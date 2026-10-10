/** Same-origin browser adapter tests. Fake RPC, no external services or compute. */
import assert from 'node:assert/strict';
import { build } from '../api/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, entryPoints: ['sandbox/worker.js'],
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', nodePaths: [root + 'api/node_modules'] });
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const origin = 'https://sandbox.bayleaf.dev';
const sessionCookie = '__Host-bayleaf-sandbox-session=synthetic-session';
const transactionCookie = '__Host-bayleaf-sandbox-transaction=synthetic-verifier';
const calls = [], background = [];
let failWake = false, authenticated = true, validExchange = true;
const management = {
  async beginLogin(input) { calls.push(['begin', input]); return { flow: 'flow', authorizeUrl: 'https://api.bayleaf.dev/auth/services/authorize?flow=flow' }; },
  async proveLogin(input) { calls.push(['prove', input]); return { authorizeUrl: 'https://api.bayleaf.dev/auth/services/authorize?flow=flow' }; },
  async exchangeLogin(input) { calls.push(['exchange', input]); return validExchange ? { session: 'synthetic-session', expiresAt: Math.floor(Date.now()/1000)+3600 } : null; },
  async readSession(input) { calls.push(['read', input]); return authenticated ? { user: { email: 'owner@example.test', name: '<script>untrusted</script>' } } : null; },
  async logout(input) { calls.push(['logout', input]); return true; },
  async managed(input) {
    calls.push(['managed', input]);
    if (input.operation === 'wake-existing' && failWake) throw Error('synthetic unavailable');
    if (input.operation !== 'wake-existing' && !['openchamber', 'code-server', 'dufs', 'ttyd'].includes(input.service))
      return { status: 400, body: { error: 'invalid_operation' } };
    return { status: 200, body: { phase: 'idle', machine: 'absent' } };
  },
};
async function request(path, { method = 'GET', cookie, headers = {}, host = origin } = {}) {
  return worker.fetch(new Request(host + path, { method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } }),
    { MANAGEMENT: management }, { waitUntil(promise) { background.push(promise); } });
}
const mutations = () => calls.filter(([name, input]) => name === 'managed' && input.operation !== 'status');

let response = await request('/');
assert.equal(response.status, 200);
assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin', 'native sign-in forms need an Origin header');
let html = await response.text();
assert(html.includes('OpenChamber'));
assert(html.includes('code-server'));
assert(html.includes('Files (dufs)'));
assert(html.includes('Shell (ttyd)'));
assert(!html.includes('id="dufs-start"'));
assert(!html.includes('id="code-server-start"'));
assert(!html.includes('browser-restart'));
assert.equal(calls.length, 0, 'anonymous overview does not contact management');
assert.equal((await request('/', { method: 'HEAD' })).status, 200);
assert.equal((await request('/login')).status, 303);
assert.equal(calls.length, 0, 'prefetched login link is passive');
for (const badOrigin of [undefined, 'https://chat.bayleaf.dev', 'https://attacker.example']) {
  assert.equal((await request('/login', { method: 'POST', headers: badOrigin ? { Origin: badOrigin } : {} })).status, 403);
}
response = await request('/login', { method: 'POST', headers: { Origin: origin } });
assert.equal(response.status, 200);
assert.match(await response.text(), /http-equiv="refresh"/);
assert.match(calls.at(-1)[1].verifierHash, /^[a-f0-9]{64}$/);
assert.match(response.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
assert(!response.headers.get('Set-Cookie').includes('Domain='));
assert.equal(mutations().length, 0);
assert.equal((await request('/auth/prove?flow=flow')).status, 400);
assert.equal((await request('/auth/prove?flow=flow', { cookie: transactionCookie })).status, 303);
assert.equal((await request('/auth/callback?flow=flow&code=code')).status, 400);
validExchange = false;
assert.equal((await request('/auth/callback?flow=flow&code=code', { cookie: transactionCookie })).status, 400);
assert.equal(mutations().length, 0);
validExchange = true; failWake = true;
response = await request('/auth/callback?flow=flow&code=code', { cookie: transactionCookie });
assert.equal(response.status, 303, 'wake outage must not block login');
await Promise.all(background);
assert.equal(mutations().length, 1);
assert.equal(mutations()[0][1].operation, 'wake-existing');
assert.match(response.headers.get('Set-Cookie'), /__Host-bayleaf-sandbox-session=synthetic-session/);
for (let i=0; i<3; i++) {
  response = await request('/', { cookie: sessionCookie });
  html = await response.text();
  assert.match(response.headers.get('Cache-Control'), /\bno-store\b/);
  assert(!html.includes('<script>untrusted</script>'));
  assert.equal((await request('/services/openchamber/status', { cookie: sessionCookie })).status, 200);
}
assert.equal(mutations().length, 1, 'refresh and status never repeat login wake');
assert(html.includes('id="code-server-start"'));
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(ids).size,ids.length,'service controls have unique ids');
for (const service of ['code-server', 'dufs', 'ttyd', 'unknown']) {
  const path='/services/'+service;
  assert.equal((await request(path+'/status')).status,401);
  assert.equal((await request(path+'/status',{cookie:sessionCookie})).status,service!=='unknown'?200:400);
  assert.equal((await request(path+'/start',{method:'POST',cookie:sessionCookie})).status,403);
  assert.equal((await request(path+'/start',{method:'POST',cookie:sessionCookie,
    headers:{Origin:origin,'X-BayLeaf-Action':'managed-service'}})).status,service!=='unknown'?200:400);
}
assert.equal((await request('/services/openchamber/start', { method: 'POST' })).status, 401);
assert.equal((await request('/services/openchamber/start', { method: 'POST', cookie: sessionCookie,
  headers: { Origin: 'https://chat.bayleaf.dev', 'X-BayLeaf-Action': 'managed-service' } })).status, 403);
assert.equal((await request('/services/openchamber/start', { method: 'POST', cookie: sessionCookie,
  headers: { Origin: origin } })).status, 403);
assert.equal((await request('/services/openchamber/start', { method: 'POST', cookie: sessionCookie,
  headers: { Origin: origin, 'X-BayLeaf-Action': 'managed-service' } })).status, 200);
assert.deepEqual(calls.at(-1), ['managed', { session: 'synthetic-session', service: 'openchamber', operation: 'start' }]);
assert.equal((await request('/services/openchamber/start', { cookie: sessionCookie })).status, 405);
assert.equal((await request('/logout', { method: 'POST', cookie: sessionCookie })).status, 403);
response = await request('/logout', { method: 'POST', cookie: sessionCookie, headers: { Origin: origin } });
assert.equal(response.status, 303); assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
authenticated = false;
response = await request('/', { cookie: sessionCookie });
assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
assert.equal((await request('/', { host: 'https://attacker.example' })).status, 400);
assert.equal((await request('/services/openchamber/status', { method: 'OPTIONS' })).status, 405);
assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
console.log('PASS sandbox overview, host-only login, CSRF, escaped identity, one-shot wake, passive reads, service dispatch and logout');
