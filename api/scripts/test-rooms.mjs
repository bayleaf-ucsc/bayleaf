#!/usr/bin/env node
/** Rooms facade in real workerd/D1 against a STUB bayleaf-rooms RPC. No network, no providers. */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { inboxTestAssets } from './inbox-test-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const generation = 'a'.repeat(64), sandboxBearer = 'sk-bayleaf-sandbox-' + 'b'.repeat(64);
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  import { issueGrant } from './src/grants.ts';
  import { cleanupRetiredRooms } from './src/userRetention.ts';
  export default { ...app, async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/__test/grant') {
      const row = await env.DB.prepare('SELECT * FROM user_keys WHERE email=?').bind('owner@example.test').first();
      return Response.json(await issueGrant(env, row, 'https://api.example.test', { scopes: url.searchParams.getAll('scope'),
        models: [], inboxes: [], sandboxDirs: [] }, Math.floor(Date.now()/1000)+600));
    }
    if (url.pathname === '/__test/retire') return Response.json(await cleanupRetiredRooms(env, Math.floor(Date.now()/1000)));
    const headers = new Headers(req.headers);
    if (headers.has('X-Test-Origin')) { headers.set('Origin', headers.get('X-Test-Origin')); headers.delete('X-Test-Origin'); }
    return app.fetch(new Request(req, { headers }), env, ctx);
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'], loader: { '.py': 'text', '.md': 'text' }, plugins: [inboxTestAssets] });

// Stub Rooms Worker: records every call; canned outcomes are selected by the room id.
const stub = `import { WorkerEntrypoint } from 'cloudflare:workers';
const calls = [];
const canned = (method, owner, args) => {
  calls.push({ method, owner, args: JSON.parse(JSON.stringify(args)) });
  const id = args[0];
  if (id === 'r_throw') throw new Error('synthetic RPC failure');
  if (id === 'r_response') return new Response('unexpected');
  if (id === 'r_null') return null;
  if (typeof id === 'string' && id.startsWith('r_err_')) return { error: id.slice(6), label: 's01' };
  if (method === 'retireOwner') return { retired: true, rooms: 0 };
  if (method === 'exportRoom') return args[1].format === 'yjs' ? { content_type: 'application/octet-stream', body: new Uint8Array([0, 1, 2]) }
    : id === 'r_badtype' ? { content_type: 'text/html', body: '<script>alert(1)</script>' }
    : id === 'r_nobody' ? { content_type: 'application/x-ndjson' }
    : { content_type: 'application/x-ndjson', body: '{"seq":1}\\n' };
  if (method === 'listRooms') return { rooms: [{ room_id: 'r_1', label: 'board', codec: 'json', mode: 'open', expires_at: '2026-12-01T00:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' }] };
  return { method, owner, args };
};
export class RoomManagement extends WorkerEntrypoint {}
for (const m of ['getLimits','createRoom','listRooms','getRoom','updateRoom','deleteRoom','issueCredentials','listCredentials','revokeCredential','exportRoom','retireOwner'])
  RoomManagement.prototype[m] = async function (owner, ...args) { return canned(m, owner, args); };
export default { fetch() { return Response.json(calls.splice(0)); } };`;

const outbound = [];
const worker = (enabled, binding = true) => ({ name: !binding ? 'api-unbound' : enabled ? 'api' : 'api-off', modules: true,
  script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'shared-db' }, kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'],
  ...(binding ? { serviceBindings: { ROOMS: { name: 'bayleaf-rooms', entrypoint: 'RoomManagement' } } } : {}),
  bindings: { ROOMS_ENABLED: enabled ? 'true' : 'false', CAMPUS_IP_RANGES: '192.0.2.0/24', CAMPUS_POOL_KEY: 'synthetic-pool',
    GRANTS_ENABLED: 'true', GRANTS_MAX_SECONDS: '3600', OIDC_CLIENT_SECRET: 'synthetic-signing', PREVIEWS_ENABLED: 'false',
    DAYTONA_API_URL: 'https://daytona.example.test', DAYTONA_API_KEY: 'synthetic', DAYTONA_DEPLOYMENT_LABEL: 'synthetic',
    OPENROUTER_PROVISIONING_KEY: 'synthetic-admin', TINFOIL_ADMIN_KEY: 'synthetic-admin' },
  outboundService: req => {
    const u = new URL(req.url);
    // Sandbox credential authentication is a passive Daytona metadata read; nothing else may leave.
    if (u.hostname === 'daytona.example.test' && req.method === 'GET' && u.pathname === '/sandbox/one')
      return Response.json({ id: 'one', state: 'started', labels: { synthetic: 'owner@example.test' } });
    outbound.push(u.hostname + u.pathname);
    throw new Error('Rooms facade must not reach ' + u.hostname);
  } });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [worker(true), worker(false), worker(true, false),
  { name: 'bayleaf-rooms', modules: true, compatibilityDate: '2026-08-01', script: stub }] }));
try {
  const db = await mf.getD1Database('DB', 'api');
  for (const file of (await readdir(root + 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(root + 'migrations/' + file, 'utf8')).replace(/^\s*--.*$/gm, '');
    const statements = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) : sql.split(';');
    for (const statement of statements.map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const [email, key, gen, sandbox] of [['owner@example.test', 'sk-bayleaf-owner', generation, 'one'],
    ['blank@example.test', 'sk-bayleaf-blank', '', null]])
    await db.prepare('INSERT INTO user_keys(email,bayleaf_token,account_generation,daytona_sandbox_id) VALUES(?,?,?,?)').bind(email, key, gen, sandbox).run();
  await db.prepare("INSERT INTO sandbox_credentials(id,email,sandbox_id,token_hash,secret_name,state,created_at,updated_at) VALUES('sc','owner@example.test','one',?,'s','active',0,0)")
    .bind(createHash('sha256').update(sandboxBearer).digest('hex')).run();
  const api = await mf.getWorker('api'), off = await mf.getWorker('api-off'), unbound = await mf.getWorker('api-unbound');
  const rooms = await mf.getWorker('bayleaf-rooms');
  const calls = async () => (await rooms.fetch('https://stub/')).json();
  const req = (target, path, { key = 'sk-bayleaf-owner', method = 'GET', body, headers = {} } = {}) =>
    target.fetch('https://api.bayleaf.dev' + path, { method, body: typeof body === 'string' ? body : body && JSON.stringify(body),
      headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } });
  const json = async (r, status) => { const text = await r.text(); assert.equal(r.status, status, text); return JSON.parse(text); };
  const notFound = { error: { message: 'Not found', code: 404 } };

  // Disabled flag or missing binding: indistinguishable from a nonexistent path, before auth.
  for (const target of [off, unbound]) for (const key of ['sk-bayleaf-owner', null, 'garbage'])
    assert.deepEqual(await json(await req(target, '/rooms', { key }), 404), notFound);
  for (const path of ['/rooms/r_1/nope', '/rooms/r_1/credentials/', '/rooms/r_1/export/x'])
    assert.deepEqual(await json(await req(api, path), 404), notFound);
  assert.deepEqual(await calls(), []);

  // Authority: Campus Pass, unscoped app tokens, bad and blank identities never reach the RPC.
  const campus = await json(await req(api, '/rooms', { key: null, headers: { 'CF-Connecting-IP': '192.0.2.7' } }), 403);
  assert.match(campus.error.message, /Campus Pass does not establish ownership/);
  await json(await req(api, '/rooms', { key: null, headers: { 'CF-Connecting-IP': '203.0.113.1' } }), 401);
  await json(await req(api, '/rooms', { key: 'sk-bayleaf-nope' }), 401);
  await json(await req(api, '/rooms', { key: 'sk-bayleaf-blank' }), 500);
  const token = async (...scopes) => (await (await api.fetch('https://api.bayleaf.dev/__test/grant?' +
    scopes.map(s => 'scope=' + s).join('&'))).json()).access_token;
  const webOnly = await token('web.search');
  assert.equal((await json(await req(api, '/rooms', { key: webOnly }), 403)).error.code, 'insufficient_scope');
  assert.deepEqual(await calls(), []);

  // Ordinary key and sandbox credential both resolve to the account generation, unchanged JSON passthrough.
  for (const key of ['sk-bayleaf-owner', sandboxBearer]) {
    const res = await req(api, '/rooms/limits', { key });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await json(res, 200), { method: 'getLimits', owner: generation, args: [] });
  }
  assert.equal((await json(await req(api, '/rooms'), 200)).rooms[0].room_id, 'r_1');
  assert.deepEqual(await json(await req(api, '/rooms', { method: 'POST', body: { label: 'board', codec: 'yjs', expires_at: '2026-12-01T00:00:00Z' } }), 201),
    { method: 'createRoom', owner: generation, args: [{ label: 'board', codec: 'yjs', expires_at: '2026-12-01T00:00:00Z' }] });
  assert.deepEqual((await json(await req(api, '/rooms', { method: 'POST', body: '', headers: { 'Content-Type': 'application/json' } }), 201)).args, [{}]);
  assert.deepEqual((await json(await req(api, '/rooms/r_1'), 200)).args, ['r_1']);
  assert.deepEqual((await json(await req(api, '/rooms/r_1', { method: 'PATCH', body: { mode: 'read_only' } }), 200)).args, ['r_1', { mode: 'read_only' }]);
  assert.equal((await json(await req(api, '/rooms/r_1', { method: 'DELETE' }), 200)).method, 'deleteRoom');
  for (const body of [{ scopes: ['presence'], label: 'projector-qr' }, { scopes: [], label: 'reader' },
    { role: 'write', labels: ['s01', 's02'], expires_at: '2026-11-20T00:00:00Z' }])
    assert.deepEqual((await json(await req(api, '/rooms/r_1/credentials', { method: 'POST', body }), 201)).args, ['r_1', body]);
  assert.deepEqual((await json(await req(api, '/rooms/r_1/credentials'), 200)).args, ['r_1']);
  assert.deepEqual((await json(await req(api, '/rooms/r_1/credentials/c_1', { method: 'DELETE' }), 200)).args, ['r_1', 'c_1']);
  const seen = await calls();
  assert.ok(seen.length === 13 && seen.every(call => call.owner === generation), JSON.stringify(seen.map(c => c.method)));

  // Local validation runs after auth and before the RPC.
  for (const body of [{ scopes: ['append'], role: 'write', label: 'x' }, { label: 'x' }, { scopes: ['append'] },
    { scopes: ['append'], label: 'x', labels: ['y'] }, { scopes: ['admin'], label: 'x' }, { role: 'owner', label: 'x' },
    { scopes: ['append'], labels: [] }, { scopes: ['append'], label: '' }, { scopes: ['append'], label: 'x', extra: 1 }])
    await json(await req(api, '/rooms/r_1/credentials', { method: 'POST', body }), 400);
  for (const body of [{}, { mode: 'frozen' }, { label: 'x', extra: 1 }])
    await json(await req(api, '/rooms/r_1', { method: 'PATCH', body }), 400);
  await json(await req(api, '/rooms', { method: 'POST', body: { codec: 'crdt' } }), 400);
  await json(await req(api, '/rooms', { method: 'POST', body: '[1]' }), 400);
  await json(await req(api, '/rooms', { method: 'POST', body: '{' }), 400);
  await json(await req(api, '/rooms', { method: 'POST', body: '{"label":"x"}', headers: { 'Content-Type': 'text/plain' } }), 415);
  await json(await req(api, '/rooms', { method: 'POST', body: { label: 'x'.repeat(5000) } }), 413);
  await json(await req(api, '/rooms/r_1/export?format=xml'), 400);
  await json(await req(api, '/rooms/' + 'x'.repeat(65)), 400);
  // Auth precedes Zod validation: invalid input never answers 400 to an unauthenticated caller.
  await json(await req(api, '/rooms/r_1/credentials', { key: null, method: 'POST', body: { role: 'nope' } }), 401);
  await json(await req(api, '/rooms/r_1/export?format=xml', { key: null }), 401);
  assert.deepEqual(await calls(), [], 'rejected requests never reach the RPC');

  // RPC error mapping, thrown RPC and unexpected results all fail closed.
  for (const [code, status] of [['invalid', 400], ['not_found', 404], ['disabled', 404], ['limit', 409], ['credential_limit', 409],
    ['unavailable', 503], ['weird', 503]]) {
    const body = await json(await req(api, '/rooms/r_err_' + code), status);
    assert.equal(body.error.code, status);
    assert.equal(body.error.label, undefined, 'only label_taken echoes a label');
  }
  const taken = await json(await req(api, '/rooms/r_err_label_taken/credentials', { method: 'POST', body: { role: 'write', labels: ['s01'] } }), 409);
  assert.equal(taken.error.label, 's01');
  for (const id of ['r_throw', 'r_response', 'r_null']) await json(await req(api, '/rooms/' + id), 503);
  assert.equal((await calls()).length, 11);

  // Exports are inert downloads with the RPC's (allowlisted) type.
  const lines = await req(api, '/rooms/r_1/export', { headers: { 'X-Test-Origin': 'https://elsewhere.example' } });
  assert.equal(lines.status, 200);
  assert.equal(await lines.text(), '{"seq":1}\n');
  for (const [name, value] of [['Content-Type', 'application/x-ndjson'], ['Content-Disposition', 'attachment; filename="r_1.jsonl"'],
    ['Cache-Control', 'no-store'], ['X-Content-Type-Options', 'nosniff'], ['Content-Security-Policy', 'sandbox'], ['Access-Control-Allow-Origin', '*']])
    assert.equal(lines.headers.get(name), value, name);
  const yjs = await req(api, '/rooms/r_1/export?format=yjs');
  assert.deepEqual([...new Uint8Array(await yjs.arrayBuffer())], [0, 1, 2]);
  assert.equal(yjs.headers.get('Content-Disposition'), 'attachment; filename="r_1.yjs"');
  const html = await req(api, '/rooms/r_badtype/export');
  assert.equal(html.headers.get('Content-Type'), 'text/html', 'allowlisted shape passes; sandbox CSP and attachment keep it inert');
  assert.equal(html.headers.get('Content-Security-Policy'), 'sandbox');
  await json(await req(api, '/rooms/r_nobody/export'), 503);
  await json(await req(api, '/rooms/r_err_not_found/export'), 404);
  assert.deepEqual((await calls()).map(call => call.args), [['r_1', {}], ['r_1', { format: 'yjs' }], ['r_badtype', {}], ['r_nobody', {}], ['r_err_not_found', {}]]);

  // App tokens: rooms.read and rooms.manage are account-wide and do not imply each other.
  const reader = await token('rooms.read'), manager = await token('rooms.manage');
  for (const path of ['/rooms/limits', '/rooms', '/rooms/r_1', '/rooms/r_1/export']) await req(api, path, { key: reader }).then(r => assert.equal(r.status, 200, path));
  for (const [method, path, body] of [['POST', '/rooms', {}], ['PATCH', '/rooms/r_1', { mode: 'open' }], ['DELETE', '/rooms/r_1'],
    ['POST', '/rooms/r_1/credentials', { role: 'read', label: 'x' }], ['GET', '/rooms/r_1/credentials'], ['DELETE', '/rooms/r_1/credentials/c_1']]) {
    assert.equal((await json(await req(api, path, { key: reader, method, body }), 403)).error.code, 'insufficient_scope', method + path);
    assert.ok([200, 201].includes((await req(api, path, { key: manager, method, body })).status), method + path);
  }
  for (const path of ['/rooms', '/rooms/r_1/export']) assert.equal((await json(await req(api, path, { key: manager }), 403)).error.code, 'insufficient_scope');
  assert.ok((await calls()).every(call => call.owner === generation), 'app tokens act for their grantor');
  // Rooms scopes cannot be issued while Rooms is unavailable.
  assert.equal((await json(await req(off, '/grants', { method: 'POST', body: { scopes: ['rooms.read'], expires_in: 60 } }), 400)).error.code, 'invalid_scope');
  const issued = await json(await req(api, '/grants', { method: 'POST', body: { scopes: ['rooms.read'], expires_in: 60 } }), 200);
  assert.deepEqual(issued.scopes, ['rooms.read']);

  // Dashboard card endpoints: browser session only, same-origin writes, bounded extension.
  const data = [{ alg: 'HS256', typ: 'JWT' }, { email: 'owner@example.test', name: 'Synthetic', exp: Math.floor(Date.now()/1000)+3600 }]
    .map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  const Cookie = 'bayleaf_session=' + data + '.' + createHmac('sha256', 'synthetic-signing').update(data).digest('base64url');
  const same = { Cookie, 'X-Test-Origin': 'https://api.bayleaf.dev' };
  const list = await req(api, '/dashboard/rooms', { key: null, headers: { Cookie } });
  assert.equal(list.headers.get('X-Frame-Options'), 'DENY');
  assert.equal((await json(list, 200)).rooms.length, 1);
  await json(await req(api, '/dashboard/rooms', { key: null }), 401);
  await json(await req(off, '/dashboard/rooms', { key: null, headers: { Cookie } }), 404);
  await json(await req(api, '/dashboard/rooms/r_1', { key: null, method: 'PATCH', body: { days: 90 }, headers: { Cookie, 'X-Test-Origin': 'https://evil.example' } }), 403);
  await json(await req(api, '/dashboard/rooms/r_1', { key: null, method: 'DELETE', headers: { Cookie } }), 403);
  for (const body of [{ days: 91 }, { days: 0 }, { days: 1.5 }, { expires_at: 'x' }])
    await json(await req(api, '/dashboard/rooms/r_1', { key: null, method: 'PATCH', body, headers: same }), 400);
  const before = Date.now();
  const extended = await json(await req(api, '/dashboard/rooms/r_1', { key: null, method: 'PATCH', body: { days: 90 }, headers: same }), 200);
  const until = Date.parse(extended.args[1].expires_at) - before;
  assert.ok(until >= 90 * 86400_000 && until < 90 * 86400_000 + 60_000, 'ninety days from now');
  assert.deepEqual(Object.keys(extended.args[1]), ['expires_at'], 'the card can only move expiry');
  assert.equal((await json(await req(api, '/dashboard/rooms/r_1', { key: null, method: 'DELETE', headers: same }), 200)).method, 'deleteRoom');
  assert.equal((await json(await req(api, '/dashboard/rooms', { key: webOnly, headers: { Cookie } }), 403)).error.code, 'insufficient_scope');
  assert.deepEqual((await calls()).map(call => call.method), ['listRooms', 'updateRoom', 'deleteRoom']);

  // Retirement: the ledger is retried through retireOwner even while Rooms is disabled.
  await db.prepare('INSERT INTO room_retirements(generation,retired_at) VALUES (?,?)').bind('retired-generation', 1).run();
  assert.equal(await (await off.fetch('https://api.bayleaf.dev/__test/retire')).json(), 0);
  assert.ok((await db.prepare('SELECT fenced_at FROM room_retirements').first()).fenced_at > 0);
  // Fence, then the same run's replay pass (as for inboxes): retireOwner is idempotent.
  assert.deepEqual((await calls()).map(call => [call.method, call.owner]), [['retireOwner', 'retired-generation'], ['retireOwner', 'retired-generation']]);
  assert.equal(await (await unbound.fetch('https://api.bayleaf.dev/__test/retire')).json(), 1, 'a missing binding counts a failed replay');

  // Documented contract: every facade route is a Bearer-only Rooms operation.
  const spec = await json(await req(api, '/docs/openapi.json', { key: null }), 200);
  const roomOps = Object.entries(spec.paths).filter(([path]) => path.startsWith('/rooms')).flatMap(([, ops]) => Object.values(ops));
  assert.equal(roomOps.length, 10);
  assert.ok(roomOps.every(op => op.tags[0] === 'Rooms' && op.operationId && JSON.stringify(op.security) === '[{"Bearer":[]}]'));
  assert.ok(!Object.keys(spec.paths).some(path => path.startsWith('/dashboard')), 'card endpoints stay out of the spec');

  // Room-only use never provisions or touches inference credentials.
  assert.deepEqual(outbound, [], 'no provider traffic');
  const row = await db.prepare("SELECT or_key_secret, tinfoil_key FROM user_keys WHERE email='owner@example.test'").first();
  assert.deepEqual(row, { or_key_secret: null, tinfoil_key: null });
  console.log('PASS rooms facade: 404 when disabled, auth before validation, owner and app-token authority, generation passthrough, error mapping, inert exports, dashboard card, retirement retry, no provisioning');
} finally { await mf.dispose(); }
