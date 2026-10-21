#!/usr/bin/env node
// Physical-cleanup throughput benchmark for BayLeaf Inboxes (#97).
// Results and interpretation: ../QUALIFICATION.md. Local only; --json requires an explicit output path.
//
// Runs the real scheduled() sweep in Miniflare's workerd against real local D1/R2
// seeded with 1k-10k messages/objects. The sweep's env is wrapped in counting proxies,
// so each run reports D1 calls (a batch is one call), statements, the largest batch,
// the most bound parameters in any statement (D1 allows 100; local SQLite does not
// enforce it) and R2 operations. Production also limits D1 to 1,000 queries per
// invocation (D1 limits page) within a 10,000-subrequest Workers default; Miniflare
// enforces neither, so the counts are the evidence. Wall times are local SQLite and
// disk, not production latency.
//
// Usage (from inbox/): node qualification/cleanup-bench.mjs [--only name,...] [--json out.json]

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKER_SRC = process.env.BENCH_WORKER_SRC ?? 'src/worker.js';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
let seq = 0;
const id = prefix => {
  let n = seq++, text = '';
  do { text = BASE32[n % 32] + text; n = Math.floor(n / 32); } while (n);
  return `${prefix}_${text.padStart(26, 'a')}`;
};
const now = () => Math.floor(Date.now() / 1000);

const WRAPPER = `
import * as mod from './${WORKER_SRC}';
export * from './${WORKER_SRC}';
const inner = mod.default;
let stats = null;
const raw = new WeakMap();
function wrapStatement(stmt) {
  const proxy = new Proxy(stmt, { get(t, k) {
    if (k === 'bind') return (...args) => {
      stats.max_params = Math.max(stats.max_params, args.length);
      if (args.length > 100) throw new Error('qualification: D1 statement exceeds 100 bound parameters');
      return wrapStatement(t.bind(...args));
    };
    if (k === 'run' || k === 'all' || k === 'first' || k === 'raw') return (...a) => { stats.d1_calls++; stats.d1_statements++; return t[k](...a); };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  raw.set(proxy, stmt);
  return proxy;
}
function counting(env, failKey) {
  stats = { d1_calls: 0, d1_statements: 0, max_batch: 0, max_params: 0, r2_list: 0, r2_delete: 0, r2_keys_deleted: 0, r2_other: 0 };
  const DB = new Proxy(env.DB, { get(t, k) {
    if (k === 'prepare') return sql => wrapStatement(t.prepare(sql));
    if (k === 'batch') return list => { stats.d1_calls++; stats.d1_statements += list.length; stats.max_batch = Math.max(stats.max_batch, list.length); return t.batch(list.map(s => raw.get(s) ?? s)); };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  const BLOBS = new Proxy(env.BLOBS, { get(t, k) {
    if (k === 'list') return (...a) => { stats.r2_list++; return t.list(...a); };
    if (k === 'delete') return keys => {
      stats.r2_delete++; stats.r2_keys_deleted += Array.isArray(keys) ? keys.length : 1;
      if (failKey && (Array.isArray(keys) ? keys : [keys]).includes(failKey)) throw new Error('synthetic stuck object');
      return t.delete(keys);
    };
    const v = t[k]; return typeof v === 'function' ? (...a) => { stats.r2_other++; return v.apply(t, a); } : v;
  } });
  return { ...env, DB, BLOBS };
}
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/plant') {
      // Bulk seeding inside workerd: rows by batch, objects by bounded parallel puts.
      const { statements, objects } = await req.json();
      for (let i = 0; i < statements.length; i += 200)
        await env.DB.batch(statements.slice(i, i + 200).map(s => env.DB.prepare(s.sql).bind(...s.args)));
      for (let i = 0; i < objects.length; i += 50) await Promise.all(objects.slice(i, i + 50).map(k => env.BLOBS.put(k, 'xyz')));
      return new Response('ok');
    }
    if (u.pathname === '/sweep') {
      const t0 = Date.now();
      let error = null;
      try { await inner.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, counting(env, u.searchParams.get('fail')), {}); }
      catch (e) { error = String((e && e.message) || e); }
      return Response.json({ ...stats, inner_ms: Date.now() - t0, error });
    }
    if (u.pathname === '/count') {
      const q = async sql => (await env.DB.prepare(sql).first()).n;
      let objects = 0, cursor;
      do { const l = await env.BLOBS.list({ cursor, limit: 1000 }); objects += l.objects.length; cursor = l.truncated ? l.cursor : undefined; } while (cursor);
      return Response.json({ messages: await q('SELECT COUNT(*) AS n FROM messages'),
        reserved_messages: await q('SELECT COALESCE(SUM(message_count),0) AS n FROM inboxes'),
        reserved_bytes: await q('SELECT COALESCE(SUM(bytes_stored),0) AS n FROM inboxes'),
        inboxes: await q('SELECT COUNT(*) AS n FROM inboxes'),
        destroying: await q("SELECT COUNT(*) AS n FROM inboxes WHERE state = 'destroying'"),
        prefixes: await q('SELECT COUNT(*) AS n FROM cleanup_prefixes'),
        events: await q('SELECT COUNT(*) AS n FROM events'), leases: await q('SELECT COUNT(*) AS n FROM event_streams'),
        lapsed: await q("SELECT COUNT(*) AS n FROM inboxes WHERE state='active' AND expires_at <= unixepoch()"), objects });
    }
    return new Response('not found', { status: 404 });
  },
};`;

async function harness() {
  const require = createRequire(import.meta.url);
  const { build } = require('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const bundle = (await build({ absWorkingDir: ROOT, bundle: true, write: false, format: 'esm', platform: 'browser',
    external: ['cloudflare:workers', 'node:*'], stdin: { resolveDir: ROOT, contents: WRAPPER, sourcefile: 'cleanup-wrapper.js' } })).outputFiles[0].text;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'inbox', modules: true, script: bundle,
    compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BLOBS'],
    bindings: { INBOXES_ENABLED: 'true', INBOX_DOMAIN: 'bayleaf-inboxes.dev',
      INBOX_TELEMETRY_ENABLED: 'true', INBOX_TELEMETRY_WRITE_SECRET: 'synthetic-qualification-inbox-writer' },
    outboundService: () => { throw new Error('no network'); } }] }));
  const db = await mf.getD1Database('DB', 'inbox');
  const migration = (await Promise.all((await readdir(join(ROOT, 'migrations'))).filter(f => f.endsWith('.sql')).sort().map(f => readFile(join(ROOT, 'migrations', f), 'utf8'))))
    .join('\n').replace(/--.*$/gm, '').match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g).map(s => s.trim());
  for (const stmt of migration) await db.prepare(stmt).run();
  const worker = await mf.getWorker('inbox');
  const call = async (path, body) => {
    const r = await worker.fetch(`https://bench.invalid${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});
    return path === '/plant' ? r.text() : r.json();
  };
  return { mf, call };
}

// Seed helpers build SQL + object keys; counters stay consistent with the rows.
function seedInbox({ owner = 'bench-owner-000000', state = 'active', messages = 0, msgState = 'stored', expired = false,
  destroyedAgo = 3600, objects = true, lifetime = false } = {}) {
  const inbox = id('ibx'), t = now();
  const statements = [{ sql: `INSERT INTO inboxes (id, owner, type, nonce, state, created_at, destroy_requested_at, bytes_stored, message_count)
    VALUES (?,?,?,?,?,?,?,?,?)`, args: [inbox, owner, 'http', inbox.slice(4), state, t - 100000, state === 'destroying' ? t - destroyedAgo : null, messages * 3, messages] }];
  const keys = [];
  if (lifetime) statements.push({ sql: 'UPDATE inboxes SET expires_at=? WHERE id=?', args: [t - 3600, inbox] });
  statements.push({ sql: 'INSERT INTO event_streams(id,inbox_id,expires_at) VALUES (?,?,?)', args: [id('lease'), inbox, t - 1] });
  if (state === 'destroying') statements.push({ sql: 'INSERT OR IGNORE INTO cleanup_prefixes (inbox_id, turn) VALUES (?, 0)', args: [inbox] });
  for (let i = 0; i < messages; i++) {
    const m = id('msg');
    const received = msgState === 'pending' ? t - 7200 : t - 1000;
    statements.push({ sql: `INSERT INTO messages (id, inbox_id, state, received_at, expires_at, size, meta_json) VALUES (?,?,?,?,?,3,'{}')`,
      args: [m, inbox, msgState, received, expired ? t - 10 : t + 86400] });
    if (msgState === 'stored') statements.push({ sql: "INSERT INTO events(inbox_id,seq,message_id,type,created_at) VALUES (?,?,?,'message.received',?)",
      args: [inbox, i + 1, m, received] });
    if (objects) keys.push(`m/${inbox}/${m}`);
  }
  return { inbox, statements, keys };
}
function seedPrefixes(count, orphanEvery) {
  const statements = [], keys = [];
  for (let i = 0; i < count; i++) {
    const inbox = id('ibx');
    statements.push({ sql: 'INSERT INTO cleanup_prefixes (inbox_id, turn) VALUES (?, ?)', args: [inbox, i] });
    if (orphanEvery && i % orphanEvery === 0) keys.push(`m/${inbox}/msg_orphan`);
  }
  return { statements, keys };
}
const merge = seeds => ({ statements: seeds.flatMap(s => s.statements), objects: seeds.flatMap(s => s.keys) });
const times = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const SCENARIOS = {
  'stuck-delete-fairness': { note: 'one permanently failing object must not pin all 1,000 deleting rows', maxRuns: 6,
    seed: () => { const p = seedInbox({ messages: 1000, msgState: 'deleting' });
      return { statements: p.statements, objects: p.keys, failKey: p.keys[0] }; } },
  'expiry-1k': { note: '1,000 expired stored messages in 10 inboxes',
    seed: () => merge(times(10, () => seedInbox({ messages: 100, expired: true }))) },
  'expiry-10k': { note: '10,000 expired stored messages in 10 inboxes',
    seed: () => merge(times(10, () => seedInbox({ messages: 1000, expired: true }))) },
  'stale-and-deleting-1k': { note: '500 stale pending + 500 stuck deleting rows',
    seed: () => merge([...times(5, () => seedInbox({ messages: 100, msgState: 'pending' })),
      ...times(5, () => seedInbox({ messages: 100, msgState: 'deleting' }))]) },
  'destroy-10k': { note: '10 destroying inboxes x 1,000 messages, quiescence elapsed',
    seed: () => merge(times(10, () => seedInbox({ state: 'destroying', messages: 1000 }))) },
  'destroy-wide-15k': { note: '60 destroying inboxes x 250 messages (past the 50-inbox and 200-message per-run bounds)',
    seed: () => merge(times(60, () => seedInbox({ state: 'destroying', messages: 250 }))) },
  'worst-case-mix': { note: '300 expired + 300 stale + 300 deleting + 60 destroying x 250 + 1,000 prefixes (1 in 10 with an orphan)',
    seed: () => merge([...times(3, () => seedInbox({ messages: 100, expired: true })),
      ...times(3, () => seedInbox({ messages: 100, msgState: 'pending' })),
      ...times(3, () => seedInbox({ messages: 100, msgState: 'deleting' })),
       ...times(60, () => seedInbox({ state: 'destroying', messages: 250 })), seedPrefixes(1000, 10)]) },
  'integrated-ttl-events': { note: 'mixed backlog plus 12 lapsed inboxes x 250 receipts; all stored messages carry events and all inboxes have expired leases',
    seed: () => merge([...times(3, () => seedInbox({ messages: 100, expired: true })),
      ...times(3, () => seedInbox({ messages: 100, msgState: 'pending' })),
      ...times(3, () => seedInbox({ messages: 100, msgState: 'deleting' })),
      ...times(60, () => seedInbox({ state: 'destroying', messages: 250 })),
      ...times(12, () => seedInbox({ lifetime: true, messages: 250 })), seedPrefixes(1000, 10)]) },
  'reconcile-1k-prefixes': { note: '1,000 cleanup prefixes, every 10th with a late orphan object',
    seed: () => merge([seedPrefixes(1000, 10)]) },
  'reconcile-10k-prefixes': { note: '10,000 cleanup prefixes, every 100th with a late orphan object',
    seed: () => merge([seedPrefixes(10000, 100)]), maxRuns: 6 },
  'one-prefix-5k-orphans': { note: 'one finalized prefix with 5,000 late orphan objects',
    seed: () => { const p = seedPrefixes(1, 0); const inbox = p.statements[0].args[0];
      return { statements: p.statements, objects: times(5000, i => `m/${inbox}/msg_${String(i).padStart(5, '0')}`) }; }, maxRuns: 6 },
};

function done(c) { return c.messages === 0 && c.destroying === 0 && c.objects === 0; }

async function scenario(name, spec) {
  const h = await harness();
  try {
    const seed = spec.seed();
    const t0 = performance.now();
    await h.call('/plant', seed);
    const seedMs = Math.round(performance.now() - t0);
    const start = await h.call('/count');
    assert.equal(start.objects, seed.objects.length, 'every fixture object must exist');
    assert.equal(start.messages, seed.statements.filter(s => s.sql.startsWith('INSERT INTO messages')).length);
    const runs = [];
    let count = start;
    const maxRuns = spec.maxRuns ?? 250;
    while (runs.length < maxRuns && !done(count)) {
      const t = performance.now();
      const s = await h.call('/sweep' + (seed.failKey ? '?fail=' + encodeURIComponent(seed.failKey) : ''));
      assert.equal(s.error, null, 'the real scheduled handler must complete');
      // Conservative published D1 budget, counting statements too, with 50
      // statements reserved for the separately integrated <=5 TTL transitions.
      assert.ok(s.d1_statements + 50 <= 700, 'whole-sweep SQL budget plus TTL headroom');
      assert.ok(s.d1_calls + s.r2_list + s.r2_delete + s.r2_other + 50 <= 900, 'whole invocation subrequest headroom');
      const wall = performance.now() - t;
      const after = await h.call('/count');
      assert.ok(count.lapsed - after.lapsed <= 5, 'at most five TTL transitions per sweep');
      runs.push({ ...s, wall_ms: Math.round(wall), removed_messages: count.messages - after.messages,
        removed_objects: count.objects - after.objects, finalized: count.destroying - after.destroying });
      count = after;
    }
    if (done(count)) {
      assert.equal(count.reserved_messages, 0);
      assert.equal(count.reserved_bytes, 0);
      assert.equal(count.events, 0, 'set-based message cleanup removes events');
      assert.equal(count.leases, 0, 'expired leases and finalized inbox leases are removed');
    }
    if (seed.failKey) assert.ok(count.messages <= 50, 'stuck batch must yield to later rows');
    const peak = k => Math.max(...runs.map(r => r[k]));
    return { name, note: spec.note, seed_ms: seedMs, start, end: count, runs: runs.length, finished: done(count),
      first_run: runs[0], peak: { d1_calls: peak('d1_calls'), d1_statements: peak('d1_statements'), max_batch: peak('max_batch'),
        max_params: peak('max_params'), r2_ops: Math.max(...runs.map(r => r.r2_list + r.r2_delete + r.r2_other)),
        wall_ms: peak('wall_ms'), removed_messages: peak('removed_messages'), removed_objects: peak('removed_objects') },
      errors: runs.filter(r => r.error).length };
  } finally { await h.mf.dispose(); }
}

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const only = opt('--only')?.split(',');
const results = [];
for (const [name, spec] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(name)) continue;
  const r = await scenario(name, spec);
  results.push(r);
  console.error(JSON.stringify(r));
}
if (opt('--json')) await writeFile(opt('--json'), JSON.stringify(results, null, 2));
console.log('| scenario | start msgs / objects / prefixes | runs | finished | max removed msgs/run | max objects/run | peak D1 calls (stmts) | max batch | max params | peak R2 ops | peak wall ms |');
console.log('|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of results) {
  console.log(`| ${r.name} | ${r.start.messages} / ${r.start.objects} / ${r.start.prefixes} | ${r.runs} | ${r.finished ? 'yes' : `no (${r.end.objects} objects left)`} | ${r.peak.removed_messages} | ${r.peak.removed_objects} | ${r.peak.d1_calls} (${r.peak.d1_statements}) | ${r.peak.max_batch} | ${r.peak.max_params} | ${r.peak.r2_ops} | ${r.peak.wall_ms} |`);
}
