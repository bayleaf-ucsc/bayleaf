import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './d1.js';
import { createWorker } from '../src/worker.js';
import { validate } from '../src/validate.js';
import { ingest, purge, readRows } from '../src/store.js';
import { webhookEnvelope, organizationEnvelope } from '../daytona/receiver.js';
import { BUCKET_MS } from '../daytona/policy.js';
import { shapes } from '../daytona/shapes.js';
import { NOW, DAYTONA_ENV, signedWebhook, organizationWire } from './daytona-fixtures.js';

const webhook = options => new Request('https://telemetry.invalid/v1/daytona/webhooks', signedWebhook(options));
const otlp = (wire = organizationWire(), signal = 'metrics', token = 'synthetic-daytona-write-secret-123456') =>
  new Request(`https://telemetry.invalid/v1/daytona/otlp/${signal}`, { method: 'POST', headers: {
    'Content-Type': 'application/x-protobuf', Authorization: `Bearer ${token}` }, body: wire });
const envFor = db => ({ ...DAYTONA_ENV, TELEMETRY_ENABLED: 'true', RETENTION_DAYS: '90', TELEMETRY_DB: db,
  READ_SECRET: 'synthetic-operator-read-secret-123456',
  WRITE_KEYS_JSON: JSON.stringify({ daytona: 'synthetic-daytona-write-secret-123456', owui: 'synthetic-owui-write-secret-12345678' }) });
const worker = () => createWorker({ clock: () => NOW });

test('signed lifecycle inputs retain only 15-minute buckets and states, no sandbox identity', async () => {
  const a = await webhookEnvelope(webhook(), DAYTONA_ENV, NOW);
  const b = await webhookEnvelope(webhook(), DAYTONA_ENV, NOW);
  assert.deepEqual(a, b);
  assert.equal(a.observed_at % BUCKET_MS, 0);
  assert.equal(a.new_state, 'stopped');
  assert.ok(!JSON.stringify(a).includes('FAKE_PRIVATE'));
  assert.ok(!JSON.stringify(a).includes('synthetic-org'));
  assert.ok(!JSON.stringify(a).includes('msg_synthetic'));
  assert.notEqual((await webhookEnvelope(webhook({ id: 'msg_other' }), DAYTONA_ENV, NOW)).batch_id, a.batch_id);
  const svix = await webhookEnvelope(webhook({ family: 'svix' }), DAYTONA_ENV, NOW);
  assert.deepEqual(svix, a);
});

test('webhook auth rejects tampering, stale/future signatures, mixed headers and wrong organizations', async () => {
  for (const options of [{ timestamp: NOW / 1000 - 301 }, { timestamp: NOW / 1000 + 301 },
    { fields: { organizationId: 'wrong-org' } }, { fields: { newState: 'FAKE_PRIVATE' } },
    { fields: { name: 'FAKE_PRIVATE' } }]) {
    await assert.rejects(webhookEnvelope(webhook(options), DAYTONA_ENV, NOW));
  }
  const bad = signedWebhook(); bad.body = bad.body.replace('stopped', 'started');
  await assert.rejects(webhookEnvelope(new Request('https://invalid', bad), DAYTONA_ENV, NOW));
  const mixed = signedWebhook(); mixed.headers['svix-id'] = 'msg_ambiguous';
  await assert.rejects(webhookEnvelope(new Request('https://invalid', mixed), DAYTONA_ENV, NOW));
  await assert.rejects(webhookEnvelope(webhook(), { ...DAYTONA_ENV, DAYTONA_WEBHOOK_PROTOCOL: undefined }, NOW));
});

test('lifecycle storage atomically counts unique events, not repeated deliveries; conflicts cannot increment', async t => {
  const db = database(); t.after(() => db.close());
  const env = envFor(db), app = worker();
  const first = await app.fetch(webhook(), env); assert.equal(first.status, 202);
  assert.equal((await first.json()).duplicate, false);
  const retry = await app.fetch(webhook(), env); assert.equal(retry.status, 202);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal((await app.fetch(webhook({ id: 'msg_second' }), env)).status, 202);
  assert.equal((await app.fetch(webhook({ fields: { newState: 'starting' } }), env)).status, 409);
  const rows = db.sql.prepare('SELECT * FROM lifecycle_buckets').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].count, 2);
  assert.ok(!JSON.stringify(rows).includes('FAKE_PRIVATE'));
  assert.equal(rows[0].expires_at, rows[0].observed_at + 90 * 86_400_000);
  const dump = db.sql.prepare('SELECT * FROM receipts').all();
  assert.ok(!JSON.stringify(dump).includes('FAKE_PRIVATE'));
  assert.ok(!JSON.stringify(dump).includes('msg_synthetic'));
});

test('lifecycle reads remain private and expiry/purge continue with collection off', async t => {
  const db = database(); t.after(() => db.close()); const env = envFor(db), app = worker();
  assert.equal((await app.fetch(webhook(), env)).status, 202);
  const from = Math.floor(NOW / BUCKET_MS) * BUCKET_MS;
  const url = `https://invalid/v1/read/lifecycle?from=${from}&to=${NOW + 1}&limit=10`;
  assert.equal((await app.fetch(new Request(url), env)).status, 401);
  const read = await app.fetch(new Request(url, { headers: { Authorization: `Bearer ${env.READ_SECRET}` } }), env);
  assert.equal(read.status, 200); assert.equal((await read.json()).rows[0].count, 1);
  const later = from + 90 * 86_400_000 + 1;
  assert.deepEqual(await readRows(db, 'lifecycle', { from, to: NOW + 1, limit: 10 }, later, env), []);
  await createWorker({ clock: () => later }).scheduled({}, { ...env, TELEMETRY_ENABLED: 'false' });
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM lifecycle_buckets').get().n, 0);
});

test('lifecycle durable retention cannot be raised and retired events cannot return', async t => {
  const db = database(); t.after(() => db.close());
  const payload = await webhookEnvelope(webhook(), DAYTONA_ENV, NOW);
  await ingest(db, 'lifecycle', validate('lifecycle', payload, {}, NOW), NOW);
  const later = NOW + 8 * 86_400_000;
  await purge(db, later, { RETENTION_DAYS: '90' });
  assert.equal(db.sql.prepare("SELECT ttl_ms FROM retention_state WHERE class='lifecycle'").get().ttl_ms, 7 * 86_400_000);
  await assert.rejects(ingest(db, 'lifecycle', validate('lifecycle', payload, { RETENTION_DAYS: '90' }, later), later, { RETENTION_DAYS: '90' }));
});

test('organization protobuf keeps fractional capacities and bounded disjoint dimensions', async () => {
  const payload = await organizationEnvelope(otlp(), DAYTONA_ENV);
  const data = validate('metrics', payload, { RETENTION_DAYS: '90' }, NOW);
  assert.equal(data.points[0].value, 1.5);
  assert.deepEqual(data.points[0].attributes, { region: 'us', sandbox_class: 'container' });
  assert.ok(!JSON.stringify(data).includes('synthetic-org'));
  assert.ok(!JSON.stringify(data).includes('FAKE_PRIVATE'));
  assert.deepEqual(await organizationEnvelope(otlp(), DAYTONA_ENV), payload);
  const observed = await organizationEnvelope(otlp(organizationWire({ unit: '{cpu}', integer: true, value: 2 })), DAYTONA_ENV);
  assert.equal(observed.points[0].value, 2); assert.equal(observed.points[0].unit, 'cores');
});

test('organization filter excludes sandbox resources/unknown metrics and rejects unknown dimensions/units', async () => {
  for (const options of [{ sandboxResource: true }, { name: 'daytona.sandbox.cpu.utilization' }, { organization: 'other-org' }])
    assert.equal(await organizationEnvelope(otlp(organizationWire(options)), DAYTONA_ENV), null);
  for (const options of [{ extraDimension: true }, { region: 'FAKE_PRIVATE' }, { sandboxClass: 'FAKE_PRIVATE' },
    { value: -1 }, { value: Infinity }, { unit: 'bytes' }])
    await assert.rejects(organizationEnvelope(otlp(organizationWire(options)), DAYTONA_ENV));
  const wire = organizationWire();
  const mixed = Buffer.concat([wire, organizationWire({ sandboxResource: true })]);
  assert.deepEqual(await organizationEnvelope(otlp(mixed), DAYTONA_ENV), await organizationEnvelope(otlp(wire), DAYTONA_ENV));
  const duplicate = Buffer.concat([wire, wire]);
  assert.equal((await organizationEnvelope(otlp(duplicate), DAYTONA_ENV)).points.length, 1);
  await assert.rejects(organizationEnvelope(otlp(Buffer.concat([wire, organizationWire({ value: 2 })])), DAYTONA_ENV));
});

test('OTLP authentication, source isolation, deterministic retries and no-reading discard of logs/traces', async t => {
  const db = database(); t.after(() => db.close()); const env = envFor(db), app = worker();
  assert.equal((await app.fetch(otlp(undefined, 'metrics', 'wrong'), env)).status, 401);
  assert.equal((await app.fetch(otlp(undefined, 'metrics', 'synthetic-owui-write-secret-12345678'), env)).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await app.fetch(otlp(), env)).status, 200);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM metric_points').get().n, 1);
  for (const signal of ['logs', 'traces']) {
    assert.equal((await app.fetch(otlp(Buffer.from('FAKE_PRIVATE_LOG_CONTENT'), signal), env)).status, 200);
    assert.equal((await app.fetch(otlp(Buffer.alloc(262145), signal), env)).status, 200);
    let pulls = 0, cancelled = false;
    const body = new ReadableStream({ pull() { pulls++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const noRead = new Request(`https://invalid/v1/daytona/otlp/${signal}`, { method: 'POST',
      headers: { Authorization: 'Bearer synthetic-daytona-write-secret-123456' }, body, duplex: 'half' });
    assert.equal((await app.fetch(noRead, env)).status, 200);
    assert.equal(pulls, 0); assert.equal(cancelled, true);
  }
  const result = await app.fetch(otlp(organizationWire({ sandboxResource: true })), env);
  assert.equal(result.status, 200);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM receipts').get().n, 1);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM metric_points').get().n, 1);
});

test('independent switches, global switch and invalid webhooks prevent any database work', async () => {
  const env = envFor(undefined), app = worker();
  for (const [request, override] of [[webhook(), { DAYTONA_WEBHOOKS_ENABLED: 'false' }],
    [otlp(), { DAYTONA_OTLP_ENABLED: 'false' }], [webhook(), { TELEMETRY_ENABLED: 'false' }]])
    assert.equal((await app.fetch(request, { ...env, ...override })).status, 503);
  const bad = signedWebhook(); bad.headers['webhook-signature'] = 'v1,AAAA';
  assert.equal((await app.fetch(new Request('https://invalid/v1/daytona/webhooks', bad), env)).status, 400);
  let key;
  const limited = { ...env, DAYTONA_EDGE_LIMITER: { limit: async input => { key = input.key; return { success: false }; } } };
  assert.equal((await app.fetch(webhook(), limited)).status, 429); assert.equal(key, 'daytona');
});

test('metric policy separates provider writers and rejects identifiers/fractional user counts', async () => {
  const payload = await organizationEnvelope(otlp(), DAYTONA_ENV);
  assert.throws(() => validate('metrics', { ...payload, source: 'owui' }, {}, NOW));
  assert.throws(() => validate('metrics', { ...payload, points: [{ ...payload.points[0], attributes: { region: 'us', sandbox_class: 'container', sandbox_id: 'FAKE' } }] }, {}, NOW));
  assert.throws(() => validate('metrics', { ...payload, points: [{ name: 'webui.users.total', kind: 'gauge', unit: 'users', value: 1, observed_at: NOW, attributes: {} }] }, {}, NOW));
});

test('qualification diagnostics retain fixed vocabulary, never raw attribute values', () => {
  const observed = shapes(organizationWire({ unit: '{cpu}', integer: true, value: 2 }));
  assert.equal(observed[0].unit, '{cpu}'); assert.equal(observed[0].numeric, 'integer');
  assert.deepEqual(observed[0].dimensions, { 'region.id': 'us', 'sandbox.class': 'container' });
  const excluded = shapes(organizationWire({ region: 'FAKE_PRIVATE', sandboxClass: 'FAKE_PRIVATE', extraDimension: true }));
  assert.ok(!JSON.stringify(excluded).includes('FAKE_PRIVATE'));
  assert.equal(excluded[0].dimensions['region.id'], '<excluded>');
  assert.ok(excluded[0].point_keys.includes('<excluded>'));
});

test('OTLP body-read deadlines are retryable and never reach storage', async () => {
  const body = new ReadableStream({ cancel() {} });
  const request = new Request('https://invalid/v1/daytona/otlp/metrics', { method: 'POST',
    headers: { 'Content-Type': 'application/x-protobuf', Authorization: 'Bearer synthetic-daytona-write-secret-123456' },
    body, duplex: 'half' });
  const response = await worker().fetch(request, envFor(undefined));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'unavailable' });
});
