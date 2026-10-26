import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard, readBuckets, readWindow } from './server.mjs';

// Like the collector: rows ordered by observed_at, the oldest `cap` returned.
const store = (times, cap = 500) => async (_, from, to) => {
  const rows = times.filter(t => t >= from && t < to).slice(0, cap).map(t => ({ id: t, observed_at: t }));
  return { as_of: 10, truncated: rows.length === cap, rows };
};
const minute = 60_000;

test('a window that fits one read is complete in one query', async () => {
  const result = await readWindow('browser', 0, 100, store([1, 2, 3]));
  assert.deepEqual(result.rows.map(row => row.id), [1, 2, 3]);
  assert.deepEqual([result.queries, result.complete, result.sampled], [1, true, false]);
});
test('modestly over-cap windows resolve completely with few strata', async () => {
  const times = Array.from({ length: 600 }, (_, i) => i * 10 * minute);
  const result = await readWindow('probes', 0, 6000 * minute, store(times));
  assert.equal(result.complete, true);
  assert.equal(new Set(result.rows.map(row => row.id)).size, 600);
  assert.ok(result.queries <= 10);
});
test('dense windows are sampled within budget with a complete newest tail', async () => {
  const to = 7 * 24 * 60 * minute;
  const times = Array.from({ length: to / 2000 }, (_, i) => i * 2000);
  const result = await readWindow('metrics', 0, to, store(times), { budget: 20 });
  assert.deepEqual([result.complete, result.sampled, result.queries], [false, true, 20]);
  assert.equal(new Set(result.rows.map(row => row.id)).size, result.rows.length);
  assert.equal(Math.max(...result.rows.map(row => row.observed_at)), times.at(-1));
  assert.deepEqual(result.spans.at(-1), [to - 10 * minute, to]);
  // Covered spans hold every row read and stay inside the window.
  for (const row of result.rows) assert.ok(result.spans.some(([s, e]) => row.observed_at >= s && row.observed_at <= e));
  assert.ok(result.spans.length > 10 && result.spans[0][0] === 0);
});
test('same-ms caps and failed strata stay visibly unread; a failed tail fails', async () => {
  const dense = await readWindow('metrics', 0, 100 * minute, store(Array(600).fill(0)));
  assert.equal(dense.complete, false);
  // The stratum stuck at one millisecond reads nothing as covered; empty strata do.
  assert.ok(dense.spans.every(([s, e]) => e > s && s > 0));
  const times = Array.from({ length: 1000 }, (_, i) => i * minute / 10);
  const flaky = await readWindow('metrics', 0, 100 * minute, async (kind, from, to) => {
    if (from === 0 && to !== 100 * minute) throw new Error('synthetic');
    return store(times)(kind, from, to);
  });
  assert.equal(flaky.complete, false);
  assert.ok(flaky.spans[0][0] > 0);
  await assert.rejects(readWindow('metrics', 0, 100 * minute, async (kind, from, to) => {
    if (to === 100 * minute && from > 0) throw new Error('synthetic');
    return store(times)(kind, from, to);
  }));
});
test('long windows read in seven-day chunks, sampling only dense ones', async () => {
  const day = 24 * 60 * minute, to = 20 * day;
  // Sparse for the first 13 days, then a dense week ending at `to`.
  const times = [...Array.from({ length: 50 }, (_, i) => i * day / 4), ...Array.from({ length: 7 * 24 * 60 }, (_, i) => 13 * day + i * minute)];
  const calls = [];
  const result = await readWindow('metrics', 0, to, async (kind, from, end) => { calls.push([from, end]); return store(times)(kind, from, end); });
  assert.ok(calls.every(([from, end]) => end - from <= 7 * day && from >= 0 && end <= to));
  assert.deepEqual(calls.slice(0, 3).map(([from, end]) => [from / day, end / day]), [[13, 20], [6, 13], [0, 6]]);
  assert.deepEqual([result.complete, result.sampled], [true, true]);
  assert.equal(new Set(result.rows.map(row => row.id)).size, times.length);
  assert.ok(result.queries <= 96);
});
test('collector buckets coarsen on overflow and become export-shaped points', async () => {
  const bucketRow = (bucket_start, extra = {}) => ({ bucket_start, source: 'owui', attributes_json: '{}', kind: 'gauge', unit: 'users',
    temporality: null, last_at: bucket_start + 5, last_value: 3, last_start_at: null, conflict: 0, min_expires_at: 99, ...extra });
  const seen = [];
  const result = await readBuckets(0, 7 * 24 * 3_600_000, async (name, bucket) => {
    seen.push([name, bucket]);
    if (name === 'busy' && bucket < 86_400_000) return { as_of: 1, truncated: true, rows: [] };
    return { as_of: 1, truncated: false, rows: [bucketRow(0), bucketRow(bucket, { temporality: 'delta', delta_sum: 7, last_value: 1 })] };
  }, ['quiet', 'busy']);
  assert.deepEqual(seen.filter(([name]) => name === 'quiet'), [['quiet', 3_600_000]]);
  assert.deepEqual(seen.filter(([name]) => name === 'busy').map(([, bucket]) => bucket), [3_600_000, 21_600_000, 86_400_000]);
  assert.deepEqual([result.complete, result.bucketed, result.queries], [true, true, 4]);
  const [gaugePoint, deltaPoint] = result.rows;
  assert.deepEqual([gaugePoint.observed_at, gaugePoint.value, gaugePoint.expires_at, gaugePoint.bucket], [5, 3, 99, 3_600_000]);
  assert.equal(deltaPoint.value, 7);
  await assert.rejects(readBuckets(0, 3_600_000, async () => ({ truncated: false, rows: [bucketRow(0, { min_expires_at: undefined })] }), ['x']),
    error => error.unusable);
});
test('multi-day metrics fall back to sampling until the bucket route is deployed', async t => {
  const secret = 'synthetic-read-only-secret-123456';
  const paths = [];
  const server = createDashboard({ secret, fetcher: async url => {
    paths.push(url.pathname);
    if (url.pathname === '/v1/read/metric-buckets') return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ as_of: Date.now(), truncated: false, rows: [] });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://${'127.0.0.1'}:${server.address().port}`;
  const cookie = (await fetch(origin)).headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${origin}/read`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{"hours":168}' });
  const { classes } = await response.json();
  assert.deepEqual([classes.metrics.complete, !!classes.metrics.bucketed, classes.metrics.error], [true, false, undefined]);
  assert.equal(paths.filter(path => path === '/v1/read/metric-buckets').length, 1);
  assert.ok(paths.includes('/v1/read/lifecycle'));
});
test('year views never read beyond the retention maximum, minus an expiry margin', async t => {
  const secret = 'synthetic-read-only-secret-123456';
  const ranges = [];
  const server = createDashboard({ secret, fetcher: async url => {
    ranges.push([Number(url.searchParams.get('from')), Number(url.searchParams.get('to'))]);
    return Response.json({ as_of: Date.now(), truncated: false, rows: [] });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(origin)).headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${origin}/read`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{"hours":8760}' });
  const data = await response.json();
  assert.equal(data.to - data.from, 365 * 24 * 60 * minute);
  assert.equal(data.to - data.read_from, 90 * 24 * 60 * minute - 10 * minute);
  assert.ok(ranges.length && ranges.every(([from, to]) => from >= data.read_from && to - from <= 90 * 24 * 60 * minute));
});
test('local session, origin checks, no-store, private credential and expiry', async t => {
  const secret = 'synthetic-read-only-secret-123456';
  const expiry = Date.now() + 60_000;
  const server = createDashboard({ secret, fetcher: async (url, options) => {
    assert.equal(url.hostname, 'telemetry.bayleaf.dev');
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    return Response.json({ as_of: Date.now(), truncated: false, rows: [{ id: 1, expires_at: expiry }] });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/read`, { method: 'POST' })).status, 403);
  const home = await fetch(origin);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.ok(!(await home.text()).includes(secret));
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${origin}/read`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{"hours":1}' })).status, 403);
  const response = await fetch(`${origin}/read`, { method: 'POST', headers, body: '{"hours":1}' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(secret));
  assert.equal(JSON.parse(text).expires_at, expiry);
});
