// The virtual filesystem the agent, the file browser and the editor share.
//
//   /            in memory (just-bash's InMemoryFs): /tmp and scratch, gone on reload
//   /work        the origin-private file system (OPFS): durable, this browser only
//   /pouch       IndexedDB: AGENTS.md and skills/, kept apart from your files
//   /mnt/<name>  folders you picked with showDirectoryPicker (Chromium only)
//
// Since the Namespaces work (src/ns/), the tree is a Plan 9 mount table
// rather than just-bash's MountableFs: each store above is a small file server
// bound at its path, /work can be stacked over a read-only seed archive, and
// /task is a synthetic tree of running tasks. Tasks (run, subagents) get
// narrower namespaces cut from this one and reach them over 9P.
//
// One adapter, HandleFs, serves both OPFS and picked folders, because both are
// FileSystemDirectoryHandles.
import { InMemoryFs } from 'just-bash';
import * as store from './store.js';
import { BaseFs, Namespace, fsError, normalize, parts, toBytes, encodingOf } from './ns/namespace.js';
import { seedFrom } from './ns/seed.js';
import { Tasks, TaskFs } from './ns/tasks.js';
import { attribute } from './ns/watch.js';

export { normalize };

// ── FileSystemDirectoryHandle adapter: OPFS and picked folders ─────
export class HandleFs extends BaseFs {
  constructor(root, { readOnly = false } = {}) { super(); this.root = root; this.readOnly = readOnly; }

  async dir(path, { create = false, op = 'open' } = {}) {
    let h = this.root;
    for (const name of parts(path)) {
      try { h = await h.getDirectoryHandle(name, { create }); } catch (e) {
        throw fsError(e.name === 'TypeMismatchError' ? 'ENOTDIR' : 'ENOENT', op, path);
      }
    }
    return h;
  }
  async entry(path, op) {
    const p = parts(path);
    if (!p.length) return this.root;
    const parent = await this.dir('/' + p.slice(0, -1).join('/'), { op });
    const name = p.at(-1);
    try { return await parent.getFileHandle(name); } catch {}
    try { return await parent.getDirectoryHandle(name); } catch {}
    throw fsError('ENOENT', op, path);
  }
  guard(op, path) { if (this.readOnly) throw fsError('EROFS', op, path); }

  async stat(path) {
    const h = await this.entry(path, 'stat');
    if (h.kind === 'directory') return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(0) };
    const f = await h.getFile();
    return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size: f.size, mtime: new Date(f.lastModified) };
  }
  async readFileBuffer(path) {
    const h = await this.entry(path, 'open');
    if (h.kind === 'directory') throw fsError('EISDIR', 'read', path);
    return new Uint8Array(await (await h.getFile()).arrayBuffer());
  }
  async writeFile(path, content, options) {
    this.guard('open', path);
    const p = parts(path);
    const parent = await this.dir('/' + p.slice(0, -1).join('/'), { op: 'open' });
    const fh = await parent.getFileHandle(p.at(-1), { create: true });
    // createWritable is missing in some older Safari builds; fail loudly rather than corrupt.
    if (!fh.createWritable) throw fsError('ENOTSUP', 'write (this browser cannot write files here)', path);
    const w = await fh.createWritable();
    await w.write(toBytes(content, encodingOf(options)));
    await w.close();
  }
  async mkdir(path, options) {
    this.guard('mkdir', path);
    const p = parts(path);
    if (!options?.recursive) {
      if (await this.exists(path)) throw fsError('EEXIST', 'mkdir', path);
      const parent = await this.dir('/' + p.slice(0, -1).join('/'), { op: 'mkdir' });
      await parent.getDirectoryHandle(p.at(-1), { create: true });
    } else await this.dir(path, { create: true, op: 'mkdir' });
  }
  async readdir(path) {
    const h = await this.dir(path, { op: 'scandir' });
    const names = [];
    for await (const name of h.keys()) names.push(name);
    return names.sort();
  }
  async readdirWithFileTypes(path) {
    const h = await this.dir(path, { op: 'scandir' });
    const out = [];
    for await (const [name, e] of h.entries()) out.push({ name, isFile: e.kind === 'file', isDirectory: e.kind === 'directory', isSymbolicLink: false });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async rm(path, options) {
    this.guard('rm', path);
    const p = parts(path);
    if (!p.length) throw fsError('EINVAL', 'rm', path);
    const parent = await this.dir('/' + p.slice(0, -1).join('/'), { op: 'rm' }).catch((e) => { if (options?.force) return null; throw e; });
    if (!parent) return;
    try { await parent.removeEntry(p.at(-1), { recursive: !!options?.recursive }); } catch (e) {
      if (e.name === 'NotFoundError') { if (options?.force) return; throw fsError('ENOENT', 'rm', path); }
      if (e.name === 'InvalidModificationError') throw fsError('ENOTEMPTY', 'rm', path);
      throw e;
    }
  }
}

// ── IndexedDB adapter for /pouch ──────────────────────────────────
// A flat map from path to record; directories are explicit records. Small by
// design (instructions and skills), so listing scans all keys.
export class IdbFs extends BaseFs {
  async rec(path) { return path === '/' ? { kind: 'dir', mtime: 0 } : store.get('shared', normalize(path)); }
  async stat(path) {
    const r = await this.rec(path);
    if (!r) throw fsError('ENOENT', 'stat', path);
    return { isFile: r.kind === 'file', isDirectory: r.kind === 'dir', isSymbolicLink: false,
      mode: r.kind === 'dir' ? 0o755 : 0o644, size: r.data?.length ?? 0, mtime: new Date(r.mtime) };
  }
  async readFileBuffer(path) {
    const r = await this.rec(path);
    if (!r) throw fsError('ENOENT', 'open', path);
    if (r.kind === 'dir') throw fsError('EISDIR', 'read', path);
    return r.data;
  }
  async parentMustExist(path, op) {
    const parent = normalize(path + '/..');
    const r = await this.rec(parent);
    if (!r) throw fsError('ENOENT', op, path);
    if (r.kind !== 'dir') throw fsError('ENOTDIR', op, path);
  }
  async writeFile(path, content, options) {
    await this.parentMustExist(path, 'open');
    if ((await this.rec(path))?.kind === 'dir') throw fsError('EISDIR', 'open', path);
    await store.put('shared', normalize(path), { kind: 'file', data: toBytes(content, encodingOf(options)), mtime: Date.now() });
  }
  async mkdir(path, options) {
    const p = parts(path);
    for (let i = options?.recursive ? 1 : p.length; i <= p.length; i++) {
      const sub = '/' + p.slice(0, i).join('/');
      const r = await this.rec(sub);
      if (r?.kind === 'dir') { if (i === p.length && !options?.recursive) throw fsError('EEXIST', 'mkdir', path); continue; }
      if (r) throw fsError('ENOTDIR', 'mkdir', path);
      if (!options?.recursive) await this.parentMustExist(sub, 'mkdir');
      await store.put('shared', sub, { kind: 'dir', mtime: Date.now() });
    }
  }
  async children(path) {
    const prefix = path === '/' ? '/' : normalize(path) + '/';
    return (await store.keys('shared')).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
  }
  async readdir(path) {
    const r = await this.rec(path);
    if (!r) throw fsError('ENOENT', 'scandir', path);
    if (r.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', path);
    return (await this.children(path)).map((k) => k.split('/').pop()).sort();
  }
  async rm(path, options) {
    const r = await this.rec(path);
    if (!r) { if (options?.force) return; throw fsError('ENOENT', 'rm', path); }
    if (r.kind === 'dir') {
      const kids = await this.children(path);
      if (kids.length && !options?.recursive) throw fsError('ENOTEMPTY', 'rm', path);
      for (const k of kids) await this.rm(k, { recursive: true });
    }
    await store.del('shared', normalize(path));
  }
}

// ── The assembled tree ────────────────────────────────────────────
export const DEFAULTS = {}; // filled by main.js: path under /pouch -> text, seeded once
// FNV-1a, enough to tell versions of a default apart (not a security check).
const textHash = (t) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16); };
const SEEDED_BEFORE_LIST = ['/AGENTS.md', '/skills/pouch-environment/SKILL.md', '/skills/bayleaf-cli/SKILL.md', '/skills/skill-authoring/SKILL.md'];

export class Vfs extends EventTarget {
  constructor() {
    super();
    this.mem = new InMemoryFs();
    this.ns = new Namespace();
    this.fs = this.ns; // what just-bash, the tools and the UI call
    this.mounts = new Map(); // name -> { handle, readOnly, live: boolean }
    this.tasks = new Tasks();
    this.seedLayer = null; // { name, files } when /work is stacked over an archive
    this.watches = null; // the watch registry (src/ns/watch.js), set by main.js
    this.views = new Map();
  }
  // A view of the tree whose writes are reported to the watches with who made
  // them: 'user' (editor, uploads, undo), 'agent', 'run', 'subagent <name> (sN)'.
  // Writes through vfs.fs itself are not reported.
  as(source) {
    if (!this.views.has(source)) this.views.set(source, attribute(this.fs, source, {
      wants: (p) => !!this.watches?.wants(p), wantsUnder: (p) => !!this.watches?.wantsUnder(p), observe: (e) => this.watches?.observe(e),
    }));
    return this.views.get(source);
  }

  async init() {
    for (const d of ['/tmp', '/mnt', '/home']) await this.mem.mkdir(d, { recursive: true });
    this.ns.mount(this.mem, '/', { label: 'memory' });
    // OPFS. Absent in very old browsers and some embedded webviews: fall back to
    // memory and say so, rather than refuse to start.
    try {
      this.opfs = await navigator.storage.getDirectory();
      this.ns.mount(new HandleFs(this.opfs), '/work', { label: 'opfs' });
    } catch {
      this.opfsMissing = true;
      await this.mem.mkdir('/work', { recursive: true });
      this.ns.mount(this.mem, '/work', { root: '/work', label: 'memory' });
    }
    this.ns.mount(new IdbFs(), '/pouch', { label: 'indexeddb' });
    this.ns.mount(new TaskFs(this.tasks, () => this.watches), '/task', { label: 'tasks' });
    await this.seed();
    const layer = await store.getSetting('seedLayer').catch(() => null);
    if (layer) await this.stack(layer.name, layer.bytes, { save: false }).catch((e) => console.warn('Pouch seed layer:', e));
    for (const name of await store.keys('mounts')) {
      const { handle, readOnly } = await store.get('mounts', name);
      this.mounts.set(name, { handle, readOnly, live: false });
      await this.reconnect(name, { ask: false });
    }
  }

  // Stack /work over a read-only archive (bind -a): your files win, writes
  // land in /work, removing a seed file leaves a whiteout (kept in settings).
  async stack(name, bytes, { save = true } = {}) {
    const seed = await seedFrom(name, bytes);
    this.unstack({ save: false });
    this.ns.mount(seed, '/work', { flag: 'after', readOnly: true, label: 'seed ' + name });
    const wh = (await store.getSetting('seedWhiteouts').catch(() => null)) ?? [];
    this.ns.whiteouts('/work', save ? [] : wh, (list) => store.setSetting('seedWhiteouts', list.length ? list : undefined));
    this.seedLayer = { name, files: seed.size, fs: seed };
    if (save) { await store.setSetting('seedLayer', { name, bytes }); await store.setSetting('seedWhiteouts', undefined); }
    this.changed();
    return seed.size;
  }
  async unstack({ save = true } = {}) {
    if (this.seedLayer) this.ns.unmount('/work', this.seedLayer.fs);
    this.ns.wh.delete('/work');
    this.seedLayer = null;
    if (save) { await store.setSetting('seedLayer', undefined); await store.setSetting('seedWhiteouts', undefined); }
    this.changed();
  }

  // Seed /pouch with each default once; afterwards it is the user's to edit.
  // 'seeded' lists the paths given so far, so a default added in a later
  // release (the panel skill) arrives once too, and one the user deleted
  // stays deleted. `true` is a profile from before the list: it had these.
  // 'seededHash' remembers what was written: when a bundled default changes,
  // a copy the user never edited is updated in place; an edited copy (or one
  // from before the hashes) is offered (this.defaultUpdates, main.js asks).
  async seed() {
    const was = await store.getSetting('seeded');
    const had = new Set(Array.isArray(was) ? was : was ? SEEDED_BEFORE_LIST : []);
    const hashes = (await store.getSetting('seededHash')) ?? {};
    const todo = Object.keys(DEFAULTS).filter((p) => !had.has(p));
    for (const path of todo) {
      const full = '/pouch' + path;
      if (await this.fs.exists(full).catch(() => false)) continue;
      await this.fs.mkdir(normalize(full + '/..'), { recursive: true });
      await this.fs.writeFile(full, DEFAULTS[path]);
      hashes[path] = textHash(DEFAULTS[path]);
    }
    this.defaultUpdates = [];
    for (const path of Object.keys(DEFAULTS).filter((p) => had.has(p))) {
      const full = '/pouch' + path, want = textHash(DEFAULTS[path]);
      if (hashes[path] === want) continue;
      const disk = await this.fs.readFile(full).catch(() => null);
      if (disk == null) continue; // deleted by the user: stays deleted
      if (textHash(disk) === want) { hashes[path] = want; continue; }
      if (hashes[path] && textHash(disk) === hashes[path]) { await this.fs.writeFile(full, DEFAULTS[path]); hashes[path] = want; continue; }
      this.defaultUpdates.push(path);
    }
    await store.setSetting('seeded', [...had, ...todo]);
    await store.setSetting('seededHash', hashes);
  }
  // The user chose for an offered default: take the bundled one, or keep theirs.
  async resolveDefault(path, take) {
    const hashes = (await store.getSetting('seededHash')) ?? {};
    if (take) await this.fs.writeFile('/pouch' + path, DEFAULTS[path]);
    hashes[path] = textHash(DEFAULTS[path]); // asked once per bundled version
    await store.setSetting('seededHash', hashes);
    this.defaultUpdates = (this.defaultUpdates ?? []).filter((p) => p !== path);
    this.changed();
  }

  // ask=true must run inside a user gesture: browsers only prompt from one.
  async reconnect(name, { ask }) {
    const m = this.mounts.get(name);
    const mode = { mode: m.readOnly ? 'read' : 'readwrite' };
    let state = await m.handle.queryPermission?.(mode) ?? 'granted';
    if (state !== 'granted' && ask) state = await m.handle.requestPermission(mode);
    if (state === 'granted' && !m.live) {
      await this.mem.mkdir('/mnt/' + name, { recursive: true });
      this.ns.mount(new HandleFs(m.handle, { readOnly: m.readOnly }), '/mnt/' + name, { readOnly: m.readOnly, label: 'picked folder' });
      m.live = true;
      this.changed();
    }
    return m.live;
  }

  async pick(readOnly) {
    const handle = await window.showDirectoryPicker({ mode: readOnly ? 'read' : 'readwrite' });
    let name = handle.name.replace(/[^\w.-]+/g, '-') || 'folder';
    for (let i = 2; this.mounts.has(name); i++) name = handle.name + '-' + i;
    await store.put('mounts', name, { handle, readOnly });
    this.mounts.set(name, { handle, readOnly, live: false });
    await this.reconnect(name, { ask: false });
    return '/mnt/' + name;
  }

  async unmount(name) {
    const m = this.mounts.get(name);
    if (m?.live) this.ns.unmount('/mnt/' + name);
    this.mounts.delete(name);
    await store.del('mounts', name);
    await this.mem.rm('/mnt/' + name, { recursive: true, force: true });
    this.changed();
  }

  // Which storage a path lives in, for labels and warnings.
  where(path) {
    const p = normalize(path);
    if (p === '/work' || p.startsWith('/work/')) return this.opfsMissing ? 'memory' : 'opfs';
    if (p === '/pouch' || p.startsWith('/pouch/')) return 'idb';
    const m = p.match(/^\/mnt\/([^/]+)/);
    if (m) return this.mounts.get(m[1])?.readOnly ? 'mount-ro' : 'mount';
    return 'memory';
  }

  // Types come with the listing; sizes still need one stat per file.
  async list(path) {
    const items = await this.fs.readdirWithFileTypes(path);
    return Promise.all(items.map(async ({ name, isDirectory }) => {
      const s = isDirectory ? null : await this.fs.stat(normalize(path + '/' + name)).catch(() => null);
      return { name, isDirectory, size: s?.size ?? 0 };
    }));
  }

  // The agent's mount table, one line per mount point, for the trust panel.
  describe() { return this.ns.describe(); }

  changed() { this.dispatchEvent(new Event('change')); }
}
