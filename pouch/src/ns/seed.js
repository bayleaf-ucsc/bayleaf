// A read-only file server over the entries of a tar or zip archive: the seed
// layer that /work can be stacked over (starter code, a skills pack). It is
// bound 'after' the user's files, so your copy of a file wins; writing a seed
// file copies it up into /work and removing one leaves a whiteout (see
// src/ns/namespace.js). Nothing here ever writes.
import { BaseFs, fsError, normalize } from './namespace.js';
import { unpackTar, unpackZip } from '../archive.js';

export class SeedFs extends BaseFs {
  // entries: [{ path, dir, data? }] as archive.js returns them.
  constructor(entries, name = 'seed') {
    super();
    this.name = name;
    this.files = new Map();          // path -> bytes
    this.dirs = new Map([['/', new Set()]]); // path -> child names
    // An archive of one folder ("starter/...") seeds that folder's contents.
    const tops = new Set(entries.map((e) => e.path.replace(/^\/+/, '').split('/')[0]));
    const strip = tops.size === 1 && entries.some((e) => e.path.includes('/'));
    for (const e of entries) {
      if (e.path.split('/').includes('..')) continue; // no climbing out ("zip slip")
      const rel = strip ? e.path.replace(/^\/*[^/]+/, '') : e.path;
      const p = normalize(rel);
      if (p === '/') continue;
      this.addDir(normalize(p + '/..'));
      this.dirs.get(normalize(p + '/..')).add(p.split('/').pop());
      if (e.dir) this.addDir(p); else this.files.set(p, e.data);
    }
  }
  addDir(p) {
    if (this.dirs.has(p)) return;
    this.dirs.set(p, new Set());
    if (p === '/') return;
    const up = normalize(p + '/..');
    this.addDir(up);
    this.dirs.get(up).add(p.split('/').pop());
  }
  get size() { return this.files.size; }

  async stat(path) {
    const p = normalize(path);
    if (this.dirs.has(p)) return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o555, size: 0, mtime: new Date(0) };
    const b = this.files.get(p);
    if (!b) throw fsError('ENOENT', 'stat', path);
    return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o444, size: b.length, mtime: new Date(0) };
  }
  async readFileBuffer(path) {
    const p = normalize(path);
    if (this.dirs.has(p)) throw fsError('EISDIR', 'read', path);
    const b = this.files.get(p);
    if (!b) throw fsError('ENOENT', 'open', path);
    return b.slice();
  }
  async readdirWithFileTypes(path) {
    const p = normalize(path);
    const kids = this.dirs.get(p);
    if (!kids) throw fsError(this.files.has(p) ? 'ENOTDIR' : 'ENOENT', 'scandir', path);
    return [...kids].sort().map((name) => {
      const dir = this.dirs.has(normalize(p + '/' + name));
      return { name, isFile: !dir, isDirectory: dir, isSymbolicLink: false };
    });
  }
  async readdir(path) { return (await this.readdirWithFileTypes(path)).map((d) => d.name); }
  async writeFile(path) { throw fsError('EROFS', 'open', path); }
  async mkdir(path) { throw fsError('EROFS', 'mkdir', path); }
  async rm(path) { throw fsError('EROFS', 'rm', path); }
}

// Bytes of a .tar or .zip (by name, else by sniffing) -> SeedFs.
export async function seedFrom(name, bytes) {
  const zip = /\.zip$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  const entries = zip ? await unpackZip(bytes) : unpackTar(bytes);
  if (!entries.length) throw new Error(`${name} has no files`);
  return new SeedFs(entries, name);
}
