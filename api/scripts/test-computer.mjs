#!/usr/bin/env node
/** Credential-free full-app HTTP tests with fail-closed D1 and Toolbox mocks.
 * No .dev.vars, provider credentials, real network, compute or screenshots.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';

const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
  export { default } from './src/index';
  export { COMPUTER_GENERATION_COMMAND } from './src/computerUse';
  export { seal, hash } from './src/grants';
  export { sign } from 'hono/jwt';
` }, bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', loader: { '.py': 'text', '.md': 'text' },
  plugins: [{ name: 'unused-worker-rpc', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'rpc', namespace: 'test-rpc' }));
    b.onLoad({ filter: /.*/, namespace: 'test-rpc' }, () => ({
      contents: 'export class WorkerEntrypoint { constructor() { throw new Error("RPC out of scope"); } }',
    }));
  } }],
});
const { default: worker, COMPUTER_GENERATION_COMMAND, seal, hash, sign } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
let id = 'synthetic-machine', generation = ['11111111-2222-3333-4444-555555555555', '293', '121700320'];
let row = { email: 'owner@example.test', account_generation: 'synthetic-account',
  bayleaf_token: 'sk-bayleaf-synthetic', revoked: 0, user_last_active_at: Math.floor(Date.now() / 1000) };
let activeCredential = true, revoked = false, pascal = false, probeOutput, probeExit = 0;
let grant;
let toolboxStatus = 200, throwToolbox = false, imageStatus = 200, imageType = 'image/png';
let calls = [], queries = [], requests = [], screenshotSeen = false, probeSeen = false, parallelProbe = false;
let requireParallel = false, logs = [];
const realFetch = globalThis.fetch, realError = console.error;
const sandboxToken = 'sk-bayleaf-sandbox-' + 'a'.repeat(64);
const env = {
  OIDC_CLIENT_SECRET: 'synthetic-session-secret', DAYTONA_API_KEY: 'synthetic-provider-secret',
  DAYTONA_API_URL: 'https://control.example.test', DAYTONA_PROXY_URL: 'https://proxy.example.test/toolbox',
  DAYTONA_DEPLOYMENT_LABEL: 'test-label', CAMPUS_IP_RANGES: '192.0.2.0/24', CAMPUS_POOL_KEY: 'synthetic-campus', GRANTS_ENABLED: 'true',
  DB: { prepare(sql) { return { bind(...values) { return {
    async first() {
      queries.push({ sql, values });
      if (sql.includes('FROM inference_grants')) return grant;
      if (sql.includes('FROM sandbox_credentials WHERE token_hash')) return activeCredential
        ? { id: 'credential', email: row.email, sandbox_id: id } : null;
      if (sql.startsWith('SELECT daytona_sandbox_id')) {
        assert.ok(sql.includes('revoked=0') || sql.includes("sc.state='active'"));
        return revoked ? null : { daytona_sandbox_id: id };
      }
      if (sql.includes('FROM user_keys WHERE bayleaf_token')) return values[0] === row.bayleaf_token && !revoked ? { ...row, daytona_sandbox_id: id } : null;
      if (sql.includes('FROM user_keys WHERE email')) return { ...row, daytona_sandbox_id: id };
      throw new Error('Unexpected D1 read');
    },
    async run() { throw new Error('No D1 mutation expected'); },
  }; } }; } },
};
console.error = (...args) => logs.push(args.join(' '));
globalThis.fetch = async (url, init) => {
  url = String(url); calls.push({ url, init });
  assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
  assert.equal(init.headers.Authorization, 'Bearer synthetic-provider-secret');
  if (url === `https://control.example.test/sandbox/${id}`) {
    assert.equal(init.method, 'GET');
    return Response.json({ id, state: 'started', labels: { 'test-label': row.email }, toolboxProxyUrl: 'https://regional.example.test/toolbox' });
  }
  assert.match(url, /^https:\/\/(proxy|regional)\.example\.test\/toolbox\/synthetic-machine\//);
  assert.equal(init.cache, 'no-store');
  if (throwToolbox) throw new Error('Do not log typed content or synthetic-provider-secret');
  if (url.endsWith('/process/execute')) {
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { command: COMPUTER_GENERATION_COMMAND, timeout: 5000 });
    probeSeen = true;
    if (requireParallel) {
      // fetch screenshot starts first; its response must not need to finish
      // before the generation probe starts.
      parallelProbe = screenshotSeen;
    }
    if (toolboxStatus !== 200) return Response.json({ message: 'Do not relay provider details' }, { status: toolboxStatus });
    const value = probeOutput ?? JSON.stringify([generation]);
    return Response.json(pascal ? { Result: value, ExitCode: probeExit } : { result: value, exitCode: probeExit });
  }
  assert.ok(url.includes('/computeruse/'), 'Only the constant read-only probe may use another Toolbox path');
  if (url.includes('/screenshot')) {
    screenshotSeen = true;
    await Promise.resolve();
    assert.ok(!requireParallel || probeSeen, 'Generation probe must start before image response completes');
    const body = imageType === 'application/json' ? JSON.stringify(pascal ? { Screenshot: 'c3ludGhldGlj' } : { screenshot: 'c3ludGhldGlj' }) : 'synthetic-image-not-real-content';
    return new Response(body, { status: imageStatus, headers: { 'Content-Type': imageType, 'Set-Cookie': 'must-not-forward=1', 'X-Provider-Secret': 'must-not-forward' } });
  }
  if (toolboxStatus !== 200) return Response.json({}, { status: toolboxStatus });
  if (url.endsWith('/display/info')) return Response.json(pascal
    ? { Displays: [{ X: 0, Y: 0, Width: 1024, Height: 768 }] } : { displays: [{ x: 0, y: 0, width: 1024, height: 768 }] });
  if (url.endsWith('/display/windows')) return Response.json(pascal
    ? { Windows: [{ Id: 392, Title: 'Panel', X: 0, Y: 0, Width: 0, Height: 0 }] } : { windows: [] });
  assert.equal(init.method, 'POST');
  requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
  assert.ok(!('session' in requests.at(-1).body), 'Never forward a handle to Toolbox');
  return Response.json({});
};
async function call(path, body = {}, token = row.bayleaf_token) {
  const r = await worker.fetch(new Request(`https://api.example.test/sandbox/computer/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.3', Origin: 'https://client.example.test' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env);
  // The existing global grant gate rejects before the computer sub-app runs.
  if (!token.startsWith('sk-bayleaf-grant-')) assert.equal(r.headers.get('Cache-Control'), 'no-store');
  return r;
}
async function expectCode(path, body, status, code, token) {
  const r = await call(path, body, token);
  assert.equal(r.status, status);
  const data = await r.json(); if (code) assert.equal(data.error.code, code);
  return data;
}
async function open(token) {
  const r = await call('session', {}, token); assert.equal(r.status, 200);
  return (await r.json()).session;
}
try {
  await expectCode('session', {}, 403, 'owner_required', 'campus');
  // Global temporary-token gate must reject before Toolbox, including a
  // malformed token whose prefix otherwise overlaps ordinary owner keys.
  await expectCode('session', {}, 401, 'invalid_token', 'sk-bayleaf-grant-synthetic');
  grant = { id: 'synthetic-grant', name: null, owner_email: row.email,
    owner_token_hash: await hash(row.bayleaf_token), expires_at: Math.floor(Date.now() / 1000) + 600,
    models_json: '["openrouter:test/model"]' };
  const grantToken = 'sk-bayleaf-grant-' + await seal(env, 'access', { id: grant.id, exp: grant.expires_at });
  await expectCode('session', {}, 403, 'insufficient_scope', grantToken);
  await expectCode('session', {}, 401, undefined, 'sk-bayleaf-invalid');
  assert.equal(calls.length, 0); assert.equal(queries.length, 3);
  for (const path of ['mouse/move', 'mouse/click', 'mouse/drag', 'mouse/scroll', 'mouse/down', 'mouse/up',
    'keyboard/type', 'keyboard/press', 'keyboard/hotkey', 'keyboard/down', 'keyboard/up',
    'screenshot', 'screenshot/compressed', 'display/info', 'display/windows']) {
    await expectCode(path, {}, 403, 'owner_required', 'campus');
    await expectCode(path, {}, 403, 'insufficient_scope', grantToken);
  }
  assert.equal(calls.length, 0, 'Every computer method rejects non-owner auth before Toolbox');
  id = null; await expectCode('session', {}, 409, 'sandbox_not_running'); assert.equal(calls.length, 0); id = 'synthetic-machine';
  revoked = true; await expectCode('session', {}, 401); revoked = false;
  for (const status of [409, 503, 404, 410, 302]) {
    toolboxStatus = status;
    await expectCode('session', {}, status === 404 || status === 410 ? 410 : 409, 'sandbox_not_running');
  }
  toolboxStatus = 200;
  for (const output of ['[]', '[[]]', JSON.stringify([generation, generation]), 'not json', JSON.stringify([['bad-boot', '293', '12']]),
    JSON.stringify([[generation[0], 293, '12']]), JSON.stringify([[generation[0], '293', '0']]), 'x'.repeat(513)]) {
    probeOutput = output; await expectCode('session', {}, 409, 'desktop_not_running');
  }
  probeOutput = undefined; probeExit = 1; await expectCode('session', {}, 409, 'desktop_not_running'); probeExit = 0;
  const handle = await open(), handle2 = await open(); assert.notEqual(handle, handle2, 'Random nonce per open');
  const signingSecret = env.OIDC_CLIENT_SECRET;
  env.OIDC_CLIENT_SECRET = '';
  await expectCode('session', {}, 502, 'computer_unavailable');
  await expectCode('display/info', { session: handle }, 410, 'session_ended');
  env.OIDC_CLIENT_SECRET = signingSecret;
  const payload = JSON.parse(Buffer.from(handle.split('.')[1], 'base64url'));
  for (const changes of [{ exp: 1 }, { sandbox: 'other-machine' }, { purpose: 'other-purpose' }]) {
    const altered = await sign({ ...payload, ...changes }, 'bayleaf-computer-session-v1:' + env.OIDC_CLIENT_SECRET, 'HS256');
    await expectCode('display/info', { session: altered }, 410, 'session_ended');
  }
  const tokenParts = handle.split('.'); tokenParts[1] = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url');
  const beforeTamper = calls.length;
  await expectCode('keyboard/type', { session: tokenParts.join('.'), text: 'secret' }, 410, 'session_ended');
  assert.equal(calls.length, beforeTamper, 'Tampered handle must not reach Toolbox');
  const originalGeneration = [...generation];
  for (const change of [[generation[0], '294', generation[2]], [generation[0], generation[1], '121700321'],
    ['aaaaaaaa-2222-3333-4444-555555555555', generation[1], generation[2]]]) {
    generation = change; await expectCode('screenshot', { session: handle }, 410, 'session_ended');
  }
  generation = originalGeneration;
  const oldAccount = row.account_generation; row.account_generation = 'replacement-account';
  await expectCode('display/info', { session: handle }, 410, 'session_ended'); row.account_generation = oldAccount;
  const oldEmail = row.email; row.email = 'another-owner@example.test';
  await expectCode('display/info', { session: handle }, 410, 'session_ended'); row.email = oldEmail;
  for (const [path, action] of Object.entries({
    'mouse/move': { x: 10, y: 20 }, 'mouse/click': { x: 10, y: 20 },
    'mouse/drag': { startX: 10, startY: 20, endX: 30, endY: 40 },
    'mouse/scroll': { x: 10, y: 20, direction: 'down', amount: 3 }, 'mouse/down': {}, 'mouse/up': {},
    'keyboard/type': { text: 'Hello\n世界' }, 'keyboard/press': { key: 'enter' },
    'keyboard/hotkey': { keys: 'ctrl+u' }, 'keyboard/down': { key: 'shift' }, 'keyboard/up': { key: 'shift' },
  })) {
    const before = calls.length;
    const r = await call(path, { session: handle, ...action }); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { success: true });
    assert.equal(calls.length, before + 1, 'No readiness ritual per action');
    assert.ok(requests.at(-1).path.endsWith(path === 'keyboard/press' ? '/keyboard/key' : '/' + path));
  }
  for (const [path, body] of [['mouse/down', { x: 3 }], ['mouse/move', { x: -1, y: 0 }], ['keyboard/type', { text: '\t' }],
    ['screenshot/compressed', { scale: 2 }], ['keyboard/type', { text: 'a', actions: [] }]]) {
    const before = calls.length; await expectCode(path, { session: handle, ...body }, 400, 'invalid_request'); assert.equal(calls.length, before);
  }
  await expectCode('keyboard/type', '{bad secret input', 400, 'invalid_request');
  await expectCode('keyboard/type', 'x'.repeat(32769), 400, 'invalid_request');
  pascal = true;
  const pascalHandle = await open();
  assert.deepEqual(await (await call('display/info', { session: pascalHandle })).json(), { displays: [{ x: 0, y: 0, width: 1024, height: 768 }] });
  assert.equal((await (await call('display/windows', { session: pascalHandle })).json()).windows[0].title, 'Panel');
  for (const [path, options, expected] of [
    ['screenshot', {}, '/screenshot?'],
    ['screenshot', { region: { x: 1, y: 2, width: 3, height: 4 } }, '/screenshot/region?'],
    ['screenshot/compressed', { format: 'jpeg', quality: 70, scale: 0.5 }, '/screenshot/compressed?'],
    ['screenshot/compressed', { region: { x: 1, y: 2, width: 3, height: 4 }, format: 'webp' }, '/screenshot/region/compressed?'],
  ]) {
    requireParallel = true; screenshotSeen = probeSeen = parallelProbe = false;
    const r = await call(path, { session: pascalHandle, ...options }); assert.equal(r.status, 200);
    assert.equal(await r.text(), 'synthetic-image-not-real-content');
    assert.equal(r.headers.get('Set-Cookie'), null); assert.equal(r.headers.get('X-Provider-Secret'), null);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(parallelProbe); assert.ok(calls.slice(-2).some(c => c.url.includes(expected)));
    requireParallel = false;
  }
  imageType = 'application/json';
  assert.equal((await (await call('screenshot', { session: pascalHandle })).json()).Screenshot, 'c3ludGhldGlj');
  imageStatus = 503; await expectCode('screenshot', { session: handle }, 410, 'session_ended'); imageStatus = 200;
  toolboxStatus = 503; await expectCode('screenshot', { session: handle }, 410, 'session_ended');
  await expectCode('mouse/click', { session: handle, x: 1, y: 1 }, 410, 'session_ended'); toolboxStatus = 200;
  throwToolbox = true; await expectCode('screenshot', { session: handle }, 410, 'session_ended'); throwToolbox = false;
  imageType = 'text/html'; await expectCode('screenshot', { session: handle }, 410, 'session_ended'); imageType = 'image/png';
  const sandboxHandle = await open(sandboxToken);
  assert.ok(calls.at(-1).url.startsWith('https://regional.example.test/'), 'Reuse toolboxProxyUrl already obtained by sandbox-credential auth');
  assert.equal((await call('mouse/move', { session: sandboxHandle, x: 1, y: 1 }, sandboxToken)).status, 200);
  activeCredential = false; await expectCode('session', {}, 401, undefined, sandboxToken); activeCredential = true;
  assert.equal(logs.length, 0, 'No content-bearing exception reaches the generic logger');
  assert.ok(calls.every(({ url }) => !/\/(start|stop|sandbox\?|last-activity|files\/)/.test(url)), 'No wake/create/start/exec ritual/file upload');

  // Run the exact Python probe against virtual /proc fixtures, not the host's
  // processes. Field 22 must survive spaces and multiple ')' inside stat comm.
  const code = COMPUTER_GENERATION_COMMAND.slice("python3 -c '".length, -1);
  for (const [count, expectedCount] of [[0, 0], [1, 1], [2, 2]]) {
    const fixture = `import sys,types,json
class Path:
    def __init__(self,p): self.p=p
    def __truediv__(self,n): return Path(self.p+"/"+n)
    @property
    def name(self): return self.p.split("/")[-1]
    def iterdir(self): return [Path("/proc/"+str(n)) for n in range(100,100+${count})]+[Path("/proc/not-a-pid"),Path("/proc/999")]
    def read_text(self):
        if self.p.endswith("boot_id"): return "11111111-2222-3333-4444-555555555555\\n"
        if self.p.endswith("comm"): return "Other" if "/999/" in self.p else "Xvfb\\n"
        if self.p.endswith("stat"): return "100 (Xvfb (name) strange)) S " + "0 "*18 + "12345 99"
        raise AssertionError(self.p)
    def read_bytes(self): return b"/usr/bin/Xvfb\\0:0\\0-screen\\00\\0"
sys.modules["pathlib"]=types.SimpleNamespace(Path=Path)
exec(${JSON.stringify(code)})`;
    const child = spawnSync('python3', ['-c', fixture], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    const triples = JSON.parse(child.stdout); assert.equal(triples.length, expectedCount);
    for (const triple of triples) assert.equal(triple[2], '12345');
  }
  console.log('PASS computer-use: full-app auth, no lifecycle, generation triples, signatures, case tolerance, single actions, streaming screenshots and parallel checks');
} finally { globalThis.fetch = realFetch; console.error = realError; }
