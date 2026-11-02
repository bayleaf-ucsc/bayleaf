// Task status as files: a synthetic file server bound at /task.
//
//   /task/<id>/status  one line: state, seconds, kind, label   (read)
//   /task/<id>/log     the last few lines the task reported    (read)
//   /task/<id>/ns      its mount table, one line per mount     (read)
//   /task/<id>/ctl     write "kill" (or "stop") to stop it     (write)
//   /task/watch/<id>/{paths,note,ctl}  file watches (src/ns/watch.ts);
//                      write "stop" to ctl to unwatch, "deliver" to hand
//                      its held changes to the agent now
//
// Tasks are `run` calls and subagents, running or recent. A model checks one
// with `cat /task/3/status` and stops one with `echo kill > /task/3/ctl`, so
// no new tool schema is needed; the tray reads the same registry. Ids are
// small numbers, fresh per page load. Output stays a line or two on purpose.
import { BaseFs, fsError, normalize, parts, type DirEntry, type FileContent, type FileStat } from './namespace.ts';
import type { Watch, Watches } from './watch.ts';

const enc = new TextEncoder();
const FILES = ['ctl', 'log', 'ns', 'status'];
const WFILES = ['ctl', 'note', 'paths'];
const LOG_LINES = 12;

export type TaskKind = 'run' | 'subagent' | 'terminal' | 'install' | 'job';
export interface TaskFields {
  kind: TaskKind; label?: string; key?: string;
  sid?: string | number | null; // the session it belongs to; none for the user's terminal
  ns?: string[] | (() => string[]); kill?: () => unknown; status?: string;
}
export interface Task extends TaskFields {
  id: number; status: string; started: number; ended?: number; log: string[];
  note(line: unknown): void; end(status: string, line?: string | null): void;
}
// What /task/watch reads of src/ns/watch.ts's registry.
export type WatchRegistry = Pick<Watches, 'get' | 'all' | 'remove' | 'deliverHeld'>;
type Scoped = { sid?: string | number | null };

export class Tasks extends EventTarget {
  declare keep: number;
  declare next: number;
  declare byId: Map<number, Task>;
  declare byKey: Map<string, Task>;
  constructor({ keep = 20 }: { keep?: number } = {}) { super(); this.keep = keep; this.next = 1; this.byId = new Map(); this.byKey = new Map(); }

  add(fields: TaskFields): Task {
    const t: Task = { id: this.next++, status: 'running', started: Date.now(), log: [], ...fields,
      note: (line) => { t.log.push(String(line).replace(/\s+/g, ' ').slice(0, 200)); t.log.splice(0, t.log.length - LOG_LINES); this.changed(); },
      end: (status, line) => { if (t.status !== 'running') return; t.status = status; t.ended = Date.now(); if (line) t.note(line); this.prune(); this.changed(); },
    };
    this.byId.set(t.id, t);
    if (t.key) this.byKey.set(t.key, t);
    this.prune();
    this.changed();
    return t;
  }
  // Add or update the task with this key (subagents report state changes); kind is for a new key.
  upsert(key: string, fields: TaskFields): Task {
    const t = this.byKey.get(key);
    if (!t) return this.add({ key, ...fields });
    const { status, ...rest } = fields;
    Object.assign(t, rest);
    if (status && status !== t.status) {
      if (status === 'running') { t.status = 'running'; t.started = Date.now(); delete t.ended; this.changed(); }
      else t.end(status);
    }
    return t;
  }
  get(id: string | number): Task | undefined { return this.byId.get(Number(id)); }
  byKeyOf(key: string): Task | undefined { return this.byKey.get(key); }
  list(): Task[] { return [...this.byId.values()]; }
  // Keep every running task and the most recent finished ones.
  prune() {
    const done = this.list().filter((t) => t.status !== 'running');
    for (const t of done.slice(0, Math.max(0, done.length - this.keep))) { this.byId.delete(t.id); if (t.key) this.byKey.delete(t.key); }
  }
  changed() { this.dispatchEvent(new Event('change')); }

  status(t: Task): string {
    const secs = (((t.ended ?? Date.now()) - t.started) / 1000).toFixed(1);
    return `${t.status} ${secs}s ${t.kind} ${t.label ?? ''}`.trimEnd() + '\n';
  }
  mounts(t: Task): string[] { return (typeof t.ns === 'function' ? t.ns() : t.ns) ?? []; }
  async kill(t: Task): Promise<boolean> {
    if (t.status !== 'running') return false;
    if (!t.kill) throw fsError('ENOTSUP', 'write', `/task/${t.id}/ctl`, 'this task cannot be killed from here');
    await t.kill();
    return true;
  }
}

// The /task tree over a Tasks registry. Read-only except ctl.
// sid: a main agent's view, holding only its own session's tasks and watches
// (other sessions' subagents and the user's terminal commands do not exist
// for it, so it cannot stop them). Without sid: every task, for the
// Interface and the terminal.
export class TaskFs extends BaseFs {
  declare tasks: Tasks;
  declare watches: () => WatchRegistry | null | undefined; // read lazily: the registry starts later
  declare mine: (x: Scoped) => boolean;
  constructor(tasks: Tasks, watches: () => WatchRegistry | null | undefined = () => null, { sid = null }: { sid?: string | number | null } = {}) {
    super(); this.tasks = tasks; this.watches = watches;
    this.mine = sid == null ? () => true : (x) => x.sid != null && String(x.sid) === String(sid);
  }
  // /task/watch/...: { w, file } or { dir: true } for /task/watch itself.
  findWatch(path: string, op: string): { dir?: true; w?: Watch; file?: string; reg: WatchRegistry } {
    const [, id, file, ...rest] = parts(path);
    const reg = this.watches();
    if (!reg) throw fsError('ENOENT', op, path);
    if (!id) return { dir: true, reg };
    const w = reg.get(id);
    if (!w || !this.mine(w) || rest.length || (file && !WFILES.includes(file))) throw fsError('ENOENT', op, path);
    return { w, file, reg };
  }
  wtext(w: Watch, file: string): string {
    if (file === 'paths') return w.paths.map((p) => p + '\n').join('');
    if (file === 'note') return `${w.note || '(no note)'}\nby ${w.by}${w.once ? ', once' : ''}; owner ${w.ownerName} (${w.owner})\n`;
    return '';
  }
  find(path: string, op: string): { t: Task | undefined; file: string | undefined } {
    const [id, file, ...rest] = parts(path);
    const t = id ? this.tasks.get(id) : undefined; // none for /task itself
    if (id && (!t || !this.mine(t))) throw fsError('ENOENT', op, path);
    if (rest.length || (file && !FILES.includes(file))) throw fsError('ENOENT', op, path);
    return { t, file };
  }
  text(t: Task, file: string): string {
    if (file === 'status') return this.tasks.status(t);
    if (file === 'log') return t.log.length ? t.log.join('\n') + '\n' : '';
    if (file === 'ns') return this.tasks.mounts(t).map((l) => l + '\n').join('');
    return ''; // ctl reads empty
  }
  isWatch(path: string) { return parts(path)[0] === 'watch' && this.watches(); }
  async stat(path: string): Promise<FileStat> {
    if (this.isWatch(path)) {
      const { dir, w, file } = this.findWatch(path, 'stat');
      if (dir || !file || !w) return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o555, size: 0, mtime: new Date(w?.created ?? 0) };
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: file === 'ctl' ? 0o200 : 0o444, size: enc.encode(this.wtext(w, file)).length, mtime: new Date(w.created) };
    }
    const { t, file } = this.find(path, 'stat');
    if (!t || !file) return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o555, size: 0, mtime: new Date(t?.started ?? 0) };
    return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: file === 'ctl' ? 0o200 : 0o444, size: enc.encode(this.text(t, file)).length, mtime: new Date(t.ended ?? t.started) };
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (this.isWatch(path)) {
      const { dir, w, file } = this.findWatch(path, 'open');
      if (dir || !file || !w) throw fsError('EISDIR', 'read', path); // a file is always a watch's
      return enc.encode(this.wtext(w, file));
    }
    const { t, file } = this.find(path, 'open');
    if (!t || !file) throw fsError('EISDIR', 'read', path); // a file is always a task's
    return enc.encode(this.text(t, file));
  }
  async readdirWithFileTypes(path: string): Promise<DirEntry[]> {
    if (this.isWatch(path)) {
      const { dir, w, file, reg } = this.findWatch(path, 'scandir');
      if (file) throw fsError('ENOTDIR', 'scandir', path);
      return (dir ? reg.all().filter(this.mine).map((x) => x.id) : WFILES).map((name) => ({ name, isFile: !dir, isDirectory: !!dir, isSymbolicLink: false }));
    }
    const { t, file } = this.find(path, 'scandir');
    if (file) throw fsError('ENOTDIR', 'scandir', path);
    // /task/watch is listed only while there are watches (it can always be opened).
    const names = t ? FILES : [...this.tasks.list().filter(this.mine).map((x) => String(x.id)), ...(this.watches()?.all().some(this.mine) ? ['watch'] : [])];
    return names.map((name) => ({ name, isFile: !!t, isDirectory: !t, isSymbolicLink: false }));
  }
  async readdir(path: string): Promise<string[]> { return (await this.readdirWithFileTypes(path)).map((d) => d.name); }
  async writeFile(path: string, content: FileContent): Promise<unknown> {
    if (this.isWatch(path)) {
      const { w, file, reg } = this.findWatch(path, 'open');
      if (file !== 'ctl' || !w) throw fsError('EROFS', 'open', path);
      const cmd = (typeof content === 'string' ? content : new TextDecoder().decode(content)).trim();
      if (!cmd) return;
      if (cmd === 'stop') return reg.remove(w.id);
      if (cmd === 'deliver') return reg.deliverHeld(w.id);
      throw fsError('EINVAL', 'write', path, `ctl accepts: stop, deliver (got "${cmd.slice(0, 20)}")`);
    }
    const { t, file } = this.find(path, 'open');
    if (file !== 'ctl' || !t) throw fsError('EROFS', 'open', path);
    const cmd = (typeof content === 'string' ? content : new TextDecoder().decode(content)).trim();
    if (!cmd) return; // a shell redirection truncates first: nothing to do
    if (cmd !== 'kill' && cmd !== 'stop') throw fsError('EINVAL', 'write', path, `ctl accepts one command: kill (alias stop) (got "${cmd.slice(0, 20)}")`);
    await this.tasks.kill(t);
  }
  async appendFile(path: string, content: FileContent): Promise<unknown> { return this.writeFile(path, content); } // the receipt is writeFile's
  async mkdir(path: string): Promise<void> { throw fsError('EROFS', 'mkdir', normalize(path)); }
  async rm(path: string): Promise<void> { throw fsError('EROFS', 'rm', normalize(path)); }
}
