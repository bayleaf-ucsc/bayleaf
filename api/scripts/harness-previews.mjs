#!/usr/bin/env node
/** Isolated workerd + real D1 SQL. All identities, credentials, and upstreams are synthetic. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, WebSocketPair, Response as WorkerResponse } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
let lastStage = 'preparing harness';
const stage = name => { lastStage = name; console.log(`STAGE ${name}`); };
stage(lastStage);
// Visible, bounded failure even if workerd startup or disposal stops responding.
const deadline = setTimeout(() => {
  console.error(`TIMEOUT after 90 seconds; last stage: ${lastStage}. Later stages/tests are not established.`);
  process.exit(1);
}, 90_000);
const api = 'https://api.example.test';
const key = 'synthetic_installation_key_00000000000000000000';
const oidcSecret = 'synthetic_oidc_secret_000000000000000000000000';
const upstream = 'https://5000-synthetic-bearer.preview.example.test';
const appPassword = 'synthetic app password';
const appToken = 'nbwt_synthetic_application_token_000000000000000';
const bindings = {
  PREVIEWS_ENABLED: 'true', PREVIEWS_API_ORIGIN: api,
  PREVIEWS_DOMAIN: 'previews.example.test', PREVIEWS_SECRET: Buffer.alloc(32, 7).toString('base64'),
  PREVIEWS_INSTALLATION_KEY: key, PREVIEWS_UPSTREAM_SUFFIXES: '.preview.example.test',
  ALLOWED_EMAIL_DOMAIN: 'example.test', OIDC_CLIENT_SECRET: oidcSecret,
  DAYTONA_API_URL: 'https://daytona.example.test/api', DAYTONA_API_KEY: 'synthetic-daytona-key',
  DAYTONA_DEPLOYMENT_LABEL: 'synthetic-chat', CAMPUS_IP_RANGES: '192.0.2.0/24',
};
// Node rewrites Sec-Fetch-Mode; Miniflare rejects nonlocal Origin headers before
// dispatch. Restore these simulated browser inputs in a TEST-ONLY entrypoint,
// so it is the real gateway, not the harness transport, that must reject them.
stage('bundling Worker');
const bundled = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  export { PreviewConnections } from './src/index.ts';
  // An outboundService exception is rendered as HTTP 500 by Miniflare, not a
  // fetch rejection. Inject a transport rejection at the Worker fetch boundary.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/transport-failure') throw new Error('synthetic transport failure ' + url.origin);
    // Real workerd sockets: enqueue server-first frames before the handshake
    // returns, as Nanobot does. An echo-only fixture cannot catch greeting loss.
    if (url.pathname === '/initial-greeting') {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('message', event => pair[1].send(event.data));
      pair[1].addEventListener('close', () => { try { pair[1].close(); } catch {} });
      pair[1].send('ready');
      pair[1].send(new Uint8Array([0, 127, 255]));
      pair[1].send('greeting complete');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return realFetch(input, init);
  };
  export default { ...app, async fetch(request, env, ctx) {
    const headers = new Headers(request.headers);
    const advance = Number(headers.get('X-Harness-Advance-Seconds') || 0) * 1000;
    headers.delete('X-Harness-Advance-Seconds');
    for (const [wire, actual] of [['X-Harness-Fetch-Mode', 'Sec-Fetch-Mode'],
      ['X-Harness-Origin', 'Origin'], ['X-Harness-Forwarded-Host', 'X-Forwarded-Host']]) {
      const value = headers.get(wire);
      if (value) headers.set(actual, value);
      headers.delete(wire);
    }
    const realNow = Date.now;
    if (advance) Date.now = () => realNow() + advance;
    try { return await app.fetch(new Request(request, { headers }), env, ctx); }
    finally { Date.now = realNow; }
  } };
` }, bundle: true,
  write: false, format: 'esm', platform: 'browser', target: 'es2022', loader: { '.py': 'text', '.md': 'text' } });
let lastUpstream = null;
let outboundCalls = 0;
let sandboxState = 'started';
let handshakeRecheck = null;
let rejectedUpstreamClose = null;
const options = { workers: [{ name: 'preview-harness', modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: '2025-01-31', compatibilityFlags: ['nodejs_compat'],
  bindings, d1Databases: ['DB'],
  durableObjects: { PREVIEW_CONNECTIONS: { className: 'PreviewConnections', useSQLite: true } },
  outboundService: async request => {
    outboundCalls++;
    const u = new URL(request.url);
    if (u.hostname === 'daytona.example.test') {
      assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-daytona-key');
      if (u.pathname.endsWith('/signed-preview-url')) {
        assert.equal(u.searchParams.get('expiresInSeconds'), '86400');
        return Response.json({ url: upstream + '/' });
      }
      return Response.json({ id: 'owner-sandbox', state: sandboxState });
    }
    assert.equal(u.origin, upstream);
    lastUpstream = { url: u.href, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() };
    if (u.pathname === '/webui/bootstrap') {
      if (request.headers.get('X-Nanobot-Auth') === appPassword) return Response.json({ api_token: appToken });
      return new Response(upstream, { status: 401, headers: {
        'WWW-Authenticate': 'Bearer realm="' + upstream + '"', 'Location': upstream,
        'Set-Cookie': 'debug=' + upstream, 'Content-Type': 'application/json', 'X-Debug': upstream,
      } });
    }
    if (u.pathname === '/webui/api') return new Response('app API', {
      status: request.headers.get('Authorization') === `Bearer ${appToken}` ? 200 : 403,
    });
    if (u.pathname === '/status') return new Response(upstream, {
      status: Number(u.searchParams.get('code')), headers: {
        'Retry-After': u.searchParams.get('retry') ?? '120', 'Location': upstream,
        'ETag': '"' + new URL(upstream).hostname + '"', 'Last-Modified': upstream,
        'WWW-Authenticate': 'Bearer realm="' + upstream + '"',
        'Set-Cookie': 'debug=' + upstream, 'X-Debug': upstream,
      },
    });
    if (u.pathname === '/conditional') return new Response(null, { status: 304, headers: {
      ETag: u.searchParams.has('unsafe') ? '"' + new URL(upstream).hostname + '"' : 'W/"fixture-v1"',
      'Last-Modified': 'Thu, 08 Oct 2026 00:00:00 GMT',
      ...(u.searchParams.has('location') ? { Location: upstream } : {}),
      'Set-Cookie': 'debug=' + upstream, 'X-Debug': upstream,
    } });
    if (u.pathname === '/validators') return new Response('validated content', { headers: {
      ETag: u.searchParams.get('etag') ?? '"fixture-v1"',
      'Last-Modified': u.searchParams.get('modified') ?? 'Thu, 08 Oct 2026 00:00:00 GMT',
    } });
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('message', event => pair[1].send(event.data));
      pair[1].addEventListener('close', () => { try { pair[1].close(); } catch {} });
      if (u.pathname === '/rejected-handshake') {
        rejectedUpstreamClose = event(pair[1], 'close', 2000);
        if (handshakeRecheck) await handshakeRecheck();
      }
      return new WorkerResponse(null, { status: 101, webSocket: pair[0], headers: {
        'Sec-WebSocket-Protocol': u.searchParams.has('invalid-protocol') ? 'unoffered' : 'echo',
      } });
    }
    if (u.pathname === '/cookie-path') return new Response('cookies', { headers: {
      'Set-Cookie': 'scoped=ok; Domain=.example.test; Path=/private; Max-Age=600',
    } });
    if (u.pathname === '/cookie-attack') return new Response('cookies', { headers: {
      'Set-Cookie': '__Host-bl-preview-session=forged; Path=/; Secure; HttpOnly',
    } });
    if (u.pathname === '/sw.js') return new Response('self.addEventListener("fetch", () => {});', { headers: {
      'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/',
    } });
    if (u.pathname === '/redirect') return new Response('do not forward ' + upstream, {
      status: 302, headers: { Location: upstream + '/next?ok=1', 'Set-Cookie': 'upstream-secret=yes' },
    });
    if (u.pathname === '/public-redirect') return new Response(null, { status: 302,
      headers: { Location: 'https://' + request.headers.get('X-Forwarded-Host') + '/next?ok=1' } });
    if (u.pathname === '/escape') return new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } });
    if (u.pathname === '/error') return new Response(upstream, { status: 500, headers: { 'X-Debug': upstream } });
    return new Response('synthetic service', { headers: {
      'Content-Type': 'text/plain', 'Set-Cookie': 'app-secret=yes; Domain=.example.test',
      'Access-Control-Allow-Origin': '*', 'Refresh': '0;url=' + upstream,
      'Link': '<' + upstream + '>; rel=preload', 'X-Debug': upstream,
    } });
  },
}] };
stage('starting isolated workerd');
const mf = new Miniflare(convertV4MiniflareOptions(options));
const dispatch = async (url, init = {}) => {
  const headers = new Headers(init.headers);
  for (const [actual, wire] of [['Origin', 'X-Harness-Origin'], ['X-Forwarded-Host', 'X-Harness-Forwarded-Host']]) {
    if (headers.has(actual)) { headers.set(wire, headers.get(actual)); headers.delete(actual); }
  }
  return (await mf.getWorker()).fetch(url, { ...init, headers });
};

function jwt(payload, secret = oidcSecret) {
  const data = [ { alg: 'HS256', typ: 'JWT' }, payload ].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}
function browser(email) {
  const cookies = new Map();
  if (email) cookies.set(new URL(api).host, new Map([['bayleaf_session', jwt({ email, name: 'Synthetic', exp: Math.floor(Date.now() / 1000) + 3600 })]]));
  return {
    cookies,
    async visit(url, options = {}) {
      const host = new URL(url).host;
      const headers = new Headers({ 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', ...options.headers });
      headers.set('X-Harness-Fetch-Mode', headers.get('Sec-Fetch-Mode'));
      const jar = cookies.get(host) ?? new Map();
      if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const response = await dispatch(url, { ...options, headers, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const [name, ...value] = cookie.split(';')[0].split('=');
        if (name.startsWith('__Host-')) {
          assert.match(cookie, /; Secure/i); assert.match(cookie, /; HttpOnly/i);
          assert.match(cookie, /; Path=\//i); assert.doesNotMatch(cookie, /; Domain=/i);
        }
        if (/Max-Age=0/i.test(cookie) || !value.join('=')) jar.delete(name);
        else jar.set(name, value.join('='));
      }
      cookies.set(host, jar);
      return response;
    },
  };
}
async function next(client, url) {
  const response = await client.visit(url);
  assert.equal(response.status, 302, `${url}: ${response.status} ${await response.clone().text()}`);
  return new URL(response.headers.get('Location'), url).href;
}
const input = () => ({ owner: { subject: 'owui-owner', email: 'owner@example.test' },
  upstream_url: upstream + '/', access: 'private' });
async function register(overrides = {}, credential = key) {
  return dispatch(api + '/previews/registrations', { method: 'POST', headers: {
    Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ ...input(), ...overrides }) });
}
async function revoke(url) {
  const label = new URL(url).hostname.split('.')[0];
  return dispatch(api + `/previews/registrations/${label}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${key}` },
  });
}
async function login(client, url) {
  let current = url;
  for (let i = 0; i < 6; i++) current = await next(client, current);
  assert.equal(current, url);
  const response = await client.visit(current);
  assert.equal(response.status, 200);
  return response;
}
let checks = 0;
async function check(name, fn) { stage(`check: ${name}`); await fn(); checks++; console.log(`PASS ${name}`); }
function event(socket, name, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket ${name} timeout`)), timeout);
    socket.addEventListener(name, value => { clearTimeout(timer); resolve(value); }, { once: true });
  });
}
async function connect(client, url) {
  const response = await client.visit(url + 'socket', { headers: { Upgrade: 'websocket', Origin: new URL(url).origin,
    'Sec-WebSocket-Protocol': 'echo', 'Sec-Fetch-Mode': 'websocket', 'Sec-Fetch-Dest': 'empty' } });
  assert.equal(response.status, 101, response.status === 101 ? '' : await response.text());
  assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'echo');
  response.webSocket.accept();
  return response.webSocket;
}

try {
  stage('awaiting local D1 handle');
  const db = await mf.getD1Database('DB');
  stage('local D1 handle obtained');
  for (const file of (await readdir(root + 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    stage(`applying fixture migration ${file}`);
    if (file === '0008_preview_cruzid_names.sql') {
      await db.prepare('INSERT INTO preview_owners(email,slug) VALUES (?,?)')
        .bind('owner@example.test', 'owner-legacy-digest').run();
    }
    if (file === '0010_preview_access_policy.sql') {
      await db.prepare('INSERT INTO preview_owners(email,slug) VALUES (?,?)').bind('legacy@example.test', 'legacy').run();
      await db.prepare(`INSERT INTO preview_registrations
        (hostname,email,deployment,slot,generation,upstream_encrypted,expires_at)
        VALUES (?,?,?,?,?,?,?)`).bind('legacy.previews.example.test', 'legacy@example.test', 'lathe',
          '5000', 'legacy-generation', 'legacy-ciphertext', Math.floor(Date.now() / 1000) + 3600).run();
    }
    const sql = (await readFile(root + 'migrations/' + file, 'utf8')).replace(/^\s*--.*$/gm, '');
    const statements = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) : sql.split(';');
    for (const statement of statements.map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    if (file === '0010_preview_access_policy.sql') {
      assert.equal((await db.prepare('SELECT access FROM preview_registrations WHERE hostname=?')
        .bind('legacy.previews.example.test').first()).access, 'private');
      await db.prepare('DELETE FROM preview_registrations WHERE hostname=?').bind('legacy.previews.example.test').run();
      await db.prepare('DELETE FROM preview_invalidations WHERE hostname=?').bind('legacy.previews.example.test').run();
      await db.prepare('DELETE FROM preview_owners WHERE email=?').bind('legacy@example.test').run();
    }
  }
  assert.equal((await db.prepare('SELECT slug FROM preview_owners WHERE email=?')
    .bind('owner@example.test').first()).slug, 'owner');
  for (const [email, token, sandbox] of [
    ['owner@example.test', 'sk-bayleaf-owner', 'owner-sandbox'],
    ['other@example.test', 'sk-bayleaf-other', 'other-sandbox'],
  ]) await db.prepare('INSERT INTO user_keys(email,bayleaf_token,daytona_sandbox_id) VALUES (?,?,?)').bind(email, token, sandbox).run();

  await check('installation authentication rejects anonymous, user keys, bad and truncated keys before parsing', async () => {
    for (const credential of ['', 'sk-bayleaf-owner', key + 'x', key.slice(0, -1)]) assert.equal((await register({}, credential)).status, 401);
    const malformed = await dispatch(api + '/previews/registrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 401);
    const authenticatedMalformed = await dispatch(api + '/previews/registrations', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: '{"upstream_headers":{"secret-name":"secret-value"},' });
    assert.equal(authenticatedMalformed.status, 400);
    assert.doesNotMatch(await authenticatedMalformed.text(), /secret-name|secret-value/);
  });
  let url;
  await check('private registration returns only a wrapped URL and stores encrypted upstream', async () => {
    const response = await register();
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json(); url = data.url;
    assert.deepEqual(Object.keys(data).sort(), ['expires_at', 'url']);
    const ttl = (Date.parse(data.expires_at) - Date.now()) / 1000;
    assert.ok(ttl > 86390 && ttl <= 86400, 'registration defaults to 24 hours');
    assert.match(url, /^https:\/\/owner-private-[a-f0-9]{24}\.previews\.example\.test\/$/);
    assert.ok(!JSON.stringify(data).includes('synthetic-bearer'));
    const row = await db.prepare('SELECT * FROM preview_registrations').first();
    assert.ok(!JSON.stringify(row).includes('synthetic-bearer'));
  });
  await check('public registration serves directly while private registration requires owner login', async () => {
    const response = await register({ access: 'public', tag: 'demo' });
    assert.equal(response.status, 200, await response.clone().text());
    const publicUrl = (await response.json()).url;
    assert.match(publicUrl, /^https:\/\/owner-public-[a-f0-9]{24}\.previews\.example\.test\/$/);
    const served = await dispatch(publicUrl);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), 'synthetic service');
    assert.equal((await dispatch(publicUrl + '__preview/start')).status, 404);
    assert.equal((await dispatch(url)).status, 401);
  });
  await check('legacy shapes, destination, owner, and access policy fail closed', async () => {
    const before = outboundCalls;
    for (const upstream_url of ['http://x.preview.example.test/', 'https://preview.example.test/',
      'https://x.preview.example.test.evil.test/', 'https://x.preview.example.test:444/',
      'https://user:pass@x.preview.example.test/', 'https://x.preview.example.test/path',
      'https://x.preview.example.test/?token=x', 'https://127.0.0.1/', 'https://localhost/']) {
      assert.equal((await register({ upstream_url })).status, 403, upstream_url);
    }
    assert.equal((await register({ owner: { subject: 'bad', email: 'owner@evil.test' } })).status, 403);
    for (const email of ['owner+alias@example.test', 'ow.ner@example.test', 'a'.repeat(60) + '@example.test']) {
      assert.equal((await register({ owner: { subject: 'invalid-name', email } })).status, 403);
    }
    for (const legacy of [{ slot: '5000' }, { requested_access: 'private' }, { expires_at: '2020-01-01T00:00:00Z' }]) {
      assert.equal((await register(legacy)).status, 400);
    }
    for (const access of ['', 'owner-authenticated', 'PRIVATE']) assert.equal((await register({ access })).status, 400);
    assert.equal((await register({ owner: { subject: 'owui-owner', email: 'other@example.test' } })).status, 409);
    assert.equal(outboundCalls, before);
  });
  await check('Lathe registrations are independent 24-hour leases', async () => {
    const first = await (await register()).json();
    const second = await (await register()).json();
    for (const registration of [first, second]) {
      const ttl = (Date.parse(registration.expires_at) - Date.now()) / 1000;
      assert.ok(ttl > 86390 && ttl <= 86400);
      assert.equal((await dispatch(registration.url)).status, 401);
    }
    assert.notEqual(first.url, second.url);
  });
  await check('registration size and active-preview bounds ignore expired leases', async () => {
    const oversized = await dispatch(api + '/previews/registrations', { method: 'POST', headers: {
      Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
     }, body: JSON.stringify({ ...input(), padding: 'x'.repeat(65536) }) });
    assert.equal(oversized.status, 413);
    const owner = { subject: 'cap-user', email: 'cap@example.test' };
    for (let i = 0; i < 16; i++) assert.equal((await register({ owner, tag: `p${i}` })).status, 200);
    assert.equal((await register({ owner })).status, 409);
    await db.prepare("UPDATE preview_registrations SET expires_at=0 WHERE hostname=(SELECT hostname FROM preview_registrations WHERE email='cap@example.test' LIMIT 1)").run();
    assert.equal((await register({ owner })).status, 200);
  });
  await check('concurrent Lathe registrations create independent live origins', async () => {
    const raceOwner = { subject: 'race-user', email: 'race@example.test' };
    const responses = await Promise.all(Array.from({length: 6}, () => register({ owner: raceOwner })));
    const urls = await Promise.all(responses.map(async r => { assert.equal(r.status,200); return (await r.json()).url; }));
    assert.equal(new Set(urls).size, 6);
    for (const live of urls) assert.equal((await dispatch(live)).status, 401);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM preview_registrations WHERE email=? AND expires_at>?')
      .bind(raceOwner.email, Math.floor(Date.now() / 1000)).first()).n, 6);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM preview_invalidations').first()).n, 0);
  });
  await check('preview hosts cannot reach API routes or wildcard CORS', async () => {
    for (const path of ['health', 'dashboard', 'v1/models', 'oauth/token']) {
      const response = await dispatch(url + path);
      assert.equal(response.status, 401); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
    const r = await dispatch(api + '/previews/registrations', { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  });
  const owner = browser('owner@example.test');
  await check('owner completes two-host browser binding and gets host-only session', async () => { await login(owner, url); });
  await check('upstream header validation is bounded, sanitized and independent of access', async () => {
    const invalid = [null, [], 'secret-value', { 'secret-name': 123 },
      { 'bad name': 'secret-value' }, { Good: 'secret-value\r\nHost: evil' }, { Good: 'é' },
      { 'Good\n': 'secret-value' }, { Good: 'secret-value\n' }, { Good: 'secret-value\r' },
      { Good: 'a'.repeat(4097) }, { ['a'.repeat(65)]: 'secret-value' }, { Good: 'one', good: 'two' },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['H'+i, 'secret-value'])),
      { A: 'a'.repeat(4096), B: 'b'.repeat(4096) }];
    for (const name of ['Host','Cookie','Origin','Referer','Forwarded','X-Real-IP','True-Client-IP',
      'Connection','Upgrade','Keep-Alive','TE','Trailer','Transfer-Encoding','Content-Length','Expect',
      'HTTP2-Settings','Proxy-Authorization','Proxy-Authenticate','X-Forwarded-Foo','Sec-Foo','CF-Foo',
      'Daytona-Foo','X-Daytona-Foo','X-Lathe-Foo']) invalid.push({ [name.toUpperCase()]: 'secret-value' });
    for (const access of ['private', 'public']) {
      for (const upstream_headers of invalid) {
        const response = await register({ access, upstream_headers });
        assert.equal(response.status, 400);
        assert.doesNotMatch(await response.text(), /secret-name|secret-value/);
      }
      const empty = await (await register({ access, upstream_headers: {} })).json();
      assert.equal(empty.upstream_headers_applied, undefined);
      await revoke(empty.url);
      // Inclusive total bound and value bound; escaped JSON can exceed 8 KiB.
      const bounded = await register({ access, upstream_headers: { A: '"'.repeat(4096), B: '\\'.repeat(4094) } });
      assert.equal(bounded.status, 200, await bounded.clone().text());
      const result = await bounded.json();
      assert.equal(result.upstream_headers_applied, true);
      await revoke(result.url);
    }
  });
  await check('configured HTTP/WS headers overwrite spoofing after owner/origin gates and remain encrypted', async () => {
    for (const access of ['private', 'public']) {
      const config = { 'X-Authenticated-Owner': 'configured-assertion-secret',
        Authorization: 'Basic ' + Buffer.from('app-user:app-only-password').toString('base64'),
        'X-Nanobot-Auth': 'fixed-app-password', Accept: 'application/configured' };
      const response = await register({ access, upstream_headers: config });
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(data).sort(), ['expires_at','upstream_headers_applied','url']);
      assert.equal(data.upstream_headers_applied, true);
      const hostname = new URL(data.url).hostname;
      const row = await db.prepare('SELECT * FROM preview_registrations WHERE hostname=?').bind(hostname).first();
      for (const secret of [...Object.values(config), upstream, 'X-Authenticated-Owner']) {
        assert.ok(!JSON.stringify(row).includes(secret), 'configuration and destination must not be metadata');
        assert.ok(!JSON.stringify(data).includes(secret), 'reply must not contain configuration');
      }
      const before = outboundCalls;
      if (access === 'private') {
        assert.equal((await dispatch(data.url)).status, 401);
        const other = browser('other@example.test');
        let current = data.url;
        for (let i = 0; i < 4; i++) current = await next(other, current);
        assert.equal((await other.visit(current)).status, 403);
      }
      assert.equal((await owner.visit(data.url, { headers: { Origin: 'https://evil.test' } })).status, 403);
      assert.equal(outboundCalls, before, 'denied requests must not reach app');
      const client = access === 'private' ? owner : browser();
      if (access === 'private') await login(client, data.url);
      assert.equal((await client.visit(data.url, { headers: { 'x-authenticated-owner': 'spoof',
        authorization: 'Bearer nbwt_browser', 'x-nanobot-auth': 'spoof', Accept: 'spoof',
        Connection: 'X-Authenticated-Owner, Authorization' } })).status, 200);
      for (const [name, value] of Object.entries(config)) assert.equal(lastUpstream.headers[name.toLowerCase()], value);
      assert.equal(lastUpstream.headers.connection, undefined);
      const socket = await connect(client, data.url);
      for (const [name, value] of Object.entries(config)) assert.equal(lastUpstream.headers[name.toLowerCase()], value);
      const closed = event(socket, 'close'); await revoke(data.url); await closed;
      assert.equal((await client.visit(data.url)).status, 404);
    }
  });
  await check('browser authorization still works four hours later but not beyond the registration boundary', async () => {
    const token = owner.cookies.get(new URL(url).host).get('__Host-bl-preview-session');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    assert.ok(claims.exp - Date.now() / 1000 > 4 * 3600);
    assert.equal((await owner.visit(url, { headers: { 'X-Harness-Advance-Seconds': '14400' } })).status, 200);
    assert.equal((await owner.visit(url, { headers: { 'X-Harness-Advance-Seconds': '86401' } })).status, 404);
  });
  await check('another authenticated user copying the exact URL cannot access the service', async () => {
    const other = browser('other@example.test');
    let current = url;
    for (let i = 0; i < 4; i++) current = await next(other, current);
    assert.equal((await other.visit(current)).status, 403);
    assert.ok(!other.cookies.get(new URL(url).host).has('__Host-bl-preview-session'));
  });
  await check('copied login/proof/callback URLs cannot establish a session in a different browser', async () => {
    const legitimate = browser('owner@example.test');
    let current = await next(legitimate, url); // start
    current = await next(legitimate, current); // API authorize, unbound
    // Attacker-originated unbound authorization completed by the owner cannot
    // get back past the preview proof: the owner's browser lacks the first cookie.
    const victim = browser('owner@example.test');
    const prove = await next(victim, current);
    assert.equal((await victim.visit(prove)).status, 403);
    // Initiator lacks the broker cookie, even if they complete their proof.
    const finish = await next(legitimate, prove);
    assert.equal((await legitimate.visit(finish)).status, 403);

    const proper = browser('owner@example.test');
    current = await next(proper, url);
    current = await next(proper, current);
    current = await next(proper, current); // preview prove
    assert.equal((await browser('owner@example.test').visit(current)).status, 403);
    current = await next(proper, current); // API finish
    assert.equal((await browser('owner@example.test').visit(current)).status, 403);
    current = await next(proper, current); // callback
    assert.equal((await browser('owner@example.test').visit(current)).status, 403);
    const replayCookies = new Map(proper.cookies.get(new URL(url).host));
    const responses = await Promise.all([proper.visit(current), proper.visit(current)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [302, 403]);
    proper.cookies.set(new URL(url).host, replayCookies);
    assert.equal((await proper.visit(current)).status, 403);
  });
  await check('sibling fetches, unsafe requests, and unbound WebSockets are denied', async () => {
    const before = outboundCalls;
    for (const headers of [
      { Origin: 'https://sibling.previews.example.test' },
      { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
      { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
      { Upgrade: 'websocket' },
    ]) assert.equal((await owner.visit(url, { headers })).status, 403);
    assert.equal((await owner.visit(url, { method: 'POST', body: 'bad' })).status, 403);
    assert.equal(outboundCalls, before);
  });
  await check('authenticated fresh origins support service workers without exposing reserved auth scripts', async () => {
    const headers = { 'Service-Worker':'script', 'Sec-Fetch-Site':'same-origin', 'Sec-Fetch-Mode':'same-origin', 'Sec-Fetch-Dest':'serviceworker' };
    const sw = await owner.visit(url + 'sw.js', { headers });
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('Service-Worker-Allowed'), '/');
    assert.equal((await browser().visit(url + 'sw.js', { headers })).status, 401);
    assert.equal((await owner.visit(url + '__preview/start', { headers })).status, 403);
    assert.equal((await dispatch('https://owner-5000.previews.example.test/')).status, 404);
  });
  await check('forwarding strips credentials and unsafe response headers; uploads stream', async () => {
    const response = await owner.visit(url, { method: 'POST', body: 'synthetic upload', headers: {
      Origin: new URL(url).origin, Authorization: 'Bearer sk-bayleaf-owner',
      'X-Forwarded-Host': 'evil.test', 'X-Api-Key': 'must-not-forward',
    } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(lastUpstream.body, 'synthetic upload');
    for (const name of ['authorization', 'x-api-key']) assert.equal(lastUpstream.headers[name], undefined);
    assert.equal(lastUpstream.headers.cookie, 'app-secret=yes');
    assert.equal(lastUpstream.headers['x-forwarded-host'], new URL(url).host);
    for (const name of ['Access-Control-Allow-Origin', 'Refresh', 'Link', 'X-Debug']) assert.equal(response.headers.get(name), null);
    assert.match(response.headers.get('Set-Cookie'), /^__Host-bl-app-/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(response.headers.get('Content-Security-Policy'), /worker-src 'self' blob:/);
  });
  await check('app authentication is independent of the private owner gate; login and bearer reach only the app', async () => {
    const headers = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
    const before = outboundCalls;
    for (const credentials of [{}, { 'X-Nanobot-Auth': appPassword }, { Authorization: `Bearer ${appToken}` },
      { Authorization: 'Bearer sk-bayleaf-owner' }, { Authorization: `Bearer ${key}` }]) {
      assert.equal((await browser().visit(url + 'webui/bootstrap', { headers: { ...headers, ...credentials } })).status, 401);
    }
    assert.equal(outboundCalls, before, 'no app credentials can replace the owner cookie');
    const bootstrap = await owner.visit(url + 'webui/bootstrap', { headers });
    assert.equal(bootstrap.status, 401);
    assert.equal(await bootstrap.text(), 'Preview application request failed.');
    for (const name of ['WWW-Authenticate', 'Location', 'Set-Cookie', 'X-Debug']) assert.equal(bootstrap.headers.get(name), null);
    const loggedIn = await owner.visit(url + 'webui/bootstrap', { headers: { ...headers, 'X-Nanobot-Auth': appPassword } });
    assert.equal(loggedIn.status, 200);
    assert.equal((await loggedIn.json()).api_token, appToken);
    assert.equal(lastUpstream.headers['x-nanobot-auth'], appPassword);
    const apiResponse = await owner.visit(url + 'webui/api', { headers: { ...headers, Authorization: `Bearer ${appToken}` } });
    assert.equal(apiResponse.status, 200);
    assert.equal(lastUpstream.headers.authorization, `Bearer ${appToken}`);
    assert.doesNotMatch(lastUpstream.headers.cookie ?? '', /__Host-bl-preview|bayleaf_session/);
    assert.equal((await owner.visit(url + 'webui/api', { headers })).status, 403);
    const blocked = ['sk-bayleaf-owner', 'sk-bayleaf-grant-test', 'sk-or-v1-test', 'tk_test', 'admin_test', 'campus',
      key, bindings.DAYTONA_API_KEY, oidcSecret, bindings.PREVIEWS_SECRET, new URL(upstream).hostname, 'synthetic-bearer',
      jwt({ email: 'owner@example.test', exp: 1 }),
      owner.cookies.get(new URL(url).host).get('__Host-bl-preview-session')];
    for (const credential of blocked) {
      await owner.visit(url + 'webui/api', { headers: { ...headers, Authorization: `Bearer ${credential}`, 'X-Nanobot-Auth': credential } });
      assert.equal(lastUpstream.headers.authorization, undefined, 'reserved bearer excluded');
      assert.equal(lastUpstream.headers['x-nanobot-auth'], undefined, 'reserved custom credential excluded');
    }
    for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer one, Bearer two', 'Bearer ' + 'a'.repeat(4096)]) {
      await owner.visit(url, { headers: { ...headers, Authorization: authorization } });
      assert.equal(lastUpstream.headers.authorization, undefined);
    }
    await owner.visit(url, { headers: { ...headers, Authorization: 'Bearer ' + jwt({ app: true }, 'synthetic-app-signing-secret') } });
    assert.match(lastUpstream.headers.authorization, /^Bearer /, 'non-BayLeaf app JWT remains supported');
  });
  await check('cross-origin requests cannot transmit app credentials, including navigation exceptions', async () => {
    const before = outboundCalls;
    for (const origin of ['https://evil.test', 'https://sibling.previews.example.test', 'null']) {
      for (const method of ['GET', 'POST']) {
        const response = await owner.visit(url + 'webui/bootstrap', { method, headers: {
          Origin: origin, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site',
          'X-Nanobot-Auth': appPassword, Authorization: `Bearer ${appToken}`,
        } });
        assert.equal(response.status, 403);
      }
    }
    assert.equal(outboundCalls, before);
    await owner.visit(url, { headers: { 'Sec-Fetch-Site': 'cross-site', 'X-Nanobot-Auth': appPassword, Authorization: `Bearer ${appToken}` } });
    assert.equal(lastUpstream.headers.authorization, undefined);
    assert.equal(lastUpstream.headers['x-nanobot-auth'], undefined);
    const publicUrl = (await (await register({ access: 'public' })).json()).url;
    await browser().visit(publicUrl, { headers: {
      'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe',
      'X-Nanobot-Auth': appPassword, Authorization: `Bearer ${appToken}`,
    } });
    assert.equal(lastUpstream.headers.authorization, undefined);
    assert.equal(lastUpstream.headers['x-nanobot-auth'], undefined);
    await revoke(publicUrl);
  });
  await check('HTTP app errors preserve status with fixed content; only validated retry metadata survives', async () => {
    for (const code of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
      const response = await owner.visit(url + `status?code=${code}`);
      assert.equal(response.status, code);
      assert.equal(await response.text(), 'Preview application request failed.');
      for (const name of ['Location', 'ETag', 'Last-Modified', 'WWW-Authenticate', 'Set-Cookie', 'X-Debug']) assert.equal(response.headers.get(name), null);
      assert.equal(response.headers.get('Retry-After'), [429, 503].includes(code) ? '120' : null);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.ok(!JSON.stringify([...response.headers]).includes('synthetic-bearer'));
    }
    for (const retry of [upstream, 'tomorrow', '-1', '12345678901']) {
      const response = await owner.visit(url + 'status?code=429&retry=' + encodeURIComponent(retry));
      assert.equal(response.headers.get('Retry-After'), null);
    }
    const date = 'Thu, 08 Oct 2026 00:00:00 GMT';
    assert.equal((await owner.visit(url + 'status?code=503&retry=' + encodeURIComponent(date))).headers.get('Retry-After'), date);
    const head = await owner.visit(url + 'status?code=401', { method: 'HEAD' });
    assert.equal(head.status, 401); assert.equal(await head.text(), '');
    const transport = await owner.visit(url + 'transport-failure');
    assert.equal(transport.status, 502); assert.ok(!(await transport.text()).includes('synthetic-bearer'));
  });
  await check('304 is bodyless, not a redirect; conditional validators remain bounded and uncached', async () => {
    const response = await owner.visit(url + 'conditional', { headers: {
      'If-None-Match': 'W/"fixture-v1"', 'If-Modified-Since': 'Thu, 08 Oct 2026 00:00:00 GMT',
    } });
    assert.equal(response.status, 304); assert.equal(await response.text(), '');
    assert.equal(lastUpstream.headers['if-none-match'], 'W/"fixture-v1"');
    assert.equal(lastUpstream.headers['if-modified-since'], 'Thu, 08 Oct 2026 00:00:00 GMT');
    assert.equal(response.headers.get('ETag'), 'W/"fixture-v1"');
    assert.equal(response.headers.get('Last-Modified'), 'Thu, 08 Oct 2026 00:00:00 GMT');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    for (const name of ['Location', 'Set-Cookie', 'X-Debug', 'Content-Length']) assert.equal(response.headers.get(name), null);
    assert.equal((await owner.visit(url + 'conditional?location')).headers.get('Location'), null);
    assert.equal((await owner.visit(url + 'conditional?unsafe')).headers.get('ETag'), null);
    assert.equal((await owner.visit(url + 'conditional', { method: 'HEAD' })).status, 304);
    assert.equal((await owner.visit(url + 'conditional', { method: 'POST', headers: { Origin: new URL(url).origin } })).status, 502);
    const success = await owner.visit(url + 'validators');
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('ETag'), '"fixture-v1"');
    assert.equal(success.headers.get('Last-Modified'), 'Thu, 08 Oct 2026 00:00:00 GMT');
    assert.equal(success.headers.get('Cache-Control'), 'no-store');
    for (const etag of ['"' + upstream + '"', '"' + new URL(upstream).hostname + '"', '"' + 'a'.repeat(257) + '"']) {
      const invalid = await owner.visit(url + 'validators?etag=' + encodeURIComponent(etag) + '&modified=' + encodeURIComponent(upstream));
      assert.equal(invalid.headers.get('ETag'), null);
      assert.equal(invalid.headers.get('Last-Modified'), null);
    }
  });
  await check('application cookies preserve paths, cannot cross hosts, and cannot overwrite gateway credentials', async () => {
    await owner.visit(url + 'cookie-path');
    await owner.visit(url + 'private/file');
    assert.match(lastUpstream.headers.cookie, /scoped=ok/);
    await owner.visit(url + 'elsewhere');
    assert.doesNotMatch(lastUpstream.headers.cookie, /scoped/);
    owner.cookies.get(new URL(url).host).set('scoped', 'sibling-injected');
    await owner.visit(url + 'private/file');
    assert.doesNotMatch(lastUpstream.headers.cookie, /sibling-injected|__Host-bl-preview/);
    const original = owner.cookies.get(new URL(url).host).get('__Host-bl-preview-session');
    const attack = await owner.visit(url + 'cookie-attack');
    assert.equal(attack.headers.get('Set-Cookie'), null);
    assert.equal(owner.cookies.get(new URL(url).host).get('__Host-bl-preview-session'), original);
  });
  await check('server-first WebSocket greetings survive authorization recheck in order', async () => {
    for (const access of ['public', 'private']) {
      const data = await (await register({ access })).json();
      const client = browser(access === 'private' ? 'owner@example.test' : undefined);
      if (access === 'private') await login(client, data.url);
      const response = await client.visit(data.url + 'initial-greeting', { headers: {
        Upgrade: 'websocket', Origin: new URL(data.url).origin,
        'Sec-Fetch-Mode': 'websocket', 'Sec-Fetch-Dest': 'empty',
      } });
      assert.equal(response.status, 101);
      const socket = response.webSocket;
      const received = [];
      const greetings = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${access}: initial greeting lost`)), 2000);
        socket.addEventListener('message', event => {
          received.push(typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data)]);
          if (received.length === 3) { clearTimeout(timer); resolve(); }
        });
      });
      // Attach before accept on the test client too, so it cannot lose frames.
      socket.accept();
      try {
        await greetings;
        assert.deepEqual(received, ['ready', [0, 127, 255], 'greeting complete']);
        const reply = event(socket, 'message');
        socket.send('after greeting');
        assert.equal((await reply).data, 'after greeting');
        assert.deepEqual(received, ['ready', [0, 127, 255], 'greeting complete', 'after greeting']);
      } finally {
        socket.close();
        await revoke(data.url);
      }
    }
  });
  await check('rejected post-upgrade handshakes close their upstream sockets', async () => {
    for (const reason of ['generation', 'expiry', 'deleted', 'protocol']) {
      const data = await (await register({ access: 'public' })).json();
      const hostname = new URL(data.url).hostname;
      handshakeRecheck = reason === 'protocol' ? null : async () => {
        const sql = reason === 'generation'
          ? "UPDATE preview_registrations SET generation='replaced' WHERE hostname=?"
          : reason === 'expiry'
            ? 'UPDATE preview_registrations SET expires_at=0 WHERE hostname=?'
            : 'DELETE FROM preview_registrations WHERE hostname=?';
        await db.prepare(sql).bind(hostname).run();
      };
      try {
        const response = await browser().visit(data.url + 'rejected-handshake' +
          (reason === 'protocol' ? '?invalid-protocol' : ''), { headers: {
            Upgrade: 'websocket', Origin: new URL(data.url).origin,
            'Sec-WebSocket-Protocol': 'echo', 'Sec-Fetch-Mode': 'websocket', 'Sec-Fetch-Dest': 'empty',
          } });
        assert.equal(response.status, reason === 'protocol' ? 502 : 403, reason);
        assert.equal(response.webSocket, null);
        assert.ok(rejectedUpstreamClose, 'fixture must receive the upstream upgrade');
        assert.equal((await rejectedUpstreamClose).code, 1008, reason);
      } finally {
        handshakeRecheck = null;
        rejectedUpstreamClose = null;
        await revoke(data.url);
      }
    }
  });
  await check('authenticated WebSockets relay text and binary, reconnect, and close on revocation', async () => {
    let socket = await connect(owner, url);
    let received = event(socket, 'message'); socket.send('hello');
    assert.equal((await received).data, 'hello');
    received = event(socket, 'message'); socket.send(new Uint8Array([1, 2, 3]).buffer);
    assert.deepEqual([...new Uint8Array((await received).data)], [1, 2, 3]);
    await new Promise(resolve => setTimeout(resolve, 11000));
    received = event(socket, 'message'); socket.send('past-handshake-deadline');
    assert.equal((await received).data, 'past-handshake-deadline');
    socket.close(1000);
    socket = await connect(owner, url);
    const closed = event(socket, 'close');
    assert.equal((await revoke(url)).status, 204);
    assert.equal((await closed).code, 1008);
    assert.equal((await owner.visit(url)).status, 404);
    const oldToken = owner.cookies.get(new URL(url).host).get('__Host-bl-preview-session');
    const oldUrl = url;
    const replacement = await register();
    assert.equal(replacement.status, 200);
    url = (await replacement.json()).url;
    assert.notEqual(url, oldUrl);
    owner.cookies.set(new URL(url).host, new Map([['__Host-bl-preview-session', oldToken]]));
    assert.equal((await owner.visit(url)).status, 302);
    await login(owner, url);
  });
  await check('Durable Object alarm closes an idle WebSocket at registration expiry', async () => {
    const registered = await register();
    assert.equal(registered.status, 200);
    const shortUrl = (await registered.json()).url;
    await db.prepare('UPDATE preview_registrations SET expires_at=? WHERE hostname=?')
      .bind(Math.floor(Date.now() / 1000) + 9, new URL(shortUrl).hostname).run();
    const client = browser('owner@example.test');
    await login(client, shortUrl);
    const socket = await connect(client, shortUrl);
    assert.equal((await event(socket, 'close')).code, 1008);
  });
  await check('WebSocket also respects a shorter browser grant, including legacy sessions', async () => {
    const client = browser('owner@example.test');
    const token = owner.cookies.get(new URL(url).host).get('__Host-bl-preview-session');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    client.cookies.set(new URL(url).host, new Map([['__Host-bl-preview-session',
      jwt({ ...claims, exp: Math.floor(Date.now() / 1000) + 9 }, bindings.PREVIEWS_SECRET)]]));
    const socket = await connect(client, url);
    assert.equal((await event(socket, 'close')).code, 1008);
    assert.equal((await owner.visit(url)).status, 200);
  });
  await check('redirects stay wrapped; external redirects and upstream errors reveal no bearer URL', async () => {
    const response = await owner.visit(url + 'redirect');
    assert.equal(response.status, 302); assert.equal(response.headers.get('Location'), url + 'next?ok=1');
    assert.equal(await response.text(), '');
    const publicRedirect = await owner.visit(url + 'public-redirect');
    assert.equal(publicRedirect.status, 302);
    assert.equal(publicRedirect.headers.get('Location'), url + 'next?ok=1');
    for (const path of ['escape', 'error']) {
      const r = await owner.visit(url + path);
      assert.equal(r.status, path === 'error' ? 500 : 502); assert.ok(!(await r.text()).includes('synthetic-bearer'));
    }
    assert.equal((await owner.visit(url + '__preview/unknown')).status, 403);
    const before = outboundCalls;
    for (const path of ['__preview', '%5f%5fpreview/start', '__preview%2fstart']) {
      assert.equal((await owner.visit(url + path)).status, 404);
    }
    assert.equal(outboundCalls, before);
  });
  await check('keyed expose rejects installation credentials, cookies, and Campus Pass', async () => {
    const before = outboundCalls;
    for (const headers of [ { Authorization: `Bearer ${key}` }, {}, { 'CF-Connecting-IP': '192.0.2.1' } ]) {
      const r = await dispatch(api + '/sandbox/expose', { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"port":5000}' });
      assert.ok([401, 403].includes(r.status));
    }
    assert.equal(outboundCalls, before);
    const spoof = await dispatch(api + '/sandbox/expose', { method: 'POST', headers: {
      Authorization: 'Bearer sk-bayleaf-other', 'Content-Type': 'application/json',
    }, body: '{"port":5000,"owner":{"email":"owner@example.test"}}' });
    assert.equal(spoof.status, 400);
  });
  await check('keyed expose keeps port-based replacement without replacing Lathe leases', async () => {
    const r = await dispatch(api + '/sandbox/expose', { method: 'POST', headers: {
      Authorization: 'Bearer sk-bayleaf-owner', 'Content-Type': 'application/json',
    }, body: '{"port":5000}' });
    assert.equal(r.status, 200, await r.clone().text());
    const fresh = (await r.json()).url;
    assert.notEqual(fresh, url);
    assert.equal((await owner.visit(url)).status, 200);
    url = fresh;
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM preview_registrations WHERE email=? AND slot=?')
      .bind('owner@example.test','5000').first()).n, 1);
    await login(owner, url);
    const renewed = await dispatch(api + '/sandbox/expose', { method: 'POST', headers: {
      Authorization: 'Bearer sk-bayleaf-owner', 'Content-Type': 'application/json',
    }, body: '{"port":5000}' });
    assert.equal(renewed.status, 200);
    const renewedUrl = (await renewed.json()).url;
    assert.equal((await owner.visit(url)).status, 404);
    url = renewedUrl;
    await login(owner, url);
    sandboxState = 'stopped';
    const stopped = await dispatch(api + '/sandbox/expose', { method: 'POST', headers: {
      Authorization: 'Bearer sk-bayleaf-owner', 'Content-Type': 'application/json',
    }, body: '{"port":5000}' });
    assert.equal(stopped.status, 409); sandboxState = 'started';
  });
  await check('keyed exposure supports explicit public access but reserves the browser port', async () => {
    const headers={Authorization:'Bearer sk-bayleaf-owner','Content-Type':'application/json'};
    const exposed=await dispatch(api+'/sandbox/expose',{method:'POST',headers,body:JSON.stringify({port:5001,access:'public'})});
    assert.equal(exposed.status,200);
    assert.equal((await dispatch((await exposed.json()).url)).status,200);
    const reserved=await dispatch(api+'/sandbox/expose',{method:'POST',headers,body:JSON.stringify({port:3100,access:'public'})});
    assert.equal(reserved.status,400);
    await dispatch(api+'/sandbox/expose/5001',{method:'DELETE',headers});
  });
  await check('keyed headers replace/remove atomically, close old sockets, expire and reject platform credentials', async () => {
    const headers = { Authorization: 'Bearer sk-bayleaf-owner', 'Content-Type': 'application/json' };
    const expose = body => dispatch(api + '/sandbox/expose', { method: 'POST', headers,
      body: JSON.stringify({ port: 5002, access: 'public', ...body }) });
    const config = { 'X-App-Assertion': 'keyed-application-secret' };
    const first = await (await expose({ upstream_headers: config })).json();
    assert.equal(first.upstream_headers_applied, true);
    assert.equal((await dispatch(first.url)).status, 200);
    assert.equal(lastUpstream.headers['x-app-assertion'], config['X-App-Assertion']);
    const socket = await connect(browser(), first.url);
    const closed = event(socket, 'close');
    const second = await (await expose({ upstream_headers: { 'X-App-Assertion': 'replacement-secret' } })).json();
    await closed;
    assert.equal((await dispatch(first.url)).status, 404);
    assert.equal((await dispatch(second.url)).status, 200);
    assert.equal(lastUpstream.headers['x-app-assertion'], 'replacement-secret');
    const third = await (await expose({})).json();
    assert.equal(third.upstream_headers_applied, undefined);
    assert.equal((await dispatch(second.url)).status, 404);
    assert.equal((await dispatch(third.url)).status, 200);
    assert.equal(lastUpstream.headers['x-app-assertion'], undefined);
    for (const credential of ['sk-bayleaf-owner', key, bindings.DAYTONA_API_KEY,
      new URL(upstream).hostname, 'synthetic-bearer', jwt({ exp: 1 }) + '=']) {
      for (const value of [credential, 'Basic ' + Buffer.from('app:' + credential).toString('base64'),
        ' Bearer ' + credential + ' ', ' Basic ' + Buffer.from('app:' + credential).toString('base64') + ' ']) {
        const response = await expose({ upstream_headers: { 'X-App-Auth': value } });
        assert.equal(response.status, 403);
        assert.ok(!(await response.text()).includes(credential));
        const installation = await register({ upstream_headers: { 'X-App-Auth': value } });
        assert.equal(installation.status, 403);
      }
    }
    assert.equal((await dispatch(third.url)).status, 200, 'rejected replacement preserves existing lease');
    const invalid = await expose({ upstream_headers: { 'secret-name': 42 } });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(await invalid.text(), /secret-name/);
    const malformed = await dispatch(api + '/sandbox/expose', { method: 'POST', headers,
      body: '{"upstream_headers":{"secret-name":"secret-value"},' });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /secret-name|secret-value/);
    const anonymousMalformed = await dispatch(api + '/sandbox/expose', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(anonymousMalformed.status, 401);
    const oversized = await expose({ upstream_headers: { A: 'x'.repeat(65536) } });
    assert.equal(oversized.status, 413);
    const final = await (await expose({ upstream_headers: config })).json();
    assert.equal((await dispatch(final.url, { headers: { 'X-Harness-Advance-Seconds': '86401' } })).status, 404);
    await dispatch(api + '/sandbox/expose/5002', { method: 'DELETE', headers });
  });
  await check('revocation is scoped to the caller; registration replacement cannot revive old sessions', async () => {
    assert.equal((await dispatch(api + '/sandbox/expose/5000', { method: 'DELETE', headers: { Authorization: 'Bearer sk-bayleaf-other' } })).status, 204);
    assert.equal((await owner.visit(url)).status, 200);
    const socket = await connect(owner, url);
    const closed = event(socket, 'close');
    assert.equal((await dispatch(api + '/sandbox/expose/5000', { method: 'DELETE', headers: { Authorization: 'Bearer sk-bayleaf-owner' } })).status, 204);
    assert.equal((await closed).code, 1008);
    assert.equal((await owner.visit(url)).status, 404);
    const replacement = await register();
    const fresh = (await replacement.json()).url;
    assert.notEqual(fresh, url);
    assert.equal((await owner.visit(url)).status, 404);
    url = fresh;
  });
  await check('expiry blocks sessions and scheduled cleanup removes credentials and transactions', async () => {
    await login(owner, url);
    await db.prepare('UPDATE preview_registrations SET expires_at=0').run();
    await db.prepare('UPDATE preview_flows SET expires_at=0').run();
    assert.equal((await owner.visit(url)).status, 404);
    // Exercise the production handler, not a duplicate cleanup implementation.
    const worker = await mf.getWorker();
    await worker.scheduled({ cron: '0 * * * *' });
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM preview_registrations').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM preview_flows').first()).n, 0);
    assert.ok((await db.prepare('SELECT COUNT(*) AS n FROM preview_owners').first()).n > 0);
  });
  await check('missing installation secret and disabled gateway fail closed', async () => {
    await mf.setOptions(convertV4MiniflareOptions({ ...options, workers: [{ ...options.workers[0],
      bindings: { ...bindings, PREVIEWS_INSTALLATION_KEY: '' },
    }] }));
    assert.equal((await register()).status, 401);
    assert.equal((await dispatch(api + '/previews/registrations/owner-5000', { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } })).status, 401);
    await mf.setOptions(convertV4MiniflareOptions({ ...options, workers: [{ ...options.workers[0],
      bindings: { ...bindings, PREVIEWS_ENABLED: 'false' },
    }] }));
    assert.equal((await register()).status, 503);
    assert.equal((await dispatch(url)).status, 503);
    assert.equal((await dispatch(api + '/sandbox/expose', { method: 'POST', headers: {
      Authorization: 'Bearer sk-bayleaf-owner', 'Content-Type': 'application/json',
    }, body: '{"port":5000}' })).status, 503);
    assert.equal((await dispatch(api + '/health')).status, 200);
  });
  console.log(`${checks} security checks passed (synthetic workerd/D1; no live browser or Daytona qualification).`);
} finally {
  stage('disposing isolated workerd');
  await mf.dispose();
  clearTimeout(deadline);
}
