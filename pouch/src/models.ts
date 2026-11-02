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
// One store for everyone: the Transformers.js engine (src/local/engine.ts), the
// `models` command (src/models-cli.ts) and Settings' Download/Remove buttons.
import { openStore, fillFile, fileState, verifiedFile, rangeSource, blobSource, dropFile, CHUNK, PARALLEL } from './assets.ts';
import type { FetchImpl, FilePin, VerifiedBlob } from './assets.ts';

// A lock entry (models.lock.json).
export interface ModelPin { id: string; label: string; repo: string; revision: string; license: string; files: FilePin[] }
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
// Parts kept by builds before the gateway (the old manifest: where parts are, nothing more).
interface OldManifest { id: string; revision: string; files?: (FilePin & { parts: { path: string }[] })[] }
export type ModelStore = ReturnType<typeof createModelStore>;

export const GATEWAY = 'https://api.bayleaf.dev/hf';
const STORE = 'pouch-models';
const OLD_CACHE = 'pouch-local-models'; // parts cached from pouch.bayleaf.dev before the gateway

export function createModelStore(models: ModelPin[], { gateway = GATEWAY, fetchImpl = (...a: Parameters<FetchImpl>) => fetch(...a), chunk = CHUNK, parallel = PARALLEL }: { gateway?: string; fetchImpl?: FetchImpl; chunk?: number; parallel?: number } = {}) {
  const byId = new Map<string, ModelPin>(models.map((m) => [m.id, m]));
  const keyOf = (m: ModelPin, f: FilePin) => `${m.repo}@${m.revision}/${f.name}`;
  const urlOf = (m: ModelPin, f: FilePin) => `${gateway}/${m.repo}/resolve/${m.revision}/${f.name.split('/').map(encodeURIComponent).join('/')}`;
  const totalOf = (m: ModelPin) => m.files.reduce((n, f) => n + f.bytes, 0);
  const get = (id: string): ModelPin => {
    const m = byId.get(id);
    if (!m) throw Object.assign(new Error(`unknown model "${id}". Known: ${[...byId.keys()].join(', ') || 'none in this build'}. Run \`models list\`.`), { code: 'ENOENT' });
    return m;
  };
  const running = new Map<string, { promise: Promise<ModelStatus>; ctrl: AbortController }>(); // one download per model at a time

  async function status(id: string): Promise<ModelStatus> {
    const m = get(id), st = await openStore(STORE, { create: false });
    const per = await Promise.all(m.files.map((f) => fileState(st, keyOf(m, f), f, chunk)));
    return { id, label: m.label, total: totalOf(m), bytes: per.reduce((n, p) => n + p.bytes, 0), complete: per.every((p) => p.complete),
      downloading: running.has(id), persistent: st.persistent,
      files: m.files.map((f, i) => ({ name: f.name, bytes: f.bytes, kept: per[i].bytes, complete: per[i].complete })) };
  }

  // Download whatever is missing. onProgress({ done, total, fetched }) in bytes.
  // Returns the running download if one exists (one per model).
  function download(id: string, { signal, onProgress = () => {}, onRetry }: { signal?: AbortSignal; onProgress?: (p: ModelProgress) => void; onRetry?: (r: RangeRetry) => void } = {}): Promise<ModelStatus> {
    const m = get(id);
    if (running.has(id)) return running.get(id)!.promise;
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
      if (!blob) throw Object.assign(new Error(`${m.label} is not downloaded (${(total / 1e9).toFixed(2)} GB). Run \`models get ${m.id}\`; the user will be asked to approve.`), { code: 'ENOTDOWNLOADED' });
      repaired += blob.repaired; out[f.name] = blob;
    }
    return { files: out, repaired };
  }

  // Picked files (the original upstream files, matched by name and size), each hashed
  // against its pin like a download. { added, bad: [names], complete }.
  async function ingest(id: string, list: Iterable<File>) {
    const m = get(id), st = await openStore(STORE), picked = [...list];
    let added = 0; const bad: string[] = [];
    for (const f of m.files) {
      const src = picked.find((x) => x.name === f.name.split('/').pop() && x.size === f.bytes);
      if (!src || (await fileState(st, keyOf(m, f), f, chunk)).complete) continue;
      try { await fillFile(st, keyOf(m, f), f, blobSource(src), { chunk, parallel: 1 }); added++; }
      catch (e) { if ((e as { code?: string }).code === 'EINTEGRITY') bad.push(f.name); else throw e; }
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

  // Parts kept by builds before the gateway (cache pouch-local-models, content-hash
  // parts plus a manifest naming each whole file's SHA-256). Each lock file whose
  // parts are all there is reassembled lazily (a Blob of disk-backed parts) and fed
  // through the same incremental check against the lock; an incomplete file keeps
  // its contiguous prefix. The old cache is deleted afterwards. The old manifest is
  // not trusted for anything but where the parts are: the lock hash decides.
  async function migrate() {
    let old: Cache;
    try { if (!globalThis.caches || !(await caches.has(OLD_CACHE))) return null; old = await caches.open(OLD_CACHE); } catch { return null; }
    const reqs = await old.keys(), byName = new Map<string | undefined, Request>(reqs.map((r) => [r.url.split('/').pop(), r]));
    const report = { migrated: [] as string[], partial: [] as string[], refused: [] as string[], bytes: 0 };
    const st = await openStore(STORE);
    for (const r of reqs.filter((x) => /\/manifest\.[0-9a-f]{16}\.json$/.test(x.url))) {
      let man: OldManifest; try { man = await (await old.match(r))!.json(); } catch { continue; }
      const m = byId.get(man.id);
      if (!m || man.revision !== m.revision) continue;
      for (const f of m.files) {
        const of = man.files?.find((x) => x.name === f.name && x.sha256 === f.sha256 && x.bytes === f.bytes);
        if (!of || (await fileState(st, keyOf(m, f), f, chunk)).complete) continue;
        const blobs: Blob[] = [];
        for (const part of of.parts) { const hit = byName.get(part.path) && await old.match(byName.get(part.path)!); if (!hit) break; blobs.push(await hit.blob()); }
        if (!blobs.length) continue;
        const whole = new Blob(blobs);
        try {
          const s = await fillFile(st, keyOf(m, f), f, blobSource(whole), { chunk, parallel: 1, until: whole.size >= f.bytes ? f.bytes : Math.floor(whole.size / chunk) * chunk });
          (s.verified ? report.migrated : report.partial).push(f.name);
          report.bytes += s.verified ? f.bytes : s.done * chunk;
        } catch (e) { if ((e as { code?: string }).code === 'EINTEGRITY') report.refused.push(f.name); else throw e; }
      }
    }
    await caches.delete(OLD_CACHE);
    return report;
  }

  // The gateway's public catalog (license, distribution, qualification), for display only.
  let catalogCache: ModelRelease[] | null = null;
  async function catalog({ refresh = false } = {}): Promise<ModelRelease[]> {
    if (catalogCache && !refresh) return catalogCache;
    const r = await fetchImpl(`${gateway}/catalog`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${gateway}/catalog: HTTP ${r.status}`);
    catalogCache = ((await r.json()).releases ?? []) as ModelRelease[];
    return catalogCache;
  }
  const release = async (id: string) => { const m = get(id); return (await catalog().catch(() => [])).find((x) => x.repo === m.repo && x.revision === m.revision) ?? null; };

  return { models, get, status, download, stop, files, ingest, remove, migrate, catalog, release, urlOf, totalOf, isDownloading: (id: string) => running.has(id) };
}
