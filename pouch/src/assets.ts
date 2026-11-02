// Hash-verified assets: the one way Pouch turns bytes from the network (or a
// picked file) into something it runs. Two sources, one rule: nothing is used
// unless its SHA-256 matches a hash the page was built with.
//
//   partAssets(...)  runtime files from Pouch's own origin, cut by the build
//                    into content-addressed parts of at most 20 MiB (Cloudflare
//                    Static Assets refuses files over 25 MiB). Each part is
//                    checked with crypto.subtle; a manifest whose SHA-256 the
//                    page embeds lists them. Any tool's worker, wasm or data.
//   fillFile(...)    one large upstream file (model weights) fetched from the
//                    BayLeaf HF gateway in byte ranges, hashed incrementally
//                    (src/sha256.ts) against the pinned whole-file SHA-256,
//                    kept in CHUNK-sized pieces, resumable after a reload.
//
// Storage is Cache Storage (memory for one page load where it is unavailable,
// e.g. a saved file:// copy). Blobs read back from Cache Storage are backed by
// disk, so assembling a 1 GB Blob from chunks costs no memory; only the chunk
// being checked is in memory. Every load re-checks every chunk (crypto.subtle
// against the receipt recorded when the whole file matched its pin).
import { Sha256 } from './sha256.ts';
import type { Sha256State } from './sha256.ts';

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
// A pinned upstream file (a lock entry's file), or a manifest's file.
export interface FilePin { name: string; bytes: number; sha256: string }
// A build define naming a manifest of content-addressed parts.
export interface PartsPin { dir: string; manifest: string; sha256: string; bytes?: number }
interface Part { path: string; bytes: number; sha256: string }
// role: what the file is to its runtime (build-models.mjs marks the 'wasm').
export interface PartsManifest { files: (FilePin & { parts: Part[]; role?: string })[] }
// What an engine needs of partAssets: the runtime's verified files by name.
export type RuntimeFiles = Record<string, Blob>;
export interface ObtainedRuntime { files: RuntimeFiles }
export interface RuntimeAssets { obtain(opts: { network?: boolean; signal?: AbortSignal }): Promise<ObtainedRuntime> }
export interface AssetProgress { done: number; total: number; fetched: number; repaired: number }
// Bytes for chunk i, [from, to) of the file.
export type RangeSource = (i: number, from: number, to: number, signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
export type VerifiedBlob = Blob & { repaired: number };

// Range and storage unit for large files (a multiple of 64; tests define POUCH_CHUNK smaller).
export const CHUNK = typeof POUCH_CHUNK !== 'undefined' ? POUCH_CHUNK : 32 * 2 ** 20; // eslint-disable-line no-undef
export const PARALLEL = 4;               // ranges in flight
const RETRIES = 3;                       // per range, for network errors and short bodies
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const digest = async (data: Blob | BufferSource) => hex(await crypto.subtle.digest('SHA-256', data instanceof Blob ? await data.arrayBuffer() : data));
const stopped = () => new DOMException('Stopped.', 'AbortError');
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(stopped()); }, { once: true }); });
export const mib = (n: number) => `${(n / 2 ** 20).toFixed(n < 10 * 2 ** 20 ? 1 : 0)} MiB`;

// ── Storage ──────────────────────────────────────────────────────────
export interface AssetStore {
  persistent: boolean; get(k: string): Promise<Blob | null>; put(k: string, b: Blob | string): Promise<void>;
  del(k: string): Promise<unknown>; keys(prefix?: string): Promise<string[]>; drop(): Promise<unknown>;
}
const mem = new Map<string, Map<string, Blob | string>>(); // for pages without Cache Storage
export async function openStore(name: string, { create = true }: { create?: boolean } = {}): Promise<AssetStore> {
  const base = `https://${name}.invalid/`;
  try {
    if (globalThis.caches) {
      // create: false only looks (caches.open would create an empty cache, which shows up as site data).
      if (!create && !(await caches.has(name))) return { persistent: true, get: async () => null, put: async () => {}, del: async () => {}, keys: async () => [], drop: async () => {} };
      const c = await caches.open(name);
      // Keys become one encoded path segment: Cache Storage ignores a URL's #fragment
      // (chunk keys end in #<i>) and treats ? as a query.
      const at = (k: string) => base + encodeURIComponent(k);
      return {
        persistent: true,
        get: async (k) => (await (await c.match(at(k)))?.blob()) ?? null,
        put: (k, b) => c.put(at(k), new Response(b)),
        del: (k) => c.delete(at(k)),
        keys: async (prefix = '') => (await c.keys()).map((r) => decodeURIComponent(r.url.slice(base.length))).filter((k) => k.startsWith(prefix)),
        drop: () => caches.delete(name),
      };
    }
  } catch { /* SecurityError on opaque origins */ }
  const m = mem.get(name) ?? mem.set(name, new Map()).get(name)!;
  return {
    persistent: false,
    get: async (k) => m.has(k) ? new Blob([m.get(k)!]) : null,
    put: async (k, b) => { m.set(k, b); },
    del: async (k) => { m.delete(k); },
    keys: async (prefix = '') => [...m.keys()].filter((k) => k.startsWith(prefix)),
    drop: async () => { mem.delete(name); },
  };
}

// ── Parts from Pouch's origin (the generic reassembler) ──────────────
// pin: { dir: 'runtime/<group>/', manifest: 'manifest.<16>.json', sha256 } (a build define).
// Manifest (format 2): { files: [{ name, bytes, sha256, parts: [{ path, bytes, sha256 }] }] }.
// A part that fails is deleted and fetched once more; failing twice refuses.
export type PartAssets = ReturnType<typeof partAssets>;
export function partAssets(pin: PartsPin, { storeName = 'pouch-runtime', base = () => globalThis.document?.baseURI ?? location.href, fetchImpl = (...a: Parameters<FetchImpl>) => fetch(...a) }: { storeName?: string; base?: () => string; fetchImpl?: FetchImpl } = {}) {
  const url = (name: string) => new URL(pin.dir + name, base()).href;
  const key = (name: string) => pin.dir + name;
  async function manifest(st: AssetStore, { network = true } = {}): Promise<PartsManifest | null> {
    let blob = await st.get(key(pin.manifest));
    if (blob && await digest(blob) !== pin.sha256) { await st.del(key(pin.manifest)); blob = null; }
    if (!blob && network) {
      const r = await fetchImpl(url(pin.manifest), { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${pin.dir}${pin.manifest}: HTTP ${r.status}`);
      blob = await r.blob();
      if (await digest(blob) !== pin.sha256) throw new Error(`${pin.dir}${pin.manifest} does not match this page; refused.`);
      await st.put(key(pin.manifest), blob);
    }
    return blob && JSON.parse(await blob.text());
  }
  async function fetchPart(st: AssetStore, part: Part, onBytes: (n: number) => void, signal: AbortSignal): Promise<Blob> {
    for (let attempt = 1; ; attempt++) {
      const r = await fetchImpl(url(part.path), { signal, cache: attempt > 1 ? 'reload' : 'default' });
      if (!r.ok) throw new Error(`${pin.dir}${part.path}: HTTP ${r.status}`);
      const blob = await r.blob();
      onBytes(blob.size);
      if (blob.size === part.bytes && await digest(blob) === part.sha256) { await st.put(key(part.path), blob); return blob; }
      onBytes(-blob.size);
      if (attempt >= 2) throw new Error(`Part ${pin.dir}${part.path} failed its SHA-256 check twice; nothing from it was used.`);
    }
  }
  return {
    pin,
    // { bytes, total, complete, persistent }
    async stored() {
      const st = await openStore(storeName, { create: false });
      const m = await manifest(st, { network: false }).catch(() => null);
      if (!m) return { bytes: 0, total: pin.bytes ?? 0, complete: false, persistent: st.persistent };
      const have = new Set(await st.keys(pin.dir)), parts = m.files.flatMap((f) => f.parts);
      const kept = parts.filter((p) => have.has(key(p.path)));
      return { bytes: kept.reduce((n, p) => n + p.bytes, 0), total: parts.reduce((n, p) => n + p.bytes, 0), complete: kept.length === parts.length, persistent: st.persistent };
    },
    // Every file as a verified Blob: { manifest, files: { name: Blob }, progress }.
    async obtain({ onProgress = () => {}, signal, network = true }: { onProgress?: (p: AssetProgress) => void; signal?: AbortSignal; network?: boolean } = {}) {
      const st = await openStore(storeName);
      const m = await manifest(st, { network });
      if (!m) throw new Error(`The runtime files (${pin.dir}) are not in this browser, and the network is not available.`);
      const parts = m.files.flatMap((f) => f.parts), blobs = new Map<string, Blob>();
      const p = { done: 0, total: parts.reduce((n, x) => n + x.bytes, 0), fetched: 0, repaired: 0 };
      let next = 0;
      const halt = new AbortController(), sig = signal ? AbortSignal.any([signal, halt.signal]) : halt.signal;
      async function stream() {
        while (next < parts.length) {
          const part = parts[next++];
          if (sig.aborted) throw stopped();
          let blob = await st.get(key(part.path));
          if (blob && (blob.size !== part.bytes || await digest(blob) !== part.sha256)) { await st.del(key(part.path)); blob = null; p.repaired++; }
          else if (!blob) p.fetched++;
          if (blob) { p.done += part.bytes; onProgress({ ...p }); }
          else {
            if (!network) throw new Error(`Part ${pin.dir}${part.path} is missing or damaged, and the network is not available.`);
            blob = await fetchPart(st, part, (n) => { p.done += n; onProgress({ ...p }); }, sig);
          }
          blobs.set(part.path, blob);
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, () => stream().catch((e) => { halt.abort(); throw e; })));
      return { manifest: m, files: Object.fromEntries(m.files.map((f) => [f.name, new Blob(f.parts.map((x) => blobs.get(x.path)!))])), progress: p, persistent: st.persistent };
    },
    // Picked files: the manifest and parts by name (a saved runtime/<group>/ folder). Each checked.
    async importFiles(list: Iterable<File>) {
      const st = await openStore(storeName), byName = new Map([...list].map((f) => [f.name, f]));
      let m = await manifest(st, { network: false });
      if (!m && byName.has(pin.manifest)) {
        const f = byName.get(pin.manifest)!;
        if (await digest(f) !== pin.sha256) throw new Error(`${pin.manifest} does not match this page; refused.`);
        await st.put(key(pin.manifest), f); m = JSON.parse(await f.text());
      }
      let added = 0, bad = 0;
      if (m) for (const part of m.files.flatMap((f) => f.parts)) {
        const f = byName.get(part.path);
        if (!f) continue;
        if (f.size === part.bytes && await digest(f) === part.sha256) { await st.put(key(part.path), f); added++; } else bad++;
      }
      return { added, bad, manifest: !!m };
    },
    async remove() { const st = await openStore(storeName, { create: false }); for (const k of await st.keys(pin.dir)) await st.del(k); },
  };
}

// ── One large file in chunks, hashed as it arrives ───────────────────
// f: { name, bytes, sha256 } (the pin). key: storage prefix for this file.
// State (JSON at key + '.state'): { sha256, bytes, chunk, done, states: [hash state after
// chunk i], chunks: [crypto.subtle SHA-256 of chunk i], verified }. Chunks 0..done-1 are
// stored and hashed in order; `verified` is set only when the whole file matched the pin,
// and from then on chunks[] are receipts that later loads check each chunk against.
export interface ChunkState { sha256: string; bytes: number; chunk: number; done: number; states: (Sha256State | null)[]; chunks: string[]; verified: boolean }
const chunkKey = (key: string, i: number) => `${key}#${i}`;
async function readState(st: AssetStore, key: string, f: FilePin, chunk: number): Promise<ChunkState> {
  try {
    const s = JSON.parse(await (await st.get(key + '.state'))?.text() ?? 'null');
    if (s && s.sha256 === f.sha256 && s.bytes === f.bytes && s.chunk === chunk) return s;
  } catch { /* unreadable: start over */ }
  return { sha256: f.sha256, bytes: f.bytes, chunk, done: 0, states: [], chunks: [], verified: false };
}
const writeState = (st: AssetStore, key: string, s: ChunkState) => st.put(key + '.state', new Blob([JSON.stringify(s)]));
export async function dropFile(st: AssetStore, key: string) { for (const k of await st.keys(key + '#')) await st.del(k); await st.del(key + '.state'); }

// How much of f is kept: { bytes, complete }. Cheap: reads only the state.
export async function fileState(st: AssetStore, key: string, f: FilePin, chunk = CHUNK) {
  const s = await readState(st, key, f, chunk);
  return { bytes: s.verified ? f.bytes : Math.min(s.done * chunk, f.bytes), complete: !!s.verified };
}

// Feed chunks from `source(i, from, to) -> Promise<Uint8Array>` into the file, resuming
// where the state says, `parallel` sources in flight, hashed and stored strictly in order.
// Throws, with the file's name, if the whole does not match the pin (and drops it all).
export async function fillFile(st: AssetStore, key: string, f: FilePin, source: RangeSource,
  { chunk = CHUNK, parallel = PARALLEL, signal, onBytes = () => {}, until = f.bytes }: { chunk?: number; parallel?: number; signal?: AbortSignal; onBytes?: (n: number, kind: 'kept' | 'new') => void; until?: number } = {}) {
  let s = await readState(st, key, f, chunk);
  if (s.verified) return s;
  const n = Math.ceil(f.bytes / chunk) || 1;
  // A resumed prefix is checked against what was recorded as it was stored.
  for (let i = 0; i < s.done; i++) {
    const b = await st.get(chunkKey(key, i));
    if (!b || await digest(b) !== s.chunks[i]) { s.done = i; s.states.length = i; s.chunks.length = i; break; }
  }
  onBytes(Math.min(s.done * chunk, f.bytes), 'kept');
  const hash = s.done ? Sha256.resume(s.states[s.done - 1]!) : new Sha256();
  const halt = new AbortController(), sig = signal ? AbortSignal.any([signal, halt.signal]) : halt.signal;
  const inflight = new Map<number, Promise<Uint8Array<ArrayBuffer>>>();
  let next = s.done;
  const last = Math.min(n, Math.ceil(until / chunk));
  const launch = () => {
    while (next < last && inflight.size < parallel) {
      const i = next++, from = i * chunk, to = Math.min(f.bytes, from + chunk);
      const p = source(i, from, to, sig).then((b) => { if (b.length !== to - from) throw new Error(`${f.name}: chunk ${i} has ${b.length} bytes, expected ${to - from}`); return b; });
      p.catch(() => {});
      inflight.set(i, p);
    }
  };
  try {
    for (let i = s.done; i < last; i++) {
      launch();
      const bytes = await inflight.get(i)!;
      inflight.delete(i);
      if (sig.aborted) throw stopped();
      // Hash in 4 MiB slices, yielding between them, so the page stays responsive.
      for (let at = 0; at < bytes.length; at += 4 << 20) { hash.update(bytes.subarray(at, at + (4 << 20))); await new Promise((r) => setTimeout(r, 0)); }
      s.chunks[i] = await digest(bytes);
      await st.put(chunkKey(key, i), new Blob([bytes]));
      s.states[i] = i < n - 1 ? hash.state() : null;
      s.done = i + 1;
      await writeState(st, key, s);
      onBytes(bytes.length, 'new');
    }
  } catch (e) { halt.abort(); throw e; }
  if (s.done < n) return s; // `until` stopped early (a partial source)
  const got = hash.hex();
  if (got !== f.sha256) {
    await dropFile(st, key);
    throw Object.assign(new Error(`${f.name}: SHA-256 differs from the pin (expected ${f.sha256.slice(0, 16)}..., got ${got.slice(0, 16)}...); the downloaded bytes were discarded and nothing from them was used.`), { code: 'EINTEGRITY', file: f.name });
  }
  s.verified = true; s.states = [];
  await writeState(st, key, s);
  return s;
}

// A source of byte ranges over HTTP (the gateway answers 206 to `Range: bytes=a-b`).
// Each range is retried on network errors and short bodies, with backoff.
export function rangeSource(url: string, { fetchImpl = (...a: Parameters<FetchImpl>) => fetch(...a), retries = RETRIES, onRetry = () => {} }: { fetchImpl?: FetchImpl; retries?: number; onRetry?: (r: { i: number; attempt: number; error: string }) => void } = {}): RangeSource {
  return async (i, from, to, signal) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetchImpl(url, { signal, headers: { Range: `bytes=${from}-${to - 1}` } });
        if (r.status === 200 && from === 0) { const b = new Uint8Array(await r.arrayBuffer()); if (b.length === to) return b; throw new Error('the server ignored the byte range'); }
        if (r.status !== 206) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: r.status === 404 || r.status === 416 || r.status === 403 });
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length !== to - from) throw new Error(`short body (${b.length} of ${to - from} bytes)`);
        return b;
      } catch (e) {
        if (signal?.aborted) throw stopped();
        if ((e as { fatal?: boolean }).fatal || attempt > retries) throw new Error(`${url.split('/resolve/')[1] ?? url} bytes ${from}-${to - 1}: ${(e as Error).message}`);
        onRetry({ i, attempt, error: (e as Error).message });
        await sleep(500 * 2 ** attempt, signal);
      }
    }
  };
}
// A source over a Blob or File already here (a picked file, or old parts reassembled).
export const blobSource = (blob: Blob): RangeSource => async (i, from, to) => new Uint8Array(await blob.slice(from, to).arrayBuffer());

// The verified file as one Blob: every chunk re-checked against its receipt.
// repair(i, from, to) may fetch a damaged chunk again (checked against the same receipt).
export async function verifiedFile(st: AssetStore, key: string, f: FilePin, { chunk = CHUNK, repair, onBytes = () => {} }: { chunk?: number; repair?: RangeSource | null; onBytes?: (n: number) => void } = {}): Promise<VerifiedBlob | null> {
  const s = await readState(st, key, f, chunk);
  if (!s.verified) return null;
  const n = Math.ceil(f.bytes / chunk) || 1, parts: Blob[] = [];
  let repaired = 0;
  for (let i = 0; i < n; i++) {
    let b = await st.get(chunkKey(key, i));
    if (!b || await digest(b) !== s.chunks[i]) {
      if (!repair) throw Object.assign(new Error(`${f.name}: chunk ${i} is missing or damaged, and the network is not available.`), { code: 'EDAMAGED' });
      const from = i * chunk, to = Math.min(f.bytes, from + chunk);
      const bytes = await repair(i, from, to);
      if (await digest(bytes) !== s.chunks[i]) throw new Error(`${f.name}: chunk ${i} fetched again still differs from its receipt; refused.`);
      b = new Blob([bytes]); await st.put(chunkKey(key, i), b); repaired++;
    }
    parts.push(b); onBytes(b.size);
  }
  const blob = new Blob(parts) as VerifiedBlob;
  blob.repaired = repaired;
  return blob;
}
