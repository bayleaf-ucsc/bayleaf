// Model weights in this browser, from the BayLeaf HF artifact gateway.
//
// The gateway (api.bayleaf.dev/hf, issue #121) serves approved Hugging Face
// files from BayLeaf's mirror: keyless, Hub-shaped, byte ranges. Pouch pins
// every file's size and SHA-256 in the build (models.lock.json, define
// LOCAL_MODEL), and that pin is the authority: the gateway's catalog is shown
// to the user (license, qualification) but never trusted for bytes. Each file
// arrives in CHUNK ranges, is hashed incrementally against its pin
// (src/assets.ts fillFile) and kept in Cache Storage, resumable after Stop or a
// reload; a mismatch refuses the file and names it.
//
// The gateway files backend of add-ons (src/addons.ts gatewayBackend): the
// `addons` command, Settings > Add-ons and the Transformers.js worker all reach
// these files through that service.
import { openStore, fillFile, fileState, verifiedFile, rangeSource, blobSource, dropFile, CHUNK, PARALLEL } from './assets.ts';
import type { FetchImpl, VerifiedBlob } from './assets.ts';
import type { FilePin, ModelPin } from './trust.ts';

// A lock entry (models.lock.json).
export type { ModelPin };
export interface ModelStatus {
  id: string; label: string; total: number; bytes: number; complete: boolean; downloading: boolean; persistent: boolean;
  files: { name: string; bytes: number; kept: number; complete: boolean }[];
}
export interface ModelProgress { done: number; total: number; fetched: number; repaired?: number; file?: string }
export interface RangeRetry { i: number; attempt: number; error: string }
// A gateway catalog release, display only (never trusted for bytes).
export interface ModelRelease {
  repo: string; revision: string; files: { bytes: number }[]; license?: { name?: string; url?: string }; base_model?: string;
  distribution?: { basis?: string }; qualification?: { client: string; status: string }[];
}
export type ModelStore = ReturnType<typeof createModelStore>;

export const GATEWAY = 'https://api.bayleaf.dev/hf';
const STORE = 'pouch-models';
// fillFile's EINTEGRITY and friends.
const codeOf = (e: unknown) => (e instanceof Error && 'code' in e ? e.code : undefined);
// A catalog entry Pouch can match and size; the rest is optional display, but
// what `addons info` and the install sheet read must have the shape they read.
const isObj = (x: unknown): x is object => typeof x === 'object' && x !== null;
const optString = (o: object, k: string) => !(k in o) || Reflect.get(o, k) === undefined || typeof Reflect.get(o, k) === 'string';
const isRelease = (r: unknown): r is ModelRelease => isObj(r) && 'repo' in r && typeof r.repo === 'string'
  && 'revision' in r && typeof r.revision === 'string'
  && 'files' in r && Array.isArray(r.files) && r.files.every((f) => isObj(f) && 'bytes' in f && typeof f.bytes === 'number')
  && optString(r, 'base_model')
  && (!('license' in r) || r.license == null || isObj(r.license) && optString(r.license, 'name') && optString(r.license, 'url'))
  && (!('distribution' in r) || r.distribution == null || isObj(r.distribution) && optString(r.distribution, 'basis'))
  && (!('qualification' in r) || r.qualification == null || Array.isArray(r.qualification)
    && r.qualification.every((q) => isObj(q) && 'client' in q && typeof q.client === 'string' && 'status' in q && typeof q.status === 'string'));

export function createModelStore(models: ModelPin[], { gateway = GATEWAY, fetchImpl = (...a: Parameters<FetchImpl>) => fetch(...a), chunk = CHUNK, parallel = PARALLEL }: { gateway?: string; fetchImpl?: FetchImpl; chunk?: number; parallel?: number } = {}) {
  const byId = new Map<string, ModelPin>(models.map((m) => [m.id, m]));
  const keyOf = (m: ModelPin, f: FilePin) => `${m.repo}@${m.revision}/${f.name}`;
  const urlOf = (m: ModelPin, f: FilePin) => `${gateway}/${m.repo}/resolve/${m.revision}/${f.name.split('/').map(encodeURIComponent).join('/')}`;
  const totalOf = (m: ModelPin) => m.files.reduce((n, f) => n + f.bytes, 0);
  const get = (id: string): ModelPin => {
    const m = byId.get(id);
    if (!m) throw Object.assign(new Error(`unknown model "${id}". Known: ${[...byId.keys()].join(', ') || 'none in this build'}. Run \`addons list\`.`), { code: 'ENOENT' });
    return m;
  };
  const running = new Map<string, { promise: Promise<ModelStatus>; ctrl: AbortController }>(); // one install per model at a time

  async function status(id: string): Promise<ModelStatus> {
    const m = get(id), st = await openStore(STORE, { create: false });
    const per = await Promise.all(m.files.map((f) => fileState(st, keyOf(m, f), f, chunk)));
    return { id, label: m.label, total: totalOf(m), bytes: per.reduce((n, p) => n + p.bytes, 0), complete: per.every((p) => p.complete),
      downloading: running.has(id), persistent: st.persistent,
      files: m.files.map((f, i) => ({ name: f.name, bytes: f.bytes, kept: per[i].bytes, complete: per[i].complete })) };
  }

  // Fetch whatever is missing. onProgress({ done, total, fetched }) in bytes.
  // Returns the running fill if one exists (one per model).
  function download(id: string, { signal, onProgress = () => {}, onRetry }: { signal?: AbortSignal; onProgress?: (p: ModelProgress) => void; onRetry?: (r: RangeRetry) => void } = {}): Promise<ModelStatus> {
    const m = get(id);
    const already = running.get(id);
    if (already) return already.promise;
    const ctrl = new AbortController(), sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    const promise = (async () => {
      const st = await openStore(STORE);
      const p = { done: 0, total: totalOf(m), fetched: 0 };
      // Small files first, then the large one: a stop leaves the many small ones done.
      for (const f of [...m.files].sort((a, b) => a.bytes - b.bytes)) {
        if (sig.aborted) throw new DOMException('Stopped.', 'AbortError');
        await fillFile(st, keyOf(m, f), f, rangeSource(urlOf(m, f), { fetchImpl, onRetry }), { chunk, parallel, signal: sig,
          onBytes: (n, kind) => { p.done += n; if (kind === 'new') p.fetched += n; onProgress({ ...p, file: f.name }); } });
      }
      return status(id);
    })().finally(() => running.delete(id));
    running.set(id, { promise, ctrl });
    return promise;
  }
  const stop = (id: string) => running.get(id)?.ctrl.abort();

  // Every file as a verified Blob (re-checked chunk by chunk); a damaged chunk is
  // fetched again by range when the network may be used.
  async function files(id: string, { network = true, onProgress = () => {} }: { network?: boolean; onProgress?: (p: ModelProgress) => void } = {}) {
    const m = get(id), st = await openStore(STORE, { create: false }), out: Record<string, VerifiedBlob> = {};
    let done = 0, repaired = 0;
    const total = totalOf(m);
    for (const f of m.files) {
      const blob = await verifiedFile(st, keyOf(m, f), f, { chunk, repair: network ? (i, from, to) => rangeSource(urlOf(m, f), { fetchImpl })(i, from, to) : null,
        onBytes: (n) => { done += n; onProgress({ done, total, fetched: 0, repaired }); } });
      if (!blob) throw Object.assign(new Error(`not installed: ${m.label} (${(total / 1e9).toFixed(1)} GB). Run \`addons install ${m.id}\`; the user will be asked.`), { code: 'ENOTINSTALLED' });
      repaired += blob.repaired; out[f.name] = blob;
    }
    return { files: out, repaired };
  }

  // Picked files (the original upstream files, matched by name and size), each hashed
  // against its pin like an install. { added, bad: [names], complete }.
  async function ingest(id: string, list: Iterable<File>) {
    const m = get(id), st = await openStore(STORE), picked = [...list];
    let added = 0; const bad: string[] = [];
    for (const f of m.files) {
      const src = picked.find((x) => x.name === f.name.split('/').pop() && x.size === f.bytes);
      if (!src || (await fileState(st, keyOf(m, f), f, chunk)).complete) continue;
      try { await fillFile(st, keyOf(m, f), f, blobSource(src), { chunk, parallel: 1 }); added++; }
      catch (e) { if (codeOf(e) === 'EINTEGRITY') bad.push(f.name); else throw e; }
    }
    return { added, bad, ...(await status(id)) };
  }

  async function remove(id: string) {
    const m = get(id);
    stop(id);
    await running.get(id)?.promise.catch(() => {});
    const st = await openStore(STORE, { create: false });
    for (const f of m.files) await dropFile(st, keyOf(m, f));
    if (!(await st.keys()).length) await st.drop();
  }

  // The gateway's public catalog (license, distribution, qualification), for display only.
  let catalogCache: ModelRelease[] | null = null;
  async function catalog({ refresh = false } = {}): Promise<ModelRelease[]> {
    if (catalogCache && !refresh) return catalogCache;
    const r = await fetchImpl(`${gateway}/catalog`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${gateway}/catalog: HTTP ${r.status}`);
    const body: unknown = await r.json();
    const releases = typeof body === 'object' && body !== null && 'releases' in body && Array.isArray(body.releases) ? body.releases : [];
    catalogCache = releases.filter(isRelease); // display only: an entry without repo, revision and files is skipped
    return catalogCache;
  }
  const release = async (id: string) => { const m = get(id); return (await catalog().catch(() => [])).find((x) => x.repo === m.repo && x.revision === m.revision) ?? null; };

  // The storage key of each pinned file (its chunks are key#i, its state key.state).
  const keysOf = (id: string) => { const m = get(id); return m.files.map((f) => keyOf(m, f)); };
  return { models, get, status, download, stop, files, ingest, remove, catalog, keysOf, release, urlOf, totalOf, isDownloading: (id: string) => running.has(id) };
}
