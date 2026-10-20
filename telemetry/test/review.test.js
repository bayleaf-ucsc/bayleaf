import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './d1.js';
import { retentionScenarios } from './retention-scenarios.js';
import { validate, Invalid } from '../src/validate.js';
import { createWorker, boundedJson } from '../src/worker.js';
import { ingest, purge } from '../src/store.js';
import { DAY, retentionMs } from '../src/policies.js';

const NOW = 1_790_000_000_000;
const READ = 'local-distinct-read-secret-1234567';
const WRITE = 'local-distinct-write-secret-123456';
const envFor = db => ({ TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'true', TELEMETRY_DB: db,
  READ_SECRET: READ, WRITE_KEYS_JSON: JSON.stringify({ 'chat-retention': WRITE }) });
test('90-day policy bounds preserve the local default and per-class overrides', () => {
  for (const klass of ['browser', 'metrics', 'deletions', 'probes']) {
    assert.equal(retentionMs({}, klass), 7 * DAY);
    assert.equal(retentionMs({ RETENTION_DAYS: '90' }, klass), 90 * DAY);
    assert.equal(retentionMs({ RETENTION_DAYS: '90', [`${klass.toUpperCase()}_RETENTION_DAYS`]: '1' }, klass), DAY);
    for (const days of ['0', '91', '90.5', 'NaN']) {
      assert.throws(() => retentionMs({ RETENTION_DAYS: days }, klass), /configuration/);
      assert.throws(() => retentionMs({ [`${klass.toUpperCase()}_RETENTION_DAYS`]: days }, klass), /configuration/);
    }
  }
  const input = { schema_version: 1, source: 'chat-retention', batch_id: '00000000-0000-4000-8000-000000000000',
    observed_at: NOW - 90 * DAY + 1, job: 'chat-retention', outcome: 'success', deleted: 0, duration_ms: 0, extensions: {} };
  assert.equal(validate('deletions', input, { RETENTION_DAYS: '90' }, NOW).expires_at, NOW + 1);
  assert.throws(() => validate('deletions', { ...input, observed_at: NOW - 90 * DAY }, { RETENTION_DAYS: '90' }, NOW), Invalid);
});

test('raising local seven-day initialization to 90 cannot extend durable retention', async t => {
  const db = database(); t.after(() => db.close());
  const input = { schema_version: 1, source: 'chat-retention', batch_id: '00000000-0000-4000-8000-000000000000',
    observed_at: NOW, job: 'chat-retention', outcome: 'success', deleted: 0, duration_ms: 0, extensions: {} };
  await ingest(db, 'deletions', validate('deletions', input, {}, NOW), NOW, {});
  const next = { ...input, batch_id: '00000000-0000-4000-8000-000000000001', observed_at: NOW + 1 };
  const production = { RETENTION_DAYS: '90' };
  await ingest(db, 'deletions', validate('deletions', next, production, NOW + 1), NOW + 1, production);
  assert.equal((await db.prepare('SELECT ttl_ms FROM retention_state WHERE class=?').bind('deletions').first()).ttl_ms, 7 * DAY);
  assert.equal((await db.prepare('SELECT expires_at FROM deletion_runs WHERE batch_id=?').bind(next.batch_id).first()).expires_at, NOW + 1 + 7 * DAY);
});

test('retention transitions remain irreversible before and after purge, including point/envelope mismatch', async t => {
  const db = database(); t.after(() => db.close());
  await retentionScenarios(db);
});

test('actual browser ingress rejects URL-recognized disguised IPs without persisting observations', async t => {
  const db = database(); t.after(() => db.close());
  const worker = createWorker({ clock: () => NOW });
  for (const referring_hostname of ['192.0.2.123.', '127.1', '0177.0.0.1', '0x7f.0x0.0x0.0x1', '0x7f.1',
    '2130706433.', '0300.0000.0002.0173', '127.0.0.1', '[::1]', '2001:db8::1']) {
    const reply = await worker.fetch(new Request('https://telemetry.invalid/v1/browser', { method: 'POST',
      headers: { Origin: 'https://bayleaf.dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema_version: 1, destination: 'landing', referring_hostname }) }), envFor(db));
    assert.equal(reply.status, 400, referring_hostname);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM browser_observations').first()).n, 0);
  assert.equal(validate('browser', { schema_version: 1, destination: 'landing', referring_hostname: 'Example.Org.' }, {}, NOW).referring_hostname, 'example.org');
});

test('read/write secret collisions and malformed credential maps deny both privileged directions', async t => {
  const db = database(); t.after(() => db.close());
  const worker = createWorker({ clock: () => NOW });
  for (const env of [
    { ...envFor(db), READ_SECRET: WRITE },
    { ...envFor(db), WRITE_KEYS_JSON: JSON.stringify({ 'chat-retention': READ }) },
    { ...envFor(db), WRITE_KEYS_JSON: '{' },
    { ...envFor(db), WRITE_KEYS_JSON: JSON.stringify({ 'chat-retention': WRITE, 'api-retention': WRITE }) },
  ]) {
    for (const secret of [READ, WRITE]) {
      const reply = await worker.fetch(new Request(`https://telemetry.invalid/v1/read/deletions?from=${NOW - 1}&to=${NOW + 1}&limit=1`,
        { headers: { Authorization: `Bearer ${secret}` } }), env);
      assert.equal(reply.status, 503);
      assert.deepEqual(await reply.json(), { error: 'configuration' });
    }
    const write = await worker.fetch(new Request('https://telemetry.invalid/v1/deletions', { method: 'POST',
      headers: { Authorization: `Bearer ${WRITE}` } }), env);
    assert.equal(write.status, 503);
  }
});

test('normalized JSON ingress rejects impossible empty histograms and permits absent or zero sum', async t => {
  const db = database(); t.after(() => db.close());
  const worker = createWorker({ clock: () => NOW });
  const env = { ...envFor(db), WRITE_KEYS_JSON: JSON.stringify({ owui: WRITE }) };
  const point = { name: 'http.server.duration', kind: 'histogram', unit: 'ms', observed_at: NOW,
    start_at: NOW - 60_000, temporality: 'delta', count: 0, bounds: [100, 500], bucket_counts: [0, 0, 0], attributes: {} };
  let sequence = 0;
  const envelope = p => ({ schema_version: 1, source: 'owui', batch_id: `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`, observed_at: NOW, points: [p] });
  const post = p => worker.fetch(new Request('https://telemetry.invalid/v1/metrics', { method: 'POST',
    headers: { Authorization: `Bearer ${WRITE}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope(p)) }), env);
  for (const extra of [{ sum: 600 }, { min: 10 }, { max: 400 }, { sum: 0, min: 0 }, { sum: 600, min: 10, max: 400 }]) {
    assert.throws(() => validate('metrics', envelope({ ...point, ...extra }), {}, NOW), Invalid);
    assert.equal((await post({ ...point, ...extra })).status, 400);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM metric_points').first()).n, 0);
  for (const extra of [{}, { sum: 0 }]) assert.equal((await post({ ...point, ...extra })).status, 202);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM metric_points').first()).n, 2);
});

test('bounded future clock skew cannot create an expiry/replay resurrection gap', async t => {
  const db = database(); t.after(() => db.close());
  const observed = NOW + 60_000;
  const input = { schema_version: 1, source: 'chat-retention', batch_id: '00000000-0000-4000-8000-000000000000',
    observed_at: observed, job: 'chat-retention', outcome: 'success', deleted: 0, duration_ms: 0, extensions: {} };
  const short = { RETENTION_DAYS: '1' }, long = { RETENTION_DAYS: '7' };
  const data = validate('deletions', input, short, NOW);
  assert.equal(data.expires_at, observed + DAY);
  await ingest(db, 'deletions', data, NOW, short);
  await purge(db, observed + DAY, short);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM receipts').first()).n, 0);
  await assert.rejects(ingest(db, 'deletions', validate('deletions', input, long, observed + DAY), observed + DAY, long), Invalid);
});

test('JSON stream chunk count is bounded independently of total bytes', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedJson(new Request('https://telemetry.invalid', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' })), Invalid);
  assert.equal(cancelled, true);
});
