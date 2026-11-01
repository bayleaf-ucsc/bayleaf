// The runtime-agnostic core of a code run: snapshot in, captured output and
// proposed file changes out. Nothing here touches the network, storage or the
// page; the guest sees only the in-memory snapshot through a tiny fs API.
//
//   request = { files: [{ path, bytes: Uint8Array, hash }], code, filename?,
//               args?: string[], stdin?: string, limits?: {...} }
//   result  = { status: 'ok'|'error'|'timeout'|'oom'|'cancelled'|'exit',
//               exitCode, message?, stdout, stderr, truncated,
//               changes: [{ path, op: 'create'|'modify'|'delete', baseHash, bytes? }],
//               ms }
//
// A Python runtime (Pyodide) would implement the same runRequest contract with
// a different engine in the middle; validate(), normalize() and diff() carry over.

export const DEFAULT_LIMITS = {
  timeMs: 5000, memoryBytes: 64 << 20, maxOutputBytes: 64 << 10,
  maxFileBytes: 4 << 20, maxFiles: 500, stackBytes: 1 << 20,
};

// Shell-style exit codes, so a caller that only reads exitCode still sees why.
export const CODES = { timeout: 124, cancelled: 130, oom: 137 };

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Absolute, slash-separated, no "." or ".." left, so "/a/../b" and "b" meet.
export function normalize(path) {
  const out = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}

// Refuse an oversized snapshot before spending any engine time on it.
export function validate(req, limits) {
  if (typeof req.code !== 'string') throw new Error('code must be a string');
  const files = req.files ?? [];
  if (files.length > limits.maxFiles) throw new Error(`snapshot has ${files.length} files, limit ${limits.maxFiles}`);
  for (const f of files) {
    if (f.bytes.byteLength > limits.maxFileBytes) throw new Error(`${f.path} exceeds maxFileBytes`);
  }
}

// Bounded text sink: keeps the first maxBytes (UTF-8) across stdout+stderr.
function sink(maxBytes) {
  const s = { stdout: '', stderr: '', used: 0, truncated: false };
  s.write = (stream, text) => {
    if (s.truncated) return;
    const b = enc.encode(text);
    if (s.used + b.length > maxBytes) {
      s[stream] += dec.decode(b.subarray(0, maxBytes - s.used)).replace(/�$/, '');
      s.used = maxBytes; s.truncated = true; return;
    }
    s[stream] += text; s.used += b.length;
  };
  return s;
}

// Proposed changes: compare the guest's final working set with the snapshot.
async function diff(initial, work) {
  const changes = [];
  for (const [path, bytes] of work) {
    const was = initial.get(path);
    if (!was) changes.push({ path, op: 'create', baseHash: null, bytes });
    else if (!sameBytes(was.bytes, bytes)) changes.push({ path, op: 'modify', baseHash: was.hash, bytes });
  }
  for (const [path, was] of initial) if (!work.has(path)) changes.push({ path, op: 'delete', baseHash: was.hash });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// quickjs: a QuickJSWASMModule (from quickjs-emscripten-core). shouldCancel: an
// optional poll for soft cancellation, checked from the interrupt handler.
export async function runRequest(quickjs, req, { shouldCancel = () => false } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...req.limits };
  validate(req, limits);
  const t0 = performance.now();
  const initial = new Map();
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
  let reason = null, exitCode = 0;
  rt.setInterruptHandler(() => {
    if (!reason && Date.now() > deadline) reason = 'timeout';
    if (!reason && shouldCancel()) reason = 'cancelled';
    return reason !== null;
  });
  const vm = rt.newContext();
  const result = (status, message) => ({ status, exitCode, message, stdout: out.stdout, stderr: out.stderr, truncated: out.truncated });

  try {
    install(vm, { out, work, limits, req, exit: (code) => { exitCode = code | 0; reason = 'exit'; } });
    let r = vm.evalCode(req.code, req.filename ?? '/main.js', { type: 'global' });
    // Settle promise jobs (async functions, .then) so their output lands too.
    if (!r.error) { r.value.dispose(); r = rt.executePendingJobs(); if (!r.error) r.value?.dispose?.(); }
    let res;
    if (r.error) {
      const err = vm.dump(r.error); r.error.dispose();
      const message = describe(err);
      if (reason === 'exit') res = result('exit', null);
      else if (reason) { exitCode = CODES[reason]; res = result(reason, reason === 'timeout' ? `exceeded ${limits.timeMs} ms` : 'cancelled by host'); }
      else if (/out of memory/i.test(message) || err == null) { exitCode = CODES.oom; res = result('oom', `exceeded ${limits.memoryBytes} bytes (${message})`); }
      else { exitCode = 1; res = result('error', message); }
    } else if (reason === 'exit') res = result('exit', null);
    else res = result('ok', null);
    res.changes = await diff(initial, work);
    res.ms = Math.round(performance.now() - t0);
    return res;
  } catch (e) {
    // A host-side throw (e.g. wasm trap) means the engine state is suspect:
    // report it and propose nothing.
    exitCode = 1;
    return { ...result(/memory/i.test(e.message) ? 'oom' : 'error', `engine: ${e.message}`), changes: [], ms: Math.round(performance.now() - t0) };
  } finally {
    // After a stack overflow or OOM, QuickJS can leak objects and fail its
    // free-time assertion (an emscripten abort). The result is already
    // computed; the worker that ran it is discarded, so the engine is too.
    try { vm.dispose(); rt.dispose(); } catch { /* engine is single-use */ }
  }
}

function describe(err) {
  if (err && typeof err === 'object') return `${err.name ?? 'Error'}: ${err.message ?? ''}${err.stack ? '\n' + err.stack : ''}`.trim();
  return String(err);
}

// The guest's whole world: console/print, args, stdin, exit() and fs. Host
// functions take and return plain values only; a small guest-side prelude
// adapts typed arrays so no host object ever crosses into the guest.
function install(vm, { out, work, limits, req, exit }) {
  const host = vm.newObject();
  const def = (name, f) => {
    const h = vm.newFunction(name, (...hs) => {
      const v = f(...hs.map((x) => vm.dump(x)));
      return v === undefined ? undefined : toHandle(vm, v);
    });
    vm.setProp(host, name, h); h.dispose();
  };
  const text = (xs) => xs.map((x) => (typeof x === 'string' ? x : safeJSON(x))).join(' ') + '\n';
  const need = (p) => { const k = normalize(p); if (!work.has(k)) throw new Error(`ENOENT: ${k}`); return k; };

  def('out', (xs) => out.write('stdout', text(xs)));
  def('err', (xs) => out.write('stderr', text(xs)));
  def('exit', (code) => exit(code ?? 0));
  def('readFile', (p) => dec.decode(work.get(need(p))));
  def('readBytes', (p) => work.get(need(p)).slice().buffer); // a copy, never a view of host memory
  def('writeFile', (p, data) => {
    const k = normalize(p);
    const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
    if (bytes.byteLength > limits.maxFileBytes) throw new Error(`EFBIG: ${k} exceeds ${limits.maxFileBytes} bytes`);
    if (!work.has(k) && work.size >= limits.maxFiles) throw new Error(`EMFILE: more than ${limits.maxFiles} files`);
    work.set(k, bytes);
  });
  def('exists', (p) => work.has(normalize(p)) || isDir(work, normalize(p)));
  def('rm', (p) => { work.delete(need(p)); });
  def('readdir', (p = '/') => {
    const dir = normalize(p), pre = dir === '/' ? '/' : dir + '/';
    const names = new Set();
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

const isDir = (work, dir) => dir === '/' || [...work.keys()].some((k) => k.startsWith(dir + '/'));

function toHandle(vm, v) {
  if (typeof v === 'string') return vm.newString(v);
  if (typeof v === 'number') return vm.newNumber(v);
  if (typeof v === 'boolean') return v ? vm.true : vm.false;
  if (v instanceof ArrayBuffer) return vm.newArrayBuffer(v);
  if (Array.isArray(v)) { const a = vm.newArray(); v.forEach((x, i) => { const h = toHandle(vm, x); vm.setProp(a, i, h); h.dispose?.(); }); return a; }
  return vm.undefined;
}

function safeJSON(x) { try { return JSON.stringify(x); } catch { return String(x); } }
