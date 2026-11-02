// The Transformers.js provider's files and worker: fetch, verify, keep, load, generate.
//
// Trust: the build embeds LOCAL_MODEL (build-models.mjs): the model's pinned
// files (models.lock.json: name, size, SHA-256) and the SHA-256 of the runtime
// manifest. Two sources, both checked before anything is kept or used:
// - the weights from the BayLeaf HF gateway (src/models.ts), in byte ranges,
//   hashed incrementally against the lock, kept in Cache Storage, resumable;
// - the runtime (the Transformers.js + ORT worker bundle and the ORT wasm) from
//   this page's own origin, as content-hash parts (src/assets.ts partAssets).
// Every later load re-checks every chunk and part and needs no network. The
// worker script is itself a verified part, started from a blob: URL (CSP
// worker-src blob:); it has no network (src/local/worker.ts).
import { createModelStore } from '../models.ts';
import { partAssets } from '../assets.ts';
import type { LocalModel } from '../trust.ts';
import type { LocalAction, LocalGenerateRequest, LocalGenerateResult, LocalLoadResult, LocalReply } from './protocol.ts';

export type { LocalAction, LocalChatMessage, LocalEngine, LocalGenerateRequest, LocalGenerateResult, LocalLoadResult, LocalReply, LocalRequest, LocalToolCall, LocalToolSchema } from './protocol.ts';
export type { LocalModel };
export type Support = { ok: true } | { ok: false; reason: string };
export interface LocalProgress { done: number; total: number; fetched?: number; repaired?: number; phase?: 'runtime' | 'loading' }
// The slices of WebGPU (not in this TypeScript's DOM lib) and Navigator read here.
interface GpuAdapterLike { features?: { has?(feature: string): boolean }; limits?: { maxStorageBuffersPerShaderStage?: number }; info?: { vendor?: string; architecture?: string } }
export interface GpuLike { requestAdapter(): Promise<GpuAdapterLike | null> }
export interface DeviceSignals { userAgentData?: { mobile?: boolean }; userAgent?: string; maxTouchPoints?: number; deviceMemory?: number; gpu?: GpuLike }

export const LOCAL = typeof LOCAL_MODEL !== 'undefined' ? LOCAL_MODEL : null; // eslint-disable-line no-undef
export const models = createModelStore(LOCAL ? [LOCAL] : []);
const pinned = LOCAL && { local: LOCAL, runtime: partAssets(LOCAL.runtime) };
const NOT_BUILT = 'This build of Pouch does not include the local model.';
function pins() { if (!pinned) throw new Error(NOT_BUILT); return pinned; }

// What LFM3 (q4f16) needs from the WebGPU adapter, checked before the picker
// offers it or anything is downloaded. Pouch does not create the device: ONNX
// Runtime Web's WebGPU EP calls requestDevice itself, so this reads the adapter.
// MIN_STORAGE_BUFFERS: Firefox on an M3 Max (2026-11-01, ORT-Web 1.31.0-dev via
// Transformers.js 4.3.2) failed mid-turn in OrtRun with "Too many storage buffers
// in shader. Current: 10, Max is 9"; Chrome on the same machine reports more and
// works. The kernel that needs 10 is not yet identified.
export const MIN_STORAGE_BUFFERS = 10;
const ELSEWHERE = 'Use Chrome or Edge, or a BayLeaf Sealed model.';
const buffersReason = (have: number, need = MIN_STORAGE_BUFFERS) => `This browser's WebGPU allows ${have} storage buffers per shader; LFM3 needs ${need}. ${ELSEWHERE}`;

// gpu: navigator.gpu or a stand-in. Asks for an adapter only: no device, no download.
export async function gpuSupport(gpu: GpuLike | undefined): Promise<Support> {
  if (!gpu) return { ok: false, reason: 'WebGPU is not available in this browser (a recent Chrome or Edge on a computer has it).' };
  let adapter;
  try { adapter = await gpu.requestAdapter(); }
  catch (e) { return { ok: false, reason: 'WebGPU failed: ' + (e instanceof Error ? e.message : String(e)) }; }
  if (!adapter) return { ok: false, reason: 'WebGPU found no usable graphics adapter on this device.' };
  if (!adapter.features?.has?.('shader-f16')) return { ok: false, reason: `This browser's WebGPU lacks shader-f16, which LFM3 (q4f16) needs. ${ELSEWHERE}` };
  const buffers = adapter.limits?.maxStorageBuffersPerShaderStage ?? 0;
  if (buffers < MIN_STORAGE_BUFFERS) return { ok: false, reason: buffersReason(buffers) };
  return { ok: true };
}

// Phones and tablets are refused before any GPU check. Evidence: a Pixel 10 Pro
// (2026-11-01, Chrome Android, WebGPU hardware accelerated) passed gpuSupport and
// downloaded the weights, but the first request (a one-shot prefill of about 4K
// tokens) froze the whole phone for about 60 s with "System UI isn't
// responding", twice, and left GPU glitches behind. A long single GPU submission
// starves the OS compositor on a mobile GPU: scheduling, not memory. Signals, in order:
// - UA_CH_MOBILE: navigator.userAgentData.mobile (Chromium's own answer);
// - UA_MOBILE: the user-agent string names Android, iPhone, iPad or Mobile;
// - IPADOS_DESKTOP_UA: iPadOS Safari claims "Macintosh" but has touch points
//   (no Mac has a touchscreen);
// - LOW_MEMORY: navigator.deviceMemory below 8 (Chrome caps it at 8, so it can
//   only refuse, never qualify).
// A coarse pointer alone is not used: touch laptops would be refused.
export const DEVICE_REASON = 'In-browser models are turned off on phones and tablets: on a Pixel test the first request froze the whole phone for about a minute. Use a BayLeaf Sealed model here.';
const UA_MOBILE = /Android|iPhone|iPad|iPod|Mobile/;
export function deviceSupport({ userAgentData, userAgent = '', maxTouchPoints = 0, deviceMemory }: DeviceSignals = {}): Support {
  if (userAgentData?.mobile === true || UA_MOBILE.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return { ok: false, reason: DEVICE_REASON };
  if (typeof deviceMemory === 'number' && deviceMemory < 8) return { ok: false, reason: `In-browser models need a computer with at least 8 GB of memory; this device reports ${deviceMemory} GB. Use a BayLeaf Sealed model here.` };
  return { ok: true };
}

export async function support(): Promise<Support> {
  if (!LOCAL) return { ok: false, reason: NOT_BUILT };
  const nav: DeviceSignals = globalThis.navigator ?? {};
  const device = deviceSupport(nav);
  return device.ok ? gpuSupport(nav.gpu) : device;
}

// The same limit, met at run time (an adapter that reported more than the device
// got): the friendly reason instead of ORT's raw message.
export function friendlyError(message: string): string {
  const m = /Too many storage buffers in shader\. Current: (\d+), Max is (\d+)/.exec(String(message));
  return m ? buffersReason(Number(m[2]), Number(m[1])) : message;
}

// { bytes, total, complete, persistent, downloading }: the weights (the runtime is small
// and comes from this origin on first load).
export async function stored() {
  if (!LOCAL) return { bytes: 0, total: 0, complete: false };
  const s = await models.status(LOCAL.id);
  return { bytes: s.bytes, total: s.total, complete: s.complete, persistent: s.persistent, downloading: s.downloading };
}

// Verified weights and runtime. onProgress({ done, total, fetched, repaired }).
export async function obtain({ onProgress = () => {}, network = true }: { onProgress?: (p: LocalProgress) => void; network?: boolean } = {}) {
  const { local, runtime } = pins();
  const rt = await runtime.obtain({ network, onProgress: (p: LocalProgress) => onProgress({ ...p, phase: 'runtime' }) });
  const w = await models.files(local.id, { network, onProgress });
  return { runtime: rt, files: w.files, repaired: w.repaired };
}

// A saved copy picked by the user: the original upstream files (by name and size) and/or
// a saved runtime/<group>/ folder (parts by name). Every byte checked like a download.
export async function importFiles(fileList: FileList | File[]) {
  const { local, runtime } = pins();
  const r = await models.ingest(local.id, fileList);
  const rt = await runtime.importFiles(fileList);
  return { added: r.added + rt.added, bad: r.bad.length + rt.bad, refused: r.bad, bytes: r.bytes, total: r.total, complete: r.complete };
}

export async function remove() {
  const { local, runtime } = pins();
  await engine.dispose();
  await models.remove(local.id);
  await runtime.remove();
}

// ── The worker ─────────────────────────────────────────────────────
let worker: Worker | null = null, starting: Promise<LocalLoadResult> | null = null, seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onDelta?: (delta: string) => void }>();
function call<T>(action: LocalAction, data: object = {}, onDelta?: (delta: string) => void) {
  return new Promise<T>((resolve, reject) => {
    if (!worker) throw new Error('The Transformers.js model worker is not running.');
    const id = ++seq;
    // The worker answers each action with that action's result (src/local/worker.ts).
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onDelta });
    worker.postMessage({ id, action, ...data });
  });
}
let chain: Promise<unknown> = Promise.resolve(); // one generation at a time

export const engine = {
  loaded: () => !!worker && !starting,
  // Load the model (downloading what is missing if allowed).
  start({ onProgress, network = true }: { onProgress?: (p: LocalProgress) => void; network?: boolean } = {}): Promise<LocalLoadResult | { loaded: true }> {
    if (worker && !starting) return Promise.resolve({ loaded: true });
    starting ??= (async () => {
      const got = await obtain({ onProgress, network });
      const { bytes } = pins().local;
      onProgress?.({ done: bytes, total: bytes, phase: 'loading' });
      const src = URL.createObjectURL(new Blob([got.runtime.files['worker.js']], { type: 'text/javascript' }));
      worker = new Worker(src, { type: 'module', name: 'pouch-local' });
      URL.revokeObjectURL(src);
      worker.onmessage = ({ data }: MessageEvent<LocalReply>) => {
        if (data.id === undefined) return; // a progress report
        const p = pending.get(data.id);
        if (!p) return;
        if (data.delta !== undefined) return p.onDelta?.(data.delta);
        pending.delete(data.id);
        data.error ? p.reject(new Error(friendlyError(data.error))) : p.resolve(data.result);
      };
      worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(friendlyError(e.message) || 'The Transformers.js model worker failed.')); pending.clear(); };
      const wasm = got.runtime.manifest.files.find((f) => f.role === 'wasm');
      if (!wasm) throw new Error('The Transformers.js runtime manifest names no wasm file.');
      return await call<LocalLoadResult>('load', { files: got.files, wasm: got.runtime.files[wasm.name] });
    })();
    starting.catch(() => { worker?.terminate(); worker = null; }).finally(() => {});
    return starting.then((r) => { starting = null; return r; }, (e) => { starting = null; throw e; });
  },
  generate(req: LocalGenerateRequest, { onDelta, signal }: { onDelta?: (delta: string) => void; signal?: AbortSignal } = {}): Promise<LocalGenerateResult> {
    const run = chain.then(async () => {
      if (!worker || starting) await this.start({ network: navigator.onLine });
      if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
      const stop = () => worker?.postMessage({ action: 'interrupt' });
      signal?.addEventListener('abort', stop, { once: true });
      try { return await call<LocalGenerateResult>('generate', req, onDelta); }
      finally { signal?.removeEventListener('abort', stop); }
    });
    chain = run.catch(() => {});
    return run;
  },
  async dispose(): Promise<void> {
    const w = worker; worker = null; starting = null;
    if (!w) return;
    try { await Promise.race([new Promise((r) => { w.onmessage = r; w.postMessage({ id: -1, action: 'dispose' }); }), new Promise((r) => setTimeout(r, 2000))]); } catch {}
    w.terminate();
  },
};
