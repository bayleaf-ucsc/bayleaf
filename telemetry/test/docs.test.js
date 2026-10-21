import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openapi } from '../src/openapi.js';
import { DOCS_HTML, SCALAR_URL } from '../src/docs.js';
import { createWorker } from '../src/worker.js';
import { LIMITS, METRICS, SCHEMA_VERSION, POLICY_VERSION } from '../src/policies.js';
import { BROWSER_SCHEMA_VERSION, BROWSER_POLICY_VERSION } from '../src/browser-policy.js';
import { TABLES } from '../src/store.js';

const schemas = openapi.components.schemas;
const worker = createWorker();

test('public GET/HEAD docs bypass switches, credentials, clock and database, without reflecting requests', async () => {
  const unreachable = () => { throw new Error('public docs must not access private state'); };
  const w = createWorker({ clock: unreachable });
  for (const state of ['false', 'true']) {
    const env = { TELEMETRY_ENABLED: state, BROWSER_ENABLED: state };
    for (const name of ['READ_SECRET', 'WRITE_KEYS_JSON', 'TELEMETRY_DB']) Object.defineProperty(env, name, { get: unreachable });
    for (const path of ['/docs', '/docs/openapi.json']) {
      const url = `https://telemetry.invalid${path}?private=do-not-reflect`;
      const get = await w.fetch(new Request(url, { headers: { Authorization: 'Bearer do-not-reflect' } }), env);
      const head = await w.fetch(new Request(url, { method: 'HEAD' }), env);
      assert.equal(get.status, 200);
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      assert.deepEqual([...get.headers], [...head.headers]);
      assert.equal(get.headers.get('Cache-Control'), 'no-store');
      assert.equal(get.headers.get('Referrer-Policy'), 'no-referrer');
      assert.equal(get.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.doesNotMatch(await get.text(), /do-not-reflect/);
      const post = await w.fetch(new Request(url, { method: 'POST' }), env);
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('Allow'), 'GET, HEAD');
    }
  }
  assert.equal((await worker.fetch(new Request('https://telemetry.invalid/v1/read/browser?from=1&to=2&limit=1'), {})).status, 503);
  assert.equal((await worker.fetch(new Request('https://telemetry.invalid/v1/browser', { method: 'POST' }), {})).status, 503);
});

test('Scalar keeps canonical spec, disabled requests and telemetry, source-map CSP allowance and beacon block', async () => {
  assert.match(SCALAR_URL, /@scalar\/api-reference@\d+\.\d+\.\d+\/dist\/browser\/standalone\.js$/);
  assert.match(DOCS_HTML, /lang="en"/);
  assert.match(DOCS_HTML, /data-url="\/docs\/openapi.json"/);
  for (const setting of ['"hideClientButton":true', '"hideTestRequestButton":true', '"persistAuth":false', '"telemetry":false', '"withDefaultFonts":false']) assert.ok(DOCS_HTML.includes(setting));
  assert.match(DOCS_HTML, /no-referrer/);
  assert.doesNotMatch(DOCS_HTML, /<p>|Do not enter credentials/);
  const r = await worker.fetch(new Request('https://telemetry.invalid/docs'), {});
  const csp = r.headers.get('Content-Security-Policy');
  assert.ok(csp.includes(`script-src ${SCALAR_URL}`));
  assert.ok(csp.includes(`connect-src 'self' ${SCALAR_URL}.map;`));
  assert.ok(!csp.includes('cloudflareinsights.com'));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(!csp.includes("script-src 'unsafe-inline'"));
});

test('spec contains exactly the named GET reads with only operator authorization', () => {
  assert.deepEqual(Object.keys(openapi.paths).sort(), Object.keys(TABLES).map(k => `/v1/read/${k}`).sort());
  assert.deepEqual(Object.keys(openapi.components.securitySchemes), ['OperatorBearer']);
  assert.deepEqual(Object.values(openapi.paths).map(p => p.get.summary), ['Browser arrivals', 'Metrics', 'Sandbox lifecycle counts', 'Probe runs', 'Deletion reports', 'Source status']);
  for (const path of Object.values(openapi.paths)) {
    assert.deepEqual(Object.keys(path), ['get']);
    assert.deepEqual(path.get.security, [{ OperatorBearer: [] }]);
  }
  assert.equal(openapi.info.title, 'BayLeaf telemetry');
  assert.ok(openapi.info.description.length < 180);
  assert.doesNotMatch(JSON.stringify(openapi), /Bounded private|SourceBearer|BrowserPayload|MetricPoint|Ingestion|Public documentation/);
});

test('all schema refs resolve and every delivered schema is reachable from a read operation', () => {
  const reached = new Set();
  const visit = x => {
    if (!x || typeof x !== 'object') return;
    if (x.$ref) {
      const name = x.$ref.split('/').at(-1);
      assert.ok(schemas[name], x.$ref);
      if (!reached.has(name)) { reached.add(name); visit(schemas[name]); }
    }
    Object.values(x).forEach(visit);
  };
  visit(openapi.paths);
  assert.deepEqual([...reached].sort(), Object.keys(schemas).sort());
  const ids = Object.values(openapi.paths).map(p => p.get.operationId);
  assert.equal(new Set(ids).size, ids.length);
});

test('read parameters and errors retain exact limits without ingestion error codes', () => {
  for (const { get } of Object.values(openapi.paths)) {
    assert.deepEqual(get.parameters.map(p => p.name), ['from', 'to', 'limit']);
    assert.ok(get.parameters.every(p => p.required && p.in === 'query'));
    assert.equal(get.parameters[0].schema.maximum, Number.MAX_SAFE_INTEGER);
    assert.ok(get.parameters[0].description.includes(`${LIMITS.readWindowMs / 86_400_000} days`));
    assert.ok(get.parameters[1].description.includes(`${LIMITS.futureMs / 1000} seconds`));
    assert.equal(get.parameters[2].schema.minimum, 1);
    assert.equal(get.parameters[2].schema.maximum, LIMITS.readRows);
    assert.deepEqual(Object.keys(get.responses), ['200', '400', '401', '503']);
    assert.match(get.responses[200].description, /\[from, to\)/);
  }
  assert.deepEqual(schemas.Error.properties.error.enum, ['invalid_payload', 'unauthorized', 'disabled', 'configuration', 'unavailable']);
});

test('response metadata preserves versions, expiry, no-cursor truncation and raw JSON/null representations', () => {
  for (const name of ['BrowserRow', 'MetricRow', 'ProbeRow', 'DeletionRow', 'StatusRow', 'LifecycleRow']) {
    const response = schemas[`${name}Response`].properties;
    assert.equal(response.schema_version.const, name === 'BrowserRow' ? BROWSER_SCHEMA_VERSION : SCHEMA_VERSION);
    assert.equal(response.policy_version.const, name === 'BrowserRow' ? BROWSER_POLICY_VERSION : POLICY_VERSION);
    assert.equal(response.rows.maxItems, LIMITS.readRows);
    assert.match(response.truncated.description, /not proof more rows exist/);
    assert.match(response.truncated.description, /no cursor/);
    assert.match(schemas[name].properties.expires_at.description, /epoch milliseconds/);
  }
  assert.equal(schemas.MetricRow.properties.attributes_json.type, 'string');
  assert.deepEqual(schemas.MetricRow.properties.value.anyOf[1], { type: 'null' });
  assert.deepEqual(schemas.MetricRow.properties.monotonic.anyOf[0].enum, [0, 1]);
  assert.match(schemas.StatusRow.description, /not live health/);
});

test('metric row reference keeps policy names and places interpretation next to measurements', () => {
  assert.deepEqual(schemas.MetricRow.properties.name.enum, Object.keys(METRICS));
  assert.deepEqual(schemas.MetricRow.properties.unit.enum, [...new Set(Object.values(METRICS).map(m => m.unit))]);
  assert.match(schemas.MetricRow.description, /cumulative.*exact reset/);
  assert.match(schemas.MetricRow.description, /global snapshots.*never sum/);
  assert.match(schemas.MetricRow.description, /deduplicate exact points/);
  assert.match(schemas.MetricRow.properties.bucket_counts_json.anyOf[0].description, /Disjoint.*overflow/);
  assert.match(schemas.MetricRow.properties.time_unix_nano.anyOf[0].description, /Exact uint64/);
});

test('read response columns track actual migrations', async () => {
  const sql = await readFile(new URL('../migrations/0001_telemetry.sql', import.meta.url), 'utf8');
  const definitions = { browser_observations: 'BrowserRow', metric_points: 'MetricRow', deletion_runs: 'DeletionRow', probe_runs: 'ProbeRow', source_status: 'StatusRow' };
  for (const [table, name] of Object.entries(definitions)) {
    const body = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))[1];
    const columns = [...body.matchAll(/^\s+(\w+)\s+(?:INTEGER|REAL|TEXT)\b/gm)].map(m => m[1]);
    if (name === 'BrowserRow') columns.push('network_location');
    assert.deepEqual(Object.keys(schemas[name].properties).sort(), columns.sort());
    assert.deepEqual(schemas[name].required.slice().sort(), columns.sort());
  }
  const lifecycle = await readFile(new URL('../migrations/0004_daytona_lifecycle.sql', import.meta.url), 'utf8');
  const columns = [...lifecycle.matchAll(/^\s+(\w+)\s+(?:INTEGER|REAL|TEXT)\b/gm)].map(m => m[1]);
  assert.deepEqual(Object.keys(schemas.LifecycleRow.properties).sort(), columns.sort());
});

test('real workerd serves public docs without a database, credentials, activation or outbound calls', async t => {
  const local = createRequire(import.meta.url);
  const api = createRequire(new URL('../../api/package.json', import.meta.url));
  const dependency = name => { try { return local(name); } catch { return api(name); } };
  const { build } = dependency('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = dependency('miniflare');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({ absWorkingDir: root, entryPoints: ['src/worker.js'], bundle: true,
    write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-08-01', bindings: { TELEMETRY_ENABLED: 'false', BROWSER_ENABLED: 'false' },
    outboundService: () => { throw new Error('No outbound calls permitted'); } }));
  t.after(() => mf.dispose());
  const spec = await mf.dispatchFetch('https://telemetry.invalid/docs/openapi.json');
  assert.equal(spec.status, 200);
  assert.deepEqual(await spec.json(), openapi);
  const html = await mf.dispatchFetch('https://telemetry.invalid/docs');
  assert.equal(html.status, 200);
  assert.equal(await html.text(), DOCS_HTML);
  for (const path of ['/docs', '/docs/openapi.json']) {
    const head = await mf.dispatchFetch(`https://telemetry.invalid${path}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  assert.equal((await mf.dispatchFetch('https://telemetry.invalid/')).status, 200);
  assert.equal((await mf.dispatchFetch('https://telemetry.invalid/v1/read/status?from=1&to=2&limit=1')).status, 503);
});
