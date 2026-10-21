import http from 'node:http';
import { readFile, watch } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const directory = fileURLToPath(new URL('.', import.meta.url));
const classes = ['browser', 'metrics', 'probes', 'deletions', 'status'];

// Split capped windows, not rows: there is no cursor for dense same-ms samples.
export async function readWindow(kind, from, to, request, budget = 48) {
  let queries = 0;
  const rows = [], gaps = [], pending = [[from, to]];
  let asOf = null;
  while (pending.length && queries < budget) {
    const [start, end] = pending.pop();
    const data = await request(kind, start, end);
    queries++;
    asOf = data.as_of;
    if (data.truncated && end - start > 1) {
      const mid = Math.floor((start + end) / 2);
      pending.push([mid, end], [start, mid]);
    } else {
      rows.push(...data.rows);
      if (data.truncated) gaps.push([start, end]);
    }
  }
  gaps.push(...pending);
  return { rows, gaps, queries, as_of: asOf, complete: !gaps.length };
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
      if (![1, 6, 24, 168].includes(hours)) return send(400, { error: 'Invalid window.' });
      const to = Date.now(), from = to - hours * 3_600_000;
      const deadline = AbortSignal.timeout(30_000);
      const result = { from, to, fetched_at: to, classes: {} };
      const request = async (kind, start, end) => {
        deadline.throwIfAborted();
        const url = new URL(`/v1/read/${kind}`, upstream);
        url.search = new URLSearchParams({ from: start, to: end, limit: 500 });
        const response = await fetcher(url, { headers: { Authorization: `Bearer ${secret}` },
          redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(12_000)]) });
        if (!response.ok) throw new Error(`upstream ${response.status}`);
        return response.json();
      };
      await Promise.all(classes.map(async kind => {
        try { result.classes[kind] = await readWindow(kind, from, to, request); }
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
