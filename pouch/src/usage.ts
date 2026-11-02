// Today's BayLeaf Sealed allowance (story A6). Every model step Pouch takes is one
// Sealed request against a daily budget: each tool round, each compaction
// summary and each automatic title. With a key the budget is the key's own;
// under Campus Pass it is one approximate bucket shared by everyone behind
// the same campus network address. Checked on load, on sign-in and sign-out,
// and after each run settles; never polled. These calls carry the credential
// and nothing else: no prompt or file content.
//
// Unknown is never zero: a failed check leaves remaining null, shown as "?".
import { $, el } from './dom.ts';
import { campusPass, usageOf } from './bayleaf-api.ts';

// The allowance as last checked; remaining and limit are null when unknown.
export interface Allowance {
  mode: 'unknown' | 'key' | 'campus'; remaining: number | null; limit: number | null; used?: number | null;
  resetsAt?: Date | null; approximate?: boolean; offCampus?: boolean; error?: string;
}
// Today's request ledger (createLedger).
export interface Ledger {
  day: string; bySid: Record<string, number>; kinds: Record<string, number>;
  seen: { remaining: number; counted: number; at: number } | null; outside: { down: number; up: number; at: number | null }; carry: number;
}
// One row of the Usage panel's table.
export interface UsageRow { title: string; input?: number; output?: number; cost?: number; requests?: number; current?: boolean; subagents?: number }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const budget = (b: { remaining?: unknown; limit?: unknown; used?: unknown; resets_at?: string } | undefined) => ({ remaining: num(b?.remaining), limit: num(b?.limit), used: num(b?.used), resetsAt: b?.resets_at ? new Date(b.resets_at) : null });

export function createUsage({ getKey }: { getKey(): string | null | undefined }) {
  let state: Allowance = { mode: 'unknown', remaining: null, limit: null };
  let gen = 0;
  const subs = new Set<(s: Allowance) => void>();
  async function refresh() {
    const g = ++gen, key = getKey();
    let next: Allowance;
    try {
      if (key) {
        const r = await usageOf(key);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const sealed = j.budgets?.find((b: { provider?: string }) => b.provider === 'sealed');
        next = { mode: 'key', ...budget(sealed) };
      } else {
        const r = await campusPass();
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        next = j.campus_network && j.enabled !== false
          ? { mode: 'campus', approximate: j.quota?.approximate !== false, ...budget(j.quota) }
          : { mode: 'campus', offCampus: !j.campus_network, remaining: null, limit: null };
      }
    } catch (e) {
      next = { mode: key ? 'key' : 'campus', error: (e as Error).message, remaining: null, limit: null };
    }
    if (g === gen) { state = next; for (const f of subs) f(state); }
    return state;
  }
  return {
    refresh,
    get state() { return state; },
    subscribe(fn: (s: Allowance) => void) { subs.add(fn); fn(state); return () => subs.delete(fn); },
  };
}

// A pasted line like BAYLEAF_API_KEY=sk-bayleaf-... still yields the key.
// Today's request ledger: every Sealed request Pouch sends, counted as it
// leaves and attributed to a session (turns, subagents, one-shots, titles,
// compactions, and requests a Stop cut short but BayLeaf had received). The
// transcript cannot say this: a revert folds turns away and a title is not
// in it.
//
// The allowance itself is outside state: the same key works in other tools
// and on other devices, a top-up or a daily reset raises it, so it can move
// either way under Pouch. The ledger never reconciles the two into an
// "Other" figure. It only notes, between two checks of the allowance, how
// far it moved beyond what this browser sent then (outside: { down, up, at }).
// dayOf(): the current allowance day (a string).
export function createLedger(storage: { get(): Promise<Ledger | null | undefined>; set(v: Ledger): Promise<void> | void }, dayOf: () => string | null | undefined) {
  let led = null as Ledger | null;
  // dayOf() is null while the allowance is unknown: keep counting into the current day.
  const fresh = (): Ledger => ({ day: dayOf() ?? new Date().toDateString(), bySid: {}, kinds: {}, seen: null, outside: { down: 0, up: 0, at: null }, carry: 0 });
  const total = (l: Ledger) => Object.values(l.bySid).reduce((a, b) => a + b, 0);
  async function load() {
    led ??= (await storage.get().catch(() => null)) ?? fresh();
    const d = dayOf();
    if (d && led.day !== d) led = fresh();
    return led;
  }
  let saving = Promise.resolve();
  return {
    async add(sid: unknown, kind = 'turn') {
      const l = await load();
      const k = String(sid ?? 'new');
      l.bySid[k] = (l.bySid[k] ?? 0) + 1;
      l.kinds[kind] = (l.kinds[kind] ?? 0) + 1;
      saving = saving.then(() => storage.set(l)).catch(() => {});
    },
    // A first message counts under 'new' until its session exists.
    async adopt(from: unknown, to: unknown) {
      const l = await load(), a = String(from), b = String(to);
      if (a === b || !l.bySid[a]) return;
      l.bySid[b] = (l.bySid[b] ?? 0) + l.bySid[a]; delete l.bySid[a];
      saving = saving.then(() => storage.set(l)).catch(() => {});
    },
    // A fresh allowance figure. The move since the last one, less what this
    // browser sent in between, happened outside it. A request still in flight
    // can be counted before BayLeaf books it, so a rise no larger than what
    // was sent in between is carried to the next check, not reported.
    async observe(remaining: number | null | undefined, at = Date.now()) {
      if (remaining == null) return;
      const l = await load();
      l.outside ??= { down: 0, up: 0, at: null }; l.carry ??= 0;
      const n = total(l);
      if (l.seen) {
        const sent = n - l.seen.counted;
        const d = l.seen.remaining - remaining - sent + l.carry;
        l.carry = 0;
        if (d < 0 && -d <= sent) l.carry = d;
        else if (d) { l.outside[d > 0 ? 'down' : 'up'] += Math.abs(d); l.outside.at = at; }
      }
      l.seen = { remaining, counted: n, at };
      saving = saving.then(() => storage.set(l)).catch(() => {});
    },
    snapshot: async () => structuredClone(await load()),
  };
}
export const counted = (led: Ledger | null | undefined) => Object.values(led?.bySid ?? {}).reduce((a, b) => a + b, 0);
// "down 3 and up 120", or null when nothing moved outside this browser.
export function outsideText(led: Ledger | null | undefined) {
  const o = led?.outside;
  const parts = [o?.down && `down ${fmt(o.down)}`, o?.up && `up ${fmt(o.up)}`].filter(Boolean);
  return parts.length ? parts.join(' and ') : null;
}

export const extractKey = (text: unknown) => /sk-bayleaf-[A-Za-z0-9_-]+/.exec(String(text ?? ''))?.[0] ?? null;
export const fraction = (s: Allowance) => (s.remaining != null && s.limit ? Math.max(0, Math.min(1, s.remaining / s.limit)) : null);
const isLow = (s: Allowance) => { const f = fraction(s); return f != null && f < 0.1; };

// "5:00 PM", or "Thu 5:00 PM" when the reset is not today, in the user's zone.
export function resetText(d: Date | null | undefined) {
  if (!d || Number.isNaN(d.getTime())) return null;
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function exhaustedText(s: Allowance) {
  const at = resetText(s.resetsAt);
  const when = at ? ` It resets at ${at} (your time).` : ' It resets daily.';
  return s.mode === 'campus'
    ? `This network's shared Campus Pass allowance is used up for today.${when} Signing in gives you your own allowance.`
    : `Today's BayLeaf Sealed allowance for your key is used up.${when}`;
}

// The rail's Usage icon (a small bar and the number left) and the
// composer's compact copy of it (the number).
// led: today's ledger, for the tooltip's "this browser today" line.
export function renderMeter(s: Allowance, led: Ledger | null = null) {
  const f = fraction(s);
  // Off campus without a key: nothing can be sent, so 0, not "?" (or 100).
  const off = s.mode === 'campus' && s.offCampus;
  const out = outsideText(led);
  const label = off ? 'Off campus: Campus Pass does not work on this network. Sign in to send.' : (s.remaining == null ? 'Allowance: remaining requests unknown'
    : `Allowance: ${s.mode === 'campus' ? 'about ' : ''}${s.remaining} of ${s.limit} BayLeaf Sealed requests left today${s.mode === 'campus' ? ' (shared on this network)' : ' (for this key, wherever it is used)'}`)
    + (led ? `. This browser today: ${fmt(counted(led))} sent` : '') + (out ? `. Changed outside this browser: ${out}` : '');
  // The composer's state sits on its allowance reading (the button also holds the context one).
  for (const [id, part, num] of [['rail-usage', 'rail-usage', 'usage-num'], ['composer-usage', 'composer-allow', 'composer-usage-num']]) {
    const b = $(id), r = $(part);
    if (!b || !r) continue;
    r.classList.toggle('low', isLow(s));
    r.classList.toggle('unknown', f == null && !off);
    r.style.setProperty('--fill', f == null ? '0%' : `${Math.round(f * 100)}%`);
    $(num).textContent = off ? '0' : s.remaining == null ? '?' : String(s.remaining);
    if (id === 'composer-usage') { b.dataset.allow = label; labelComposer(); } else { b.ariaLabel = label; b.title = label; }
  }
}

// The composer's one Usage button names both readings: the allowance (above) and
// the context, which src/interface/queues.ts renderCtx leaves in data-ctx (absent when hidden).
export function labelComposer() {
  const b = $('composer-usage');
  if (!b) return;
  const allow = b.dataset.allow ?? 'Allowance: remaining requests unknown', ctx = b.dataset.ctx;
  b.title = `${allow}.${ctx ? ' ' + ctx : ''}`;
  b.ariaLabel = `Usage. ${b.title} Opens Usage.`;
}

const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString();

// rows: [{ title, input, output, cost, current }] for the token table; led: today's ledger.
export function renderPanel(host: HTMLElement, s: Allowance, rows: UsageRow[], led: Ledger | null = null) {
  const out: HTMLElement[] = [];
  const f = fraction(s);
  const box = el('div', { className: 'quota' + (isLow(s) ? ' low' : '') });
  if (s.remaining == null) {
    box.append(el('div', { className: 'big', textContent: '?' }), el('p', { textContent:
      s.offCampus ? 'Not on the UCSC network, so Campus Pass does not apply here. Sign in (the key icon) to use your own allowance.'
      : s.error ? `Could not check the allowance (${s.error}). That means unknown, not zero.`
      : 'Checking...' }));
  } else {
    const bar = el('div', { className: 'bar' }, el('span'));
    bar.style.setProperty('--fill', `${Math.round(f! * 100)}%`);
    bar.role = 'img'; bar.ariaLabel = `${Math.round(f! * 100)}% left`;
    box.append(
      el('div', { className: 'big' }, `${s.mode === 'campus' ? 'about ' : ''}${s.remaining}`, el('small', { textContent: ` of ${s.limit} left today` })),
      bar,
      el('p', { textContent: s.mode === 'campus'
        ? `About ${s.remaining} BayLeaf Sealed requests left on this network today, shared with everyone behind the same campus network address (Campus Pass).`
        : 'BayLeaf Sealed requests left today for your personal key.' }),
    );
    const at = resetText(s.resetsAt);
    if (at) box.append(el('p', { className: 'muted', textContent: `Resets at ${at} (your time).` }));
    const out = outsideText(led);
    if (out) box.append(el('p', { className: 'outside', textContent: `Changed outside this browser: ${out} since ${new Date(led!.outside.at!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} or earlier today. ${s.mode === 'campus' ? 'Others on this network share it' : 'This key is also used elsewhere, or the allowance was reset or raised'}; the number above is the allowance as BayLeaf reports it.` }));
  }
  out.push(box);
  out.push(el('p', { textContent: 'Each model step uses one request: every tool round in a turn, every compaction summary, and every automatic title of a BayLeaf Sealed session. A turn that reads two files and then replies takes three.' }));
  out.push(el('h3', { textContent: 'Today by session' }));
  const shown = rows.filter((r) => r.input || r.output || r.requests);
  if (!shown.length) out.push(el('p', { className: 'muted', textContent: 'Nothing counted yet. Rows appear after a session\'s first turn.' }));
  else {
    const anyCost = shown.some((r) => r.cost! > 0);
    // Three columns fit the 320 px drawer: tokens ride under the session name.
    const head = el('tr', {}, el('th', { textContent: 'Session' }), el('th', { textContent: 'Requests', title: 'Requests sent today, counted as they left: turns, subagents, titles, compactions and stopped requests' }), ...(anyCost ? [el('th', { textContent: 'Cost' })] : []));
    const toks = (r: UsageRow) => r.input || r.output ? [el('span', { className: 'toks muted', textContent: `${fmt(r.input)} in, ${fmt(r.output)} out` })] : [];
    const row = (r: UsageRow, cls = '') => el('tr', { className: (r.current ? 'current ' : '') + cls },
      el('td', { title: r.subagents ? `${r.title} (with ${r.subagents} subagent${r.subagents > 1 ? 's' : ''})` : r.title }, el('span', { className: 'clamp', textContent: r.title }), ...toks(r)),
      el('td', { textContent: r.requests != null ? fmt(r.requests) : '' }),
      ...(anyCost ? [el('td', { textContent: r.cost! > 0 ? `$${r.cost!.toFixed(4)}` : '' })] : []));
    const body = shown.map((r) => row(r));
    if (led) body.push(row({ title: 'This browser today', requests: counted(led) }, 'total'));
    const cols = el('colgroup', {}, el('col'), ...Array.from({ length: anyCost ? 2 : 1 }, () => el('col', { className: 'n' })));
    out.push(el('div', { className: 'tokens-wrap' }, el('table', { className: 'tokens' + (anyCost ? ' cost' : '') }, cols, el('thead', {}, head), el('tbody', {}, ...body))));
    out.push(el('p', { className: 'muted', textContent: 'Requests are today\'s, counted as Pouch sent them, so reverted, stopped and deleted turns, subagents and automatic titles are all in. Tokens and cost are each session\'s running totals (an informational estimate). The allowance above is BayLeaf\'s own figure and can move for reasons outside this browser, so the two are not expected to add up.' }));
  }
  host.replaceChildren(...out);
}
