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
//   one owner in it (main s1 or a subagent), persists, and turns matching
//   writes into one-line events. Delivery batches by itself: events wait while
//   the user has a message queued, join a busy owner's next step, and wake an
//   idle one, at most MAX_WAKES times per watch between user messages; after
//   that they are held for the tray. A short settle (SETTLE_MS of quiet)
//   makes a burst one delivery: the journeys measured that without it a
//   multi-file drop or rapid saves split across wakes. once = one wake: the
//   watch stays until the turn it woke ends, so the rest of a burst joins it.
//
// Events never carry file content: path, who, and a compact change summary.
import { normalize, within } from './namespace.js';

export const MAX_WAKES = 3;
// A burst of changes becomes one delivery once quiet this long (at most SETTLE_MAX_MS).
export const SETTLE_MS = 300, SETTLE_MAX_MS = 3000;
export const WATCH_KIND = 'pouch.watch';
const MAX_FILES = 200; // files one watch keeps hashes for
const GLOB = /[*?[]/;
const dec = new TextDecoder();

// ── Globs ───────────────────────────────────────────────────────────
// * and ? stay inside one path segment, ** crosses them, [abc] is a class.
export function globRe(pattern) {
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
export const isGlob = (p) => GLOB.test(p);
// The folder a pattern's matches all live under: /work/data for /work/data/*.csv.
export function baseOf(pattern) {
  const segs = pattern.split('/'), i = segs.findIndex((s) => GLOB.test(s));
  return i < 0 ? pattern : normalize(segs.slice(0, i).join('/') || '/');
}
export const matches = (pattern, path) => (isGlob(pattern) ? globRe(pattern).test(path) : path === pattern);

// Files a pattern matches now, walking only below its base.
export async function expand(fs, pattern, limit = MAX_FILES) {
  if (!isGlob(pattern)) return (await fs.stat(pattern).then((s) => s.isFile, () => false)) ? [pattern] : [];
  const base = baseOf(pattern), deep = pattern.includes('**');
  const depth = pattern.split('/').length - base.split('/').length;
  const out = [];
  const walk = async (dir, d) => {
    if (out.length >= limit) return;
    let items = [];
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
const isBinary = (b) => b.subarray(0, 8000).includes(0);
const lines = (b) => { const t = dec.decode(b); return t === '' ? [] : t.replace(/\n$/, '').split('\n'); };
export const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Changed regions of b against a, as [newStart, newCount, oldCount] (1-based):
// common head and tail trimmed, then an LCS on the middle when it is small.
export function hunks(a, b) {
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
  const out = [];
  let i = 0, j = 0, cur = null;
  const close = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { close(); i++; j++; continue; }
    cur ??= [h + j + 1, 0, 0];
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { cur[1]++; j++; } else { cur[2]++; i++; }
  }
  close();
  return out;
}
// What happened to one file: { verb, detail }, e.g. changed "lines 12-18 (+4 -2)",
// created "20 lines (1.2 KB)", deleted "was 3 lines, 120 B".
// before/after: bytes or null (missing). prior: { size } when only that is known (a rescan).
const desc = (b) => (isBinary(b) ? size(b.length) : `${plural(lines(b).length, 'line')}, ${size(b.length)}`);
export function change(before, after, prior) {
  if (!after) return { verb: 'deleted', detail: before ? `was ${desc(before)}` : prior ? `was ${size(prior.size)}` : '' };
  if (!before) return prior ? { verb: 'changed', detail: `now ${desc(after)} (it changed while Pouch was not looking)` } : { verb: 'created', detail: desc(after) };
  if (isBinary(after) || isBinary(before)) return { verb: 'changed', detail: `binary, ${size(before.length)} -> ${size(after.length)}` };
  const hs = hunks(lines(before), lines(after));
  if (!hs.length) return { verb: 'saved', detail: before.length === after.length ? 'no changes' : 'only line endings changed' };
  const add = hs.reduce((s, x) => s + x[1], 0), del = hs.reduce((s, x) => s + x[2], 0);
  const at = (x) => (x[1] <= 1 ? `${x[0]}` : `${x[0]}-${x[0] + x[1] - 1}`);
  const where = hs.length > 4 ? `lines ${hs[0][0]}-${hs.at(-1)[0] + Math.max(0, hs.at(-1)[1] - 1)} in ${hs.length} places`
    : `line${hs.length === 1 && hs[0][1] <= 1 ? '' : 's'} ${hs.map(at).join(', ')}`;
  return { verb: 'changed', detail: `${where} (+${add} -${del})` };
}
export const summarize = (b, a, p) => { const c = change(b, a, p); return c.detail ? `${c.verb}: ${c.detail}` : c.verb; };

async function digest(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(h.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}
const fingerprint = async (bytes) => ({ h: await digest(bytes), size: bytes.length });

// ── Attribution ─────────────────────────────────────────────────────
// sink: { wants(path), wantsUnder(path), observe({ path, source, before, after }) }.
// Before-bytes are read only for paths some watch wants, so unwatched writes
// cost one synchronous check.
export function attribute(fs, source, sink) {
  const read = (p) => fs.readFileBuffer(p).then((b) => b, () => null);
  const filesUnder = async (p) => {
    const st = await fs.stat(p).catch(() => null);
    if (!st) return [];
    if (st.isFile) return sink.wants(p) ? [p] : [];
    const out = [];
    const walk = async (d) => {
      for (const it of await fs.readdirWithFileTypes(d).catch(() => [])) {
        const q = normalize(d + '/' + it.name);
        if (it.isDirectory) await walk(q); else if (sink.wants(q)) out.push(q);
      }
    };
    await walk(p);
    return out;
  };
  // paths: the targets of one call; dirs: whether a folder may be involved.
  const around = async (targets, op) => {
    const ps = targets.map((x) => normalize(x));
    if (!ps.some((p) => sink.wants(p) || sink.wantsUnder(p))) return op();
    const pre = new Map();
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
    get(target, prop) {
      if (prop === 'writeFile' || prop === 'appendFile' || prop === 'rm') return (p, ...a) => around([p], () => target[prop](p, ...a));
      if (prop === 'mv') return (s, d, ...a) => around([s, d], () => target.mv(s, d, ...a));
      if (prop === 'cp') return (s, d, ...a) => around([d], () => target.cp(s, d, ...a));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// ── The registry ────────────────────────────────────────────────────
// deps:
//   fs                       the raw namespace (hashing, globbing, rescans)
//   load(sid) / save(sid, l) persistence per session
//   sessions()               session ids that may have watches (boot)
//   scopeOf(sid, owner)      mount specs an owner may see, or null for all
//   userQueued(sid)          the user has a message held for main (queued, not sent)
//   userSending(sid)         the user's message is on its way in (Enter pressed,
//                            not yet admitted): a wake waits for it, a steer need not
//   busy(sid, owner)         that owner is in a model run
//   deliver(sid, owner, { content, entry, mode })  mode 'steer' | 'wake';
//                            resolves to { done?: Promise } (a wake's run)
//   ready                    a promise: the agent can take messages
//   onChange()               the tray re-renders
export function createWatches(deps) {
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const byId = new Map(); // id -> watch
  const loaded = new Set(); // sids read from storage
  const outbox = new Map(); // sid -> [event]
  const pumping = new Set();
  const waking = new Map(); // `${sid}:${owner}` -> Promise of the woken run
  let next = 1;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const changed = () => deps.onChange?.();
  const ofSid = (sid) => [...byId.values()].filter((w) => String(w.sid) === String(sid));
  const persist = (sid) => deps.save(String(sid), ofSid(sid).map(({ id, sid: s, owner, ownerName, paths, by, once, note, created, wakes, held, files }) => ({ id, sid: s, owner, ownerName, paths, by, once, note, created, wakes, held: held.map(({ path, source, at }) => ({ path, source, at })), files })));
  const pats = (w) => w.paths;
  const watching = (w, path) => pats(w).some((p) => matches(p, path));

  async function loadSid(sid) {
    if (loaded.has(String(sid))) return;
    loaded.add(String(sid));
    for (const w of (await deps.load(String(sid))) ?? []) {
      byId.set(w.id, { ...w, held: w.held ?? [], files: w.files ?? {} });
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
  async function rescan(source, sid) {
    for (const w of [...byId.values()]) {
      if (sid != null && String(w.sid) !== String(sid)) continue;
      const now = new Set();
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
  const byFits = (w, source) => (w.by === 'any' ? true : w.by === 'agent' ? !USERISH.includes(source) : USERISH.includes(source));

  async function add(sid, owner, ownerName, args) {
    await loadSid(sid);
    const raw = Array.isArray(args.paths) ? args.paths : args.paths != null ? [args.paths] : args.path != null ? [args.path] : [];
    if (!raw.length) throw new Error('paths is empty: give files or globs, e.g. ["/work/essay.md"] or ["/work/data/*.csv"].');
    const by = args.by ?? 'user';
    if (!['user', 'agent', 'any'].includes(by)) throw new Error(`by must be "user", "agent" or "any" (got "${by}").`);
    const scope = deps.scopeOf(sid, owner);
    const paths = [];
    for (const r of raw) {
      let p = normalize(String(r).startsWith('/') ? String(r) : '/work/' + r);
      const base = baseOf(p);
      if (within(base, '/task')) throw new Error(`${p}: /task cannot be watched; read /task/<id>/status instead.`);
      if (scope && !scope.some((s) => within(base, s))) throw new Error(`${p} is outside what you can see (${scope.join(', ')}); you can only watch files in your own namespace.`);
      if (!isGlob(p) && (await deps.fs.stat(p).then((s) => s.isDirectory, () => false))) p = p + '/**';
      paths.push(p);
    }
    const w = { id: 'w' + next++, sid: String(sid), owner, ownerName, paths, by, once: !!args.once, note: String(args.note ?? '').trim().slice(0, 200), created: Date.now(), wakes: 0, held: [], files: {} };
    for (const p of paths) for (const f of await expand(deps.fs, p)) {
      const b = await deps.fs.readFileBuffer(f).catch(() => null);
      if (b) w.files[f] = await fingerprint(b);
    }
    byId.set(w.id, w);
    persist(sid); changed();
    return w;
  }
  function remove(id, sid) {
    const w = byId.get(String(id).trim());
    if (!w || (sid != null && String(w.sid) !== String(sid))) return null;
    byId.delete(w.id);
    persist(w.sid); changed();
    return w;
  }
  function removeSession(sid) {
    for (const w of ofSid(sid)) byId.delete(w.id);
    outbox.delete(String(sid));
    changed();
  }

  // From attribute(): is anyone watching this path, or something under it?
  const wants = (path) => { for (const w of byId.values()) if (watching(w, path)) return true; return false; };
  const wantsUnder = (path) => { for (const w of byId.values()) for (const p of pats(w)) if (within(baseOf(p), path)) return true; return false; };
  function observe(e) {
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
  function enqueue(w, e) {
    const l = outbox.get(w.sid) ?? [];
    l.push({ watch: w.id, path: e.path, source: e.source, before: e.before, after: e.after, prior: e.prior, at: Date.now() });
    outbox.set(w.sid, l);
  }

  // One delivery loop per session; anything arriving while it waits joins.
  async function pump(sid) {
    sid = String(sid);
    if (pumping.has(sid)) return;
    pumping.add(sid);
    try {
      await deps.ready;
      for (;;) {
        // User-first: a queued user message goes before any watch event.
        while (deps.userQueued(sid)) await sleep(150);
        // Let a burst settle (a multi-file drop, saves in quick succession):
        // deliver once nothing new arrived for SETTLE_MS, so it is one wake.
        for (let n = -1, t0 = Date.now(); (outbox.get(sid)?.length ?? 0) !== n && Date.now() - t0 < SETTLE_MAX_MS;) { n = outbox.get(sid)?.length ?? 0; await sleep(settleMs); }
        const batch = outbox.get(sid) ?? [];
        if (!batch.length) break;
        outbox.set(sid, []);
        const owners = new Map();
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
  async function deliverTo(sid, owner, evs) {
    const k = `${sid}:${owner}`;
    let busy = waking.has(k) || await deps.busy(sid, owner);
    // The user's own message is being admitted: let it start its turn first.
    while (!busy && owner === 's1' && deps.userSending?.(sid)) { await sleep(100); busy = await deps.busy(sid, owner); }
    const send = [];
    for (const e of evs) {
      const w = byId.get(e.watch);
      if (!w) continue;
      // Idle and over its wake cap: held for the tray instead.
      if (!busy && !e.forced && w.wakes >= MAX_WAKES) { w.held.push(e); continue; }
      send.push(e);
    }
    const ws = [...new Set(send.map((e) => e.watch))].map((id) => byId.get(id));
    for (const w of new Set(evs.map((e) => byId.get(e.watch)).filter(Boolean))) persist(w.sid);
    if (!send.length) { changed(); return; }
    const content = formatEvents(send, ws);
    const entry = { kind: WATCH_KIND, data: { watches: ws.map((w) => ({ id: w.id, note: w.note, paths: w.paths, once: w.once })), lines: content.split('\n'), mode: busy ? 'steer' : 'wake' } };
    if (!busy) for (const w of ws) w.wakes++;
    // once = one wake (or one turn it joined): the watch stays until that turn
    // ends, so the rest of a burst (feb.csv after jan.csv, rapid saves) joins
    // the same turn; then it is removed.
    const retiring = ws.filter((w) => w.once && !w.firing);
    for (const w of retiring) w.firing = true;
    persist(sid); changed();
    const r = await deps.deliver(sid, owner, { content, entry, mode: busy ? 'steer' : 'wake', paths: [...new Set(send.map((e) => e.path))] }).catch((e) => { console.warn('Pouch watch delivery:', e); return null; });
    let ended;
    if (!busy && r?.done) {
      const p = Promise.resolve(r.done).catch(() => {}).finally(() => { if (waking.get(k) === p) waking.delete(k); });
      waking.set(k, p);
      ended = p;
    } else ended = (async () => { while (await deps.busy(sid, owner).catch(() => false)) await sleep(300); })();
    if (retiring.length) ended.then(() => { for (const w of retiring) if (byId.get(w.id) === w) byId.delete(w.id); persist(sid); changed(); });
  }

  return {
    boot, add, remove, removeSession, rescan, wants, wantsUnder, observe,
    list: (sid) => ofSid(sid),
    get: (id) => byId.get(id),
    all: () => [...byId.values()],
    // The user wrote to the session: every watch may wake it again.
    userSpoke(sid) { let any = false; for (const w of ofSid(sid)) if (w.wakes) { w.wakes = 0; any = true; } if (any) persist(sid); },
    // Tray: deliver what a capped watch held (the user asked, so it may wake).
    deliverHeld(id) {
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

const WHO = { user: 'you', agent: 'Pouch', run: 'a run script', seed: 'you (seed layer)', outside: 'outside Pouch (while it was closed)' };
export const whoOf = (source) => WHO[source] ?? source.replace(/^subagent /, '');
const show = (p) => (within(p, '/work') && p !== '/work' ? p.slice(6) : p);

// One line per (watch, path), several saves of one file merged into one
// summary (first before, last after), then one line per watch with its note.
export function formatEvents(events, watches) {
  const groups = new Map();
  for (const e of events) {
    const k = e.path;
    const g = groups.get(k);
    if (!g) groups.set(k, { ...e, n: 1, who: new Set([e.source]) });
    else { g.after = e.after; g.n++; g.who.add(e.source); if (e.held) g.held = true; }
  }
  const out = [];
  for (const g of groups.values()) {
    const who = [...g.who].map(whoOf).join(' and ') + (g.n > 1 ? ` (${g.n} writes)` : '');
    const c = g.held ? { verb: 'changed', detail: 'held while the watch was paused; read it for details' } : change(g.before, g.after, g.prior);
    out.push(`[from files] ${show(g.path)} ${c.verb} by ${who}${c.detail ? (c.verb === 'deleted' ? ` (${c.detail})` : `: ${c.detail}`) : ''}`);
  }
  for (const w of watches) out.push(`[watch ${w.id}${w.note ? `, your note: ${w.note}` : ''}${w.once ? '; a once watch: more changes during this turn still arrive, then it is removed' : `; unwatch ${w.id} to stop`}]`);
  return out.join('\n');
}

// ── The tool ────────────────────────────────────────────────────────
// A small tool of its own rather than actions on `subagent`: watching is not
// about subagents, main and subagents share one schema, and the subagent
// tool's description stays as long as it is. callerOf(caller) gives
// { sid, owner, ownerName } (owner: "s1" for main, "s3" for a subagent).
export const WATCH_GLOSS = 'The watch tool tells you when files change. Instead of asking the user to tell you when they are done editing or adding files, watch those files, say in one line that you are watching, and end your turn: the change arrives as a message. Unwatch when the user does not want follow-ups.';
export function watchTool({ Type, watches, callerOf }) {
  const line = (w) => `- ${w.id} ${w.paths.join(', ')}: changes by ${w.by === 'user' ? 'the user' : w.by === 'agent' ? 'agents and scripts' : 'anyone'}${w.once ? ', once' : ''}${w.note ? `; note: ${w.note}` : ''}${w.owner !== 's1' ? ` (owner ${w.ownerName} ${w.owner})` : ''}${w.held.length ? `; ${w.held.length} change(s) held in the user's tray` : ''}`;
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
    async execute(args, { caller } = {}) {
      const who = await callerOf(caller);
      if (args.action === 'list') {
        const l = watches.list(who.sid).filter((w) => who.owner === 's1' || w.owner === who.owner);
        return l.length ? l.map(line).join('\n') : 'No watches.';
      }
      if (args.action === 'unwatch') {
        const w = watches.get(String(args.id ?? '').trim());
        if (!w || String(w.sid) !== String(who.sid) || (who.owner !== 's1' && w.owner !== who.owner)) throw new Error(`No watch "${args.id}" of yours. ${watches.list(who.sid).length ? 'list shows them.' : 'There are none.'}`);
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
