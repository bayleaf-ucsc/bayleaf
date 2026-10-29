// The virtual filesystem the agent, the file browser and the editor share.
//
//   /            in memory (just-bash's InMemoryFs): /tmp and scratch, gone on reload
//   /work        the origin-private file system (OPFS): durable, this browser only
//   /pouch       IndexedDB: AGENTS.md and skills/, kept apart from your files
//   /mnt/<name>  folders you picked with showDirectoryPicker (Chromium only)
//
// One adapter, HandleFs, serves both OPFS and picked folders, because both are
// FileSystemDirectoryHandles. just-bash's MountableFs stitches the trees together
// and hands each mount paths relative to its mount point.
import { InMemoryFs, MountableFs } from 'just-bash';
import * as store from './store.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// just-bash expects Node-style errors ("ENOENT: ...") and sometimes reads .code.
function fsError(code, op, path) {
  const text = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory',
    EISDIR: 'illegal operation on a directory', EROFS: 'read-only file system', ENOTSUP: 'operation not supported',
    ENOTEMPTY: 'directory not empty', EINVAL: 'invalid argument' }[code];
  return Object.assign(new Error(`${code}: ${text}, ${op} '${path}'`), { code });
}

export function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}
const parts = (path) => normalize(path).split('/').filter(Boolean);
const resolvePath = (base, path) => normalize(path.startsWith('/') ? path : base + '/' + path);
const toBytes = (content, encoding) => typeof content !== 'string' ? content
  : encoding === 'base64' ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : enc.encode(content);
const encodingOf = (o) => (typeof o === 'string' ? o : o?.encoding);

// Methods every adapter shares, written once in terms of the primitive ones.
class BaseFs {
  resolvePath(base, path) { return resolvePath(base, path); }
  getAllPaths() { return []; } // only used for globbing in-memory trees
  async readFile(path, options) {
    const bytes = await this.readFileBuffer(path);
    const e = encodingOf(options);
    if (e === 'base64') return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
    if (e === 'latin1' || e === 'binary') return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    return dec.decode(bytes);
  }
  async appendFile(path, content, options) {
    const old = (await this.exists(path)) ? await this.readFileBuffer(path) : new Uint8Array();
    const add = toBytes(content, encodingOf(options));
    const both = new Uint8Array(old.length + add.length); both.set(old); both.set(add, old.length);
    await this.writeFile(path, both);
  }
  async exists(path) { try { await this.stat(path); return true; } catch { return false; } }
  lstat(path) { return this.stat(path); }
  async realpath(path) { await this.stat(path); return normalize(path); }
  async readdirWithFileTypes(path) {
    const names = await this.readdir(path);
    return Promise.all(names.map(async (name) => {
      const s = await this.stat(normalize(path + '/' + name));
      return { name, isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: false };
    }));
  }
  async cp(src, dest, options) {
    const s = await this.stat(src);
    if (s.isFile) return this.writeFile(dest, await this.readFileBuffer(src));
    if (!options?.recursive) throw fsError('EISDIR', 'cp', src);
    await this.mkdir(dest, { recursive: true });
    for (const name of await this.readdir(src)) await this.cp(src + '/' + name, dest + '/' + name, options);
  }
  async mv(src, dest) { await this.cp(src, dest, { recursive: true }); await this.rm(src, { recursive: true }); }
  async chmod() {}
  async utimes() {}
  async symlink(_t, p) { throw fsError('ENOTSUP', 'symlink', p); }
  async link(_e, p) { throw fsError('ENOTSUP', 'link', p); }
  async readlink(p) { throw fsError('EINVAL', 'readlink', p); }
}

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

export class Vfs extends EventTarget {
  constructor() {
    super();
    this.mem = new InMemoryFs();
    this.fs = new MountableFs({ base: this.mem });
    this.mounts = new Map(); // name -> { handle, readOnly, live: boolean }
  }

  async init() {
    for (const d of ['/tmp', '/mnt', '/home']) await this.mem.mkdir(d, { recursive: true });
    // OPFS. Absent in very old browsers and some embedded webviews: fall back to
    // memory and say so, rather than refuse to start.
    try {
      this.opfs = await navigator.storage.getDirectory();
      this.fs.mount('/work', new HandleFs(this.opfs));
    } catch {
      this.opfsMissing = true;
      await this.mem.mkdir('/work', { recursive: true });
    }
    this.fs.mount('/pouch', new IdbFs());
    await this.seed();
    for (const name of await store.keys('mounts')) {
      const { handle, readOnly } = await store.get('mounts', name);
      this.mounts.set(name, { handle, readOnly, live: false });
      await this.reconnect(name, { ask: false });
    }
  }

  // Seed /pouch with defaults once; afterwards it is the user's to edit.
  async seed() {
    if (await store.getSetting('seeded')) return;
    for (const [path, text] of Object.entries(DEFAULTS)) {
      const full = '/pouch' + path;
      await this.fs.mkdir(normalize(full + '/..'), { recursive: true });
      await this.fs.writeFile(full, text);
    }
    await store.setSetting('seeded', true);
  }

  // ask=true must run inside a user gesture: browsers only prompt from one.
  async reconnect(name, { ask }) {
    const m = this.mounts.get(name);
    const mode = { mode: m.readOnly ? 'read' : 'readwrite' };
    let state = await m.handle.queryPermission?.(mode) ?? 'granted';
    if (state !== 'granted' && ask) state = await m.handle.requestPermission(mode);
    if (state === 'granted' && !m.live) {
      await this.mem.mkdir('/mnt/' + name, { recursive: true });
      this.fs.mount('/mnt/' + name, new HandleFs(m.handle, { readOnly: m.readOnly }));
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
    if (m?.live) this.fs.unmount('/mnt/' + name);
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

  // MountableFs has no readdirWithFileTypes, so list with one stat per entry.
  async list(path) {
    const names = await this.fs.readdir(path);
    return Promise.all(names.map(async (name) => {
      const s = await this.fs.stat(normalize(path + '/' + name)).catch(() => null);
      return { name, isDirectory: !!s?.isDirectory, size: s?.size ?? 0 };
    }));
  }

  changed() { this.dispatchEvent(new Event('change')); }
}
