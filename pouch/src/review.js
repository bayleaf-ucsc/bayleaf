// What did the agent change, and can I take it back? (story map R2, R3, R5)
//
// Every tool mutation calls beforeChange(path) first (tools.js, recording()).
// On the first touch of a path within a run, the old state is copied into the
// `changes` store. Status is not stored: it is derived from that copy and what
// is on disk now, so it stays true after reloads, later edits and undos.
// No DOM here; main.js renders the rows and asks the questions.
import * as store from './store.js';
import { normalize } from './vfs.js';
import { collect, extract } from './archive.js';

const LIMIT = 20 * 1024 * 1024; // larger pre-images are noted, not copied

const parentOf = (p) => normalize(p + '/..');
const nameIn = (p) => p.slice(parentOf(p).length).replace(/^\//, '');

// The state of a path, as a record's `before`.
async function snapshot(fs, path) {
  let st;
  try { st = await fs.stat(path); } catch { return { kind: 'none' }; }
  if (!st.isDirectory) return st.size > LIMIT ? { kind: 'toolarge' } : { kind: 'file', data: await fs.readFileBuffer(path) };
  const entries = await collect(fs, parentOf(path), nameIn(path));
  const size = entries.reduce((n, e) => n + (e.data?.length ?? 0), 0);
  return size > LIMIT ? { kind: 'toolarge' } : { kind: 'dir', entries };
}

// A cheap fingerprint of a path's current state, to notice later changes.
async function signature(fs, path) {
  let st;
  try { st = await fs.stat(path); } catch { return 'none'; }
  if (st.isDirectory) return 'dir';
  const hash = await crypto.subtle.digest('SHA-256', await fs.readFileBuffer(path));
  return 'file:' + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function createReview(vfs, { currentSession }) {
  const fs = vfs.fs; // the raw filesystem: reading and restoring are not agent changes
  let run = null;    // { id, session, afterItem, seen: Map(path -> Promise) }
  const subRuns = new Map(); // subagent id -> its run (sub: the id), until endSub()
  let records = [];  // the loaded session's change records, by seq
  let loaded = null; // which session `records` belongs to
  const unseen = new Set(); // changed paths the user has not opened yet

  function begin(session, afterItem) {
    run = { id: crypto.randomUUID(), session: String(session), afterItem, seen: new Map() };
    return run;
  }

  // Never throws: failing to record must not fail the agent's write.
  // who: { session, sub } when a subagent makes the change (main.js); its
  // changes form their own run, shown on its card and report, not in a turn.
  function beforeChange(path, op, who) {
    let r;
    if (who?.sub != null) {
      const k = String(who.sub);
      if (!subRuns.has(k)) subRuns.set(k, { id: `sub:${k}:${crypto.randomUUID()}`, session: String(who.session), sub: k, afterItem: null, seen: new Map() });
      r = subRuns.get(k);
    } else {
      // pi-durable may resume an interrupted run after a reload, with no send().
      run ??= { id: 'resumed', session: String(who?.session ?? currentSession() ?? ''), afterItem: null, seen: new Map() };
      r = run;
    }
    if (r.seen.has(path)) return r.seen.get(path);
    const p = (async () => {
      const rec = { run: r.id, session: r.session, afterItem: r.afterItem, path, op, ts: Date.now(), before: await snapshot(fs, path), ...(r.sub ? { sub: r.sub } : {}) };
      rec.seq = await store.addChange(rec);
      if (loaded === rec.session) records.push(rec);
      unseen.add(path);
    })().catch((e) => console.warn('Pouch could not record a change to', path, e));
    r.seen.set(path, p);
    return p;
  }

  // At the end of a run, fingerprint what it left, so undo can tell whether
  // anything (a later run, the user) changed the file since.
  async function end() { const r = run; run = null; await close(r); }
  // A subagent's run ends when its submission settles.
  async function endSub(sub) { const r = subRuns.get(String(sub)); subRuns.delete(String(sub)); await close(r); }
  async function close(r) {
    if (!r) return;
    await Promise.all(r.seen.values());
    const recs = (await store.changesFor(r.session)).filter((x) => x.run === r.id);
    for (const rec of recs) {
      rec.after = await signature(fs, rec.path);
      await store.putChange(rec);
      const mine = records.find((x) => x.seq === rec.seq);
      if (mine) mine.after = rec.after;
    }
    await store.pruneChanges();
  }

  async function load(session) {
    const want = session == null ? null : String(session);
    loaded = want;
    const recs = want == null ? [] : (await store.changesFor(want)).sort((a, b) => a.seq - b.seq);
    if (loaded === want) records = recs; // a newer load() wins a race
    return records;
  }

  async function kind(path) {
    try { return (await fs.stat(path)).isDirectory ? 'dir' : 'file'; } catch { return 'none'; }
  }

  // Rows for one run: { path, to?, status, recs, undone, dir }. An mv shows
  // up as two records in a row (source, then destination): one "moved" row.
  async function rowsOf(recs) {
    const rows = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i], next = recs[i + 1];
      const now = await kind(r.path);
      const undone = !!r.undone;
      if (r.op === 'mv' && next?.op === 'mv' && r.before.kind !== 'none' && next.before.kind === 'none' && now === 'none' && (await kind(next.path)) !== 'none') {
        rows.push({ path: r.path, to: next.path, status: 'moved', recs: [r, next], undone: undone && !!next.undone, dir: r.before.kind === 'dir' });
        i++; continue;
      }
      let status;
      if (undone) status = 'undone';
      else if (r.before.kind === 'none') status = now === 'none' ? null : 'created';
      else if (now === 'none') status = 'deleted';
      else status = 'modified';
      // A write that left the bytes as they were is not a change worth showing.
      if (status === 'modified' && r.before.kind === 'file' && now === 'file') {
        const cur = await fs.readFileBuffer(r.path);
        if (sameBytes(cur, r.before.data)) status = null;
      }
      if (status) rows.push({ path: r.path, status, recs: [r], undone, dir: r.before.kind === 'dir' || now === 'dir' });
    }
    return rows;
  }

  // Map run id -> { id, afterItem, rows }, in the order the runs happened.
  async function describe() {
    const runs = new Map();
    for (const r of records) {
      if (r.hidden) continue; // made after a revert point (D12)
      if (!runs.has(r.run)) runs.set(r.run, { id: r.run, afterItem: r.afterItem, sub: r.sub, recs: [] });
      runs.get(r.run).recs.push(r);
    }
    for (const g of runs.values()) g.rows = await rowsOf(g.recs);
    return runs;
  }

  // Texts for a diff of one row: { original, current } or a reason it cannot be shown.
  async function texts(row) {
    const r = row.recs[0];
    if (row.dir) throw new Error('Folders have no text diff; Undo restores the whole folder.');
    if (r.before.kind === 'toolarge') throw new Error('This file was too large to keep a copy of, so there is nothing to compare.');
    const target = row.to ?? row.path;
    const current = (await kind(target)) === 'file' ? await fs.readFileBuffer(target) : new Uint8Array();
    const original = r.before.kind === 'file' ? r.before.data : new Uint8Array();
    if (original.includes(0) || current.includes(0)) throw new Error(target + ' looks binary; there is no text diff.');
    const dec = new TextDecoder();
    return { path: target, original: dec.decode(original), current: dec.decode(current) };
  }

  async function restore(rec) {
    const b = rec.before;
    if (b.kind === 'toolarge') throw new Error(`${rec.path} was too large to keep a copy of; it cannot be undone.`);
    const now = await kind(rec.path);
    if (b.kind === 'none') { if (now !== 'none') await fs.rm(rec.path, { recursive: true, force: true }); return; }
    if (now !== 'none' && (b.kind === 'dir' || now === 'dir')) await fs.rm(rec.path, { recursive: true, force: true });
    await fs.mkdir(parentOf(rec.path), { recursive: true });
    if (b.kind === 'file') await fs.writeFile(rec.path, b.data);
    else await extract(fs, parentOf(rec.path), b.entries);
  }

  // Paths among recs that changed after their run: a later run outside recs
  // touched them, or what is on disk differs from what the newest of recs
  // for that path left.
  async function drifted(recs) {
    const out = [], mine = new Set(recs.map((r) => r.seq)), newest = new Map();
    for (const r of recs) if (!r.undone && !(newest.get(r.path)?.seq > r.seq)) newest.set(r.path, r);
    for (const r of newest.values()) {
      const later = records.some((x) => x.path === r.path && x.seq > r.seq && !mine.has(x.seq) && !x.undone);
      if (later || (r.after && (await signature(fs, r.path)) !== r.after)) out.push(r.path);
    }
    return out;
  }

  // Restore before-states, newest first. ask(paths) confirms when some
  // changed since; it returns false to cancel.
  async function undo(recs, ask) {
    const todo = recs.filter((r) => !r.undone).sort((a, b) => b.seq - a.seq);
    const changed = await drifted(todo);
    if (changed.length && !(await ask(changed))) return false;
    for (const r of todo) {
      await restore(r);
      r.undone = true;
      await store.putChange(r);
    }
    vfs.changed();
    return true;
  }

  // ── Revert to here (D12) ──────────────────────────────────────────
  // A revert hides the records of everything the agent did after the point
  // (by time), and can undo their files first. It keeps what those files
  // held, so undoing the revert puts them back.

  // What a revert to time `ts` would take away: { recs, rows } of shown,
  // not yet undone changes made after it.
  // rows: one per path, { path, to?, statuses } in first-touch order.
  async function since(ts) {
    const recs = records.filter((r) => !r.hidden && r.ts > ts);
    const rows = [];
    for (const r of (await rowsOf(recs)).filter((x) => !x.undone)) {
      const same = rows.find((x) => x.path === r.path && x.to === r.to);
      if (same) { if (!same.statuses.includes(r.status)) same.statuses.push(r.status); }
      else rows.push({ path: r.path, to: r.to, statuses: [r.status] });
    }
    return { recs, rows };
  }

  // Hide recs; with undoFiles, first undo the live ones (ask(paths) as in
  // undo()). Resolves to a token for unhide(), or null when cancelled.
  async function hide(recs, undoFiles, ask) {
    const live = undoFiles ? recs.filter((r) => !r.undone) : [];
    const paths = [...new Set(live.map((r) => r.path))];
    const kept = [];
    for (const path of paths) kept.push({ path, state: await snapshot(fs, path) });
    if (live.length && !(await undo(live, ask))) return null;
    for (const k of kept) k.sig = await signature(fs, k.path);
    for (const r of recs) { r.hidden = true; await store.putChange(r); }
    return { seqs: recs.map((r) => r.seq), undid: live.map((r) => r.seq), files: kept };
  }

  // Undo a revert's file side: put back what hide() kept, after asking
  // when a file changed since the revert. False when cancelled.
  async function unhide(token, ask) {
    const drift = [];
    for (const f of token.files) if ((await signature(fs, f.path)) !== f.sig) drift.push(f.path);
    if (drift.length && !(await ask(drift))) return false;
    for (const f of token.files) await restore({ path: f.path, before: f.state });
    const all = await store.changesFor(token.session ?? loaded);
    for (const r of all) {
      if (!token.seqs.includes(r.seq)) continue;
      r.hidden = false;
      if (token.undid.includes(r.seq)) r.undone = false;
      await store.putChange(r);
      const mine = records.find((x) => x.seq === r.seq);
      if (mine) Object.assign(mine, { hidden: false, undone: r.undone });
    }
    if (token.files.length) vfs.changed();
    return true;
  }

  return {
    begin, end, endSub, beforeChange, load, describe, texts, undo, unseen, since, hide, unhide,
    get active() { return run; },
    forget: (session) => store.deleteChanges(session),
  };
}
