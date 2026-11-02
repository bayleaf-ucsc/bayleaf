// Ported from experiments/quickjs. Host side: snapshot files out of a vfs, run them in a disposable worker,
// and apply the proposed changes back with conflict detection. Nothing the
// guest does reaches the filesystem except through applyChanges().
import { DEFAULT_LIMITS, CODES, normalize, sha256 } from './core.ts';
import type { AppliedChange, Change, ChangeConflict, RunLimits, RunRequest, RunResult, RunStatus, SnapshotFile } from './core.ts';
import type { RunLoaded, RunMessage, RunWorkerMessage } from './protocol.ts';

// The slice of Pouch's vfs API a snapshot and its write-back use.
export interface RunFs {
  exists(p: string): Promise<boolean>; readFileBuffer(p: string): Promise<ArrayBuffer | Uint8Array>;
  writeFile(p: string, content: Uint8Array): Promise<void>; rm(p: string, options?: object): Promise<void>;
}
// A Web Worker, or a Node worker_threads stand-in delivering bare payloads.
export interface RunWorker {
  postMessage(msg: RunMessage, transfer?: Transferable[]): void; terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null; onerror: ((e: ErrorEvent) => void) | null;
}
export interface RunOptions {
  signal?: AbortSignal; graceMs?: number; loadMs?: number; applyMs?: number; ns?: MessagePort;
  onPhase?: (...a: ['loaded', RunLoaded] | ['ran', { type: 'ran' }]) => void; onStop?: (status: RunStatus) => void;
}

// Read a bounded snapshot from a vfs-shaped object (readFileBuffer). paths are
// chosen by the caller (e.g. the agent's `run` tool arguments), not discovered.
export async function snapshot(fs: Pick<RunFs, 'readFileBuffer'>, paths: string[], limits: RunLimits = DEFAULT_LIMITS) {
  if (paths.length > limits.maxFiles) throw new Error(`more than ${limits.maxFiles} files`);
  const files: SnapshotFile[] = [];
  for (const p of paths) {
    const bytes = new Uint8Array(await fs.readFileBuffer(p));
    if (bytes.byteLength > limits.maxFileBytes) throw new Error(`${p} exceeds maxFileBytes`);
    files.push({ path: normalize(p), bytes, hash: await sha256(bytes) });
  }
  return files;
}

const exitCodes: Partial<Record<RunStatus, number>> = CODES;
const fail = (status: RunStatus, message: string, ms = 0): RunResult => ({ status, exitCode: exitCodes[status] ?? 1, message, stdout: '', stderr: '', truncated: false, changes: [], ms });

// makeWorker() returns a Web-Worker-shaped object (postMessage, terminate,
// onmessage, onerror). The hard deadline (timeMs + graceMs) backs up
// QuickJS's own interrupt check: a guest stuck inside one long native call
// still ends. It counts from "ready", or with a 9P namespace (ns, a
// MessagePort the worker reads its files through) from "loaded", so reading
// the snapshot does not eat the guest's time; writing back after "ran" has its
// own deadline (applyMs). Cancellation is always terminate(): a busy worker
// cannot read a cancel message, and without cross-origin isolation there is
// no SharedArrayBuffer flag to poll. onStop() runs first, so the host can
// flush the 9P server and refuse whatever the worker sends after.
export function runInWorker(makeWorker: () => RunWorker, request: RunRequest, { signal, graceMs = 1000, loadMs = 10000, applyMs = 30000, ns, onPhase, onStop }: RunOptions = {}) {
  const limits = { ...DEFAULT_LIMITS, ...request.limits };
  return new Promise<RunResult>((resolve) => {
    const w = makeWorker();
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    let timer = setTimeout(() => end(fail('error', `engine did not load within ${loadMs} ms`)), loadMs);
    const end = (r: RunResult, finished = false) => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (!finished) onStop?.(r.status); // cut off: nothing it sends from now on may land
      w.terminate();
      resolve(r);
    };
    const deadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => end(fail('timeout', `exceeded ${limits.timeMs} ms (hard stop)`, ms())), limits.timeMs + graceMs);
    };
    const onAbort = () => end(fail('cancelled', 'cancelled by host', ms()));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    w.onerror = (e) => end(fail('error', `worker: ${e.message ?? e}`));
    w.onmessage = (e) => {
      const msg = (e.data ?? e) as RunWorkerMessage; // a Node port delivers the bare payload
      if (msg.type === 'ready') {
        if (ns) {
          clearTimeout(timer);
          timer = setTimeout(() => end(fail('error', `reading the files took over ${loadMs} ms`)), loadMs);
          w.postMessage({ type: 'run', request, ns }, [ns]);
        } else { deadline(); w.postMessage({ type: 'run', request }); }
      } else if (msg.type === 'loaded') { onPhase?.('loaded', msg); deadline(); }
      else if (msg.type === 'ran') {
        onPhase?.('ran', msg);
        clearTimeout(timer);
        timer = setTimeout(() => end(fail('error', `writing changes back took over ${applyMs} ms`, ms())), applyMs);
      } else if (msg.type === 'result') end(msg.result, true);
    };
  });
}

// Apply proposed changes to a vfs-shaped object (readFileBuffer, writeFile,
// rm, exists). A change applies only if the file still matches the snapshot
// it was computed from; otherwise it is reported as a conflict and skipped.
// atomic: check everything first, write nothing if any change conflicts.
export async function applyChanges(fs: RunFs, changes: Change[], { atomic = false } = {}) {
  const current = async (path: string) => ((await fs.exists(path)) ? sha256(new Uint8Array(await fs.readFileBuffer(path))) : null);
  const checked = [];
  for (const c of changes) {
    // A refused check (deleted between exists and read, a dropped mount) is a
    // conflict for that file, so the run still reports a result.
    let now: string | null = null, error: string | undefined;
    try { now = await current(c.path); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    let conflict: string | null = null;
    if (error !== undefined) conflict = 'could not check the file';
    else if (c.op === 'create' && now !== null) conflict = 'file was created since the snapshot';
    else if (c.op !== 'create' && now === null) conflict = 'file was deleted since the snapshot';
    else if (c.op !== 'create' && now !== c.baseHash) conflict = 'file changed since the snapshot';
    checked.push({ c, conflict, error });
  }
  const conflicts: ChangeConflict[] = checked.flatMap(({ c, conflict, error }) => (conflict ? [{ path: c.path, op: c.op, reason: conflict, ...(error === undefined ? {} : { error }) }] : []));
  const applied: AppliedChange[] = [];
  if (atomic && conflicts.length) return { applied, conflicts };
  // Why check-then-write is not a transaction: another writer can still slip
  // in between; in Pouch the agent loop is the only other writer and it is
  // waiting on this call, so the window is the user's own hand in the editor.
  for (const { c, conflict } of checked) {
    if (conflict) continue;
    // A refused write (read-only mount, no such folder) is reported like a conflict.
    try {
      if (c.op === 'delete') await fs.rm(c.path);
      else await fs.writeFile(c.path, c.bytes);
    } catch (e) { conflicts.push({ path: c.path, op: c.op, reason: 'write failed', error: e instanceof Error ? e.message : String(e) }); continue; }
    applied.push({ path: c.path, op: c.op });
  }
  return { applied, conflicts };
}

// An in-memory stand-in with the slice of Pouch's vfs API used above.
export class MemFS implements RunFs {
  declare files: Map<string, Uint8Array>;
  constructor(entries: Record<string, string | Uint8Array> = {}) {
    this.files = new Map();
    for (const [p, v] of Object.entries(entries)) this.files.set(normalize(p), typeof v === 'string' ? new TextEncoder().encode(v) : v);
  }
  async exists(p: string) { return this.files.has(normalize(p)); }
  async readFileBuffer(p: string) { const b = this.files.get(normalize(p)); if (!b) throw new Error(`ENOENT: ${p}`); return b.slice(); }
  async readFile(p: string) { return new TextDecoder().decode(await this.readFileBuffer(p)); }
  async writeFile(p: string, content: string | Uint8Array) { this.files.set(normalize(p), typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)); }
  async rm(p: string) { if (!this.files.delete(normalize(p))) throw new Error(`ENOENT: ${p}`); }
}
