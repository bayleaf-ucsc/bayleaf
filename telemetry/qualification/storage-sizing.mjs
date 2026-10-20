// Local-only, bounded SQLite sizing. No exporter, network, persistence or deployment.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { otlpHook } from '../otlp/worker-adapter.mjs';
import { ingest, takeBudget } from '../src/store.js';
import { validate } from '../src/validate.js';

const env = { RETENTION_DAYS: '90' }, day = 86400000;
const migrations = ['0001_telemetry.sql', '0002_retention_state.sql'].map(f =>
  readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
const fixture = await otlpHook(new Request('https://telemetry.invalid', { method: 'POST',
  headers: { 'content-type': 'application/x-protobuf' },
  body: readFileSync(new URL('../otlp/fixture.pb', import.meta.url)) }), { source: 'owui', now: Date.now() });
const start = fixture.observed_at;
function database() {
  const sql = new DatabaseSync(':memory:');
  migrations.forEach(m => sql.exec(m));
  const cache = new Map();
  const wrap = (q, args = []) => {
    if (!cache.has(q)) cache.set(q, sql.prepare(q));
    const s = cache.get(q);
    return { bind: (...a) => wrap(q, a), first: async () => s.get(...args),
      run: async () => ({ meta: s.run(...args) }),
      _run: () => s.columns().length ? { results: s.all(...args) } : { meta: s.run(...args) } };
  };
  return { sql, prepare: wrap, async batch(ss) {
    sql.exec('BEGIN');
    try { const r = ss.map(s => s._run()); sql.exec('COMMIT'); return r; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  } };
}
function size(db) {
  return { bytes: db.sql.prepare('PRAGMA page_count').get().page_count * db.sql.prepare('PRAGMA page_size').get().page_size,
    freelistPages: db.sql.prepare('PRAGMA freelist_count').get().freelist_count,
    objects: db.sql.prepare('SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name').all() };
}
// 99 is the source's configured cardinality envelope, not an observed fixture.
// Expand the actual hook-normalized sum/histogram into 48 approved dimension
// combinations plus its three gauges. No private routes or real traffic.
function templates(n) {
  if (n === 11) return fixture.points;
  const points = fixture.points.filter(p => p.kind === 'gauge');
  for (let i = 0; i < 48; i++) for (const kind of ['sum', 'histogram']) {
    const p = structuredClone(fixture.points.find(p => p.kind === kind));
    p.attributes = { method: ['GET', 'POST', 'OTHER'][i % 3],
      route: ['/health', '/api/version', '/api/chat/completions', '/api/v1/chats/{id}', '/_other'][Math.floor(i / 3) % 5],
      status_code: 200 + Math.floor(i / 15), instance: 'single' };
    points.push(p);
  }
  return points;
}
function batch(n, i) {
  const observed_at = start + i * 60000;
  const points = templates(n).map(p => ({ ...p, observed_at,
    time_unix_nano: String(BigInt(p.time_unix_nano) + BigInt(observed_at - p.observed_at) * 1000000n) }));
  return validate('metrics', { schema_version: 1, source: 'owui', batch_id: randomUUID(), observed_at, points }, env, observed_at);
}
const output = { node: process.version, sqlite: null, pageSize: 4096, normalizedFixturePoints: fixture.points.length,
  methodology: 'real migrations, in-memory SQLite, actual ingest SQL, no remote requests; 99-point synthetic expansion after safe protobuf hook', measurements: [] };
for (const n of [11, 99]) {
  const db = database(); output.sqlite = db.sql.prepare('SELECT sqlite_version() v').get().v;
  const empty = size(db).bytes, checkpoints = [20000, 50000, 100000].map(x => Math.floor(x / n));
  for (let i = 0; i < checkpoints.at(-1); i++) {
    const data = batch(n, i); await ingest(db, 'metrics', data, data.observed_at, env);
    if (checkpoints.includes(i + 1)) output.measurements.push({ type: `metrics-${n}`, rows: n * (i + 1),
      receipts: i + 1, emptyBytes: empty, ...size(db) });
  }
  // Simulate ongoing churn: delete oldest half, insert same count at newer times.
  // This tests page reuse and index fill, not a full 90-day steady-state workload.
  const half = Math.floor(checkpoints.at(-1) / 2), cutoff = start + half * 60000;
  db.sql.prepare('DELETE FROM metric_points WHERE observed_at < ?').run(cutoff);
  db.sql.prepare('DELETE FROM receipts WHERE observed_at < ?').run(cutoff);
  const afterDelete = size(db);
  for (let i = checkpoints.at(-1); i < checkpoints.at(-1) + half; i++) {
    const data = batch(n, i); await ingest(db, 'metrics', data, data.observed_at, env);
  }
  output.measurements.push({ type: `metrics-${n}-churn`, rows: n * checkpoints.at(-1),
    emptyBytes: empty, afterDelete, ...size(db) });
  db.sql.close();
}
for (const long of [false, true]) {
  const db = database(), empty = size(db).bytes;
  const longHost = [...Array(4).fill('a'.repeat(48)), 'a'.repeat(45), 'example', 'org'].join('.');
  const total = long ? 20000 : 100000;
  for (let i = 0; i < total; i++) {
    const now = start + Math.floor(i / 120) * 60000;
    const data = { schema_version: 1, policy_version: 2, observed_at: now, expires_at: now + 90 * day,
      destination: ['landing', 'sandbox', 'chat', 'api'][i % 4],
      referring_hostname: long ? longHost : [null, 'www.google.com', 'canvas.ucsc.edu', 'bayleaf.dev'][i % 4] };
    await ingest(db, 'browser', data, now, env);
    if ([20000, 50000, 100000].includes(i + 1)) output.measurements.push({ type: long ? 'browser-long-host' : 'browser-mix',
      rows: i + 1, hostnameBytes: long ? longHost.length : null, emptyBytes: empty, ...size(db) });
  }
  db.sql.close();
}
// Small independent local workerd/D1 sample: count billed write amplification.
const require = createRequire(import.meta.url), api = createRequire(new URL('../../api/package.json', import.meta.url));
const dep = name => { try { return require(name); } catch { return api(name); } };
const { Miniflare, convertV4MiniflareOptions } = dep('miniflare');
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("local");}}',
  compatibilityDate: '2026-08-01', d1Databases: ['DB'], outboundService: () => { throw new Error('outbound forbidden'); } }));
try {
  const db = await mf.getD1Database('DB');
  for (const migration of migrations) for (const s of migration.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(s).run();
  output.d1 = [];
  let rowsRead = 0, rowsWritten = 0;
  const wrapped = { prepare: q => {
    const wrap = s => ({ bind: (...a) => wrap(s.bind(...a)), async first() {
      const r = await s.all(); rowsRead += r.meta.rows_read; rowsWritten += r.meta.rows_written;
      return r.results[0] ?? null;
    }, _s: s }); return wrap(db.prepare(q));
  }, async batch(ss) {
    const rs = await db.batch(ss.map(s => s._s));
    for (const r of rs) { rowsRead += r.meta.rows_read; rowsWritten += r.meta.rows_written; }
    return rs;
  } };
  for (const n of [11, 99]) {
    rowsRead = rowsWritten = 0;
    const data = batch(n, n);
    await takeBudget(wrapped, 'owui', 'metrics', data.observed_at);
    await takeBudget(wrapped, 'owui', 'metrics', data.observed_at, n);
    await ingest(wrapped, 'metrics', data, data.observed_at, env);
    output.d1.push({ kind: `metrics-${n}-admission`, rowsRead, rowsWritten });
  }
  rowsRead = rowsWritten = 0;
  await takeBudget(wrapped, 'landing', 'browser', start);
  await ingest(wrapped, 'browser', { schema_version: 1, policy_version: 2, observed_at: start,
    expires_at: start + 90 * day, destination: 'landing', referring_hostname: 'canvas.ucsc.edu' }, start, env);
  output.d1.push({ kind: 'browser-admission', rowsRead, rowsWritten });
  for (const table of ['metric_points', 'receipts', 'browser_observations']) {
    const r = await db.prepare(`DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT 500)`).bind(start + 100 * day).run();
    output.d1.push({ kind: `${table}-delete`, changes: r.meta.changes, rowsWritten: r.meta.rows_written, rowsRead: r.meta.rows_read });
  }
} finally { await mf.dispose(); }
console.log(JSON.stringify(output, null, 2));
