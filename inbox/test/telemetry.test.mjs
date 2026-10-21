import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { database } from '../../telemetry/test/d1.js';
import { validate } from '../../telemetry/src/validate.js';
import { createWorker } from '../../telemetry/src/worker.js';
import { ingest } from '../../telemetry/src/store.js';

// Real SQLite plus a Node WorkerEntrypoint shim. Existing suite separately runs
// all reception/lifecycle contracts in workerd; no network in this suite.
const bundle = await build({ entryPoints: [new URL('../src/worker.js', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'entrypoint',
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'entrypoint', namespace: 'shim' }));
      b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents:
        'export class WorkerEntrypoint { constructor(ctx,env) { this.env=env; } }' }));
    } }] });
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const WINDOW = 900000;
const SECRET = 'synthetic-inboxes-writer-for-local-tests';
function setup(t) {
  const db = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    db.sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  t.after(() => db.close());
  return { DB: db, INBOXES_ENABLED: 'true', INBOX_TELEMETRY_ENABLED: 'true',
    INBOX_TELEMETRY_WRITE_SECRET: SECRET,
    ACCEPT_LIMIT: { limit: async () => ({ success: true }) }, REJECT_LIMIT: { limit: async () => ({ success: true }) },
    BLOBS: { put: async () => {}, delete: async () => {}, list: async () => ({ objects: [] }) } };
}
function closeWindow(db, age = 1) {
  const start = Math.floor(Date.now() / WINDOW) * WINDOW - age * WINDOW;
  db.sql.exec(`PRAGMA foreign_keys=OFF; UPDATE telemetry_counts SET start_at=${start}; UPDATE telemetry_windows SET start_at=${start}; PRAGMA foreign_keys=ON;`);
  return start;
}
const counts = env => env.DB.sql.prepare('SELECT name,transport,outcome,value FROM telemetry_counts ORDER BY name,transport,outcome').all();

test('durable windows, immutable retries, source capability, and collector deduplication', async t => {
  const env = setup(t);
  await mod.countTelemetry(env, 'inbox.receipts', 'email', 'accepted');
  await mod.countTelemetry(env, 'inbox.receipts', 'email', 'accepted');
  const start = closeWindow(env.DB);
  const attempts = [];
  const send = async (url, init) => {
    assert.equal(url, 'https://telemetry.bayleaf.dev/v1/metrics');
    assert.equal(init.redirect, 'manual');
    attempts.push(init.body);
    return new Response('never retain this response', { status: attempts.length === 1 ? 503 : 202 });
  };
  await mod.exportTelemetry(env, send);
  await mod.exportTelemetry(env, send);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(env.DB.sql.prepare('SELECT sent FROM telemetry_windows').get().sent, 1);
  await mod.exportTelemetry(env, send);
  assert.equal(attempts.length, 2);
  assert.ok(!attempts[0].includes(SECRET));
  const payload = JSON.parse(attempts[0]);
  assert.equal(payload.observed_at, start + WINDOW);
  assert.equal(payload.points[0].value, 2);
  const data = validate('metrics', payload, { RETENTION_DAYS: '90' });
  const collector = database(); t.after(() => collector.close());
  assert.equal((await ingest(collector, 'metrics', data, Date.now(), { RETENTION_DAYS: '90' })).duplicate, false);
  assert.equal((await ingest(collector, 'metrics', data, Date.now(), { RETENTION_DAYS: '90' })).duplicate, true);
  const worker = createWorker();
  const cfg = { TELEMETRY_ENABLED: 'true', TELEMETRY_DB: collector,
    READ_SECRET: 'synthetic-read-only-for-local-tests', WRITE_KEYS_JSON: JSON.stringify({ inboxes: SECRET }) };
  const req = () => new Request('https://telemetry.invalid/v1/metrics', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` }, body: attempts[0] });
  assert.equal((await worker.fetch(req(), cfg)).status, 503);
  assert.equal((await worker.fetch(req(), { ...cfg, INBOXES_METRICS_ENABLED: 'true' })).status, 202);
});

test('privacy allowlists reject identities/content, arbitrary dimensions, windows and source spoofing', async t => {
  const env = setup(t);
  await mod.countTelemetry(env, 'inbox.receipts', 'http', 'unknown_address');
  closeWindow(env.DB);
  let payload;
  await mod.exportTelemetry(env, async (_, init) => { payload = JSON.parse(init.body); return new Response(null, { status: 202 }); });
  const check = p => validate('metrics', p, {});
  for (const field of ['address', 'id', 'owner', 'hostname', 'path', 'headers', 'subject', 'body', 'credential', 'ip', 'error']) {
    const p = structuredClone(payload); p.points[0].attributes[field] = 'private-canary';
    assert.throws(() => check(p));
  }
  for (const change of [p => { p.source = 'owui'; }, p => { p.points[0].attributes.transport = 'private-canary'; },
    p => { p.points[0].attributes.outcome = 'private-canary'; }, p => { p.points[0].start_at++; },
    p => { p.points[0].temporality = 'cumulative'; }, p => { p.points.push(p.points[0]); },
    p => { p.points[0].attributes = {}; }, p => { p.points[0].name = 'webui.users.active'; }]) {
    const p = structuredClone(payload); change(p); assert.throws(() => check(p));
  }
  for (let i = 0; i < 20; i++) await mod.countTelemetry(env, 'inbox.receipts', `host-${i}`, 'unknown_address');
  assert.equal(counts(env).length, 1);
});

test('export counters use approved units and anonymous fixed dimensions end to end', async t => {
  const env = setup(t);
  await mod.countTelemetry(env, 'inbox.export.pages', 'http', 'emitted', 2);
  await mod.countTelemetry(env, 'inbox.export.bytes', 'http', 'emitted', 16384);
  await mod.countTelemetry(env, 'inbox.export.bytes', 'private-host', 'emitted', 1);
  await mod.countTelemetry(env, 'inbox.export.pages', 'http', 'private-error', 1);
  closeWindow(env.DB);
  let payload;
  await mod.exportTelemetry(env, async (_, init) => { payload = JSON.parse(init.body); return new Response(null, { status: 202 }); });
  const data = validate('metrics', payload, {});
  assert.deepEqual(data.points.map(p => [p.name, p.unit, p.value, p.attributes]), [
    ['inbox.export.bytes', 'By', 16384, { transport: 'http', outcome: 'emitted' }],
    ['inbox.export.pages', '1', 2, { transport: 'http', outcome: 'emitted' }],
  ]);
  for (const field of ['owner', 'id', 'address', 'path', 'content', 'headers']) {
    const bad = structuredClone(payload); bad.points[0].attributes[field] = 'private-canary';
    assert.throws(() => validate('metrics', bad, {}));
  }
  const wrongUnit = structuredClone(payload); wrongUnit.points[0].unit = '1';
  assert.throws(() => validate('metrics', wrongUnit, {}));
});

test('export counter migration preserves pre-existing windows and counts', t => {
  const db = database(); t.after(() => db.close());
  for (const file of ['0001_inboxes.sql', '0002_telemetry.sql'])
    db.sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const start = Math.floor(Date.now() / WINDOW) * WINDOW;
  db.sql.prepare('INSERT INTO telemetry_windows(start_at,batch_id,sealed) VALUES (?,?,1)').run(start, 'synthetic-migration-batch');
  db.sql.prepare("INSERT INTO telemetry_counts VALUES (?,'inbox.receipts','http','accepted',7)").run(start);
  db.sql.exec(readFileSync(new URL('../migrations/0005_export_telemetry.sql', import.meta.url), 'utf8'));
  assert.equal(db.sql.prepare('SELECT value FROM telemetry_counts').get().value, 7);
  assert.equal(db.sql.prepare('SELECT sealed FROM telemetry_windows').get().sealed, 1);
  db.sql.prepare("INSERT INTO telemetry_counts VALUES (?,'inbox.export.bytes','http','emitted',4096)").run(start);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM telemetry_counts').get().n, 2);
});

test('reception failures/rejections and lifecycle transitions count only fixed terminal outcomes', async t => {
  const env = setup(t);
  const rpc = new mod.InboxManagement({}, env);
  const owner = 'synthetic-owner-generation';
  const http = await rpc.createInbox(owner, { type: 'http', label: 'private-label-canary' });
  const email = await rpc.createInbox(owner, { type: 'email' });
  assert.equal((await mod.default.fetch(new Request(http.url + 'private-path?secret=canary', {
    method: 'POST', body: 'private-content-canary', headers: { 'Content-Type': 'text/plain' } }), env)).status, 200);
  assert.equal((await mod.default.fetch(new Request('https://unknown.bayleaf-inboxes.dev'), env)).status, 404);
  await rpc.createCredential(owner, http.id, {});
  assert.equal((await mod.default.fetch(new Request(http.url), env)).status, 401);
  env.REJECT_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await mod.default.fetch(new Request(http.url), env)).status, 429);
  const message = to => ({ to, from: 'private-sender-canary@example.invalid', rawSize: 20,
    raw: new Response('Subject: private-subject-canary\r\n\r\nprivate-body').body,
    setReject() {} });
  await mod.default.email(message(email.address), env);
  await mod.default.email(message('unknown@example.invalid'), env);
  await rpc.destroyInbox(owner, http.id);
  await rpc.destroyInbox(owner, http.id);
  assert.equal(counts(env).find(r => r.outcome === 'destroy_requested').value, 1);
  // An ended lifetime enters the same transition and counter, once, without identifiers.
  env.DB.sql.prepare('UPDATE inboxes SET expires_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 1, email.id);
  // Never reach the real collector, even if a window closes mid-test.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try { await mod.default.scheduled({}, env); await mod.default.scheduled({}, env); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(counts(env).find(r => r.transport === 'email' && r.outcome === 'destroy_requested').value, 1);
  const serialized = JSON.stringify(counts(env));
  for (const forbidden of ['canary', owner, http.id, email.address]) assert.ok(!serialized.includes(forbidden));
  assert.equal(counts(env).filter(r => r.outcome === 'accepted').length, 2);
  // Telemetry outage after successful content storage cannot change reception.
  env.DB.sql.exec('DROP TABLE telemetry_counts; DROP TABLE telemetry_windows;');
  assert.equal((await mod.default.fetch(new Request('https://unknown.bayleaf-inboxes.dev'), env)).status, 404);
  const other = await rpc.createInbox(owner, { type: 'http' });
  assert.equal((await mod.default.fetch(new Request(other.url), env)).status, 200);
});

test('outbox capacity, two-window export bound, timeout/retry and expiry while disabled', async t => {
  const env = setup(t);
  const start = Math.floor(Date.now() / WINDOW) * WINDOW;
  const insert = env.DB.sql.prepare('INSERT INTO telemetry_windows(start_at,batch_id) VALUES (?,?)');
  for (let i = 1; i <= 96; i++) insert.run(start - i * WINDOW, crypto.randomUUID());
  await mod.countTelemetry(env, 'inbox.receipts', 'http', 'accepted');
  assert.equal(counts(env).length, 0); // Saturated queue drops, not expands.
  env.DB.sql.exec('DELETE FROM telemetry_windows');
  for (let i = 1; i <= 3; i++) {
    insert.run(start - i * WINDOW, crypto.randomUUID());
    env.DB.sql.prepare("INSERT INTO telemetry_counts VALUES (?,'inbox.receipts','http','accepted',1)").run(start - i * WINDOW);
  }
  let calls = 0;
  await mod.exportTelemetry(env, async (_, init) => { calls++; assert.ok(init.signal); throw new Error('private-error-canary'); });
  assert.equal(calls, 1);
  assert.equal(env.DB.sql.prepare('SELECT SUM(sent) AS n FROM telemetry_windows').get().n, 0);
  calls = 0;
  await mod.exportTelemetry(env, async () => { calls++; return new Response(null, { status: 202 }); });
  assert.equal(calls, 2);
  env.INBOX_TELEMETRY_ENABLED = 'false';
  await mod.countTelemetry(env, 'inbox.receipts', 'email', 'accepted');
  // Move every row outside local retention, then schedule with collection off.
  env.DB.sql.exec(`PRAGMA foreign_keys=OFF; UPDATE telemetry_counts SET start_at=start_at-172800000;
    UPDATE telemetry_windows SET start_at=start_at-172800000; PRAGMA foreign_keys=ON;`);
  await mod.default.scheduled({}, env);
  assert.equal(counts(env).length, 0);
  assert.equal(env.DB.sql.prepare('SELECT COUNT(*) AS n FROM telemetry_windows').get().n, 0);
});

test('sealed windows reject late increments; redirects and lost acknowledgement keep one immutable batch', async t => {
  const env = setup(t);
  await mod.countTelemetry(env, 'inbox.receipts', 'http', 'accepted');
  env.DB.sql.exec('UPDATE telemetry_windows SET sealed=1');
  await mod.countTelemetry(env, 'inbox.receipts', 'http', 'accepted');
  assert.equal(counts(env)[0].value, 1);
  closeWindow(env.DB);
  const bodies = [];
  await mod.exportTelemetry(env, async (_, init) => {
    bodies.push(init.body);
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid' } });
  });
  assert.equal(env.DB.sql.prepare('SELECT sent FROM telemetry_windows').get().sent, 0);
  await mod.exportTelemetry(env, async (_, init) => {
    bodies.push(init.body);
    // Collector accepted, but its acknowledgement never reached the exporter.
    throw new Error('synthetic dropped acknowledgement');
  });
  await mod.exportTelemetry(env, async (_, init) => {
    bodies.push(init.body);
    return new Response(null, { status: 202 });
  });
  assert.equal(new Set(bodies).size, 1);
  assert.equal(env.DB.sql.prepare('SELECT sent FROM telemetry_windows').get().sent, 1);
});
