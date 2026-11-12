// Ported from experiments/quickjs (the proof of concept and its tests).
// The runtime-agnostic core of a code run: snapshot in, captured output and
// proposed file changes out. Nothing here touches the network, storage or the
// page; the guest sees only the in-memory snapshot through a tiny fs API.
//
// A Python runtime (Pyodide) would implement the same runRequest contract with
// a different engine in the middle; validate(), normalize() and diff() carry over.
import type { DisposableResult, ExecutePendingJobsResult, QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core';

export interface RunLimits { timeMs: number; memoryBytes: number; maxOutputBytes: number; maxFileBytes: number; maxFiles: number; stackBytes: number }
export interface SnapshotFile { path: string; bytes: Uint8Array; hash?: string }
// specs: with a 9P namespace, the paths, folders and globs the worker reads itself.
export interface RunRequest { files?: SnapshotFile[]; specs?: string[]; code: string; filename?: string; cwd?: string; args?: string[]; stdin?: string; limits?: Partial<RunLimits> }
export type RunStatus = 'ok' | 'error' | 'timeout' | 'oom' | 'cancelled' | 'exit';
export type ChangeOp = 'create' | 'modify' | 'delete';
// A delete carries no bytes; a create or modify always does.
export type Change = { path: string; baseHash: string | null } & ({ op: 'delete'; bytes?: undefined } | { op: 'create' | 'modify'; bytes: Uint8Array });
export interface AppliedChange { path: string; op: ChangeOp }
export interface ChangeConflict { path: string; op: ChangeOp; reason: string; error?: string }
// phase 'load': the snapshot could not be read; applied/conflicts: what a 9P write-back did.
export interface RunResult {
  status: RunStatus; exitCode: number; message?: string | null; stdout: string; stderr: string; truncated: boolean;
  changes: Change[]; ms: number; phase?: 'load'; applied?: AppliedChange[]; conflicts?: ChangeConflict[];
}
interface Sink { stdout: string; stderr: string; used: number; truncated: boolean; write(stream: 'stdout' | 'stderr', text: string): void }
type HostValue = string | number | boolean | ArrayBuffer | HostValue[];

export const DEFAULT_LIMITS: RunLimits = {
  timeMs: 5000, memoryBytes: 64 << 20, maxOutputBytes: 64 << 10,
  maxFileBytes: 4 << 20, maxFiles: 500, stackBytes: 1 << 20,
};

// Shell-style exit codes, so a caller that only reads exitCode still sees why.
export const CODES = { timeout: 124, cancelled: 130, oom: 137 };

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256(bytes: Uint8Array): Promise<string> {
  // digest refuses shared memory; a view over a SharedArrayBuffer is copied out first.
  const view = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
  const d = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Absolute, slash-separated, no "." or ".." left, so "/a/../b" and "b" meet.
export function normalize(path: string): string {
  const out = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}

// Refuse an oversized snapshot before spending any engine time on it.
export function validate(req: RunRequest, limits: RunLimits) {
  if (typeof req.code !== 'string') throw new Error('code must be a string');
  const files = req.files ?? [];
  if (files.length > limits.maxFiles) throw new Error(`snapshot has ${files.length} files, limit ${limits.maxFiles}`);
  for (const f of files) {
    if (f.bytes.byteLength > limits.maxFileBytes) throw new Error(`${f.path} exceeds maxFileBytes`);
  }
}

// Bounded text sink: keeps the first maxBytes (UTF-8) across stdout+stderr.
function sink(maxBytes: number) {
  const s: Sink = { stdout: '', stderr: '', used: 0, truncated: false, write(stream, text) {
    if (s.truncated) return;
    const b = enc.encode(text);
    if (s.used + b.length > maxBytes) {
      s[stream] += dec.decode(b.subarray(0, maxBytes - s.used)).replace(/�$/, '');
      s.used = maxBytes; s.truncated = true; return;
    }
    s[stream] += text; s.used += b.length;
  } };
  return s;
}

// Proposed changes: compare the guest's final working set with the snapshot.
async function diff(initial: Map<string, { bytes: Uint8Array; hash: string }>, work: Map<string, Uint8Array>) {
  const changes: Change[] = [];
  for (const [path, bytes] of work) {
    const was = initial.get(path);
    if (!was) changes.push({ path, op: 'create', baseHash: null, bytes });
    else if (!sameBytes(was.bytes, bytes)) changes.push({ path, op: 'modify', baseHash: was.hash, bytes });
  }
  for (const [path, was] of initial) if (!work.has(path)) changes.push({ path, op: 'delete', baseHash: was.hash });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// quickjs: a QuickJSWASMModule (from quickjs-emscripten-core). shouldCancel: an
// optional poll for soft cancellation, checked from the interrupt handler.
export async function runRequest(quickjs: QuickJSWASMModule, req: RunRequest, { shouldCancel = () => false }: { shouldCancel?: () => boolean } = {}): Promise<RunResult> {
  const limits = { ...DEFAULT_LIMITS, ...req.limits };
  validate(req, limits);
  const t0 = performance.now();
  const initial = new Map<string, { bytes: Uint8Array; hash: string }>();
  for (const f of req.files ?? []) initial.set(normalize(f.path), { bytes: f.bytes, hash: f.hash ?? await sha256(f.bytes) });
  const work = new Map([...initial].map(([p, f]) => [p, f.bytes]));
  const out = sink(limits.maxOutputBytes);

  const rt = quickjs.newRuntime();
  rt.setMemoryLimit(limits.memoryBytes);
  rt.setMaxStackSize(limits.stackBytes);
  const deadline = Date.now() + limits.timeMs;
  // Why a reason variable: QuickJS reports every interrupt as the same
  // "interrupted" InternalError, which the guest could even catch; the host
  // remembers why it pulled the plug and keeps pulling until the run ends.
  let reason: 'timeout' | 'cancelled' | 'exit' | null = null, exitCode = 0;
  rt.setInterruptHandler(() => {
    if (!reason && Date.now() > deadline) reason = 'timeout';
    if (!reason && shouldCancel()) reason = 'cancelled';
    return reason !== null;
  });
  const vm = rt.newContext();
  // changes and ms are filled in once the run is over.
  const result = (status: RunStatus, message: string | null) => ({ status, exitCode, message, stdout: out.stdout, stderr: out.stderr, truncated: out.truncated });

  try {
    install(vm, { out, work, limits, req, exit: (code: number) => { exitCode = code | 0; reason = 'exit'; } });
    let r: DisposableResult<QuickJSHandle, QuickJSHandle> | ExecutePendingJobsResult = vm.evalCode(req.code, req.filename ?? '/main.js', { type: 'global' });
    // Settle promise jobs (async functions, .then) so their output lands too; their result is a job count.
    if (!r.error) { r.value.dispose(); r = rt.executePendingJobs(); }
    let res: ReturnType<typeof result>;
    if (r.error) {
      const err = vm.dump(r.error); r.error.dispose();
      const message = describe(err);
      if (reason === 'exit') res = result('exit', null);
      else if (reason) { exitCode = CODES[reason]; res = result(reason, reason === 'timeout' ? `exceeded ${limits.timeMs} ms` : 'cancelled by host'); }
      else if (/out of memory/i.test(message) || err == null) { exitCode = CODES.oom; res = result('oom', `exceeded ${limits.memoryBytes} bytes (${message})`); }
      else { exitCode = 1; res = result('error', message); }
    } else if (reason === 'exit') res = result('exit', null);
    else res = result('ok', null);
    const changes = await diff(initial, work);
    return { ...res, changes, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    // A host-side throw (e.g. wasm trap) means the engine state is suspect:
    // report it and propose nothing.
    exitCode = 1;
    const message = e instanceof Error ? e.message : String(e);
    return { ...result(/memory/i.test(message) ? 'oom' : 'error', `engine: ${message}`), changes: [], ms: Math.round(performance.now() - t0) };
  } finally {
    // After a stack overflow or OOM, QuickJS can leak objects and fail its
    // free-time assertion (an emscripten abort). The result is already
    // computed; the worker that ran it is discarded, so the engine is too.
    try { vm.dispose(); rt.dispose(); } catch { /* engine is single-use */ }
  }
}

function describe(err: { name?: string; message?: string; stack?: string } | string | number | boolean | null | undefined) {
  if (err && typeof err === 'object') {
    // Explain the runtime boundary, without adding a pretend Node loader or
    // changing scripts that define their own require (or use typeof require).
    const hint = err.name === 'ReferenceError' && /^['"]?require['"]? is not defined$/.test(err.message ?? '')
      ? '\nPouch runs JavaScript, not Node.js: there is no require. Use the global fs (fs.readFile, fs.writeFile), without importing it.' : '';
    return `${err.name ?? 'Error'}: ${err.message ?? ''}${err.stack ? '\n' + err.stack : ''}${hint}`.trim();
  }
  return String(err);
}

// The guest's whole world: console/print, args, stdin, exit() and fs. Host
// functions take and return plain values only; a small guest-side prelude
// adapts typed arrays so no host object ever crosses into the guest.
interface Guest { out: Sink; work: Map<string, Uint8Array>; limits: RunLimits; req: RunRequest; exit: (code: number) => void }
function install(vm: QuickJSContext, { out, work, limits, req, exit }: Guest) {
  const host = vm.newObject();
  // The guest's values are untrusted; each host function names what the prelude passes it.
  const def = <A extends unknown[]>(name: string, f: (...args: A) => HostValue | void) => {
    const h = vm.newFunction(name, (...hs) => {
      const v = f(...(hs.map((x) => vm.dump(x)) as A));
      return v === undefined ? undefined : toHandle(vm, v);
    });
    vm.setProp(host, name, h); h.dispose();
  };
  const text = (xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : safeJSON(x))).join(' ') + '\n';
  // Relative guest paths resolve against the request's cwd (Pouch: /work).
  const cwd = normalize(req.cwd ?? '/');
  const res = (p: string) => normalize(String(p).startsWith('/') ? p : cwd + '/' + p);
  const need = (p: string) => { const k = res(p); if (!work.has(k)) throw new Error(`ENOENT: ${k}`); return k; };
  const read = (p: string) => { const k = res(p), b = work.get(k); if (!b) throw new Error(`ENOENT: ${k}`); return b; };

  def('out', (xs: unknown[]) => out.write('stdout', text(xs)));
  def('err', (xs: unknown[]) => out.write('stderr', text(xs)));
  def('exit', (code?: number) => exit(code ?? 0));
  def('readFile', (p: string) => dec.decode(read(p)));
  def('readBytes', (p: string) => read(p).slice().buffer); // a copy, never a view of host memory
  def('writeFile', (p: string, data: string | number[]) => {
    const k = res(p);
    const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
    if (bytes.byteLength > limits.maxFileBytes) throw new Error(`EFBIG: ${k} exceeds ${limits.maxFileBytes} bytes`);
    if (!work.has(k) && work.size >= limits.maxFiles) throw new Error(`EMFILE: more than ${limits.maxFiles} files`);
    work.set(k, bytes);
  });
  def('exists', (p: string) => work.has(res(p)) || isDir(work, res(p)));
  def('rm', (p: string) => { work.delete(need(p)); });
  def('readdir', (p?: string) => {
    const dir = res(p ?? cwd), pre = dir === '/' ? '/' : dir + '/';
    const names = new Set<string>();
    for (const k of work.keys()) if (k.startsWith(pre)) names.add(k.slice(pre.length).split('/')[0]);
    if (!names.size && !isDir(work, dir)) throw new Error(`ENOTDIR: ${dir}`);
    return [...names].sort();
  });
  def('args', () => req.args ?? []);
  def('stdin', () => req.stdin ?? '');

  // vm.dump turns an ArrayBuffer into {}, so the prelude sends bytes as a
  // plain number array; fine at the file sizes this targets.
  const prelude = `(h) => {
    const bytes = (d) => typeof d === 'string' ? d : Array.from(d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : String(d));
    const log = (f) => (...xs) => f(xs);
    globalThis.console = { log: log(h.out), info: log(h.out), warn: log(h.err), error: log(h.err) };
    globalThis.print = log(h.out);
    globalThis.exit = (code) => { h.exit(code); for (;;); };
    globalThis.args = h.args();
    globalThis.stdin = h.stdin();
    globalThis.fs = Object.freeze({
      readFile: (p) => h.readFile(p),
      readBytes: (p) => new Uint8Array(h.readBytes(p)),
      writeFile: (p, d) => h.writeFile(p, bytes(d)),
      exists: (p) => h.exists(p), rm: (p) => h.rm(p), readdir: (p) => h.readdir(p),
    });
  }`;
  const f = vm.unwrapResult(vm.evalCode(prelude, '<prelude>'));
  vm.unwrapResult(vm.callFunction(f, vm.undefined, host)).dispose();
  f.dispose(); host.dispose();
}

const isDir = (work: Map<string, Uint8Array>, dir: string) => dir === '/' || [...work.keys()].some((k) => k.startsWith(dir + '/'));

function toHandle(vm: QuickJSContext, v: HostValue): QuickJSHandle {
  if (typeof v === 'string') return vm.newString(v);
  if (typeof v === 'number') return vm.newNumber(v);
  if (typeof v === 'boolean') return v ? vm.true : vm.false;
  if (v instanceof ArrayBuffer) return vm.newArrayBuffer(v);
  if (Array.isArray(v)) { const a = vm.newArray(); v.forEach((x, i) => { const h = toHandle(vm, x); vm.setProp(a, i, h); h.dispose?.(); }); return a; }
  return vm.undefined;
}

function safeJSON(x: unknown) { try { return JSON.stringify(x); } catch { return String(x); } }
