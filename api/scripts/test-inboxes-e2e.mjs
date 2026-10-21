#!/usr/bin/env node
/** End-to-end: real API facade + real bayleaf-inboxes Worker over a service binding, in
 * workerd with real D1/R2. Synthetic owners only. No network and no inference providers.
 * Needs `npm install` in ../inbox (postal-mime) and this package's devDependencies.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { generateVerifier } from '../../inbox/scripts/build-dkim.mjs';
import { inboxTestAssets } from './inbox-test-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const inboxRoot = fileURLToPath(new URL('../../inbox/', import.meta.url));
const bundle = async (absWorkingDir, entry, extra = {}) => (await build({ absWorkingDir, entryPoints: [entry],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers', 'node:*'], ...extra })).outputFiles[0].text;
const apiScript = await bundle(root, 'src/index.ts', { loader: { '.py': 'text', '.md': 'text' }, plugins: [inboxTestAssets] });
await generateVerifier();
const inboxScript = await bundle(inboxRoot, 'src/worker.js');

const DOMAIN = 'bayleaf-inboxes.dev', API = 'https://api.example.test';
const noNet = req => {
  const u = new URL(req.url);
  if (u.origin === 'https://oidc.example.test') {
    if (u.pathname === '/.well-known/openid-configuration') return Response.json({
      authorization_endpoint: u.origin + '/authorize', token_endpoint: u.origin + '/token', userinfo_endpoint: u.origin + '/userinfo' });
    if (u.pathname === '/token') return Response.json({ access_token: 'synthetic-oidc' });
    if (u.pathname === '/userinfo') return Response.json({ email: 'a@example.test', name: 'Synthetic A' });
  }
  throw new Error('No outbound network: ' + u.hostname);
};
const mf = new Miniflare(convertV4MiniflareOptions({ unsafeTriggerHandlers: true, workers: [
  { name: 'bayleaf-inboxes', modules: true, script: inboxScript, compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    routes: [`*.${DOMAIN}/*`], d1Databases: ['DB'], r2Buckets: ['BLOBS'], outboundService: noNet,
    ratelimits: { ACCEPT_LIMIT: { namespace_id: '9701', simple: { limit: 60, period: 60 } }, REJECT_LIMIT: { namespace_id: '9702', simple: { limit: 30, period: 60 } } },
    bindings: { INBOXES_ENABLED: 'true', EMAIL_AUTH_CREATION_ENABLED: 'true', INBOX_DOMAIN: DOMAIN } },
  { name: 'api', modules: true, script: apiScript, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
    routes: ['api.example.test/*', 'bayleaf-proxies.dev/*'], d1Databases: ['DB'], kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'], outboundService: noNet,
    serviceBindings: { INBOXES: { name: 'bayleaf-inboxes', entrypoint: 'InboxManagement' } },
     bindings: { INBOXES_ENABLED: 'true', CAMPUS_IP_RANGES: '192.0.2.0/24', PREVIEWS_ENABLED: 'true', GRANTS_ENABLED: 'false',
       PREVIEWS_API_ORIGIN: API, PREVIEWS_DOMAIN: 'bayleaf-proxies.dev', PREVIEWS_SECRET: Buffer.alloc(32).toString('base64'),
       OIDC_ISSUER: 'https://oidc.example.test', OIDC_CLIENT_ID: 'synthetic', OIDC_SCOPES: 'openid email', ALLOWED_EMAIL_DOMAIN: 'example.test',
      OIDC_CLIENT_SECRET: 'synthetic', OPENROUTER_PROVISIONING_KEY: 'synthetic', TINFOIL_ADMIN_KEY: 'synthetic' } },
] }));

const migrate = async (db, dir) => {
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(dir + file, 'utf8')).replace(/^\s*--.*$/gm, '');
    const parts = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) :
      file === '0007_email_auth.sql' ? sql.match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g) : sql.split(';');
    for (const s of parts.map(x => x.trim()).filter(Boolean)) await db.prepare(s).run();
  }
};
let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };
try {
  const proxyDiscovery = await mf.dispatchFetch('https://bayleaf-proxies.dev/llms.txt');
  ok(proxyDiscovery.status === 200 && (await proxyDiscovery.text()).includes('https://api.bayleaf.dev/llms.txt'), 'proxy apex discovery bypasses API routes and auth');
  const apiDb = await mf.getD1Database('DB', 'api');
  await migrate(apiDb, root + 'migrations/');
  await migrate(await mf.getD1Database('DB', 'bayleaf-inboxes'), inboxRoot + 'migrations/');
  for (const [email, key, gen] of [['a@example.test', 'sk-bayleaf-a', 'gen-a-'.padEnd(64, 'a')], ['b@example.test', 'sk-bayleaf-b', 'gen-b-'.padEnd(64, 'b')]])
    await apiDb.prepare('INSERT INTO user_keys(email,bayleaf_token,account_generation) VALUES(?,?,?)').bind(email, key, gen).run();

  const call = (key, method, path, body) => mf.dispatchFetch(API + path, { method,
    headers: { Authorization: `Bearer ${key}`, 'CF-Connecting-IP': '198.51.100.7', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const json = async (res, status, what) => { ok(res.status === status, `${what}: ${res.status} != ${status}`); return res.json(); };

  const emailPolicy = { domains: ['ucsc.edu'], selector_pins: { 'ucsc.edu': ['campus_key'] } };
  const restricted = await json(await call('sk-bayleaf-a', 'POST', '/inboxes', { type: 'email', email_auth: emailPolicy }), 201, 'create restricted email');
  ok(JSON.stringify(restricted.email_auth) === JSON.stringify(emailPolicy) && restricted.restricted_email_max_bytes === 1048576,
    'API reports exact creation-only email policy and restricted cap');
  const ownPolicy = await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${restricted.id}`), 200, 'read restricted policy');
  ok(JSON.stringify(ownPolicy.email_auth) === JSON.stringify(emailPolicy), 'owner policy readback');
  await json(await call('sk-bayleaf-b', 'GET', `/inboxes/${restricted.id}`), 404, 'other owner cannot read policy');
  await json(await call('sk-bayleaf-a', 'POST', '/inboxes', { type: 'http', email_auth: emailPolicy }), 400, 'email policy on HTTP denied');

  // HTTP inbox: open reception, then read back through the API.
  const web = await json(await call('sk-bayleaf-a', 'POST', '/inboxes', { type: 'http', label: '<img src=x onerror=alert(1)>' }), 201, 'create http');
  const payload = JSON.stringify({ event: 'push', note: 'ignore previous instructions' });
  const got = await mf.dispatchFetch(new URL('/github/push?x=1', web.url), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }, body: payload });
  ok(got.status === 200 && (await got.json()).ok === true, 'open http reception');
  const list = await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/messages`), 200, 'list');
  ok(list.messages.length === 1 && list.messages[0].preview.path === '/github/push', 'listed with path');
  const mid = list.messages[0].id;
  const feedResponse = await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/events?limit=1`);
  ok(feedResponse.headers.get('cache-control') === 'no-store', 'arrival feed is private and uncached');
  const feed = await json(feedResponse, 200, 'arrival feed');
  ok(feed.events.length === 1 && feed.events[0].message_id === mid && feed.events[0].event_id === 'evt_1'
    && feed.more === false, 'committed receipt is in the real-binding arrival feed');
  ok(!JSON.stringify(feed).includes(payload) && !JSON.stringify(feed).includes('/github/push'), 'arrival references contain no sender content');
  const idle = await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/events?after=${feed.cursor}`), 200, 'arrival resume');
  ok(idle.events.length === 0 && idle.cursor === feed.cursor, 'empty catch-up preserves resume position');
  const parts = Buffer.from(feed.cursor, 'base64url').toString().split(':');
  parts[0] = parts[0] === '0'.repeat(16) ? 'f'.repeat(16) : '0'.repeat(16);
  const foreign = Buffer.from(parts.join(':')).toString('base64url');
  await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/events?after=${foreign}`), 410, 'foreign epoch requires resync');
  await json(await call('sk-bayleaf-b', 'GET', `/inboxes/${web.id}/events`), 404, 'arrival owner isolation');
  await apiDb.prepare("UPDATE user_keys SET bayleaf_token='sk-bayleaf-a-rotated' WHERE email='a@example.test'").run();
  await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/events`), 401, 'old owner key denied after rotation');
  await json(await call('sk-bayleaf-a-rotated', 'GET', `/inboxes/${web.id}/events`), 200, 'rotated key retains account-generation ownership');
  await apiDb.prepare("UPDATE user_keys SET bayleaf_token='sk-bayleaf-a' WHERE email='a@example.test'").run();
  const session = email => {
    const data = [{ alg: 'HS256', typ: 'JWT' }, { email, name: 'Synthetic', exp: Math.floor(Date.now()/1000) + 3600 }]
      .map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
    return 'bayleaf_session=' + data + '.' + createHmac('sha256', 'synthetic').update(data).digest('base64url');
  };
  const inspect = (kind, email = 'a@example.test') => mf.dispatchFetch(API + '/diagnostics/' + kind,
    { headers: email ? { Cookie: session(email) } : {} });
  for (const kind of ['inboxes', 'proxies']) {
    const anonymous = await inspect(kind, null);
    ok(anonymous.status === 200 && (await anonymous.text()).includes('Sign in to inspect'), 'explicit sign-in interstitial');
    const returnCookie = anonymous.headers.get('set-cookie');
    ok(returnCookie.includes('__Host-bl-diagnostic-return=') && returnCookie.includes('HttpOnly') && !returnCookie.includes('Domain='), 'host-only return marker');
    // A user may leave the interstitial open longer than its old return cookie.
    const login = await mf.dispatchFetch(API + '/login?diagnostic=' + kind, { redirect: 'manual' });
    const freshReturn = login.headers.getSetCookie().find(value => value.startsWith('__Host-bl-diagnostic-return='));
    ok(freshReturn && freshReturn.includes('Max-Age=600'), 'OAuth establishes a fresh allowlisted return marker without an interstitial cookie');
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    const callback = await mf.dispatchFetch(API + '/callback?code=synthetic&state=' + state, { redirect: 'manual',
      headers: { Cookie: freshReturn.split(';')[0] + '; oauth_state=' + state } });
    ok(callback.status === 302 && callback.headers.get('location') === '/diagnostics/' + kind, 'OIDC returns directly to diagnostics, not provisioning dashboard');
  }
  const diagnostic = await inspect('inboxes');
  const html = await diagnostic.text();
  ok(diagnostic.status === 200 && html.includes(web.url) && html.includes('Recent receipts'), 'owner sees receipt metadata');
  ok(!html.includes(payload) && !html.includes('/github/push') && !html.includes('<script') && !html.includes(`href="${web.url}`), 'no content, arrival script or receipt URL link');
  ok(html.includes('&lt;img') && !html.includes('<img'), 'untrusted owner labels are escaped');
  ok(html.includes('>Expires</th>') && !html.includes('>Deleted</th>'), 'expiry is not a physical-erasure claim');
  ok(diagnostic.headers.get('cache-control') === 'no-store' && diagnostic.headers.get('content-security-policy').includes("frame-ancestors 'none'"), 'private security headers');
  ok(!(await (await inspect('inboxes', 'b@example.test')).text()).includes(web.url), 'browser owner isolation');
  const at = Math.floor(Date.now()/1000);
  await apiDb.prepare("INSERT INTO preview_owners(email,slug) VALUES('a@example.test','a')").run();
  await apiDb.prepare("INSERT INTO preview_owners(email,slug) VALUES('b@example.test','b')").run();
  await apiDb.prepare("INSERT INTO preview_owners(email,slug) VALUES('chat-only@example.test','chat-only')").run();
  const previewHost = 'a-public-' + 'a'.repeat(24) + '.bayleaf-proxies.dev';
  for (const [host, email, slot, expires] of [[previewHost,'a@example.test','live',at+600],
    ['a-private-expired.bayleaf-proxies.dev','a@example.test','expired',at-1],
    ['b-private-hidden.bayleaf-proxies.dev','b@example.test','other',at+600],
    ['chat-only-public-link.bayleaf-proxies.dev','chat-only@example.test','chat',at+600]]) {
    await apiDb.prepare(`INSERT INTO preview_registrations(hostname,email,deployment,slot,generation,upstream_encrypted,expires_at,access)
      VALUES(?,?,'lathe',?,'synthetic','encrypted-content-canary',?,'public')`).bind(host,email,slot,expires).run();
  }
  const previews = await (await inspect('proxies')).text();
  ok(previews.includes(previewHost) && previews.includes('Expired') && !previews.includes('b-private-hidden') &&
    !previews.includes('encrypted-content-canary') && !previews.includes('<script'), 'owner-only preview validity, expiry and no encrypted payload');
  const chatOnly = await inspect('proxies', 'chat-only@example.test');
  ok(chatOnly.status === 200 && (await chatOnly.text()).includes('chat-only-public-link.bayleaf-proxies.dev'),
    'Chat-only preview owner does not need an API-key row');
  ok(!(await apiDb.prepare("SELECT email FROM user_keys WHERE email='chat-only@example.test'").first()),
    'Chat-only inspection does not provision an API account or inference key');
  for (const host of ['bayleaf-proxies.dev', DOMAIN]) {
    const worker = await mf.getWorker(host === DOMAIN ? 'bayleaf-inboxes' : 'api');
    const home = await worker.fetch('https://' + host + '/');
    ok(home.status === 200 && home.headers.get('content-type').includes('text/html') && !(await home.text()).includes('<script'), 'public HTML defaults uninstrumented');
    ok((await worker.fetch('https://' + host + '/', { method: 'HEAD' })).status === 200, 'public HEAD');
    ok((await worker.fetch('https://' + host + '/llms.txt')).headers.get('content-type').includes('text/plain'), 'plaintext discovery preserved');
  }
  const text = await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/messages/${mid}/text`), 200, 'text');
  ok(text.source === 'body' && text.text === payload, 'readable text is the exact body');
  const body = await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/messages/${mid}/body`);
  ok(body.status === 200 && await body.text() === payload, 'body streams through real RPC Response');
  ok(body.headers.get('content-security-policy') === 'sandbox' && body.headers.get('x-content-type-options') === 'nosniff'
    && /^attachment/.test(body.headers.get('content-disposition') || ''), 'body download is inert');

  // Exact export and derived HAR over the real RPC Response boundary.
  const exported = await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/export`);
  const tar = new Uint8Array(await exported.arrayBuffer());
  const entry = at => ({ name: new TextDecoder().decode(tar.subarray(at, at + 100)).replace(/\0.*$/s, ''),
    size: parseInt(new TextDecoder().decode(tar.subarray(at + 124, at + 136)), 8) });
  const first = entry(0), second = entry(512 + Math.ceil(first.size / 512) * 512);
  ok(exported.status === 200 && exported.headers.get('content-type') === 'application/x-tar'
    && exported.headers.get('content-security-policy') === 'sandbox' && !exported.headers.has('x-inbox-export-next-cursor'), 'export is inert tar');
  ok(first.name === `payloads/${mid}.body` && new TextDecoder().decode(tar.subarray(512, 512 + first.size)) === payload, 'exact exported payload');
  const harAt = 1024 + Math.ceil(first.size / 512) * 512;
  const archiveHar = JSON.parse(new TextDecoder().decode(tar.subarray(harAt, harAt + second.size)));
  const thirdAt = harAt + Math.ceil(second.size / 512) * 512, third = entry(thirdAt);
  const manifest = JSON.parse(new TextDecoder().decode(tar.subarray(thirdAt + 512, thirdAt + 512 + third.size)));
  ok(third.name === `manifests/${mid}.json` && manifest.format === 'bayleaf-inbox-export' && manifest.receipts[0].meta.path === '/github/push'
    && manifest.receipts[0].sha256 === createHash('sha256').update(payload).digest('hex'), 'manifest metadata and digest');
  ok(second.name === 'receipts.har' && manifest.har === 'receipts.har' && archiveHar.log.entries[0]._receiptId === mid
    && archiveHar.log.entries[0].request.postData.text === payload
    && archiveHar.log.entries[0].response.status === 0 && archiveHar.log.entries[0].response._observed === false
    && archiveHar.log.entries[0].time === -1 && archiveHar.log._profile === 'bayleaf-inbox-receipt-1', 'truthful HAR profile');
  const singleHar = await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/messages/${mid}/har`);
  ok(singleHar.status === 200 && singleHar.headers.get('content-type') === 'application/json'
    && singleHar.headers.get('content-security-policy') === 'sandbox'
    && singleHar.headers.get('x-content-type-options') === 'nosniff'
    && singleHar.headers.get('content-disposition') === `attachment; filename="${mid}.har"`, 'inert standalone HAR');
  ok(JSON.stringify(await singleHar.json()) === JSON.stringify(archiveHar), 'standalone/export HAR parity');
  ok((await call('sk-bayleaf-b', 'GET', `/inboxes/${web.id}/messages/${mid}/har`)).status === 404, 'HAR owner isolation');
  ok((await call('sk-bayleaf-b', 'GET', `/inboxes/${web.id}/export`)).status === 404, 'export owner isolation');

  // Owner isolation through the facade: B sees nothing of A's.
  for (const path of [`/inboxes/${web.id}`, `/inboxes/${web.id}/messages`, `/inboxes/${web.id}/messages/${mid}/text`])
    ok((await call('sk-bayleaf-b', 'GET', path)).status === 404, `owner B denied ${path}`);

  // Closing the inbox with a write-only bearer credential.
  const cred = await json(await call('sk-bayleaf-a', 'POST', `/inboxes/${web.id}/credentials`, { name: 'alice' }), 201, 'credential');
  ok(/^sk-bayleaf-inbox-[a-f0-9]{64}$/.test(cred.token) && cred.credential.hint === cred.token.slice(-4), 'token shape and hint');
  const listed = await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/credentials`), 200, 'list credentials');
  ok(!JSON.stringify(listed).includes(cred.token), 'token never read back');
  const anon = await mf.dispatchFetch(web.url, { method: 'POST', body: 'x' });
  ok(anon.status === 401 && anon.headers.get('www-authenticate') === 'Bearer realm="bayleaf-inbox"', 'closed inbox challenges');
  const signed = await mf.dispatchFetch(web.url, { method: 'POST', body: 'x', headers: { Authorization: `Bearer ${cred.token}` } });
  ok(signed.status === 200, 'bearer accepted');
  // An inbox token is not an API key.
  ok((await call(cred.token, 'GET', '/inboxes')).status === 401, 'inbox token refused by the API');

  // Revocation must remove authority, never silently switch authentication off.
  await json(await call('sk-bayleaf-a', 'DELETE', `/inboxes/${web.id}/credentials/${cred.credential.id}`), 200, 'revoke');
  ok((await mf.dispatchFetch(web.url, { method: 'POST', body: 'x' })).status === 401, 'last-token revocation keeps inbox closed');
  ok((await mf.dispatchFetch(web.url, { method: 'POST', body: 'x', headers: { Authorization: `Bearer ${cred.token}` } })).status === 401,
    'revoked token no longer authorizes reception');

  // Email inbox: envelope routing, attachment extraction through the API.
  const mail = await json(await call('sk-bayleaf-a', 'POST', '/inboxes', { type: 'email' }), 201, 'create email');
  const raw = ['From: Zoe <zoe@example.org>', 'To: someone-else@example.org', 'Subject: report', 'Message-ID: <e2e@example.org>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'see attached',
    '--B', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="r.pdf"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('%PDF-1.4 synthetic').toString('base64'), '--B--', ''].join('\r\n');
  const delivered = await mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?format=json&from=zoe@example.org&to=${encodeURIComponent(mail.address)}`,
    { method: 'POST', body: raw });
  ok((await delivered.json()).rejectReason === undefined, 'email delivered by envelope recipient');
  const mm = (await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${mail.id}/messages?q=report`), 200, 'search')).messages;
  ok(mm.length === 1 && mm[0].preview.attachments === 1, 'searchable with attachment count');
  const emailHar = await call('sk-bayleaf-a', 'GET', `/inboxes/${mail.id}/messages/${mm[0].id}/har`);
  ok(emailHar.status === 400 && (await emailHar.json()).error.message === 'HAR is available only for HTTP receipts.', 'email HAR type error');
  const att = await call('sk-bayleaf-a', 'GET', `/inboxes/${mail.id}/messages/${mm[0].id}/attachments/0`);
  ok(att.status === 200 && await att.text() === '%PDF-1.4 synthetic' && att.headers.get('content-security-policy') === 'sandbox', 'attachment inert and exact');
  const mailDiagnostic = await (await inspect('inboxes')).text();
  ok(!mailDiagnostic.includes(mm[0].preview.subject) && !mailDiagnostic.includes('ignore previous instructions'), 'email subjects and content excluded from diagnostics');
  if (process.argv.includes('--preview')) {
    const dir = await mkdtemp('/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/diagnostics-');
    // A second owner with ordinary labels, so the gallery shows the normal case beside the escaped hostile one.
    const hooks = await json(await call('sk-bayleaf-b', 'POST', '/inboxes', { type: 'http', label: 'GitHub deploy hooks' }), 201, 'showcase http');
    for (const size of [180, 2400, 96000]) await mf.dispatchFetch(new URL('/push', hooks.url), { method: 'POST', body: 'x'.repeat(size) });
    await json(await call('sk-bayleaf-b', 'POST', '/inboxes', { type: 'email', label: 'Course notifications' }), 201, 'showcase email');
    const pages = { 'inboxes-owner': mailDiagnostic, 'inboxes-owner-showcase': await (await inspect('inboxes', 'b@example.test')).text(),
      'proxies-owner': previews, 'signin': await (await inspect('proxies', null)).text(),
      'inboxes': await (await (await mf.getWorker('bayleaf-inboxes')).fetch('https://' + DOMAIN + '/')).text(),
      'proxies': await (await mf.dispatchFetch('https://bayleaf-proxies.dev/')).text(),
      'unavailable': await (await mf.dispatchFetch('https://bayleaf-proxies.dev/unavailable')).text() };
    for (const [name, body] of Object.entries(pages)) await writeFile(`${dir}/${name}.html`, body);
    await writeFile(`${dir}/index.html`, '<!doctype html><html lang="en"><title>Local diagnostic fixtures</title><h1>Synthetic diagnostic fixtures</h1><ul>' +
      Object.keys(pages).map(name => `<li><a href="${name}.html">${name}</a></li>`).join('') + '</ul></html>');
    console.log('Synthetic browser preview: ' + dir);
  }

  // Destruction: immediate revocation of reception and reads, 202 not a completion claim.
  const gone = await json(await call('sk-bayleaf-a', 'DELETE', `/inboxes/${web.id}`), 202, 'destroy');
  ok(gone.state === 'destroying', 'destroy is asynchronous');
  ok((await mf.dispatchFetch(web.url, { method: 'POST', body: 'x', headers: { Authorization: `Bearer ${cred.token}` } })).status === 404, 'reception revoked');
  ok((await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/messages`)).status === 404, 'reads revoked');
  ok((await call('sk-bayleaf-a', 'GET', `/inboxes/${web.id}/events`)).status === 404, 'arrival reads revoked by destruction');

  // Disposable lifetime: preset, shorten-only PATCH, then expiry stops everything before any sweep.
  const brief = await json(await call('sk-bayleaf-a', 'POST', '/inboxes', { type: 'http', preset: 'experiment' }), 201, 'create disposable');
  ok(brief.expires_at - brief.created_at === 900, 'experiment preset is 15 minutes');
  ok((await call('sk-bayleaf-a', 'PATCH', `/inboxes/${brief.id}`, { ttl_seconds: 3600 })).status === 409, 'lifetime never lengthened');
  const shortened = await json(await call('sk-bayleaf-a', 'PATCH', `/inboxes/${brief.id}`, { ttl_seconds: 600 }), 200, 'shorten');
  ok(shortened.expires_at < brief.expires_at, 'lifetime shortened');
  ok((await mf.dispatchFetch(brief.url, { method: 'POST', body: 'x' })).status === 200, 'live before expiry');
  await (await mf.getD1Database('DB', 'bayleaf-inboxes')).prepare('UPDATE inboxes SET expires_at=? WHERE id=?')
    .bind(Math.floor(Date.now() / 1000) - 1, brief.id).run();
  ok((await mf.dispatchFetch(brief.url, { method: 'POST', body: 'x' })).status === 404, 'expired reception refused');
  ok((await call('sk-bayleaf-a', 'GET', `/inboxes/${brief.id}/messages`)).status === 404, 'expired reads refused');
  const lapsed = await json(await call('sk-bayleaf-a', 'GET', `/inboxes/${brief.id}`), 200, 'expired view');
  ok(lapsed.state === 'destroying' && lapsed.cleanup_not_before === lapsed.expires_at + 900, 'expiry visible as cleanup pending');
  ok((await (await inspect('inboxes')).text()).includes('Expired, deleting'), 'diagnostics show the ended lifetime');

  // No inference credentials were ever minted for inbox-only use.
  const row = await apiDb.prepare('SELECT or_key_secret, tinfoil_key FROM user_keys WHERE email=?').bind('a@example.test').first();
  ok(row.or_key_secret === null && row.tinfoil_key === null, 'no provider keys minted');
  console.log(`inbox end-to-end: ${checks} checks passed`);
} finally {
  await mf.dispose();
}
