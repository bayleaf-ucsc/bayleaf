import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from './d1.js';
import { createWorker } from '../src/worker.js';
import { openapi } from '../src/openapi.js';
import { DAY } from '../src/policies.js';

const NOW = 1_789_948_800_000; // UTC midnight, so aligned to every bucket width
const HOUR = 3_600_000;
const READ = 'local-fake-read-token-1234567890';
let index = 0;
function insert(db, point) {
  const row = { schema_version: 1, policy_version: 4, source: 'owui', batch_id: randomUUID(), point_index: index++,
    received_at: NOW, expires_at: NOW + DAY, kind: 'gauge', unit: 'users', attributes_json: '{}', ...point };
  const names = Object.keys(row);
  db.sql.prepare(`INSERT INTO metric_points (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(row));
}
function setup(t) {
  const db = database(); t.after(() => db.close());
  const env = { TELEMETRY_ENABLED: 'true', TELEMETRY_DB: db, READ_SECRET: READ,
    WRITE_KEYS_JSON: JSON.stringify({ owui: 'local-fake-write-token-123456789' }) };
  const worker = createWorker({ clock: () => NOW });
  const get = (query, token = READ) => worker.fetch(new Request(`https://telemetry.invalid/v1/read/metric-buckets${query}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }), env);
  const read = async (name, bucket = 300_000, limit = 100) => {
    const r = await get(`?from=${NOW - 6 * DAY}&to=${NOW + 1}&name=${name}&bucket=${bucket}&limit=${limit}`);
    assert.equal(r.status, 200);
    return r.json();
  };
  return { db, get, read };
}

test('metric buckets require the operator bearer and the exact parameter set', async t => {
  const { get } = setup(t);
  const ok = `from=${NOW - HOUR}&to=${NOW}&name=webui.users.active&bucket=60000&limit=10`;
  assert.equal((await get(`?${ok}`, null)).status, 401);
  assert.equal((await get(`?${ok}`, 'local-fake-write-token-123456789')).status, 401);
  for (const query of ['', `?from=${NOW - HOUR}&to=${NOW}&name=webui.users.active&bucket=60000`,
    `?${ok}&sql=DROP`, `?${ok}&bucket=60000`, `?${ok}&name=webui.users.total`,
    `?${ok.replace('webui.users.active', 'webui.users.secret')}`, `?${ok.replace('webui.users.active', 'constructor')}`,
    `?${ok.replace('webui.users.active', '__proto__')}`, `?${ok.replace('bucket=60000', 'bucket=120000')}`,
    `?${ok.replace('bucket=60000', 'bucket=-60000')}`, `?${ok.replace('limit=10', 'limit=2001')}`,
    `?${ok.replace('limit=10', 'limit=0')}`, `?${ok.replace(`from=${NOW - HOUR}`, `from=${NOW - 91 * DAY}`)}`,
    `?${ok.replace(`to=${NOW}`, `to=${NOW + HOUR}`)}`, `?${ok.replace(`from=${NOW - HOUR}`, `from=${NOW}`)}`]) {
    assert.equal((await get(query)).status, 400, query);
  }
  // Unlike raw reads, aggregates may span the whole retention maximum.
  assert.equal((await get(`?${ok.replace(`from=${NOW - HOUR}`, `from=${NOW - 30 * DAY}`)}`)).status, 200);
  const r = await get(`?${ok.replace('limit=10', 'limit=2000')}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), Object.keys(openapi.components.schemas.MetricBucketRowResponse.properties).sort());
  assert.deepEqual({ ...body, as_of: 0 }, { schema_version: 1, policy_version: 4, as_of: 0, from: NOW - HOUR, to: NOW,
    name: 'webui.users.active', bucket: 60000, limit: 2000, truncated: false, rows: [] });
});

test('gauges summarize min/max/last per aligned series bucket and flag same-ms conflicts', async t => {
  const { db, read } = setup(t);
  const name = 'webui.users.active';
  for (const [at, value] of [[-600_000, 4], [-540_000, 9], [-360_000, 6], [-120_000, 3]]) insert(db, { name, observed_at: NOW + at, value });
  insert(db, { name, observed_at: NOW - 360_000, value: 6, expires_at: NOW + HOUR }); // exact export overlap collapses
  insert(db, { name, observed_at: NOW - 120_000, value: 3, attributes_json: '{"instance":"b"}' });
  insert(db, { name, observed_at: NOW - 60_000, value: 7, attributes_json: '{"instance":"b"}' });
  insert(db, { name, observed_at: NOW - 60_000, value: 8, attributes_json: '{"instance":"b"}' });
  insert(db, { name: 'webui.users.total', observed_at: NOW - 60_000, value: 99 });
  const { rows } = await read(name);
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(openapi.components.schemas.MetricBucketRow.properties).sort());
  assert.deepEqual(rows.map(r => [r.bucket_start, r.attributes_json, r.samples, r.min_value, r.max_value, r.last_value, r.conflict]), [
    [NOW - 600_000, '{}', 3, 4, 9, 6, 0],
    [NOW - 300_000, '{"instance":"b"}', 3, 3, 8, rows[1].last_value, 1],
    [NOW - 300_000, '{}', 1, 3, 3, 3, 0],
  ]);
  assert.deepEqual([rows[0].min_expires_at, rows[1].min_expires_at], [NOW + HOUR, NOW + DAY], 'earliest expiry survives deduplication');
  assert.deepEqual([rows[0].first_at, rows[0].last_at, rows[0].kind, rows[0].unit, rows[0].delta_sum], [NOW - 600_000, NOW - 360_000, 'gauge', 'users', null]);
  insert(db, { name, observed_at: NOW - 60_000, value: 8, attributes_json: '{"instance":"c"}', batch_id: 'x', point_index: 0 });
  insert(db, { name, observed_at: NOW - 60_000, value: 8, attributes_json: '{"instance":"c"}', batch_id: 'y', point_index: 0 });
  const c = (await read(name)).rows.find(r => r.attributes_json === '{"instance":"c"}');
  assert.deepEqual([c.samples, c.conflict], [1, 0], 'identical duplicates are not a conflict');
});

test('delta sums deduplicate exact points; cumulative last values keep reset metadata', async t => {
  const { db, read } = setup(t);
  const delta = { name: 'inbox.receipts', source: 'inboxes', kind: 'sum', unit: '1', temporality: 'delta', monotonic: 1,
    attributes_json: '{"outcome":"accepted","transport":"http"}' };
  for (const [at, value] of [[-2 * HOUR, 2], [-HOUR - 900_000, 5], [-HOUR - 900_000, 5], [-HOUR, 1]])
    insert(db, { ...delta, observed_at: NOW + at, start_at: NOW + at - 900_000, value });
  assert.deepEqual((await read('inbox.receipts', HOUR)).rows.map(r => [r.bucket_start, r.samples, r.delta_sum]),
    [[NOW - 2 * HOUR, 2, 7], [NOW - HOUR, 1, 1]]);
  const histogram = { name: 'http.server.duration', kind: 'histogram', unit: 'ms', temporality: 'cumulative', bounds_json: '[100,500]' };
  insert(db, { ...histogram, observed_at: NOW - 240_000, start_at: NOW - DAY, count: 10, sum: 900, bucket_counts_json: '[9,1,0]' });
  insert(db, { ...histogram, observed_at: NOW - 120_000, start_at: NOW - 150_000, count: 2, sum: 80, bucket_counts_json: '[2,0,0]' });
  const [row] = (await read('http.server.duration', 900_000)).rows;
  assert.deepEqual([row.samples, row.min_value, row.max_value, row.last_count, row.last_sum, row.last_start_at,
    row.last_bucket_counts_json, row.last_bounds_json, row.temporality, row.delta_sum, row.conflict],
  [2, null, null, 2, 80, NOW - 150_000, '[2,0,0]', '[100,500]', 'cumulative', null, 0]);
});

test('metric buckets exclude expired and retired points and flag truncation', async t => {
  const { db, read } = setup(t);
  const name = 'webui.users.total';
  insert(db, { name, observed_at: NOW - 3 * HOUR, value: 1 });
  insert(db, { name, observed_at: NOW - 2 * HOUR, value: 2, expires_at: NOW });
  insert(db, { name, observed_at: NOW - HOUR, value: 3 });
  insert(db, { name, observed_at: NOW - 90 * 60_000, value: 4 });
  db.sql.prepare("INSERT INTO retention_state(class,ttl_ms,cutoff_ms) VALUES ('metrics',?,?)").run(7 * DAY, NOW - 150 * 60_000);
  const full = await read(name, HOUR);
  assert.deepEqual(full.rows.map(r => r.last_value), [4, 3]);
  assert.equal(full.truncated, false);
  const capped = await read(name, HOUR, 1);
  assert.deepEqual([capped.truncated, capped.rows.map(r => r.last_value)], [true, [4]]);
});
