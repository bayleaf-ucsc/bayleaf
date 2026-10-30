// 9P2000 for Pouch: the protocol wherever a namespace crosses a boundary.
//
//   codec    encode(msg) -> Uint8Array, decode(bytes) -> msg (one message each)
//   serve    export any file server (usually a Namespace subtree) on a port
//   Client   speak 9P over a port; NinepFs mounts the far side as a file server
//
// Why plain 9P2000 and not 9P2000.L: Pouch's stores have names, sizes, a
// directory bit and a modification time, nothing more. 9P2000 has 13 small
// request types that cover exactly that (walk, open, create, read, write,
// clunk, remove, stat, wstat), with directory reads as packed stat records.
// 9P2000.L adds Linux attributes (uid/gid numbers, getattr masks, xattrs,
// locks, renameat) that we would have to invent values for. No auth: the
// capability is the port itself (whoever holds it sees what was exported).
//
// Transport: a MessagePort-shaped object (postMessage, onmessage). Each
// message is one ArrayBuffer, transferred, still framed with its size[4]
// header so the same bytes could travel over a WebSocket or sit in a file.
//
// Consistency is close-to-open: a fid opened for writing collects its writes
// and the server commits the whole file at clunk, through the commit hook
// (Pouch serializes writes per path and records them for Diff and Undo there).

import { BaseFs, codeOf, join, normalize } from './namespace.js';

export const VERSION = '9P2000';
export const NOTAG = 0xffff, NOFID = 0xffffffff;
export const DMDIR = 0x80000000;
export const QTDIR = 0x80, QTFILE = 0;
export const OREAD = 0, OWRITE = 1, ORDWR = 2, OEXEC = 3, OTRUNC = 0x10, ORCLOSE = 0x40;
const HEADER = 7; // size[4] type[1] tag[2]
const IOHDR = 24; // a Rread/Twrite header and then some, the standard iounit slack

// Message types and their fields, in wire order. Types: 1 2 4 8 (little-endian
// integers), s (string: len[2] utf8), q (qid: type[1] vers[4] path[8]),
// S (stat record, len[2] prefixed), d (data: count[4] bytes), W (wnames:
// n[2] s*), Q (qids: n[2] q*).
const T = {
  Tversion: [100, 'msize:4 version:s'], Rversion: [101, 'msize:4 version:s'],
  Tauth: [102, 'afid:4 uname:s aname:s'], Rauth: [103, 'aqid:q'],
  Tattach: [104, 'fid:4 afid:4 uname:s aname:s'], Rattach: [105, 'qid:q'],
  Rerror: [107, 'ename:s'],
  Tflush: [108, 'oldtag:2'], Rflush: [109, ''],
  Twalk: [110, 'fid:4 newfid:4 wnames:W'], Rwalk: [111, 'qids:Q'],
  Topen: [112, 'fid:4 mode:1'], Ropen: [113, 'qid:q iounit:4'],
  Tcreate: [114, 'fid:4 name:s perm:4 mode:1'], Rcreate: [115, 'qid:q iounit:4'],
  Tread: [116, 'fid:4 offset:8 count:4'], Rread: [117, 'data:d'],
  Twrite: [118, 'fid:4 offset:8 data:d'], Rwrite: [119, 'count:4'],
  Tclunk: [120, 'fid:4'], Rclunk: [121, ''],
  Tremove: [122, 'fid:4'], Rremove: [123, ''],
  Tstat: [124, 'fid:4'], Rstat: [125, 'stat:S'],
  Twstat: [126, 'fid:4 stat:S'], Rwstat: [127, ''],
};
const NAMES = Object.fromEntries(Object.entries(T).map(([n, [code]]) => [code, n]));
const FIELDS = Object.fromEntries(Object.entries(T).map(([n, [, f]]) => [n, f ? f.split(' ').map((x) => x.split(':')) : []]));

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Codec ─────────────────────────────────────────────────────────────
class Writer {
  constructor() { this.buf = new Uint8Array(256); this.n = 0; }
  room(k) { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf); this.buf = b; } }
  int(v, w) {
    this.room(w);
    const d = new DataView(this.buf.buffer);
    if (w === 1) d.setUint8(this.n, v); else if (w === 2) d.setUint16(this.n, v, true); else if (w === 4) d.setUint32(this.n, v >>> 0, true);
    else d.setBigUint64(this.n, BigInt(v), true);
    this.n += w;
  }
  bytes(b) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length; }
  str(s) { const b = enc.encode(s ?? ''); this.int(b.length, 2); this.bytes(b); }
  qid(q) { this.int(q.type, 1); this.int(q.version ?? 0, 4); this.int(q.path, 8); }
  stat(st) {
    const w = new Writer();
    w.int(st.type ?? 0, 2); w.int(st.dev ?? 0, 4); w.qid(st.qid); w.int(st.mode, 4);
    w.int(st.atime ?? 0, 4); w.int(st.mtime ?? 0, 4); w.int(st.length ?? 0, 8);
    w.str(st.name); w.str(st.uid ?? 'pouch'); w.str(st.gid ?? 'pouch'); w.str(st.muid ?? '');
    this.int(w.n, 2); this.bytes(w.buf.subarray(0, w.n));
  }
}
class Reader {
  constructor(b) { this.b = b; this.d = new DataView(b.buffer, b.byteOffset, b.byteLength); this.n = 0; }
  need(k) { if (this.n + k > this.b.length) throw new Error('9P: message too short'); }
  int(w) {
    this.need(w);
    const v = w === 1 ? this.d.getUint8(this.n) : w === 2 ? this.d.getUint16(this.n, true) : w === 4 ? this.d.getUint32(this.n, true) : Number(this.d.getBigUint64(this.n, true));
    this.n += w; return v;
  }
  bytes(k) { this.need(k); const b = this.b.slice(this.n, this.n + k); this.n += k; return b; }
  str() { return dec.decode(this.bytes(this.int(2))); }
  qid() { return { type: this.int(1), version: this.int(4), path: this.int(8) }; }
  stat() {
    const size = this.int(2), end = this.n + size;
    const st = { type: this.int(2), dev: this.int(4), qid: this.qid(), mode: this.int(4), atime: this.int(4), mtime: this.int(4),
      length: this.int(8), name: this.str(), uid: this.str(), gid: this.str(), muid: this.str() };
    this.n = end;
    return st;
  }
}

export function encode(msg) {
  const fields = FIELDS[msg.type];
  if (!fields) throw new Error(`9P: unknown message type ${msg.type}`);
  const w = new Writer();
  w.int(0, 4); w.int(T[msg.type][0], 1); w.int(msg.tag ?? NOTAG, 2);
  for (const [name, kind] of fields) {
    const v = msg[name];
    if (kind === 's') w.str(v);
    else if (kind === 'q') w.qid(v);
    else if (kind === 'S') { const r = new Writer(); r.stat(v); w.int(r.n, 2); w.bytes(r.buf.subarray(0, r.n)); } // stat[n]
    else if (kind === 'd') { w.int(v.length, 4); w.bytes(v); }
    else if (kind === 'W') { w.int(v.length, 2); for (const s of v) w.str(s); }
    else if (kind === 'Q') { w.int(v.length, 2); for (const q of v) w.qid(q); }
    else w.int(v ?? 0, Number(kind));
  }
  new DataView(w.buf.buffer).setUint32(0, w.n, true);
  return w.buf.slice(0, w.n);
}

export function decode(bytes) {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const size = r.int(4);
  if (size !== r.b.length) throw new Error(`9P: size field ${size} but ${r.b.length} bytes`);
  const type = NAMES[r.int(1)];
  if (!type) throw new Error('9P: unknown message type');
  const msg = { type, tag: r.int(2) };
  for (const [name, kind] of FIELDS[type]) {
    if (kind === 's') msg[name] = r.str();
    else if (kind === 'q') msg[name] = r.qid();
    else if (kind === 'S') { r.int(2); msg[name] = r.stat(); } // stat[n]: n[2] then the record (which has its own size)
    else if (kind === 'd') msg[name] = r.bytes(r.int(4));
    else if (kind === 'W') msg[name] = Array.from({ length: r.int(2) }, () => r.str());
    else if (kind === 'Q') msg[name] = Array.from({ length: r.int(2) }, () => r.qid());
    else msg[name] = r.int(Number(kind));
  }
  return msg;
}

// Packed stat records, as a directory read returns them.
export function packStats(stats) { const w = new Writer(); for (const s of stats) w.stat(s); return w.buf.slice(0, w.n); }
export function unpackStats(bytes) { const r = new Reader(bytes), out = []; while (r.n < bytes.length) out.push(r.stat()); return out; }

// ── Shared helpers ────────────────────────────────────────────────────
// qid.path: a stable 53-bit number per path (FNV-1a), good enough to tell
// files apart within one connection.
function qpath(p) {
  let h = 0xcbf29ce484222325n;
  for (const b of enc.encode(p)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0x1fffffffffffffn; }
  return Number(h);
}
const qidOf = (p, st) => ({ type: st.isDirectory ? QTDIR : QTFILE, version: Math.floor((+st.mtime || 0) / 1000) >>> 0, path: qpath(p) });
function statOf(p, st) {
  const ro = (st.mode ?? 0o644) & 0o222 ? 0 : 1;
  return { qid: qidOf(p, st), mode: ((st.isDirectory ? DMDIR | 0o755 : 0o644) & ~(ro ? 0o222 : 0)) >>> 0, atime: 0,
    mtime: Math.floor((+st.mtime || 0) / 1000) >>> 0, length: st.isDirectory ? 0 : st.size ?? 0, name: p === '/' ? '/' : p.split('/').pop() };
}
const errno = (e) => codeOf(e) ?? 'EIO';
// A Rerror string: the errno first so the client can rebuild a Node-style error.
const ename = (e) => { const m = String(e?.message ?? e); return /^E[A-Z]+:/.test(m) ? m : `${errno(e)}: ${m}`; };

// ── Server ────────────────────────────────────────────────────────────
// serve(port, fs, opts) answers 9P on port with paths inside fs. opts:
//   root      the subtree exported (default '/'): the client's "/" is root
//   msize     the largest message we accept (default 128 KiB)
//   commit(path, bytes|null, op) -> Promise   where writes and removes land
//             (default: fs.writeFile / fs.rm); op is 'write' | 'remove';
//             path is the full path in fs, not the client's
//   onCommit(path, op)                        after each landed change (full path)
// Returns { close(), flushAll(reason) }: flushAll answers every request in
// flight with Rerror and refuses new ones (Stop), close() also drops fids.
export function serve(port, fs, { root = '/', msize: max = 128 << 10, commit, onCommit } = {}) {
  const fids = new Map(); // fid -> { path, open?, data?, dirty?, dir? }
  const live = new Map(); // tag -> { flushed }
  let msize = max, stopped = null;
  const full = (p) => join(root, p);
  const write = commit ?? ((p, b, op) => (op === 'remove' ? fs.rm(p) : fs.writeFile(p, b)));
  const land = async (p, b, op) => { await write(full(p), b, op); onCommit?.(full(p), op); };
  const send = (m) => { const b = encode(m); port.postMessage(b.buffer, [b.buffer]); };
  const err = (code, text) => Object.assign(new Error(`${code}: ${text}`), { code });

  async function handle(m) {
    const fid = (n = m.fid) => { const f = fids.get(n); if (!f) throw err('EBADF', 'unknown fid'); return f; };
    switch (m.type) {
      case 'Tversion': {
        msize = Math.min(max, m.msize);
        fids.clear();
        return { type: 'Rversion', msize, version: m.version.startsWith('9P2000') ? VERSION : 'unknown' };
      }
      case 'Tauth': throw err('EACCES', 'no authentication required');
      case 'Tattach': {
        if (fids.has(m.fid)) throw err('EBADF', 'fid in use');
        const st = await fs.stat(full('/'));
        fids.set(m.fid, { path: '/' });
        return { type: 'Rattach', qid: qidOf('/', st) };
      }
      case 'Tflush': {
        const t = live.get(m.oldtag);
        if (t) t.flushed = true;
        return { type: 'Rflush' };
      }
      case 'Twalk': {
        const f = fid();
        if (f.open) throw err('EBADF', 'walk from an open fid');
        if (m.newfid !== m.fid && fids.has(m.newfid)) throw err('EBADF', 'newfid in use');
        let p = f.path;
        const qids = [];
        for (const name of m.wnames) {
          if (name.includes('/')) throw err('EINVAL', 'name contains /');
          const next = name === '..' ? (p === '/' ? '/' : normalize(p + '/..')) : join(p, name);
          const st = await fs.stat(full(next)).catch(() => null);
          if (!st) break;
          qids.push(qidOf(next, st)); p = next;
        }
        if (m.wnames.length && !qids.length) throw err('ENOENT', `no such file or directory, walk '${join(f.path, m.wnames[0])}'`);
        if (qids.length === m.wnames.length) fids.set(m.newfid, { path: p });
        return { type: 'Rwalk', qids };
      }
      case 'Topen': case 'Tcreate': {
        const f = fid();
        if (f.open) throw err('EBADF', 'fid already open');
        let p = f.path, st;
        if (m.type === 'Tcreate') {
          if (!m.name || m.name.includes('/') || m.name === '.' || m.name === '..') throw err('EINVAL', 'bad name');
          p = join(f.path, m.name);
          if (await fs.stat(full(p)).then(() => true, () => false)) throw err('EEXIST', `file already exists, create '${p}'`);
          f.path = p;
          if (m.perm & DMDIR) await fs.mkdir(full(p));
          else {
            // The new file lands at clunk with whatever was written (close-to-open).
            Object.assign(f, { open: true, mode: m.mode & 3, dir: false, data: new Uint8Array(), dirty: true, rclose: !!(m.mode & ORCLOSE) });
            return { type: 'Rcreate', qid: { type: QTFILE, version: 0, path: qpath(p) }, iounit: msize - IOHDR };
          }
        }
        st = await fs.stat(full(p));
        const mode = m.mode & 3;
        if (st.isDirectory && mode !== OREAD) throw err('EISDIR', `illegal operation on a directory, open '${p}'`);
        Object.assign(f, { open: true, mode, dir: st.isDirectory, rclose: !!(m.mode & ORCLOSE) });
        if (!st.isDirectory && mode !== OREAD && mode !== OEXEC) {
          f.data = m.mode & OTRUNC || m.type === 'Tcreate' ? new Uint8Array() : await fs.readFileBuffer(full(p));
          if (m.mode & OTRUNC) f.dirty = true;
        }
        return { type: m.type === 'Tcreate' ? 'Rcreate' : 'Ropen', qid: qidOf(p, st), iounit: msize - IOHDR };
      }
      case 'Tread': {
        const f = fid();
        if (!f.open || f.mode === OWRITE) throw err('EBADF', 'fid not open for reading');
        const count = Math.min(m.count, msize - IOHDR);
        if (f.dir) {
          // Directory reads return whole stat records; offset 0 restarts.
          if (m.offset === 0 || !f.entries) {
            const ds = await fs.readdirWithFileTypes(full(f.path));
            f.entries = await Promise.all(ds.map(async (d) => {
              const p = join(f.path, d.name);
              const st = await fs.stat(full(p)).catch(() => ({ isDirectory: d.isDirectory, isFile: d.isFile, size: 0, mtime: 0 }));
              return packStats([statOf(p, st)]);
            }));
            f.next = 0; f.at = 0;
          }
          if (m.offset !== f.at) throw err('EINVAL', 'bad offset in directory read');
          const out = [];
          let n = 0;
          while (f.next < f.entries.length && n + f.entries[f.next].length <= count) { out.push(f.entries[f.next]); n += f.entries[f.next++].length; }
          f.at += n;
          const data = new Uint8Array(n); let o = 0;
          for (const b of out) { data.set(b, o); o += b.length; }
          return { type: 'Rread', data };
        }
        f.data ??= await fs.readFileBuffer(full(f.path));
        return { type: 'Rread', data: f.data.slice(m.offset, m.offset + count) };
      }
      case 'Twrite': {
        const f = fid();
        if (!f.open || (f.mode !== OWRITE && f.mode !== ORDWR) || f.dir) throw err('EBADF', 'fid not open for writing');
        const end = m.offset + m.data.length;
        if (end > f.data.length) { const b = new Uint8Array(end); b.set(f.data); f.data = b; }
        f.data.set(m.data, m.offset);
        f.dirty = true;
        return { type: 'Rwrite', count: m.data.length };
      }
      case 'Tclunk': case 'Tremove': {
        const f = fid();
        fids.delete(m.fid); // the fid is gone whatever happens next (9P rule)
        if (m.type === 'Tremove' || f.rclose) await land(f.path, null, 'remove');
        else if (f.dirty) await land(f.path, f.data, 'write');
        return { type: m.type === 'Tremove' ? 'Rremove' : 'Rclunk' };
      }
      case 'Tstat': {
        const f = fid();
        return { type: 'Rstat', stat: statOf(f.path, await fs.stat(full(f.path))) };
      }
      case 'Twstat': {
        // Only what Pouch's stores can do: truncate (length) and rename within a folder.
        const f = fid(), s = m.stat;
        if (s.length !== 0xffffffffffffffff && Number.isSafeInteger(s.length) && s.length >= 0 && s.length < 2 ** 52) {
          const b = await fs.readFileBuffer(full(f.path)).catch(() => new Uint8Array());
          const out = new Uint8Array(s.length); out.set(b.subarray(0, s.length));
          await land(f.path, out, 'write');
        }
        if (s.name && s.name !== f.path.split('/').pop()) {
          const to = join(normalize(f.path + '/..'), s.name);
          await fs.mv(full(f.path), full(to)); onCommit?.(full(f.path), 'remove'); onCommit?.(full(to), 'write');
          f.path = to;
        }
        return { type: 'Rwstat' };
      }
      default: throw err('ENOTSUP', `${m.type} not supported`);
    }
  }

  port.onmessage = async (e) => {
    let m;
    try { m = decode(new Uint8Array(e.data ?? e)); } catch (x) { return send({ type: 'Rerror', tag: NOTAG, ename: `EINVAL: ${x.message}` }); }
    if (stopped) return send({ type: 'Rerror', tag: m.tag, ename: stopped });
    const t = { flushed: false };
    if (m.type !== 'Tflush') live.set(m.tag, t);
    let r;
    try { r = await handle(m); } catch (x) { r = { type: 'Rerror', ename: ename(x) }; }
    live.delete(m.tag);
    if (t.flushed) return; // a flushed request gets no answer (its Rflush went first)
    if (stopped && m.type !== 'Tflush') r = { type: 'Rerror', ename: stopped };
    send({ ...r, tag: m.tag });
  };
  return {
    // Stop from the server side: every request in flight is answered now with
    // Rerror (a write already handed to commit still lands; nothing new starts).
    flushAll(reason = 'EINTR: interrupted (stopped)') {
      stopped = reason;
      for (const [tag, t] of live) { t.flushed = true; send({ type: 'Rerror', tag, ename: reason }); }
      live.clear();
    },
    close() { stopped ??= 'EPIPE: connection closed'; fids.clear(); port.onmessage = null; port.close?.(); },
  };
}

// ── Client ────────────────────────────────────────────────────────────
// One connection: tags, fids, msize. call() resolves with the R-message or
// rejects with an Error whose message is the Rerror string (code first).
export class Client {
  constructor(port, { msize = 128 << 10 } = {}) {
    this.port = port; this.msize = msize; this.tags = new Map(); this.nextTag = 0; this.nextFid = 1; this.freeFids = [];
    port.onmessage = (e) => {
      let m;
      try { m = decode(new Uint8Array(e.data ?? e)); } catch (x) { return this.fail(new Error(x.message)); }
      const w = this.tags.get(m.tag);
      if (!w) return; // an answer to a flushed request
      this.tags.delete(m.tag);
      if (m.type === 'Rerror') w.reject(Object.assign(new Error(m.ename), { code: codeOf({ message: m.ename }) }));
      else w.resolve(m);
    };
  }
  fail(e) { for (const w of this.tags.values()) w.reject(e); this.tags.clear(); }
  tag() { for (;;) { const t = this.nextTag; this.nextTag = (this.nextTag + 1) % NOTAG; if (!this.tags.has(t)) return t; } }
  fid() { return this.freeFids.pop() ?? this.nextFid++; }
  call(msg, { signal } = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error('EPIPE: 9P connection closed'), { code: 'EPIPE' }));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('EINTR: interrupted (stopped)'), { code: 'EINTR' }));
    const tag = msg.type === 'Tversion' ? NOTAG : this.tag();
    return new Promise((resolve, reject) => {
      this.tags.set(tag, { resolve, reject });
      const b = encode({ ...msg, tag });
      this.port.postMessage(b.buffer, [b.buffer]);
      // Stop: send Tflush, give up on the answer (9P: the server may still finish it).
      signal?.addEventListener('abort', () => {
        if (!this.tags.has(tag)) return;
        this.tags.delete(tag);
        const f = encode({ type: 'Tflush', tag: this.tag(), oldtag: tag });
        this.port.postMessage(f.buffer, [f.buffer]);
        reject(Object.assign(new Error('EINTR: interrupted (stopped)'), { code: 'EINTR' }));
      }, { once: true });
    });
  }
  async connect(aname = '') {
    const v = await this.call({ type: 'Tversion', msize: this.msize, version: VERSION });
    if (v.version !== VERSION) throw new Error(`9P: server speaks ${v.version}`);
    this.msize = v.msize;
    this.root = this.fid();
    await this.call({ type: 'Tattach', fid: this.root, afid: NOFID, uname: 'pouch', aname });
    return this;
  }
  close() { this.closed = true; this.fail(Object.assign(new Error('EPIPE: 9P connection closed'), { code: 'EPIPE' })); this.port.onmessage = null; this.port.close?.(); }

  // Walk a fresh fid to path (from the attach root); throws ENOENT if any step is missing.
  async walk(path, signal) {
    const names = normalize(path).split('/').filter(Boolean);
    const fid = this.fid();
    try {
      const r = await this.call({ type: 'Twalk', fid: this.root, newfid: fid, wnames: names }, { signal });
      if (r.qids.length !== names.length) throw Object.assign(new Error(`ENOENT: no such file or directory, walk '${normalize(path)}'`), { code: 'ENOENT' });
      return fid;
    } catch (e) { this.freeFids.push(fid); throw e; }
  }
  async clunk(fid) { try { await this.call({ type: 'Tclunk', fid }); } finally { this.freeFids.push(fid); } }
  async readAll(fid, signal) {
    const chunks = []; let off = 0;
    for (;;) {
      const r = await this.call({ type: 'Tread', fid, offset: off, count: this.msize - IOHDR }, { signal });
      if (!r.data.length) break;
      chunks.push(r.data); off += r.data.length;
    }
    const out = new Uint8Array(off); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  async writeAll(fid, bytes, signal) {
    const step = this.msize - IOHDR;
    for (let off = 0; off < bytes.length; off += step) await this.call({ type: 'Twrite', fid, offset: off, data: bytes.subarray(off, off + step) }, { signal });
  }
}

// The far side of a 9P connection as a Pouch file server, so a Namespace can
// mount it like any local store. Each method is a short fid conversation:
// walk, (open|create), read/write, clunk.
export class NinepFs extends BaseFs {
  constructor(client, { signal } = {}) { super(); this.c = client; this.signal = signal; }
  async with(path, fn) {
    const fid = await this.c.walk(path, this.signal);
    try { return await fn(fid); } finally { await this.c.clunk(fid).catch(() => {}); }
  }
  async stat(path) {
    const st = await this.with(path, async (fid) => (await this.c.call({ type: 'Tstat', fid }, { signal: this.signal })).stat);
    const dir = !!(st.mode & DMDIR);
    return { isFile: !dir, isDirectory: dir, isSymbolicLink: false, mode: st.mode & 0o777, size: st.length, mtime: new Date(st.mtime * 1000) };
  }
  async readFileBuffer(path) {
    return this.with(path, async (fid) => {
      const o = await this.c.call({ type: 'Topen', fid, mode: OREAD }, { signal: this.signal });
      if (o.qid.type & QTDIR) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: 'EISDIR' });
      return this.c.readAll(fid, this.signal);
    });
  }
  async readdirWithFileTypes(path) {
    return this.with(path, async (fid) => {
      const o = await this.c.call({ type: 'Topen', fid, mode: OREAD }, { signal: this.signal });
      if (!(o.qid.type & QTDIR)) throw Object.assign(new Error(`ENOTDIR: not a directory, scandir '${path}'`), { code: 'ENOTDIR' });
      return unpackStats(await this.c.readAll(fid, this.signal)).map((s) => ({ name: s.name, isFile: !(s.mode & DMDIR), isDirectory: !!(s.mode & DMDIR), isSymbolicLink: false }));
    });
  }
  async readdir(path) { return (await this.readdirWithFileTypes(path)).map((d) => d.name); }
  async writeFile(path, content) {
    const bytes = typeof content === 'string' ? enc.encode(content) : content;
    const p = normalize(path), name = p.split('/').pop();
    const fid = await this.c.walk(p, this.signal).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (fid != null) {
      try { await this.c.call({ type: 'Topen', fid, mode: OWRITE | OTRUNC }, { signal: this.signal }); await this.c.writeAll(fid, bytes, this.signal); }
      finally { await this.c.clunk(fid); }
      return;
    }
    // Errors from the commit arrive at clunk (close-to-open), so that one is awaited.
    const dfid = await this.c.walk(normalize(p + '/..'), this.signal);
    let created = false;
    try {
      await this.c.call({ type: 'Tcreate', fid: dfid, name, perm: 0o644, mode: OWRITE }, { signal: this.signal });
      created = true;
      await this.c.writeAll(dfid, bytes, this.signal);
    } finally { if (created) await this.c.clunk(dfid); else await this.c.clunk(dfid).catch(() => {}); }
  }
  async mkdir(path, options) {
    const p = normalize(path);
    if (options?.recursive) {
      if (await this.exists(p)) return;
      if (p !== '/') await this.mkdir(normalize(p + '/..'), options);
    }
    await this.with(normalize(p + '/..'), (dfid) => this.c.call({ type: 'Tcreate', fid: dfid, name: p.split('/').pop(), perm: DMDIR | 0o755, mode: OREAD }, { signal: this.signal }));
  }
  async rm(path, options) {
    const st = await this.stat(path).catch((e) => { if (options?.force && e.code === 'ENOENT') return null; throw e; });
    if (!st) return;
    if (st.isDirectory) {
      const kids = await this.readdir(path);
      if (kids.length && !options?.recursive) throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rm '${path}'`), { code: 'ENOTEMPTY' });
      for (const k of kids) await this.rm(join(path, k), options);
    }
    const fid = await this.c.walk(path, this.signal);
    try { await this.c.call({ type: 'Tremove', fid }, { signal: this.signal }); } finally { this.c.freeFids.push(fid); }
  }
}
