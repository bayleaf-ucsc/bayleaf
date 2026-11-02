// Agent graphs (JOURNEYS G1-G12): the routing state of one session, its
// main agent and its subagents, which message each other by handle (main is
// a1, subagents a2, a3, ... in spawn order; LANGUAGE.md "Handles"). Pure
// bookkeeping, no pi-durable: subagents.ts does the delivery and calls in here to
//
// - admit a message under the caps (per user turn: the whole session, and each
//   pair of agents in either direction), so a graph cannot ping-pong away
//   the allowance; a refusal is a sentence for the sender, never a drop;
// - remember, per (sender, target), the target's result number when the
//   sender last messaged it, so a `join` after a `message` waits for a result
//   newer than that message and never returns the stale answer;
// - hold blocking calls (a `join`, a foreground spawn): a join resolves when
//   every target is ready (all joiners of one target in the same tick), a
//   join that would close a cycle of blocked agents is refused, and the
//   user can detach main's holds (G10, G12): the call returns, the subagents
//   keep running.
//
// Message content never passes through here: it is delivered as an entry in
// the recipient's conversation (one path for every sender).
export const MAIN = 'a1';
export const MAX_SCOPE_MESSAGES = 40; // per user turn, all agents of the session together
export const MAX_PAIR_MESSAGES = 8;   // per user turn, between two agents, both directions

// Handles. Builds before the realignment (2026-10-31) stored s1, s2, ...;
// asRef reads either form (and an agent that copies an old tag from its
// context), migrateRows upgrades a registry as it is read, so stored rows,
// edge counts and wake marks become a-handles the next time they are written.
// A session-local agent handle: 'a1' (main), 'a2', ... (LANGUAGE.md "Handles").
export type Handle = string;
// The fields of a stored subagent row that carry handles; rows have more.
export interface HandleRow { ref?: Handle; sent?: Record<Handle, number>; got?: Record<Handle, number>; wokenBy?: Handle; to?: Handle; lastSent?: { to?: string } }
export const asRef = (x: unknown): Handle => { const s = String(x ?? ''); const m = /^s(\d+)$/i.exec(s.trim()); return m ? 'a' + m[1] : s; };
export const refOf = <R extends { ref?: Handle }>(l: readonly R[], c: R): Handle => asRef(c.ref ?? `a${l.indexOf(c) + 2}`);
// A child by handle (a3, s3) or by its conversation id, which arrives as a number or as text from a path.
export const findChild = <R extends { ref?: Handle; id: unknown }>(l: readonly R[], ref: unknown): R | undefined =>
  l.find((x) => refOf(l, x) === asRef(ref)) ?? l.find((x) => String(x.id) === String(ref));
// A stored label ("main (s1)", "chair (s2)") with its handles upgraded.
export const relabel = <T>(t: T): T => (typeof t === 'string' ? t.replace(/\(s(\d+)\)/g, '(a$1)') as T : t);
const rekey = <V>(o: Record<string, V> | undefined) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [asRef(k), v])) : o);
// Stored data: anything that is not an array passes through untouched.
export function migrateRows<R extends HandleRow>(l: R[]): R[] {
  if (!Array.isArray(l)) return l;
  return l.map((c, i) => ({ ...c, ref: asRef(c.ref ?? `a${i + 2}`), ...(c.sent ? { sent: rekey(c.sent) } : {}), ...(c.got ? { got: rekey(c.got) } : {}),
    ...(c.wokenBy ? { wokenBy: asRef(c.wokenBy) } : {}), ...(c.to ? { to: asRef(c.to) } : {}),
    ...(c.lastSent?.to ? { lastSent: { ...c.lastSent, to: relabel(c.lastSent.to) } } : {}) }));
}
export const JOIN_DEFAULT_S = 300;
export const JOIN_MAX_S = 1800;

export type HoldKind = 'join' | 'spawn';
// How a hold ends; release() may pass any of these (a detach without pending, which it fills in).
export type HoldResult = { type: 'ready' } | { type: 'timeout'; pending: Handle[] } | { type: 'detached'; pending: Handle[]; note: string }
  | { type: 'aborted' } | { type: 'done' };
export type HoldRelease = Exclude<HoldResult, { type: 'detached' }> | { type: 'detached'; note: string };
export interface HoldOptions { kind?: HoldKind; ids: Handle[]; ready?: (id: Handle) => boolean; timeoutMs?: number; signal?: AbortSignal }
// A blocking call in progress.
interface Hold {
  waiter: Handle; kind: HoldKind; ids: Handle[]; ready: (id: Handle) => boolean; resolve: (r: HoldResult) => void;
  signal?: AbortSignal; since: number; onAbort?: () => void; timer?: ReturnType<typeof setTimeout>;
}
export type HoldView = Pick<Hold, 'kind' | 'ids' | 'since'>;
export type Scope = ReturnType<typeof createScope>;

export function createScope() {
  let total = 0;
  const pairs = new Map<string, number>(); // "a|b" (sorted) -> messages this user turn
  const sent = new Map<string, number>();  // "from>to" -> target's result number when `from` last messaged it
  const holds = new Set<Hold>(); // blocking calls in progress
  const of = (waiter: Handle) => [...holds].filter((h) => h.waiter === waiter);
  const pendingOf = (h: Hold) => h.ids.filter((id) => !h.ready(id));

  function finish(h: Hold, result: HoldResult) {
    if (!holds.has(h)) return;
    holds.delete(h);
    clearTimeout(h.timer);
    h.signal?.removeEventListener('abort', h.onAbort!);
    h.resolve(result);
  }

  return {
    // The user spoke to main: the caps start over.
    newTurn() { total = 0; pairs.clear(); },
    usage: () => ({ total, pairs: Object.fromEntries(pairs) }),
    // null when admitted (and counted), else why not, for the sender.
    admit(from: Handle, to: Handle): string | null {
      if (total >= MAX_SCOPE_MESSAGES) return `Not sent: the agents of this session have sent ${MAX_SCOPE_MESSAGES} messages since the user last wrote to main, the limit. Finish with what you have; the user can let the graph continue by writing to main.`;
      const k = [from, to].sort().join('|'), n = pairs.get(k) ?? 0;
      if (n >= MAX_PAIR_MESSAGES) return `Not sent: ${from} and ${to} have exchanged ${MAX_PAIR_MESSAGES} messages since the user last wrote to main, the limit for one pair. Stop the exchange and send your conclusion to whoever asked.`;
      pairs.set(k, n + 1);
      total++;
      return null;
    },
    // Refund an admitted message that could not be delivered after all.
    undo(from: Handle, to: Handle) {
      const k = [from, to].sort().join('|');
      if (pairs.get(k)) { pairs.set(k, pairs.get(k)! - 1); total--; }
    },
    // `from` messaged `to` while `to` had produced `seq` results.
    markSent(from: Handle, to: Handle, seq: number) { sent.set(`${from}>${to}`, seq); },
    // The result number a join by `from` on `to` must exceed (-1: any).
    sentSeq: (from: Handle, to: Handle) => sent.get(`${from}>${to}`) ?? -1,

    // The blocked agents a join from `waiter` on `ids` would close a cycle
    // with, as a path [waiter, ..., waiter], or null. Edges: every hold
    // (join or foreground spawn) from its waiter to each of its ids.
    cycle(waiter: Handle, ids: Handle[]): Handle[] | null {
      const next = (w: Handle) => [...holds].filter((h) => h.waiter === w).flatMap((h) => h.ids);
      const seen = new Set<Handle>();
      const walk = (at: Handle, path: Handle[]): Handle[] | null => {
        if (at === waiter) return path;
        if (seen.has(at)) return null;
        seen.add(at);
        for (const n of next(at)) { const p = walk(n, [...path, n]); if (p) return p; }
        return null;
      };
      for (const id of ids) { const p = walk(id, [waiter, id]); if (p) return p; }
      return null;
    },

    // Block `waiter` on `ids` (one waiter may hold several: parallel calls).
    // kind 'join' resolves by itself once ready(id) holds for every id;
    // kind 'spawn' only by release(). Resolves to { type: 'ready' }
    //   | { type: 'timeout', pending } | { type: 'detached', pending, note } | { type: 'aborted' } | release()'s result
    hold(waiter: Handle, { kind = 'join', ids, ready = () => false, timeoutMs, signal }: HoldOptions) {
      return new Promise<HoldResult>((resolve) => {
        const h: Hold = { waiter, kind, ids: [...new Set(ids)], ready, resolve, signal, since: Date.now() };
        if (signal?.aborted) return resolve({ type: 'aborted' });
        h.onAbort = () => finish(h, { type: 'aborted' });
        signal?.addEventListener('abort', h.onAbort, { once: true });
        if (timeoutMs) h.timer = setTimeout(() => finish(h, { type: 'timeout', pending: pendingOf(h) }), timeoutMs);
        holds.add(h);
        this.check(waiter);
      });
    },
    // What `waiter` is blocked on: { kind, ids, since } per call, [] if nothing.
    held: (waiter: Handle): HoldView[] => of(waiter).map((h) => ({ kind: h.kind, ids: h.ids, since: h.since })),
    // Every agent blocked on `id` (its joiners), for the views.
    joinersOf: (id: Handle) => [...holds].filter((h) => h.ids.includes(id)).map((h) => h.waiter),
    // Re-evaluate joins (after a state change): every ready one resolves now,
    // so several joiners of one target are released together.
    check(waiter: Handle) {
      for (const h of of(waiter)) if (h.kind === 'join' && h.ids.every((id) => h.ready(id))) finish(h, { type: 'ready' });
    },
    checkAll() { for (const w of new Set([...holds].map((h) => h.waiter))) this.check(w); },
    // End a waiter's holds early: the user detached them (note says how), or
    // only those that match (a foreground spawn whose child finished).
    release(waiter: Handle, result: HoldRelease, match: (h: HoldView) => boolean = () => true) {
      const hs = of(waiter).filter(match);
      for (const h of hs) finish(h, result.type === 'detached' ? { ...result, pending: pendingOf(h).length ? pendingOf(h) : h.ids } : result);
      return hs.length;
    },
  };
}
