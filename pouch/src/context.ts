// How much context a session holds (LANGUAGE.md "Context"): about how many
// tokens the model would receive if you sent now, so a person can decide when
// to compact (/compact). Computed in the page from what is already stored:
// no request, no tokenizer download, nothing leaves the device for it.
//
// Two parts, the way pi-durable sizes a request for its own compaction
// (pi-durable estimateContext, spec §8.3):
//   measured  the newest reply's own usage as its provider reported it
//             (prompt, cached prompt and reply tokens): exact for that request,
//             system prompt and tool schemas included
//   added     everything after that reply (tool results, your next message,
//             a compaction summary), estimated at 3.5 characters a token
//             (pi-ai's estimateMessageTokens), so it is approximate
// A reply from before the newest compaction or reset says nothing about the
// context now, so it is never the measured part. With no measured reply at all
// (a new session, a server that reports no usage) everything is estimated,
// the system prompt and tool schemas included (they are stored entries).
//
// Transformers.js (LFM3) differs: its provider fits each request into BUDGET
// tokens by leaving out older turns (src/local/worker.ts fit()), and says how
// many it left out (message.contextTrimmed). Its measured part is what the
// model actually saw, which is less than the session holds once trimming starts.
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { PouchEntry } from './agent-types.ts';

const HEADS = new Set(['pi.compaction', 'pi.reset']);

// entries: a conversation view's active entries (pi-durable ConversationView.entries:
// the head marker, if any, then everything after it).
//   exact      nothing was added since the measured reply (tokens is the provider's figure)
//   trimmed    parts the Transformers.js provider left out of the measured request (0 elsewhere)
//   compacted  the context starts from a compaction summary
//   full       only when trimmed: every active entry estimated, which is what
//              another provider would be sent (contextFor)
export interface ContextSize { tokens: number; measured: number; added: number; exact: boolean; trimmed: number; compacted: boolean; full?: number }
export function contextOf(entries: readonly PouchEntry[] = []): ContextSize {
  // Kept turns follow the head but are older than it (lower ids): their usage
  // predates the summary, so, as in pi-durable, only entries newer than the head are measured.
  const head = HEADS.has(entries[0]?.kind) ? entries[0].id : null;
  // at: the measured reply's entry; k: its index among that entry's messages.
  let at = -1, k = -1, msg: AssistantMessage | undefined;
  for (let i = entries.length - 1; i >= 0 && !msg; i--) {
    if (head != null && (i === 0 || entries[i].id <= head)) continue;
    const ms = entries[i].model ?? [];
    k = ms.findLastIndex((x) => x?.role === 'assistant' && x.stopReason !== 'error' && x.stopReason !== 'aborted' && x.usage && calculateContextTokens(x.usage) > 0);
    const m = ms[k];
    if (m?.role === 'assistant') { msg = m; at = i; }
  }
  let added = 0;
  for (let i = 0; i < entries.length; i++) {
    const ms = entries[i].model ?? [];
    if (i < at) continue;
    for (const m of i === at ? ms.slice(k + 1) : ms) if (m?.role) added += estimateMessageTokens(m);
  }
  const measured = msg ? calculateContextTokens(msg.usage) : 0;
  // Transformers.js (src/local/provider.ts) adds contextTrimmed to its replies.
  const trimmed = msg && 'contextTrimmed' in msg && typeof msg.contextTrimmed === 'number' ? msg.contextTrimmed : 0;
  const full = trimmed ? entries.reduce((n, e) => n + (e.model ?? []).reduce((t, m) => t + (m?.role ? estimateMessageTokens(m) : 0), 0), 0) : undefined;
  return { tokens: measured + added, measured, added, exact: !!msg && added === 0, trimmed, compacted: entries[0]?.kind === 'pi.compaction', ...(full != null && { full }) };
}

// The context as the picked provider would receive it: away from Transformers.js,
// the turns it left out go along again, so a trimmed measurement undercounts.
export const contextFor = (ctx: ContextSize | null | undefined, local: boolean) => (ctx?.full != null && !local ? { ...ctx, tokens: ctx.full, measured: 0, added: ctx.full, exact: false, trimmed: 0 } : ctx);

// "812", "12.4k", "98k", "1.2M": short enough for the composer toolbar.
// window: a power-of-two window reads as people name it (131,072 is "128k",
// 4,096 is "4k", 1,048,576 is "1M"); the label spells out the exact figure.
export function short(n: number | null | undefined, window = false) {
  if (n == null) return '?';
  if (window && n >= 1024 && n % 1024 === 0) return n % 1_048_576 === 0 ? n / 1_048_576 + 'M' : n / 1024 + 'k';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) { const k = n / 1000; return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)) + 'k'; }
  const m = n / 1e6; return (m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)) + 'M';
}

// Where Pouch compacts by itself, for a window (src/agent.ts compactionFor):
// background summarizing starts here. null for Transformers.js, which never
// compacts by itself (it trims instead).
export function autoCompactAt(window: number | null | undefined, compaction: { reserveTokens: number; backgroundTokens: number } | null | undefined) {
  if (!window || !compaction) return null;
  return window - compaction.reserveTokens - compaction.backgroundTokens;
}

// What the meter says. ctx: contextOf(); window: the next request's model's
// window in tokens, or null when unknown; budget: Transformers.js's BUDGET
// when the next turn runs there (then window is the budget); auto: autoCompactAt().
// level is 'ok', 'near' or 'over'.
export interface ContextMeter { text: string; count: string; of: string | null; label: string; level: 'ok' | 'near' | 'over'; fill: number | null }
export function describe(ctx: ContextSize | null | undefined, { window = null, budget = null, auto = null }: { window?: number | null; budget?: number | null; auto?: number | null } = {}): ContextMeter | null {
  if (!ctx) return null;
  const approx = !ctx.exact, n = ctx.tokens;
  const count = (approx ? '~' : '') + short(n);
  const limit = budget ?? window;
  const text = limit ? `${count} / ${short(limit, true)}` : count;
  const fill = limit ? Math.max(0, Math.min(1, n / limit)) : null;
  const parts = [];
  parts.push(`Context: ${approx ? 'about ' : ''}${n.toLocaleString()} tokens${limit ? ` of ${budget ? 'the Transformers.js model\'s ' + budget.toLocaleString() + '-token budget' : 'a ' + limit.toLocaleString() + '-token window'}` : ' (this model\'s window is unknown)'}`);
  if (ctx.measured && ctx.added) parts.push(`${ctx.measured.toLocaleString()} as the last reply's server reported, plus about ${ctx.added.toLocaleString()} estimated since`);
  else if (ctx.measured) parts.push('as the last reply\'s server reported');
  else if (n) parts.push('estimated from text length: no reply has reported usage yet');
  if (ctx.compacted) parts.push('starts from a compaction summary');
  let level: ContextMeter['level'] = 'ok';
  if (budget) {
    if (ctx.trimmed) { level = 'over'; parts.push('the model is not seeing the whole conversation: its last request left out older turns or cut tool results to fit. /compact summarizes older turns; a new session starts clean'); }
    else if (n > budget) { level = 'over'; parts.push('your next message will leave out older turns to fit. /compact summarizes them first'); }
    else if (n > budget * 0.75) { level = 'near'; parts.push('near the budget: older turns will soon be left out. /compact summarizes them'); }
  } else if (auto && n >= auto) { level = 'over'; parts.push(`past the point where Pouch compacts by itself (about ${short(auto)}); it summarizes older turns at the next step`); }
  else if (auto && n >= auto * 0.75) { level = 'near'; parts.push(`Pouch compacts by itself at about ${short(auto)}; /compact does it now`); }
  else if (window && n >= window * 0.75) level = 'near';
  // count and of: the two halves of text, so a phone can drop the window.
  return { text, count, of: limit ? short(limit, true) : null, label: parts.join('; ') + '.', level, fill };
}
