import http from 'node:http';
import { readFile, watch } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DAY, METRICS, METRIC_BUCKETS } from '../src/policies.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const classes = ['browser', 'metrics', 'probes', 'deletions', 'lifecycle', 'status'];
export const WINDOWS = [1, 6, 24, 168, 720, 2160, 8760]; // Hours: up to one year.
// policies.js bounds every class's retention to 1–90 days.
const RETENTION_MAX_MS = 90 * DAY, EXPIRY_MARGIN_MS = 10 * 60_000;

// Run tasks with bounded concurrency; a failed task yields null, not a rejection.
async function pool(tasks, concurrency) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; try { results[i] = await tasks[i](); } catch { results[i] = null; } }
  }));
  return results;
}

// Reads return the oldest rows first, capped, with no cursor, over at most seven
// days. Each chunk's head read is complete when it fits. Dense chunks are sampled,
// not exhausted: the newest tail in full (so "latest" stays true), then evenly
// spaced strata, each read from its start. Only spans actually read are reported
// as covered; nothing is extrapolated.
export async function readWindow(kind, from, to, request, { budget = 96, concurrency = 6, tailMs = 600_000, maxWindow = 7 * DAY } = {}) {
  const chunks = [];
  for (let end = to; end > from; end -= maxWindow) chunks.push([Math.max(from, end - maxWindow), end]);
  const heads = await pool(chunks.map(chunk => () => request(kind, ...chunk)), concurrency);
  if (!heads[0]) throw new Error('newest chunk unavailable');
  const rows = [], spans = [], dense = [];
  let queries = chunks.length;
  heads.forEach((data, i) => {
    if (!data) return;
    if (data.truncated) dense.push([...chunks[i], data]);
    else { rows.push(...data.rows); spans.push(chunks[i]); }
  });
  const result = (complete, sampled) => ({ rows, spans: spans.sort((a, b) => a[0] - b[0]), queries, as_of: heads[0].as_of, complete, sampled });
  if (!dense.length) return result(heads.every(Boolean), false);
  // The tail belongs to the newest chunk, and only matters when that chunk overflowed.
  const split = dense[0][1] === to ? Math.max(dense[0][0], to - tailMs) : to;
  const tail = split < to ? await request(kind, split, to) : null;
  if (tail) queries++;
  // Size strata to need about half a cap each, at the densest observed rate:
  // sources join over time, so the oldest rows of a chunk may be sparse.
  const rate = Math.max(...dense.map(([start, , data]) => data.rows.length / Math.max(1, (data.rows.at(-1)?.observed_at ?? start) - start)),
    tail ? tail.rows.length / Math.max(1, to - split) : 0);
  const ranges = dense.map(([start, end]) => [start, Math.min(end, split)]).filter(([start, end]) => end > start);
  const wanted = ranges.map(([start, end]) => Math.max(4, Math.ceil(2 * rate * (end - start) / 500)));
  const total = wanted.reduce((a, b) => a + b, 0), room = Math.max(ranges.length, budget - queries);
  const slices = ranges.flatMap(([start, end], i) => {
    const strata = Math.max(1, total > room ? Math.floor(wanted[i] * room / total) : wanted[i]);
    return Array.from({ length: strata }, (_, j) => [start + Math.floor((end - start) * j / strata), start + Math.floor((end - start) * (j + 1) / strata)]);
  });
  const results = await pool(slices.map(slice => () => request(kind, ...slice)), concurrency);
  queries += slices.length;
  for (const [i, data] of [[-1, tail], ...results.map((data, i) => [i, data])]) {
    const [start, end] = i < 0 ? [split, to] : slices[i];
    if (!data) continue;
    rows.push(...data.rows);
    // A capped stratum is covered only up to its last (possibly partial) millisecond.
    const reach = data.truncated ? data.rows.at(-1)?.observed_at ?? start : end;
    if (reach > start) spans.push([start, reach]);
  }
  return result(heads.every(Boolean) && (!tail || !tail.truncated) && results.every(data => data && !data.truncated), true);
}

// A bucket row stands in for the newest export in its bucket, so panels treat
// buckets like exports spaced one bucket apart. Delta counters carry the bucket sum.
const bucketPoint = (name, bucket, row) => {
  if (!Number.isSafeInteger(row.min_expires_at)) throw Object.assign(new Error('bucket rows lack expiry'), { unusable: true });
  return { id: `${name}|${bucket}|${row.bucket_start}|${row.source}|${row.attributes_json}`, bucket, name,
    source: row.source, kind: row.kind, unit: row.unit, temporality: row.temporality, attributes_json: row.attributes_json,
    observed_at: row.last_at, start_at: row.last_start_at, value: row.temporality === 'delta' ? row.delta_sum : row.last_value,
    count: row.last_count, sum: row.last_sum, min: row.min_value, max: row.max_value, conflict: row.conflict, expires_at: row.min_expires_at };
};

// Collector-side aggregation: about `target` buckets per metric, coarser when a
// name's series overflow one capped read. Only the coarsest cap is a gap.
export async function readBuckets(from, to, request, names, { concurrency = 6, target = 400 } = {}) {
  const first = METRIC_BUCKETS.findIndex(bucket => (to - from) / bucket <= target);
  const rows = [];
  let queries = 0, asOf = null, complete = true;
  const read = async name => {
    for (let i = first; i < METRIC_BUCKETS.length; i++) {
      const data = await request(name, METRIC_BUCKETS[i]);
      queries++;
      asOf = data.as_of;
      if (data.truncated && i < METRIC_BUCKETS.length - 1) continue;
      if (data.truncated) complete = false;
      rows.push(...data.rows.map(row => bucketPoint(name, METRIC_BUCKETS[i], row)));
      return;
    }
  };
  const pending = [...names];
  await read(pending.shift()); // Probe the route once before fanning out.
  await Promise.all(Array.from({ length: concurrency }, async () => { while (pending.length) await read(pending.shift()); }));
  return { rows, spans: [[from, to]], queries, as_of: asOf, complete, sampled: false, bucketed: true };
}

export function createDashboard({ secret, upstream = 'https://telemetry.bayleaf.dev', fetcher = fetch } = {}) {
  if (!secret || /\s/.test(secret) || secret.length < 24) throw new Error('A valid operator READ_SECRET is required.');
  const session = randomBytes(32).toString('hex');
  const clients = new Set();
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    const origin = `http://${host}`;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Local same-origin access only.' });
    const authorized = (req.headers.cookie || '').split(';').some(value => value.trim() === `dashboard=${session}`);
    const path = req.url;
    if (req.method === 'GET' && path === '/') {
      res.setHeader('Set-Cookie', `dashboard=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return send(200, await readFile(`${directory}index.html`, 'utf8'), 'text/html');
    }
    if (!authorized) return send(403, { error: 'Open the local dashboard first.' });
    if (req.method === 'GET' && ['/app.js', '/style.css'].includes(path)) {
      return send(200, await readFile(`${directory}${path.slice(1)}`, 'utf8'), path.endsWith('.js') ? 'text/javascript' : 'text/css');
    }
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method !== 'POST' || path !== '/read') return send(404, { error: 'Not found.' });
    if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return send(403, { error: 'Same-origin JSON required.' });
    if (busy) return send(429, { error: 'A dashboard read is already running.' });
    busy = true;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) throw new Error('invalid');
      }
      const { hours } = JSON.parse(body);
      if (!WINDOWS.includes(hours)) return send(400, { error: 'Invalid window.' });
      const to = Date.now(), from = to - hours * 3_600_000;
      // Nothing older than the retention maximum can exist, so it is never read.
      // Rows about to expire are left out too, or the view would clear at once.
      const readFrom = Math.max(from, to - RETENTION_MAX_MS + EXPIRY_MARGIN_MS);
      const deadline = AbortSignal.timeout(30_000);
      const result = { from, to, read_from: readFrom, fetched_at: to, classes: {} };
      const request = async (kind, start, end) => {
        deadline.throwIfAborted();
        const url = new URL(`/v1/read/${kind}`, upstream);
        url.search = new URLSearchParams({ from: start, to: end, limit: 500 });
        const response = await fetcher(url, { headers: { Authorization: `Bearer ${secret}` },
          redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(12_000)]) });
        if (!response.ok) throw new Error(`upstream ${response.status}`);
        return response.json();
      };
      const requestBuckets = async (name, bucket) => {
        deadline.throwIfAborted();
        const url = new URL('/v1/read/metric-buckets', upstream);
        url.search = new URLSearchParams({ from: readFrom, to, name, bucket, limit: 2000 });
        const response = await fetcher(url, { headers: { Authorization: `Bearer ${secret}` },
          redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(12_000)]) });
        if (!response.ok) throw Object.assign(new Error(`upstream ${response.status}`), { status: response.status });
        return response.json();
      };
      // Multi-day metrics prefer collector-side buckets; until that route is
      // deployed (404), fall back to sampling raw rows.
      const readMetrics = () => hours <= 24 ? readWindow('metrics', readFrom, to, request)
        : readBuckets(readFrom, to, requestBuckets, Object.keys(METRICS))
          .catch(error => error.status === 404 || error.unusable ? readWindow('metrics', readFrom, to, request) : Promise.reject(error));
      await Promise.all(classes.map(async kind => {
        try { result.classes[kind] = await (kind === 'metrics' ? readMetrics() : readWindow(kind, readFrom, to, request)); }
        catch { result.classes[kind] = { rows: [], complete: false, error: 'Read unavailable. Check collector configuration or connectivity.' }; }
      }));
      // No cache or export: even derived views expire with their oldest input.
      const expiries = Object.values(result.classes).flatMap(data => data.rows.map(row => row.expires_at));
      result.expires_at = expiries.reduce((earliest, expiry) => Math.min(earliest, expiry), Date.now() + 300_000);
      return send(200, result);
    } catch { return send(400, { error: 'Could not read dashboard data.' }); }
    finally { busy = false; }
  });
  server.reload = () => { for (const client of clients) client.write('data: reload\n\n'); };
  server.on('close', () => { for (const client of clients) client.end(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let secret = process.env.READ_SECRET;
  if (!secret) {
    try { secret = JSON.parse(await readFile(new URL('../.dev.vars.production.json', import.meta.url), 'utf8')).READ_SECRET; }
    catch { /* Never print credential files or parse errors. */ }
  }
  const server = createDashboard({ secret });
  server.listen(Number(process.env.PORT || 4318), '127.0.0.1', () => {
    console.log(`Operator dashboard: http://127.0.0.1:${server.address().port}`);
    console.log('Live read-only data. UI edits reload automatically; Ctrl-C stops the app.');
  });
  server.on('error', () => { console.error('Could not start local dashboard. Check PORT.'); process.exit(1); });
  for await (const event of watch(directory)) {
    if (['index.html', 'app.js', 'style.css'].includes(event.filename)) server.reload();
  }
}
