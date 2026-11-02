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
// (Pouch serializes writes per path and attributes them to their writer there).

import { BaseFs, codeOf, join, normalize, type FileServer, type FileStat, type FileStream } from './namespace.ts';

export const VERSION = '9P2000';
export const NOTAG = 0xffff, NOFID = 0xffffffff;
export const DMDIR = 0x80000000;
export const QTDIR = 0x80, QTFILE = 0;
export const OREAD = 0, OWRITE = 1, ORDWR = 2, OEXEC = 3, OTRUNC = 0x10, ORCLOSE = 0x40;
const HEADER = 7; // size[4] type[1] tag[2]
const IOHDR = 24; // a Rread/Twrite header and then some, the standard iounit slack

// The message shapes, keyed by type: the protocol boundary #143 plans to verify.
export interface Qid { type: number; version: number; path: number }
// A stat record. Optional fields get defaults when encoded; decoded ones are Required<NinepStat>.
export interface NinepStat {
  type?: number; dev?: number; qid: Qid; mode: number; atime?: number; mtime: number; length: number;
  name: string; uid?: string; gid?: string; muid?: string;
}
interface MessageFields {
  Tversion: { msize: number; version: string }; Rversion: { msize: number; version: string };
  Tauth: { afid: number; uname: string; aname: string }; Rauth: { aqid: Qid };
  Tattach: { fid: number; afid: number; uname: string; aname: string }; Rattach: { qid: Qid };
  Rerror: { ename: string };
  Tflush: { oldtag: number }; Rflush: {};
  Twalk: { fid: number; newfid: number; wnames: string[] }; Rwalk: { qids: Qid[] };
  Topen: { fid: number; mode: number }; Ropen: { qid: Qid; iounit: number };
  Tcreate: { fid: number; name: string; perm: number; mode: number }; Rcreate: { qid: Qid; iounit: number };
  Tread: { fid: number; offset: number; count: number }; Rread: { data: Uint8Array };
  Twrite: { fid: number; offset: number; data: Uint8Array }; Rwrite: { count: number };
  Tclunk: { fid: number }; Rclunk: {};
  Tremove: { fid: number }; Rremove: {};
  Tstat: { fid: number }; Rstat: { stat: NinepStat };
  Twstat: { fid: number; stat: NinepStat }; Rwstat: {};
}
export type MessageType = keyof MessageFields;
export type TType = Extract<MessageType, `T${string}`>;
export type RType = Extract<MessageType, `R${string}`>;
// The reply a request expects (Rerror aside): Twalk -> Rwalk.
export type ReplyOf<K extends TType> = K extends `T${infer N}` ? Extract<RType, `R${N}`> : never;
type Shaped<K extends MessageType, Tag> = { [P in K]: { type: P } & Tag & MessageFields[P] }[K];
// As decoded (tag always present) and as written (tag defaults to NOTAG).
export type Message<K extends MessageType = MessageType> = Shaped<K, { tag: number }>;
export type Untagged<K extends MessageType = MessageType> = Shaped<K, { tag?: number }>;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Codec ─────────────────────────────────────────────────────────────
// One field kind on the wire, both ways. The spec table below gives each
// message type its code and fields in wire order (an object's keys keep their
// order), and tsc checks it against MessageFields: a field missing, extra or of
// the wrong kind does not compile.
interface Kind<V> { put(w: Writer, v: V): void; get(r: Reader): V }
type Spec<F> = { readonly [N in keyof F]-?: Kind<F[N]> };
const int = (n: 1 | 2 | 4 | 8): Kind<number> => ({ put: (w, v) => w.int(v, n), get: (r) => r.int(n) });
const u8 = int(1), u16 = int(2), u32 = int(4), u64 = int(8);
const str: Kind<string> = { put: (w, v) => w.str(v), get: (r) => r.str() };                 // len[2] utf8
const qid: Kind<Qid> = { put: (w, v) => w.qid(v), get: (r) => r.qid() };                    // type[1] vers[4] path[8]
const data: Kind<Uint8Array> = { put: (w, v) => { w.int(v.length, 4); w.bytes(v); }, get: (r) => r.bytes(r.int(4)) }; // count[4] bytes
const many = <V>(k: Kind<V>): Kind<V[]> => ({ put: (w, v) => { w.int(v.length, 2); for (const x of v) k.put(w, x); }, get: (r) => Array.from({ length: r.int(2) }, () => k.get(r)) }); // n[2] then each
// stat[n]: n[2], then the record, which carries its own size[2].
const stat: Kind<NinepStat> = {
  put: (w, v) => { const r = new Writer(); r.stat(v); w.int(r.n, 2); w.bytes(r.buf.subarray(0, r.n)); },
  get: (r) => { r.int(2); return r.stat(); },
};
const SPEC: { readonly [K in MessageType]: readonly [code: number, fields: Spec<MessageFields[K]>] } = {
  Tversion: [100, { msize: u32, version: str }], Rversion: [101, { msize: u32, version: str }],
  Tauth: [102, { afid: u32, uname: str, aname: str }], Rauth: [103, { aqid: qid }],
  Tattach: [104, { fid: u32, afid: u32, uname: str, aname: str }], Rattach: [105, { qid }],
  Rerror: [107, { ename: str }],
  Tflush: [108, { oldtag: u16 }], Rflush: [109, {}],
  Twalk: [110, { fid: u32, newfid: u32, wnames: many(str) }], Rwalk: [111, { qids: many(qid) }],
  Topen: [112, { fid: u32, mode: u8 }], Ropen: [113, { qid, iounit: u32 }],
  Tcreate: [114, { fid: u32, name: str, perm: u32, mode: u8 }], Rcreate: [115, { qid, iounit: u32 }],
  Tread: [116, { fid: u32, offset: u64, count: u32 }], Rread: [117, { data }],
  Twrite: [118, { fid: u32, offset: u64, data }], Rwrite: [119, { count: u32 }],
  Tclunk: [120, { fid: u32 }], Rclunk: [121, {}],
  Tremove: [122, { fid: u32 }], Rremove: [123, {}],
  Tstat: [124, { fid: u32 }], Rstat: [125, { stat }],
  Twstat: [126, { fid: u32, stat }], Rwstat: [127, {}],
};
const keysOf = <O extends object>(o: O) => { const ks: Extract<keyof O, string>[] = []; for (const k in o) ks.push(k); return ks; };
const NAMES = new Map(keysOf(SPEC).map((type) => [SPEC[type][0], type]));
// The reply each request expects (Rerror aside), checked by the client.
const REPLY: { readonly [K in TType]: ReplyOf<K> } = {
  Tversion: 'Rversion', Tauth: 'Rauth', Tattach: 'Rattach', Tflush: 'Rflush', Twalk: 'Rwalk', Topen: 'Ropen',
  Tcreate: 'Rcreate', Tread: 'Rread', Twrite: 'Rwrite', Tclunk: 'Rclunk', Tremove: 'Rremove', Tstat: 'Rstat', Twstat: 'Rwstat',
};

function put<F>(w: Writer, spec: Spec<F>, msg: F) { for (const name in spec) spec[name].put(w, msg[name]); }
// Every field of F, though tsc sees only Partial<F>: decode's one cast completes it.
function get<F>(r: Reader, spec: Spec<F>): Partial<F> {
  const out: Partial<F> = {};
  for (const name in spec) out[name] = spec[name].get(r);
  return out;
}

class Writer {
  declare buf: Uint8Array<ArrayBuffer>; declare n: number;
  constructor() { this.buf = new Uint8Array(256); this.n = 0; }
  room(k: number) { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf); this.buf = b; } }
  int(v: number, w: number) {
    this.room(w);
    const d = new DataView(this.buf.buffer);
    if (w === 1) d.setUint8(this.n, v); else if (w === 2) d.setUint16(this.n, v, true); else if (w === 4) d.setUint32(this.n, v >>> 0, true);
    else d.setBigUint64(this.n, BigInt(v), true);
    this.n += w;
  }
  bytes(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length; }
  str(s: string | undefined) { const b = enc.encode(s ?? ''); this.int(b.length, 2); this.bytes(b); }
  qid(q: Qid) { this.int(q.type, 1); this.int(q.version ?? 0, 4); this.int(q.path, 8); }
  stat(st: NinepStat) {
    const w = new Writer();
    w.int(st.type ?? 0, 2); w.int(st.dev ?? 0, 4); w.qid(st.qid); w.int(st.mode, 4);
    w.int(st.atime ?? 0, 4); w.int(st.mtime ?? 0, 4); w.int(st.length ?? 0, 8);
    w.str(st.name); w.str(st.uid ?? 'pouch'); w.str(st.gid ?? 'pouch'); w.str(st.muid ?? '');
    this.int(w.n, 2); this.bytes(w.buf.subarray(0, w.n));
  }
}
class Reader {
  declare b: Uint8Array; declare d: DataView; declare n: number;
  constructor(b: Uint8Array) { this.b = b; this.d = new DataView(b.buffer, b.byteOffset, b.byteLength); this.n = 0; }
  need(k: number) { if (this.n + k > this.b.length) throw new Error('9P: message too short'); }
  int(w: number) {
    this.need(w);
    const v = w === 1 ? this.d.getUint8(this.n) : w === 2 ? this.d.getUint16(this.n, true) : w === 4 ? this.d.getUint32(this.n, true) : Number(this.d.getBigUint64(this.n, true));
    this.n += w; return v;
  }
  bytes(k: number) { this.need(k); const b = this.b.slice(this.n, this.n + k); this.n += k; return b; }
  str() { return dec.decode(this.bytes(this.int(2))); }
  qid(): Qid { return { type: this.int(1), version: this.int(4), path: this.int(8) }; }
  stat(): Required<NinepStat> {
    const size = this.int(2), end = this.n + size;
    const st = { type: this.int(2), dev: this.int(4), qid: this.qid(), mode: this.int(4), atime: this.int(4), mtime: this.int(4),
      length: this.int(8), name: this.str(), uid: this.str(), gid: this.str(), muid: this.str() };
    this.n = end;
    return st;
  }
}

export function encode<K extends MessageType>(msg: Untagged<K>) {
  const spec = SPEC[msg.type];
  if (!spec) throw new Error(`9P: unknown message type ${msg.type}`); // an untyped caller
  const w = new Writer();
  w.int(0, 4); w.int(spec[0], 1); w.int(msg.tag ?? NOTAG, 2);
  put(w, spec[1], msg);
  new DataView(w.buf.buffer).setUint32(0, w.n, true);
  return w.buf.slice(0, w.n);
}

export function decode(bytes: Uint8Array | ArrayBuffer): Message {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const size = r.int(4);
  if (size !== r.b.length) throw new Error(`9P: size field ${size} but ${r.b.length} bytes`);
  const type = NAMES.get(r.int(1));
  if (!type) throw new Error('9P: unknown message type');
  return { type, tag: r.int(2), ...get(r, SPEC[type][1]) } as Message; // the spec for `type` read every field
}

// Packed stat records, as a directory read returns them.
export function packStats(stats: NinepStat[]) { const w = new Writer(); for (const s of stats) w.stat(s); return w.buf.slice(0, w.n); }
export function unpackStats(bytes: Uint8Array) { const r = new Reader(bytes), out: Required<NinepStat>[] = []; while (r.n < bytes.length) out.push(r.stat()); return out; }

// ── Shared helpers ────────────────────────────────────────────────────
// qid.path: a stable 53-bit number per path (FNV-1a), good enough to tell
// files apart within one connection.
function qpath(p: string) {
  let h = 0xcbf29ce484222325n;
  for (const b of enc.encode(p)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0x1fffffffffffffn; }
  return Number(h);
}
const qidOf = (p: string, st: ServedStat): Qid => ({ type: st.isDirectory ? QTDIR : QTFILE, version: Math.floor((+st.mtime || 0) / 1000) >>> 0, path: qpath(p) });
function statOf(p: string, st: ServedStat): NinepStat {
  const ro = (st.mode ?? 0o644) & 0o222 ? 0 : 1;
  return { qid: qidOf(p, st), mode: ((st.isDirectory ? DMDIR | 0o755 : 0o644) & ~(ro ? 0o222 : 0)) >>> 0, atime: 0,
    mtime: Math.floor((+st.mtime || 0) / 1000) >>> 0, length: st.isDirectory ? 0 : st.size ?? 0, name: p === '/' ? '/' : base(p) };
}
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const errno = (e: unknown) => codeOf(e) ?? 'EIO';
const messageOf = (e: unknown) => String(typeof e === 'object' && e && 'message' in e && e.message != null ? e.message : e);
// A Rerror string: the errno first so the client can rebuild a Node-style error.
const ename = (e: unknown) => { const m = messageOf(e); return /^E[A-Z]+:/.test(m) ? m : `${errno(e)}: ${m}`; };
// The frame a message carries: a MessagePort wraps it in an event, a direct transport hands it over bare.
function frameOf(e: unknown): Uint8Array {
  const d = (typeof e === 'object' && e && 'data' in e ? e.data : null) ?? e;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  throw new Error('9P: a message that is not bytes');
}

// ── Server ────────────────────────────────────────────────────────────
// A MessagePort-shaped transport. Handlers get a MessageEvent, or the raw
// buffer from transports that deliver data directly.
export interface NinepPort {
  postMessage(data: ArrayBuffer, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ArrayBuffer>) => void) | null;
  close?(): void;
}
// What serve needs of a file server: typed listings and mv, which BaseFs gives every one.
export type ServedFs = Pick<FileServer, 'stat' | 'readFileBuffer' | 'writeFile' | 'mkdir' | 'rm' | 'openStream'> & Pick<BaseFs, 'readdirWithFileTypes' | 'mv'>;
// A stat, or the stand-in a listing uses when one fails (mtime 0).
type ServedStat = Pick<FileStat, 'isFile' | 'isDirectory'> & Partial<Pick<FileStat, 'size' | 'mode'>> & { mtime: Date | number };
export type CommitOp = 'write' | 'remove';
export interface ServeOptions {
  root?: string;   // the subtree exported (default '/'): the client's "/" is root
  msize?: number;  // the largest message we accept (default 128 KiB)
  // Where writes and removes land (default: fs.writeFile / fs.rm); bytes is
  // null for a remove; path is the full path in fs, not the client's.
  commit?: (path: string, bytes: Uint8Array | null, op: CommitOp) => Promise<unknown>;
  onCommit?: (path: string, op: CommitOp) => void; // after each landed change (full path)
}
// flushAll answers every request in flight with Rerror and refuses new ones
// (Stop), close() also drops fids.
export interface NinepServer { flushAll(reason?: string): void; close(): void }
// One fid's server-side state. data: the whole file, set at an open for writing (or the first read);
// the directory cursor (packed entries, the next one, its offset) is set by the first read.
interface ServedFid {
  path: string; open?: boolean; mode?: number; dir?: boolean; data?: Uint8Array; dirty?: boolean; rclose?: boolean;
  stream?: FileStream | null; pending?: Uint8Array; cursor?: { entries: Uint8Array[]; next: number; at: number };
}
interface InFlight { flushed: boolean; ac: AbortController }
type Reply = Untagged<RType>;

// serve(port, fs, opts) answers 9P on port with paths inside fs.
export function serve(port: NinepPort, fs: ServedFs, { root = '/', msize: max = 128 << 10, commit, onCommit }: ServeOptions = {}): NinepServer {
  const fids = new Map<number, ServedFid>();
  const live = new Map<number, InFlight>(); // by tag
  let msize = max, stopped: string | null = null;
  const full = (p: string) => join(root, p);
  // A change lands as a write of bytes, or a remove (null).
  const write = commit ?? ((p: string, b: Uint8Array | null) => (b === null ? fs.rm(p) : fs.writeFile(p, b)));
  const land = async (p: string, b: Uint8Array | null) => { const op = b === null ? 'remove' : 'write'; await write(full(p), b, op); onCommit?.(full(p), op); };
  const send = (m: Untagged) => { const b = encode(m); port.postMessage(b.buffer, [b.buffer]); };
  const err = (code: string, text: string) => Object.assign(new Error(`${code}: ${text}`), { code });

  async function handle(m: Message, t: InFlight): Promise<Reply> {
    const fid = (n: number) => { const f = fids.get(n); if (!f) throw err('EBADF', 'unknown fid'); return f; };
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
        if (t) { t.flushed = true; t.ac.abort(); } // a blocked stream read gives up
        return { type: 'Rflush' };
      }
      case 'Twalk': {
        const f = fid(m.fid);
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
        const f = fid(m.fid);
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
        // A streaming file (/session/events): each read waits for what is new to this fid.
        if (!st.isDirectory && mode === OREAD) f.stream = fs.openStream?.(full(p)) ?? null;
        if (!st.isDirectory && mode !== OREAD && mode !== OEXEC) {
          f.data = m.mode & OTRUNC || m.type === 'Tcreate' ? new Uint8Array() : await fs.readFileBuffer(full(p));
          if (m.mode & OTRUNC) f.dirty = true;
        }
        return { type: m.type === 'Tcreate' ? 'Rcreate' : 'Ropen', qid: qidOf(p, st), iounit: msize - IOHDR };
      }
      case 'Tread': {
        const f = fid(m.fid);
        if (!f.open || f.mode === OWRITE) throw err('EBADF', 'fid not open for reading');
        const count = Math.min(m.count, msize - IOHDR);
        if (f.dir) {
          // Directory reads return whole stat records; offset 0 restarts.
          if (m.offset === 0 || !f.cursor) {
            const ds = await fs.readdirWithFileTypes(full(f.path));
            const entries = await Promise.all(ds.map(async (d) => {
              const p = join(f.path, d.name);
              const st = await fs.stat(full(p)).catch(() => ({ isDirectory: d.isDirectory, isFile: d.isFile, size: 0, mtime: 0 }));
              return packStats([statOf(p, st)]);
            }));
            f.cursor = { entries, next: 0, at: 0 };
          }
          const c = f.cursor;
          if (m.offset !== c.at) throw err('EINVAL', 'bad offset in directory read');
          const out: Uint8Array[] = [];
          let n = 0;
          while (c.next < c.entries.length && n + c.entries[c.next].length <= count) { out.push(c.entries[c.next]); n += c.entries[c.next++].length; }
          c.at += n;
          const data = new Uint8Array(n); let o = 0;
          for (const b of out) { data.set(b, o); o += b.length; }
          return { type: 'Rread', data };
        }
        if (f.stream) {
          // Offsets mean nothing in a stream: a read returns the next events (at most count bytes of them).
          f.pending ??= new Uint8Array();
          if (!f.pending.length) f.pending = await f.stream.read(t.ac.signal);
          const data = f.pending.slice(0, count); f.pending = f.pending.slice(count);
          return { type: 'Rread', data };
        }
        f.data ??= await fs.readFileBuffer(full(f.path));
        return { type: 'Rread', data: f.data.slice(m.offset, m.offset + count) };
      }
      case 'Twrite': {
        const f = fid(m.fid);
        // Open for writing means data was set at open or create.
        if (!f.open || (f.mode !== OWRITE && f.mode !== ORDWR) || f.dir || !f.data) throw err('EBADF', 'fid not open for writing');
        const end = m.offset + m.data.length;
        if (end > f.data.length) { const b = new Uint8Array(end); b.set(f.data); f.data = b; }
        f.data.set(m.data, m.offset);
        f.dirty = true;
        return { type: 'Rwrite', count: m.data.length };
      }
      case 'Tclunk': case 'Tremove': {
        const f = fid(m.fid);
        fids.delete(m.fid); // the fid is gone whatever happens next (9P rule)
        if (m.type === 'Tremove' || f.rclose) await land(f.path, null);
        else if (f.dirty && f.data) await land(f.path, f.data); // dirty: written since an open that set data
        return { type: m.type === 'Tremove' ? 'Rremove' : 'Rclunk' };
      }
      case 'Tstat': {
        const f = fid(m.fid);
        return { type: 'Rstat', stat: statOf(f.path, await fs.stat(full(f.path))) };
      }
      case 'Twstat': {
        // Only what Pouch's stores can do: truncate (length) and rename within a folder.
        const f = fid(m.fid), s = m.stat;
        if (s.length !== 0xffffffffffffffff && Number.isSafeInteger(s.length) && s.length >= 0 && s.length < 2 ** 52) {
          const b = await fs.readFileBuffer(full(f.path)).catch(() => new Uint8Array());
          const out = new Uint8Array(s.length); out.set(b.subarray(0, s.length));
          await land(f.path, out);
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
    let m: Message;
    try { m = decode(frameOf(e)); } catch (x) { return send({ type: 'Rerror', tag: NOTAG, ename: `EINVAL: ${messageOf(x)}` }); }
    if (stopped) return send({ type: 'Rerror', tag: m.tag, ename: stopped });
    const t = { flushed: false, ac: new AbortController() };
    if (m.type !== 'Tflush') live.set(m.tag, t);
    let r: Reply;
    try { r = await handle(m, t); } catch (x) { r = { type: 'Rerror', ename: ename(x) }; }
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
      for (const [tag, t] of live) { t.flushed = true; t.ac.abort(); send({ type: 'Rerror', tag, ename: reason }); }
      live.clear();
    },
    close() { stopped ??= 'EPIPE: connection closed'; for (const t of live.values()) t.ac.abort(); fids.clear(); port.onmessage = null; port.close?.(); },
  };
}

// ── Client ────────────────────────────────────────────────────────────
// One connection: tags, fids, msize. call() resolves with the R-message or
// rejects with an Error whose message is the Rerror string (code first). A
// reply of another type than the request's (an Rread to a Twalk) rejects with
// EPROTO: the server is broken or hostile, and its fields would be misread.
interface Waiter { resolve(m: Message): void; reject(e: Error): void }
const isReply = <K extends TType>(m: Message, want: ReplyOf<K>): m is Message & Message<ReplyOf<K>> => m.type === want;
export class Client {
  declare port: NinepPort; declare msize: number; declare tags: Map<number, Waiter>; declare nextTag: number;
  declare nextFid: number; declare freeFids: number[]; declare closed?: boolean; declare root: number;
  constructor(port: NinepPort, { msize = 128 << 10 }: { msize?: number } = {}) {
    this.port = port; this.msize = msize; this.tags = new Map(); this.nextTag = 0; this.nextFid = 1; this.freeFids = [];
    port.onmessage = (e) => {
      let m: Message;
      try { m = decode(frameOf(e)); } catch (x) { return this.fail(new Error(messageOf(x))); }
      const w = this.tags.get(m.tag);
      if (!w) return; // an answer to a flushed request
      this.tags.delete(m.tag);
      if (m.type === 'Rerror') w.reject(Object.assign(new Error(m.ename), { code: codeOf({ message: m.ename }) }));
      else w.resolve(m);
    };
  }
  fail(e: Error) { for (const w of this.tags.values()) w.reject(e); this.tags.clear(); }
  tag() { for (;;) { const t = this.nextTag; this.nextTag = (this.nextTag + 1) % NOTAG; if (!this.tags.has(t)) return t; } }
  fid() { return this.freeFids.pop() ?? this.nextFid++; }
  call<K extends TType>(msg: Untagged<K>, { signal }: { signal?: AbortSignal } = {}): Promise<Message<ReplyOf<K>>> {
    if (this.closed) return Promise.reject(Object.assign(new Error('EPIPE: 9P connection closed'), { code: 'EPIPE' }));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('EINTR: interrupted (stopped)'), { code: 'EINTR' }));
    const tag = msg.type === 'Tversion' ? NOTAG : this.tag();
    return new Promise<Message<ReplyOf<K>>>((resolve, reject) => {
      const want: ReplyOf<K> = REPLY[msg.type];
      this.tags.set(tag, { reject, resolve: (m) => isReply(m, want) ? resolve(m)
        : reject(Object.assign(new Error(`EPROTO: 9P ${m.type} in reply to ${msg.type}`), { code: 'EPROTO' })) });
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
  async walk(path: string, signal?: AbortSignal) {
    const names = normalize(path).split('/').filter(Boolean);
    const fid = this.fid();
    try {
      const r = await this.call({ type: 'Twalk', fid: this.root, newfid: fid, wnames: names }, { signal });
      if (r.qids.length !== names.length) throw Object.assign(new Error(`ENOENT: no such file or directory, walk '${normalize(path)}'`), { code: 'ENOENT' });
      return fid;
    } catch (e) { this.freeFids.push(fid); throw e; }
  }
  async clunk(fid: number) { try { await this.call({ type: 'Tclunk', fid }); } finally { this.freeFids.push(fid); } }
  async readAll(fid: number, signal?: AbortSignal) {
    const chunks: Uint8Array[] = []; let off = 0;
    for (;;) {
      const r = await this.call({ type: 'Tread', fid, offset: off, count: this.msize - IOHDR }, { signal });
      if (!r.data.length) break;
      chunks.push(r.data); off += r.data.length;
    }
    const out = new Uint8Array(off); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  async writeAll(fid: number, bytes: Uint8Array, signal?: AbortSignal) {
    const step = this.msize - IOHDR;
    for (let off = 0; off < bytes.length; off += step) await this.call({ type: 'Twrite', fid, offset: off, data: bytes.subarray(off, off + step) }, { signal });
  }
}

// The far side of a 9P connection as a Pouch file server, so a Namespace can
// mount it like any local store. Each method is a short fid conversation:
// walk, (open|create), read/write, clunk.
export class NinepFs extends BaseFs {
  declare c: Client; declare signal?: AbortSignal;
  constructor(client: Client, { signal }: { signal?: AbortSignal } = {}) { super(); this.c = client; this.signal = signal; }
  async with<R>(path: string, fn: (fid: number) => Promise<R>): Promise<R> {
    const fid = await this.c.walk(path, this.signal);
    try { return await fn(fid); } finally { await this.c.clunk(fid).catch(() => {}); }
  }
  async stat(path: string) {
    const st = await this.with(path, async (fid) => (await this.c.call({ type: 'Tstat', fid }, { signal: this.signal })).stat);
    const dir = !!(st.mode & DMDIR);
    return { isFile: !dir, isDirectory: dir, isSymbolicLink: false, mode: st.mode & 0o777, size: st.length, mtime: new Date(st.mtime * 1000) };
  }
  async readFileBuffer(path: string) {
    return this.with(path, async (fid) => {
      const o = await this.c.call({ type: 'Topen', fid, mode: OREAD }, { signal: this.signal });
      if (o.qid.type & QTDIR) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: 'EISDIR' });
      return this.c.readAll(fid, this.signal);
    });
  }
  async readdirWithFileTypes(path: string) {
    return this.with(path, async (fid) => {
      const o = await this.c.call({ type: 'Topen', fid, mode: OREAD }, { signal: this.signal });
      if (!(o.qid.type & QTDIR)) throw Object.assign(new Error(`ENOTDIR: not a directory, scandir '${path}'`), { code: 'ENOTDIR' });
      return unpackStats(await this.c.readAll(fid, this.signal)).map((s) => ({ name: s.name, isFile: !(s.mode & DMDIR), isDirectory: !!(s.mode & DMDIR), isSymbolicLink: false }));
    });
  }
  async readdir(path: string) { return (await this.readdirWithFileTypes(path)).map((d) => d.name); }
  async writeFile(path: string, content: string | Uint8Array) {
    const bytes = typeof content === 'string' ? enc.encode(content) : content;
    const p = normalize(path), name = base(p);
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
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const p = normalize(path);
    if (options?.recursive) {
      if (await this.exists(p)) return;
      if (p !== '/') await this.mkdir(normalize(p + '/..'), options);
    }
    await this.with(normalize(p + '/..'), (dfid) => this.c.call({ type: 'Tcreate', fid: dfid, name: base(p), perm: DMDIR | 0o755, mode: OREAD }, { signal: this.signal }));
  }
  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
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
