// Agent graphs (JOURNEYS G1-G12): the routing state of one scope, a
// top-level session and its subagents, which message each other by short id
// (main is s1, children s2, s3, ... in spawn order). Pure bookkeeping, no
// pi-durable: subagents.js does the delivery and calls in here to
//
// - admit a message under the caps (per user turn: the whole scope, and each
//   pair of sessions in either direction), so a graph cannot ping-pong away
//   the allowance; a refusal is a sentence for the sender, never a drop;
// - remember, per (sender, target), the target's result number when the
//   sender last messaged it, so a `join` after a `message` waits for a result
//   newer than that message and never returns the stale answer;
// - hold blocking calls (a `join`, a foreground spawn): a join resolves when
//   every target is ready (all joiners of one target in the same tick), a
//   join that would close a cycle of blocked sessions is refused, and the
//   user can detach main's holds (G10, G12): the call returns, the subagents
//   keep running.
//
// Message content never passes through here: it is delivered as an entry in
// the recipient's conversation (one path for every sender).
export const MAIN = 's1';
export const MAX_SCOPE_MESSAGES = 40; // per user turn, all sessions of the scope together
export const MAX_PAIR_MESSAGES = 8;   // per user turn, between two sessions, both directions
export const JOIN_DEFAULT_S = 300;
export const JOIN_MAX_S = 1800;

export function createScope() {
  let total = 0;
  const pairs = new Map(); // "a|b" (sorted) -> messages this user turn
  const sent = new Map();  // "from>to" -> target's result number when `from` last messaged it
  const holds = new Set(); // { waiter, kind, ids, ready, ... }: blocking calls in progress
  const of = (waiter) => [...holds].filter((h) => h.waiter === waiter);
  const pendingOf = (h) => h.ids.filter((id) => !h.ready(id));

  function finish(h, result) {
    if (!holds.has(h)) return;
    holds.delete(h);
    clearTimeout(h.timer);
    h.signal?.removeEventListener('abort', h.onAbort);
    h.resolve(result);
  }

  return {
    // The user spoke to main: the caps start over.
    newTurn() { total = 0; pairs.clear(); },
    usage: () => ({ total, pairs: Object.fromEntries(pairs) }),
    // null when admitted (and counted), else why not, for the sender.
    admit(from, to) {
      if (total >= MAX_SCOPE_MESSAGES) return `Not sent: this scope has sent ${MAX_SCOPE_MESSAGES} messages since the user last wrote to main, the limit. Finish with what you have; the user can let the graph continue by writing to main.`;
      const k = [from, to].sort().join('|'), n = pairs.get(k) ?? 0;
      if (n >= MAX_PAIR_MESSAGES) return `Not sent: ${from} and ${to} have exchanged ${MAX_PAIR_MESSAGES} messages since the user last wrote to main, the limit for one pair. Stop the exchange and send your conclusion to whoever asked.`;
      pairs.set(k, n + 1);
      total++;
      return null;
    },
    // Refund an admitted message that could not be delivered after all.
    undo(from, to) {
      const k = [from, to].sort().join('|');
      if (pairs.get(k)) { pairs.set(k, pairs.get(k) - 1); total--; }
    },
    // `from` messaged `to` while `to` had produced `seq` results.
    markSent(from, to, seq) { sent.set(`${from}>${to}`, seq); },
    // The result number a join by `from` on `to` must exceed (-1: any).
    sentSeq: (from, to) => sent.get(`${from}>${to}`) ?? -1,

    // The blocked sessions a join from `waiter` on `ids` would close a cycle
    // with, as a path [waiter, ..., waiter], or null. Edges: every hold
    // (join or foreground spawn) from its waiter to each of its ids.
    cycle(waiter, ids) {
      const next = (w) => [...holds].filter((h) => h.waiter === w).flatMap((h) => h.ids);
      const seen = new Set();
      const walk = (at, path) => {
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
    hold(waiter, { kind = 'join', ids, ready = () => false, timeoutMs, signal }) {
      return new Promise((resolve) => {
        const h = { waiter, kind, ids: [...new Set(ids)], ready, resolve, signal, since: Date.now() };
        if (signal?.aborted) return resolve({ type: 'aborted' });
        h.onAbort = () => finish(h, { type: 'aborted' });
        signal?.addEventListener('abort', h.onAbort, { once: true });
        if (timeoutMs) h.timer = setTimeout(() => finish(h, { type: 'timeout', pending: pendingOf(h) }), timeoutMs);
        holds.add(h);
        this.check(waiter);
      });
    },
    // What `waiter` is blocked on: { kind, ids, since } per call, [] if nothing.
    held: (waiter) => of(waiter).map((h) => ({ kind: h.kind, ids: h.ids, since: h.since })),
    // Every session blocked on `id` (its joiners), for the views.
    joinersOf: (id) => [...holds].filter((h) => h.ids.includes(id)).map((h) => h.waiter),
    // Re-evaluate joins (after a state change): every ready one resolves now,
    // so several joiners of one target are released together.
    check(waiter) {
      for (const h of of(waiter)) if (h.kind === 'join' && h.ids.every((id) => h.ready(id))) finish(h, { type: 'ready' });
    },
    checkAll() { for (const w of new Set([...holds].map((h) => h.waiter))) this.check(w); },
    // End a waiter's holds early: the user detached them (note says how), or
    // only those that match (a foreground spawn whose child finished).
    release(waiter, result, match = () => true) {
      const hs = of(waiter).filter(match);
      for (const h of hs) finish(h, result.type === 'detached' ? { ...result, pending: pendingOf(h).length ? pendingOf(h) : h.ids } : result);
      return hs.length;
    },
  };
}
