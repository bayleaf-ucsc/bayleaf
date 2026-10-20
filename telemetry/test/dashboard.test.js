import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboard, renderDashboard } from '../src/dashboard.js';

const request = (method = 'GET') => new Request('https://telemetry.bayleaf.dev/', { method });
const enabled = { TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'true', RETENTION_DAYS: '90' };

test('operator records distinguish enabled, verified, and pending integrations', async () => {
  const response = dashboard(request(), enabled);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Operator record dated <strong>2026-10-20<\/strong>, not live health/);
  assert.match(html, /Chat browser<\/th>\s*<td>Disabled \(recorded\)<\/td>\s*<td>Implementation in progress; qualification pending/);
  assert.equal((html.match(/awaiting ordinary schedule confirmation/g) ?? []).length, 3);
  assert.match(html, /Verified with a 5-minute export interval/);
  assert.match(html, /cannot remotely inspect source switches/);
  assert.equal((html.match(/<li>\w+: 90 days<\/li>/g) ?? []).length, 4);
});

test('receiver switches fail closed independently of source records', async () => {
  for (const env of [{}, { TELEMETRY_ENABLED: true }, { TELEMETRY_ENABLED: 'false', BROWSER_ENABLED: 'true' }]) {
    const response = dashboard(request(), env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Global ingestion: Disabled/);
    assert.match(html, /Enabled \(recorded\)/);
    assert.doesNotMatch(html, /Open by receiver switches/);
    assert.match(html, /Blocked: global ingestion disabled/);
  }
  const html = renderDashboard({ TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'false' });
  assert.match(html, /Browser admission: Blocked: browser ingestion disabled/);
  assert.match(html, /Service admission: Open by receiver switches/);
});

test('only approved public configuration is read; no database, credentials, or request data reflected', async () => {
  const env = { ...enabled };
  for (const key of ['TELEMETRY_DB', 'READ_SECRET', 'WRITE_KEYS_JSON', 'ARBITRARY_SECRET']) {
    Object.defineProperty(env, key, { enumerable: true, get() { throw new Error('must not read'); } });
  }
  const dirtyRequest = new Request('https://telemetry.bayleaf.dev/?secret=do-not-reflect-query', {
    headers: { Authorization: 'Bearer do-not-reflect-token', 'User-Agent': 'do-not-reflect-agent' },
  });
  const html = await dashboard(dirtyRequest, env).text();
  assert.doesNotMatch(html, /do-not-reflect|<script|<img|<iframe|fetch\(/);
  assert.doesNotMatch(html, /READ_SECRET|WRITE_KEYS_JSON|ARBITRARY_SECRET/);
});

test('operator text is escaped, never interpreted as HTML', () => {
  const attack = `<script>alert("x" & 'y')</script>`;
  const html = renderDashboard({}, { recordedOn: attack,
    sources: [{ name: attack, enabled: false, kind: 'browser', verification: attack }] });
  assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/&lt;script&gt;alert\(&quot;x&quot; &amp; &#39;y&#39;\)&lt;\/script&gt;/g) ?? []).length, 3);
});

test('retention reflects bounded configuration, overrides, and conservative defaults without unsafe reflection', () => {
  assert.match(renderDashboard({}), /<li>browser: 7 days<\/li>/);
  assert.match(renderDashboard({ ...enabled, BROWSER_RETENTION_DAYS: '30' }), /<li>browser: 30 days<\/li>/);
  for (const value of ['91', '0', '-1', '1.5', 'Infinity', '<script>secret</script>']) {
    const html = renderDashboard({ RETENTION_DAYS: value });
    assert.equal((html.match(/Invalid configuration \(allowed: 1–90 days\)/g) ?? []).length, 4);
    assert.doesNotMatch(html, /<script>|secret/);
  }
  assert.match(renderDashboard(enabled), /previously lowered durable retention ceiling can be stricter/);
});

test('GET and empty HEAD share no-store and restrictive security headers', async () => {
  const get = dashboard(request(), enabled);
  const head = dashboard(request('HEAD'), enabled);
  assert.equal(head.status, get.status);
  assert.equal(await head.text(), '');
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.equal(get.headers.get('Cache-Control'), 'no-store');
  assert.equal(get.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(get.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(get.headers.get('Content-Security-Policy'), /default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'/);
  assert.equal(get.headers.get('Referrer-Policy'), 'no-referrer');
});

test('unsupported methods cannot become an ingestion endpoint', async () => {
  const response = dashboard(request('POST'), enabled);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  assert.equal(await response.text(), '');
});
