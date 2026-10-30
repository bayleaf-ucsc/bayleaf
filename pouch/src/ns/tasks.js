// Task status as files: a synthetic file server bound at /task.
//
//   /task/<id>/status  one line: state, seconds, kind, label   (read)
//   /task/<id>/log     the last few lines the task reported    (read)
//   /task/<id>/ns      its mount table, one line per mount     (read)
//   /task/<id>/ctl     write "kill" to stop it                 (write)
//   /task/watch/<id>/{paths,note,ctl}  file watches (src/ns/watch.js);
//                      write "stop" to ctl to unwatch
//
// Tasks are `run` calls and subagents, running or recent. A model checks one
// with `cat /task/3/status` and stops one with `echo kill > /task/3/ctl`, so
// no new tool schema is needed; the tray reads the same registry. Ids are
// small numbers, fresh per page load. Output stays a line or two on purpose.
import { BaseFs, fsError, normalize, parts } from './namespace.js';

const enc = new TextEncoder();
const FILES = ['ctl', 'log', 'ns', 'status'];
const WFILES = ['ctl', 'note', 'paths'];
const LOG_LINES = 12;

export class Tasks extends EventTarget {
  constructor({ keep = 20 } = {}) { super(); this.keep = keep; this.next = 1; this.byId = new Map(); this.byKey = new Map(); }

  // fields: { kind: 'run'|'subagent', label, key?, ns: string[] | () => string[], kill?: () => any }
  add(fields) {
    const t = { id: this.next++, status: 'running', started: Date.now(), log: [], ...fields };
    t.note = (line) => { t.log.push(String(line).replace(/\s+/g, ' ').slice(0, 200)); t.log.splice(0, t.log.length - LOG_LINES); this.changed(); };
    t.end = (status, line) => { if (t.status !== 'running') return; t.status = status; t.ended = Date.now(); if (line) t.note(line); this.prune(); this.changed(); };
    this.byId.set(t.id, t);
    if (t.key) this.byKey.set(t.key, t);
    this.prune();
    this.changed();
    return t;
  }
  // Add or update the task with this key (subagents report state changes).
  upsert(key, fields) {
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
  get(id) { return this.byId.get(Number(id)); }
  byKeyOf(key) { return this.byKey.get(key); }
  list() { return [...this.byId.values()]; }
  // Keep every running task and the most recent finished ones.
  prune() {
    const done = this.list().filter((t) => t.status !== 'running');
    for (const t of done.slice(0, Math.max(0, done.length - this.keep))) { this.byId.delete(t.id); if (t.key) this.byKey.delete(t.key); }
  }
  changed() { this.dispatchEvent(new Event('change')); }

  status(t) {
    const secs = (((t.ended ?? Date.now()) - t.started) / 1000).toFixed(1);
    return `${t.status} ${secs}s ${t.kind} ${t.label ?? ''}`.trimEnd() + '\n';
  }
  mounts(t) { return (typeof t.ns === 'function' ? t.ns() : t.ns) ?? []; }
  async kill(t) {
    if (t.status !== 'running') return false;
    if (!t.kill) throw fsError('ENOTSUP', 'write', `/task/${t.id}/ctl`, 'this task cannot be killed from here');
    await t.kill();
    return true;
  }
}

// The /task tree over a Tasks registry. Read-only except ctl.
export class TaskFs extends BaseFs {
  // watches: () => the registry (or null), read lazily since it starts later.
  constructor(tasks, watches = () => null) { super(); this.tasks = tasks; this.watches = watches; }
  // /task/watch/...: { w, file } or { dir: true } for /task/watch itself.
  findWatch(path, op) {
    const [, id, file, ...rest] = parts(path);
    const reg = this.watches();
    if (!reg) throw fsError('ENOENT', op, path);
    if (!id) return { dir: true, reg };
    const w = reg.get(id);
    if (!w || rest.length || (file && !WFILES.includes(file))) throw fsError('ENOENT', op, path);
    return { w, file, reg };
  }
  wtext(w, file) {
    if (file === 'paths') return w.paths.map((p) => p + '\n').join('');
    if (file === 'note') return `${w.note || '(no note)'}\nby ${w.by}${w.once ? ', once' : ''}; owner ${w.ownerName} (${w.owner})\n`;
    return '';
  }
  find(path, op) {
    const [id, file, ...rest] = parts(path);
    const t = id && this.tasks.get(id);
    if (id && !t) throw fsError('ENOENT', op, path);
    if (rest.length || (file && !FILES.includes(file))) throw fsError('ENOENT', op, path);
    return { t, file };
  }
  text(t, file) {
    if (file === 'status') return this.tasks.status(t);
    if (file === 'log') return t.log.length ? t.log.join('\n') + '\n' : '';
    if (file === 'ns') return this.tasks.mounts(t).map((l) => l + '\n').join('');
    return ''; // ctl reads empty
  }
  isWatch(path) { return parts(path)[0] === 'watch' && this.watches(); }
  async stat(path) {
    if (this.isWatch(path)) {
      const { dir, w, file } = this.findWatch(path, 'stat');
      if (dir || !file) return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o555, size: 0, mtime: new Date(w?.created ?? 0) };
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: file === 'ctl' ? 0o200 : 0o444, size: enc.encode(this.wtext(w, file)).length, mtime: new Date(w.created) };
    }
    const { t, file } = this.find(path, 'stat');
    if (!file) return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o555, size: 0, mtime: new Date(t?.started ?? 0) };
    return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: file === 'ctl' ? 0o200 : 0o444, size: enc.encode(this.text(t, file)).length, mtime: new Date(t.ended ?? t.started) };
  }
  async readFileBuffer(path) {
    if (this.isWatch(path)) {
      const { dir, w, file } = this.findWatch(path, 'open');
      if (dir || !file) throw fsError('EISDIR', 'read', path);
      return enc.encode(this.wtext(w, file));
    }
    const { t, file } = this.find(path, 'open');
    if (!file) throw fsError('EISDIR', 'read', path);
    return enc.encode(this.text(t, file));
  }
  async readdirWithFileTypes(path) {
    if (this.isWatch(path)) {
      const { dir, w, file, reg } = this.findWatch(path, 'scandir');
      if (file) throw fsError('ENOTDIR', 'scandir', path);
      return (dir ? reg.all().map((x) => x.id) : WFILES).map((name) => ({ name, isFile: !dir, isDirectory: !!dir, isSymbolicLink: false }));
    }
    const { t, file } = this.find(path, 'scandir');
    if (file) throw fsError('ENOTDIR', 'scandir', path);
    // /task/watch is listed only while there are watches (it can always be opened).
    const names = t ? FILES : [...this.tasks.list().map((x) => String(x.id)), ...(this.watches()?.all().length ? ['watch'] : [])];
    return names.map((name) => ({ name, isFile: !!t, isDirectory: !t, isSymbolicLink: false }));
  }
  async readdir(path) { return (await this.readdirWithFileTypes(path)).map((d) => d.name); }
  async writeFile(path, content) {
    if (this.isWatch(path)) {
      const { w, file, reg } = this.findWatch(path, 'open');
      if (file !== 'ctl') throw fsError('EROFS', 'open', path);
      const cmd = (typeof content === 'string' ? content : new TextDecoder().decode(content)).trim();
      if (!cmd) return;
      if (cmd !== 'stop') throw fsError('EINVAL', 'write', path, `ctl accepts one command: stop (got "${cmd.slice(0, 20)}")`);
      reg.remove(w.id);
      return;
    }
    const { t, file } = this.find(path, 'open');
    if (file !== 'ctl') throw fsError('EROFS', 'open', path);
    const cmd = (typeof content === 'string' ? content : new TextDecoder().decode(content)).trim();
    if (!cmd) return; // a shell redirection truncates first: nothing to do
    if (cmd !== 'kill') throw fsError('EINVAL', 'write', path, `ctl accepts one command: kill (got "${cmd.slice(0, 20)}")`);
    await this.tasks.kill(t);
  }
  async appendFile(path, content) { return this.writeFile(path, content); }
  async mkdir(path) { throw fsError('EROFS', 'mkdir', normalize(path)); }
  async rm(path) { throw fsError('EROFS', 'rm', normalize(path)); }
}
