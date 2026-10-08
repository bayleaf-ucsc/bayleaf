// Operator-only verification. No credentials, content, or raw errors in output.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Verifier } from '@tinfoilsh/verifier';
import { validateSealedAttestationSize } from './index.mjs';

export async function qualifySealedAttestation() {
  const response = await fetch('https://api.bayleaf.dev/sealed/attestation', {
    redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  const bundle = await response.json();
  const verify = async value => {
    await validateSealedAttestationSize(value, AbortSignal.timeout(15000));
    return new Verifier({ configRepo: 'tinfoilsh/confidential-model-router' }).verifyBundle(value);
  };
  await verify(bundle);
  console.log(JSON.stringify({ sealed_attestation: 'verified' }));
  for (const field of ['digest', 'enclaveAttestationReport', 'sigstoreBundle', 'enclaveCert', 'domain']) {
    const changed = structuredClone(bundle);
    changed[field] = field === 'enclaveAttestationReport' ? { ...changed[field], body: 'AAAA' }
      : field === 'sigstoreBundle' ? {} : field === 'domain' ? 'evil.example' : 'invalid';
    await assert.rejects(verify(changed));
    console.log(JSON.stringify({ mutation: field, rejected: true }));
  }
}

/** Local workerd or deployed endpoint; fresh GET and HEAD, with anonymous denial. */
export async function qualifySealedHTTP(target = 'https://probe.bayleaf.dev', password) {
  if (!password) {
    const secrets = JSON.parse(await readFile(new URL('worker.secrets.json', import.meta.url), 'utf8'));
    password = secrets.PROBE_PASSWORD;
  }
  assert.ok(password);
  for (const method of ['GET', 'HEAD']) {
    const denied = await fetch(`${target}/api/sealed`, { method, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('server-timing'), null);
    await denied.body?.cancel();
    const start = performance.now();
    const response = await fetch(`${target}/api/sealed`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(35000),
      headers: { Authorization: `Basic ${btoa(`probe:${password}`)}` },
    });
    const result = response.headers.get('x-bayleaf-probe-result');
    console.log(JSON.stringify({ layer: 'sealed', method, status: response.status, result,
      elapsed_ms: Math.round(performance.now() - start),
      timing: response.headers.get('server-timing'), events: response.headers.get('x-bayleaf-probe-events') }));
    assert.equal(response.status, 200);
    assert.equal(result, 'ok');
    assert.equal(response.headers.get('x-bayleaf-probe-metrics-version'), '2');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else {
      const body = await response.json();
      assert.equal(body.layer, 'sealed');
      assert.equal(body.result, 'ok');
      assert.equal(body.version, 2);
      assert.ok(body.metrics.phases.attestation_verify >= 0);
      assert.ok(body.metrics.phases.response_decrypt >= 0);
      assert.ok(body.metrics.events.eof >= body.metrics.events.done);
      assert.ok(Math.abs(body.metrics.total - body.metrics.accounted - body.metrics.unaccounted) < 0.1);
      assert.equal(Object.hasOwn(body, 'content'), false);
    }
  }
}
