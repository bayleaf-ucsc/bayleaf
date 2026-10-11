/** Credential-free full-app tests: mock provider metadata and read-only KV. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: "export { default } from './src/index'; export { CampusPassResponseSchema } from './src/schemas';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', loader: { '.py': 'text' },
  // RPC is unrelated to these HTTP tests and must never be invoked here.
  plugins: [{ name: 'unused-worker-rpc', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'rpc', namespace: 'test-rpc' }));
    build.onLoad({ filter: /.*/, namespace: 'test-rpc' }, () => ({
      contents: 'export class WorkerEntrypoint { constructor() { throw new Error("RPC is out of scope"); } }',
    }));
  } }],
});
const { default: worker, CampusPassResponseSchema } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const realFetch = globalThis.fetch;
let calls = [], reads = [], serial = 0;
let key = { limit: 50, limit_remaining: 20, budgets: [], expires_at: null };
let account = { total_credits: 100, total_usage: 20 };
let keyStatus = 200, accountStatus = 200, fail = false;
let count = 27, kvFail = false;
let rawCounter;
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'test/model', name: 'Test model', pricing: { prompt: '0', completion: '0' } }] });
  calls.push({ url, options });
  if (fail) throw new Error('Synthetic provider failure');
  assert.equal(options.redirect, 'manual');
  assert.ok(options.signal);
  const isKey = url.endsWith('/key');
  return Response.json({ data: isKey ? key : account }, { status: isKey ? keyStatus : accountStatus });
};
const env = () => ({
  CAMPUS_IP_RANGES: '128.114.0.0/16,2607:f5f0::/32', CAMPUS_POOL_KEY: `synthetic-pool-${++serial}`,
  OPENROUTER_PROVISIONING_KEY: 'synthetic-management', CAMPUS_RPD_LIMIT: '100',
  RECOMMENDED_MODEL: 'test/model', SEALED_CURATED_MODELS: '',
  CAMPUS_RPD: {
    get: async (name, type) => {
      reads.push(name); if (kvFail) throw new Error('Synthetic KV failure');
      assert.equal(type, 'text');
      return rawCounter !== undefined ? rawCounter : JSON.stringify({ count });
    },
    put: () => { throw new Error('Inspection must not write'); },
  },
  DB: { prepare: () => { throw new Error('Inspection must not touch identities or provision'); } },
});
async function inspect(bindings, headers = { 'CF-Connecting-IP': '128.114.1.2' }) {
  const response = await worker.fetch(new Request('https://api.bayleaf.dev/campus-pass', {
    headers: { Origin: 'https://static.example', ...headers },
  }), bindings);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  CampusPassResponseSchema.parse(body);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('synthetic-') && !text.includes('total_credits') && !text.includes('limit_remaining'));
  assert.ok(!text.includes('128.114.1.2'));
  return body;
}
try {
  const bindings = env();
  let report = await inspect(bindings);
  assert.equal(report.campus_network, true);
  assert.equal(report.inference.status, 'available');
  assert.equal(report.shared_credit.status, 'available');
  assert.equal(report.quota.remaining, 73);
  assert.equal(new Date(report.quota.resets_at).getUTCHours(), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls.find(c => c.url.endsWith('/key')).options.headers.Authorization, `Bearer ${bindings.CAMPUS_POOL_KEY}`);
  assert.equal(calls.find(c => c.url.endsWith('/credits')).options.headers.Authorization, 'Bearer synthetic-management');
  count = 100;
  report = await inspect(bindings);
  assert.equal(report.inference.status, 'unavailable');
  assert.ok(report.inference.reasons.includes('quota_exhausted'));
  assert.equal(report.quota.remaining, 0);
  assert.equal(calls.length, 2, 'Provider cache reused; caller quota reread');
  count = 27;
  report = await inspect(bindings, { 'CF-Connecting-IP': '203.0.113.1' });
  assert.equal(report.campus_network, false);
  assert.equal(report.quota, null);
  assert.ok(report.inference.reasons.includes('off_campus'));
  report = await inspect(bindings, { 'X-Forwarded-For': '128.114.1.2' });
  assert.equal(report.campus_network, null);
  assert.equal(report.inference.status, 'unknown');
  assert.equal(report.quota, null);
  report = await inspect(bindings, { 'CF-Connecting-IP': '2607:f5f0:1:2::3' });
  assert.equal(report.campus_network, true);
  assert.ok(reads.at(-1).includes('2607:f5f0:1:2:'));
  report = await inspect({ ...env(), CAMPUS_POOL_KEY: '' });
  assert.equal(report.campus_network, true, 'Network membership independent of configuration');
  assert.equal(report.enabled, false);
  assert.ok(report.inference.reasons.includes('disabled'));
  report = await inspect({ ...env(), CAMPUS_IP_RANGES: '' });
  assert.equal(report.campus_network, null);
  assert.equal(report.enabled, false);
  for (const remaining of [0, -1]) {
    key.limit_remaining = remaining;
    report = await inspect(env());
    assert.equal(report.shared_credit.status, 'unavailable');
    assert.ok(report.inference.reasons.includes('pool_budget_exhausted'));
  }
  key.limit_remaining = 20;
  key.budgets = [{ remaining_usd: 0 }];
  assert.ok((await inspect(env())).inference.reasons.includes('pool_budget_exhausted'));
  key.budgets = [];
  key.effective_budget = { remaining_usd: -1 };
  assert.ok((await inspect(env())).inference.reasons.includes('pool_budget_exhausted'));
  delete key.effective_budget;
  key.expires_at = '2000-01-01T00:00:00Z';
  assert.ok((await inspect(env())).inference.reasons.includes('pool_key_unavailable'));
  key.expires_at = null;
  key.allowed_data_regions = [];
  assert.ok((await inspect(env())).inference.reasons.includes('pool_key_unavailable'));
  delete key.allowed_data_regions;
  account.total_usage = 100;
  assert.ok((await inspect(env())).inference.reasons.includes('shared_credit_exhausted'));
  account.total_usage = 20;
  keyStatus = 401;
  assert.ok((await inspect(env())).inference.reasons.includes('pool_key_unavailable'));
  keyStatus = 200;
  accountStatus = 403;
  report = await inspect(env());
  assert.equal(report.shared_credit.status, 'unknown', 'Management auth failure is not exhausted credit');
  accountStatus = 200;
  fail = true;
  report = await inspect(env());
  assert.equal(report.inference.status, 'unknown');
  assert.equal(report.quota.remaining, 73, 'Provider failure must not hide local quota');
  fail = false;
  kvFail = true;
  report = await inspect(env());
  assert.equal(report.inference.status, 'unknown');
  assert.equal(report.quota, null);
  kvFail = false;
  count = -1;
  assert.equal((await inspect(env())).quota, null, 'Corrupt quota is unknown, not extra allowance');
  count = 27;
  for (const malformed of ['{}', 'null', '{', '{"count":null}', '{"count":"12"}', '{"count":1.5}']) {
    rawCounter = malformed;
    report = await inspect(env());
    assert.equal(report.quota, null);
    assert.ok(report.inference.reasons.includes('quota_unknown'));
  }
  rawCounter = null;
  assert.equal((await inspect(env())).quota.remaining, 100, 'Missing KV entry means unused allowance');
  rawCounter = undefined;
  key = {};
  assert.equal((await inspect(env())).shared_credit.status, 'unknown');
  for (const malformed of [
    { limit: null, limit_remaining: 'broken' },
    { limit: 'broken', limit_remaining: 20 },
    { limit: -1, limit_remaining: 20 },
    { limit: 20, limit_remaining: null },
  ]) {
    key = malformed;
    assert.equal((await inspect(env())).shared_credit.status, 'unknown');
  }
  key = { limit: null, limit_remaining: null };
  assert.equal((await inspect(env())).shared_credit.status, 'available', 'Uncapped pool still requires account credit');
  assert.equal((await inspect({ ...env(), OPENROUTER_PROVISIONING_KEY: '' })).shared_credit.status, 'unknown');
  calls = [];
  const concurrent = env();
  await Promise.all(Array.from({ length: 8 }, () => inspect(concurrent)));
  assert.equal(calls.length, 2, 'Concurrent provider reads coalesced');
  const now = Date.now;
  try {
    Date.now = () => now() + 16_000;
    await inspect(concurrent);
    assert.equal(calls.length, 4, 'Provider cache expires');
  } finally { Date.now = now; }

  const preflight = await worker.fetch(new Request('https://api.bayleaf.dev/v1/chat/completions', {
    method: 'OPTIONS', headers: { Origin: 'https://static.example',
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  }), env());
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok(preflight.headers.get('Access-Control-Allow-Headers').toLowerCase().includes('content-type'));
  const spec = await (await worker.fetch(new Request('https://api.bayleaf.dev/docs/openapi.json'), env())).json();
  assert.deepEqual(spec.paths['/campus-pass'].get.security, []);
  assert.equal(spec.paths['/campus-pass'].get.operationId, 'inspectCampusPass');
  assert.ok(spec.components.schemas.CampusPassResponse);
  const llms = await (await worker.fetch(new Request('https://api.bayleaf.dev/llms.txt'), env())).text();
  assert.ok(llms.includes('### Build browser apps with Campus Pass'));
  assert.ok(llms.includes('credentials: "omit"'));
  console.log('PASS: Campus Pass states, trusted IPs, quotas, provider budgets, failures, cache, CORS, OpenAPI, and JS guidance');
} finally {
  globalThis.fetch = realFetch;
}
