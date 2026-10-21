// Real API + real inbox RPC/D1/R2, including actual localhost HTTP streaming.
// Synthetic owners and a passive fake Daytona control plane only. Never production.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { generateVerifier } from '../../inbox/scripts/build-dkim.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INBOX = fileURLToPath(new URL('../../inbox/', import.meta.url));
const fixtures = { name: 'build-only adapter fixtures', setup(b) {
  b.onResolve({ filter: /(?:\.sandbox-plugin-ref|\.nanobot-assets)\.json$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'json', contents: JSON.stringify(
    args.path.includes('sandbox-plugin') ? { package: 'synthetic-build-only-never-deploy' } : { _source: { mode: 'fixture' } }) }));
} };
const api = (await build({ absWorkingDir: ROOT, stdin: { resolveDir: ROOT, contents: `
import app from './src/index.ts';
export default { async fetch(req, env, ctx) {
  const u = new URL(req.url);
  if (u.pathname.startsWith('/__race/')) {
    u.pathname = u.pathname.slice('/__race'.length);
    const service = {
      async acquireEventStream(...args) {
        const r = await env.INBOXES.acquireEventStream(...args);
        await env.ACQUIRE_GATE.fetch('https://acquire-gate.invalid/'); return r;
      },
      readEventStream(...args) { return env.INBOXES.readEventStream(...args); },
      releaseEventStream(...args) { return env.INBOXES.releaseEventStream(...args); },
    };
    return app.fetch(new Request(u, req), { ...env, INBOXES: service }, ctx);
  }
  if (u.pathname === '/__release') {
    const { who, inbox, lease } = await req.json();
    return Response.json(await env.INBOXES.releaseEventStream(who, inbox, lease));
  }
  if (u.pathname === '/__retire') {
    const { who } = await req.json();
    return Response.json(await env.INBOXES.retireOwner(who));
  }
  if (u.pathname.startsWith('/__short/')) {
    u.pathname = u.pathname.slice('/__short'.length);
    return app.fetch(new Request(u, req), { ...env, INBOX_STREAM_SECONDS: '1' }, ctx);
  }
  if (u.pathname.startsWith('/__hold/')) {
    u.pathname = u.pathname.slice('/__hold'.length);
    const r = await app.fetch(new Request(u, req), env, ctx);
    // A genuine API stream whose downstream never pulls. Keep the response alive
    // behind a bounded test gate instead of relying on OS socket buffer sizes.
    ctx.waitUntil((async () => { await env.HOLD.fetch('https://hold.invalid/'); await r.body?.cancel().catch(() => {}); })());
    return Response.json({ status: r.status });
  }
  return app.fetch(req, env, ctx);
}};` }, bundle: true, write: false, format: 'esm', platform: 'browser',
  external: ['cloudflare:workers'], loader: { '.md': 'text', '.py': 'text' }, plugins: [fixtures] })).outputFiles[0].text;
await generateVerifier();
const inbox = (await build({ absWorkingDir: INBOX, entryPoints: ['src/worker.js'], bundle: true, write: false,
  format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:*'] })).outputFiles[0].text;
const provider = new Map();
let holdRelease, acquireGate;
const hold = new Promise(resolve => { holdRelease = resolve; });
const noNet = async req => {
  const u = new URL(req.url), row = provider.get(u.pathname.slice('/sandbox/'.length));
  if (u.hostname !== 'daytona.invalid' || !u.pathname.startsWith('/sandbox/') || req.method !== 'GET')
    throw new Error('Unexpected outbound access in stream test');
  if (row?.gate) await row.gate;
  return row ? Response.json({ id: row.id, state: 'started', labels: { synthetic: row.email } }) : new Response(null, { status: 404 });
};
let mf, db, inboxDb, base;
before(async () => {
  const apiWorker = (name, host, seconds) => ({ name, modules: true, script: api, compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'], routes: [`${host}/*`], d1Databases: { DB: 'api-db' },
    kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'], outboundService: noNet,
    serviceBindings: { INBOXES: { name: 'inbox', entrypoint: 'InboxManagement' }, HOLD: () => hold.then(() => new Response('ok')),
      ACQUIRE_GATE: async () => { acquireGate.started(); await acquireGate.wait; return new Response('ok'); } },
    bindings: { INBOXES_ENABLED: 'true', INBOX_STREAM_SECONDS: String(seconds), INBOX_STREAM_POLL_MS: '50', INBOX_STREAM_WRITE_MS: '250',
      OIDC_CLIENT_SECRET: 'synthetic', DAYTONA_API_URL: 'https://daytona.invalid', DAYTONA_API_KEY: 'synthetic',
      DAYTONA_DEPLOYMENT_LABEL: 'synthetic', CAMPUS_IP_RANGES: '192.0.2.0/24', GRANTS_ENABLED: 'false', PREVIEWS_ENABLED: 'false' } });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [apiWorker('api', 'api.example.test', 30),
    { name: 'inbox', modules: true, script: inbox, compatibilityDate: '2026-08-01', routes: ['*.bayleaf-inboxes.dev/*'],
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'], r2Buckets: ['BLOBS'], outboundService: noNet,
      bindings: { INBOXES_ENABLED: 'true' },
      ratelimits: { ACCEPT_LIMIT: { namespace_id: '9701', simple: { limit: 60, period: 60 } },
        REJECT_LIMIT: { namespace_id: '9702', simple: { limit: 30, period: 60 } } } },
  ] }));
  const migrate = async (target, path) => {
    for (const file of (await readdir(path)).filter(f => f.endsWith('.sql')).sort()) {
      const sql = (await readFile(path + file, 'utf8')).replace(/^\s*--.*$/gm, '');
      const parts = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) :
        file === '0007_email_auth.sql' ? sql.match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g) : sql.split(';');
      for (const stmt of parts.map(s => s.trim()).filter(Boolean)) await target.prepare(stmt).run();
    }
  };
  db = await mf.getD1Database('DB', 'api'); inboxDb = await mf.getD1Database('DB', 'inbox');
  await migrate(db, ROOT + 'migrations/'); await migrate(inboxDb, INBOX + 'migrations/');
  base = await mf.ready;
});
after(async () => { holdRelease(); await mf?.dispose(); });

const call = (u, path, init = {}) => mf.dispatchFetch('https://api.example.test' + path,
  { ...init, headers: { Authorization: `Bearer ${u.key}`, 'Content-Type': 'application/json', ...init.headers } });
async function setup() {
  const id = randomUUID(), u = { key: 'sk-bayleaf-' + id, generation: id, email: id + '@example.test', id };
  await db.prepare('INSERT INTO user_keys(email, bayleaf_token, account_generation, daytona_sandbox_id) VALUES (?,?,?,?)')
    .bind(u.email, u.key, u.generation, id).run();
  const r = await call(u, '/inboxes', { method: 'POST', body: '{"type":"http"}' });
  assert.equal(r.status, 201, await r.clone().text());
  u.inbox = await r.json();
  return u;
}
async function post(u, body = 'synthetic self-post, never instructions') {
  const r = await mf.dispatchFetch(u.inbox.url, { method: 'POST', body });
  assert.equal(r.status, 200); await r.arrayBuffer();
}
const count = async u => (await inboxDb.prepare('SELECT COUNT(*) AS n FROM event_streams WHERE inbox_id=?').bind(u.inbox.id).first()).n;
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('bounded condition timed out'); await new Promise(r => setTimeout(r, 20)); }
}
async function connect(u, { after, last, short = false, path } = {}) {
  const abort = new AbortController();
  const target = new URL(path || `${short ? '/__short' : ''}/inboxes/${u.inbox.id}/events/stream${after !== undefined ? '?after=' + encodeURIComponent(after) : ''}`, base);
  const openingTimer = setTimeout(() => abort.abort(), 6000);
  const response = await fetch(target, { signal: abort.signal, headers: { Host: short ? 'short.example.test' : 'api.example.test',
    Authorization: `Bearer ${u.key}`, ...(last !== undefined ? { 'Last-Event-ID': last } : {}) } })
    .finally(() => clearTimeout(openingTimer));
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  return { response, abort: () => abort.abort(),
    async next(ms = 6000) {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const fields = {};
          for (const line of block.split('\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          if (fields.data) fields.data = JSON.parse(fields.data);
          return fields;
        }
        let timer;
        const chunk = await Promise.race([reader.read(), new Promise((_, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(new Error('bounded SSE read timed out')); }, ms);
        })]).finally(() => clearTimeout(timer));
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async event(name, ms) {
      const deadline = Date.now() + (ms ?? 6000);
      for (;;) {
        if (Date.now() >= deadline) { abort.abort(); assert.fail(`bounded wait for ${name} expired`); }
        const f = await this.next(Math.max(1, deadline - Date.now()));
        assert.ok(f, `EOF before ${name}`);
        if (f.event === name) return f;
        if (f.event === 'end') assert.fail(`ended before ${name}: ${JSON.stringify(f.data)}`);
      }
    },
  };
}
async function ready(u, options) {
  const s = await connect(u, options);
  assert.equal(s.response.status, 200);
  s.head = (await s.event('ready')).data.cursor;
  return s;
}

test('real HTTP SSE catches up, then self-posts arrive on the same open connection; resume and precedence', { timeout: 12000 }, async () => {
  const u = await setup(); await post(u);
  const s = await connect(u);
  try {
    assert.match(s.response.headers.get('content-type'), /^text\/event-stream/);
    assert.match(s.response.headers.get('cache-control'), /no-store.*no-cache/);
    assert.equal(s.response.headers.get('x-accel-buffering'), 'no');
    const first = await s.event('message.received');
    assert.equal(first.data.event_id, 'evt_1'); assert.equal(first.id, first.data.cursor);
    const checkpoint = await s.event('ready');
    await post(u);
    const second = await s.event('message.received');
    assert.equal(second.data.event_id, 'evt_2');
    assert.deepEqual(Object.keys(second.data).sort(), ['created_at', 'cursor', 'event_id', 'message_id', 'type']);
    assert.ok(!JSON.stringify(second).includes('synthetic self-post'));
    s.abort(); await until(async () => await count(u) === 0);
    await post(u);
    const resume = await connect(u, { last: first.id });
    try {
      assert.equal((await resume.event('message.received')).data.event_id, 'evt_2', 'at least once: stable duplicate');
      assert.equal((await resume.event('message.received')).data.event_id, 'evt_3');
    } finally { resume.abort(); }
    const explicit = await ready(u, { after: 'now', last: 'malformed' });
    try { assert.notEqual(explicit.head, checkpoint.data.cursor); } finally { explicit.abort(); }
    await until(async () => await count(u) === 0);
    const invalid = await connect(u, { after: 'malformed', last: second.id });
    assert.equal(invalid.response.status, 400); invalid.abort();
  } finally { s.abort(); }
});

test('commit during catch-up has no handoff gap, independent observers see the same event', { timeout: 12000 }, async () => {
  const u = await setup(); await post(u);
  const one = await connect(u), two = await ready(u, { after: 'now' });
  try {
    await one.event('message.received');
    // No need to wait for ready: commit while the client is still in catch-up.
    await post(u);
    assert.equal((await one.event('message.received')).data.event_id, 'evt_2');
    assert.equal((await two.event('message.received')).data.event_id, 'evt_2');
  } finally { one.abort(); two.abort(); }
});

test('after=now resolves once: an arrival during the RPC handshake is followed, not skipped', { timeout: 12000 }, async () => {
  const u = await setup(); let started, release;
  const acquired = new Promise(r => { started = r; });
  acquireGate = { started, wait: new Promise(r => { release = r; }) };
  const opening = connect(u, { path: `/__race/inboxes/${u.inbox.id}/events/stream?after=now` });
  try {
    let timer;
    await Promise.race([acquired, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('bounded handshake gate timed out')), 4000);
    })]).finally(() => clearTimeout(timer));
    await post(u); // committed after acquisition's snapshot, before its response
    release();
    const s = await opening;
    try {
      assert.equal((await s.event('message.received')).data.event_id, 'evt_1');
      await s.event('ready');
    } finally { s.abort(); }
  } finally { release(); }
});

test('foreign cursors fail with HTTP 410 before opening SSE; empty checkpoint skips deleted/expired messages', { timeout: 12000 }, async () => {
  const u = await setup(); await post(u);
  const page = await (await call(u, `/inboxes/${u.inbox.id}/events`)).json();
  const parts = Buffer.from(page.cursor, 'base64url').toString().split(':'); parts[0] = 'f'.repeat(16);
  const stale = await connect(u, { after: Buffer.from(parts.join(':')).toString('base64url') });
  assert.equal(stale.response.status, 410); stale.abort();
  const zero = await inboxDb.prepare('SELECT epoch FROM event_feed').first();
  const beginning = Buffer.from(`${zero.epoch}:${u.inbox.id}:0`).toString('base64url');
  await inboxDb.prepare('UPDATE messages SET expires_at=unixepoch()-1 WHERE inbox_id=?').bind(u.inbox.id).run();
  const s = await ready(u, { after: beginning });
  try {
    assert.equal(s.head, page.cursor, 'expired arrival omitted, head still advances');
    await post(u);
    assert.equal((await s.event('message.received')).data.event_id, 'evt_2');
  } finally { s.abort(); }
});

for (const mode of ['destroy', 'ttl', 'ordinary revoke', 'ordinary rotate', 'generation change', 'sandbox revoke', 'sandbox rotate']) {
  test(`connected ${mode} terminates within five seconds and releases its lease`, { timeout: 12000 }, async () => {
    const u = await setup();
    let bearer;
    if (mode.startsWith('sandbox')) {
      bearer = 'sk-bayleaf-sandbox-' + randomBytes(32).toString('hex');
      await db.prepare(`INSERT INTO sandbox_credentials(id,email,sandbox_id,token_hash,secret_name,state,created_at,updated_at)
        VALUES(?,?,?,?,?,'active',0,0)`).bind(u.id, u.email, u.id, createHash('sha256').update(bearer).digest('hex'), 'stream-' + u.id).run();
      provider.set(u.id, { id: u.id, email: u.email }); u.key = bearer;
    }
    const s = await ready(u);
    try {
      const start = Date.now();
      if (mode === 'destroy') await call(u, `/inboxes/${u.inbox.id}`, { method: 'DELETE' });
      if (mode === 'ttl') await inboxDb.prepare('UPDATE inboxes SET expires_at=unixepoch() WHERE id=?').bind(u.inbox.id).run();
      if (mode === 'ordinary revoke') await db.prepare('UPDATE user_keys SET revoked=1 WHERE email=?').bind(u.email).run();
      if (mode === 'ordinary rotate') await db.prepare("UPDATE user_keys SET bayleaf_token='sk-bayleaf-replacement' WHERE email=?").bind(u.email).run();
      if (mode === 'generation change') await db.prepare('UPDATE user_keys SET account_generation=? WHERE email=?').bind(randomUUID(), u.email).run();
      if (mode === 'sandbox revoke') await db.prepare("UPDATE sandbox_credentials SET state='revoked' WHERE id=?").bind(u.id).run();
      if (mode === 'sandbox rotate') await db.prepare("UPDATE sandbox_credentials SET token_hash='changed' WHERE id=?").bind(u.id).run();
      const end = await s.event('end');
      assert.equal(end.data.reason, ['ttl', 'destroy'].includes(mode) ? 'not_found' : 'auth_revoked');
      assert.ok(Date.now() - start < 5000, 'short revocation/liveness bound');
      assert.equal(await s.next(), null);
      await until(async () => await count(u) === 0);
    } finally { s.abort(); }
  });
}

test('retirement fences an already-open SSE and restored generation without waiting for physical cleanup', { timeout: 12000 }, async () => {
  const u = await setup();
  await post(u);
  const s = await ready(u, { after: 'now' });
  try {
    const generation = (await db.prepare('SELECT account_generation FROM user_keys WHERE email=?').bind(u.email).first()).account_generation;
    const at = Date.now();
    assert.deepEqual(await (await call(u, '/__retire', { method: 'POST', body: JSON.stringify({ who: generation }) })).json(), { retired: true });
    await inboxDb.prepare("UPDATE inboxes SET state='active',destroy_requested_at=NULL WHERE id=?").bind(u.inbox.id).run();
    assert.equal((await s.event('end')).data.reason, 'not_found');
    assert.ok(Date.now() - at < 5000);
    assert.equal(await count(u), 0);
    for (const path of [`/inboxes/${u.inbox.id}/export`, `/inboxes/${u.inbox.id}/events`, `/inboxes/${u.inbox.id}/events/stream`])
      assert.equal((await call(u, path)).status, 404, path);
    assert.equal((await call(u, '/inboxes', { method: 'POST', body: JSON.stringify({ type: 'http' }) })).status, 404);
  } finally { s.abort(); }
});

test('four-subscriber cap is durable; actual HTTP disconnect releases a slot', { timeout: 12000 }, async () => {
  const u = await setup(), streams = [];
  try {
    for (let i = 0; i < 4; i++) streams.push(await ready(u, { after: 'now' }));
    assert.equal(await count(u), 4);
    const busy = await connect(u);
    assert.equal(busy.response.status, 429); assert.equal(busy.response.headers.get('retry-after'), '5'); busy.abort();
    streams[0].abort();
    await until(async () => await count(u) === 3);
    streams.push(await ready(u));
    assert.equal(await count(u), 4);
  } finally { streams.forEach(s => s.abort()); }
  await until(async () => await count(u) === 0);
});

test('an API response whose downstream never pulls drops the reader and releases the lease', { timeout: 12000 }, async () => {
  const u = await setup();
  const r = await call(u, `/__hold/inboxes/${u.inbox.id}/events/stream`);
  assert.equal((await r.json()).status, 200);
  await until(async () => await count(u) === 0, 3000);
});

test('lifetime closes with a resumable end frame while the connection is healthy', { timeout: 12000 }, async () => {
  const u = await setup(), s = await ready(u, { short: true });
  try {
    const end = await s.event('end');
    assert.equal(end.data.reason, 'lifetime'); assert.equal(end.data.cursor, s.head);
    assert.equal(await s.next(), null);
    await until(async () => await count(u) === 0);
  } finally { s.abort(); }
});

test('bounded replay ends after 1000 references and reconnect continues the same sequence', { timeout: 12000 }, async () => {
  const u = await setup();
  await inboxDb.batch([
    inboxDb.prepare(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x < 1001)
      INSERT INTO messages(id,inbox_id,state,received_at,expires_at,size,meta_json)
      SELECT 'msg_' || 'aaaaaaaaaaaaaaaaaaaaaaa' ||
        substr('abcdefghijklmnopqrstuvwxyz234567', (x / 1024) + 1, 1) ||
        substr('abcdefghijklmnopqrstuvwxyz234567', ((x / 32) % 32) + 1, 1) ||
        substr('abcdefghijklmnopqrstuvwxyz234567', (x % 32) + 1, 1),
        ?, 'stored', unixepoch(), unixepoch()+3600, 0, '{}' FROM n`).bind(u.inbox.id),
    inboxDb.prepare(`INSERT INTO events(inbox_id,seq,message_id,type,created_at)
      SELECT inbox_id, ROW_NUMBER() OVER (ORDER BY id), id, 'message.received', unixepoch()
      FROM messages WHERE inbox_id=?`).bind(u.inbox.id),
    inboxDb.prepare('UPDATE inboxes SET event_seq=1002 WHERE id=?').bind(u.inbox.id),
  ]);
  const s = await connect(u); let seen = 0, end;
  try {
    for (;;) {
      const f = await s.next(); assert.ok(f);
      if (f.event === 'message.received') { seen++; assert.equal(f.data.event_id, 'evt_' + seen); }
      if (f.event === 'end') { end = f; break; }
    }
    assert.equal(seen, 1000); assert.equal(end.data.reason, 'replay_limit');
    const resumed = await connect(u, { last: end.data.cursor });
    try {
      assert.equal((await resumed.event('message.received')).data.event_id, 'evt_1001');
      assert.equal((await resumed.event('message.received')).data.event_id, 'evt_1002');
      await resumed.event('ready');
    } finally { resumed.abort(); }
  } finally { s.abort(); }
});

test('expired leases cannot follow, and foreign owners cannot release another subscriber', { timeout: 12000 }, async () => {
  const u = await setup(), stranger = await setup(), s = await ready(u);
  try {
    const row = await inboxDb.prepare('SELECT id FROM event_streams WHERE inbox_id=?').bind(u.inbox.id).first();
    // A direct private RPC probe exercises owner scoping, not a new public authority.
    await call(stranger, '/__release', { method: 'POST',
      body: JSON.stringify({ who: stranger.generation, inbox: u.inbox.id, lease: row.id }) });
    assert.equal(await count(u), 1);
    await inboxDb.prepare('UPDATE event_streams SET expires_at=unixepoch()-1 WHERE id=?').bind(row.id).run();
    const end = await s.event('end'); assert.equal(end.data.reason, 'not_found');
    await until(async () => await count(u) === 0);
  } finally { s.abort(); }
});

test('epoch changes while connected end explicitly with cursor_expired', { timeout: 12000 }, async () => {
  const u = await setup(), s = await ready(u);
  const old = await inboxDb.prepare('SELECT epoch FROM event_feed').first();
  try {
    await inboxDb.prepare('UPDATE event_feed SET epoch=lower(hex(randomblob(8)))').run();
    assert.equal((await s.event('end')).data.reason, 'cursor_expired');
  } finally { s.abort(); await inboxDb.prepare('UPDATE event_feed SET epoch=?').bind(old.epoch).run(); }
});

test('stalled sandbox reauthentication fails closed under the five-second watchdog', { timeout: 12000 }, async () => {
  const u = await setup(), bearer = 'sk-bayleaf-sandbox-' + randomBytes(32).toString('hex');
  await db.prepare(`INSERT INTO sandbox_credentials(id,email,sandbox_id,token_hash,secret_name,state,created_at,updated_at)
    VALUES(?,?,?,?,?,'active',0,0)`).bind(u.id, u.email, u.id, createHash('sha256').update(bearer).digest('hex'), 'stream-' + u.id).run();
  const row = { id: u.id, email: u.email }; provider.set(u.id, row); u.key = bearer;
  const s = await ready(u);
  let unblock;
  try {
    row.gate = new Promise(resolve => { unblock = resolve; });
    const at = Date.now(), end = await s.event('end');
    assert.equal(end.data.reason, 'unavailable'); assert.ok(Date.now() - at < 5000);
    await until(async () => await count(u) === 0);
  } finally { unblock?.(); s.abort(); }
});
