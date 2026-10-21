import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validate.js';
import { createWorker } from '../src/worker.js';
import { database } from './d1.js';

const NOW = Math.floor(Date.now() / 900000) * 900000;
const WRITE = 'synthetic-inboxes-only-writer-for-tests';
const READ = 'synthetic-operator-only-reader-for-tests';
const outcomes = {
  'inbox.receipts': ['accepted', 'auth', 'rate', 'quota', 'size', 'unknown_address', 'failure'],
  'inbox.lifecycle': ['created', 'destroy_requested', 'destroyed'],
  'inbox.cleanup': ['expired', 'stale', 'retried', 'destroyed_messages', 'reconciled', 'success', 'failure'],
  'inbox.export.pages': ['emitted'],
  'inbox.export.bytes': ['emitted'],
};
function payload() {
  return { schema_version: 1, source: 'inboxes', batch_id: crypto.randomUUID(), observed_at: NOW,
    points: Object.entries(outcomes).flatMap(([name, values]) =>
      (name === 'inbox.cleanup' ? [''] : ['http', 'email']).flatMap(transport => values.map(outcome => ({
        name, kind: 'sum', unit: name === 'inbox.export.bytes' ? 'By' : '1', observed_at: NOW, start_at: NOW - 900000,
        temporality: 'delta', monotonic: true, value: 1,
        attributes: { ...(transport ? { transport } : {}), outcome },
      })))) };
}

test('inboxes admits exactly the fixed 31-series delta matrix, never an identity dimension', () => {
  const data = payload();
  assert.equal(data.points.length, 31);
  assert.deepEqual(validate('metrics', data, {}, NOW).points, data.points);
  for (const change of [
    p => { p.source = 'owui'; },
    p => { p.points[0].attributes.address = 'private-address-canary'; },
    p => { p.points[0].attributes.outcome = 'private-error-canary'; },
    p => { p.points[0].value = 0.5; },
    p => { p.points[0].temporality = 'cumulative'; },
    p => { p.points[0].observed_at--; },
    p => { p.points[0].start_at--; },
    p => { p.points[0].start_time_unix_nano = '1'; },
    p => { p.points[0].attributes = {}; },
    p => { p.points.push(p.points[0]); },
  ]) {
    const bad = structuredClone(data); change(bad);
    assert.throws(() => validate('metrics', bad, {}, NOW));
  }
});

test('inboxes receiver defaults off, requires its own writer, deduplicates and keeps reads private', async t => {
  const db = database(); t.after(() => db.close());
  const env = { TELEMETRY_ENABLED: 'true', TELEMETRY_DB: db, RETENTION_DAYS: '90',
    READ_SECRET: READ, WRITE_KEYS_JSON: JSON.stringify({ inboxes: WRITE, owui: 'synthetic-owui-only-writer-for-tests' }) };
  const worker = createWorker({ clock: () => NOW });
  const body = payload();
  const post = (token = WRITE) => new Request('https://telemetry.invalid/v1/metrics', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(post(), env)).status, 503);
  env.INBOXES_METRICS_ENABLED = 'true';
  assert.equal((await worker.fetch(post(READ), env)).status, 401);
  assert.equal((await worker.fetch(post('synthetic-owui-only-writer-for-tests'), env)).status, 400);
  assert.equal((await worker.fetch(post(), env)).status, 202);
  assert.equal((await (await worker.fetch(post(), env)).json()).duplicate, true);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM metric_points').get().n, 31);
  const url = `https://telemetry.invalid/v1/read/metrics?from=${NOW - 1}&to=${NOW + 1}&limit=100`;
  assert.equal((await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${WRITE}` } }), env)).status, 401);
  const result = await (await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${READ}` } }), env)).json();
  assert.equal(result.rows.length, 31);
  assert.ok(result.rows.every(r => r.expires_at === NOW + 90 * 86400000));
  assert.ok(!JSON.stringify(result).includes(WRITE));
});
