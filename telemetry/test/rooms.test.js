import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validate.js';
import { createWorker } from '../src/worker.js';
import { ROOM_VOCABULARY, ROOM_SERIES } from '../src/policies.js';
import { database } from './d1.js';

// Proposed vocabulary (review required): these tests pin the closed matrix, not activation.
const NOW = Math.floor(Date.now() / 900000) * 900000;
const WRITE = 'synthetic-rooms-only-writer-for-tests';
const READ = 'synthetic-operator-only-reader-for-tests';
const product = attrs => Object.entries(attrs).reduce((rows, [k, values]) =>
  rows.flatMap(row => values.map(v => ({ ...row, [k]: v }))), [{}]);
function payload() {
  return { schema_version: 1, source: 'rooms', batch_id: crypto.randomUUID(), observed_at: NOW,
    points: Object.entries(ROOM_VOCABULARY).flatMap(([name, attrs]) => product(attrs).map(attributes => ({
      name, kind: 'sum', unit: name === 'room.append.bytes' ? 'By' : '1', observed_at: NOW, start_at: NOW - 900000,
      temporality: 'delta', monotonic: true, value: 1, attributes }))) };
}
const at = (data, name) => data.points.find(p => p.name === name);

test('rooms admits exactly the fixed 30-series delta matrix, never an identity dimension', () => {
  const data = payload();
  assert.equal(ROOM_SERIES, 30);
  assert.equal(data.points.length, 30);
  assert.deepEqual(validate('metrics', data, {}, NOW).points, data.points);
  // A partial window is valid: missing series are unknown, not zero.
  assert.equal(validate('metrics', { ...data, points: data.points.slice(0, 1) }, {}, NOW).points.length, 1);
  for (const change of [
    p => { p.source = 'inboxes'; },
    p => { p.points[0].attributes.room_id = 'private-room-canary'; },
    p => { p.points[0].attributes.outcome = 'private-error-canary'; },
    p => { p.points[0].attributes.codec = 'private-codec-canary'; },
    p => { delete p.points[0].attributes.codec; },
    p => { at(p, 'room.presence').attributes.codec = 'json'; },
    p => { at(p, 'room.fanout.frames').attributes.kind = 'private-kind-canary'; },
    p => { at(p, 'room.fanout.frames').attributes.outcome = 'relayed'; },
    p => { at(p, 'room.append.bytes').attributes.outcome = 'too_large'; },
    p => { at(p, 'room.append.bytes').unit = '1'; },
    p => { at(p, 'room.connections').attributes.codec = 'json'; },
    p => { p.points[0].name = 'room.unknown'; },
    p => { p.points[0].value = 0.5; },
    p => { p.points[0].temporality = 'cumulative'; },
    p => { p.points[0].observed_at--; },
    p => { p.points[0].start_at--; },
    p => { p.points[0].start_time_unix_nano = '1'; },
    p => { p.points[0].attributes = {}; },
    p => { p.points.push(p.points[0]); },
    p => { p.points[0] = { ...p.points[0], name: 'inbox.cleanup', attributes: { outcome: 'success' } }; },
  ]) {
    const bad = structuredClone(data); change(bad);
    assert.throws(() => validate('metrics', bad, {}, NOW));
  }
  const inbox = { ...payload(), source: 'inboxes' };
  assert.throws(() => validate('metrics', inbox, {}, NOW), 'room metrics never enter another source');
});

test('rooms receiver defaults off, requires its own writer, deduplicates and keeps reads private', async t => {
  const db = database(); t.after(() => db.close());
  const env = { TELEMETRY_ENABLED: 'true', TELEMETRY_DB: db, RETENTION_DAYS: '90', INBOXES_METRICS_ENABLED: 'true',
    READ_SECRET: READ, WRITE_KEYS_JSON: JSON.stringify({ rooms: WRITE, inboxes: 'synthetic-inboxes-only-writer-for-tests' }) };
  const worker = createWorker({ clock: () => NOW });
  const body = payload();
  const post = (token = WRITE) => new Request('https://telemetry.invalid/v1/metrics', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(post(), env)).status, 503);
  env.ROOMS_METRICS_ENABLED = 'true';
  assert.equal((await worker.fetch(post(READ), env)).status, 401);
  assert.equal((await worker.fetch(post('synthetic-inboxes-only-writer-for-tests'), env)).status, 400);
  assert.equal((await worker.fetch(post(), env)).status, 202);
  assert.equal((await (await worker.fetch(post(), env)).json()).duplicate, true);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM metric_points').get().n, 30);
  const url = `https://telemetry.invalid/v1/read/metrics?from=${NOW - 1}&to=${NOW + 1}&limit=100`;
  assert.equal((await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${WRITE}` } }), env)).status, 401);
  const result = await (await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${READ}` } }), env)).json();
  assert.equal(result.rows.length, 30);
  assert.ok(result.rows.every(r => r.source === 'rooms' && r.expires_at === NOW + 90 * 86400000));
  assert.ok(!JSON.stringify(result).includes(WRITE));
});
