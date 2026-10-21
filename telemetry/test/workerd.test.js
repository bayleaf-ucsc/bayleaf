import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { otlpHook } from '../otlp/worker-adapter.mjs';
import { retentionScenarios } from './retention-scenarios.js';
import { DAYTONA_ENV, signedWebhook, organizationWire } from './daytona-fixtures.js';

// Reuse already installed repo tooling without fetching or installing anything.
const local = createRequire(import.meta.url);
const api = createRequire(new URL('../../api/package.json', import.meta.url));
function dependency(name) { try { return local(name); } catch { return api(name); } }
const { build } = dependency('esbuild');
const { Miniflare, convertV4MiniflareOptions } = dependency('miniflare');

test('workerd / real D1: concurrent retries, conflicts, bounded reads, physical purge', async t => {
  const fixture = JSON.parse(await readFile(new URL('../otlp/fixture.normalized.json', import.meta.url), 'utf8'));
  const now = Number(fixture.points.reduce((n, p) => BigInt(p.timeUnixNano) > n ? BigInt(p.timeUnixNano) : n, 0n) / 1_000_000n);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import { createWorker } from './src/worker.js';
    import { otlpHook } from './otlp/worker-adapter.mjs';
    export default createWorker({clock:()=>${now},otlp:otlpHook});
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const read = 'local-only-read-token-1234567890';
  const write = 'local-only-write-token-123456789';
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-01',
    d1Databases: ['TELEMETRY_DB'], bindings: { ...DAYTONA_ENV, TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'true',
      READ_SECRET: read, WRITE_KEYS_JSON: JSON.stringify({ 'chat-retention': write, owui: `${write}-owui`, daytona: `${write}-daytona` }) },
    outboundService: () => { throw new Error('No outbound calls permitted'); },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('TELEMETRY_DB');
  for (const file of ['0001_telemetry.sql', '0002_retention_state.sql', '0003_browser_network.sql', '0004_daytona_lifecycle.sql']) {
    const migration = (await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')).replace(/^\s*--.*$/gm, '');
    for (const stmt of migration.split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
  }
  const payload = { schema_version: 1, source: 'chat-retention', batch_id: randomUUID(), observed_at: now,
    job: 'chat-retention', outcome: 'success', duration_ms: 123, deleted: 7, extensions: {} };
  const post = body => mf.dispatchFetch('https://telemetry.invalid/v1/deletions', {
    method: 'POST', headers: { Authorization: `Bearer ${write}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const replies = await Promise.all(Array.from({ length: 8 }, () => post(payload)));
  assert.deepEqual(replies.map(r => r.status), Array(8).fill(202));
  const results = await Promise.all(replies.map(r => r.json()));
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM deletion_runs').first()).n, 1);
  const contested = { ...payload, batch_id: randomUUID() };
  const conflicts = await Promise.all([post(contested), post({ ...contested, deleted: 999 })]);
  assert.deepEqual(conflicts.map(r => r.status).sort(), [202, 409]);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM deletion_runs').first()).n, 2);
  const r = await mf.dispatchFetch(`https://telemetry.invalid/v1/read/deletions?from=${now - 1}&to=${now + 1}&limit=10`,
    { headers: { Authorization: `Bearer ${read}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rows.length, 2);
  const protobuf = await readFile(new URL('../otlp/fixture.pb', import.meta.url));
  const native = () => mf.dispatchFetch('https://telemetry.invalid/v1/otlp/metrics', {
    method: 'POST', headers: { Authorization: `Bearer ${write}-owui`, 'Content-Type': 'application/x-protobuf' }, body: protobuf });
  for (let i = 0; i < 2; i++) {
    const reply = await native();
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('Content-Type'), 'application/x-protobuf');
    assert.equal((await reply.arrayBuffer()).byteLength, 0);
  }
  const points = (await db.prepare('SELECT * FROM metric_points ORDER BY point_index').all()).results;
  const expected = await otlpHook(new Request('https://telemetry.invalid', { method: 'POST',
    headers: { 'Content-Type': 'application/x-protobuf' }, body: protobuf }), { source: 'owui', now });
  assert.equal(points.length, 11, 'real native fixture retry must not duplicate points');
  assert.equal(points[0].time_unix_nano, expected.points[0].time_unix_nano);
  assert.equal(points[0].start_time_unix_nano, expected.points[0].start_time_unix_nano);
  assert.equal(points.find(p => p.kind === 'gauge').attributes_json, '{}');
  assert.equal(points.find(p => p.kind === 'histogram').temporality, 'cumulative');
  const malformed = await mf.dispatchFetch('https://telemetry.invalid/v1/otlp/metrics', {
    method: 'POST', headers: { Authorization: `Bearer ${write}-owui`, 'Content-Type': 'application/x-protobuf' }, body: new Uint8Array([255]) });
  assert.equal(malformed.status, 400, 'invalid native input must not trigger exporter retry');
  const lifecycle = options => mf.dispatchFetch('https://telemetry.invalid/v1/daytona/webhooks',
    signedWebhook({ ...options, timestamp: Math.floor(now / 1000) }));
  const deliveries = await Promise.all(Array.from({ length: 8 }, () => lifecycle()));
  assert.deepEqual(deliveries.map(r => r.status), Array(8).fill(202));
  assert.equal((await db.prepare('SELECT count FROM lifecycle_buckets').first()).count, 1);
  const competing = await Promise.all([lifecycle({ id: 'msg_competing' }),
    lifecycle({ id: 'msg_competing', fields: { newState: 'archiving' } })]);
  assert.deepEqual(competing.map(r => r.status).sort(), [202, 409]);
  const total = (await db.prepare('SELECT SUM(count) n FROM lifecycle_buckets').first()).n;
  assert.equal(total, 2, 'conflicting concurrent delivery must not increment both buckets');
  const daytonaMetrics = () => mf.dispatchFetch('https://telemetry.invalid/v1/daytona/otlp/metrics', {
    method: 'POST', headers: { Authorization: `Bearer ${write}-daytona`, 'Content-Type': 'application/x-protobuf' },
    body: organizationWire() });
  const metricRetries = await Promise.all(Array.from({ length: 4 }, daytonaMetrics));
  assert.deepEqual(metricRetries.map(r => r.status), [200, 200, 200, 200]);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM metric_points WHERE source='daytona'").first()).n, 1);
  await db.prepare('UPDATE deletion_runs SET expires_at=?').bind(now - 1).run();
  const expired = await mf.dispatchFetch(`https://telemetry.invalid/v1/read/deletions?from=${now - 1}&to=${now + 1}&limit=10`,
    { headers: { Authorization: `Bearer ${read}` } });
  assert.equal((await expired.json()).rows.length, 0);
  const worker = await mf.getWorker();
  await worker.scheduled({ scheduledTime: now, cron: '*/15 * * * *' });
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM deletion_runs').first()).n, 0);
  await retentionScenarios(db);
});
