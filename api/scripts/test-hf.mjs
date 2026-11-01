#!/usr/bin/env node
/**
 * HF artifact gateway (issue #121) in real workerd with a local R2 bucket and a
 * synthetic Hub. Credential-free: the token is synthetic and no request leaves
 * the process. Covers the mirror's token/redirect boundary and R2's checksum
 * refusal, then the download contract that Transformers.js and resumable
 * clients rely on, and that serving never contacts upstream.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const COMMIT = 'a'.repeat(40), BAD_COMMIT = 'b'.repeat(40);
const TOKEN = 'hf_synthetic_token';

// Deterministic fixtures: one small (non-LFS) file, one large (LFS) one.
const bytes = (n, seed) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
const upstream = {
  'config.json': Buffer.from('{"model_type":"tiny"}'),
  'onnx/model.onnx_data': bytes(3 * 2 ** 20 + 7, 1),
  'LICENSE': Buffer.from('Synthetic license text\n'),
  'wrong.bin': bytes(1000, 2),
  'evil.bin': bytes(10, 3),
  'throws.bin': bytes(5, 4),          // upstream fetch rejects; mirrored first (smallest)
  'stall.bin': bytes(4 * 2 ** 20, 5), // upstream body never finishes; mirrored last (largest)
};
const entry = (path, lfs = false, override = {}) => ({ path, bytes: upstream[path].length, sha256: sha(upstream[path]), git_oid: 'c'.repeat(40), lfs, ...override });
const meta = { title: 'Tiny', task: 'text-generation', library: 'transformers.js', architecture: 'tiny', formats: ['onnx'],
  license: { name: 'Synthetic', file: 'LICENSE', url: 'https://example.invalid/LICENSE' },
  distribution: { basis: 'synthetic', reviewed: '2026-11-01', decision: 'test fixture' }, qualification: [] };
const registry = { releases: [
  { repo: 'test-org/tiny-model', revision: COMMIT, aliases: ['main'], ...meta,
    variants: [{ name: 'default', files: ['config.json', 'onnx/model.onnx_data'] }],
    files: [entry('config.json'), entry('onnx/model.onnx_data', true), entry('LICENSE')] },
  // The registry's hash for wrong.bin is not what upstream serves; evil.bin redirects off-Hub.
  { repo: 'test-org/bad', revision: BAD_COMMIT, aliases: [], ...meta, task: 'other', variants: [],
    files: [entry('LICENSE'), entry('wrong.bin', true, { sha256: 'd'.repeat(64) }), entry('evil.bin', true),
      entry('throws.bin', true), entry('stall.bin', true)] },
] };

const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import worker from './src/index';
  import { mirrorHfReleases } from './src/hfMirror';
  import { registryProblems, HF_RELEASES } from './src/hfRegistry';
  import real from './real-hf-releases';
  export { PreviewConnections, SandboxBrowser, SandboxManagement } from './src/index';
  export default { ...worker, async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/__mirror') return Response.json(await mirrorHfReleases(env, { hardDeadlineMs: 3000 }));
    if (path === '/__registry') return Response.json({ fixture: registryProblems(HF_RELEASES), real: registryProblems(real.releases) });
    return worker.fetch(request, request.headers.get('X-Test-Disabled') ? { ...env, HF_GATEWAY_ENABLED: 'false' } : env, ctx);
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'], loader: { '.py': 'text', '.md': 'text' },
  plugins: [{ name: 'fixture-registry', setup(b) {
    // The Worker's registry becomes the fixture; the real one is still checked for well-formedness.
    b.onResolve({ filter: /^\.\/hfReleases\.json$/ }, () => ({ path: 'fixture', namespace: 'hf-fixture' }));
    b.onResolve({ filter: /^\.\/real-hf-releases$/ }, () => ({ path: `${root}src/hfReleases.json` }));
    b.onLoad({ filter: /.*/, namespace: 'hf-fixture' }, () => ({ contents: JSON.stringify(registry), loader: 'json' }));
  } }] });

const outbound = [];
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'hf-harness', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-01-31', compatibilityFlags: ['nodejs_compat'],
    bindings: { HF_GATEWAY_ENABLED: 'true', HF_TOKEN: TOKEN, RECOMMENDED_MODEL: 'test/model', GRANTS_ENABLED: 'true' },
    r2Buckets: ['HF_ARTIFACTS'],
    durableObjects: { PREVIEW_CONNECTIONS: { className: 'PreviewConnections', useSQLite: true },
      SANDBOX_BROWSER: { className: 'SandboxBrowser', useSQLite: true } },
    outboundService: async (request) => {
      const url = new URL(request.url), auth = request.headers.get('Authorization');
      outbound.push({ host: url.hostname, path: url.pathname, auth });
      if (url.hostname === 'huggingface.co') {
        assert.equal(auth, `Bearer ${TOKEN}`, 'the Hub gets the operator token');
        const m = /^\/test-org\/[\w-]+\/resolve\/[0-9a-f]{40}\/(.+)$/.exec(url.pathname);
        const cached = /^\/api\/resolve-cache\/(.+)$/.exec(url.pathname);
        if (cached) return new Response(upstream[decodeURIComponent(cached[1])]);
        const file = m && decodeURIComponent(m[1]);
        if (!file || !upstream[file]) return new Response('missing', { status: 404 });
        if (file === 'throws.bin') throw new Error('synthetic network failure');
        if (file === 'evil.bin') return new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } });
        if (file.endsWith('.onnx_data') || file.endsWith('.bin')) {
          return new Response(null, { status: 302, headers: { Location: `https://us.aws.cdn.hf.co/xet-bridge-us/x/${encodeURIComponent(file)}?Signature=s` } });
        }
        return new Response(null, { status: 307, headers: { Location: `/api/resolve-cache/${encodeURIComponent(file)}` } });
      }
      if (url.hostname === 'us.aws.cdn.hf.co') {
        assert.equal(auth, null, 'the token never reaches a storage host');
        const name = decodeURIComponent(url.pathname.split('/').pop());
        if (name === 'stall.bin') return new Response(new ReadableStream({ start(c) { c.enqueue(upstream[name].subarray(0, 100)); } }),
          { headers: { 'Content-Length': String(upstream[name].length) } });
        return new Response(upstream[name]);
      }
      throw new Error(`unexpected outbound request to ${url.hostname}`);
    } }],
}));

const base = 'https://api.bayleaf.dev';
const get = (path, init = {}) => mf.dispatchFetch(base + path, init);
const file = (path, rev = COMMIT, repo = 'test-org/tiny-model') => `/hf/${repo}/resolve/${rev}/${path}`;
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

try {
  await check('registries are well formed (fixture and the real hfReleases.json)', async () => {
    const r = await (await get('/__registry')).json();
    assert.deepEqual(r, { fixture: [], real: [] });
  });

  await check('a disabled gateway answers 503 and the mirror does nothing', async () => {
    const r = await get('/hf/catalog', { headers: { 'X-Test-Disabled': '1' } });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'hf_gateway_disabled');
  });

  await check('before mirroring, approved files answer 503 with Retry-After and make no upstream request', async () => {
    const r = await get(file('config.json'));
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('Retry-After'), '3600');
    assert.equal(outbound.length, 0);
  });

  await check('mirror: token only to the Hub, storage redirects without it, off-Hub redirects refused, wrong bytes rejected by R2, a rejected fetch and a stalled transfer fail alone', async () => {
    const t0 = Date.now();
    const report = await (await get('/__mirror')).json();
    assert.deepEqual(report, { approved: 7, present: 0, mirrored: 3, failed: 4, deferred: 0 });
    assert.ok(Date.now() - t0 < 15_000, 'the deadline ends the stalled transfer');
    assert.ok(!outbound.some((o) => o.host === 'evil.example'), 'the refused redirect is never followed');
    assert.ok(outbound.some((o) => o.host === 'us.aws.cdn.hf.co' && o.auth === null));
    const again = await (await get('/__mirror')).json();
    assert.equal(again.present, 3);
  });

  const before = outbound.length;

  await check('GET by commit: exact bytes and the controlled headers', async () => {
    const r = await get(file('config.json'), { headers: { Origin: 'https://pouch.example', Cookie: 'a=b', Authorization: 'Bearer sk-bayleaf-grant-synthetic' } });
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), upstream['config.json']);
    const h = r.headers, etag = `"${sha(upstream['config.json'])}"`;
    assert.equal(h.get('ETag'), etag);
    assert.equal(h.get('X-Linked-Etag'), etag);
    assert.equal(h.get('X-Repo-Commit'), COMMIT);
    assert.equal(h.get('Content-Length'), String(upstream['config.json'].length));
    assert.equal(h.get('Content-Type'), 'application/octet-stream');
    assert.equal(h.get('Cache-Control'), 'public, max-age=31536000, immutable, no-transform');
    assert.equal(h.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(h.get('Content-Security-Policy'), "default-src 'none'; sandbox");
    assert.equal(h.get('Access-Control-Allow-Origin'), '*');
    for (const name of ['Content-Range', 'ETag', 'X-Repo-Commit', 'X-Linked-Size']) assert.ok(h.get('Access-Control-Expose-Headers').includes(name));
    assert.equal(h.get('Set-Cookie'), null);
    assert.equal(h.get('X-Xet-Hash'), null);
    assert.equal(h.get('Link'), null);
  });

  await check('the main alias serves the approved commit and revalidates', async () => {
    const r = await get(file('config.json', 'main'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('X-Repo-Commit'), COMMIT);
    assert.equal(r.headers.get('Cache-Control'), 'no-cache, no-transform');
    await r.arrayBuffer();
  });

  const big = upstream['onnx/model.onnx_data'], size = big.length;
  const range = async (value, status, start, end) => {
    const r = await get(file('onnx/model.onnx_data'), { headers: { Range: value } });
    assert.equal(r.status, status, value);
    if (status === 206) {
      assert.equal(r.headers.get('Content-Range'), `bytes ${start}-${end}/${size}`);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), big.subarray(start, end + 1));
    } else {
      assert.equal(r.headers.get('Content-Range'), `bytes */${size}`);
      await r.arrayBuffer();
    }
  };
  await check('single ranges: Transformers.js size probe, middle, open-ended, suffix, clamped end', async () => {
    await range('bytes=0-0', 206, 0, 0);
    await range('bytes=1048576-2097151', 206, 1048576, 2097151);
    await range(`bytes=${size - 5}-`, 206, size - 5, size - 1);
    await range('bytes=-10', 206, size - 10, size - 1);
    await range(`bytes=10-${size + 99}`, 206, 10, size - 1);
  });
  await check('unsatisfiable, reversed, multiple and malformed ranges answer 416', async () => {
    await range(`bytes=${size}-`, 416);
    await range('bytes=9-3', 416);
    await range('bytes=0-1,5-6', 416);
    await range('items=0-1', 416);
  });

  await check('a resumable download reassembles to the pinned SHA-256', async () => {
    const parts = [], step = 1 << 20;
    for (let at = 0; at < size; at += step) {
      const r = await get(file('onnx/model.onnx_data'), { headers: { Range: `bytes=${at}-${Math.min(at + step, size) - 1}` } });
      parts.push(Buffer.from(await r.arrayBuffer()));
    }
    assert.equal(sha(Buffer.concat(parts)), registry.releases[0].files[1].sha256);
  });

  await check('conditional requests: If-None-Match 304, stale If-Range serves the whole file', async () => {
    const etag = `"${sha(big)}"`;
    const r = await get(file('onnx/model.onnx_data'), { headers: { 'If-None-Match': etag } });
    assert.equal(r.status, 304);
    const stale = await get(file('onnx/model.onnx_data'), { headers: { Range: 'bytes=0-0', 'If-Range': '"other"' } });
    assert.equal(stale.status, 200);
    assert.equal((await stale.arrayBuffer()).byteLength, size);
  });

  await check('HEAD reports size without a body', async () => {
    const r = await get(file('onnx/model.onnx_data'), { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Content-Length'), String(size));
    assert.equal((await r.arrayBuffer()).byteLength, 0);
  });

  await check('unapproved repositories, revisions and files are 404; tricks do not reach other paths', async () => {
    for (const path of [
      file('README.md'), file('config.json', 'c'.repeat(40)), file('config.json', 'dev'),
      // Literal and %2e dot segments are collapsed by URL parsing before any request is sent,
      // so these are the forms that can reach the Worker.
      file('config.json', COMMIT, 'other/repo'), file('onnx%2Fmodel.onnx_data'), file('onnx/%2E%2E%2Fconfig.json'),
      file('onnx/%252e%252e/config.json'), file('evil.bin', BAD_COMMIT, 'test-org/bad') + 'x', '/hf/test-org/tiny-model',
    ]) {
      const r = await get(path);
      assert.equal(r.status, 404, path);
      assert.equal(r.headers.get('Content-Type'), 'application/json');
    }
  });

  await check('failed mirrors stay unavailable (503), never served from upstream', async () => {
    for (const name of ['wrong.bin', 'evil.bin', 'throws.bin', 'stall.bin']) assert.equal((await get(file(name, BAD_COMMIT, 'test-org/bad'))).status, 503);
  });

  await check('query strings are 400; writes are 405', async () => {
    assert.equal((await get(file('config.json') + '?download=true')).status, 400);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await get(file('config.json'), { method, body: method === 'DELETE' ? undefined : 'x' });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('Allow'), 'GET, HEAD');
    }
  });

  await check('CORS preflight admits Range from any origin, without credentials', async () => {
    const r = await get(file('onnx/model.onnx_data'), { method: 'OPTIONS', headers: {
      Origin: 'https://pouch.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(/range/i.test(r.headers.get('Access-Control-Allow-Headers')));
    assert.equal(r.headers.get('Access-Control-Allow-Credentials'), null);
  });

  await check('catalog: releases, inventory, download URLs, filters, unknown query refused', async () => {
    const all = await (await get('/hf/catalog')).json();
    assert.equal(all.releases.length, 2);
    assert.ok(all.notice.includes('did not author or endorse'));
    const tiny = all.releases[0];
    assert.equal(tiny.files[1].url, `${base}${file('onnx/model.onnx_data')}`);
    assert.equal(tiny.upstream_url, `https://huggingface.co/test-org/tiny-model/tree/${COMMIT}`);
    assert.equal(tiny.files[0].mirrored, undefined);
    assert.equal((await (await get('/hf/catalog?task=other')).json()).releases.length, 1);
    assert.equal((await get('/hf/catalog?search=x')).status, 400);
  });

  await check('per-repository catalog reports mirror status; unknown repositories are 404', async () => {
    const tiny = await (await get('/hf/catalog/test-org/tiny-model')).json();
    assert.ok(tiny.releases[0].files.every((f) => f.mirrored === true));
    const bad = await (await get('/hf/catalog/test-org/bad')).json();
    assert.deepEqual(bad.releases[0].files.map((f) => f.mirrored), [true, false, false, false, false]);
    assert.equal((await get('/hf/catalog/nobody/nothing')).status, 404);
  });

  await check('serving made no upstream requests', async () => {
    assert.equal(outbound.length, before);
  });

  console.log(`PASS: ${passed} HF artifact gateway checks`);
} finally {
  await mf.dispose();
}
