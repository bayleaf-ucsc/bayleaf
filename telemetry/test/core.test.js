import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from './d1.js';
import { createWorker } from '../src/worker.js';
import { validate, canonical } from '../src/validate.js';
import { ingest, purge, readRows, takeBudget } from '../src/store.js';
import { DAY, LIMITS } from '../src/policies.js';
import { OtlpError } from '../otlp/normalize.mjs';

const NOW = 1_790_000_000_000;
const WRITE = 'local-fake-write-token-123456789';
const READ = 'local-fake-read-token-1234567890';
const envFor = db => ({ TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'true', TELEMETRY_DB: db,
  READ_SECRET: READ, WRITE_KEYS_JSON: JSON.stringify(Object.fromEntries(
    ['owui', 'probe', 'chat-retention', 'api-retention', 'sandbox-reaper'].map(s => [s, `${WRITE}-${s}`]))) });
const envelope = source => ({ schema_version: 1, source, batch_id: randomUUID(), observed_at: NOW });
const deletion = () => ({ ...envelope('chat-retention'), job: 'chat-retention', outcome: 'success',
  duration_ms: 500, deleted: 3, extensions: { scanned: 5, pending: 2, dry_run: false } });
const probe = () => ({ ...envelope('probe'), layer: 'browser', outcome: 'success', duration_ms: 1000,
  phases_ms: { navigation: 200, rendered: 500, chat_cleanup: 100 }, events_ms: { first_answer: 650 },
  extensions: { cleanup: 'confirmed', accounted_ms: 800, unaccounted_ms: 200 } });
const gauge = () => ({ name: 'webui.users.active', kind: 'gauge', unit: 'users', observed_at: NOW,
  value: 10, attributes: { instance: 'worker-1' } });
const sum = () => ({ name: 'http.server.requests', kind: 'sum', unit: '1', observed_at: NOW,
  start_at: NOW - 60_000, temporality: 'delta', monotonic: true, value: 5,
  attributes: { method: 'POST', route: '/api/chat/completions', status_code: 200, instance: 'worker-1' } });
const histogram = () => ({ name: 'http.server.duration', kind: 'histogram', unit: 'ms', observed_at: NOW,
  start_at: NOW - 60_000, temporality: 'cumulative', count: 5, sum: 600, min: 10, max: 400,
  bounds: [100, 500], bucket_counts: [4, 1, 0], attributes: {} });
const metrics = (points = [gauge(), sum(), histogram()]) => ({ ...envelope('owui'), points });
const browser = () => ({ schema_version: 1, destination: 'landing', referring_hostname: 'EXAMPLE.ORG.' });
function request(path, body, source = 'chat-retention', extra = {}) {
  return new Request(`https://telemetry.invalid${path}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${WRITE}-${source}`, ...extra }, body: JSON.stringify(body) });
}
function count(db, table) { return db.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }

test('scheduled expiry continues after collection is switched off', async t => {
  const db = database();
  t.after(() => db.sql.close());
  await ingest(db, 'deletions', validate('deletions', deletion(), {}, NOW), NOW, {});
  assert.equal(count(db, 'deletion_runs'), 1);
  const worker = createWorker({ clock: () => NOW + 8 * DAY });
  await worker.scheduled({}, { ...envFor(db), TELEMETRY_ENABLED: 'false' });
  assert.equal(count(db, 'deletion_runs'), 0);
});

test('strict normalization and sensitive-field rejection across all classes', () => {
  assert.equal(validate('browser', browser(), {}, NOW).referring_hostname, 'example.org');
  assert.equal(validate('browser', { ...browser(), referring_hostname: null }, {}, NOW).referring_hostname, null);
  for (const host of ['https://site.org/secret?q=token', 'person@site.org', '1.2.3.4', '[::1]', 'a.local', 'site.org/path', 'a..org',
    'person-private-nonce.api.bayleaf.dev', '0123456789abcdef.example.org', `${'x'.repeat(49)}.example.org`]) {
    assert.throws(() => validate('browser', { ...browser(), referring_hostname: host }, {}, NOW));
  }
  for (const [klass, payload] of [['browser', browser()], ['deletions', deletion()], ['probes', probe()], ['metrics', metrics()]]) {
    assert.ok(validate(klass, payload, {}, NOW));
    for (const field of ['email', 'ip', 'user_agent', 'url', 'prompt', 'error', 'token', 'path', 'extensions_raw']) {
      assert.throws(() => validate(klass, { ...payload, [field]: 'FAKE_SECRET' }, {}, NOW));
    }
    assert.throws(() => validate(klass, { ...payload, schema_version: 2 }, {}, NOW));
  }
  assert.throws(() => validate('deletions', { ...deletion(), job: 'credential-cleanup' }, {}, NOW));
  assert.throws(() => validate('deletions', { ...deletion(), extensions: { dry_run: true } }, {}, NOW));
  assert.throws(() => validate('probes', { ...probe(), phases_ms: { navigation: 1002 } }, {}, NOW));
  assert.throws(() => validate('probes', { ...probe(), events_ms: { first_answer: 1002 } }, {}, NOW));
  assert.throws(() => validate('probes', { ...probe(), extensions: { error: 'FAKE_SECRET' } }, {}, NOW));
});

test('metrics preserve aggregate semantics and reject unapproved dimensions and raw routes', () => {
  const data = validate('metrics', metrics(), {}, NOW);
  assert.equal(data.points[1].temporality, 'delta');
  assert.deepEqual(data.points[2].bucket_counts, [4, 1, 0]);
  for (const bad of [
    { ...gauge(), attributes: { user_id: 'fake' } },
    { ...sum(), attributes: { route: '/private/fake-secret' } },
    { ...sum(), attributes: { route: 'constructor' } },
    { ...sum(), start_at: NOW - 1 },
    { ...sum(), monotonic: false },
    { ...sum(), temporality: 'unknown' },
    { ...histogram(), bucket_counts: [1, 1, 1] },
    { ...histogram(), bounds: [500, 100] },
    { ...histogram(), min: 500, max: 100 },
    { ...gauge(), start_at: NOW - 10_000 },
    { ...gauge(), value: NaN },
  ]) assert.throws(() => validate('metrics', metrics([bad]), {}, NOW));
  assert.throws(() => validate('metrics', metrics(Array(101).fill(gauge())), {}, NOW));
});

test('exact nanosecond reset identity and absent histogram sum survive typed storage', async t => {
  const db = database(); t.after(() => db.close());
  const p = { ...sum(), time_unix_nano: `${NOW}123456`, start_time_unix_nano: `${NOW - 60_000}654321` };
  const h = histogram(); delete h.sum;
  const data = validate('metrics', metrics([p, h]), {}, NOW);
  assert.equal('sum' in data.points[1], false);
  await ingest(db, 'metrics', data, NOW);
  const rows = db.sql.prepare('SELECT * FROM metric_points ORDER BY point_index').all();
  assert.equal(rows[0].time_unix_nano, p.time_unix_nano);
  assert.equal(rows[0].start_time_unix_nano, p.start_time_unix_nano);
  assert.equal(rows[1].sum, null);
  assert.throws(() => validate('metrics', metrics([{ ...p, time_unix_nano: `${NOW + 1}123456` }]), {}, NOW));
  assert.throws(() => validate('metrics', metrics([{ ...p, start_time_unix_nano: '1' }]), {}, NOW));
});

test('real SQLite migration and typed storage retain only approved representations', async t => {
  const db = database(); t.after(() => db.close());
  for (const [klass, payload] of [['browser', browser()], ['deletions', deletion()], ['probes', probe()], ['metrics', metrics()]]) {
    await ingest(db, klass, validate(klass, payload, {}, NOW), NOW);
  }
  assert.equal(count(db, 'browser_observations'), 1);
  assert.equal(count(db, 'metric_points'), 3);
  assert.equal(count(db, 'source_status'), 3);
  const rows = await readRows(db, 'metrics', { from: NOW - 1, to: NOW + 1, limit: 50 }, NOW, {});
  assert.equal(rows[2].count, 5);
  assert.deepEqual(JSON.parse(rows[2].bounds_json), [100, 500]);
  const stored = JSON.stringify(db.sql.prepare('SELECT * FROM browser_observations').all());
  assert.ok(stored.includes('example.org'));
  for (const forbidden of ['Authorization', 'user_agent', 'prompt', 'ip_address', 'FAKE_SECRET']) assert.ok(!stored.includes(forbidden));
});

test('idempotent retry, conflict protection, point batch and source scope', async t => {
  const db = database(); t.after(() => db.close());
  const payload = metrics();
  const a = validate('metrics', payload, {}, NOW);
  assert.deepEqual(await ingest(db, 'metrics', a, NOW), { duplicate: false });
  const b = validate('metrics', JSON.parse(JSON.stringify(payload)), {}, NOW + 1);
  assert.deepEqual(await ingest(db, 'metrics', b, NOW + 1), { duplicate: true });
  assert.equal(count(db, 'metric_points'), 3);
  b.points[0].value = 90;
  assert.deepEqual(await ingest(db, 'metrics', b, NOW + 1), { conflict: true });
  assert.equal(db.sql.prepare('SELECT value FROM metric_points WHERE point_index=0').get().value, 10);
  const p = deletion();
  p.batch_id = payload.batch_id;
  await ingest(db, 'deletions', validate('deletions', p, {}, NOW), NOW);
  assert.equal(count(db, 'receipts'), 2);
  assert.equal(canonical({ z: 1, a: { y: 2, x: 3 } }), canonical({ a: { x: 3, y: 2 }, z: 1 }));
});

test('expiry excluded before purge, configurable per-class and bounded physical deletion', async t => {
  const db = database(); t.after(() => db.close());
  await ingest(db, 'deletions', validate('deletions', deletion(), {}, NOW), NOW);
  const range = { from: NOW - 1, to: NOW + 1, limit: 50 };
  assert.equal((await readRows(db, 'deletions', range, NOW + 7 * DAY, {})).length, 0);
  assert.equal((await readRows(db, 'deletions', range, NOW + 2 * DAY, { DELETIONS_RETENTION_DAYS: '1' })).length, 0);
  assert.equal((await readRows(db, 'status', range, NOW + 2 * DAY, { DELETIONS_RETENTION_DAYS: '1' })).length, 0);
  assert.equal(count(db, 'deletion_runs'), 1);
  await purge(db, NOW + 7 * DAY, {});
  assert.equal(count(db, 'deletion_runs'), 0);
  assert.equal(count(db, 'source_status'), 0);
  assert.equal(count(db, 'receipts'), 0);
  assert.throws(() => validate('deletions', deletion(), {}, NOW + 7 * DAY));
  for (const days of ['0', '91', 'NaN', '1.5']) assert.throws(() => validate('deletions', deletion(), { RETENTION_DAYS: days }, NOW));
  const later = NOW + 7 * DAY + 1;
  const old = validate('browser', browser(), {}, later);
  for (let i = 0; i < 510; i++) await ingest(db, 'browser', old, later);
  await purge(db, later + 7 * DAY, {});
  assert.equal(count(db, 'browser_observations'), 10);
});

test('a late metric point cannot gain envelope retention; missing status is not zero', async t => {
  const db = database(); t.after(() => db.close());
  assert.equal(count(db, 'source_status'), 0);
  const old = { ...gauge(), observed_at: NOW - DAY };
  await ingest(db, 'metrics', validate('metrics', metrics([old]), {}, NOW), NOW);
  const row = db.sql.prepare('SELECT * FROM metric_points').get();
  assert.equal(row.expires_at, NOW + 6 * DAY);
  assert.equal(row.value, 10);
});

test('bounded identity-free rate budgets and window rollover', async t => {
  const db = database(); t.after(() => db.close());
  for (let i = 0; i < LIMITS.browserPerMinute; i++) assert.equal(await takeBudget(db, 'browser', 'browser', NOW), true);
  assert.equal(await takeBudget(db, 'browser', 'browser', NOW), false);
  assert.equal(await takeBudget(db, 'browser', 'browser', NOW + 60_000), true);
  assert.equal(count(db, 'ingress_budgets'), 2);
  await purge(db, NOW + 180_000, {});
  assert.equal(count(db, 'ingress_budgets'), 0);
});

test('HTTP kill switches, service-scoped auth, bounded reads and no public data', async t => {
  const db = database(); t.after(() => db.close());
  const env = envFor(db), worker = createWorker({ clock: () => NOW });
  const call = (req, e = env) => worker.fetch(req, e);
  assert.equal((await call(request('/v1/deletions', deletion()), {})).status, 503);
  assert.equal((await call(request('/v1/deletions', deletion(), 'owui'))).status, 401);
  const payload = deletion();
  assert.equal((await call(request('/v1/deletions', payload))).status, 202);
  const duplicate = await call(request('/v1/deletions', payload));
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal((await call(request('/v1/deletions', { ...payload, deleted: 50 }))).status, 409);
  assert.equal((await call(request('/v1/deletions', { ...deletion(), source: 'api-retention' }))).status, 400);
  const read = query => new Request(`https://telemetry.invalid/v1/read/deletions${query}`, { headers: { Authorization: `Bearer ${READ}` } });
  assert.equal((await call(new Request('https://telemetry.invalid/v1/read/deletions'))).status, 401);
  for (const query of ['', '?from=1&to=2', '?from=1&to=2&limit=501', '?from=1&to=9999999999999&limit=1',
    `?from=${NOW - 1}&to=${NOW + 1}&limit=1&limit=2`, `?from=${NOW - 1}&to=${NOW + 1}&limit=1&sql=DROP`]) {
    assert.equal((await call(read(query))).status, 400, query);
  }
  const r = await call(read(`?from=${NOW - 1}&to=${NOW + 1}&limit=1`));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal((await r.json()).rows.length, 1);
});

test('HTTP browser ingress requires approved origin, matching fixed destination, bounded body', async t => {
  const db = database(); t.after(() => db.close());
  const env = envFor(db), worker = createWorker({ clock: () => NOW });
  const call = (body, headers = {}, e = env) => worker.fetch(request('/v1/browser', body, 'none', headers), e);
  assert.equal((await call(browser())).status, 403);
  assert.equal((await call(browser(), { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await call(browser(), { Origin: 'https://chat.bayleaf.dev' })).status, 400);
  assert.equal((await call(browser(), { Origin: 'https://bayleaf.dev' }, { ...env, BROWSER_ENABLED: 'false' })).status, 503);
  const r = await call(browser(), { Origin: 'https://bayleaf.dev' });
  assert.equal(r.status, 202);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://bayleaf.dev');
  assert.equal((await call({ ...browser(), raw: 'x'.repeat(70_000) }, { Origin: 'https://bayleaf.dev' })).status, 400);
  assert.equal((await call(browser(), { Origin: 'https://bayleaf.dev', 'Content-Encoding': 'gzip' })).status, 400);
  assert.equal(count(db, 'browser_observations'), 1);
});

test('collector and trusted adapter failures return content-free errors', async t => {
  const db = database(); t.after(() => db.close());
  const env = envFor(db);
  const worker = createWorker({ clock: () => NOW, otlp: async () => { throw new Error('FAKE_SECRET'); } });
  const r = await worker.fetch(request('/v1/otlp/metrics', {}, 'owui'), env);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'unavailable' });
  const timeout = createWorker({ clock: () => NOW, otlp: async () => { throw new OtlpError('body_timeout', 408); } });
  assert.equal((await timeout.fetch(request('/v1/otlp/metrics', {}, 'owui'), env)).status, 408);
  const hooked = createWorker({ clock: () => NOW, otlp: async (_r, context) => {
    assert.equal(context.source, 'owui'); return metrics();
  } });
  assert.equal((await hooked.fetch(request('/v1/otlp/metrics', {}, 'owui'), env)).status, 200);
  const failEnv = { ...env, TELEMETRY_DB: { prepare() { throw new Error('FAKE_SECRET'); } } };
  const failure = await worker.fetch(request('/v1/deletions', deletion()), failEnv);
  assert.deepEqual(await failure.json(), { error: 'unavailable' });
});
