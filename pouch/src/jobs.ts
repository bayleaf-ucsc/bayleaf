// Engine jobs: one instance of each heavy tool engine (OCR, ASR, DuckDB...)
// shared by every agent and the terminal, with a queue in front of it.
//
// - One engine per kind, created on first use and kept warm; jobs queue
//   (serial by default, `concurrency` per engine).
// - Each job is a /task entry (src/ns/tasks.ts) with its own ctl: `stop`
//   aborts that job only (a queued job leaves the queue; a running one gets
//   its signal aborted). Other jobs, and the engine, carry on.
// - Memory guard: each engine declares an estimate; loading one that would
//   exceed the budget first unloads idle engines, then refuses with a reason.
// - Capability scoping: a job gets the filesystem its caller passed (the
//   caller's own namespace view), never Pouch's global tree. This module
//   imports no vfs at all, so an engine cannot reach past what it was handed.
//
import type { IFileSystem } from 'just-bash';
import type { Task, TaskFields, Tasks } from './ns/tasks.ts';
// An engine definition (J its input, R its answer); memory in bytes.
export interface EngineRun { fs: IFileSystem; signal: AbortSignal; note(line: string): void }
export interface EngineInstance<J = unknown, R = unknown> { run(input: J, opts: EngineRun): R | Promise<R>; dispose?(): unknown }
export interface EngineDef<J = unknown, R = unknown> { label?: string; memory?: number; concurrency?: number; create(): EngineInstance<J, R> | Promise<EngineInstance<J, R>> }
export interface JobCaller { sid?: TaskFields['sid']; name?: string; fs?: IFileSystem }
interface Job { name: string; input: unknown; caller: JobCaller; ctrl: AbortController; settle: { res(v: unknown): void; rej(e: unknown): void }; state: string; task: Task }
interface LiveEngine { instance: EngineInstance | null; active: number; queue: Job[]; lastUsed: number; ready: Promise<void> | null }
export interface JobsOptions { tasks: Tasks; engines?: Record<string, EngineDef>; budget?: number }
const GiB = 2 ** 30;
const stopped = () => new DOMException('Stopped.', 'AbortError');

export function createJobs({ tasks, engines = {}, budget = defaultBudget() }: JobsOptions = {} as JobsOptions) {
  const defs = new Map(Object.entries(engines));
  const live = new Map<string, LiveEngine>(); // name -> { instance, active, queue: [], lastUsed }

  function define(name: string, def: EngineDef) { if (defs.has(name)) throw new Error(`engine ${name} is already defined`); defs.set(name, def); }
  const used = () => [...live.entries()].reduce((n, [k]) => n + (defs.get(k)!.memory ?? 0), 0);

  async function ensure(name: string) {
    if (live.has(name)) { const e = live.get(name)!; await e.ready; return e; } // one instance, even while it starts
    const def = defs.get(name)!;
    const need = def.memory ?? 0;
    // Unload idle engines, least recently used first, until it fits.
    for (const [k, e] of [...live.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (used() + need <= budget) break;
      if (!e.active && !e.queue.length) await unload(k);
    }
    if (used() + need > budget) {
      const busy = [...live.keys()].map((k) => `${k} (${(defs.get(k)!.memory! / GiB).toFixed(1)} GiB)`).join(', ');
      throw Object.assign(new Error(`not enough memory budget to start ${name}: it needs about ${(need / GiB).toFixed(1)} GiB and ${(used() / GiB).toFixed(1)} of ${(budget / GiB).toFixed(1)} GiB is held by ${busy}, which are busy. Wait for their jobs, or stop one through its /task ctl.`), { code: 'ENOMEM' });
    }
    const e: LiveEngine = { instance: null, active: 0, queue: [], lastUsed: Date.now(), ready: null };
    live.set(name, e);
    e.ready = Promise.resolve().then(() => def.create()).then((inst) => { e.instance = inst; }, (err) => { live.delete(name); throw err; });
    await e.ready;
    return e;
  }
  async function unload(name: string) {
    const e = live.get(name);
    if (!e) return;
    live.delete(name);
    await e.instance?.dispose?.();
  }

  // Submit a job. caller: { sid?, name, fs } (fs: the caller's namespace view).
  // Returns { task, result } (result: a Promise of the engine's answer).
  function submit(name: string, input: unknown, { caller = {}, label }: { caller?: JobCaller; label?: string } = {}) {
    const def = defs.get(name);
    if (!def) throw Object.assign(new Error(`unknown engine "${name}". Known: ${[...defs.keys()].join(', ') || 'none'}`), { code: 'ENOENT' });
    if (!caller.fs) throw new Error('a job needs its caller\'s filesystem view (caller.fs)');
    const ctrl = new AbortController();
    let settle!: Job['settle'];
    const result = new Promise((res, rej) => { settle = { res, rej }; });
    result.catch(() => {});
    const job = { name, input, caller, ctrl, settle, state: 'queued' } as Job; // task is set below
    const task = tasks.add({ kind: 'job', label: label ?? `${name}${caller.name ? ' for ' + caller.name : ''}`, sid: caller.sid,
      ns: () => [`${caller.name ?? 'caller'}'s namespace`],
      kill: () => stop(job) });
    job.task = task;
    task.note('queued');
    queueMicrotask(() => enqueue(job));
    return { task, result, job };
  }
  function stop(job: Job) {
    job.ctrl.abort();
    if (job.state === 'queued') {
      const e = live.get(job.name);
      if (e) e.queue = e.queue.filter((j) => j !== job);
      job.state = 'stopped'; job.task.end('stopped', 'stopped while queued'); job.settle.rej(stopped());
    }
  }
  async function enqueue(job: Job) {
    if (job.ctrl.signal.aborted) return;
    let e: LiveEngine;
    try { e = await ensure(job.name); }
    catch (err) { job.state = 'failed'; job.task.end('failed', (err as Error).message); job.settle.rej(err); return; }
    if (job.ctrl.signal.aborted) return;
    e.queue.push(job);
    pump(job.name);
  }
  function pump(name: string) {
    const e = live.get(name), def = defs.get(name)!;
    if (!e) return;
    while (e.active < (def.concurrency ?? 1) && e.queue.length) {
      const job = e.queue.shift()!;
      e.active++; job.state = 'running'; e.lastUsed = Date.now();
      job.task.note('running');
      (async () => {
        try {
          const out = await e.instance!.run(job.input, { fs: job.caller.fs!, signal: job.ctrl.signal, note: (l) => job.task.note(l) });
          if (job.ctrl.signal.aborted) throw stopped();
          job.state = 'done'; job.task.end('done'); job.settle.res(out);
        } catch (err) {
          const st = job.ctrl.signal.aborted ? 'stopped' : 'failed';
          job.state = st; job.task.end(st, st === 'stopped' ? 'stopped' : String((err as Error)?.message ?? err)); job.settle.rej(job.ctrl.signal.aborted ? stopped() : err);
        } finally { e.active--; e.lastUsed = Date.now(); pump(name); }
      })();
    }
  }
  return { define, submit, unload, loaded: () => [...live.keys()], budget, used };
}

// A quarter of the device's memory (navigator.deviceMemory caps at 8), at most 4 GiB.
export function defaultBudget() {
  const dm = (globalThis.navigator as Navigator & { deviceMemory?: number })?.deviceMemory; // Chromium only
  return Math.min(4 * GiB, dm ? (dm * GiB) / 4 : 2 * GiB);
}

// The trivial engine the tests use: wait `ms` (abortable), then hash a file from the caller's view.
export const sleepAndHash = (sha256hex: (bytes: Uint8Array) => string, { memory = 0.1 * GiB, concurrency = 1, onCreate = () => {} } = {}): EngineDef => ({
  label: 'sleep-and-hash', memory, concurrency,
  create() {
    onCreate();
    return {
      async run({ path, ms = 10 }: { path: string; ms?: number }, { fs, signal, note }: EngineRun) {
        await new Promise((res, rej) => { const t = setTimeout(res, ms); signal.addEventListener('abort', () => { clearTimeout(t); rej(stopped()); }, { once: true }); });
        const bytes = await fs.readFileBuffer(path);
        note(`hashed ${bytes.length} bytes`);
        return { path, sha256: sha256hex(bytes) };
      },
    };
  },
});
