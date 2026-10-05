/** Synthetic billing and SSR checks. No credentials, real spend, or provisioning. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';

const bundle = await build({
  stdin: {
    contents: `export { getTinfoilUsage } from './src/tinfoil';
      export { DashboardPage } from './src/templates/dashboard';
      export { renderPage } from './src/templates/layout';
      export { Hono } from 'hono';`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx',
});
const { getTinfoilUsage, DashboardPage, renderPage, Hono } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const originalFetch = globalThis.fetch;
const env = { TINFOIL_ADMIN_KEY: 'admin_synthetic' };
const start = new Date('2026-10-01T00:00:00Z');
const end = new Date('2026-10-04T12:00:00Z');
const billing = { cost: 1.88, prompt_tokens: 100000, completion_tokens: 2345, requests: 91 };
try {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/api/billing/usage/key');
    assert.equal(new URL(url).searchParams.get('start'), start.toISOString());
    assert.equal(new URL(url).searchParams.get('end'), end.toISOString());
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer admin_synthetic');
    assert.deepEqual(JSON.parse(options.body), { key: 'tk_synthetic' });
    return Response.json({ ...billing, key: 'must_not_escape', unexpected: 'ignored' });
  };
  assert.equal(await getTinfoilUsage(null, start, end, env), null);
  assert.equal(await getTinfoilUsage('tk_synthetic', start, end, {}), null);
  assert.equal(calls, 0, 'An unprovisioned account must not make any provider calls');
  assert.deepEqual(await getTinfoilUsage('tk_synthetic', start, end, env), billing);

  for (const status of [302, 401, 403, 429, 500]) {
    globalThis.fetch = async () => new Response('provider failure', { status });
    assert.equal(await getTinfoilUsage('tk_synthetic', start, end, env), null);
  }
  for (const body of [null, {}, { ...billing, cost: '1.88' }, { ...billing, cost: -1 },
    { ...billing, prompt_tokens: null }, { ...billing, completion_tokens: 1.5 }]) {
    globalThis.fetch = async () => Response.json(body);
    assert.equal(await getTinfoilUsage('tk_synthetic', start, end, env), null);
  }
  globalThis.fetch = async () => new Response('not JSON');
  assert.equal(await getTinfoilUsage('tk_synthetic', start, end, env), null);
  globalThis.fetch = async () => { throw new DOMException('Timed out', 'TimeoutError'); };
  assert.equal(await getTinfoilUsage('tk_synthetic', start, end, env), null);
  globalThis.fetch = async () => Response.json({ ...billing, cost: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0 });
  assert.equal((await getTinfoilUsage('tk_synthetic', start, end, env)).cost, 0);
} finally {
  globalThis.fetch = originalFetch;
}

const usage = { count: 91, limit: 500, hasProviderKey: true, today: billing, month: { ...billing, cost: 5.25 } };
const props = {
  session: { email: 'synthetic@ucsc.edu', name: 'Synthetic Preview' },
  row: {}, orKey: null, recommendedModel: 'openai/gpt-oss-120b',
  sealedEnabled: true, sealedRecommendedModel: 'glm-5-3', sealedUsage: usage,
};
const render = async (sealedUsage = usage) => {
  const app = new Hono();
  app.get('/', c => renderPage(c, DashboardPage({ ...props, sealedUsage })));
  return (await app.request('http://localhost/')).text();
};
const sealedCard = html => html.split('<h2>Sealed LLM Inference</h2>')[1].split('<h2>')[0];
const html = await render();
const card = sealedCard(html);
for (const expected of ['91', '409', '500', '$1.8800', '$5.2500', '102,345', 'midnight UTC', 'not a dollar budget']) {
  assert.ok(card.includes(expected), `Expected rendered Sealed usage: ${expected}`);
}
assert.ok(!card.includes('Dollars Remaining'));
assert.ok(!html.includes('admin_synthetic') && !html.includes('tk_synthetic'));
const partial = sealedCard(await render({ ...usage, today: null }));
assert.ok(partial.includes('Unavailable') && partial.includes('$5.2500'));
const unavailable = sealedCard(await render({ ...usage, today: null, month: null }));
assert.ok(unavailable.includes('409') && unavailable.includes('billing usage is unavailable'));
assert.ok(!unavailable.includes('$0.0000'));
const unprovisioned = sealedCard(await render({ ...usage, hasProviderKey: false, today: null, month: null }));
assert.ok(unprovisioned.includes('first Sealed request') && !unprovisioned.includes('$0.0000'));
const exceeded = sealedCard(await render({ ...usage, count: 501 }));
assert.ok(!exceeded.includes('>-1<'));
const zero = sealedCard(await render({ ...usage, today: { ...billing, cost: 0 } }));
assert.ok(zero.includes('$0.0000'));
console.log('Sealed dashboard billing and rendering checks passed.');

// Exercise the real dashboard handler with synthetic session/row lookups.
// Only these route dependencies are stubbed; billing and rendering are real.
const routeBundle = await build({
  stdin: { contents: "export { dashboardRoutes } from './src/routes/dashboard';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  loader: { '.py': 'text' },
  jsx: 'automatic', jsxImportSource: 'hono/jsx',
  plugins: [{ name: 'synthetic-dashboard-identity', setup(build) {
    build.onResolve({ filter: /(?:provision|utils\/session)$/ }, args => {
      if (!args.importer.endsWith('/routes/dashboard.tsx')) return;
      return { path: args.path, namespace: 'fixture' };
    });
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
      contents: args.path.endsWith('session')
        ? 'export async function getSession() { return globalThis.dashboardFixture.session; }'
        : `export async function getActiveRow() { return globalThis.dashboardFixture.row; }
           export async function resolveOrKeyInfo() { return null; }`,
      loader: 'js',
    }));
  } }],
});
const { dashboardRoutes } = await import(
  `data:text/javascript;base64,${Buffer.from(routeBundle.outputFiles[0].text).toString('base64')}`
);
const fixtureEnv = { SEALED_ENABLED: 'true', SEALED_RPD_LIMIT: '500', SEALED_RECOMMENDED_MODEL: 'glm-5-3',
  RECOMMENDED_MODEL: 'openai/gpt-oss-120b', ...env };
globalThis.dashboardFixture = { session: props.session,
  row: { tinfoil_key: 'tk_synthetic', sealed_rpd_count: 91, sealed_rpd_date: '2000-01-01' } };
try {
  const starts = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/billing/usage/key');
    assert.deepEqual(JSON.parse(options.body), { key: 'tk_synthetic' });
    starts.push(new URL(url).searchParams.get('start'));
    return Response.json(billing);
  };
  const response = await dashboardRoutes.request('http://localhost/dashboard', {}, fixtureEnv);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const routeCard = sealedCard(await response.text());
  assert.ok(routeCard.includes('>0</div>'), 'Stale daily counter is displayed as zero');
  assert.equal(starts.length, 2);
  const now = new Date();
  assert.ok(starts.includes(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`));
  assert.ok(starts.includes(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()));
  globalThis.dashboardFixture.row.tinfoil_key = null;
  const before = starts.length;
  const absentKey = await dashboardRoutes.request('http://localhost/dashboard', {}, fixtureEnv);
  assert.ok((await absentKey.text()).includes('first Sealed request'));
  assert.equal(starts.length, before);
  const disabled = await dashboardRoutes.request('http://localhost/dashboard', {}, { ...fixtureEnv, SEALED_ENABLED: 'false' });
  assert.ok(!(await disabled.text()).includes('<h2>Sealed LLM Inference</h2>'));
  assert.equal(starts.length, before);
  globalThis.dashboardFixture.session = null;
  const anonymous = await dashboardRoutes.request('http://localhost/dashboard', {}, fixtureEnv);
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('Location'), '/login');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.dashboardFixture;
}
console.log('Sealed dashboard route checks passed.');

if (process.argv.includes('--serve')) {
  createServer(async (req, res) => {
    const state = new URL(req.url, 'http://localhost').searchParams.get('state');
    const previewUsage = state === 'unavailable' ? { ...usage, today: null, month: null }
      : state === 'unprovisioned' ? { ...usage, hasProviderKey: false, today: null, month: null } : usage;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(await render(previewUsage));
  }).listen(8789, '127.0.0.1', () => console.log('Synthetic dashboard preview: http://127.0.0.1:8789'));
}
