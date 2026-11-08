/** Credential-free tests for GET /directory/{cruzid}: parser fixture plus full-app routing with mocked directory, KV and D1. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: "export { default } from './src/index'; export { parseDetailPage } from './src/routes/directory';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', loader: { '.py': 'text' },
  plugins: [{ name: 'unused-worker-rpc', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'rpc', namespace: 'test-rpc' }));
    build.onLoad({ filter: /.*/, namespace: 'test-rpc' }, () => ({
      contents: 'export class WorkerEntrypoint { constructor() { throw new Error("RPC is out of scope"); } }',
    }));
  } }],
});
const { default: worker, parseDetailPage } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

// Trimmed from the live page's structure (2026-11-07), photo omitted.
const FOUND = `<div id="profileHead"><div class="col1"><div class="imgwrapper">&nbsp;<img src="data:image/jpeg;base64, AAAA" alt="Ada Lovelace" /></div></div>
<div class="col2"><h2> <i class="fa fa-user-circle" title="User"></i> Ada Q Lovelace </h2>
<p> <i class="fa fa-address-book" title="User"></i> Professor &amp; Chair </p></div>
<div class="col2"><div><p> <i class="fa fa-phone" title="User"></i> 831-555-0100</p></div>
<div><h3><i class="fas fa-envelope" title="User"></i> <a href="mailto:alove@ucsc.edu" title="alove@ucsc.edu">alove@ucsc.edu</a></h3></div></div>
<div class="clear">&nbsp;</div></div>
<!-- profileHead -->
<div id="profileBody">
<div style="x"><p><label>Department/ College/ Unit</label> Computational Media</p></div>
<div style="x"><p><label>Web Site</label></p>
	<a href="https://example.edu/ada" title="Personal webpage" target="_BLANK">Personal webpage</a> <br /></div>
<div style="x"><p><label>Primary Office Location</label> Engineering Building 2<br />269</p></div>
<div style="x"><p><label>Research Interests</label> <ul>
<li>Analytical engines</li>
<li>Poetical science</li>
</ul></p></div>
</div></div><!-- profileBody -->`;

const parsed = parseDetailPage(FOUND);
assert.deepEqual(parsed, {
  name: 'Ada Q Lovelace', title: 'Professor & Chair', email: 'alove@ucsc.edu', phone: '831-555-0100',
  details: {
    'Department/ College/ Unit': 'Computational Media',
    'Primary Office Location': 'Engineering Building 2\n269',
    'Research Interests': ['Analytical engines', 'Poetical science'],
  },
  links: [{ title: 'Personal webpage', url: 'https://example.edu/ada' }],
});
assert.ok(!JSON.stringify(parsed).includes('base64'), 'photo is never returned');
assert.equal(parseDetailPage('<p>Could not find user</p>'), 'not_found');
assert.equal(parseDetailPage('<html>redesigned</html>'), null, 'unknown layout is not an empty profile');

// ── Full app ──
const kv = new Map();
let directoryPage = FOUND, directoryCalls = [];
globalThis.fetch = async (url, options) => {
  directoryCalls.push(url);
  assert.ok(url.startsWith('https://campusdirectory.ucsc.edu/cd_detail?uid='));
  assert.equal(options.redirect, 'manual');
  return new Response(directoryPage, { status: 200 });
};
const row = { email: 'owner@ucsc.edu', bayleaf_token: 'sk-bayleaf-test', revoked: 0, user_last_active_at: Math.floor(Date.now() / 1000) };
const env = (extra = {}) => ({
  DIRECTORY_ENABLED: 'true', DIRECTORY_RPD_LIMIT: '2', CAMPUS_IP_RANGES: '128.114.0.0/16', CAMPUS_POOL_KEY: 'synthetic-pool',
  CAMPUS_RPD: { get: async (k) => kv.has(k) ? JSON.parse(kv.get(k)) : null, put: async (k, v) => { kv.set(k, v); } },
  DB: { prepare: () => ({ bind: (token) => ({ first: async () => token === row.bayleaf_token ? row : null }) }) },
  ...extra,
});
const get = (path, headers = {}, bindings = env()) =>
  worker.fetch(new Request(`https://api.bayleaf.dev${path}`, { headers }), bindings, { waitUntil() {} });
const keyed = { Authorization: 'Bearer sk-bayleaf-test' };

assert.equal((await get('/directory/alove', keyed, env({ DIRECTORY_ENABLED: 'false' }))).status, 503);
assert.equal((await get('/directory/alove')).status, 401);
assert.equal((await get('/directory/alove', { 'CF-Connecting-IP': '128.114.1.2' })).status, 403, 'Campus Pass is anonymous');
assert.equal((await get('/directory/a%20b', keyed)).status, 400);
assert.equal(directoryCalls.length, 0, 'no upstream call before auth and validation');

let res = await get('/directory/ALOVE', keyed);
assert.equal(res.status, 200);
assert.equal(res.headers.get('cache-control'), 'no-store');
const body = await res.json();
assert.equal(body.cruzid, 'alove');
assert.equal(body.source_url, 'https://campusdirectory.ucsc.edu/cd_detail?uid=alove');
assert.equal(body.email, 'alove@ucsc.edu');

directoryPage = '<p>Could not find user</p>';
assert.equal((await get('/directory/nobody', keyed)).status, 404);
assert.equal((await get('/directory/alove', keyed)).status, 429, 'misses count toward the cap');
assert.equal(directoryCalls.length, 2, 'capped request makes no upstream call');
for (const key of kv.keys()) assert.ok(!key.includes('owner') && !key.includes('alove'), 'counter key holds no identity or target');

// ── /whoami shares the credential-kind plumbing in resolveAuth ──
assert.deepEqual(await (await get('/whoami', keyed)).json(), { credential: 'key', email: 'owner@ucsc.edu' });
assert.deepEqual(await (await get('/whoami', { 'CF-Connecting-IP': '128.114.1.2' })).json(), { credential: 'campus', email: null });
assert.equal((await get('/whoami')).status, 401);
assert.equal((await get('/whoami', { Authorization: 'Bearer sk-bayleaf-wrong' })).status, 401);
assert.equal((await get('/whoami', keyed)).headers.get('cache-control'), 'no-store');

console.log('PASS: directory parser, auth gating, validation, not-found, cap and storage hygiene; whoami reflection');
