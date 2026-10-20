import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.mjs';

const token = 'synthetic-probe-collector-write-token';
const request = (method = 'GET', authorized = true) => new Request('https://probe.invalid/chat/basic', {
  method, headers: authorized ? { Authorization: `Basic ${btoa('probe:synthetic-password')}` } : {},
});

test('completed GET/HEAD snapshots export through waitUntil with dedicated auth, even if delivery fails', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    throw new Error('synthetic collector unavailable');
  };
  try {
    for (const method of ['GET', 'HEAD']) {
      const pending = [];
      const response = await worker.fetch(request(method), {
        PROBE_PASSWORD: 'synthetic-password', ENABLED: 'false', TELEMETRY_ENABLED: 'true',
        TELEMETRY_PROBE_WRITE_TOKEN: token, OWUI_API_KEY: 'never-export-upstream-key',
      }, { waitUntil: promise => pending.push(promise) });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('X-BayLeaf-Probe-Result'), 'disabled');
      assert.equal(pending.length, 1);
      await Promise.all(pending);
      const call = calls.at(-1);
      assert.equal(call.url, 'https://telemetry.bayleaf.dev/v1/probes');
      assert.equal(call.options.headers.Authorization, `Bearer ${token}`);
      const body = JSON.parse(call.options.body);
      assert.equal(body.source, 'probe');
      assert.equal(body.outcome, 'skipped');
      assert.equal(body.extensions.result, 'disabled');
      assert.equal(body.layer, 'owui');
      assert.ok(!call.options.body.includes('never-export'));
      assert.ok(!call.options.body.includes('synthetic-password'));
      if (method === 'HEAD') assert.equal(await response.text(), '');
      else assert.equal((await response.json()).metrics.total, body.duration_ms);
    }
    assert.equal(calls.length, 2); // No inference, retry, or extra probe.
  } finally { globalThis.fetch = previous; }
});

test('default off, missing dedicated secret, unauthorized requests and waitUntil failure preserve outcomes', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not call'); };
  try {
    for (const extra of [{}, { TELEMETRY_ENABLED: 'true' },
      { TELEMETRY_ENABLED: 'TRUE', TELEMETRY_PROBE_WRITE_TOKEN: token }]) {
      const pending = [];
      const response = await worker.fetch(request(), {
        PROBE_PASSWORD: 'synthetic-password', ENABLED: 'false', ...extra,
      }, { waitUntil: p => pending.push(p) });
      assert.equal(response.status, 503);
      await Promise.all(pending);
    }
    const env = { PROBE_PASSWORD: 'synthetic-password', ENABLED: 'false',
      TELEMETRY_ENABLED: 'true', TELEMETRY_PROBE_WRITE_TOKEN: token };
    assert.equal((await worker.fetch(request('GET', false), env, {
      waitUntil() { assert.fail('unauthorized telemetry'); },
    })).status, 401);
    assert.equal(calls, 0);
    const pending = [];
    assert.equal((await worker.fetch(request(), env, {
      waitUntil(p) { pending.push(p); throw new Error('closed'); },
    })).status, 503);
    await Promise.all(pending);
  } finally { globalThis.fetch = previous; }
});
