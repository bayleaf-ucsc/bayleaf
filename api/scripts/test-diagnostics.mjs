/** Focused presentation contracts. Synthetic data only; no Worker or network. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/templates/diagnostics.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { relative, when, bytes, publicDiagnosticPage, diagnosticPage, diagnosticHeaders } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('receipt-time boundaries and exact UTC timestamps', () => {
  assert.equal(relative(100, 100), 'just now');
  assert.equal(relative(99, 100), 'just now');
  assert.equal(relative(101, 100), 'in under a minute');
  assert.equal(relative(160, 100), 'in 1 min');
  const futureReceipt = 1792562001;
  const rendered = when(futureReceipt, Math.max(futureReceipt, 1792562000));
  assert.match(rendered, />just now<\/time>/);
  const exact = new Date(futureReceipt * 1000).toISOString();
  assert.ok(rendered.includes(`datetime="${exact}"`) && rendered.includes(`title="${exact}"`));
});

test('binary sizes are labelled as binary units', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(1024), '1 KiB');
  assert.equal(bytes(209715200), '200 MiB');
});

test('private and uninstrumented documents deny scripts and connections', () => {
  const policy = diagnosticHeaders().get('Content-Security-Policy');
  assert.match(policy, /script-src 'none'/);
  assert.match(policy, /connect-src 'none'/);
  const page = diagnosticPage('Synthetic', '', { account: '<test>@example.test' });
  assert.doesNotMatch(page, /<script|<test>/);
  assert.match(page, /&lt;test&gt;@example.test/);
});

test('public arrival inclusion is explicit and its CSP matches', () => {
  for (const kind of ['proxies', 'inboxes']) {
    assert.doesNotMatch(publicDiagnosticPage(kind, true, false), /<script/);
    assert.ok(publicDiagnosticPage(kind, true, true).includes(`BayLeafArrival.publicArrival("${kind}",true)`));
  }
  const policy = diagnosticHeaders(true).get('Content-Security-Policy');
  assert.match(policy, /connect-src https:\/\/telemetry.bayleaf.dev/);
  assert.match(policy, /frame-ancestors 'none'/);
});
