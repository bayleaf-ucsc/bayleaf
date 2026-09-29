#!/usr/bin/env node
/** Real workerd/D1, synthetic accounts and upstreams. No live credentials. */
import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const api = 'http://localhost:8789';
const secret = 'synthetic-grant-harness-secret-not-for-deployment';
const model = 'test/open-model';
const digest = value => createHash('sha256').update(value).digest('base64url');
const jwt = email => {
  const value = [{ alg: 'HS256', typ: 'JWT' }, { email, name: 'Synthetic User', exp: Math.floor(Date.now() / 1000) + 3600 }]
    .map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return value + '.' + createHmac('sha256', secret).update(value).digest('base64url');
};
const ownerCookie = 'bayleaf_session=' + jwt('owner@example.test');
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  export { PreviewConnections } from './src/index.ts';
  export default { ...app, async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__harness-login') return new Response(null, {status: 303, headers: {Location: '/grants/manage', 'Set-Cookie': ${JSON.stringify(ownerCookie + '; HttpOnly; SameSite=Lax; Path=/')}}});
    const headers = new Headers(request.headers);
    if (headers.has('X-Harness-Origin')) { headers.set('Origin', headers.get('X-Harness-Origin')); headers.delete('X-Harness-Origin'); }
    const disabled = headers.get('X-Harness-Disabled'); headers.delete('X-Harness-Disabled');
    const backends = headers.get('X-Harness-Backends'); headers.delete('X-Harness-Backends');
    const advance = Number(headers.get('X-Harness-Advance') || 0); headers.delete('X-Harness-Advance');
    const realNow = Date.now;
    if (advance) Date.now = () => realNow() + advance * 1000;
    const effectiveEnv = { ...env, ...(disabled ? {GRANTS_ENABLED: 'false'} : {}),
      ...(backends ? {BEDROCK_ENABLED: 'true', VERTEX_ENABLED: 'true'} : {}) };
    try { return await app.fetch(new Request(request, {headers}), effectiveEnv, ctx); }
    finally { Date.now = realNow; }
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
let upstreamCalls = 0;
const bindings = { GRANTS_ENABLED: 'true', GRANTS_MAX_SECONDS: '3600', OIDC_CLIENT_SECRET: secret,
  BEDROCK_BEARER_TOKEN: 'synthetic-bedrock-key', GCP_PROJECT_ID: 'synthetic-project',
  GCP_SERVICE_ACCOUNT_EMAIL: 'synthetic@example.test',
  GCP_SERVICE_ACCOUNT_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  ALLOWED_EMAIL_DOMAIN: 'example.test', RECOMMENDED_MODEL: model, CAMPUS_IP_RANGES: '192.0.2.0/24',
  CAMPUS_POOL_KEY: 'synthetic-campus-key',
  OIDC_ISSUER: 'https://identity.example.test', OIDC_CLIENT_ID: 'synthetic-client', OIDC_SCOPES: 'openid email',
  OIDC_LOGIN_BUTTON_TEXT: 'Synthetic login', SPENDING_LIMIT_DOLLARS: '1', SPENDING_LIMIT_RESET: 'daily',
  OPENCODE_CURATED_MODELS: '', SEALED_CURATED_MODELS: '', SEALED_RECOMMENDED_MODEL: '',
};
const mf = new Miniflare(convertV4MiniflareOptions({ port: process.argv.includes('--serve') ? 8789 : 0, workers: [{ name: 'grants-harness',
  modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-31', compatibilityFlags: ['nodejs_compat'],
  bindings, d1Databases: ['DB'], kvNamespaces: ['MODEL_STATUS', 'CAMPUS_RPD'],
  durableObjects: { PREVIEW_CONNECTIONS: { className: 'PreviewConnections', useSQLite: true } },
  outboundService: async req => {
    const url = new URL(req.url);
    if (url.hostname === 'identity.example.test') {
      if (url.pathname.endsWith('/.well-known/openid-configuration')) return Response.json({ authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token', userinfo_endpoint: 'https://identity.example.test/userinfo' });
      if (url.pathname === '/token') return Response.json({ access_token: 'synthetic-oidc-token' });
      if (url.pathname === '/userinfo') return Response.json({ email: 'owner@example.test', name: 'Synthetic User' });
    }
    if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/models')) return Response.json({ data: [
      { id: model, name: 'Synthetic model', hugging_face_id: 'test/open-model', pricing: { prompt: '0', completion: '0' } },
      { id: 'test/uncurated-open', name: 'Uncurated model', hugging_face_id: 'test/uncurated-open', pricing: { prompt: '0', completion: '0' } },
      { id: 'test/closed', name: 'Closed', hugging_face_id: '' },
    ] });
    if (url.hostname === 'huggingface.co') return new Response('weights');
    if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/keys/synthetic-key-hash')) return Response.json({ data: {
      hash: 'synthetic-key-hash', disabled: false, limit: 5, limit_remaining: 5, usage: 0,
      usage_daily: 0, usage_weekly: 0, usage_monthly: 0, limit_reset: 'daily', created_at: new Date().toISOString(),
    } });
    if (url.hostname === 'bedrock-mantle.us-west-2.api.aws') {
      assert.equal(req.headers.get('Authorization'), 'Bearer synthetic-bedrock-key');
      if (url.pathname.endsWith('/models')) return Response.json({ data: [
        { id: 'test-model', name: 'Synthetic Bedrock', data_retention: { allowed_modes: ['none'] } },
        { id: 'retaining-model', data_retention: { allowed_modes: ['default'] } },
      ] });
      assert.equal((await req.json()).model, 'test-model'); upstreamCalls++;
      return Response.json({ choices: [{ message: { content: 'Synthetic Bedrock inference.' } }] });
    }
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-gcp-access', expires_in: 3600 });
    if (url.hostname === 'aiplatform.googleapis.com') {
      assert.equal(req.headers.get('Authorization'), 'Bearer synthetic-gcp-access');
      assert.equal((await req.json()).model, 'google/gemini-2.5-flash'); upstreamCalls++;
      return Response.json({ choices: [{ message: { content: 'Synthetic Vertex inference.' } }] });
    }
    assert.equal(url.hostname, 'openrouter.ai');
    assert.ok(url.pathname.endsWith('/chat/completions') || url.pathname.endsWith('/responses'), 'No provider-key provisioning or other upstream operation');
    assert.equal(req.headers.get('Authorization'), 'Bearer synthetic-existing-provider-key');
    const body = await req.json(); assert.equal(body.model, model);
    upstreamCalls++;
    return body.stream ? new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ choices: [{ message: { content: 'Synthetic inference succeeded.' } }], model: body.model });
  },
}] }));
const db = await mf.getD1Database('DB');
async function request(path, { key, cookie, json, origin, ...init } = {}) {
  const headers = new Headers(init.headers);
  if (key) headers.set('Authorization', 'Bearer ' + key);
  if (cookie) headers.set('Cookie', cookie);
  if (origin) headers.set('X-Harness-Origin', origin);
  if (json) { headers.set('Content-Type', 'application/json'); init.body = JSON.stringify(json); init.method ??= 'POST'; }
  return (await mf.getWorker()).fetch(new URL(path, api).href, { ...init, headers, redirect: 'manual' });
}
async function check(label, run) { await run(); console.log('PASS ' + label); }
async function expect(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const value = await response.json();
  if (code) assert.equal(value.error?.code, code);
  return value;
}
async function mint(lifetime = 3600) {
  return expect(await request('/grants', { key: 'sk-bayleaf-owner', json: { model, expires_in: lifetime } }), 200);
}
async function client(redirect_uri = 'http://127.0.0.1:5173/') {
  return expect(await request('/grants/clients', { json: { client_name: '<script>untrusted app</script>', redirect_uri } }), 200);
}
async function start(redirect_uri = 'http://127.0.0.1:5173/', selectedModel = model, headers = {}) {
  const { client_id } = await client(redirect_uri);
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id, response_type: 'code', model: selectedModel, expires_in: '3600', state: 'synthetic-random-state', code_challenge: digest(verifier), code_challenge_method: 'S256' });
  const res = await request('/grants/authorize?' + query, { headers });
  assert.equal(res.status, 303);
  const flowCookie = res.headers.getSetCookie().find(c => c.startsWith('bl_grant_flow=')).split(';')[0];
  const path = res.headers.get('Location');
  const cookie = ownerCookie + '; ' + flowCookie;
  const page = await request(path, { cookie }); assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('&lt;script&gt;untrusted app&lt;/script&gt;'));
  const approval = html.match(/name="approval" value="([^"]+)"/)[1];
  const id = new URL(path, api).searchParams.get('request');
  return { client_id, verifier, redirect_uri, cookie, flowCookie, path, id, approval, headers };
}
async function approve(flow, decision = 'approve', override = {}) {
  return request('/grants/authorize', { cookie: flow.cookie, origin: api, method: 'POST', headers: flow.headers,
    body: new URLSearchParams({ request: flow.id, approval: flow.approval, decision }), ...override });
}
async function code(flow) {
  const res = await approve(flow); assert.equal(res.status, 303, await res.clone().text());
  const url = new URL(res.headers.get('Location')); assert.equal(url.searchParams.get('state'), 'synthetic-random-state');
  return url.searchParams.get('code');
}
const exchange = (flow, code, overrides = {}) => request('/grants/token', { headers: flow.headers, json: {
  grant_type: 'authorization_code', code, client_id: flow.client_id, redirect_uri: flow.redirect_uri, code_verifier: flow.verifier, ...overrides,
} });
const infer = (key, extra = {}, path = '/v1/chat/completions', headers = {}) => request(path, {
  key, headers, json: { model, messages: [{ role: 'user', content: 'synthetic only' }], ...extra },
});

try {
  for (const file of (await readdir(root + 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(root + 'migrations/' + file, 'utf8')).replace(/^\s*--.*$/gm, '');
    const statements = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) : sql.split(';');
    for (const statement of statements.map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const [email, token] of [['owner@example.test', 'sk-bayleaf-owner'], ['other@example.test', 'sk-bayleaf-other']])
    await db.prepare('INSERT INTO user_keys(email, bayleaf_token, or_key_secret, or_key_hash) VALUES (?, ?, ?, ?)').bind(email, token, 'synthetic-existing-provider-key', 'synthetic-key-hash').run();

  let direct;
  await check('direct issuance shares owner credential and supports both inference endpoints and streaming', async () => {
    direct = await mint(); assert.equal(direct.key, direct.access_token); assert.equal(direct.model, 'openrouter:' + model);
    assert.match(direct.name, /^[a-z]+-[a-z]+-[0-9a-z]{4}$/);
    assert.ok(direct.key.startsWith('sk-bayleaf-grant-' + direct.name + '.'));
    assert.equal(direct.base_url, api + '/v1');
    assert.ok(direct.expires_at > Date.now() / 1000);
    await expect(await infer(direct.key), 200);
    await expect(await infer(direct.key, { input: 'synthetic only' }, '/v1/responses'), 200);
    const stream = await infer(direct.key, { stream: true }); assert.equal(stream.status, 200); assert.match(await stream.text(), /DONE/);
  });
  await check('scope gate denies all other surfaces even with an owner cookie or campus address', async () => {
    for (const [method, path] of [['GET', '/v1/models'], ['GET', '/v1/auth/key'], ['POST', '/grants'], ['DELETE', '/key'], ['POST', '/sandbox/exec'], ['POST', '/web/search'], ['POST', '/sealed/v1/chat/completions'], ['GET', '/docs/gws-oauth-client.json'], ['GET', '/grants'], ['POST', '/v1/completions'], ['POST', '/api/v1/chat/completions']])
      await expect(await request(path, { key: direct.key, cookie: ownerCookie, method, headers: { 'CF-Connecting-IP': '192.0.2.1' } }), 403, 'insufficient_scope');
    await expect(await infer(direct.key, { model: 'other/model' }), 403, 'insufficient_scope');
    for (const extra of [{ models: [model] }, { route: 'fallback' }, { plugins: [] }]) await expect(await infer(direct.key, extra), 403, 'insufficient_scope');
  });
  await check('full model catalog preserves prefixes, excludes Sealed, and exposes backend availability', async () => {
    const catalog = await expect(await request('/grants/models', { cookie: ownerCookie }), 200);
    assert.ok(catalog.models.some(m => m.id === 'openrouter:test/uncurated-open'));
    assert.ok(!catalog.models.some(m => m.id.includes('closed') || m.id.startsWith('sealed:')));
    assert.equal(catalog.backends.find(b => b.id === 'bedrock').enabled, false);
    assert.equal(catalog.backends.find(b => b.id === 'vertex').enabled, false);
    await expect(await request('/grants/models', { key: direct.key }), 403, 'insufficient_scope');
    const enabled = await expect(await request('/grants/models', { cookie: ownerCookie, headers: { 'X-Harness-Backends': 'true' } }), 200);
    assert.ok(enabled.models.some(m => m.id === 'bedrock:test-model'));
    assert.ok(enabled.models.some(m => m.id === 'vertex:gemini-2.5-flash'));
    assert.ok(!enabled.models.some(m => m.id === 'bedrock:retaining-model'));
  });
  await check('all enabled standard backends enforce qualified model scope and existing owner limits', async () => {
    const headers = { 'X-Harness-Backends': 'true' };
    for (const selectedModel of ['bedrock:test-model', 'vertex:gemini-2.5-flash']) {
      await expect(await request('/grants', { key: 'sk-bayleaf-owner', json: { model: selectedModel, expires_in: 600 } }), 403, 'model_not_allowed');
      const token = await expect(await request('/grants', { key: 'sk-bayleaf-owner', headers, json: { model: selectedModel, expires_in: 600 } }), 200);
      assert.equal(token.model, selectedModel);
      await expect(await infer(token.key, { model: selectedModel }, '/v1/chat/completions', headers), 200);
      await expect(await infer(token.key, { model: selectedModel }), 503, 'backend_disabled');
      await expect(await infer(token.key, { model: selectedModel, input: 'synthetic' }, '/v1/responses', headers), 403, 'insufficient_scope');
      await expect(await infer(token.key, { model: 'openrouter:' + model }, '/v1/chat/completions', headers), 403, 'insufficient_scope');
      await expect(await infer(direct.key, { model: selectedModel }, '/v1/chat/completions', headers), 403, 'insufficient_scope');
      const backend = selectedModel.split(':')[0];
      const today = new Date().toISOString().slice(0, 10);
      await db.prepare(`UPDATE user_keys SET ${backend}_rpd_date=?, ${backend}_rpd_count=99 WHERE email=?`).bind(today, 'owner@example.test').run();
      // One remaining request, shared by the ordinary key and its temporary token.
      const race = await Promise.all([
        infer(token.key, { model: selectedModel }, '/v1/chat/completions', headers),
        infer('sk-bayleaf-owner', { model: selectedModel }, '/v1/chat/completions', headers),
      ]);
      assert.deepEqual(race.map(r => r.status).sort(), [200, 429]);
      assert.equal((await db.prepare(`SELECT ${backend}_rpd_count n FROM user_keys WHERE email=?`).bind('owner@example.test').first()).n, 100);
      await db.prepare(`UPDATE user_keys SET ${backend}_rpd_count=0 WHERE email=?`).bind('owner@example.test').run();
    }
    for (const selectedModel of ['sealed:some-model', 'unknown:test/model', 'bedrock:retaining-model', 'vertex:nonexistent'])
      await expect(await request('/grants', { key: 'sk-bayleaf-owner', headers, json: { model: selectedModel, expires_in: 600 } }), 403, 'model_not_allowed');
  });
  await check('visitor authorization preserves alternate-backend identity and rechecks enablement at exchange', async () => {
    const flow = await start('http://localhost:5173/', 'bedrock:test-model', { 'X-Harness-Backends': 'true' });
    const value = await code(flow);
    const token = await expect(await exchange(flow, value), 200);
    assert.equal(token.model, 'bedrock:test-model');
    await expect(await infer(token.key, { model: token.model }, '/v1/chat/completions', flow.headers), 200);
    const stopped = await start('http://localhost:5173/', 'bedrock:test-model', flow.headers);
    const stoppedCode = await code(stopped);
    stopped.headers = {};
    await expect(await exchange(stopped, stoppedCode), 403, 'model_not_allowed');
  });
  await check('token names are signed and cannot be changed, stripped, or substituted', async () => {
    const other = await mint();
    await expect(await infer(direct.key.replace(direct.name, 'forged-name-0000')), 401, 'invalid_token');
    await expect(await infer(direct.key.replace(direct.name + '.', '')), 401, 'invalid_token');
    await expect(await infer(direct.key.replace(direct.name, other.name)), 401, 'invalid_token');
    const issued = await Promise.all(Array.from({ length: 12 }, () => mint()));
    assert.equal(new Set(issued.map(t => t.name)).size, issued.length);
    const list = await expect(await request('/grants', { key: 'sk-bayleaf-owner' }), 200);
    assert.equal(list.grants.find(g => g.id === direct.grant_id).name, direct.name);
    assert.ok(list.grants.every(g => !('access_token' in g) && !('key' in g)));
    const insertName = (id, email) => db.prepare(`INSERT INTO inference_grants
      (id,name,owner_email,owner_token_hash,model,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(id, direct.name, email, digest('sk-bayleaf-other'), model, direct.expires_at, direct.expires_at - 3600).run();
    await assert.rejects(insertName(crypto.randomUUID(), 'owner@example.test'), /UNIQUE constraint/);
    const otherId = crypto.randomUUID();
    await insertName(otherId, 'other@example.test');
    await db.prepare('DELETE FROM inference_grants WHERE id=?').bind(otherId).run();
  });
  await check('legacy unnamed signed tokens remain valid until expiry or revocation', async () => {
    const id = crypto.randomUUID(), exp = Math.floor(Date.now() / 1000) + 600;
    await db.prepare(`INSERT INTO inference_grants(id,owner_email,owner_token_hash,model,expires_at,created_at)
      VALUES (?,?,?,?,?,?)`).bind(id, 'owner@example.test', digest('sk-bayleaf-owner'), model, exp, exp - 600).run();
    const data = Buffer.from(JSON.stringify({id,exp})).toString('base64url');
    const sig = createHmac('sha256', secret).update('bayleaf-grants:v1:access:' + data).digest('base64url');
    const legacy = 'sk-bayleaf-grant-' + data + '.' + sig;
    await expect(await infer(legacy), 200);
    await expect(await infer('sk-bayleaf-grant-made-up-name.' + data + '.' + sig), 401, 'invalid_token');
    await db.prepare('DELETE FROM inference_grants WHERE id=?').bind(id).run();
    await expect(await infer(legacy), 401, 'invalid_token');
  });
  await check('invalid lifetimes, unknown models, cookies, and Campus Pass cannot bypass issuance policy', async () => {
    for (const expires_in of [0, -1, 1.5, 3601]) await expect(await request('/grants', { key: 'sk-bayleaf-owner', json: { model, expires_in } }), 400);
    await expect(await request('/grants', { key: 'sk-bayleaf-owner', json: { model: 'test/closed', expires_in: 60 } }), 403);
    await expect(await request('/grants', { key: 'campus', headers: { 'CF-Connecting-IP': '192.0.2.1' }, json: { model, expires_in: 60 } }), 403);
    await expect(await request('/grants', { cookie: ownerCookie, origin: 'https://evil.test', json: { model, expires_in: 60 } }), 403);
    await expect(await request('/grants', { cookie: ownerCookie, origin: api, json: { model, expires_in: 60 } }), 200);
  });
  await check('descriptors are stateless and callbacks reject normalization tricks and unsafe HTTP', async () => {
    const before = await db.prepare('SELECT count(*) AS n FROM grant_transactions').first();
    for (const callback of ['http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://[::1]:5173/', 'https://app.example.test/callback']) await client(callback);
    for (const callback of ['http://localhost.evil.test/', 'http://127.1/', 'http://2130706433/', 'http://0.0.0.0:5173/', 'http://192.168.1.1/', 'http://foo.localhost/', 'https://user:pass@example.test/', 'https://example.test/#fragment', 'https://example.test/?code=old'])
      await expect(await request('/grants/clients', { json: { client_name: 'Test', redirect_uri: callback } }), 400);
    assert.deepEqual(await db.prepare('SELECT count(*) AS n FROM grant_transactions').first(), before);
  });
  await check('consent is browser/account bound, explicit, escaped, and requires same-origin submission', async () => {
    const flow = await start();
    await expect(await request(flow.path, { cookie: ownerCookie }), 400);
    await expect(await approve(flow, 'approve', { origin: 'https://evil.test' }), 403);
    await expect(await approve(flow, 'approve', { cookie: 'bayleaf_session=' + jwt('other@example.test') + '; ' + flow.flowCookie }), 400);
    const denied = await approve(flow, 'deny'); assert.equal(denied.status, 303);
    assert.equal(new URL(denied.headers.get('Location')).searchParams.get('error'), 'access_denied');
    await expect(await approve(flow), 400);
  });
  await check('existing campus login resumes the bound authorization transaction', async () => {
    const flow = await start();
    const loginRedirect = await request(flow.path, { cookie: flow.flowCookie }); assert.equal(loginRedirect.headers.get('Location'), '/login');
    const returnCookie = loginRedirect.headers.getSetCookie()[0].split(';')[0];
    const login = await request('/login'); const oauthCookie = login.headers.getSetCookie()[0].split(';')[0];
    const state = new URL(login.headers.get('Location')).searchParams.get('state');
    const callback = await request('/callback?code=synthetic&state=' + state, { cookie: [oauthCookie, returnCookie, flow.flowCookie].join('; ') });
    assert.equal(callback.headers.get('Location'), flow.path);
    assert.ok(callback.headers.getSetCookie().some(c => c.startsWith('bayleaf_session=')));
  });
  await check('PKCE, exact descriptor/callback binding, atomic single-use code exchange, same token powers', async () => {
    const flow = await start('http://localhost:5173/'); const value = await code(flow);
    await expect(await exchange(flow, value, { code_verifier: randomBytes(32).toString('base64url') }), 400, 'invalid_grant');
    await expect(await exchange(flow, value, { redirect_uri: 'http://127.0.0.1:5173/' }), 400, 'invalid_grant');
    await expect(await exchange(flow, value, { client_id: (await client()).client_id }), 400, 'invalid_grant');
    const concurrent = await Promise.all([exchange(flow, value), exchange(flow, value)]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 400]);
    const issued = await concurrent.find(r => r.status === 200).json(); await expect(await infer(issued.key), 200);
    await expect(await request('/grants', { key: issued.key }), 403, 'insufficient_scope');
  });
  await check('list is owner-scoped; another owner cannot revoke; revocation is immediate', async () => {
    const other = await expect(await request('/grants', { key: 'sk-bayleaf-other' }), 200); assert.equal(other.grants.length, 0);
    await expect(await request('/grants/' + direct.grant_id, { key: 'sk-bayleaf-other', method: 'DELETE' }), 200);
    await expect(await infer(direct.key), 200);
    await expect(await request('/grants/' + direct.grant_id, { key: 'sk-bayleaf-owner', method: 'DELETE' }), 200);
    await expect(await infer(direct.key), 401, 'invalid_token');
  });
  await check('descriptor and authorization-code deadlines are enforced, and signed purposes cannot be swapped', async () => {
    const flow = await start();
    const query = new URLSearchParams({ client_id: flow.client_id, response_type: 'code', model, expires_in: '3600',
      state: 'test-state', code_challenge: digest(flow.verifier), code_challenge_method: 'S256' });
    await expect(await request('/grants/authorize?' + query, { headers: { 'X-Harness-Advance': '601' } }), 400);
    query.set('client_id', flow.client_id + 'x');
    await expect(await request('/grants/authorize?' + query), 400);
    await expect(await infer('sk-bayleaf-grant-' + flow.client_id), 401, 'invalid_token');
    const value = await code(flow);
    await expect(await request('/grants/token', { headers: { 'X-Harness-Advance': '121' }, json: {
      grant_type: 'authorization_code', code: value, client_id: flow.client_id, redirect_uri: flow.redirect_uri, code_verifier: flow.verifier,
    } }), 400, 'invalid_grant');
  });
  await check('signed expiry survives row cleanup, token forgery fails, and browser can read challenge header', async () => {
    const short = await mint(1);
    await db.prepare('DELETE FROM inference_grants WHERE id=?').bind(short.grant_id).run();
    const expired = await infer(short.key, {}, '/v1/chat/completions', { 'X-Harness-Advance': '3' });
    assert.equal(expired.headers.get('WWW-Authenticate'), 'Bearer error="invalid_token"');
    assert.match(expired.headers.get('Access-Control-Expose-Headers'), /WWW-Authenticate/i);
    await expect(expired, 401, 'token_expired');
    await expect(await infer(short.key + 'x'), 401, 'invalid_token');
    await expect(await infer((await mint()).key, {}, '/v1/chat/completions', { 'X-Harness-Disabled': 'true' }), 503);
  });
  await check('owner-key rotation cannot revive outstanding grants or approved transactions', async () => {
    const issued = await mint(); const flow = await start(); const value = await code(flow);
    await db.prepare("UPDATE user_keys SET bayleaf_token='sk-bayleaf-rotated' WHERE email='owner@example.test'").run();
    await expect(await infer(issued.key), 401, 'invalid_token');
    await expect(await exchange(flow, value), 400, 'invalid_grant');
    await db.prepare("UPDATE user_keys SET bayleaf_token='sk-bayleaf-owner' WHERE email='owner@example.test'").run();
  });
  await check('dashboard management, OpenAPI, and llms.txt expose the feature without exposing issued secrets', async () => {
    const redirect = await request('/grants/manage', { cookie: ownerCookie });
    assert.equal(redirect.status, 303); assert.equal(redirect.headers.get('Location'), '/dashboard#temporary-inference-tokens');
    const page = await request('/dashboard', { cookie: ownerCookie }); const html = await page.text();
    assert.equal(page.status, 200); assert.match(html, /Temporary inference tokens/); assert.match(html, /Copy token/);
    const section = html.match(/<section id="temporary-inference-tokens"[\s\S]*?<\/section>/)[0];
    assert.doesNotMatch(section, /type="password"|issued-key|\.value = result\.(key|access_token)/);
    assert.equal(page.headers.get('Cache-Control'), 'no-store');
    assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
    const spec = await expect(await request('/docs/openapi.json'), 200);
    for (const path of ['/grants', '/grants/clients', '/grants/token', '/grants/{id}']) assert.ok(spec.paths[path], path);
    const text = await (await request('/llms.txt')).text(); assert.match(text, /token_expired/); assert.match(text, /code_challenge_method=S256/);
  });
  await check('scheduled cleanup removes expired metadata and preserves active grants', async () => {
    const active = await mint();
    await db.prepare('UPDATE grant_transactions SET expires_at=0').run();
    await db.prepare('UPDATE inference_grants SET expires_at=0 WHERE id<>?').bind(active.grant_id).run();
    await (await mf.getWorker()).scheduled();
    assert.equal((await db.prepare('SELECT count(*) n FROM grant_transactions').first()).n, 0);
    assert.equal((await db.prepare('SELECT count(*) n FROM inference_grants').first()).n, 1);
    await expect(await infer(active.key), 200);
  });
  console.log(`All grant checks passed; ${upstreamCalls} synthetic inference requests, no live traffic.`);
  if (process.argv.includes('--serve')) {
    console.log('Synthetic browser preview: ' + api + '/__harness-login');
    await new Promise(resolve => process.once('SIGINT', resolve));
  }
} finally { await mf.dispose(); }
