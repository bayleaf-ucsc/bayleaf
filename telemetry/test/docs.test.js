import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openapi } from '../src/openapi.js';
import { DOCS_HTML, SCALAR_URL } from '../src/docs.js';
import { createWorker } from '../src/worker.js';
import { validate } from '../src/validate.js';
import { LIMITS, METRICS, SOURCE_JOBS, DELETION_COUNTS, SCHEMA_VERSION, POLICY_VERSION } from '../src/policies.js';
import { BROWSER_SCHEMA_VERSION, BROWSER_POLICY_VERSION } from '../src/browser-policy.js';

const schemas = openapi.components.schemas;
// Test-only evaluator for the small structural JSON Schema subset emitted here.
// Not production validation or an OpenAPI conformance implementation. Cross-field
// constraints are checked by validate(), not falsely modeled as JSON Schema.
function matches(schema, value) {
  if (schema.$ref) return matches(schemas[schema.$ref.split('/').at(-1)], value);
  if ('const' in schema && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => matches(s, value)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some(s => matches(s, value))) return false;
  if (schema.type === 'null' && value !== null) return false;
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) return false;
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (['integer', 'number'].includes(schema.type) && (value < schema.minimum || value > schema.maximum)) return false;
  if (schema.type === 'string' && (typeof value !== 'string' || (schema.pattern && !new RegExp(schema.pattern).test(value)) || value.length > schema.maxLength)) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'array' && (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems || !value.every(v => matches(schema.items, v)))) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (schema.required?.some(k => !(k in value))) return false;
    if (Object.keys(value).some(k => schema.properties?.[k] ? !matches(schema.properties[k], value[k]) : schema.additionalProperties === false)) return false;
  }
  return true;
}
const now = 1790000000000;
const envelope = source => ({ schema_version: SCHEMA_VERSION, source, batch_id: '00000000-0000-4000-8000-000000000001', observed_at: now });
const worker = createWorker({ clock: () => now });

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
  assert.equal((await worker.fetch(new Request('https://telemetry.invalid/openapi.json'), { TELEMETRY_ENABLED: 'true' })).status, 404, 'no obsolete root alias');
});

test('Scalar uses canonical spec, a pinned external script, no interactive client or telemetry, restrictive CSP', async () => {
  assert.match(SCALAR_URL, /@scalar\/api-reference@\d+\.\d+\.\d+\/dist\/browser\/standalone\.js$/);
  assert.match(DOCS_HTML, /lang="en"/);
  assert.match(DOCS_HTML, /data-url="\/docs\/openapi.json"/);
  for (const setting of ['"hideClientButton":true', '"hideTestRequestButton":true', '"persistAuth":false', '"telemetry":false', '"withDefaultFonts":false']) assert.ok(DOCS_HTML.includes(setting));
  assert.match(DOCS_HTML, /no-referrer/);
  assert.match(DOCS_HTML, /Do not enter credentials/);
  const r = await worker.fetch(new Request('https://telemetry.invalid/docs'), {});
  const csp = r.headers.get('Content-Security-Policy');
  assert.ok(csp.includes(`script-src ${SCALAR_URL}`));
  assert.ok(csp.includes("connect-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(!csp.includes("script-src 'unsafe-inline'"));
});

test('all spec refs resolve; methods, auth classes and binary OTLP contract remain distinct', () => {
  const visit = x => {
    if (!x || typeof x !== 'object') return;
    if (x.$ref) assert.ok(schemas[x.$ref.split('/').at(-1)], x.$ref);
    Object.values(x).forEach(visit);
  };
  visit(openapi);
  const ids = Object.values(openapi.paths).flatMap(path => Object.values(path).map(operation => operation.operationId));
  assert.equal(new Set(ids).size, ids.length);
  for (const klass of ['browser', 'metrics', 'deletions', 'probes', 'status']) {
    const get = openapi.paths[`/v1/read/${klass}`].get;
    assert.deepEqual(get.security, [{ OperatorBearer: [] }]);
    assert.deepEqual(get.parameters.map(p => p.name), ['from', 'to', 'limit']);
    assert.equal(get.parameters[2].schema.maximum, LIMITS.readRows);
  }
  assert.deepEqual(openapi.paths['/v1/browser'].post.security, []);
  for (const klass of ['metrics', 'deletions', 'probes']) assert.deepEqual(openapi.paths[`/v1/${klass}`].post.security, [{ SourceBearer: [] }]);
  const otlp = openapi.paths['/v1/otlp/metrics'].post;
  assert.deepEqual(Object.keys(otlp.requestBody.content), ['application/x-protobuf']);
  assert.equal(otlp.responses[200].content['application/x-protobuf'].schema.maxLength, 0);
  assert.ok(!otlp.responses[429]);
  assert.ok(otlp.responses[503]);
  assert.equal(schemas.BrowserRowResponse.properties.schema_version.const, BROWSER_SCHEMA_VERSION);
  assert.equal(schemas.BrowserRowResponse.properties.policy_version.const, BROWSER_POLICY_VERSION);
  assert.equal(schemas.MetricRowResponse.properties.policy_version.const, POLICY_VERSION);
});

test('browser wire v1 remains exact; server enrichment is not accepted as client input', () => {
  const valid = schemas.BrowserPayload.example;
  assert.ok(matches(schemas.BrowserPayload, valid));
  assert.equal(validate('browser', valid, {}, now).schema_version, SCHEMA_VERSION);
  for (const extra of ['network_location', 'policy_version', 'observed_at', 'received_at', 'expires_at', 'visitor_id']) {
    const payload = { ...valid, [extra]: 'unknown' };
    assert.ok(!matches(schemas.BrowserPayload, payload));
    assert.throws(() => validate('browser', payload, {}, now));
  }
});

test('source-specific deletion schemas and runtime agree, including recursive counter rejection', () => {
  for (const [source, jobs] of Object.entries(SOURCE_JOBS)) for (const job of jobs) {
    const payload = { ...envelope(source), job, outcome: 'success', duration_ms: 10, deleted: 0,
      extensions: { counts: Object.fromEntries(DELETION_COUNTS[source].map(k => [k, 0])) } };
    assert.ok(matches(schemas.DeletionPayload, payload));
    validate('deletions', payload, {}, now);
    for (const changed of [{ ...payload, job: 'unreviewed-job' },
      { ...payload, extensions: { counts: { raw_error: 1 } } }, { ...payload, source: 'owui' }]) {
      assert.ok(!matches(schemas.DeletionPayload, changed));
      assert.throws(() => validate('deletions', changed, {}, now));
    }
  }
});

test('all policy metric names/kinds/units have strict schemas that agree with runtime', () => {
  assert.equal(schemas.MetricPoint.oneOf.length, Object.keys(METRICS).length);
  for (const [name, spec] of Object.entries(METRICS)) {
    const p = { name, kind: spec.kind, unit: spec.unit, observed_at: now, attributes: {},
      ...(spec.kind === 'gauge' ? { value: 1 } : { start_at: now - 10_000, temporality: 'cumulative',
        ...(spec.kind === 'sum' ? { value: 1, monotonic: true } : { count: 1, bounds: [1], bucket_counts: [0, 1] }) }) };
    const payload = { ...envelope('owui'), points: [p] };
    assert.ok(matches(schemas.MetricsPayload, payload));
    validate('metrics', payload, {}, now);
    for (const point of [{ ...p, unit: 'invented' }, { ...p, attributes: { account: 'forbidden' } }, { ...p, raw: 'forbidden' }]) {
      const bad = { ...payload, points: [point] };
      assert.ok(!matches(schemas.MetricsPayload, bad));
      assert.throws(() => validate('metrics', bad, {}, now));
    }
  }
});

test('probe schema vocabularies match runtime and cross-field rules remain explicitly documented', () => {
  const p = { ...envelope('probe'), layer: 'sealed', outcome: 'success', duration_ms: 20,
    phases_ms: { validation: 10 }, events_ms: { done: 20 }, extensions: { result: 'sealed_http_200' } };
  assert.ok(matches(schemas.ProbePayload, p));
  validate('probes', p, {}, now);
  const bad = { ...p, extensions: { result: 'provider said private text' } };
  assert.ok(!matches(schemas.ProbePayload, bad));
  assert.throws(() => validate('probes', bad, {}, now));
  assert.match(schemas.ProbePayload.description, /accounted.*phase sum/);
  assert.match(openapi.info.description, /durable TTL ceiling/);
  assert.match(openapi.info.description, /Never sum successive cumulative/);
});

test('raw read response columns track actual migrations, including JSON strings and SQL nulls', async () => {
  const sql = await readFile(new URL('../migrations/0001_telemetry.sql', import.meta.url), 'utf8');
  const definitions = { browser_observations: 'BrowserRow', metric_points: 'MetricRow', deletion_runs: 'DeletionRow', probe_runs: 'ProbeRow', source_status: 'StatusRow' };
  for (const [table, name] of Object.entries(definitions)) {
    const body = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))[1];
    const columns = [...body.matchAll(/^\s+(\w+)\s+(?:INTEGER|REAL|TEXT)\b/gm)].map(m => m[1]);
    if (name === 'BrowserRow') columns.push('network_location');
    assert.deepEqual(Object.keys(schemas[name].properties).sort(), columns.sort());
    assert.deepEqual(schemas[name].required.slice().sort(), columns.sort());
  }
  assert.equal(schemas.MetricRow.properties.attributes_json.type, 'string');
  assert.ok(matches(schemas.MetricRow.properties.value, null));
  assert.ok(matches(schemas.MetricRow.properties.monotonic, 1));
  assert.ok(!matches(schemas.MetricRow.properties.monotonic, true));
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
