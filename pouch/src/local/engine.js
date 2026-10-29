// The Local lane's files and worker: fetch, verify, keep, load, generate.
//
// Trust: the build embeds the SHA-256 of one manifest (LOCAL_MODEL, from
// build-models.mjs). The manifest lists every part of every file with its
// SHA-256, so each part is checked with crypto.subtle before it is kept or
// used: on download, on every load from storage, and when picked from disk.
// A part that fails is deleted and fetched once more; failing twice refuses.
// Parts come only from this page's own origin (CSP connect-src 'self'), never
// from a CDN or Hugging Face, and are kept in Cache Storage so later loads
// work offline. The worker script is itself a verified part, started from a
// blob: URL (CSP worker-src blob:); it has no network (src/local/worker.js).
export const LOCAL = typeof LOCAL_MODEL !== 'undefined' ? LOCAL_MODEL : null; // eslint-disable-line no-undef
const CACHE = 'pouch-local-models';
const PARALLEL = 4;
// Cache keys do not depend on where the page is served from.
const keyOf = (name) => `https://pouch-local.invalid/${LOCAL.dir}${name}`;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (blob) => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));

export async function support() {
  if (!LOCAL) return { ok: false, reason: 'This build of Pouch does not include the local model.' };
  if (!globalThis.navigator?.gpu) return { ok: false, reason: 'WebGPU is not available in this browser (a recent Chrome or Edge on a computer has it).' };
  try { if (!(await navigator.gpu.requestAdapter())) return { ok: false, reason: 'WebGPU found no usable graphics adapter on this device.' }; }
  catch (e) { return { ok: false, reason: 'WebGPU failed: ' + e.message }; }
  return { ok: true };
}

// Cache Storage, or (where a page cannot use it, e.g. a saved file://
// copy) memory for this page load only.
const mem = new Map();
// create: false only looks (caches.open would create an empty cache again
// after Remove or Erase all, and it would show up as site data).
async function store({ create = true } = {}) {
  try { if (globalThis.caches) { if (!create && !(await caches.has(CACHE))) return { persistent: true, match: async () => undefined, keys: async () => [] }; const c = await caches.open(CACHE); return { persistent: true, match: (n) => c.match(keyOf(n)), put: (n, b) => c.put(keyOf(n), new Response(b)), del: (n) => c.delete(keyOf(n)), keys: async () => (await c.keys()).map((r) => r.url.slice(keyOf('').length)) }; } }
  catch { /* SecurityError on opaque origins */ }
  return { persistent: false, match: async (n) => mem.has(n) ? new Response(mem.get(n)) : undefined, put: async (n, b) => { mem.set(n, b); }, del: async (n) => mem.delete(n), keys: async () => [...mem.keys()] };
}
const url = (name) => new URL(LOCAL.dir + name, document.baseURI).href;

async function verified(st, name, sha256) {
  const r = await st.match(name);
  if (!r) return null;
  const blob = await r.blob(); // immutable: the bytes checked are the bytes used
  if (await digest(blob) === sha256) return blob;
  await st.del(name);
  return null;
}

async function fetchPart(st, part, onBytes, signal) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url(part.path), { signal, cache: attempt > 1 ? 'reload' : 'default' });
    if (!r.ok) throw new Error(`${part.path}: HTTP ${r.status}`);
    const chunks = [], reader = r.body.getReader();
    let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onBytes(value.length); }
    const blob = new Blob(chunks);
    if (blob.size === part.bytes && await digest(blob) === part.sha256) { await st.put(part.path, blob); return blob; }
    onBytes(-got);
    if (attempt >= 2) throw new Error(`Part ${part.path} failed its SHA-256 check twice; nothing from it was used.`);
  }
}

// The manifest the build trusts: from storage, a picked file, or the server.
async function manifest(st, { network = true } = {}) {
  let blob = await verified(st, LOCAL.manifest, LOCAL.sha256);
  if (!blob && network) {
    const r = await fetch(url(LOCAL.manifest), { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Model manifest: HTTP ${r.status}`);
    blob = await r.blob();
    if (await digest(blob) !== LOCAL.sha256) throw new Error('The model manifest does not match this page; refused.');
    await st.put(LOCAL.manifest, blob);
  }
  return blob && JSON.parse(await blob.text());
}
const partsOf = (m) => [{ ...m.worker, path: m.worker.path }, ...m.files.flatMap((f) => f.parts)];

// { bytes, total, complete, persistent }: what is kept in this browser.
export async function stored() {
  if (!LOCAL) return { bytes: 0, total: 0, complete: false };
  const st = await store({ create: false });
  const have = new Set(await st.keys());
  const m = have.has(LOCAL.manifest) ? await manifest(st, { network: false }).catch(() => null) : null;
  const total = LOCAL.bytes;
  if (!m) return { bytes: 0, total, complete: false, persistent: st.persistent };
  const parts = partsOf(m), kept = parts.filter((p) => have.has(p.path));
  return { bytes: kept.reduce((n, p) => n + p.bytes, 0), total, complete: kept.length === parts.length, persistent: st.persistent };
}

// Every file, verified: downloads what is missing (onProgress({ done, total, fetched, repaired })).
export async function obtain({ onProgress = () => {}, signal, network = true } = {}) {
  const st = await store();
  const m = await manifest(st, { network });
  if (!m) throw new Error('The Local model is not on this device. Download it, or load a saved copy from a folder.');
  const parts = partsOf(m), blobs = new Map();
  const p = { done: 0, total: parts.reduce((n, x) => n + x.bytes, 0), fetched: 0, repaired: 0 };
  let next = 0;
  // The first refusal (or the caller's Stop) stops every lane: nothing more is downloaded.
  const halt = new AbortController(), sig = signal ? AbortSignal.any([signal, halt.signal]) : halt.signal;
  async function lane() {
    while (next < parts.length) {
      const part = parts[next++];
      if (sig.aborted) throw new DOMException('Stopped.', 'AbortError');
      const kept = await st.match(part.path);
      let blob = kept && await kept.blob(); // immutable: the bytes checked are the bytes used
      if (blob && await digest(blob) !== part.sha256) { await st.del(part.path); blob = null; p.repaired++; }
      else if (!blob) p.fetched++;
      if (blob) { p.done += part.bytes; onProgress({ ...p }); }
      else {
        if (!network) throw new Error(`Part ${part.path} is missing or damaged, and the network is not available.`);
        blob = await fetchPart(st, part, (n) => { p.done += n; onProgress({ ...p }); }, sig);
      }
      blobs.set(part.path, blob);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, () => lane().catch((e) => { halt.abort(); throw e; })));
  const files = Object.fromEntries(m.files.map((f) => [f.name, new Blob(f.parts.map((x) => blobs.get(x.path)))]));
  return { manifest: m, worker: blobs.get(m.worker.path), files, progress: p, persistent: st.persistent };
}

// A saved copy picked by the user: the dist/models/<id>/ folder (part files by
// name) and/or the original upstream files (matched by name and size, then cut
// at the manifest's part boundaries). Every part is checked like a download.
export async function importFiles(fileList) {
  const st = await store();
  const picked = [...fileList];
  const byName = new Map(picked.map((f) => [f.name, f]));
  let m = await manifest(st, { network: false });
  if (!m) {
    const f = byName.get(LOCAL.manifest);
    if (!f) throw new Error(`Pick the saved model folder: it must contain ${LOCAL.manifest}.`);
    if (await digest(f) !== LOCAL.sha256) throw new Error('That manifest does not match this page; refused.');
    await st.put(LOCAL.manifest, f);
    m = JSON.parse(await f.text());
  }
  let added = 0, bad = 0;
  const offer = async (part, blob) => {
    if (blob.size !== part.bytes || await digest(blob) !== part.sha256) { bad++; return; }
    await st.put(part.path, blob); added++;
  };
  const have = new Set(await st.keys());
  for (const part of partsOf(m)) if (!have.has(part.path) && byName.has(part.path)) await offer(part, byName.get(part.path));
  for (const file of m.files) {
    const src = picked.find((f) => f.name === file.name.split('/').pop() && f.size === file.bytes);
    if (!src) continue;
    let at = 0;
    for (const part of file.parts) { if (!have.has(part.path)) await offer(part, src.slice(at, at + part.bytes)); at += part.bytes; }
  }
  return { added, bad, ...(await stored()) };
}

export async function remove() {
  await engine.dispose();
  mem.clear();
  try { await caches.delete(CACHE); } catch {}
}

// ── The worker ─────────────────────────────────────────────────────
let worker = null, starting = null, seq = 0;
const pending = new Map();
function call(action, data = {}, onDelta) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onDelta });
    worker.postMessage({ id, action, ...data });
  });
}
let chain = Promise.resolve(); // one generation at a time

export const engine = {
  loaded: () => !!worker && !starting,
  // Load the model (downloading what is missing if allowed).
  start({ onProgress, network = true } = {}) {
    if (worker && !starting) return Promise.resolve({ loaded: true });
    starting ??= (async () => {
      const got = await obtain({ onProgress, network });
      onProgress?.({ ...got.progress, phase: 'loading' });
      const src = URL.createObjectURL(new Blob([got.worker], { type: 'text/javascript' }));
      worker = new Worker(src, { type: 'module', name: 'pouch-local' });
      URL.revokeObjectURL(src);
      worker.onmessage = ({ data }) => {
        const p = pending.get(data.id);
        if (data.progress) return;
        if (!p) return;
        if (data.delta !== undefined) return p.onDelta?.(data.delta);
        pending.delete(data.id);
        data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
      };
      worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'The Local model worker failed.')); pending.clear(); };
      const wasm = got.manifest.files.find((f) => f.role === 'wasm');
      const files = Object.fromEntries(Object.entries(got.files).filter(([n]) => n !== wasm.name));
      return await call('load', { files, wasm: got.files[wasm.name] });
    })();
    starting.catch(() => { worker?.terminate(); worker = null; }).finally(() => {});
    return starting.then((r) => { starting = null; return r; }, (e) => { starting = null; throw e; });
  },
  generate(req, { onDelta, signal } = {}) {
    const run = chain.then(async () => {
      if (!worker || starting) await this.start({ network: navigator.onLine });
      if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
      const stop = () => worker?.postMessage({ action: 'interrupt' });
      signal?.addEventListener('abort', stop, { once: true });
      try { return await call('generate', req, onDelta); }
      finally { signal?.removeEventListener('abort', stop); }
    });
    chain = run.catch(() => {});
    return run;
  },
  async dispose() {
    const w = worker; worker = null; starting = null;
    if (!w) return;
    try { await Promise.race([new Promise((r) => { w.onmessage = r; w.postMessage({ id: -1, action: 'dispose' }); }), new Promise((r) => setTimeout(r, 2000))]); } catch {}
    w.terminate();
  },
};
