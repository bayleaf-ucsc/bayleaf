#!/usr/bin/env node
/** Inbox facade in real workerd/D1 against a STUB bayleaf-inboxes RPC. No network, no providers. */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const generation = 'a'.repeat(64), sandboxBearer = 'sk-bayleaf-sandbox-' + 'b'.repeat(64);
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  import { issueGrant } from './src/grants.ts';
  export default { ...app, async fetch(req, env, ctx) {
    if (new URL(req.url).pathname === '/__test/grant') {
      const row = await env.DB.prepare('SELECT * FROM user_keys WHERE email=?').bind('owner@example.test').first();
      return Response.json(await issueGrant(env, row, 'https://api.example.test', ['openrouter:test/open'], Math.floor(Date.now()/1000)+600));
    }
    const headers = new Headers(req.headers);
    if (headers.has('X-Test-Origin')) { headers.set('Origin', headers.get('X-Test-Origin')); headers.delete('X-Test-Origin'); }
    return app.fetch(new Request(req, { headers }), env, ctx);
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'], loader: { '.py': 'text', '.md': 'text' } });

// Stub inbox Worker: records every call; canned outcomes are selected by the inbox id.
const stub = `import { WorkerEntrypoint } from 'cloudflare:workers';
const calls = [];
const canned = (method, owner, args) => {
  calls.push({ method, owner, args });
  const id = args[0];
  if (id === 'ibx_throw') throw new Error('synthetic RPC failure');
  if (id === 'ibx_response') return new Response('unexpected');
  if (typeof id === 'string' && id.startsWith('ibx_err_')) return { error: id.slice(8) };
  if (method === 'getMessageBody') return new Response('<script>alert(1)</script>', { headers: {
    'Content-Type': 'text/html', 'Content-Length': '25', 'Content-Disposition': 'inline', 'Set-Cookie': 'x=1' } });
  if (method === 'getAttachment') return new Response(new Uint8Array([1, 2, 3]), { headers: {
    'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''a.pdf" } });
  if (method === 'createCredential') return { credential: { id: 'cred_x', kind: 'bearer' }, token: 'sk-bayleaf-inbox-' + '0'.repeat(64) };
  return { method, owner, args };
};
export class InboxManagement extends WorkerEntrypoint {}
for (const m of ['createInbox','listInboxes','getInbox','destroyInbox','listMessages','getMessage','getMessageText','getMessageBody',
  'getAttachment','setArchived','deleteMessage','createCredential','listCredentials','revokeCredential'])
  InboxManagement.prototype[m] = async function (owner, ...args) { return canned(m, owner, args); };
export default { fetch() { return Response.json(calls.splice(0)); } };`;

const outbound = [];
const worker = (enabled, binding = true) => ({ name: !binding ? 'api-unbound' : enabled ? 'api' : 'api-off', modules: true,
  script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'shared-db' }, kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'],
  ...(binding ? { serviceBindings: { INBOXES: { name: 'bayleaf-inboxes', entrypoint: 'InboxManagement' } } } : {}),
  bindings: { INBOXES_ENABLED: enabled ? 'true' : 'false', CAMPUS_IP_RANGES: '192.0.2.0/24', CAMPUS_POOL_KEY: 'synthetic-pool',
    GRANTS_ENABLED: 'true', GRANTS_MAX_SECONDS: '3600', OIDC_CLIENT_SECRET: 'synthetic-signing', PREVIEWS_ENABLED: 'false',
    DAYTONA_API_URL: 'https://daytona.example.test', DAYTONA_API_KEY: 'synthetic', DAYTONA_DEPLOYMENT_LABEL: 'synthetic',
    OPENROUTER_PROVISIONING_KEY: 'synthetic-admin', TINFOIL_ADMIN_KEY: 'synthetic-admin' },
  outboundService: req => {
    const u = new URL(req.url);
    // Sandbox credential authentication is a passive Daytona metadata read; nothing else may leave.
    if (u.hostname === 'daytona.example.test' && req.method === 'GET' && u.pathname === '/sandbox/one')
      return Response.json({ id: 'one', state: 'started', labels: { synthetic: 'owner@example.test' } });
    outbound.push(u.hostname + u.pathname);
    throw new Error('Inbox facade must not reach ' + u.hostname);
  } });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [worker(true), worker(false), worker(true, false),
  { ...worker(true), name: 'api-pilot', bindings: { ...worker(true).bindings, INBOXES_PILOT_OWNER: 'different-owner-generation' } },
  { name: 'bayleaf-inboxes', modules: true, compatibilityDate: '2026-08-01', script: stub }] }));
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
  const api = await mf.getWorker('api'), inbox = await mf.getWorker('bayleaf-inboxes');
  for (const path of ['/inboxes/ibx_1/messages//body', '/inboxes/ibx_1/credentials/', '/inboxes/unknown/subpath']) {
    const response = await api.fetch('https://api.example.test' + path);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { message: 'Not found', code: 404 } });
  }
  const pilot = await mf.getWorker('api-pilot');
  const deniedPilot = await pilot.fetch('https://api.example.test/inboxes', {
    headers: { Authorization: 'Bearer sk-bayleaf-owner' } });
  assert.equal(deniedPilot.status, 404, 'operator-only pilot denies other authenticated owners');
  const calls = async () => (await inbox.fetch('https://stub/')).json();
  const data = [{ alg: 'HS256', typ: 'JWT' }, { email: 'owner@example.test', name: 'Synthetic', exp: Math.floor(Date.now()/1000)+3600 }]
    .map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  const Cookie = 'bayleaf_session=' + data + '.' + createHmac('sha256', 'synthetic-signing').update(data).digest('base64url');
  for (const target of [pilot, await mf.getWorker('api-off'), await mf.getWorker('api-unbound')]) {
    assert.equal((await target.fetch('https://api.bayleaf.dev/diagnostics/inboxes', { headers: { Cookie } })).status, 404,
      'browser diagnostics preserve pilot/disabled/unbound gates');
  }
  assert.deepEqual(await calls(), [], 'denied diagnostics never reach the receiver RPC');
  const req = (target, path, { key = 'sk-bayleaf-owner', method = 'GET', body, headers = {} } = {}) =>
    target.fetch('https://api.bayleaf.dev' + path, { method, body: typeof body === 'string' ? body : body && JSON.stringify(body),
      headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } });
  const json = async (r, status) => { const text = await r.text(); assert.equal(r.status, status, text); return JSON.parse(text); };
  const notFound = { error: { message: 'Not found', code: 404 } };

  // Disabled flag or missing binding: indistinguishable from a nonexistent path, before auth.
  for (const name of ['api-off', 'api-unbound']) for (const key of ['sk-bayleaf-owner', null, 'garbage'])
    assert.deepEqual(await json(await req(await mf.getWorker(name), '/inboxes', { key }), 404), notFound);
  assert.deepEqual(await calls(), []);

  // Authority: Campus Pass, grants, bad and blank identities never reach the RPC.
  const campus = await json(await req(api, '/inboxes', { key: null, headers: { 'CF-Connecting-IP': '192.0.2.7' } }), 403);
  assert.match(campus.error.message, /Campus Pass does not establish ownership/);
  await json(await req(api, '/inboxes', { key: 'campus', headers: { 'CF-Connecting-IP': '192.0.2.7' } }), 403);
  await json(await req(api, '/inboxes', { key: null, headers: { 'CF-Connecting-IP': '203.0.113.1' } }), 401);
  await json(await req(api, '/inboxes', { key: 'sk-bayleaf-nope' }), 401);
  const grant = await (await api.fetch('https://api.bayleaf.dev/__test/grant')).json();
  assert.match(grant.access_token, /^sk-bayleaf-grant-/);
  assert.equal((await json(await req(api, '/inboxes', { key: grant.access_token, method: 'POST', body: { type: 'email' } }), 403)).error.code, 'insufficient_scope');
  await json(await req(api, '/inboxes', { key: 'sk-bayleaf-blank' }), 500);
  assert.deepEqual(await calls(), []);

  // Ordinary key and sandbox credential both resolve to the account generation, unchanged JSON passthrough.
  for (const key of ['sk-bayleaf-owner', sandboxBearer])
    assert.deepEqual(await json(await req(api, '/inboxes', { key }), 200), { method: 'listInboxes', owner: generation, args: [] });
  assert.deepEqual(await json(await req(api, '/inboxes', { method: 'POST', body: { type: 'http', label: 'hooks' } }), 201),
    { method: 'createInbox', owner: generation, args: [{ type: 'http', label: 'hooks' }] });
  await json(await req(api, '/inboxes/ibx_1'), 200);
  assert.equal((await json(await req(api, '/inboxes/ibx_1', { method: 'DELETE' }), 202)).method, 'destroyInbox');
  assert.deepEqual((await json(await req(api, '/inboxes/ibx_1/messages?limit=20&archived=all&q=hi&cursor=abc&junk=1'), 200)).args,
    ['ibx_1', { cursor: 'abc', q: 'hi', limit: 20, archived: 'all' }]);
  assert.deepEqual((await json(await req(api, '/inboxes/ibx_1/messages'), 200)).args, ['ibx_1', {}]);
  assert.deepEqual((await json(await req(api, '/inboxes/ibx_1/messages?archived=false'), 200)).args, ['ibx_1', { archived: false }]);
  await json(await req(api, '/inboxes/ibx_1/messages/msg_1'), 200);
  assert.deepEqual(await json(await req(api, '/inboxes/ibx_1/messages/msg_1/text'), 200),
    { method: 'getMessageText', owner: generation, args: ['ibx_1', 'msg_1'] });
  assert.deepEqual((await json(await req(api, '/inboxes/ibx_1/messages/msg_1', { method: 'PATCH', body: { archived: true } }), 200)).args,
    ['ibx_1', 'msg_1', true]);
  await json(await req(api, '/inboxes/ibx_1/messages/msg_1', { method: 'DELETE' }), 200);
  const created = await json(await req(api, '/inboxes/ibx_1/credentials', { method: 'POST' }), 201);
  assert.match(created.token, /^sk-bayleaf-inbox-/);
  await json(await req(api, '/inboxes/ibx_1/credentials', { method: 'POST', body: { name: 'gh' } }), 201);
  await json(await req(api, '/inboxes/ibx_1/credentials'), 200);
  await json(await req(api, '/inboxes/ibx_1/credentials/cred_1', { method: 'DELETE' }), 200);
  const seen = await calls();
  assert.ok(seen.length === 16 && seen.every(call => call.owner === generation));
  assert.deepEqual(seen.find(call => call.method === 'createCredential').args, ['ibx_1', {}]);

  // RPC error mapping, thrown RPC, and local validation (after auth, before the RPC).
  for (const [code, status] of [['invalid', 400], ['not_found', 404], ['disabled', 404], ['limit', 409], ['conflict', 409], ['unavailable', 503], ['weird', 503]]) {
    const body = await json(await req(api, '/inboxes/ibx_err_' + code), status);
    assert.equal(body.error.code, status);
  }
  await json(await req(api, '/inboxes/ibx_throw'), 503);
  for (const query of ['limit=-1', 'limit=abc', 'archived=yes'])
    await json(await req(api, '/inboxes/ibx_1/messages?' + query), 400);
  // Auth precedes Zod validation: invalid input never answers 400 to an unauthenticated or non-owner caller.
  await json(await req(api, '/inboxes/ibx_1/messages?limit=abc', { key: null }), 401);
  await json(await req(api, '/inboxes/ibx_1/messages/msg_1', { key: null, method: 'PATCH', body: { archived: 'yes' } }), 401);
  await json(await req(api, '/inboxes/ibx_1/messages/msg_1/attachments/x', { key: null, headers: { 'CF-Connecting-IP': '192.0.2.7' } }), 403);
  await json(await req(api, '/inboxes/' + 'x'.repeat(65)), 400);
  await json(await req(api, '/inboxes/ibx_1/credentials', { method: 'POST', body: '', headers: { 'Content-Type': 'application/json' } }), 201);
  await json(await req(api, '/inboxes', { method: 'POST', body: { type: 'fax' } }), 400);
  for (const body of [{ archived: 'yes' }, { archived: true, extra: 1 }, {}])
    await json(await req(api, '/inboxes/ibx_1/messages/msg_1', { method: 'PATCH', body }), 400);
  await json(await req(api, '/inboxes', { method: 'POST', body: '[1]' }), 400);
  await json(await req(api, '/inboxes', { method: 'POST', body: '{', }), 400);
  await json(await req(api, '/inboxes', { method: 'POST', body: '{"type":"email"}', headers: { 'Content-Type': 'text/plain' } }), 415);
  await json(await req(api, '/inboxes', { method: 'POST', body: { type: 'email', label: 'x'.repeat(5000) } }), 413);
  await json(await req(api, '/inboxes/ibx_1/messages/msg_1/attachments/x'), 400);
  const rejected = await calls();
  assert.equal(rejected.length, 9, 'only the error-mapping calls and the empty JSON body reached the RPC');
  assert.deepEqual(rejected.at(-1).args, ['ibx_1', {}], 'an empty application/json body is {}');

  // Downloads stream through inert: no rendering, sniffing, caching, or upstream header leakage.
  const page = await req(api, '/inboxes/ibx_1/messages/msg_1/body', { headers: { 'X-Test-Origin': 'https://elsewhere.example' } });
  assert.equal(page.status, 200, await page.clone().text());
  assert.equal(await page.text(), '<script>alert(1)</script>');
  for (const [name, value] of [['Content-Type', 'text/html'], ['Content-Disposition', 'attachment'], ['Cache-Control', 'no-store'],
    ['X-Content-Type-Options', 'nosniff'], ['Content-Security-Policy', 'sandbox'], ['Access-Control-Allow-Origin', '*']])
    assert.equal(page.headers.get(name), value, name);
  assert.equal(page.headers.get('Set-Cookie'), null);
  const file = await req(api, '/inboxes/ibx_1/messages/msg_1/attachments/2');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  assert.equal(file.headers.get('Content-Disposition'), "attachment; filename*=UTF-8''a.pdf");
  assert.equal(file.headers.get('Content-Security-Policy'), 'sandbox');
  assert.deepEqual((await calls()).map(call => call.args), [['ibx_1', 'msg_1'], ['ibx_1', 'msg_1', 2]]);
  await json(await req(api, '/inboxes/ibx_err_not_found/messages/msg_1/body'), 404);
  // A JSON route that unexpectedly receives a Response fails closed rather than streaming it.
  await json(await req(api, '/inboxes/ibx_response'), 503);
  assert.equal((await calls()).length, 2);

  // CORS preflight admits PATCH for bearer clients.
  const preflight = await api.fetch('https://api.bayleaf.dev/inboxes/ibx_1/messages/msg_1', { method: 'OPTIONS', headers: {
    'X-Test-Origin': 'https://elsewhere.example', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /PATCH/);

  // Documented contract: every facade route is a Bearer-only Inboxes operation (security details in test-docs).
  const spec = await json(await req(api, '/docs/openapi.json', { key: null }), 200);
  const inboxOps = Object.entries(spec.paths).filter(([path]) => path.startsWith('/inboxes')).flatMap(([, ops]) => Object.values(ops));
  assert.equal(inboxOps.length, 14);
  assert.ok(inboxOps.every(op => op.tags[0] === 'Inboxes' && op.operationId));

  // Inbox-only use never provisions or touches inference credentials.
  assert.deepEqual(outbound, [], 'no provider traffic');
  const row = await db.prepare("SELECT or_key_secret, tinfoil_key FROM user_keys WHERE email='owner@example.test'").first();
  assert.deepEqual(row, { or_key_secret: null, tinfoil_key: null });
  console.log('PASS inbox facade: 404 when disabled, auth before validation, documented operations, owner authority, generation passthrough, error mapping, inert downloads, no provisioning');
} finally { await mf.dispose(); }
