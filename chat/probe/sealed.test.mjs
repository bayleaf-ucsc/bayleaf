import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Identity, extractSessionRecoveryToken, deriveResponseKeys, encryptChunk, hexToBytes } from 'ehbp';
import worker, { probeSealed, SEALED_MODEL, metrics, validateSealedAttestationSize } from './index.mjs';

const key = 'sk-bayleaf-synthetic';
const nonce = 'ab'.repeat(32);
const bundle = { synthetic: true, enclaveAttestationReport: {
  body: gzipSync(Buffer.from('synthetic report')).toString('base64'),
} };
const signal = () => new AbortController().signal;
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const good = frame({ choices: [{ index: 0, delta: { content: 'Synthetic answer' }, finish_reason: null }] })
  + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
const request = (method = 'GET', authorized = true, path = '/api/sealed') => new Request(`https://probe.example${path}`, {
  method, headers: authorized ? { Authorization: `Basic ${btoa('probe:password')}` } : {},
});
const env = { ENABLED: 'true', DEADLINE_MS: '1000', PROBE_PASSWORD: 'password', BAYLEAF_API_KEY: key,
  LIMITER: { async limit() { return { success: true }; } } };

function fixture({ verifyError = false, securityVerified = true, host = 'router.tinfoil.sh',
  status = 200, headers = {}, plaintext = good, decryptError = false, context = true } = {}) {
  let fetches = 0, encryptions = 0, decryptions = 0;
  const verifier = {
    async verifyBundle(value) { assert.deepEqual(value, bundle); if (verifyError) throw new Error('sensitive'); return { hpkePublicKey: nonce }; },
    getVerificationDocument() { return { securityVerified, enclaveHost: host }; },
  };
  const identity = { async fromPublicKeyHex(hpke) {
    assert.equal(hpke, nonce);
    return {
      async encryptRequestWithContext(req) {
        encryptions++;
        assert.equal(req.url, 'https://api.bayleaf.dev/sealed/v1/chat/completions');
        assert.equal(req.method, 'POST');
        assert.equal(req.redirect, 'manual');
        assert.equal(req.headers.get('authorization'), `Bearer ${key}`);
        assert.equal(req.headers.get('X-Tinfoil-Enclave-Url'), `https://${host}`);
        assert.deepEqual(await req.json(), { model: SEALED_MODEL, messages: [{ role: 'user', content: "What's BayLeaf?" }],
          stream: true, max_tokens: 2048, chat_template_kwargs: { reasoning_effort: 'low' } });
        return { request: new Request(req.url, { method: 'POST', redirect: 'manual', signal: req.signal,
          headers: { 'Ehbp-Encapsulated-Key': nonce }, body: 'synthetic-ciphertext' }), context: context ? {} : null };
      },
      async decryptResponseWithContext(response) {
        decryptions++;
        assert.equal(await response.text(), 'encrypted-response');
        if (decryptError) throw new Error('sensitive');
        return new Response(plaintext);
      },
    };
  } };
  const fetcher = async (input, options) => {
    fetches++;
    if (typeof input === 'string') {
      assert.equal(input, 'https://api.bayleaf.dev/sealed/attestation');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.signal.aborted, false);
      assert.equal(options.headers, undefined, 'BayLeaf key never sent with attestation GET');
      return Response.json(bundle);
    }
    assert.equal(input.redirect, 'manual');
    assert.equal(await input.text(), 'synthetic-ciphertext');
    return new Response('encrypted-response', { status, headers: {
      'Ehbp-Response-Nonce': nonce, 'X-BayLeaf-Sealed-Relay': 'ciphertext',
      'Content-Type': 'text/event-stream', ...headers,
    } });
  };
  return { verifier, identity, fetcher, counts: () => ({ fetches, encryptions, decryptions }) };
}

test('Sealed verifies first, encrypts once, decrypts, and validates a completed stream', async () => {
  const f = fixture(), timing = metrics();
  assert.equal(await probeSealed(key, signal(), { ...f, timing }), 'ok');
  assert.deepEqual(f.counts(), { fetches: 2, encryptions: 1, decryptions: 1 });
  assert.ok(timing.snapshot().phases.attestation_verify >= 0);
});

test('Sealed refuses invalid attestation/destination before encrypting or sending inference', async () => {
  for (const options of [{ verifyError: true }, { securityVerified: false }, { host: 'evil.example' },
    { host: 'router.tinfoil.sh/evil' }, { host: 'user@router.tinfoil.sh' }]) {
    const f = fixture(options);
    assert.equal(await probeSealed(key, signal(), f), 'sealed_attestation_verify');
    assert.deepEqual(f.counts(), { fetches: 1, encryptions: 0, decryptions: 0 });
  }
});

test('Sealed rejects redirects, missing/invalid nonce, plaintext replies, and decryption failures without retry', async () => {
  for (const [options, expected] of [
    [{ status: 302 }, 'sealed_http_302'], [{ status: 401 }, 'sealed_http_401'],
    [{ headers: { 'Ehbp-Response-Nonce': '' } }, 'sealed_protocol'],
    [{ headers: { 'Ehbp-Response-Nonce': 'zz'.repeat(32) } }, 'sealed_protocol'],
    [{ headers: { 'X-BayLeaf-Sealed-Relay': '' } }, 'sealed_protocol'],
    [{ headers: { 'Content-Type': 'application/json' } }, 'sealed_protocol'],
    [{ decryptError: true }, 'sealed_response_decrypt'], [{ context: false }, 'sealed_request_encrypt'],
    [{ plaintext: 'data: [DONE]\n\n' }, 'sealed_stream_incomplete'],
    [{ plaintext: good.replace('"stop"', '"length"') }, 'sealed_stream'],
  ]) {
    const f = fixture(options);
    assert.equal(await probeSealed(key, signal(), f), expected);
    assert.ok(f.counts().fetches <= 2, 'No retries or plaintext fallback');
  }
});

test('Sealed bounds malicious attestation bodies and handles aborts', async () => {
  for (const response of [new Response('redirect', { status: 302 }), new Response('not JSON'),
    new Response('x'.repeat(1024 * 1024 + 1))]) {
    assert.equal(await probeSealed(key, signal(), { fetcher: async () => response }), 'sealed_attestation_fetch');
  }
  const controller = new AbortController();
  controller.abort();
  let called = false;
  assert.equal(await probeSealed(key, controller.signal, { fetcher: async () => { called = true; } }), 'sealed_attestation_fetch');
  assert.equal(called, false);
});

test('Sealed route gates auth, exact path/method, configuration, and independent admission', async () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await worker.fetch(request(method, false), env)).status, 401);
    assert.equal((await worker.fetch(request(method), { ...env, BAYLEAF_API_KEY: undefined })).status, 503);
    const response = await worker.fetch(request(method), { ...env, LIMITER: { async limit({ key }) {
      assert.equal(key, 'sealed'); return { success: false };
    } } });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('X-BayLeaf-Probe-Result'), 'rate_limited');
    if (method === 'HEAD') assert.equal(await response.text(), '');
  }
  assert.equal((await worker.fetch(request('POST'), env)).status, 405);
  assert.equal((await worker.fetch(request('GET', true, '/api/sealed?model=other'), env)).status, 404);
});

test('Sealed GET/HEAD wait for verification failure, redact raw errors, and abort stalled fetches', async () => {
  const original = globalThis.fetch;
  try {
    for (const method of ['GET', 'HEAD']) {
      let release, settled = false;
      globalThis.fetch = () => new Promise(resolve => { release = () => resolve(Response.json({ secret: 'must not escape' })); });
      const pending = worker.fetch(request(method), env).then(r => { settled = true; return r; });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(settled, false);
      release();
      const response = await pending;
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('X-BayLeaf-Probe-Result'), 'sealed_attestation_verify');
      assert.ok(!(await response.text()).includes('must not escape'));
    }
    let upstreamSignal;
    globalThis.fetch = (_, options) => { upstreamSignal = options.signal; return new Promise(() => {}); };
    const response = await worker.fetch(request('HEAD'), env);
    assert.equal(response.headers.get('X-BayLeaf-Probe-Result'), 'deadline');
    assert.equal(upstreamSignal.aborted, true);
  } finally { globalThis.fetch = original; }
});

test('Sealed model tracks canonical recommendation', async () => {
  const config = await readFile(new URL('../../api/wrangler.jsonc', import.meta.url), 'utf8');
  assert.equal(SEALED_MODEL, config.match(/"SEALED_RECOMMENDED_MODEL"\s*:\s*"([^"]+)"/)[1]);
});

test('Real EHBP hides the request and rejects corrupt ciphertext, even after a complete plaintext SSE frame', async () => {
  const serverIdentity = await Identity.generate();
  const hpkePublicKey = await serverIdentity.getPublicKeyHex();
  for (const tamper of [false, true]) {
    let context;
    const identity = { async fromPublicKeyHex(value) {
      const server = await Identity.fromPublicKeyHex(value);
      return {
        async encryptRequestWithContext(req) {
          const sealed = await server.encryptRequestWithContext(req);
          context = sealed.context;
          return sealed;
        },
        decryptResponseWithContext: server.decryptResponseWithContext.bind(server),
      };
    } };
    const verifier = {
      async verifyBundle() { return { hpkePublicKey }; },
      getVerificationDocument() { return { securityVerified: true, enclaveHost: 'router.tinfoil.sh' }; },
    };
    const fetcher = async input => {
      if (typeof input === 'string') return Response.json(bundle);
      const requestBytes = new Uint8Array(await input.arrayBuffer());
      const raw = new TextDecoder().decode(requestBytes);
      assert.equal(raw.includes("What's BayLeaf?"), false);
      assert.equal(raw.includes('"model"'), false);
      const token = await extractSessionRecoveryToken(context);
      const km = await deriveResponseKeys(token.exportedSecret, token.requestEnc, hexToBytes(nonce));
      const first = await encryptChunk(km, 0, new TextEncoder().encode(good));
      const second = await encryptChunk(km, 1, new TextEncoder().encode(': tail\n\n'));
      if (tamper) second[0] ^= 1;
      const body = new Uint8Array(8 + first.length + second.length);
      new DataView(body.buffer).setUint32(0, first.length);
      body.set(first, 4);
      new DataView(body.buffer).setUint32(4 + first.length, second.length);
      body.set(second, 8 + first.length);
      return new Response(body, { headers: { 'Ehbp-Response-Nonce': nonce,
        'X-BayLeaf-Sealed-Relay': 'ciphertext', 'Content-Type': 'text/event-stream' } });
    };
    assert.equal(await probeSealed(key, signal(), { verifier, identity, fetcher }), tamper ? 'sealed_stream' : 'ok');
  }
});

test('Compressed report expansion is bounded before verifier invocation without mutating signed material', async () => {
  const original = structuredClone(bundle);
  await validateSealedAttestationSize(bundle, signal());
  assert.deepEqual(bundle, original);
  const malicious = { enclaveAttestationReport: { body: gzipSync(Buffer.alloc(4 * 1024 * 1024)).toString('base64') } };
  assert.ok(JSON.stringify(malicious).length < 10000);
  await assert.rejects(validateSealedAttestationSize(malicious, signal()));
  let verified = false, calls = 0;
  const result = await probeSealed(key, signal(), {
    fetcher: async () => { calls++; return Response.json(malicious); },
    verifier: { async verifyBundle() { verified = true; } },
  });
  assert.equal(result, 'sealed_attestation_verify');
  assert.equal(verified, false);
  assert.equal(calls, 1);
  for (const body of ['not-base64!', Buffer.from('not-gzip').toString('base64')]) {
    await assert.rejects(validateSealedAttestationSize({ enclaveAttestationReport: { body } }, signal()));
  }
});

test('Sealed HTTP failures preserve header-validation diagnostics through cleanup', async () => {
  for (const status of [302, 401, 503]) {
    const timing = metrics();
    assert.equal(await probeSealed(key, signal(), { ...fixture({ status }), timing }), `sealed_http_${status}`);
    assert.equal(timing.snapshot().failed_phase, 'header_validation');
    assert.equal(timing.stage(), 'header_validation');
  }
});
