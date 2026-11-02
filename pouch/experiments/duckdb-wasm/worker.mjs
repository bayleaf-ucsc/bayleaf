// Spike worker: DuckDB-Wasm's blocking bindings (eh bundle) in a module
// worker started from a blob: URL. The page posts the wasm bytes; the worker
// compiles them itself (no URL, no fetch), drops its network APIs, then runs
// whatever SQL the page sends and answers with plain rows.
import { createDuckDB, BROWSER_RUNTIME, VoidLogger } from 'DUCKDB_BLOCKING';

let db = null, conn = null;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

// DuckDB-Wasm loads an extension with a synchronous XMLHttpRequest GET of
// <repository>/<version>/wasm_eh/<name>.duckdb_extension.wasm. This stand-in
// answers only for the extensions the page handed over (verified bytes, in
// memory) and throws for anything else: it never touches the network.
let extensions = new Map();
const requested = [];
class NoNetworkXHR {
  open(method, url) { this.method = method; this.url = String(url); requested.push(method + ' ' + this.url); }
  setRequestHeader() {}
  overrideMimeType() {}
  getResponseHeader() { return null; }
  send() {
    const m = /\/(v[0-9.]+)\/wasm_eh\/([a-z_]+)\.duckdb_extension\.wasm$/.exec(this.url);
    const bytes = this.method === 'GET' && m && extensions.get(m[2]);
    if (!bytes) throw new Error(`Pouch's DuckDB has no network (${this.method} ${this.url})`);
    this.status = 200; this.response = bytes.slice().buffer;
  }
}

async function load(wasm, ext) {
  extensions = new Map(Object.entries(ext ?? {}));
  const mod = await WebAssembly.compile(wasm);
  const compiled = ms();
  for (const k of ['fetch', 'WebSocket', 'EventSource', 'importScripts']) {
    Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false });
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { value: NoNetworkXHR, configurable: false, writable: false });
  db = await createDuckDB({ eh: { mainModule: 'pouch:eh.wasm' }, mvp: { mainModule: 'pouch:none' } }, new VoidLogger(), BROWSER_RUNTIME);
  // The bindings would fetch mainModule; give them the module compiled above.
  db.instantiateWasm = (imports, done) => {
    globalThis.DUCKDB_RUNTIME = BROWSER_RUNTIME; // what the library's own instantiateWasm sets first
    WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod));
    return [];
  };
  await db.instantiate(() => {});
  db.open({ path: ':memory:', query: { castBigIntToDouble: false } });
  conn = db.connect();
  return { compiledMs: compiled, readyMs: ms(), version: db.getVersion() };
}

const plain = (v) => (typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v && typeof v === 'object' && !(v instanceof Uint8Array) ? JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) : v);
function query(sql) {
  const t = conn.query(sql);
  return { columns: t.schema.fields.map((f) => `${f.name}:${f.type}`), rows: t.toArray().map((r) => Object.values(r.toJSON()).map(plain)) };
}

self.onmessage = async ({ data: m }) => {
  try {
    let result;
    if (m.action === 'load') result = await load(m.wasm, m.ext);
    else if (m.action === 'register') { db.registerFileBuffer(m.name, m.bytes); result = { registered: m.name }; }
    else if (m.action === 'query') { const s = performance.now(); result = { ...query(m.sql), ms: Math.round(performance.now() - s) }; }
    else if (m.action === 'copyOut') result = { bytes: db.copyFileToBuffer(m.name) };
    else if (m.action === 'fresh') {
      const s = performance.now();
      conn.close(); db.reset(); db.open({ path: ':memory:' }); conn = db.connect();
      for (const q of m.setup) conn.query(q);
      result = { ms: Math.round(performance.now() - s), heapMiB: Math.round(db._instance.HEAPU8.length / 2 ** 20) };
    }
    else if (m.action === 'requested') result = requested;
    else if (m.action === 'globals') result = { fetch: typeof fetch, xhr: typeof XMLHttpRequest, ws: typeof WebSocket };
    postMessage({ id: m.id, result });
  } catch (e) { postMessage({ id: m.id, error: String(e?.message ?? e) }); }
};
