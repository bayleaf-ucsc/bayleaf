// Plan 9 namespaces for Pouch: a per-task mount table over small file servers.
//
// A file server is anything with the path-based methods below (OPFS and picked
// folders through HandleFs, IndexedDB /pouch through IdbFs, just-bash's
// InMemoryFs, a read-only seed archive, the synthetic /task tree, a 9P client,
// or another Namespace). The 9P verbs map onto them like this:
//
//   walk + stat         stat(path)           -> { isFile, isDirectory, size, mtime, mode }
//   walk + open + read  readFileBuffer(path) -> Uint8Array (a directory read is readdir)
//   create / write      writeFile(path, bytes), mkdir(path, { recursive })
//   remove              rm(path, { recursive, force })
//   read on a directory readdir(path) / readdirWithFileTypes(path)
//
// Why paths and not fids here: every store Pouch has is keyed by path (OPFS
// handles, IndexedDB keys), so a fid layer in the hot path would only add
// lookups. Fids live where they mean something: at a 9P boundary (src/ns/9p.js).
//
// A Namespace is itself a file server, so one task's view can be mounted into
// another's, or exported over 9P, without a second kind of object.
//
// bind semantics (Plan 9's bind(2) and mount(2)):
//   flag 'replace'  the mount point shows only the new tree
//   flag 'before'   the new tree is searched first (a union directory)
//   flag 'after'    the new tree is searched last
// Lookup is first match across the union; a directory lists the union of its
// members; a create lands in the first writable member.
//
// Two deliberate departures from Plan 9, both for the seed-layer use case
// (/work over a read-only starter archive):
// - Unions are deep (like Linux overlayfs): /work/src merges src from every
//   member, so adding one file to src does not hide the seed's other files.
//   In Plan 9 only the mount point itself is a union.
// - Writing a file that only a read-only member has copies it up: the write
//   lands in the first writable member. Removing one records a whiteout in
//   the mount (persisted by the owner, see whiteouts()), which hides that path
//   and everything below it in read-only members. Without a whiteout store,
//   removing a read-only member's file is refused with EROFS.

const enc = new TextEncoder();
const dec = new TextDecoder();

// just-bash expects Node-style errors ("ENOENT: ...") and sometimes reads .code.
export function fsError(code, op, path, why) {
  const text = why ?? { ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory',
    EISDIR: 'illegal operation on a directory', EROFS: 'read-only file system', ENOTSUP: 'operation not supported',
    ENOTEMPTY: 'directory not empty', EINVAL: 'invalid argument', EBUSY: 'resource busy' }[code];
  return Object.assign(new Error(`${code}: ${text}, ${op} '${path}'`), { code });
}
export const codeOf = (e) => e?.code ?? String(e?.message ?? '').match(/^(E[A-Z]+)/)?.[1];

export function normalize(path) {
  const out = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}
export const parts = (path) => normalize(path).split('/').filter(Boolean);
export const join = (a, b) => normalize(a + '/' + b);
const resolvePath = (base, path) => normalize(path.startsWith('/') ? path : base + '/' + path);
export const toBytes = (content, encoding) => typeof content !== 'string' ? content
  : encoding === 'base64' ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : enc.encode(content);
export const encodingOf = (o) => (typeof o === 'string' ? o : o?.encoding);
const dirStat = { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(0) };
// Is `p` equal to `root` or inside it?
export const within = (p, root) => root === '/' || p === root || p.startsWith(root + '/');

// Methods every file server shares, written once in terms of the primitive ones.
export class BaseFs {
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

// A missing path is the only error that moves lookup on to the next member.
const missing = (e) => ['ENOENT', 'ENOTDIR'].includes(codeOf(e));

export class Namespace extends BaseFs {
  constructor() {
    super();
    // mount point -> [{ fs, root, readOnly, label }], in search order
    this.table = new Map();
    // mount point -> { paths: Set of paths relative to the point, save() }
    this.wh = new Map();
  }

  // mount(2): attach a file server at `point`. root is the path inside fs.
  mount(fs, point, { flag = 'replace', readOnly = false, root = '/', label = '' } = {}) {
    point = normalize(point);
    const entry = { fs, root: normalize(root), readOnly, label };
    const now = flag === 'replace' ? [] : this.table.get(point) ?? this.inherited(point);
    this.table.set(point, flag === 'after' ? [...now, entry] : [entry, ...now]);
    return this;
  }
  // bind(2): make `point` show what `path` shows now (its whole union).
  bind(path, point, { flag = 'replace', readOnly = false } = {}) {
    const { entries, rel } = this.layers(path);
    const copy = entries.map((e) => ({ ...e, root: join(e.root, rel), readOnly: e.readOnly || readOnly }));
    point = normalize(point);
    const now = flag === 'replace' ? [] : this.table.get(point) ?? this.inherited(point);
    this.table.set(point, flag === 'after' ? [...now, ...copy] : [...copy, ...now]);
    return this;
  }
  // Without fs: drop the whole mount point. With fs: drop that member only.
  unmount(point, fs) {
    point = normalize(point);
    const left = fs ? (this.table.get(point) ?? []).filter((e) => e.fs !== fs) : [];
    if (left.length) this.table.set(point, left); else { this.table.delete(point); this.wh.delete(point); }
  }
  // rfork(RFNAMEG): a copy of the table; later binds in either do not affect the other.
  clone() {
    const ns = new Namespace();
    for (const [p, l] of this.table) ns.table.set(p, [...l]);
    for (const [p, w] of this.wh) ns.wh.set(p, w);
    return ns;
  }
  // A union with whiteouts: removals of read-only members' files are remembered
  // in `paths` (relative to the point) and save() is called after each change.
  whiteouts(point, paths = [], save = () => {}) { this.wh.set(normalize(point), { paths: new Set(paths), save }); }

  // What a union mount point would start from if it is not in the table yet:
  // the members of the enclosing mount at that path (so 'before' adds to it).
  inherited(point) {
    if (!this.table.size) return [];
    const { entries, rel } = this.layers(point);
    return entries.map((e) => ({ ...e, root: join(e.root, rel) }));
  }
  // The longest mount point covering `path`, its members and the rest of the path.
  layers(path) {
    const p = normalize(path);
    for (let at = p; ; at = normalize(at + '/..')) {
      const entries = this.table.get(at);
      if (entries) return { point: at, entries, rel: at === '/' ? p : p.slice(at.length) || '/' };
      if (at === '/') return { point: '/', entries: [], rel: p };
    }
  }
  // Mount points directly below `path` (they appear in its listing).
  childMounts(path) {
    const p = normalize(path), out = new Set();
    for (const m of this.table.keys()) {
      if (m === p || !within(m, p)) continue;
      out.add(m.slice(p === '/' ? 1 : p.length + 1).split('/')[0]);
    }
    return out;
  }
  hidden(point, e, rel) {
    const w = this.wh.get(point);
    if (!w || !e.readOnly || !w.paths.size) return false;
    for (let r = rel; ; r = normalize(r + '/..')) { if (w.paths.has(r)) return true; if (r === '/') return false; }
  }
  members(path) {
    const { point, entries, rel } = this.layers(path);
    return { point, rel, list: entries.filter((e) => !this.hidden(point, e, rel)).map((e) => ({ e, p: join(e.root, rel) })) };
  }

  // ── The file-server interface, resolved through the table ──────────
  async stat(path) {
    for (const { e, p } of this.members(path).list) {
      try { return await e.fs.stat(p); } catch (err) { if (!missing(err)) throw err; }
    }
    if (this.childMounts(path).size || this.table.has(normalize(path))) return { ...dirStat };
    throw fsError('ENOENT', 'stat', path);
  }
  async readFileBuffer(path) {
    for (const { e, p } of this.members(path).list) {
      try { return await e.fs.readFileBuffer(p); } catch (err) { if (!missing(err)) throw err; }
    }
    if (this.childMounts(path).size) throw fsError('EISDIR', 'read', path);
    throw fsError('ENOENT', 'open', path);
  }
  async readdirWithFileTypes(path) {
    const { point, rel, list } = this.members(path);
    const seen = new Map();
    let found = false, err0 = null;
    for (const { e, p } of list) {
      let items;
      try {
        items = e.fs.readdirWithFileTypes ? await e.fs.readdirWithFileTypes(p)
          : await Promise.all((await e.fs.readdir(p)).map(async (name) => { const s = await e.fs.stat(join(p, name)); return { name, isFile: s.isFile, isDirectory: s.isDirectory }; }));
      } catch (err) { if (!missing(err)) throw err; err0 ??= err; continue; }
      found = true;
      for (const d of items) {
        if (seen.has(d.name) || this.hidden(point, e, join(rel, d.name))) continue;
        seen.set(d.name, { name: d.name, isFile: !!d.isFile, isDirectory: !!d.isDirectory, isSymbolicLink: false });
      }
    }
    for (const name of this.childMounts(path)) seen.set(name, { name, isFile: false, isDirectory: true, isSymbolicLink: false });
    if (!found && !seen.size && !this.table.has(normalize(path))) throw codeOf(err0) === 'ENOTDIR' ? err0 : fsError('ENOENT', 'scandir', path);
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  async readdir(path) { return (await this.readdirWithFileTypes(path)).map((d) => d.name); }

  // Where a create or write lands: the member that has the file if it is
  // writable, otherwise the first writable member (copy-up).
  async target(path, op) {
    const { point, rel, list } = this.members(path);
    const all = this.layers(path).entries;
    for (const { e, p } of list) {
      if (e.readOnly) continue;
      if (await e.fs.stat(p).then(() => true, () => false)) return { point, rel, e, p };
    }
    const e = all.find((x) => !x.readOnly);
    if (!e) throw fsError('EROFS', op, path);
    return { point, rel, e, p: join(e.root, rel) };
  }
  // Make the parent folder exist in the target member if it exists in the union.
  async parentIn(t, path, op) {
    const parent = normalize(path + '/..');
    if (parent === normalize(path)) return;
    const st = await this.stat(parent).catch(() => null);
    if (!st) throw fsError('ENOENT', op, path);
    if (!st.isDirectory) throw fsError('ENOTDIR', op, path);
    const pp = normalize(t.p + '/..');
    if (pp !== t.p && !(await t.e.fs.stat(pp).then(() => true, () => false))) await t.e.fs.mkdir(pp, { recursive: true });
  }
  unwhite(point, rel) {
    const w = this.wh.get(point);
    if (w?.paths.delete(rel)) { w.save([...w.paths]); return true; }
    return false;
  }
  // The common case, one member and no whiteouts: hand the call straight on,
  // so a plain mount costs one table lookup and keeps the store's own errors.
  single(path, op) {
    const { point, entries, rel } = this.layers(path);
    if (entries.length !== 1 || this.wh.has(point) || this.childMounts(path).size) return null;
    if (entries[0].readOnly) throw fsError('EROFS', op, path);
    return { fs: entries[0].fs, p: join(entries[0].root, rel) };
  }
  async writeFile(path, content, options) {
    const s = this.single(path, 'open');
    if (s) return s.fs.writeFile(s.p, toBytes(content, encodingOf(options)));
    if (this.childMounts(path).size) throw fsError('EISDIR', 'open', path);
    const t = await this.target(path, 'open');
    await this.parentIn(t, path, 'open');
    await t.e.fs.writeFile(t.p, toBytes(content, encodingOf(options)));
    this.unwhite(t.point, t.rel);
  }
  async mkdir(path, options) {
    const s = this.single(path, 'mkdir');
    if (s) return s.fs.mkdir(s.p, options);
    if (await this.exists(path)) {
      if (options?.recursive) return;
      throw fsError('EEXIST', 'mkdir', path);
    }
    const t = await this.target(path, 'mkdir');
    if (!options?.recursive) await this.parentIn(t, path, 'mkdir');
    else {
      const parent = normalize(path + '/..');
      if (parent !== normalize(path)) await this.mkdir(parent, { recursive: true });
      await this.parentIn(t, path, 'mkdir');
    }
    // Recreating a whited-out folder: it starts empty (an opaque directory),
    // so the read-only members' old children stay hidden.
    const was = this.unwhite(t.point, t.rel);
    await t.e.fs.mkdir(t.p, { recursive: !!options?.recursive });
    if (was) {
      const w = this.wh.get(t.point);
      for (const e of this.layers(path).entries) if (e.readOnly) {
        for (const n of await e.fs.readdir(join(e.root, t.rel)).catch(() => [])) w.paths.add(join(t.rel, n));
      }
      w.save([...w.paths]);
    }
  }
  async rm(path, options) {
    const p0 = normalize(path);
    if (this.table.has(p0) || this.childMounts(p0).size) throw fsError('EBUSY', 'rm', path, 'a mount point cannot be removed');
    const s = this.single(path, 'rm');
    if (s) return s.fs.rm(s.p, options);
    const { point, rel, list } = this.members(path);
    const have = [];
    for (const m of list) { const st = await m.e.fs.stat(m.p).catch(() => null); if (st) have.push({ ...m, st }); }
    if (!have.length) { if (options?.force) return; throw fsError('ENOENT', 'rm', path); }
    if (have[0].st.isDirectory && !options?.recursive && (await this.readdir(path)).length) throw fsError('ENOTEMPTY', 'rm', path);
    const lower = have.filter((m) => m.e.readOnly);
    const w = this.wh.get(point);
    if (lower.length && !w) throw fsError('EROFS', 'rm', path, 'it comes from a read-only layer');
    for (const m of have) if (!m.e.readOnly) await m.e.fs.rm(m.p, { recursive: true, force: true });
    if (lower.length) { w.paths.add(rel); w.save([...w.paths]); }
  }

  // ── Description, for the trust panel, the tray and /task/<id>/ns ─────
  // One line per mount point: "/work  rw opfs, ro seed:starter.zip".
  describe({ hide = [] } = {}) {
    return [...this.table].filter(([p]) => !hide.includes(p)).sort(([a], [b]) => a.localeCompare(b))
      .map(([p, l]) => `${p}  ${l.map((e) => `${e.readOnly ? 'ro' : 'rw'} ${e.label || e.fs.constructor?.name || 'fs'}`).join(', ')}`);
  }
}

// A capability view: a new namespace holding only the named subtrees of
// `parent`, each at the same path (so recorded changes, diffs and conflict
// messages name the same paths everywhere), plus a private scratch /tmp if a
// scratch file server is given. specs: ['/work', '/pouch:ro', ...].
export function parseSpecs(specs) {
  return specs.map((s) => {
    const m = String(s).trim().match(/^(.*?)(?::(ro|rw))?$/);
    return { path: normalize(m[1]), readOnly: m[2] === 'ro' };
  });
}
export function subset(parent, specs, { scratch, emptyRoot } = {}) {
  const ns = new Namespace();
  if (emptyRoot) ns.mount(emptyRoot, '/', { readOnly: true, label: 'root' });
  for (const { path, readOnly } of parseSpecs(specs)) {
    const from = parent.layers(path).entries[0];
    ns.mount(parent, path, { root: path, readOnly, label: (from?.label || 'fs') + (readOnly && !from?.readOnly ? ' (narrowed)' : '') });
  }
  if (scratch) ns.mount(scratch, '/tmp', { label: 'scratch' });
  return ns;
}
