/** Full API app, real signed synthetic sessions, fake DB and all outbound fetch denied.
 * No scripts are executed and no collector/provider request can leave this test. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const api = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: api, stdin: {
  contents: "export { default } from './src/index'; export { sign } from 'hono/jwt';",
  resolveDir: api }, bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', loader: { '.py': 'text' },
  plugins: [{ name: 'unused-worker-rpc', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'rpc', namespace: 'test-rpc' }));
    build.onLoad({ filter: /.*/, namespace: 'test-rpc' }, () => ({
      contents: 'export class WorkerEntrypoint { constructor() { throw new Error("RPC out of scope"); } }',
    }));
  } }],
});
const { default: worker, sign } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const secret = 'synthetic-only-session-signing-secret';
const token = await sign({ email: 'synthetic@example.test', name: 'Synthetic User',
  exp: Math.floor(Date.now() / 1000) + 3600 }, secret, 'HS256');
const realFetch = globalThis.fetch;
const outgoing = [];
globalThis.fetch = async (...args) => { outgoing.push(args); throw new Error('Outbound traffic forbidden'); };
const reads = [];
const bindings = {
  OIDC_CLIENT_SECRET: secret, OIDC_LOGIN_BUTTON_TEXT: 'Synthetic sign-in',
  RECOMMENDED_MODEL: 'synthetic/model', CAMPUS_IP_RANGES: '',
  BROWSER_ARRIVALS_ENABLED: 'false', TELEMETRY_ENABLED: 'false',
  DB: { prepare(sql) {
    assert.match(sql, /^SELECT\b/, 'Only synthetic read-only SQL is permitted');
    reads.push(sql);
    return { bind() { return this; }, async first() {
      return sql.includes('last_active_at FROM users') ? { last_active_at: Math.floor(Date.now() / 1000) } : null;
    } };
  } },
};
async function request(path, enabled, cookie) {
  const response = await worker.fetch(new Request('https://api.bayleaf.dev' + path, {
    headers: cookie ? { Cookie: 'bayleaf_session=' + cookie } : {},
  }), { ...bindings, BROWSER_ARRIVALS_ENABLED: enabled });
  return { response, html: await response.text() };
}
try {
  for (const enabled of [undefined, 'false', 'TRUE', true, 'true']) {
    let { response, html } = await request('/', enabled);
    assert.equal(response.status, 200);
    assert.equal(html.includes('BayLeafArrival.publicArrival("api",true)'), enabled === 'true');
    ({ response, html } = await request('/', enabled, token));
    assert.equal(response.status, 302, 'Authenticated root redirects before landing render');
    assert.equal(response.headers.get('Location'), '/dashboard');
    assert(!html.includes('BayLeafArrival'));
    ({ response, html } = await request('/dashboard', enabled, token));
    assert.equal(response.status, 200);
    assert(!html.includes('BayLeafArrival') && !html.includes('telemetry.bayleaf.dev/v1/browser'));
    ({ response, html } = await request('/dashboard', enabled));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/login');
    assert(!html.includes('BayLeafArrival'));
  }
  assert.equal((await request('/', 'true', 'invalid-synthetic-session')).response.status, 200);
  assert(reads.length > 0, 'Real session verification exercised account reads');
  assert.deepEqual(outgoing, [], 'No collector or provider sends');
} finally { globalThis.fetch = realFetch; }
console.log('PASS full API app: anonymous exact-true root only, signed-session root redirect, private dashboard absence, zero outbound requests');
