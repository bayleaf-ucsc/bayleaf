#!/usr/bin/env node
/** Sandbox-file app tokens (SCOPES.md "Sandbox files"): the lexical path check, issuance and
 * consent bindings, and GET/PUT /sandbox/files/* through the real app in workerd with real D1.
 * Daytona and Toolbox are synthetic; no network, credentials or real machines.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));

// 1. insideSandboxDirs: pure, lexical, table-driven.
const unit = await build({ absWorkingDir: root, entryPoints: ['src/grants.ts'], bundle: true, write: false, format: 'esm',
  platform: 'browser', external: ['cloudflare:workers'], loader: { '.py': 'text', '.md': 'text' } });
const { insideSandboxDirs, SANDBOX_APPS_ROOT: R } = await import(
  `data:text/javascript;base64,${Buffer.from(unit.outputFiles[0].text).toString('base64')}`);
assert.equal(R, '/home/daytona/bayleaf-apps/');
const table = [
  [`${R}journal/a.txt`, true], [`${R}journal/2026/11/e.md`, true], [`${R}notes/x.json`, true, 'second bound dir'],
  [`${R}journal-old/x`, false], [`${R}journal/`, false], [`${R}journal`, false], [`${R}journal//x`, false],
  [`${R}journal/./x`, false], [`${R}journal/../x`, false], [`${R}journal/a/../../x`, false], [`${R}journal/a/..`, false],
  [`${R}journal/a/`, false, 'trailing slash is an empty segment'], ['/home/daytona/journal/x', false], [`${R}other/x`, false],
  [`${R}journal/it's.txt`, false], [`${R}journal/a\\b`, false], [`${R}journal/a\x00b`, false], [`${R}journal/a\nb`, false],
  [`${R}journal/a\x7fb`, false], [`/x${R}journal/a`, false, 'prefix must be anchored'],
];
for (const [path, want, why] of table)
  assert.equal(insideSandboxDirs(path, ['journal', 'notes']), want, `${JSON.stringify(path)} ${why ?? ''}`);
assert.equal(insideSandboxDirs(`${R}journal/a.txt`, []), false, 'no bound dirs allows nothing');
console.log(`PASS insideSandboxDirs: ${table.length} lexical cases (prefix slash, segments, dots, quote/backslash/control)`);

// Full app with synthetic Daytona control plane and Toolbox.
const SECRET = 'synthetic-grant-sandbox-secret', API = 'https://api.example.test', EMAIL = 'owner@example.test', KEY = 'sk-bayleaf-owner';
const bundle = (await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  export { PreviewConnections } from './src/index.ts';
  export default { ...app, async fetch(req, env, ctx) {
    const headers = new Headers(req.headers);
    if (headers.has('X-Test-Origin')) { headers.set('Origin', headers.get('X-Test-Origin')); headers.delete('X-Test-Origin'); }
    return app.fetch(new Request(req, { headers }), env, ctx);
  }};` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers', 'node:*'], loader: { '.py': 'text', '.md': 'text' } })).outputFiles[0].text;

const daytona = [];   // every control-plane or Toolbox request, as "METHOD host/path?query"
const commands = [];  // Toolbox /process/execute commands
const uploads = [];   // Toolbox upload target paths
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'api', modules: true, script: bundle,
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'], durableObjects: { PREVIEW_CONNECTIONS: { className: 'PreviewConnections', useSQLite: true } },
  bindings: { GRANTS_ENABLED: 'true', GRANTS_MAX_SECONDS: '3600', OIDC_CLIENT_SECRET: SECRET, ALLOWED_EMAIL_DOMAIN: 'example.test',
    CAMPUS_IP_RANGES: '192.0.2.0/24', PREVIEWS_ENABLED: 'false', INBOXES_ENABLED: 'false',
    DAYTONA_API_URL: 'https://daytona.example.test/api', DAYTONA_PROXY_URL: 'https://toolbox.example.test/toolbox',
    DAYTONA_API_KEY: 'synthetic-daytona', DAYTONA_DEPLOYMENT_LABEL: 'synthetic',
    OPENROUTER_PROVISIONING_KEY: 'synthetic', TINFOIL_ADMIN_KEY: 'synthetic' },
  outboundService: async req => {
    const u = new URL(req.url);
    daytona.push(`${req.method} ${u.hostname}${u.pathname}${u.search}`);
    if (u.hostname === 'daytona.example.test') {
      assert.equal(u.pathname, '/api/sandbox/sbx1', 'only the cached machine is looked up');
      return Response.json({ id: 'sbx1', state: 'started', labels: { synthetic: EMAIL } });
    }
    if (u.hostname === 'toolbox.example.test') {
      if (u.pathname === '/toolbox/sbx1/process/execute') {
        const { command } = await req.json(); commands.push(command);
        return Response.json({ exitCode: 0, result: command === 'echo ready' ? 'ready' : '' });
      }
      if (u.pathname === '/toolbox/sbx1/files/download')
        return new Response('bytes of ' + u.searchParams.get('path'), { headers: { 'Content-Type': 'application/octet-stream' } });
      if (u.pathname === '/toolbox/sbx1/files/upload') { uploads.push(u.searchParams.get('path')); return Response.json({}); }
    }
    throw new Error('Unexpected synthetic upstream ' + u.hostname + u.pathname);
  } }] }));

const session = email => {
  const data = [{ alg: 'HS256', typ: 'JWT' }, { email, name: 'Synthetic', exp: Math.floor(Date.now()/1000) + 3600 }]
    .map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return 'bayleaf_session=' + data + '.' + createHmac('sha256', SECRET).update(data).digest('base64url');
};
let worker;
const call = (key, method, path, { body, raw, headers = {} } = {}) => worker.fetch(API + path, { method, redirect: 'manual',
  body: raw ?? (body && JSON.stringify(body)),
  headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } });
const expect = async (res, status, code, what) => {
  const text = await res.text();
  assert.equal(res.status, status, `${what}: ${text}`);
  const value = text.startsWith('{') ? JSON.parse(text) : text;
  if (code) assert.equal(value.error?.code, code, `${what}: ${text}`);
  return value;
};
const issue = json => call(KEY, 'POST', '/grants', { body: { expires_in: 600, ...json } });
const READ = ['sandbox.files.read'], WRITE = ['sandbox.files.write'];
const F = '/sandbox/files' + R;  // URL prefix for bound-folder files
// Denied requests must never reach Daytona: not the control plane, not Toolbox.
const denied = async (key, method, path, what, opts) => {
  const before = daytona.length;
  await expect(await call(key, method, path, opts), 403, 'insufficient_scope', what);
  assert.deepEqual(daytona.slice(before), [], what + ' reached Daytona');
};

try {
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(root + 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(root + 'migrations/' + file, 'utf8')).replace(/^\s*--.*$/gm, '');
    const parts = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) :
      file === '0007_email_auth.sql' ? sql.match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g) : sql.split(';');
    for (const s of parts.map(x => x.trim()).filter(Boolean)) await db.prepare(s).run();
  }
  await db.prepare('INSERT INTO user_keys(email,bayleaf_token,daytona_sandbox_id,account_generation) VALUES(?,?,?,?)')
    .bind(EMAIL, KEY, 'sbx1', 'gen-owner').run();
  worker = await mf.getWorker('api');

  // 2. Issuance: scope and binding come together; names follow the slug grammar.
  const codes = {};
  const reject = async (json, what) => {
    const res = await issue(json), text = await res.text();
    assert.equal(res.status, 400, `${what}: ${text}`);
    codes[what] = JSON.parse(text).error?.code;
  };
  await reject({ scopes: READ }, 'scope without sandbox_dirs');
  await reject({ scopes: ['identity.read'], sandbox_dirs: ['journal'] }, 'sandbox_dirs without scope');
  for (const [dirs, what] of [[['Journal'], 'uppercase'], [['-journal'], 'leading hyphen'], [['a/b'], 'slash'], [['..'], 'dot-dot'],
    [[''], 'empty string'], [['a'.repeat(64)], '64 chars'], [Array.from({ length: 17 }, (_, i) => 'd' + i), '17 entries'],
    [[], 'empty array'], [['journal', 7], 'non-string']])
    await reject({ scopes: READ, sandbox_dirs: dirs }, what);
  const reader = await expect(await issue({ scopes: READ, sandbox_dirs: ['journal', 'journal', 'a'.repeat(63)] }), 200, null, 'valid');
  assert.deepEqual([reader.scopes, reader.sandbox_dirs, reader.models, reader.inboxes], [READ, ['journal', 'a'.repeat(63)], [], []]);
  const listed = (await expect(await call(KEY, 'GET', '/grants'), 200)).grants.find(g => g.id === reader.grant_id);
  assert.deepEqual(listed.sandbox_dirs, ['journal', 'a'.repeat(63)], 'GET /grants lists the binding');
  const plain = await expect(await issue({ scopes: ['identity.read'] }), 200);
  assert.deepEqual(plain.sandbox_dirs, [], 'no sandbox scope reports an empty binding');
  console.log('PASS sandbox-dir issuance: pairing, slug grammar, dedupe, listing; rejection codes', JSON.stringify(codes));

  // 3. Route behavior. Read token: inside only, GET only.
  const t = reader.access_token;
  const got = await expect(await call(t, 'GET', F + 'journal/2026/a.txt'), 200, null, 'bound read');
  assert.equal(got, `bytes of ${R}journal/2026/a.txt`);
  assert.ok(daytona.includes(`GET toolbox.example.test/toolbox/sbx1/files/download?path=${encodeURIComponent(R + 'journal/2026/a.txt')}`));
  for (const [path, what] of [[F + 'journal-old/a.txt', 'sibling folder'], [F + 'notes/a.txt', 'unbound folder'], [F + 'journal/', 'folder itself'],
    [F + 'journal', 'folder without slash'], ['/sandbox/files/home/daytona/workspace/a.txt', '~/workspace'], ['/sandbox/files/etc/passwd', '/etc'],
    [F + 'journal/%2E%2E/secret', 'encoded traversal'], [F + 'journal/a/%2e%2e/%2e%2e/x', 'encoded double traversal'],
    [F + 'journal/a%27b', 'encoded quote'], [F + 'journal/a%5Cb', 'encoded backslash'], [F + 'journal/a%0Ab', 'encoded newline'],
    [F + 'journal/a%00b', 'encoded NUL']])
    await denied(t, 'GET', path, 'read ' + what);
  // WHATWG URL parsing resolves %2E%2E segments before the request leaves the client, so the
  // encoded cases above arrive as unbound ~/bayleaf-apps paths; the `..` rule itself is the unit table's.
  assert.equal(new URL(API + F + 'journal/%2E%2E/secret').pathname, F + 'secret');
  await denied(t, 'PUT', F + 'journal/a.txt', 'read token PUT', { raw: 'x' });

  // Write token: PUT inside only, mkdir gets the single quoted parent, no GET.
  const writer = (await expect(await issue({ scopes: WRITE, sandbox_dirs: ['journal'] }), 200)).access_token;
  commands.length = 0; uploads.length = 0;
  const put = await expect(await call(writer, 'PUT', F + 'journal/2026/11/e.md', { raw: 'hello' }), 200, null, 'bound write');
  assert.deepEqual([put.path, put.bytes], [R + 'journal/2026/11/e.md', 5]);
  assert.deepEqual(uploads, [R + 'journal/2026/11/e.md']);
  assert.deepEqual(commands.filter(c => c.startsWith('mkdir -p --')), [`mkdir -p -- '${R}journal/2026/11'`]);
  await denied(writer, 'PUT', F + 'journal-old/e.md', 'write sibling', { raw: 'x' });
  await denied(writer, 'PUT', F + 'journal/%2E%2E/e.md', 'write traversal', { raw: 'x' });
  await denied(writer, 'PUT', '/sandbox/files/home/daytona/workspace/e.md', 'write ~/workspace', { raw: 'x' });
  await denied(writer, 'GET', F + 'journal/2026/11/e.md', 'write token GET');

  // Neither token reaches any other sandbox route.
  for (const token of [t, writer]) {
    await denied(token, 'POST', '/sandbox/exec', 'exec', { body: { command: 'id' } });
    await denied(token, 'GET', '/sandbox', 'status');
    await denied(token, 'DELETE', '/sandbox', 'destroy');
    await denied(token, 'POST', '/sandbox/poke', 'poke');
  }

  // The ordinary key keeps unrestricted file access.
  assert.equal(await expect(await call(KEY, 'GET', '/sandbox/files/home/daytona/workspace/a.txt'), 200), 'bytes of /home/daytona/workspace/a.txt');
  assert.equal((await expect(await call(KEY, 'PUT', '/sandbox/files/home/daytona/workspace/b.txt', { raw: 'ab' }), 200)).bytes, 2);
  await expect(await call(KEY, 'GET', F + 'journal-old/x'), 200, null, 'ordinary key outside bindings');
  console.log('PASS sandbox-file token use: bound GET/PUT only, siblings/folder/workspace/traversal/other verbs denied before Daytona, ordinary key unchanged');

  // 4. Visitor flow: the app names folders; the consent page shows the full paths.
  const redirect_uri = 'http://127.0.0.1:5173/cb';
  const start = async (query = {}) => {
    const { client_id } = await expect(await call(null, 'POST', '/grants/clients', { body: { client_name: 'Journal app', redirect_uri } }), 200);
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({ client_id, response_type: 'code', scopes: JSON.stringify([...READ, ...WRITE]), expires_in: '600',
      state: 's1', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...query });
    const res = await call(null, 'GET', '/grants/authorize?' + q);
    if (res.status !== 303) return { res };
    const cookie = session(EMAIL) + '; ' + res.headers.getSetCookie().find(c => c.startsWith('bl_grant_flow=')).split(';')[0];
    const html = await expect(await call(null, 'GET', res.headers.get('Location'), { headers: { Cookie: cookie } }), 200, null, 'consent');
    return { client_id, verifier, cookie, html, id: new URL(res.headers.get('Location'), API).searchParams.get('request'),
      approval: html.match(/name="approval" value="([^"]+)"/)[1] };
  };
  await expect((await start()).res, 400, 'invalid_request', 'sandbox scope without sandbox_dirs at initiation');
  await expect((await start({ sandbox_dirs: '["journal"' })).res, 400, 'invalid_request', 'malformed JSON');
  await expect((await start({ sandbox_dirs: '["../home"]' })).res, 400, 'invalid_request', 'path instead of name');
  await expect((await start({ scopes: '["identity.read"]', sandbox_dirs: '["journal"]' })).res, 400, 'invalid_request', 'dirs without scope');
  const flow = await start({ sandbox_dirs: '["journal"]' });
  assert.ok(flow.html.includes(`<code>${R}journal/</code>`), 'consent lists the full folder path');
  assert.match(flow.html, /wakes your BayLeaf Sandbox, and creates one if you have none/);
  assert.match(flow.html, /read any file in these folders/);
  assert.match(flow.html, /create or overwrite files there/);
  const form = new URLSearchParams({ request: flow.id, approval: flow.approval, decision: 'approve' });
  const approved = await worker.fetch(API + '/grants/authorize', { method: 'POST', redirect: 'manual', body: form,
    headers: { Cookie: flow.cookie, 'X-Test-Origin': API, 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(approved.status, 303, await approved.clone().text());
  const code = new URL(approved.headers.get('Location')).searchParams.get('code');
  const visitor = await expect(await call(null, 'POST', '/grants/token', { body: { grant_type: 'authorization_code', code,
    client_id: flow.client_id, redirect_uri, code_verifier: flow.verifier } }), 200, null, 'exchange');
  assert.deepEqual([visitor.scopes, visitor.sandbox_dirs], [[...READ, ...WRITE], ['journal']]);
  await expect(await call(visitor.access_token, 'PUT', F + 'journal/v.txt', { raw: 'v' }), 200, null, 'visitor write');
  assert.equal(await expect(await call(visitor.access_token, 'GET', F + 'journal/v.txt'), 200), `bytes of ${R}journal/v.txt`);
  await denied(visitor.access_token, 'GET', F + 'notes/v.txt', 'visitor unbound');
  const readOnly = await start({ scopes: JSON.stringify(READ), sandbox_dirs: '["journal"]' });
  assert.doesNotMatch(readOnly.html, /create or overwrite/, 'read-only consent claims no write');
  console.log('PASS sandbox-file consent: app-named folders shown as full paths with wake/create disclosure, initiation rejections, exchange carries binding');
} finally {
  await mf.dispose();
}
