import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard, readWindow } from './server.mjs';

test('splits capped windows without double counting parent rows', async () => {
  const result = await readWindow('browser', 0, 4, async (_, from, to) => ({
    as_of: 10, truncated: to - from > 1, rows: [{ id: from }],
  }));
  assert.deepEqual(result.rows.map(row => row.id), [0, 1, 2, 3]);
  assert.equal(result.complete, true);
  assert.equal(result.queries, 7);
});
test('dense same-ms caps and query budgets stay visibly incomplete', async () => {
  const request = async () => ({ truncated: true, rows: [{ id: 1 }], as_of: 10 });
  assert.equal((await readWindow('metrics', 0, 1, request)).complete, false);
  const bounded = await readWindow('metrics', 0, 100, request, 2);
  assert.equal(bounded.queries, 2);
  assert.equal(bounded.complete, false);
  assert.equal(bounded.rows.length, 0);
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
