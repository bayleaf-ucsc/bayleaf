// Watching files: an agent asks to hear when files change, instead of asking
// the user to tell it when they are done (JOURNEYS G13-G17).
//
// Two halves:
// - attribute(fs, source, sink): a view of a file server whose writes are
//   reported to `sink` with who made them. Every writer gets its own view
//   (the editor and uploads 'user', the agent's tools 'agent', `run` 'run',
//   a subagent 'subagent <name> (sN)'), so a watch can tell the user's saves
//   from the agent's own edits without guessing. Writes made through the raw
//   namespace are not reported (seeding /pouch defaults at boot). A seed
//   layer stacked or removed by the user is reported by a rescan ('seed').
// - createWatches(deps): the registry. Each watch belongs to one session and
//   one owner in it (main a1 or a subagent), persists, and turns matching
//   writes into one-line events. Delivery batches by itself: events wait while
//   the user has a follow-up waiting, join a busy owner's next step, and wake an
//   idle one, at most MAX_WAKES times per watch between user messages; after
//   that they are held for the tray. A short settle (SETTLE_MS of quiet)
//   makes a burst one delivery: the journeys measured that without it a
//   multi-file drop or rapid saves split across wakes. once = one wake: the
//   watch stays until the turn it woke ends, so the rest of a burst joins it.
//
// Events never carry file content: path, who, and a compact change summary.
import { normalize, within, type BaseFs, type FileServer } from './namespace.ts';
import type { Type as Typebox } from 'typebox';
import { MAIN, asRef, type Handle } from '../graph.ts';

// What watching uses of a file server.
export type WatchFs = Pick<FileServer, 'stat' | 'readFileBuffer'> & Pick<BaseFs, 'readdirWithFileTypes'>;
// Who wrote: 'user', 'agent', 'run', 'seed', 'outside', or 'subagent <name> (aN)'.
export type WriteSource = string;
export type WatchBy = 'user' | 'agent' | 'any';
type Bytes = Uint8Array | null;
export interface Fingerprint { h: string; size: number }
// One write as attribute() reports it; prior is a rescan's last fingerprint.
export interface FileChange { path: string; source: WriteSource; before: Bytes; after: Bytes; prior?: Fingerprint | null }
// A queued event. Held ones lose before/after (their bytes) on a reload.
export interface WatchEvent { watch: string; path: string; source: WriteSource; before?: Bytes; after?: Bytes; prior?: Fingerprint | null; at: number; held?: boolean; forced?: boolean }
// Held for the tray: what is stored of one (path, who, when), with the rest until a reload.
export type HeldEvent = Pick<WatchEvent, 'path' | 'source' | 'at'> & Partial<WatchEvent>;
export interface Watch {
  id: string; sid: string; owner: Handle; ownerName: string; paths: string[]; by: WatchBy; once: boolean; note: string;
  created: number; wakes: number; held: HeldEvent[]; files: Record<string, Fingerprint>; firing?: boolean;
}
export type StoredWatch = Omit<Watch, 'held' | 'files' | 'firing'> & { held?: Pick<WatchEvent, 'path' | 'source' | 'at'>[]; files?: Record<string, Fingerprint> };

export const MAX_WAKES = 3;
// A burst of changes becomes one delivery once quiet this long (at most SETTLE_MAX_MS).
export const SETTLE_MS = 300, SETTLE_MAX_MS = 3000;
export const WATCH_KIND = 'pouch.watch';
const MAX_FILES = 200; // files one watch keeps hashes for
const GLOB = /[*?[]/;
const dec = new TextDecoder();

// ── Globs ───────────────────────────────────────────────────────────
// * and ? stay inside one path segment, ** crosses them, [abc] is a class.
export function globRe(pattern: string) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') { const j = pattern.indexOf(']', i); if (j < 0) re += '\\['; else { re += '[' + pattern.slice(i + 1, j).replace(/\\/g, '\\\\') + ']'; i = j; } }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
export const isGlob = (p: string) => GLOB.test(p);
// The folder a pattern's matches all live under: /work/data for /work/data/*.csv.
export function baseOf(pattern: string) {
  const segs = pattern.split('/'), i = segs.findIndex((s) => GLOB.test(s));
  return i < 0 ? pattern : normalize(segs.slice(0, i).join('/') || '/');
}
export const matches = (pattern: string, path: string) => (isGlob(pattern) ? globRe(pattern).test(path) : path === pattern);

// Files a pattern matches now, walking only below its base.
export async function expand(fs: WatchFs, pattern: string, limit = MAX_FILES): Promise<string[]> {
  if (!isGlob(pattern)) {
    const st = await fs.stat(pattern).catch(() => null);
    // A plain path that became a folder after the watch was set: its files.
    return st?.isFile ? [pattern] : st?.isDirectory ? expand(fs, pattern + '/**', limit) : [];
  }
  const base = baseOf(pattern), deep = pattern.includes('**');
  const depth = pattern.split('/').length - base.split('/').length;
  const out: string[] = [];
  const walk = async (dir: string, d: number): Promise<void> => {
    if (out.length >= limit) return;
    let items: Awaited<ReturnType<WatchFs['readdirWithFileTypes']>> = [];
    try { items = await fs.readdirWithFileTypes(dir); } catch { return; }
    for (const it of items) {
      const p = normalize(dir + '/' + it.name);
      if (it.isFile && matches(pattern, p)) out.push(p);
      else if (it.isDirectory && (deep || d < depth)) await walk(p, d + 1);
      if (out.length >= limit) return;
    }
  };
  await walk(base, 1);
  return out.sort();
}

// ── Change summaries ────────────────────────────────────────────────
const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);
const lines = (b: Uint8Array) => { const t = dec.decode(b); return t === '' ? [] : t.replace(/\n$/, '').split('\n'); };
export const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Changed regions of b against a, as [newStart, newCount, oldCount] (1-based):
// common head and tail trimmed, then an LCS on the middle when it is small.
export type Hunk = [newStart: number, newCount: number, oldCount: number];
export function hunks(a: string[], b: string[]): Hunk[] {
  let h = 0;
  while (h < a.length && h < b.length && a[h] === b[h]) h++;
  let t = 0;
  while (t < a.length - h && t < b.length - h && a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
  const A = a.slice(h, a.length - t), B = b.slice(h, b.length - t);
  if (!A.length && !B.length) return [];
  if (A.length * B.length > 250_000 || !A.length || !B.length) return [[h + 1, B.length, A.length]];
  // LCS table from the end, then walk it, grouping runs of non-matching lines.
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Hunk[] = [];
  let i = 0, j = 0, cur: Hunk | null = null;
  const close = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { close(); i++; j++; continue; }
    cur ??= [h + j + 1, 0, 0];
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { cur[1]++; j++; } else { cur[2]++; i++; }
  }
  close();
  return out;
}
// What happened to one file, e.g. changed "lines 12-18 (+4 -2)",
// created "20 lines (1.2 KB)", deleted "was 3 lines, 120 B".
// before/after: bytes or null (missing). prior: { size } when only that is known (a rescan).
export interface Change { verb: 'deleted' | 'changed' | 'created' | 'saved'; detail: string }
const desc = (b: Uint8Array) => (isBinary(b) ? size(b.length) : `${plural(lines(b).length, 'line')}, ${size(b.length)}`);
export function change(before?: Bytes, after?: Bytes, prior?: { size: number } | null): Change {
  if (!after) return { verb: 'deleted', detail: before ? `was ${desc(before)}` : prior ? `was ${size(prior.size)}` : '' };
  if (!before) return prior ? { verb: 'changed', detail: `now ${desc(after)} (it changed while Pouch was not looking)` } : { verb: 'created', detail: desc(after) };
  if (isBinary(after) || isBinary(before)) return { verb: 'changed', detail: `binary, ${size(before.length)} -> ${size(after.length)}` };
  const hs = hunks(lines(before), lines(after));
  if (!hs.length) return { verb: 'saved', detail: before.length === after.length ? 'no changes' : 'only line endings changed' };
  const add = hs.reduce((s, x) => s + x[1], 0), del = hs.reduce((s, x) => s + x[2], 0);
  const at = (x: Hunk) => (x[1] <= 1 ? `${x[0]}` : `${x[0]}-${x[0] + x[1] - 1}`);
  const where = hs.length > 4 ? `lines ${hs[0][0]}-${hs.at(-1)![0] + Math.max(0, hs.at(-1)![1] - 1)} in ${hs.length} places`
    : `line${hs.length === 1 && hs[0][1] <= 1 ? '' : 's'} ${hs.map(at).join(', ')}`;
  return { verb: 'changed', detail: `${where} (+${add} -${del})` };
}
export const summarize = (b?: Bytes, a?: Bytes, p?: { size: number } | null) => { const c = change(b, a, p); return c.detail ? `${c.verb}: ${c.detail}` : c.verb; };

async function digest(bytes: Uint8Array) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(h.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}
const fingerprint = async (bytes: Uint8Array): Promise<Fingerprint> => ({ h: await digest(bytes), size: bytes.length });

// ── Attribution ─────────────────────────────────────────────────────
// Before-bytes are read only for paths some watch wants, so unwatched writes
// cost one synchronous check.
export interface WatchSink { wants(path: string): boolean; wantsUnder(path: string): boolean; observe(e: FileChange): void }
// The calls attribute() wraps, as the proxy sees them.
type FsCall = (...a: unknown[]) => Promise<unknown>;
export function attribute<F extends WatchFs>(fs: F, source: WriteSource, sink: WatchSink): F {
  const read = (p: string) => fs.readFileBuffer(p).then((b) => b, () => null);
  const filesUnder = async (p: string): Promise<string[]> => {
    const st = await fs.stat(p).catch(() => null);
    if (!st) return [];
    if (st.isFile) return sink.wants(p) ? [p] : [];
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const it of await fs.readdirWithFileTypes(d).catch(() => [])) {
        const q = normalize(d + '/' + it.name);
        if (it.isDirectory) await walk(q); else if (sink.wants(q)) out.push(q);
      }
    };
    await walk(p);
    return out;
  };
  // paths: the targets of one call; dirs: whether a folder may be involved.
  const around = async (targets: string[], op: () => Promise<unknown>) => {
    const ps = targets.map((x) => normalize(x));
    if (!ps.some((p) => sink.wants(p) || sink.wantsUnder(p))) return op();
    const pre = new Map<string, Bytes>();
    for (const p of ps) for (const f of await filesUnder(p)) pre.set(f, await read(f));
    for (const p of ps) if (sink.wants(p) && !pre.has(p)) pre.set(p, null);
    const r = await op();
    const post = new Set(pre.keys());
    for (const p of ps) for (const f of await filesUnder(p)) post.add(f);
    for (const f of post) {
      const after = await read(f);
      sink.observe({ path: f, source, before: pre.get(f) ?? null, after });
    }
    return r;
  };
  return new Proxy(fs, {
    get(target: F & Record<PropertyKey, FsCall>, prop) {
      if (prop === 'writeFile' || prop === 'appendFile' || prop === 'rm') return (p: string, ...a: unknown[]) => around([p], () => target[prop](p, ...a));
      if (prop === 'mv') return (s: string, d: string, ...a: unknown[]) => around([s, d], () => target.mv(s, d, ...a));
      if (prop === 'cp') return (s: string, d: string, ...a: unknown[]) => around([d], () => target.cp(s, d, ...a));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// ── The registry ────────────────────────────────────────────────────
export type DeliveryMode = 'steer' | 'wake';
export interface WatchEntry {
  kind: typeof WATCH_KIND;
  data: { watches: Pick<Watch, 'id' | 'note' | 'paths' | 'once'>[]; lines: string[]; mode: DeliveryMode };
}
export interface WatchDelivery { content: string; entry: WatchEntry; mode: DeliveryMode; paths: string[] }
export interface WatchDeps {
  fs: WatchFs; // the raw namespace (hashing, globbing, rescans)
  load(sid: string): Promise<StoredWatch[] | null | undefined>;
  save(sid: string, l: StoredWatch[]): unknown;
  sessions(): Promise<string[]>; // session ids that may have watches (boot)
  scopeOf(sid: string, owner: Handle): string[] | null; // mount specs an owner may see, or null for all
  followUpHeld(sid: string): boolean; // the user has a follow-up held for main (not sent)
  // The user's message is on its way in (Enter pressed, not yet admitted): a wake waits for it, a steer need not.
  userSending?(sid: string): boolean;
  busy(sid: string, owner: Handle): Promise<boolean>; // that owner is in a model run
  deliver(sid: string, owner: Handle, d: WatchDelivery): Promise<{ done?: Promise<unknown> } | null | undefined>; // done: a wake's run
  ready: Promise<unknown>; // the agent can take messages
  onChange?(): void; // the tray re-renders
  settleMs?: number;
}
export interface WatchArgs { paths?: string | string[]; path?: string; by?: string; once?: boolean; note?: string }
export type Watches = ReturnType<typeof createWatches>;
export function createWatches(deps: WatchDeps) {
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const byId = new Map<string, Watch>();
  const loaded = new Set<string>(); // sids read from storage
  const outbox = new Map<string, WatchEvent[]>(); // by sid
  const pumping = new Set<string>();
  const waking = new Map<string, Promise<unknown>>(); // `${sid}:${owner}` -> the woken run
  let next = 1;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const changed = () => deps.onChange?.();
  const ofSid = (sid: string) => [...byId.values()].filter((w) => String(w.sid) === String(sid));
  const persist = (sid: string) => deps.save(String(sid), ofSid(sid).map(({ id, sid: s, owner, ownerName, paths, by, once, note, created, wakes, held, files }) => ({ id, sid: s, owner, ownerName, paths, by, once, note, created, wakes, held: held.map(({ path, source, at }) => ({ path, source, at })), files })));
  const pats = (w: Watch) => w.paths;
  // A plain path also covers what lands under it: a watch set on a folder
  // before it existed (the user makes /work/data, then uploads into it).
  const watching = (w: Watch, path: string) => pats(w).some((p) => matches(p, path) || (!isGlob(p) && within(path, p)));

  async function loadSid(sid: string) {
    if (loaded.has(String(sid))) return;
    loaded.add(String(sid));
    for (const w of (await deps.load(String(sid))) ?? []) {
      byId.set(w.id, { ...w, owner: asRef(w.owner), held: w.held ?? [], files: w.files ?? {} }); // s-handles from older builds read as a-handles
      next = Math.max(next, Number(w.id.slice(1)) + 1);
    }
  }
  // Reload: watches come back, and files that changed while the tab was
  // closed (a mounted folder edited on disk, another tab) fire once.
  async function boot() {
    for (const sid of await deps.sessions()) await loadSid(sid);
    changed();
    await rescan('outside');
  }
  async function rescan(source: WriteSource, sid?: string) {
    for (const w of [...byId.values()]) {
      if (sid != null && String(w.sid) !== String(sid)) continue;
      const now = new Set<string>();
      for (const p of pats(w)) for (const f of await expand(deps.fs, p)) now.add(f);
      for (const f of new Set([...now, ...Object.keys(w.files)])) {
        const bytes = now.has(f) ? await deps.fs.readFileBuffer(f).catch(() => null) : null;
        const fp = bytes && await fingerprint(bytes), old = w.files[f];
        if ((fp?.h ?? null) === (old?.h ?? null)) continue;
        if (fp) w.files[f] = fp; else delete w.files[f];
        if (byFits(w, source)) enqueue(w, { path: f, source, before: null, after: bytes, prior: old ?? null });
      }
      persist(w.sid);
    }
    for (const s of outbox.keys()) pump(s);
  }

  const USERISH = ['user', 'outside', 'seed'];
  const byFits = (w: Watch, source: WriteSource) => (w.by === 'any' ? true : w.by === 'agent' ? !USERISH.includes(source) : USERISH.includes(source));

  async function add(sid: string, owner: Handle, ownerName: string, args: WatchArgs) {
    await loadSid(sid);
    const raw = Array.isArray(args.paths) ? args.paths : args.paths != null ? [args.paths] : args.path != null ? [args.path] : [];
    if (!raw.length) throw new Error('paths is empty: give files or globs, e.g. ["/work/essay.md"] or ["/work/data/*.csv"].');
    const by = args.by ?? 'user';
    if (!['user', 'agent', 'any'].includes(by)) throw new Error(`by must be "user", "agent" or "any" (got "${by}").`);
    const scope = deps.scopeOf(sid, owner);
    const paths: string[] = [];
    for (const r of raw) {
      let p = normalize(String(r).startsWith('/') ? String(r) : '/work/' + r);
      const base = baseOf(p);
      if (within(base, '/task')) throw new Error(`${p}: /task cannot be watched; read /task/<id>/status instead.`);
      if (scope && !scope.some((s) => within(base, s))) throw new Error(`${p} is outside what you can see (${scope.join(', ')}); you can only watch files in your own namespace.`);
      if (!isGlob(p) && (await deps.fs.stat(p).then((s) => s.isDirectory, () => false))) p = p + '/**';
      paths.push(p);
    }
    const w: Watch = { id: 'w' + next++, sid: String(sid), owner, ownerName, paths, by: by as WatchBy, once: !!args.once, note: String(args.note ?? '').trim().slice(0, 200), created: Date.now(), wakes: 0, held: [], files: {} };
    for (const p of paths) for (const f of await expand(deps.fs, p)) {
      const b = await deps.fs.readFileBuffer(f).catch(() => null);
      if (b) w.files[f] = await fingerprint(b);
    }
    byId.set(w.id, w);
    persist(sid); changed();
    return w;
  }
  function remove(id: string, sid?: string) {
    const w = byId.get(String(id).trim());
    if (!w || (sid != null && String(w.sid) !== String(sid))) return null;
    byId.delete(w.id);
    persist(w.sid); changed();
    return w;
  }
  function removeSession(sid: string) {
    for (const w of ofSid(sid)) byId.delete(w.id);
    outbox.delete(String(sid));
    changed();
  }

  // From attribute(): is anyone watching this path, or something under it?
  const wants = (path: string) => { for (const w of byId.values()) if (watching(w, path)) return true; return false; };
  const wantsUnder = (path: string) => { for (const w of byId.values()) for (const p of pats(w)) if (within(baseOf(p), path)) return true; return false; };
  function observe(e: FileChange) {
    for (const w of [...byId.values()]) {
      if (!watching(w, e.path)) continue;
      // Hashes follow every write, so a reload never mistakes the agent's own
      // edit for an outside change.
      (async () => {
        const fp = e.after && await fingerprint(e.after);
        if (fp) w.files[e.path] = fp; else delete w.files[e.path];
        if (byFits(w, e.source)) { enqueue(w, e); pump(w.sid); } else persist(w.sid);
      })();
    }
  }
  function enqueue(w: Watch, e: FileChange) {
    const l = outbox.get(w.sid) ?? [];
    l.push({ watch: w.id, path: e.path, source: e.source, before: e.before, after: e.after, prior: e.prior, at: Date.now() });
    outbox.set(w.sid, l);
  }

  // One delivery loop per session; anything arriving while it waits joins.
  async function pump(sid: string) {
    sid = String(sid);
    if (pumping.has(sid)) return;
    pumping.add(sid);
    try {
      await deps.ready;
      for (;;) {
        // User-first: the user's follow-up goes before any watch event.
        while (deps.followUpHeld(sid)) await sleep(150);
        // Let a burst settle (a multi-file drop, saves in quick succession):
        // deliver once nothing new arrived for SETTLE_MS, so it is one wake.
        for (let n = -1, t0 = Date.now(); (outbox.get(sid)?.length ?? 0) !== n && Date.now() - t0 < SETTLE_MAX_MS;) { n = outbox.get(sid)?.length ?? 0; await sleep(settleMs); }
        const batch = outbox.get(sid) ?? [];
        if (!batch.length) break;
        outbox.set(sid, []);
        const owners = new Map<Handle, WatchEvent[]>();
        for (const e of batch) {
          const w = byId.get(e.watch);
          if (!w) continue;
          const l = owners.get(w.owner) ?? []; l.push(e); owners.set(w.owner, l);
        }
        for (const [owner, evs] of owners) await deliverTo(sid, owner, evs);
      }
    } finally { pumping.delete(sid); }
    changed();
  }
  async function deliverTo(sid: string, owner: Handle, evs: WatchEvent[]) {
    const k = `${sid}:${owner}`;
    let busy = waking.has(k) || await deps.busy(sid, owner);
    // The user's own message is being admitted: let it start its turn first.
    while (!busy && owner === MAIN && deps.userSending?.(sid)) { await sleep(100); busy = await deps.busy(sid, owner); }
    const send: WatchEvent[] = [];
    for (const e of evs) {
      const w = byId.get(e.watch);
      if (!w) continue;
      // Idle and over its wake cap: held for the tray instead.
      if (!busy && !e.forced && w.wakes >= MAX_WAKES) { w.held.push(e); continue; }
      send.push(e);
    }
    const ws = [...new Set(send.map((e) => e.watch))].map((id) => byId.get(id)!); // send kept only live watches
    for (const w of new Set(evs.map((e) => byId.get(e.watch)).filter(Boolean))) persist(w!.sid);
    if (!send.length) { changed(); return; }
    const content = formatEvents(send, ws);
    const entry: WatchEntry = { kind: WATCH_KIND, data: { watches: ws.map((w) => ({ id: w.id, note: w.note, paths: w.paths, once: w.once })), lines: content.split('\n'), mode: busy ? 'steer' : 'wake' } };
    if (!busy) for (const w of ws) w.wakes++;
    // once = one wake (or one turn it joined): the watch stays until that turn
    // ends, so the rest of a burst (feb.csv after jan.csv, rapid saves) joins
    // the same turn; then it is removed.
    const retiring = ws.filter((w) => w.once && !w.firing);
    for (const w of retiring) w.firing = true;
    persist(sid); changed();
    const r = await deps.deliver(sid, owner, { content, entry, mode: busy ? 'steer' : 'wake', paths: [...new Set(send.map((e) => e.path))] }).catch((e) => { console.warn('Pouch watch delivery:', e); return null; });
    let ended: Promise<unknown>;
    if (!busy && r?.done) {
      const p: Promise<unknown> = Promise.resolve(r.done).catch(() => {}).finally(() => { if (waking.get(k) === p) waking.delete(k); });
      waking.set(k, p);
      ended = p;
    } else ended = (async () => { while (await deps.busy(sid, owner).catch(() => false)) await sleep(300); })();
    if (retiring.length) ended.then(() => { for (const w of retiring) if (byId.get(w.id) === w) byId.delete(w.id); persist(sid); changed(); });
  }

  return {
    boot, add, remove, removeSession, rescan, wants, wantsUnder, observe,
    list: (sid: string) => ofSid(sid),
    get: (id: string) => byId.get(id),
    all: () => [...byId.values()],
    // The user wrote to the session: every watch may wake it again.
    userSpoke(sid: string) { let any = false; for (const w of ofSid(sid)) if (w.wakes) { w.wakes = 0; any = true; } if (any) persist(sid); },
    // Tray: deliver what a capped watch held (the user asked, so it may wake).
    deliverHeld(id: string) {
      const w = byId.get(id);
      if (!w?.held.length) return;
      const held = w.held; w.held = []; w.wakes = 0;
      const l = outbox.get(w.sid) ?? [];
      // Held events keep their bytes until a reload; after one, only path and who.
      for (const h of held) l.push({ ...h, watch: w.id, held: !('after' in h), forced: true });
      outbox.set(w.sid, l);
      pump(w.sid);
    },
  };
}

const WHO: Record<string, string> = { user: 'you', agent: 'Pouch', run: 'a run script', seed: 'you (seed layer)', outside: 'outside Pouch (while it was closed)' };
export const whoOf = (source: WriteSource) => WHO[source] ?? source.replace(/^subagent /, '');
const show = (p: string) => (within(p, '/work') && p !== '/work' ? p.slice(6) : p);

// One line per (watch, path), several saves of one file merged into one
// summary (first before, last after), then one line per watch with its note.
export function formatEvents(events: WatchEvent[], watches: Pick<Watch, 'id' | 'note' | 'once'>[]) {
  const groups = new Map<string, WatchEvent & { n: number; who: Set<WriteSource> }>();
  for (const e of events) {
    const k = e.path;
    const g = groups.get(k);
    if (!g) groups.set(k, { ...e, n: 1, who: new Set([e.source]) });
    else { g.after = e.after; g.n++; g.who.add(e.source); if (e.held) g.held = true; }
  }
  const out: string[] = [];
  for (const g of groups.values()) {
    const who = [...g.who].map(whoOf).join(' and ') + (g.n > 1 ? ` (${g.n} writes)` : '');
    const c: Change = g.held ? { verb: 'changed', detail: 'held while the watch was paused; read it for details' } : change(g.before, g.after, g.prior);
    out.push(`[from files] ${show(g.path)} ${c.verb} by ${who}${c.detail ? (c.verb === 'deleted' ? ` (${c.detail})` : `: ${c.detail}`) : ''}`);
  }
  for (const w of watches) out.push(`[watch ${w.id}${w.note ? `, your note: ${w.note}` : ''}${w.once ? '; a once watch: more changes during this turn still arrive, then it is removed' : `; unwatch ${w.id} to stop`}]`);
  return out.join('\n');
}

// ── The tool ────────────────────────────────────────────────────────
// A small tool of its own rather than actions on `subagent`: watching is not
// about subagents, main and subagents share one schema, and the subagent
// tool's description stays as long as it is. callerOf(caller) gives
// { sid, owner, ownerName } (owner: "a1" for main, "a3" for a subagent).
export const WATCH_GLOSS = 'The watch tool tells you when files change. Instead of asking the user to tell you when they are done editing or adding files, watch those files, say in one line that you are watching, and end your turn: the change arrives as a message. Unwatch when the user does not want follow-ups.';
export interface WatchCaller { sid: string; owner: Handle; ownerName: string }
export interface WatchToolArgs { action: string; paths?: string[]; by?: WatchBy; once?: boolean; note?: string; id?: string }
export function watchTool({ Type, watches, callerOf }: { Type: typeof Typebox; watches: Watches; callerOf: (caller: unknown) => Promise<WatchCaller> }) {
  const line = (w: Watch) => `- ${w.id} ${w.paths.join(', ')}: changes by ${w.by === 'user' ? 'the user' : w.by === 'agent' ? 'agents and scripts' : 'anyone'}${w.once ? ', once' : ''}${w.note ? `; note: ${w.note}` : ''}${w.owner !== MAIN ? ` (owner ${w.ownerName} ${w.owner})` : ''}${w.held.length ? `; ${w.held.length} change(s) held in the user's tray` : ''}`;
  return {
    name: 'watch', label: 'Watch',
    description: 'Get told when files change, instead of asking the user to tell you. action "watch" registers paths (files, folders, or globs like /work/data/*.csv; only what you can see) and returns a watch id. A change arrives as a message between your steps, or starts a turn if you are idle (one request), e.g. "[from files] essay.md changed by you: lines 12-18 (+4 -2)": never the content, read the file if you need it. ' +
      `by: "user" (default: the user's saves, uploads and drops), "agent" (agents and run scripts) or "any". once: true removes it after the one turn its first event wakes (waiting for files to arrive: files that land during that turn join it). note: why you are watching, shown to the user and repeated in each event. After ${MAX_WAKES} wakes without the user writing, events wait in the user's tray. "unwatch" removes one (id); "list" shows them.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal('watch'), Type.Literal('unwatch'), Type.Literal('list')]),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'watch: files, folders or globs; relative paths start at /work' })),
      by: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('any')], { description: 'watch: whose changes count (default "user")' })),
      once: Type.Optional(Type.Boolean({ description: 'watch: remove it after the turn its first event wakes; changes during that turn join it (default false)' })),
      note: Type.Optional(Type.String({ description: 'watch: why, in a few words, e.g. "offer to re-run the panel"' })),
      id: Type.Optional(Type.String({ description: 'unwatch: the watch id, e.g. "w1"' })),
    }),
    async execute(args: WatchToolArgs, { caller }: { caller?: unknown } = {}) {
      const who = await callerOf(caller);
      if (args.action === 'list') {
        const l = watches.list(who.sid).filter((w) => who.owner === MAIN || w.owner === who.owner);
        return l.length ? l.map(line).join('\n') : 'No watches.';
      }
      if (args.action === 'unwatch') {
        const w = watches.get(String(args.id ?? '').trim());
        if (!w || String(w.sid) !== String(who.sid) || (who.owner !== MAIN && w.owner !== who.owner)) throw new Error(`No watch "${args.id}" of yours. ${watches.list(who.sid).length ? 'list shows them.' : 'There are none.'}`);
        watches.remove(w.id);
        return `Stopped watching ${w.paths.join(', ')} (${w.id}).`;
      }
      if (args.action !== 'watch') throw new Error(`Unknown action "${args.action}": use watch, unwatch or list.`);
      const w = await watches.add(who.sid, who.owner, who.ownerName, args);
      const n = Object.keys(w.files).length;
      return `Watching ${w.paths.join(', ')} as ${w.id} (changes by ${w.by === 'user' ? 'the user' : w.by === 'agent' ? 'agents and scripts' : 'anyone'}${w.once ? ', once' : ''}; ${n} file${n === 1 ? '' : 's'} there now). Tell the user in one line that you are watching, then end your turn; the change arrives as a message.`;
    },
  };
}
