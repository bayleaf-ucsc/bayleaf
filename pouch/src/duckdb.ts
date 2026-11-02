// SQL for the shell, on Pouch's third heavy-tool runtime (DuckDB-Wasm):
//
//   duckdb [-csv|-json|-jsonlines|-markdown|-box|-line|-list] [-c SQL | -f FILE] [-o OUT] [:memory:] [SQL]
//
// The DuckDB CLI's names and flags, so an agent's prior knowledge works; SQL
// comes from -c, -f, a second argument, or standard input (duckdb < q.sql).
// Files are named in the SQL by path ('/work/sales.csv', globs too): before
// the job runs, every quoted string that names a file in the caller's own view
// is handed to the engine as bytes, and every COPY ... TO target that exists
// afterwards is written back (story DB1). Relative paths are made absolute.
// DuckDB never sees Pouch's tree, only those files; it has no network (DB6),
// and the agent sees only what is printed, capped (DB3).
//
// The runtime (build-duckdb.mjs, src/duckdb/worker.ts) is the `duckdb` add-on
// (src/addons-registry.ts): 38 MiB, so the asked tier. A command never
// downloads it; until the person installs it (`addons install duckdb`) the
// command says so. Every command is a job (src/jobs.ts): a /task entry whose
// ctl stops it; each job gets a fresh in-memory database.
import { createJobs } from './jobs.ts';
import { normalize } from './vfs.ts';
import { coded, installLines } from './pdf.ts';
import { DUCKDB } from './addons-registry.ts';
import { say } from './addons.ts';
import type { defineCommand as DefineCommand, ResolvedCommandContext, IFileSystem, ExecResult } from 'just-bash';
import type { JobHandle, Pending, RunOptions, ServiceOptions, WhoOf, WorkerOptions } from './pdf.ts';
import type { WorkerDef } from './jobs.ts';
import type { RuntimeFiles } from './assets.ts';
import type { DuckCell, DuckFile, DuckJob, DuckLoaded, DuckReply, DuckResult, DuckRun } from './duckdb/protocol.ts';
export type { DuckJob, DuckReply, DuckRequest, DuckRun } from './duckdb/protocol.ts';

export const DUCKDB_VERSION = 'v1.4.3';          // PRAGMA version of the pinned engine (build-duckdb.mjs DUCKDB.engine)
export const DUCKDB_PACKAGE = '1.32.0';          // @duckdb/duckdb-wasm

// Caps, named so errors and the duckdb skill can cite them.
export const MAX_INPUT_BYTES = 256 * 2 ** 20;   // files a call reads, together; refused before anything loads
export const MAX_OUTPUT_BYTES = 256 * 2 ** 20;  // files a call's COPY writes, together; over it nothing is written
export const MAX_GLOB_FILES = 1000;             // files one quoted glob may name
export const DEFAULT_MAX_ROWS = 40;             // rows printed per result (the DuckDB CLI's .maxrows)
export const MAX_ROWS = 10_000;                 // the most -maxrows allows
export const MAX_STDOUT_BYTES = 256 * 2 ** 10;  // printed output; more is cut with a note
export const MAX_CELL_WIDTH = 48;               // characters per cell in box and markdown (csv and json are never cut)
export const MEMORY_LIMIT = '512MB';            // DuckDB's memory_limit per job
export const WORKER_MEMORY = 1 * 2 ** 30;       // the jobs memory guard's estimate: engine, extensions, inputs

const ok = (stdout = '', stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode });
const fail = (msg: string, code = 1) => ({ stdout: '', stderr: `duckdb: ${msg}\n`, exitCode: code });

export const HELP = `usage: duckdb [OPTIONS] [:memory:] [SQL]
  DuckDB ${DUCKDB_VERSION} (DuckDB-Wasm ${DUCKDB_PACKAGE}) in this browser, with no network.
  SQL comes from -c SQL, -f FILE.sql, a second argument, or standard input.
  Name files by path inside quotes; they are read from your files:
    duckdb -c "DESCRIBE FROM '/work/sales.csv'"
    duckdb -c "SUMMARIZE FROM '/work/sales.csv'"
    duckdb -c "COPY (SELECT region, sum(amount) AS total FROM '/work/sales.csv' GROUP BY ALL) TO '/work/totals.csv' (HEADER)"
    duckdb -f /work/totals.sql        (or: duckdb < /work/totals.sql)
  CSV, Parquet and JSON (read_csv, read_parquet, read_json; globs like '/work/*.csv').
  COPY ... TO 'path' writes the file into your files. Each command starts with an
  empty in-memory database: keep a table as Parquet (COPY t TO '/work/t.parquet'
  (FORMAT parquet)) and read it back next time. Database files are not supported.
OPTIONS
  -box (default) -csv -json -jsonlines -markdown -line -list   output format
  -c SQL, -s SQL     run SQL                -f FILE   run the SQL in FILE
  -o OUT             write the printed output to OUT instead
  -header -noheader  column names in csv/list    -separator SEP   for csv/list
  -nullvalue TEXT    how NULL prints
  -maxrows N         rows printed per result (default ${DEFAULT_MAX_ROWS}, at most ${MAX_ROWS}); for every row, COPY to a file
  -echo              print each statement before its result
  -version           print the version
  Caps: ${MAX_INPUT_BYTES / 2 ** 20} MiB of input files, ${MAX_OUTPUT_BYTES / 2 ** 20} MiB written, ${MAX_STDOUT_BYTES / 2 ** 10} KiB printed per call.
  Not here: the network (httpfs, https:// paths, INSTALL), other extensions, database files, ATTACH, dot commands.
`;

// ── Arguments ────────────────────────────────────────────────────────
export type DuckMode = 'box' | 'csv' | 'json' | 'jsonlines' | 'markdown' | 'line' | 'list';
const MODES: Record<string, DuckMode> = { box: 'box', duckbox: 'box', table: 'box', csv: 'csv', json: 'json', jsonlines: 'jsonlines', ndjson: 'jsonlines', markdown: 'markdown', line: 'line', list: 'list' };
const VALUES = ['c', 's', 'f', 'o', 'separator', 'nullvalue', 'maxrows', 'cmd'];
// A database file would be the DuckDB CLI's first argument; DuckDB-Wasm 1.32.0 cannot hand one back (experiments/duckdb-wasm).
export const NO_DBFILE = "database files are not supported here; each command starts with an empty in-memory database. Keep a table as Parquet: COPY (...) TO '/work/t.parquet' (FORMAT parquet), then FROM '/work/t.parquet' next time";
const BOOLS = ['header', 'noheader', 'readonly', 'echo', 'bail', 'batch', 'no-stdin', 'version', 'unsigned', 'safe'];
export interface DuckOpts { mode: DuckMode; sql?: string; file?: string; out?: string; header: boolean | null; separator?: string; nullvalue: string; maxRows: number; echo: boolean; version: boolean }
export type DuckArgs = { help: true; error?: undefined; opts?: undefined } | { error: string; help?: undefined; opts?: undefined } | { opts: DuckOpts; help?: undefined; error?: undefined };
export function parseArgs(args: string[]): DuckArgs {
  const opts: DuckOpts = { mode: 'box', header: null, nullvalue: '', maxRows: DEFAULT_MAX_ROWS, echo: false, version: false };
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '-help' || a === '--help') return { help: true };
    if (!a.startsWith('-') || a === '-') { pos.push(a); continue; }
    const name = a.replace(/^--?/, '');
    if (MODES[name]) { opts.mode = MODES[name]; continue; }
    if (BOOLS.includes(name)) {
      if (name === 'header' || name === 'noheader') opts.header = name === 'header';
      else if (name === 'echo' || name === 'version') opts[name] = true;
      else if (name === 'readonly') return { error: NO_DBFILE };
      continue;
    }
    if (!VALUES.includes(name)) return { error: name === 'init' || name === 'cmd' ? `-${name} is not supported here` : `unknown option ${a} (duckdb -help lists them)` };
    if (i + 1 >= args.length) return { error: `${a} needs a value` };
    const v = args[++i];
    if (name === 'c' || name === 's' || name === 'cmd') { if (opts.sql !== undefined) return { error: 'give SQL once (-c), or put several statements in it separated by ;' }; opts.sql = v; }
    else if (name === 'f') opts.file = v;
    else if (name === 'o') opts.out = v;
    else if (name === 'separator') opts.separator = v.replace(/\\t/g, '\t');
    else if (name === 'nullvalue') opts.nullvalue = v;
    else if (name === 'maxrows') {
      if (!/^\d+$/.test(v) || +v < 1) return { error: `-maxrows needs a whole number of rows, not "${v}"` };
      if (+v > MAX_ROWS) return { error: `-maxrows ${v} is over ${MAX_ROWS} (MAX_ROWS); to get every row, COPY (...) TO '/work/out.csv' and read the file` };
      opts.maxRows = +v;
    }
  }
  if (pos.length > 2) return { error: 'too many arguments: duckdb [:memory:] [SQL]; quote the SQL as one argument' };
  if (pos[0] !== undefined && pos[0] !== ':memory:') {
    if (/\s/.test(pos[0]) && pos.length === 1) return { error: `"${pos[0].slice(0, 40)}" is in the database file's place; put SQL after -c: duckdb -c "${pos[0].slice(0, 40)}"` };
    return { error: `${pos[0]}: ${NO_DBFILE}` };
  }
  if (pos[1] !== undefined) { if (opts.sql !== undefined) return { error: 'give SQL either with -c or as the second argument, not both' }; opts.sql = pos[1]; }
  if (opts.sql !== undefined && opts.file !== undefined) return { error: 'give -c SQL or -f FILE, not both' };
  return { opts };
}

// ── SQL scanning: statements, quoted strings, COPY targets ───────────
// A string literal and where it sits: [start, end) covers the quotes.
export interface Literal { value: string; start: number; end: number; after: string }
// Splits on ; outside quotes, comments and $$ strings; collects '...' literals with the keyword before each.
export function scan(sql: string): { statements: string[]; literals: Literal[]; dot: string | null } {
  const statements: string[] = [], literals: Literal[] = [];
  let start = 0, word = '', last = '', dot: string | null = null;
  const lineStart = (i: number) => sql.slice(start, i).trim() === '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 1; continue; }
    if (ch === '.' && lineStart(i) && /[a-z]/i.test(sql[i + 1] ?? '')) { dot ??= sql.slice(i, sql.indexOf('\n', i) < 0 ? undefined : sql.indexOf('\n', i)).trim(); }
    if (ch === "'" || ch === '"') {
      let j = i + 1, value = '';
      for (; j < sql.length; j++) {
        if (sql[j] === ch) { if (sql[j + 1] === ch) { value += ch; j++; continue; } break; }
        value += sql[j];
      }
      if (ch === "'") literals.push({ value, start: i, end: j + 1, after: last });
      if (word) last = word.toUpperCase();
      word = ''; i = j; continue;
    }
    if (ch === '$' && sql[i + 1] === '$') { const e = sql.indexOf('$$', i + 2); i = e < 0 ? sql.length : e + 1; continue; }
    if (/[A-Za-z_]/.test(ch)) { word += ch; continue; }
    if (word) { last = word.toUpperCase(); word = ''; }
    if (/\S/.test(ch) && ch !== ';') last = ch === '(' || ch === ',' ? ch : last;
    if (ch === ';') { if (sql.slice(start, i).trim()) statements.push(sql.slice(start, i).trim()); start = i + 1; last = ''; }
  }
  if (sql.slice(start).trim()) statements.push(sql.slice(start).trim());
  return { statements: statements.filter((s) => !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(s)), literals, dot };
}
// Statements whose result is only a count or "Success": printed as nothing.
const QUIET = /^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(CREATE|INSERT|UPDATE|DELETE|COPY|DROP|ALTER|SET|RESET|LOAD|INSTALL|DETACH|USE|BEGIN|COMMIT|ROLLBACK|ABORT|CHECKPOINT|VACUUM|ANALYZE|EXPORT|IMPORT|TRUNCATE|COMMENT)\b/i;
export const isQuiet = (sql: string, r: DuckResult) => QUIET.test(sql) && r.columns.length === 1 && ['Count', 'Success'].includes(r.columns[0].name);

const abs = (cwd: string, p: string) => normalize(p.startsWith('/') ? p : cwd + '/' + p);
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;
const GLOB = /[*?[]/;
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1) || '/';
const globRe = (seg: string) => new RegExp('^' + seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
// The files a glob names in fs: * ? [..] in any segment, ** for any depth.
export async function expandGlob(fs: Pick<IFileSystem, 'readdir' | 'stat'>, pattern: string, limit = MAX_GLOB_FILES): Promise<string[]> {
  const segs = pattern.split('/').filter(Boolean), out: string[] = [];
  async function walk(dir: string, i: number): Promise<void> {
    if (out.length > limit) return;
    if (i === segs.length) { if (!(await fs.stat(dir).catch(() => null))?.isDirectory) out.push(dir); return; }
    if (!GLOB.test(segs[i])) return walk(`${dir === '/' ? '' : dir}/${segs[i]}`, i + 1);
    const names = (await fs.readdir(dir).catch(() => [])).sort();
    if (segs[i] === '**') {
      await walk(dir, i + 1);
      for (const n of names) if ((await fs.stat(`${dir === '/' ? '' : dir}/${n}`).catch(() => null))?.isDirectory) await walk(`${dir === '/' ? '' : dir}/${n}`, i);
      return;
    }
    const re = globRe(segs[i]);
    for (const n of names) if (re.test(n)) await walk(`${dir === '/' ? '' : dir}/${n}`, i + 1);
  }
  await walk('/', 0);
  return [...new Set(out)];
}

// What a call needs, from the SQL and the caller's view: the statements (relative
// paths made absolute), the files to hand over, the COPY targets, DuckDB's allowed directories.
export interface DuckPlan { error?: undefined; statements: string[]; inputs: string[]; outputs: string[]; allowed: string[]; bytes: number }
export async function plan(fs: Pick<IFileSystem, 'readdir' | 'stat'>, cwd: string, sql: string): Promise<DuckPlan | { error: string }> {
  const { literals, dot } = scan(sql);
  if (dot) return { error: `${dot.split(/\s/)[0]}: dot commands are not supported here; use flags (-csv, -json, -maxrows N) and SQL (SHOW TABLES, DESCRIBE t, SUMMARIZE t)` };
  const { statements } = scan(sql);
  for (const s of statements) {
    if (/^\s*ATTACH\b/i.test(s)) return { error: `ATTACH: ${NO_DBFILE}` };
    if (/^\s*COPY\b/i.test(s) && /\b(PARTITION_BY|PER_THREAD_OUTPUT)\b/i.test(s)) return { error: 'COPY with PARTITION_BY or PER_THREAD_OUTPUT writes a folder of files, which is not supported here; write one file per COPY' };
  }
  const inputs = new Set<string>(), outputs = new Set<string>(), edits: [Literal, string][] = [];
  let bytes = 0;
  for (const lit of literals) {
    const v = lit.value;
    if (!v || v.length > 4096 || /[\n\0]/.test(v) || URLISH.test(v)) continue;
    const p = abs(cwd, v);
    if (lit.after === 'TO') { outputs.add(p); if (p !== v) edits.push([lit, p]); continue; }
    const hits = GLOB.test(v) ? await expandGlob(fs, p) : [];
    if (hits.length > MAX_GLOB_FILES) return { error: `'${v}' names over ${MAX_GLOB_FILES} files (MAX_GLOB_FILES); narrow the pattern` };
    const st = hits.length ? null : await fs.stat(p).catch(() => null);
    if (st?.isDirectory) continue;
    const found = hits.length ? hits : st ? [p] : [];
    if (!found.length) continue;
    for (const f of found) {
      if (inputs.has(f)) continue;
      inputs.add(f); bytes += hits.length ? (await fs.stat(f)).size : st?.size ?? 0;
    }
    if (p !== v) edits.push([lit, p]);
  }
  if (bytes > MAX_INPUT_BYTES) return { error: `the files this SQL names come to ${(bytes / 2 ** 20).toFixed(0)} MiB; the cap is ${MAX_INPUT_BYTES / 2 ** 20} MiB per call (MAX_INPUT_BYTES). Query fewer or smaller files (split a large CSV with head/split, or convert it to Parquet in parts)` };
  let text = sql;
  for (const [lit, p] of edits.sort((a, b) => b[0].start - a[0].start)) text = text.slice(0, lit.start) + `'${p.replaceAll("'", "''")}'` + text.slice(lit.end);
  const all = [...inputs, ...outputs];
  return { statements: scan(text).statements, inputs: [...inputs], outputs: [...outputs], allowed: [...new Set(all.map(dirOf))], bytes };
}

// ── Output formats ───────────────────────────────────────────────────
const TYPES: Record<string, string> = { Utf8: 'varchar', LargeUtf8: 'varchar', Int8: 'tinyint', Int16: 'smallint', Int32: 'integer', Int64: 'bigint',
  Uint8: 'utinyint', Uint16: 'usmallint', Uint32: 'uinteger', Uint64: 'ubigint', Float32: 'float', Float64: 'double', Bool: 'boolean', 'Date32<DAY>': 'date', Binary: 'blob' };
export function duckType(arrow: string) {
  const dec = /^Decimal\[(\d+)e([+-]?\d+)\]$/.exec(arrow); // apache-arrow writes scale 2 as e+2
  if (dec) return `decimal(${dec[1]},${Math.abs(Number(dec[2]))})`;
  if (arrow.startsWith('Timestamp')) return arrow.includes(',') ? 'timestamp with time zone' : 'timestamp';
  return TYPES[arrow] ?? arrow.toLowerCase();
}
export interface FormatOpts { mode: DuckMode; header: boolean | null; separator?: string; nullvalue: string }
const text = (c: DuckCell, nullvalue: string) => (c === null ? nullvalue : String(c));
const csvCell = (s: string, sep: string) => (s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const width = (s: string) => [...s].length;
const cut = (s: string) => { const one = s.replace(/[\r\n\t]+/g, ' '); return width(one) > MAX_CELL_WIDTH ? [...one].slice(0, MAX_CELL_WIDTH - 1).join('') + '…' : one; };
const jsonValue = (c: DuckCell, numeric: boolean) => (c === null ? 'null' : numeric && typeof c === 'string' && /^-?\d+(\.\d+)?$/.test(c) ? c : JSON.stringify(c));
export function formatResult(r: DuckResult, o: FormatOpts): string {
  const names = r.columns.map((c) => c.name), nv = o.nullvalue;
  const objects = () => r.rows.map((row) => `{${row.map((c, i) => `${JSON.stringify(names[i])}:${jsonValue(c, r.columns[i].numeric)}`).join(',')}}`);
  switch (o.mode) {
    case 'csv': case 'list': {
      const sep = o.separator ?? (o.mode === 'csv' ? ',' : '|');
      const lines = r.rows.map((row) => row.map((c) => (o.mode === 'csv' ? csvCell(text(c, nv), sep) : text(c, nv))).join(sep));
      return [...(o.header ?? true ? [names.map((n) => (o.mode === 'csv' ? csvCell(n, sep) : n)).join(sep)] : []), ...lines].map((l) => l + '\n').join('');
    }
    case 'json': return r.rows.length ? `[${objects().join(',\n')}]\n` : '';
    case 'jsonlines': return objects().map((l) => l + '\n').join('');
    case 'line': {
      const w = Math.max(...names.map(width));
      return r.rows.map((row) => row.map((c, i) => `${names[i].padStart(w)} = ${text(c, nv || 'NULL')}`).join('\n') + '\n').join('\n');
    }
    case 'markdown': {
      const cells = r.rows.map((row) => row.map((c) => cut(text(c, nv)).replaceAll('|', '\\|')));
      return [`| ${names.join(' | ')} |`, `|${r.columns.map((c) => (c.numeric ? '---:' : '---')).join('|')}|`, ...cells.map((row) => `| ${row.join(' | ')} |`)].join('\n') + '\n';
    }
    case 'box': {
      const types = r.columns.map((c) => duckType(c.type));
      const cells = r.rows.map((row) => row.map((c) => cut(text(c, nv || 'NULL'))));
      const w = r.columns.map((_, i) => Math.max(width(cut(names[i])), width(types[i]), ...cells.map((row) => width(row[i]))));
      const line = (l: string, m: string, rr: string) => l + w.map((n) => '─'.repeat(n + 2)).join(m) + rr;
      const center = (s: string, n: number) => { const g = n - width(s); return ' '.repeat(Math.floor(g / 2)) + s + ' '.repeat(Math.ceil(g / 2)); };
      const row = (vals: string[], align: (s: string, i: number) => string) => '│' + vals.map((v, i) => ` ${align(v, i)} `).join('│') + '│';
      const out = [line('┌', '┬', '┐'), row(names.map(cut), (s, i) => center(s, w[i])), row(types, (s, i) => center(s, w[i])), line('├', '┼', '┤'),
        ...cells.map((vals) => row(vals, (s, i) => (r.columns[i].numeric ? ' '.repeat(w[i] - width(s)) + s : s + ' '.repeat(w[i] - width(s))))),
        line('└', '┴', '┘')];
      if (!r.rows.length) out.push('0 rows');
      return out.join('\n') + '\n';
    }
  }
}
export const moreNote = (shown: number) => `(${shown} rows shown; there are more. Raise -maxrows (at most ${MAX_ROWS}), add LIMIT or an aggregate, or COPY (...) TO '/work/out.csv' to keep every row)\n`;

// Some errors arrive as DuckDB's JSON ({"exception_type":"Parser","exception_message":...}): as the CLI prints them.
export function plainError(raw: string) {
  if (!raw.trimStart().startsWith('{')) return raw;
  try {
    const e: unknown = JSON.parse(raw);
    if (e && typeof e === 'object' && 'exception_message' in e && typeof e.exception_message === 'string')
      return `${'exception_type' in e && typeof e.exception_type === 'string' ? e.exception_type + ' ' : ''}Error: ${e.exception_message}`;
  } catch { /* not JSON after all */ }
  return raw;
}
// What DuckDB said, with Pouch's hint where one helps the next attempt.
// known: the files this call handed over or may write (a path outside them is
// refused by DuckDB's configuration, which reads as a permission problem).
export function explain(raw: string, known: ReadonlySet<string> = new Set()) {
  const message = plainError(raw), hints: string[] = [];
  const denied = /Cannot access file "([^"]+)"/.exec(message)?.[1];
  if (denied && !URLISH.test(denied) && !known.has(denied)) return `${denied}: no such file in your files (ls ${dirOf(denied)} to check; name files by full path in quotes, e.g. FROM '/work/data.csv')`;
  if (/https?:|s3:|gcs:|httpfs|extension/i.test(message) && /Permission|no network|disabled/i.test(message)) hints.push("Pouch's DuckDB has no network and loads no other extensions: put the file in /work (drag it into Files or attach it) and query its path");
  else if (/No files found|does not exist|Cannot open file/i.test(message)) hints.push("name a file by its full path in quotes, e.g. FROM '/work/data.csv' (ls /work to check); only quoted paths are handed to DuckDB");
  else if (/Could not convert|CSV Error|sniff/i.test(message)) hints.push("for a messy CSV, read it with read_csv('/work/f.csv', all_varchar=true) to look, then set types, delim, quote or nullstr explicitly");
  return message.trim() + (hints.length ? `\n(${hints.join('; ')})` : '');
}

// ── The worker: one, from the add-on's verified files ────────────────
const stopped = () => new DOMException('Stopped.', 'AbortError');
const codeError = (msg: string, code?: string) => Object.assign(new Error(msg), { code });
function defaultSpawn(files: RuntimeFiles) {
  const src = URL.createObjectURL(new Blob([files['worker.js']], { type: 'text/javascript' }));
  try { return new Worker(src, { type: 'module', name: 'pouch-duckdb' }); } finally { URL.revokeObjectURL(src); }
}

// assets: the add-on's files (addons.assets('duckdb')): obtain() hands back verified
// Blobs, or throws ENOTINSTALLED with the standard sentence (asked tier: never a download).
export function duckdbWorker({ assets = null, spawn = defaultSpawn, onLoad }: WorkerOptions = {}): WorkerDef<DuckJob, DuckRun> {
  return {
    label: 'DuckDB', memory: WORKER_MEMORY, concurrency: 1,
    create() {
      if (!assets) throw codeError(say.notBuilt('DuckDB'), 'ENOSYS');
      const runtime = assets;
      let worker: Worker | null = null, seq = 0;
      const pending = new Map<number, Pending<DuckRun | DuckLoaded>>();
      const end = (w: Worker) => { w.terminate(); if (worker === w) worker = null; };
      function call(w: Worker, msg: { action: 'load'; wasm: ArrayBuffer; pack: ArrayBuffer } | (DuckJob & { action: 'run' }), transfer: Transferable[], signal?: AbortSignal) {
        return new Promise<DuckRun | DuckLoaded>((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          // A query cannot be interrupted inside wasm: Stop ends the worker; the next job starts a new one.
          signal?.addEventListener('abort', () => { if (pending.delete(id)) { end(w); reject(stopped()); } }, { once: true });
          w.postMessage({ id, ...msg }, transfer);
        });
      }
      async function start(signal: AbortSignal, note: (l: string) => void) {
        const got = await runtime.obtain({ network: globalThis.navigator?.onLine !== false, signal, note });
        if (signal.aborted) throw stopped();
        onLoad?.(got);
        const w = spawn(got.files);
        w.onmessage = ({ data }: MessageEvent<DuckReply>) => {
          const p = pending.get(data.id);
          if (!p) return;
          pending.delete(data.id);
          if (data.error === undefined) return p.resolve(data.result);
          if (data.code === 'ETRAP') end(w);
          p.reject(codeError(data.error, data.code));
        };
        w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'the duckdb worker failed')); pending.clear(); end(w); };
        worker = w;
        const wasm = await got.files['duckdb-eh.wasm'].arrayBuffer(), pack = await got.files['extensions.pack'].arrayBuffer();
        try { await call(w, { action: 'load', wasm, pack }, [wasm, pack], signal); }
        catch (e) { end(w); throw e; }
      }
      return {
        async run(job, { signal, note }) {
          if (!worker) await start(signal, note).catch((e) => { throw signal.aborted ? stopped() : e; });
          const w = worker;
          if (!w) throw new Error('the duckdb worker failed while starting');
          const transfer = job.files.map((f) => f.bytes.buffer).filter((b) => b instanceof ArrayBuffer);
          const r = await call(w, { action: 'run', ...job }, transfer, signal);
          if (!('results' in r)) throw new Error('the duckdb worker answered out of turn');
          return r;
        },
        // Removing the add-on unloads it: a job still running ends with a reason, never hangs.
        dispose() { worker?.terminate(); worker = null; for (const p of pending.values()) p.reject(new Error('DuckDB was removed while this job ran.')); pending.clear(); },
      };
    },
  };
}

// The service shared by the terminal and every agent: one engine, its jobs.
export function createDuckdbService({ tasks, addons, worker = duckdbWorker({ assets: addons?.assets(DUCKDB) }), budget }: ServiceOptions<DuckJob, DuckRun>) {
  const jobs = createJobs({ tasks, workers: { duckdb: worker }, ...(budget ? { budget } : {}) });
  return {
    jobs,
    run(input: DuckJob, { who = {}, fs, signal, label }: RunOptions = {}): JobHandle {
      const { task, result } = jobs.submit('duckdb', input, { caller: { sid: who.sid ?? undefined, name: who.name, fs }, label });
      const kill = () => tasks.kill(task).catch(() => {});
      if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true }); }
      return { task, result };
    },
  };
}

// ── The shell command ────────────────────────────────────────────────
export type DuckdbService = ReturnType<typeof createDuckdbService>;
const stdinText = (s: unknown) => (typeof s === 'string' ? s : s instanceof Uint8Array ? new TextDecoder().decode(s) : '');

export function duckdbCommands(defineCommand: typeof DefineCommand, service: DuckdbService | null | undefined, whoOf: WhoOf = () => ({ name: 'terminal' })) {
  const who = () => (typeof whoOf === 'function' ? whoOf() : whoOf) ?? {};
  const installs = installLines();
  const duckdb = defineCommand('duckdb', installs.wrap('duckdb', async (args, ctx: ResolvedCommandContext): Promise<ExecResult> => {
    const a = parseArgs(args);
    if (a.help) return ok(HELP);
    if (a.error !== undefined) return { stdout: '', stderr: `duckdb: ${a.error}\n`, exitCode: 1 };
    const o = a.opts;
    if (o.version) return ok(`${DUCKDB_VERSION} (DuckDB-Wasm ${DUCKDB_PACKAGE}, in this browser)\n`);
    let sql = o.sql;
    if (o.file !== undefined) {
      const p = abs(ctx.cwd, o.file);
      try { sql = await ctx.fs.readFile(p); } catch { return fail(`${p}: no such file`); }
    }
    sql ??= stdinText(ctx.stdin);
    if (!sql.trim()) return fail('no SQL: give -c "SQL", -f FILE.sql, or pipe SQL in (duckdb < q.sql)');
    if (!service) return fail(say.notBuilt('DuckDB').replace(/\.$/, ''));
    const pl = await plan(ctx.fs, ctx.cwd, sql);
    if (pl.error !== undefined) return fail(pl.error);
    if (!pl.statements.length) return fail('no SQL statements to run');
    const read = async (name: string): Promise<DuckFile> => ({ name, bytes: (await ctx.fs.readFileBuffer(name)).slice() });
    const job: DuckJob = { statements: pl.statements, files: await Promise.all(pl.inputs.map(read)), outputs: pl.outputs, allowed: pl.allowed, maxRows: o.maxRows, memoryLimit: MEMORY_LIMIT, maxOutputBytes: MAX_OUTPUT_BYTES };
    const { task, result } = service.run(job, { who: who(), fs: ctx.fs, signal: ctx.signal, label: `duckdb ${pl.statements[0].replace(/\s+/g, ' ').slice(0, 40)}` });
    let r: DuckRun;
    try { r = await result as DuckRun; } // the worker answers with a DuckRun
    catch (caught) {
      const e = coded(caught);
      if (e.name === 'AbortError') return fail(`stopped (/task/${task.id})`, 130);
      return fail(e.message);
    } finally { installs.note(ctx, task); }
    // Printed output, capped.
    let out = '', err = '', cutAt = false;
    const print = (s: string) => {
      if (cutAt) return;
      if (out.length + s.length > MAX_STDOUT_BYTES) { out += s.slice(0, MAX_STDOUT_BYTES - out.length); cutAt = true; return; }
      out += s;
    };
    r.results.forEach((res, i) => {
      const stmt = pl.statements[i];
      if (o.echo) print(stmt + ';\n');
      if (isQuiet(stmt, res)) return;
      print(formatResult(res, o));
      if (res.more) (o.mode === 'box' || o.mode === 'markdown' || o.mode === 'line' ? print : (s: string) => { err += s; })(moreNote(res.rows.length));
    });
    if (cutAt) out += `\n[output cut at ${MAX_STDOUT_BYTES / 2 ** 10} KiB (MAX_STDOUT_BYTES): add LIMIT or an aggregate, or COPY (...) TO a file and read parts of it]\n`;
    // Files COPY wrote, and the database file, back into the caller's view.
    for (const f of r.outputs) {
      await ctx.fs.mkdir(dirOf(f.name), { recursive: true }).catch(() => {});
      await ctx.fs.writeFile(f.name, f.bytes);
      err += `wrote ${f.name} (${f.bytes.length.toLocaleString('en-US')} bytes)\n`;
    }
    if (o.out !== undefined) {
      const p = abs(ctx.cwd, o.out);
      await ctx.fs.writeFile(p, out);
      err += `wrote ${p} (printed output)\n`; out = '';
    }
    if (r.error) {
      const n = pl.statements.length > 1 ? ` (statement ${r.error.statement + 1} of ${pl.statements.length}: ${pl.statements[r.error.statement].replace(/\s+/g, ' ').slice(0, 60)})` : '';
      return { stdout: out, stderr: err + `Error${n}: ${explain(r.error.message, new Set([...pl.inputs, ...pl.outputs]))}\n`, exitCode: 1 };
    }
    return ok(out, err);
  }));
  return [duckdb];
}
