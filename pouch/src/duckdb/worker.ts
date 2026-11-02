// The DuckDB worker: DuckDB-Wasm's synchronous bindings (eh build) behind a
// small message protocol. build-duckdb.mjs bundles it into runtime/duckdb/
// worker.js; src/duckdb.ts starts it from the verified blob and talks to it.
//
// Containment (stories DB3, DB6; experiments/duckdb-wasm):
// - No network. The page hands over the engine's wasm and the parquet and json
//   extensions as verified bytes; the wasm is compiled here (no URL), and the
//   extensions are served from memory by NoNetworkXHR, the one thing DuckDB
//   asks for them through. fetch, WebSocket, EventSource and importScripts are
//   removed; NoNetworkXHR throws for any other request, so httpfs and
//   https:// reads cannot reach any host, same-origin included.
// - DuckDB's own refusal as well: each job's database loads the two
//   extensions, then sets enable_external_access=false with allowed_directories
//   naming only the job's own paths, turns autoload and autoinstall off and
//   locks the configuration, so SQL cannot undo it.
// - A fresh in-memory database per job (reset, open): no job sees another's
//   tables or files. (A database file is not offered: DuckDB-Wasm 1.32.0 keeps
//   an attached file locked after DETACH and reset, so it cannot be copied back.) A wasm trap ends the worker (the page starts a new one).
import { createDuckDB, BROWSER_RUNTIME, VoidLogger } from 'duckdb-wasm-blocking';
import { Type } from 'apache-arrow';
import type { DuckDBBindings, DuckDBConnection } from 'duckdb-wasm-blocking';
import type { DataType, Field, Table } from 'apache-arrow';
import type { DuckCell, DuckColumn, DuckJob, DuckLoaded, DuckReply, DuckRequest, DuckResult, DuckRun } from './protocol.ts';

let extensions = new Map<string, Uint8Array>();
// DuckDB-Wasm fetches an extension with a synchronous GET of
// <repository>/<version>/wasm_eh/<name>.duckdb_extension.wasm; this answers
// only for the extensions the page verified, and refuses everything else.
class NoNetworkXHR {
  method = ''; url = ''; status = 0; response: ArrayBuffer | null = null; responseType = '';
  open(method: string, url: string | URL) { this.method = method; this.url = String(url); }
  setRequestHeader() {}
  overrideMimeType() {}
  getResponseHeader() { return null; }
  send() {
    const m = /\/v[0-9.]+\/wasm_eh\/([a-z_]+)\.duckdb_extension\.wasm$/.exec(this.url);
    const bytes = this.method === 'GET' && m ? extensions.get(m[1]) : undefined;
    if (!bytes) throw new Error(`Pouch's DuckDB has no network (${this.method} ${this.url})`);
    this.status = 200; this.response = bytes.slice().buffer;
  }
}

let db: DuckDBBindings | null = null;
let conn: DuckDBConnection | null = null;
let version = '';
const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

// extensions.pack: u32 LE header length, JSON { name: [offset, length] }, bytes (build-pdf.mjs pack).
function unpack(buf: ArrayBuffer) {
  const n = new DataView(buf).getUint32(0, true);
  const index: Record<string, [number, number]> = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  return new Map(Object.entries(index).map(([p, [o, l]]) => [p, new Uint8Array(buf, 4 + n + o, l)]));
}

async function load(wasm: ArrayBuffer, pack: ArrayBuffer): Promise<DuckLoaded> {
  extensions = unpack(pack);
  const mod = await WebAssembly.compile(wasm);
  // From here on this worker has no network at all (see the header).
  const gone: [string, unknown][] = [['fetch', undefined], ['WebSocket', undefined], ['EventSource', undefined], ['importScripts', undefined], ['XMLHttpRequest', NoNetworkXHR]];
  for (const [k, value] of gone) {
    try { Object.defineProperty(globalThis, k, { value, configurable: false, writable: false }); } catch { Object.assign(globalThis, { [k]: value }); }
  }
  const bindings = await createDuckDB({ eh: { mainModule: 'pouch:duckdb-eh.wasm', mainWorker: 'pouch:none' }, mvp: { mainModule: 'pouch:none', mainWorker: 'pouch:none' } }, new VoidLogger(), BROWSER_RUNTIME);
  // The bindings would fetch mainModule; they get the module compiled above
  // (and the runtime global their own instantiateWasm sets first).
  Object.assign(bindings, {
    instantiateWasm(imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void) {
      Object.assign(globalThis, { DUCKDB_RUNTIME: BROWSER_RUNTIME });
      WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod));
      return [];
    },
  });
  await bindings.instantiate(() => {});
  db = bindings;
  version = bindings.getVersion();
  return { version, extensions: [...extensions.keys()] };
}

// A database for one job: fresh, the extensions loaded, then locked down.
function fresh(job: DuckJob) {
  if (!db) throw new Error('the DuckDB runtime is not loaded');
  conn?.close(); conn = null;
  db.dropFiles(); db.reset();
  for (const f of job.files) db.registerFileBuffer(f.name, f.bytes);
  db.open({ path: ':memory:', query: { castBigIntToDouble: false } });
  const c = db.connect();
  conn = c;
  for (const name of extensions.keys()) c.query(`LOAD ${name}`);
  for (const s of [`SET memory_limit=${sqlString(job.memoryLimit)}`, 'SET threads=1',
    'SET autoinstall_known_extensions=false', 'SET autoload_known_extensions=false', 'SET allow_community_extensions=false',
    `SET allowed_directories=[${job.allowed.map(sqlString).join(', ')}]`, 'SET enable_external_access=false', 'SET lock_configuration=true']) c.query(s);
  return c;
}

// ── Arrow values to plain cells ──────────────────────────────────────
const isNumericType = (t: DataType) => [Type.Int, Type.Float, Type.Decimal].includes(t.typeId);
// A 128-bit two's-complement integer from little-endian 32-bit words, then the decimal point.
function decimal(words: Uint32Array, scale: number) {
  let n = 0n;
  for (let i = words.length - 1; i >= 0; i--) n = (n << 32n) | BigInt(words[i]);
  const bits = BigInt(words.length * 32);
  if (n >> (bits - 1n)) n -= 1n << bits;
  const neg = n < 0n, digits = (neg ? -n : n).toString().padStart(scale + 1, '0');
  return (neg ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}
const pad2 = (n: number) => String(n).padStart(2, '0');
function isoDate(ms: number) { const d = new Date(ms); return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function isoTime(ms: number) {
  const d = new Date(ms), frac = ((ms % 1000) + 1000) % 1000;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${frac ? '.' + String(Math.round(frac)).padStart(3, '0') : ''}`;
}
const UNIT_MS = [1000, 1, 1e-3, 1e-6]; // arrow TimeUnit: s, ms, us, ns
const unitOf = (t: DataType) => ('unit' in t && typeof t.unit === 'number' ? t.unit : 1);
const toMs = (v: number | bigint, t: DataType) => Number(v) * (UNIT_MS[unitOf(t)] ?? 1);
const scaleOf = (t: DataType) => ('scale' in t && typeof t.scale === 'number' ? t.scale : 0);
const iterable = (v: object): v is Iterable<unknown> => Symbol.iterator in v;
// Nested values (lists, structs, maps, intervals) as JSON text.
function nested(v: unknown): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return [...v];
  if (v && typeof v === 'object') {
    if ('toJSON' in v && typeof v.toJSON === 'function') return nested(v.toJSON());
    if (iterable(v) && !Array.isArray(v)) return nested([...v]); // a vector
    if (Array.isArray(v)) return v.map(nested);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nested(x)]));
  }
  return v;
}
function cell(v: unknown, t: DataType): DuckCell {
  if (v === null || v === undefined) return null;
  switch (t.typeId) {
    case Type.Decimal: return v instanceof Uint32Array ? decimal(v, scaleOf(t)) : String(v);
    case Type.Int: return typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : typeof v === 'number' ? v : String(v);
    case Type.Float: return typeof v === 'number' && Number.isFinite(v) ? v : String(v);
    case Type.Bool: return typeof v === 'boolean' ? v : String(v);
    case Type.Date: return typeof v === 'number' || typeof v === 'bigint' ? isoDate(Number(v)) : v instanceof Date ? isoDate(v.getTime()) : String(v);
    case Type.Timestamp: {
      const ms = typeof v === 'number' || typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.getTime() : NaN;
      return Number.isNaN(ms) ? String(v) : `${isoDate(ms)} ${isoTime(ms)}${'timezone' in t && t.timezone ? '+00' : ''}`;
    }
    case Type.Time: return typeof v === 'number' || typeof v === 'bigint' ? isoTime(toMs(v, t)) : String(v);
    case Type.Binary: case Type.LargeBinary: case Type.FixedSizeBinary:
      return v instanceof Uint8Array ? [...v].map((b) => '\\x' + b.toString(16).padStart(2, '0')).join('') : String(v);
    case Type.Utf8: case Type.LargeUtf8: return String(v);
    default: return typeof v === 'object' ? JSON.stringify(nested(v)) : String(v);
  }
}
const column = (f: Field): DuckColumn => ({ name: f.name, type: String(f.type), numeric: isNumericType(f.type) });

// One statement's result, keeping at most maxRows rows (reading one more to know).
async function runOne(c: DuckDBConnection, sql: string, maxRows: number): Promise<DuckResult> {
  const reader = await c.send(sql, true);
  const rows: DuckCell[][] = [];
  let more = false, schema: Table['schema'] | null = null;
  for await (const batch of reader) {
    schema = batch.schema;
    const cols = batch.schema.fields.map((f, i) => ({ f, v: batch.getChildAt(i) }));
    for (let r = 0; r < batch.numRows; r++) {
      if (rows.length >= maxRows) { more = true; break; }
      rows.push(cols.map(({ f, v }) => cell(v?.get(r), f.type)));
    }
    if (more) break;
  }
  if (more) c.cancelSent();
  const fields = (schema ?? reader.schema)?.fields ?? [];
  return { columns: fields.map(column), rows, more };
}

async function run(job: DuckJob): Promise<DuckRun> {
  const c = fresh(job), bindings = db;
  if (!bindings) throw new Error('the DuckDB runtime is not loaded');
  const out: DuckRun = { version, results: [], error: null, outputs: [] };
  for (let i = 0; i < job.statements.length; i++) {
    try { out.results.push(await runOne(c, job.statements[i], job.maxRows)); }
    catch (e) {
      if (e instanceof WebAssembly.RuntimeError) throw Object.assign(new Error(`the DuckDB engine failed (${e.message}); it restarts on the next command`), { code: 'ETRAP' });
      out.error = { message: e instanceof Error ? e.message : String(e), statement: i };
      break;
    }
  }
  let total = 0;
  for (const name of job.outputs) {
    if (!bindings.globFiles(name).some((f) => f.fileName === name)) continue;
    const bytes = bindings.copyFileToBuffer(name);
    total += bytes.length;
    if (total > job.maxOutputBytes) throw Object.assign(new Error(`the files COPY wrote come to over ${Math.round(job.maxOutputBytes / 2 ** 20)} MiB (MAX_OUTPUT_BYTES); nothing was written. Write less (a LIMIT, fewer columns) or split it`), { code: 'ECAP' });
    out.outputs.push({ name, bytes });
  }
  return out;
}

const transferOf = (r: DuckRun | DuckLoaded) => ('outputs' in r ? r.outputs.map((f) => f.bytes.buffer) : [])
  .filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);

self.onmessage = async ({ data: msg }: MessageEvent<DuckRequest>) => {
  const { id } = msg;
  try {
    const result = msg.action === 'load' ? await load(msg.wasm, msg.pack) : await run(msg);
    postMessage({ id, result } satisfies DuckReply, transferOf(result));
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : e instanceof WebAssembly.RuntimeError ? 'ETRAP' : undefined;
    postMessage({ id, error: e instanceof Error ? e.message : String(e), code } satisfies DuckReply);
  }
};
