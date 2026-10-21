import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboard, renderDashboard } from '../src/dashboard.js';

const request = (method = 'GET') => new Request('https://telemetry.bayleaf.dev/', { method });
const enabled = { TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'true', RETENTION_DAYS: '90' };
// One class section holds its gate, retention, and sources.
const group = (html, kind) => html.match(new RegExp(`<section class="group" aria-labelledby="class-${kind}">[\\s\\S]*?</section>`))?.[0] ?? '';
const meta = (html, kind) => group(html, kind).match(/<p class="meta">([\s\S]*?)<\/p>/)?.[1] ?? '';

test('operator records are dated, not live health, and distinguish enabled, verified, and pending sources', async () => {
  const response = dashboard(request(), enabled);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<strong>2026-10-20<\/strong>/);
  assert.match(html, /not live health/);
  assert.match(html, /cannot see source-side switches/);
  assert.match(group(html, 'browser'), /Chat<\/span>\s*<span class="detail">Verified for signed-out public-root arrivals/);
  assert.equal((group(html, 'deletions').match(/regular schedule not yet confirmed/g) ?? []).length, 3);
  assert.doesNotMatch(group(html, 'deletions'), /Not enabled/);
  assert.match(group(html, 'metrics'), /Verified at a 5-minute export interval/);
  for (const kind of ['browser', 'metrics', 'probes', 'deletions']) {
    assert.match(meta(html, kind), /Receiver open/);
    assert.match(meta(html, kind), /Kept 90 days/);
  }
});

test('receiver switches fail closed independently of source records', async () => {
  for (const env of [{}, { TELEMETRY_ENABLED: true }, { TELEMETRY_ENABLED: 'false', BROWSER_ENABLED: 'true' }]) {
    const response = dashboard(request(), env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Ingestion is off\./);
    assert.match(html, /kill switch is engaged/);
    assert.doesNotMatch(html, /open receiver accepts/);
    assert.doesNotMatch(html, /Receiver open/);
    for (const kind of ['browser', 'metrics', 'probes', 'deletions']) assert.match(meta(html, kind), /Receiver closed/);
    assert.match(group(html, 'browser'), /Landing page<\/span>\s*<span class="detail">Verified/);
  }
  const html = renderDashboard({ TELEMETRY_ENABLED: 'true', BROWSER_ENABLED: 'false' });
  assert.match(html, /Ingestion is on for services/);
  assert.match(html, /does not show that any source is sending/);
  assert.match(meta(html, 'browser'), /Receiver closed: browser switch off/);
  for (const kind of ['metrics', 'probes', 'deletions']) assert.match(meta(html, kind), /Receiver open/);
  assert.doesNotMatch(renderDashboard(enabled), /TELEMETRY_ENABLED|BROWSER_ENABLED/);
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
  assert.match(group(html, 'metrics'), /No sources recorded/);
  assert.match(group(html, 'browser'), /<strong>Not enabled\.<\/strong>/);
});

test('retention reflects bounded configuration, overrides, and conservative defaults without unsafe reflection', () => {
  assert.match(meta(renderDashboard({}), 'browser'), /Kept 7 days/);
  const override = renderDashboard({ ...enabled, BROWSER_RETENTION_DAYS: '30' });
  assert.match(meta(override, 'browser'), /Kept 30 days/);
  assert.match(meta(override, 'metrics'), /Kept 90 days/);
  for (const value of ['91', '0', '-1', '1.5', 'Infinity', '<script>secret</script>']) {
    const html = renderDashboard({ RETENTION_DAYS: value });
    assert.equal((html.match(/Retention misconfigured \(must be 1–90 days\)/g) ?? []).length, 5);
    assert.doesNotMatch(html, /<script>|secret/);
  }
  assert.match(renderDashboard(enabled), /lower limit set earlier stays in force/);
  assert.match(renderDashboard(enabled), /provider backups/);
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

test('Daytona public configuration distinguishes both receiver switches without data reads', () => {
  const closed = renderDashboard(enabled);
  assert.match(meta(closed, 'lifecycle'), /Receiver closed: Daytona webhook switch off/);
  assert.match(group(closed, 'metrics'), /Receiver closed: Daytona OTLP switch off/);
  assert.match(meta(closed, 'lifecycle'), /Kept 90 days/);
  const open = renderDashboard({ ...enabled, DAYTONA_WEBHOOKS_ENABLED: 'true', DAYTONA_OTLP_ENABLED: 'true' });
  assert.match(meta(open, 'lifecycle'), /Receiver open/);
  assert.doesNotMatch(open, /Daytona (?:webhook|OTLP) switch off/);
  assert.doesNotMatch(open, /DAYTONA_WEBHOOKS_ENABLED|DAYTONA_OTLP_ENABLED/);
});
