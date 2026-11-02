// Batch H (node): incremental SHA-256, ranged/chunked files, the part reassembler,
// the model store and `models` command consent, the engine job service, and the
// no-CDN check over the built artifact.   node test/batchH-node.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { Sha256, sha256hex } from '../src/sha256.ts';
import { openStore, fillFile, rangeSource, blobSource, verifiedFile, fileState, partAssets } from '../src/assets.ts';
import { createModelStore } from '../src/models.ts';
import { askTitle, createModelService, modelsCommands } from '../src/models-cli.ts';
import { gpuSupport, deviceSupport, DEVICE_REASON, friendlyError, MIN_STORAGE_BUFFERS } from '../src/local/engine.ts';
import { createJobs, sleepAndHash } from '../src/jobs.ts';
import { Tasks, TaskFs } from '../src/ns/tasks.ts';
import { CDN, assertNoCdn } from '../build-runtime.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const H = (b) => createHash('sha256').update(b).digest('hex');
const subtle = async (b) => Buffer.from(await crypto.subtle.digest('SHA-256', b)).toString('hex');

// ── SHA-256 ──
await t('NIST vectors', () => {
  assert.equal(sha256hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256hex(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  const h = new Sha256(), a = new Uint8Array(1000).fill(0x61);
  for (let i = 0; i < 1000; i++) h.update(a);
  assert.equal(h.hex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'); // 10^6 'a'
});
await t('random chunks vs crypto.subtle, with save/resume at 64-byte boundaries', async () => {
  for (let k = 0; k < 20; k++) {
    const total = Math.floor(Math.random() * 300000), buf = randomBytes(total);
    let h = new Sha256(), at = 0;
    while (at < total) {
      const step = Math.min(total - at, 1 + Math.floor(Math.random() * 70000));
      h.update(buf.subarray(at, at + step)); at += step;
      if (Math.random() < 0.3) h = Sha256.resume(JSON.parse(JSON.stringify(h.state(true))));
    }
    assert.equal(h.hex(), await subtle(buf), `length ${total}`);
  }
  assert.throws(() => new Sha256().update(new Uint8Array(3)).state(), /64-byte/);
});

// ── A fake gateway: byte ranges over in-memory files ──
function gateway(files, { corrupt = null, failOnce = new Set(), log = [] } = {}) {
  return async (url, init = {}) => {
    const path = decodeURIComponent(String(url).split('/resolve/')[1]?.split('/').slice(1).join('/') ?? '');
    if (String(url).endsWith('/catalog')) return new Response(JSON.stringify({ releases: [] }), { status: 200 });
    const body = files[path];
    if (!body) return new Response('no', { status: 404 });
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? '');
    const from = +m[1], to = +m[2] + 1;
    log.push([path, from, to]);
    if (init.signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
    const key = `${path}:${from}`;
    if (failOnce.has(key)) { failOnce.delete(key); throw new TypeError('network'); }
    let b = Buffer.from(body.subarray(from, to));
    if (corrupt && corrupt(path, from)) { b = Buffer.from(b); b[0] ^= 1; }
    return new Response(b, { status: 206 });
  };
}
const C = 64 * 1024; // a small chunk for tests (a multiple of 64)

await t('fillFile: ranged download, verified, stored in chunks; retry a failed range', async () => {
  const data = randomBytes(5 * C + 123), f = { name: 'w.bin', bytes: data.length, sha256: H(data) };
  const st = await openStore('t-fill'), log = [];
  const fetchImpl = gateway({ 'w.bin': data }, { failOnce: new Set([`w.bin:${2 * C}`]), log });
  const s = await fillFile(st, 'k', f, rangeSource('https://g/x/y/resolve/r/w.bin', { fetchImpl, onRetry: () => {} }), { chunk: C, parallel: 3 });
  assert.ok(s.verified);
  assert.equal(log.filter((x) => x[1] === 2 * C).length, 2, 'range 2 retried');
  const blob = await verifiedFile(st, 'k', f, { chunk: C });
  assert.equal(H(Buffer.from(await blob.arrayBuffer())), f.sha256);
});
await t('fillFile: stop and resume skips what was kept and verified', async () => {
  const data = randomBytes(8 * C), f = { name: 'w.bin', bytes: data.length, sha256: H(data) };
  const st = await openStore('t-resume'), log = [], ctrl = new AbortController();
  const base = gateway({ 'w.bin': data }, { log });
  let count = 0;
  const fetchImpl = async (u, i) => { if (++count === 4) ctrl.abort(); return base(u, i); };
  await assert.rejects(fillFile(st, 'k', f, rangeSource('https://g/a/b/resolve/r/w.bin', { fetchImpl }), { chunk: C, parallel: 1, signal: ctrl.signal }), /Stopped/);
  const mid = await fileState(st, 'k', f, C);
  assert.ok(mid.bytes > 0 && !mid.complete, `kept ${mid.bytes}`);
  log.length = 0;
  await fillFile(st, 'k', f, rangeSource('https://g/a/b/resolve/r/w.bin', { fetchImpl: base }), { chunk: C });
  assert.equal(log[0][1], mid.bytes, 'resumed at the kept prefix');
  assert.ok((await fileState(st, 'k', f, C)).complete);
});
await t('fillFile: a tampered range refuses the file by name and keeps nothing', async () => {
  const data = randomBytes(3 * C), f = { name: 'onnx/model.onnx_data', bytes: data.length, sha256: H(data) };
  const st = await openStore('t-tamper');
  const fetchImpl = gateway({ 'onnx/model.onnx_data': data }, { corrupt: (p, from) => from === C });
  await assert.rejects(fillFile(st, 'k', f, rangeSource('https://g/a/b/resolve/r/onnx/model.onnx_data', { fetchImpl }), { chunk: C }), (e) => e.code === 'EINTEGRITY' && /onnx\/model\.onnx_data: SHA-256 differs/.test(e.message));
  assert.deepEqual(await st.keys('k'), []);
});
await t('verifiedFile: a damaged kept chunk is refused offline, repaired by range online', async () => {
  const data = randomBytes(3 * C), f = { name: 'w', bytes: data.length, sha256: H(data) };
  const st = await openStore('t-repair');
  await fillFile(st, 'k', f, blobSource(new Blob([data])), { chunk: C });
  await st.put('k#1', new Blob([Buffer.alloc(C)]));
  await assert.rejects(verifiedFile(st, 'k', f, { chunk: C }), /chunk 1 is missing or damaged/);
  const b = await verifiedFile(st, 'k', f, { chunk: C, repair: async (i, a, z) => data.subarray(a, z) });
  assert.equal(b.repaired, 1);
  await st.put('k#2', new Blob([Buffer.alloc(C)]));
  await assert.rejects(verifiedFile(st, 'k', f, { chunk: C, repair: async () => Buffer.alloc(C) }), /still differs from its receipt/);
});

// ── The generic part reassembler ──
await t('partAssets: reassemble, refuse a bad part twice, import parts by name', async () => {
  const PART = 1000, a = randomBytes(2500), w = randomBytes(300);
  const parts = (b) => { const out = []; for (let i = 0; i < b.length; i += PART) { const p = b.subarray(i, i + PART); out.push({ path: H(p) + '.bin', bytes: p.length, sha256: H(p), body: p }); } return out; };
  const pa = parts(a), pw = parts(w);
  const manifest = Buffer.from(JSON.stringify({ format: 2, files: [{ name: 'worker.js', role: 'worker', bytes: w.length, sha256: H(w), parts: pw.map(({ body, ...x }) => x) }, { name: 'x.wasm', role: 'wasm', bytes: a.length, sha256: H(a), parts: pa.map(({ body, ...x }) => x) }] }));
  const served = new Map([['manifest.0123456789abcdef.json', manifest], ...[...pa, ...pw].map((p) => [p.path, p.body])]);
  let bad = null;
  const fetchImpl = async (u) => { const name = String(u).split('/').pop(); const b = served.get(name); if (!b) return new Response('', { status: 404 }); return new Response(name === bad ? Buffer.alloc(b.length) : b); };
  const pin = { dir: 'runtime/t/', manifest: 'manifest.0123456789abcdef.json', sha256: H(manifest) };
  const rt = partAssets(pin, { storeName: 't-rt', base: () => 'https://pouch.test/', fetchImpl });
  const got = await rt.obtain();
  assert.equal(H(Buffer.from(await got.files['x.wasm'].arrayBuffer())), H(a));
  assert.ok((await rt.stored()).complete);
  await rt.remove();
  bad = pa[1].path;
  await assert.rejects(rt.obtain(), /failed its SHA-256 check twice/);
  const rt2 = partAssets(pin, { storeName: 't-rt2', base: () => 'https://pouch.test/', fetchImpl: async () => new Response('', { status: 503 }) });
  const files = [new File([manifest], pin.manifest), ...[...pa, ...pw].map((p) => new File([p.body], p.path)), new File([Buffer.alloc(PART)], pa[0].path)];
  const r = await rt2.importFiles(files.slice(0, -1));
  assert.equal(r.added, pa.length + pw.length);
  assert.equal(H(Buffer.from(await (await rt2.obtain({ network: false })).files['worker.js'].arrayBuffer())), H(w));
});

// ── The model store and `models` command ──
const fakeModel = () => {
  const cfg = Buffer.from('{"a":1}'), weights = randomBytes(4 * C + 7);
  const m = { id: 'tiny-q4', label: 'Tiny', repo: 'org/Tiny-ONNX', revision: 'a'.repeat(40), license: 'Apache-2.0 (test)',
    files: [{ name: 'config.json', bytes: cfg.length, sha256: H(cfg) }, { name: 'onnx/model.onnx_data', bytes: weights.length, sha256: H(weights) }] };
  return { m, served: { 'config.json': cfg, 'onnx/model.onnx_data': weights } };
};
async function sh(cmd, args, who = { by: 'user', via: 'terminal' }) {
  let fn; modelsCommands((name, f) => { fn = f; return name; }, cmd, who);
  return fn(args, {});
}
await t('models: get asks; deny fetches nothing; approve downloads as a /task with stop and resume', async () => {
  const { m, served } = fakeModel(), log = [];
  const store = createModelStore([m], { gateway: 'https://gw/hf', fetchImpl: gateway(served, { log }), chunk: C, parallel: 1 });
  const tasks = new Tasks(), asked = [];
  let answer = false;
  const svc = createModelService({ store, tasks, approve: async (req, who) => { asked.push({ req, who }); return answer; } });
  const st0 = await sh(svc, ['status', 'tiny-q4']);
  assert.match(st0.stdout, /not downloaded .*models get tiny-q4/);
  const denied = await sh(svc, ['get', 'tiny'], { by: 'agent', sid: 1, name: 'main (a1)' });
  assert.equal(denied.exitCode, 1); assert.match(denied.stderr, /denied by the user.*nothing was fetched/);
  assert.equal(log.length, 0, 'nothing fetched on deny');
  assert.equal(asked[0].who.by, 'agent');
  for (const k of ['bytes', 'location', 'license', 'attribution', 'origin']) assert.ok(asked[0].req[k], `sheet names ${k}`);
  answer = true;
  const r = await sh(svc, ['get', 'tiny-q4'], { by: 'agent', sid: 1, name: 'main (a1)' });
  assert.match(r.stdout, /as \/task\/(\d+).*echo stop > \/task\/\d+\/ctl/);
  const id = r.stdout.match(/\/task\/(\d+)/)[1];
  const fs = new TaskFs(tasks, () => null, { sid: 1 });
  assert.match(new TextDecoder().decode(await fs.readFileBuffer(`/${id}/status`)), /running .* download models get tiny-q4/);
  await fs.writeFile(`/${id}/ctl`, 'stop');
  await tasks.get(id).promise.catch(() => {});
  assert.equal(tasks.get(id).status, 'stopped');
  assert.equal(new TaskFs(tasks, () => null, { sid: 2 }).readdir('/').then((l) => l.includes(id)) instanceof Promise, true);
  assert.ok(!(await new TaskFs(tasks, () => null, { sid: 2 }).readdir('/')).includes(String(id)), 'another session cannot see it');
  const w = await sh(svc, ['get', 'tiny-q4', '--wait']);
  assert.equal(w.exitCode, 0, w.stderr); assert.match(w.stdout, /downloaded and verified/);
  assert.match((await sh(svc, ['list', '--offline'])).stdout, /tiny-q4 .* downloaded/);
  const files = await store.files('tiny-q4', { network: false });
  assert.equal(H(Buffer.from(await files.files['onnx/model.onnx_data'].arrayBuffer())), m.files[1].sha256);
});
await t('models remove: the user frees at once; an agent asks; errors teach', async () => {
  const { m, served } = fakeModel();
  const store = createModelStore([m], { gateway: 'https://gw/hf', fetchImpl: gateway(served), chunk: C });
  const tasks = new Tasks(); let answer = true, asks = 0;
  const svc = createModelService({ store, tasks, approve: async () => { asks++; return answer; } });
  await (await svc.get('tiny-q4', { by: 'user' })).promise;
  answer = false;
  const r1 = await sh(svc, ['remove', 'tiny-q4'], { by: 'agent', sid: 1, name: 'main (a1)' });
  assert.equal(r1.exitCode, 1); assert.match(r1.stderr, /denied by the user: Tiny was kept/);
  assert.ok((await store.status('tiny-q4')).complete);
  const before = asks;
  const r2 = await sh(svc, ['remove', 'tiny-q4']);
  assert.equal(r2.exitCode, 0); assert.match(r2.stdout, /freed/); assert.equal(asks, before, 'the user is not asked');
  await assert.rejects(store.files('tiny-q4', { network: false }), /not downloaded .*Run `models get tiny-q4`; the user will be asked to approve/);
  assert.match((await sh(svc, ['get', 'nope'])).stderr, /no pinned model "nope". Run `models list`/);
  assert.equal((await sh(svc, ['frob'])).exitCode, 2);
});
await t('models: a tampered gateway file fails the download task naming the file', async () => {
  const { m, served } = fakeModel();
  const store = createModelStore([m], { gateway: 'https://gw/hf', fetchImpl: gateway(served, { corrupt: (p, from) => p.endsWith('onnx_data') && from === 0 }), chunk: C });
  const svc = createModelService({ store, tasks: new Tasks(), approve: async () => true });
  const r = await sh(svc, ['get', 'tiny-q4', '--wait']);
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /onnx\/model\.onnx_data: SHA-256 differs from the pin/);
});

// ── WebGPU capability, before anything is offered or downloaded ──
const adapter = ({ f16 = true, buffers = MIN_STORAGE_BUFFERS } = {}) => ({ requestAdapter: async () => ({ features: new Set(f16 ? ['shader-f16'] : []), limits: { maxStorageBuffersPerShaderStage: buffers } }) });
await t('gpuSupport: storage-buffer limit 9 vs 10, missing shader-f16, no adapter, no navigator.gpu', async () => {
  assert.deepEqual(await gpuSupport(adapter({ buffers: 10 })), { ok: true });
  assert.deepEqual(await gpuSupport(adapter({ buffers: 16 })), { ok: true });
  const low = await gpuSupport(adapter({ buffers: 9 }));
  assert.equal(low.ok, false);
  assert.equal(low.reason, "This browser's WebGPU allows 9 storage buffers per shader; LFM3 needs 10. Use Chrome or Edge, or a BayLeaf Sealed model.");
  assert.match((await gpuSupport(adapter({ f16: false }))).reason, /lacks shader-f16.*Use Chrome or Edge, or a BayLeaf Sealed model/);
  assert.match((await gpuSupport({ requestAdapter: async () => null })).reason, /no usable graphics adapter/);
  assert.match((await gpuSupport({ requestAdapter: async () => { throw new Error('boom'); } })).reason, /WebGPU failed: boom/);
  assert.match((await gpuSupport(undefined)).reason, /WebGPU is not available/);
});
const UA = {
  pixel: 'Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  tabletAndroid: 'Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};
await t('deviceSupport: phones and tablets refused before any GPU check; a touch laptop is not', () => {
  const no = { ok: false, reason: DEVICE_REASON };
  assert.deepEqual(deviceSupport({ userAgentData: { mobile: true }, userAgent: UA.win }), no); // UA-CH wins over a desktop-looking UA string
  assert.deepEqual(deviceSupport({ userAgent: UA.pixel }), no);
  assert.deepEqual(deviceSupport({ userAgent: UA.tabletAndroid, userAgentData: { mobile: false } }), no);
  assert.deepEqual(deviceSupport({ userAgent: UA.ipad }), no);
  assert.deepEqual(deviceSupport({ userAgent: UA.ipadDesktop, maxTouchPoints: 5 }), no); // iPadOS "Request Desktop Website"
  assert.deepEqual(deviceSupport({ userAgent: UA.ipadDesktop, maxTouchPoints: 0 }), { ok: true }); // a Mac
  assert.deepEqual(deviceSupport({ userAgent: UA.win, userAgentData: { mobile: false }, maxTouchPoints: 10, deviceMemory: 8 }), { ok: true }); // touch laptop
  const low = deviceSupport({ userAgent: UA.win, userAgentData: { mobile: false }, deviceMemory: 4 });
  assert.equal(low.ok, false); assert.match(low.reason, /at least 8 GB of memory; this device reports 4 GB/);
  assert.deepEqual(deviceSupport({}), { ok: true });
  assert.equal(DEVICE_REASON, 'In-browser models are turned off on phones and tablets: on a Pixel test the first request froze the whole phone for about a minute. Use a BayLeaf Sealed model here.');
});
await t('friendlyError: the runtime storage-buffer error reads like the up-front check', () => {
  const raw = '[WebGPU] Kernel "MatMulNBits" failed. Error: shader_helper.cc:308 ValidateVariable numbers_storage_buffers_ <= limits_.maxStorageBuffersPerShaderStage was false. Too many storage buffers in shader. Current: 10, Max is 9';
  assert.equal(friendlyError(raw), "This browser's WebGPU allows 9 storage buffers per shader; LFM3 needs 10. Use Chrome or Edge, or a BayLeaf Sealed model.");
  assert.equal(friendlyError('other failure'), 'other failure');
});
await t('models get refuses up front when the browser cannot run the model: no sheet, nothing fetched; a cached copy is not reported as ready', async () => {
  const { m, served } = fakeModel(), log = [];
  const store = createModelStore([m], { gateway: 'https://gw/hf', fetchImpl: gateway(served, { log }), chunk: C });
  let asks = 0;
  const reason = (await gpuSupport(adapter({ buffers: 9 }))).reason;
  const svc = createModelService({ store, tasks: new Tasks(), approve: async () => { asks++; return true; }, supports: (id) => (id === m.id ? { ok: false, reason } : { ok: true }) });
  const r = await sh(svc, ['get', 'tiny-q4']);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /Tiny cannot run in this browser, so it was not downloaded \(nothing was fetched\)\. This browser's WebGPU allows 9 storage buffers per shader; LFM3 needs 10/);
  assert.equal(asks, 0); assert.equal(log.length, 0);
  await store.download(m.id);
  const cached = await sh(svc, ['get', 'tiny-q4']);
  assert.equal(cached.exitCode, 1);
  assert.match(cached.stderr, /Tiny is downloaded, but cannot run in this browser\. This browser's WebGPU allows 9/);
});

// ── The engine job service ──
const memFs = (files) => ({ readFileBuffer: async (p) => { if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); return new TextEncoder().encode(files[p]); } });
await t('jobs: one engine shared, serial by default, per-job stop, isolation', async () => {
  const tasks = new Tasks({ keep: 50 }); let created = 0;
  const jobs = createJobs({ tasks, engines: { hash: sleepAndHash(sha256hex, { onCreate: () => created++ }) } });
  const alice = { sid: 1, name: 'a1', fs: memFs({ '/work/a.txt': 'alice' }) }, bob = { sid: 2, name: 'a1', fs: memFs({ '/work/b.txt': 'bob' }) };
  const t0 = Date.now();
  const j1 = jobs.submit('hash', { path: '/work/a.txt', ms: 60 }, { caller: alice });
  const j2 = jobs.submit('hash', { path: '/work/b.txt', ms: 60 }, { caller: bob });
  const j3 = jobs.submit('hash', { path: '/work/b.txt', ms: 60 }, { caller: alice }); // alice cannot see bob's file
  const j4 = jobs.submit('hash', { path: '/work/a.txt', ms: 60 }, { caller: alice });
  await new Promise((r) => setTimeout(r, 5));
  await new TaskFs(tasks).writeFile(`/${j4.task.id}/ctl`, 'stop'); // queued: leaves the queue
  assert.equal((await j1.result).sha256, sha256hex(new TextEncoder().encode('alice')));
  assert.equal((await j2.result).sha256, sha256hex(new TextEncoder().encode('bob')));
  await assert.rejects(j3.result, /ENOENT/);
  await assert.rejects(j4.result, /Stopped/);
  assert.equal(created, 1, 'one engine instance');
  assert.ok(Date.now() - t0 >= 170, 'serial');
  assert.deepEqual([j1, j2, j3, j4].map((j) => j.task.status), ['done', 'done', 'failed', 'stopped']);
  assert.ok(!(await new TaskFs(tasks, () => null, { sid: 2 }).readdir('/')).includes(String(j1.task.id)), 'jobs are per-session in /task');
});
await t('jobs: concurrency per engine; stopping a running job leaves its neighbour running', async () => {
  const tasks = new Tasks();
  const jobs = createJobs({ tasks, engines: { hash: sleepAndHash(sha256hex, { concurrency: 2 }) } });
  const c = { sid: 1, name: 'a1', fs: memFs({ '/x': 'x' }) };
  const t0 = Date.now();
  const a = jobs.submit('hash', { path: '/x', ms: 80 }, { caller: c }), b = jobs.submit('hash', { path: '/x', ms: 80 }, { caller: c });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.job.state, 'running'); assert.equal(b.job.state, 'running');
  await tasks.kill(a.task);
  await assert.rejects(a.result, /Stopped/);
  await b.result;
  assert.ok(Date.now() - t0 < 150, 'ran side by side');
  assert.equal(b.task.status, 'done');
});
await t('jobs: memory guard unloads idle engines, refuses when busy; no fs, no job', async () => {
  const GiB = 2 ** 30, tasks = new Tasks(); let disposed = 0;
  const big = (name) => ({ ...sleepAndHash(sha256hex, { memory: 1.5 * GiB }), create() { const e = sleepAndHash(sha256hex).create(); e.dispose = () => { disposed++; }; return e; } });
  const jobs = createJobs({ tasks, budget: 2 * GiB, engines: { ocr: big('ocr'), asr: big('asr') } });
  const c = { sid: 1, name: 'a1', fs: memFs({ '/x': 'x' }) };
  await jobs.submit('ocr', { path: '/x', ms: 1 }, { caller: c }).result;
  await jobs.submit('asr', { path: '/x', ms: 1 }, { caller: c }).result;
  assert.equal(disposed, 1); assert.deepEqual(jobs.loaded(), ['asr']);
  const long = jobs.submit('asr', { path: '/x', ms: 100 }, { caller: c });
  await new Promise((r) => setTimeout(r, 10));
  const refused = jobs.submit('ocr', { path: '/x' }, { caller: c });
  await assert.rejects(refused.result, /not enough memory budget to start ocr.*asr.*busy/);
  await long.result;
  assert.throws(() => jobs.submit('ocr', {}, { caller: { sid: 1 } }), /caller.fs/);
});

// ── No CDN in the built artifact ──
await t('no tool asset defaults to a CDN or the Hub (dist/)', () => {
  assert.throws(() => assertNoCdn('x="https://cdn.jsdelivr.net/npm/a"', 't'), /third-party/);
  assert.throws(() => assertNoCdn('remoteHost:"https://huggingface.co/"', 't'), /third-party/);
  assertNoCdn('see https://huggingface.co/docs/transformers.js', 't');
  if (!existsSync('dist/SHA256SUMS')) { console.log('  (skipped the artifact scan: run node build.mjs first)'); return; }
  const listed = readFileSync('dist/SHA256SUMS', 'utf8').trim().split('\n').map((l) => l.split('  ')[1]);
  let scanned = 0;
  for (const p of listed.filter((x) => /\.(html|js|json|bin)$/.test(x))) {
    const b = readFileSync('dist/' + p);
    if (p.endsWith('.bin') && b.subarray(0, 4).toString('hex') === '0061736d') continue; // wasm binary
    // The one allowed string: the Tinfoil SDK compares Sigstore certificates' OIDC issuer with
    // https://token.actions.githubusercontent.com (an identity, never fetched).
    let text = b.toString('latin1');
    if (p === 'pouch.html') text = text.replaceAll('"https://token.actions.githubusercontent.com"', '"(sigstore issuer)"');
    assertNoCdn(text, p); scanned++;
  }
  assert.ok(scanned >= 3 && listed.some((p) => p.startsWith('runtime/transformers/')), 'runtime listed in SHA256SUMS');
  assert.ok(!listed.some((p) => p.startsWith('models/')), 'no weights in the artifact');
  void readdirSync;
});
await t('approval titles name who asks, the user included', () => {
  assert.equal(askTitle({ action: 'remove', label: 'Qwen', who: { by: 'user', via: 'Settings' } }), 'Remove Qwen?');
  assert.equal(askTitle({ action: 'get', label: 'Qwen', who: { by: 'user' } }), 'Download Qwen?');
  assert.equal(askTitle({ action: 'remove', label: 'Qwen', who: { by: 'agent', name: 'main (a1)' } }), 'main (a1) asks to remove Qwen');
  assert.equal(askTitle({ action: 'get', label: 'Qwen', who: { by: 'agent' } }), 'An agent asks to download Qwen');
});
console.log(`\n${n} passed`);
