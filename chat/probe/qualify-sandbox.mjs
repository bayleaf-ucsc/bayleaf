// Operator-only, passive qualification. No credentials, sandbox IDs or raw errors in output.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function qualifySandboxHTTP(target = 'https://probe.bayleaf.dev', password) {
  password ??= JSON.parse(await readFile(new URL('worker.secrets.json', import.meta.url), 'utf8')).PROBE_PASSWORD;
  assert.ok(password);
  for (const method of ['GET', 'HEAD']) {
    const denied = await fetch(`${target}/api/sandbox`, { method, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('server-timing'), null);
    await denied.body?.cancel();
    const start = performance.now();
    const response = await fetch(`${target}/api/sandbox`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(35000),
      headers: { Authorization: `Basic ${btoa(`probe:${password}`)}` },
    });
    const result = response.headers.get('x-bayleaf-probe-result');
    console.log(JSON.stringify({ layer: 'sandbox', method, status: response.status, result,
      elapsed_ms: Math.round(performance.now() - start), timing: response.headers.get('server-timing') }));
    assert.equal(response.status, 200);
    assert.equal(result, 'ok');
    assert.equal(response.headers.get('x-bayleaf-probe-metrics-version'), '2');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else {
      const body = await response.json();
      assert.equal(body.layer, 'sandbox'); assert.equal(body.version, 2); assert.equal(body.result, 'ok');
      assert.equal(Object.hasOwn(body, 'id'), false); assert.equal(Object.hasOwn(body, 'state'), false);
      assert.ok(Math.abs(body.metrics.total - body.metrics.accounted - body.metrics.unaccounted) < 0.1);
    }
  }
}
