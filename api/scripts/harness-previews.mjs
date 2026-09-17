#!/usr/bin/env node
/** Isolated workerd + real D1 SQL. All identities, credentials, and upstreams are synthetic. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, WebSocketPair, Response as WorkerResponse } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const api = 'https://api.example.test';
const key = 'synthetic_installation_key_00000000000000000000';
const oidcSecret = 'synthetic_oidc_secret_000000000000000000000000';
const upstream = 'https://5000-synthetic-bearer.preview.example.test';
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
const bundled = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  export { PreviewConnections } from './src/index.ts';
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
  write: false, format: 'esm', platform: 'browser', target: 'es2022' });
let lastUpstream = null;
let outboundCalls = 0;
let sandboxState = 'started';
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
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('message', event => pair[1].send(event.data));
      pair[1].addEventListener('close', () => { try { pair[1].close(); } catch {} });
      return new WorkerResponse(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'echo' } });
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
const input = () => ({ owner: { subject: 'owui-owner', email: 'owner@example.test' }, slot: '5000',
  upstream_url: upstream + '/' });
async function register(overrides = {}, credential = key) {
  return dispatch(api + '/previews/registrations', { method: 'POST', headers: {
    Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ ...input(), ...overrides }) });
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
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
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
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(root + 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    if (file === '0008_preview_cruzid_names.sql') {
      await db.prepare('INSERT INTO preview_owners(email,slug) VALUES (?,?)')
        .bind('owner@example.test', 'owner-legacy-digest').run();
    }
    const sql = (await readFile(root + 'migrations/' + file, 'utf8')).replace(/^\s*--.*$/gm, '');
    const statements = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) : sql.split(';');
    for (const statement of statements.map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
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
  });
  let url;
  await check('registration returns only protected URL and stores encrypted upstream', async () => {
    const response = await register();
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json(); url = data.url;
    assert.equal(data.access_mode, 'owner-authenticated');
    const ttl = (Date.parse(data.expires_at) - Date.now()) / 1000;
    assert.ok(ttl > 86390 && ttl <= 86400, 'registration defaults to 24 hours');
    assert.match(url, /^https:\/\/owner-[a-f0-9]{24}\.previews\.example\.test\/$/);
    assert.ok(!JSON.stringify(data).includes('synthetic-bearer'));
    const row = await db.prepare('SELECT * FROM preview_registrations').first();
    assert.ok(!JSON.stringify(row).includes('synthetic-bearer'));
  });
  await check('destination, owner, expiry, and initial numeric-slot policy fail closed', async () => {
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
    assert.equal((await register({ expires_at: '2020-01-01T00:00:00Z' })).status, 403);
    assert.equal((await register({ slot: 'editor' })).status, 403);
    assert.equal((await register({ owner: { subject: 'owui-owner', email: 'other@example.test' } })).status, 409);
    assert.equal(outboundCalls, 0);
  });
  await check('registration permits requested shorter retention and caps longer requests at 24 hours', async () => {
    const shortExpiry = new Date(Date.now() + 600_000).toISOString();
    const short = await (await register({ expires_at: shortExpiry })).json();
    assert.ok(Math.abs(Date.parse(short.expires_at) - Date.parse(shortExpiry)) < 1000);
    const capped = await (await register({ expires_at: new Date(Date.now() + 48 * 3600_000).toISOString() })).json();
    const ttl = (Date.parse(capped.expires_at) - Date.now()) / 1000;
    assert.ok(ttl > 86390 && ttl <= 86400);
    assert.notEqual(short.url, url);
    assert.notEqual(capped.url, short.url);
    assert.equal((await dispatch(url)).status, 404);
    assert.equal((await dispatch(short.url)).status, 404);
    url = capped.url;
  });
  await check('registration size and active-slot bounds include expired-slot replacements', async () => {
    const oversized = await dispatch(api + '/previews/registrations', { method: 'POST', headers: {
      Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ ...input(), padding: 'x'.repeat(9000) }) });
    assert.equal(oversized.status, 413);
    const owner = { subject: 'cap-user', email: 'cap@example.test' };
    for (let port = 3000; port < 3016; port++) assert.equal((await register({ owner, slot: String(port) })).status, 200);
    assert.equal((await register({ owner, slot: '3016' })).status, 409);
    await db.prepare("UPDATE preview_registrations SET expires_at=0 WHERE email='cap@example.test' AND slot='3000'").run();
    assert.equal((await register({ owner, slot: '3016' })).status, 200);
    assert.equal((await register({ owner, slot: '3000' })).status, 409);
  });
  await check('concurrent registrations leave one live origin and retire every displaced hostname', async () => {
    const responses = await Promise.all(Array.from({length: 6}, () => register()));
    const urls = await Promise.all(responses.map(async r => { assert.equal(r.status,200); return (await r.json()).url; }));
    assert.equal(new Set(urls).size, 6);
    const current = await db.prepare('SELECT hostname FROM preview_registrations WHERE email=? AND slot=?')
      .bind('owner@example.test','5000').first();
    url = `https://${current.hostname}/`;
    assert.ok(urls.includes(url));
    for (const retired of urls.filter(u => u !== url)) assert.equal((await dispatch(retired)).status, 404);
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
      Origin: new URL(url).origin, Authorization: 'Bearer must-not-forward',
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
  await check('authenticated WebSockets relay text and binary, reconnect, and close on replacement', async () => {
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
    const replaced = await register();
    assert.equal(replaced.status, 200);
    assert.equal((await closed).code, 1008);
    assert.equal((await owner.visit(url)).status, 404);
    const oldToken = owner.cookies.get(new URL(url).host).get('__Host-bl-preview-session');
    const oldUrl = url;
    url = (await replaced.json()).url;
    assert.notEqual(url, oldUrl);
    owner.cookies.set(new URL(url).host, new Map([['__Host-bl-preview-session', oldToken]]));
    assert.equal((await owner.visit(url)).status, 302);
    await login(owner, url);
  });
  await check('Durable Object alarm closes an idle WebSocket at registration expiry', async () => {
    const registered = await register({ slot: '5001', expires_at: new Date(Date.now() + 9000).toISOString() });
    assert.equal(registered.status, 200);
    const shortUrl = (await registered.json()).url;
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
      assert.equal(r.status, 502); assert.ok(!(await r.text()).includes('synthetic-bearer'));
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
  await check('keyed expose shares the canonical Chat owner/slot and invalidates the previous generation', async () => {
    const r = await dispatch(api + '/sandbox/expose', { method: 'POST', headers: {
      Authorization: 'Bearer sk-bayleaf-owner', 'Content-Type': 'application/json',
    }, body: '{"port":5000}' });
    assert.equal(r.status, 200, await r.clone().text());
    const fresh = (await r.json()).url;
    assert.notEqual(fresh, url);
    assert.equal((await owner.visit(url)).status, 404);
    url = fresh;
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM preview_registrations WHERE email=? AND slot=?')
      .bind('owner@example.test','5000').first()).n, 1);
    await login(owner, url);
    sandboxState = 'stopped';
    const stopped = await dispatch(api + '/sandbox/expose', { method: 'POST', headers: {
      Authorization: 'Bearer sk-bayleaf-owner', 'Content-Type': 'application/json',
    }, body: '{"port":5000}' });
    assert.equal(stopped.status, 409); sandboxState = 'started';
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
} finally { await mf.dispose(); }
