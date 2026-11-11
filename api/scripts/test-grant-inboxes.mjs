#!/usr/bin/env node
/** Inbox-scoped app tokens (SCOPES.md): real API facade + real bayleaf-inboxes Worker over its
 * service binding, in workerd with real D1/R2. Synthetic owners only; no network, no providers.
 * Needs `npm install` in ../inbox (postal-mime). Stream revocation lives in test-inbox-stream.mjs.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { generateVerifier } from '../../inbox/scripts/build-dkim.mjs';
import { inboxTestAssets } from './inbox-test-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const inboxRoot = fileURLToPath(new URL('../../inbox/', import.meta.url));
const apiScript = (await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  export default { ...app, async fetch(req, env, ctx) {
    const headers = new Headers(req.headers);
    if (headers.has('X-Test-Origin')) { headers.set('Origin', headers.get('X-Test-Origin')); headers.delete('X-Test-Origin'); }
    return app.fetch(new Request(req, { headers }), env, ctx);
  }};` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers', 'node:*'], loader: { '.py': 'text', '.md': 'text' }, plugins: [inboxTestAssets] })).outputFiles[0].text;
await generateVerifier();
const inboxScript = (await build({ absWorkingDir: inboxRoot, entryPoints: ['src/worker.js'], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'] })).outputFiles[0].text;

const DOMAIN = 'bayleaf-inboxes.dev', API = 'https://api.example.test', SECRET = 'synthetic-grant-inbox-secret';
const GEN = { a: 'gen-a-'.padEnd(64, 'a'), b: 'gen-b-'.padEnd(64, 'b'), c: 'gen-c-'.padEnd(64, 'c') };
const noNet = req => { throw new Error('No outbound network: ' + new URL(req.url).hostname); };
const apiWorker = (name, extra = {}) => ({ name, modules: true, script: apiScript, compatibilityDate: '2026-08-01',
  compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'api-db' }, kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'],
  outboundService: noNet, serviceBindings: { INBOXES: { name: 'bayleaf-inboxes', entrypoint: 'InboxManagement' } },
  bindings: { INBOXES_ENABLED: 'true', INBOXES_PILOT_OWNER: '', GRANTS_ENABLED: 'true', GRANTS_MAX_SECONDS: '3600',
    OIDC_CLIENT_SECRET: SECRET, ALLOWED_EMAIL_DOMAIN: 'example.test', CAMPUS_IP_RANGES: '192.0.2.0/24', PREVIEWS_ENABLED: 'false',
    OPENROUTER_PROVISIONING_KEY: 'synthetic', TINFOIL_ADMIN_KEY: 'synthetic', ...extra } });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  { name: 'bayleaf-inboxes', modules: true, script: inboxScript, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
    routes: [`*.${DOMAIN}/*`], d1Databases: { DB: 'inbox-db' }, r2Buckets: ['BLOBS'], outboundService: noNet,
    ratelimits: { ACCEPT_LIMIT: { namespace_id: '9711', simple: { limit: 60, period: 60 } }, REJECT_LIMIT: { namespace_id: '9712', simple: { limit: 30, period: 60 } } },
    bindings: { INBOXES_ENABLED: 'true', INBOX_DOMAIN: DOMAIN } },
  { ...apiWorker('api'), routes: ['api.example.test/*'] },
  apiWorker('api-off', { INBOXES_ENABLED: 'false' }),
  apiWorker('api-pilot', { INBOXES_PILOT_OWNER: GEN.b }),
] }));

const migrate = async (db, dir) => {
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(dir + file, 'utf8')).replace(/^\s*--.*$/gm, '');
    const parts = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) :
      file === '0007_email_auth.sql' ? sql.match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g) : sql.split(';');
    for (const s of parts.map(x => x.trim()).filter(Boolean)) await db.prepare(s).run();
  }
};
const session = email => {
  const data = [{ alg: 'HS256', typ: 'JWT' }, { email, name: 'Synthetic', exp: Math.floor(Date.now()/1000) + 3600 }]
    .map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return 'bayleaf_session=' + data + '.' + createHmac('sha256', SECRET).update(data).digest('base64url');
};
const workers = {};
const call = async (key, method, path, { body, worker = 'api', headers = {} } = {}) =>
  (workers[worker] ??= await mf.getWorker(worker)).fetch(API + path, { method, redirect: 'manual', body: body && JSON.stringify(body),
    headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } });
const expect = async (res, status, code, what) => {
  const text = await res.text();
  assert.equal(res.status, status, `${what}: ${text}`);
  const value = text.startsWith('{') ? JSON.parse(text) : text;
  if (code) assert.equal(value.error?.code, code, `${what}: ${text}`);
  return value;
};
const issue = (key, json, worker) => call(key, 'POST', '/grants', { body: { expires_in: 600, ...json }, worker });
const READ = ['inboxes.messages.read'], MANAGE = ['inboxes.messages.manage'];

try {
  const apiDb = await mf.getD1Database('DB', 'api');
  await migrate(apiDb, root + 'migrations/');
  await migrate(await mf.getD1Database('DB', 'bayleaf-inboxes'), inboxRoot + 'migrations/');
  for (const [who, email] of [['a', 'a@example.test'], ['b', 'b@example.test'], ['c', 'c@example.test']])
    await apiDb.prepare('INSERT INTO user_keys(email,bayleaf_token,account_generation) VALUES(?,?,?)').bind(email, 'sk-bayleaf-' + who, GEN[who]).run();
  const create = async (key, body) => expect(await call(key, 'POST', '/inboxes', { body }), 201, null, 'create inbox');
  const A = await create('sk-bayleaf-a', { type: 'http', access: 'open', label: 'hooks A' });
  const B = await create('sk-bayleaf-a', { type: 'email', label: 'mail B' });
  const gone = await create('sk-bayleaf-a', { type: 'http', access: 'open' });
  const foreign = await create('sk-bayleaf-b', { type: 'http', access: 'open', label: 'other owner' });
  await expect(await call('sk-bayleaf-a', 'DELETE', `/inboxes/${gone.id}`), 202, null, 'destroy');
  for (const inbox of [A, B]) assert.match(inbox.id, /^ibx_[a-z0-9]{1,60}$/i, 'real handles fit the binding grammar');
  const payload = JSON.stringify({ event: 'push' });
  assert.equal((await mf.dispatchFetch(new URL('/hook', A.url), { method: 'POST', body: payload })).status, 200);
  const mid = (await expect(await call('sk-bayleaf-a', 'GET', `/inboxes/${A.id}/messages`), 200)).messages[0].id;

  // 1. Direct issuance binds only the issuer's own active inboxes, under the facade's gates.
  const bound = await expect(await call('sk-bayleaf-a', 'GET', '/grants/inboxes'), 200, null, 'bindable inboxes');
  assert.deepEqual(bound.inboxes.map(i => i.id).sort(), [A.id, B.id].sort(), 'only own active inboxes, destroyed one omitted');
  assert.equal(bound.inboxes.find(i => i.id === A.id).url, A.url);
  await expect(await issue('sk-bayleaf-a', { scopes: READ }), 400, 'invalid_request', 'inbox scope without inboxes');
  await expect(await issue('sk-bayleaf-a', { scopes: ['identity.read'], inboxes: [A.id] }), 400, 'invalid_request', 'inboxes without inbox scope');
  for (const [inboxes, what] of [[[foreign.id], 'another owner'], [['ibx_unknown0000'], 'unknown handle'], [[gone.id], 'destroying inbox'],
    [[A.id, foreign.id], 'one foreign among own'], [['not-a-handle'], 'malformed handle']])
    await expect(await issue('sk-bayleaf-a', { scopes: READ, inboxes }), 403, 'inbox_not_allowed', what);
  await expect(await issue('sk-bayleaf-a', { scopes: READ, inboxes: [A.id] }, 'api-off'), 403, 'inbox_not_allowed', 'Inboxes disabled');
  await expect(await issue('sk-bayleaf-a', { scopes: READ, inboxes: [A.id] }, 'api-pilot'), 403, 'inbox_not_allowed', 'pilot excludes issuer');
  assert.deepEqual((await expect(await call('sk-bayleaf-a', 'GET', '/grants/inboxes', { worker: 'api-off' }), 200)).inboxes, []);
  const reader = await expect(await issue('sk-bayleaf-a', { scopes: READ, inboxes: [A.id, A.id] }), 200, null, 'valid issuance');
  assert.deepEqual([reader.scopes, reader.inboxes, reader.models], [READ, [A.id], []], 'deduplicated binding echoed');
  const listed = (await expect(await call('sk-bayleaf-a', 'GET', '/grants'), 200)).grants.find(g => g.id === reader.grant_id);
  assert.deepEqual(listed.inboxes, [A.id], 'GET /grants lists the binding');
  console.log('PASS app-token inbox issuance: scope/binding pairing, own active inboxes only, disabled and pilot gates, listing');

  // 2. Token use: read scope reaches only read routes of the bound inbox, acting as the grantor.
  const t = reader.access_token;
  const reads = id => [`/inboxes/${id}`, `/inboxes/${id}/messages`, `/inboxes/${id}/events`, `/inboxes/${id}/messages/${mid}`,
    `/inboxes/${id}/messages/${mid}/text`, `/inboxes/${id}/messages/${mid}/body`, `/inboxes/${id}/messages/${mid}/har`, `/inboxes/${id}/export`];
  for (const path of reads(A.id)) await expect(await call(t, 'GET', path), 200, null, 'bound read ' + path);
  assert.equal((await expect(await call(t, 'GET', `/inboxes/${A.id}/messages/${mid}/text`), 200)).text, payload);
  for (const path of reads(B.id)) await expect(await call(t, 'GET', path), 403, 'insufficient_scope', 'unbound sibling ' + path);
  await expect(await call(t, 'GET', `/inboxes/${foreign.id}`), 403, 'insufficient_scope', 'foreign inbox');
  const denied = [['GET', '/inboxes'], ['GET', '/inboxes/limits'], ['POST', '/inboxes', { type: 'email' }],
    ['PATCH', `/inboxes/${A.id}`, { ttl_seconds: 900 }], ['DELETE', `/inboxes/${A.id}`], ['DELETE', `/inboxes/${A.id}/messages/${mid}`],
    ['GET', `/inboxes/${A.id}/credentials`], ['POST', `/inboxes/${A.id}/credentials`, { name: 'x' }],
    ['DELETE', `/inboxes/${A.id}/credentials/cred_x`], ['PATCH', `/inboxes/${A.id}/messages/${mid}`, { archived: true }]];
  const layers = {};
  for (const [method, path, body] of denied) {
    const message = (await expect(await call(t, method, path, { body }), 403, 'insufficient_scope', `${method} ${path}`)).error.message;
    layers[`${method} ${path}`] = /not bound/.test(message) ? 'binding' : 'scope gate';
  }
  // GET /limits also matches the pattern GET /{id} (scopedRead). The gate must read scopes only
  // from the route that responds, so every denial here comes from the gate, not the binding check.
  assert.deepEqual(Object.entries(layers).filter(([, layer]) => layer !== 'scope gate'), []);
  assert.equal((await expect(await call('sk-bayleaf-a', 'GET', `/inboxes/${A.id}`), 200)).state, 'active', 'denied DELETE left A intact');
  const manager = (await expect(await issue('sk-bayleaf-a', { scopes: MANAGE, inboxes: [A.id] }), 200)).access_token;
  const archived = await expect(await call(manager, 'PATCH', `/inboxes/${A.id}/messages/${mid}`, { body: { archived: true } }), 200, null, 'archive');
  assert.equal(archived.archived, true);
  await expect(await call(manager, 'PATCH', `/inboxes/${B.id}/messages/${mid}`, { body: { archived: false } }), 403, 'insufficient_scope', 'manage unbound');
  for (const path of reads(A.id).slice(0, 3)) await expect(await call(manager, 'GET', path), 403, 'insufficient_scope', 'manage-only read ' + path);
  await expect(await call('sk-bayleaf-a', 'DELETE', `/grants/${reader.grant_id}`), 200, null, 'revoke');
  await expect(await call(t, 'GET', `/inboxes/${A.id}/messages`), 401, 'invalid_token', 'revoked token');
  console.log('PASS app-token inbox use: bound reads as grantor, unbound/foreign/management/credential routes denied, manage archives only, revocation');

  // 4. Visitor authorization: the visitor, never the app, chooses inboxes on the consent page.
  const redirect_uri = 'http://127.0.0.1:5173/cb';
  const start = async (email, query = {}, worker = 'api') => {
    const { client_id } = await expect(await call(null, 'POST', '/grants/clients', { body: { client_name: 'Inbox app', redirect_uri } }), 200);
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({ client_id, response_type: 'code', scopes: JSON.stringify(READ), expires_in: '600', state: 's1',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...query });
    const res = await call(null, 'GET', '/grants/authorize?' + q, { worker });
    if (res.status !== 303) return { res };
    const cookie = session(email) + '; ' + res.headers.getSetCookie().find(c => c.startsWith('bl_grant_flow=')).split(';')[0];
    const page = await call(null, 'GET', res.headers.get('Location'), { headers: { Cookie: cookie } });
    const html = await expect(page, 200, null, 'consent page');
    return { client_id, verifier, cookie, html, id: new URL(res.headers.get('Location'), API).searchParams.get('request'),
      approval: html.match(/name="approval" value="([^"]+)"/)[1] };
  };
  const approve = (flow, inboxes) => {
    const form = new URLSearchParams({ request: flow.id, approval: flow.approval, decision: 'approve' });
    for (const id of inboxes) form.append('inbox', id);
    return (workers.api).fetch(API + '/grants/authorize', { method: 'POST', redirect: 'manual', body: form,
      headers: { Cookie: flow.cookie, 'X-Test-Origin': API, 'Content-Type': 'application/x-www-form-urlencoded' } });
  };
  const exchange = (flow, code) => call(null, 'POST', '/grants/token', { body: { grant_type: 'authorization_code', code,
    client_id: flow.client_id, redirect_uri, code_verifier: flow.verifier } });
  const codeOf = async res => { assert.equal(res.status, 303, await res.clone().text()); return new URL(res.headers.get('Location')).searchParams.get('code'); };

  await expect((await start('a@example.test', { inboxes: JSON.stringify([A.id]) })).res, 400, 'invalid_request', 'inboxes at initiation');
  await expect((await start('a@example.test', {}, 'api-off')).res, 403, 'inbox_not_allowed', 'inbox scope while Inboxes disabled');
  const flow = await start('a@example.test');
  for (const id of [A.id, B.id]) assert.ok(flow.html.includes(`type="checkbox" name="inbox" value="${id}"`), 'own inbox offered ' + id);
  assert.ok(!flow.html.includes(foreign.id) && !flow.html.includes(gone.id), 'foreign and destroying inboxes not offered');
  assert.ok(!/<button[^>]*value="approve"[^>]*disabled/.test(flow.html), 'approve enabled with choices');
  await expect(await approve(flow, []), 403, 'inbox_not_allowed', 'approve with no inbox selected');
  await expect(await approve(flow, [foreign.id]), 403, 'inbox_not_allowed', 'forged foreign handle');
  const visitor = await expect(await exchange(flow, await codeOf(await approve(flow, [A.id]))), 200, null, 'exchange');
  assert.deepEqual([visitor.scopes, visitor.inboxes], [READ, [A.id]], 'exchanged token carries the chosen binding');
  await expect(await call(visitor.access_token, 'GET', `/inboxes/${A.id}/messages?archived=all`), 200, null, 'visitor token reads A');
  await expect(await call(visitor.access_token, 'GET', `/inboxes/${B.id}/messages`), 403, 'insufficient_scope', 'visitor token not bound to B');

  const late = await start('a@example.test');
  const lateCode = await codeOf(await approve(late, [B.id]));
  await expect(await call('sk-bayleaf-a', 'DELETE', `/inboxes/${B.id}`), 202, null, 'destroy B before exchange');
  await expect(await exchange(late, lateCode), 403, 'inbox_not_allowed', 'exchange rechecks liveness');

  const empty = await start('c@example.test');
  assert.match(empty.html, /no active inboxes/i, 'visitor without inboxes is told so');
  assert.match(empty.html, /<button[^>]*value="approve"[^>]*disabled/, 'approve disabled without inboxes');
  assert.ok(!empty.html.includes('name="inbox"'));
  console.log('PASS app-token inbox consent: no app-chosen inboxes, own-inbox checkboxes, empty/forged choice rejected, exchange rechecks, empty state');
} finally {
  await mf.dispose();
}
