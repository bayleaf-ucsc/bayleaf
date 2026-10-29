// Today's Sealed allowance (story A6). Every model step Pouch takes is one
// Sealed request against a daily budget: each tool round, each compaction
// summary and each automatic title. With a key the budget is the key's own;
// under Campus Pass it is one approximate bucket shared by everyone behind
// the same campus network address. Checked on load, on sign-in and sign-out,
// and after each run settles; never polled. These calls carry the credential
// and nothing else: no prompt or file content.
//
// Unknown is never zero: a failed check leaves remaining null, shown as "?".
import { $, el } from './dom.js';

const API = 'https://api.bayleaf.dev';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const budget = (b) => ({ remaining: num(b?.remaining), limit: num(b?.limit), used: num(b?.used), resetsAt: b?.resets_at ? new Date(b.resets_at) : null });

export function createUsage({ getKey }) {
  let state = { mode: 'unknown', remaining: null, limit: null };
  let gen = 0;
  const subs = new Set();
  async function refresh() {
    const g = ++gen, key = getKey();
    let next;
    try {
      if (key) {
        const r = await fetch(API + '/usage', { headers: { Authorization: 'Bearer ' + key } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const sealed = j.budgets?.find((b) => b.provider === 'sealed');
        const std = j.budgets?.find((b) => b.provider === 'openrouter');
        next = { mode: 'key', ...budget(sealed), standard: std && { remaining: num(std.remaining), limit: num(std.limit), unit: std.unit } };
      } else {
        const r = await fetch(API + '/campus-pass');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        next = j.campus_network && j.enabled !== false
          ? { mode: 'campus', approximate: j.quota?.approximate !== false, ...budget(j.quota) }
          : { mode: 'campus', offCampus: !j.campus_network, remaining: null, limit: null };
      }
    } catch (e) {
      next = { mode: key ? 'key' : 'campus', error: e.message, remaining: null, limit: null };
    }
    if (g === gen) { state = next; for (const f of subs) f(state); }
    return state;
  }
  return {
    refresh,
    get state() { return state; },
    subscribe(fn) { subs.add(fn); fn(state); return () => subs.delete(fn); },
  };
}

export const fraction = (s) => (s.remaining != null && s.limit ? Math.max(0, Math.min(1, s.remaining / s.limit)) : null);
const isLow = (s) => { const f = fraction(s); return f != null && f < 0.1; };

// "5:00 PM", or "Thu 5:00 PM" when the reset is not today, in the user's zone.
export function resetText(d) {
  if (!d || Number.isNaN(d.getTime())) return null;
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function exhaustedText(s) {
  const at = resetText(s.resetsAt);
  const when = at ? ` It resets at ${at} (your time).` : ' It resets daily.';
  return s.mode === 'campus'
    ? `This network's shared Campus Pass allowance is used up for today.${when} Signing in gives you your own allowance.`
    : `Today's Sealed allowance for your key is used up.${when}`;
}

// The rail's Usage icon: a small bar and the number left.
export function renderMeter(s) {
  const b = $('rail-usage'), f = fraction(s);
  b.classList.toggle('low', isLow(s));
  b.classList.toggle('unknown', f == null);
  b.style.setProperty('--fill', f == null ? '0%' : `${Math.round(f * 100)}%`);
  $('usage-num').textContent = s.remaining == null ? '?' : String(s.remaining);
  const label = s.remaining == null ? 'Usage: remaining requests unknown'
    : `Usage: ${s.mode === 'campus' ? 'about ' : ''}${s.remaining} of ${s.limit} Sealed requests left today`;
  b.ariaLabel = label; b.title = label;
}

const fmt = (n) => (n ?? 0).toLocaleString();

// rows: [{ title, input, output, cost, current }] for the token table.
export function renderPanel(host, s, rows) {
  const out = [];
  const f = fraction(s);
  const box = el('div', { className: 'quota' + (isLow(s) ? ' low' : '') });
  if (s.remaining == null) {
    box.append(el('div', { className: 'big', textContent: '?' }), el('p', { textContent:
      s.offCampus ? 'Not on the UCSC network, so Campus Pass does not apply here. Sign in (the key icon) to use your own allowance.'
      : s.error ? `Could not check the allowance (${s.error}). That means unknown, not zero.`
      : 'Checking...' }));
  } else {
    const bar = el('div', { className: 'bar' }, el('span'));
    bar.style.setProperty('--fill', `${Math.round(f * 100)}%`);
    bar.role = 'img'; bar.ariaLabel = `${Math.round(f * 100)}% left`;
    box.append(
      el('div', { className: 'big' }, `${s.mode === 'campus' ? 'about ' : ''}${s.remaining}`, el('small', { textContent: ` of ${s.limit} left today` })),
      bar,
      el('p', { textContent: s.mode === 'campus'
        ? `About ${s.remaining} Sealed requests left on this network today, shared with everyone behind the same campus network address (Campus Pass).`
        : 'Sealed requests left today for your personal key.' }),
    );
    const at = resetText(s.resetsAt);
    if (at) box.append(el('p', { className: 'muted', textContent: `Resets at ${at} (your time).` }));
  }
  out.push(box);
  out.push(el('p', { textContent: 'Each model step uses one request: every tool round in a turn, every compaction summary, and every automatic title. A turn that reads two files and then replies takes three.' }));
  if (s.standard) {
    const std = s.standard.unit === 'usd' && s.standard.remaining != null ? `$${s.standard.remaining.toFixed(2)} of $${s.standard.limit?.toFixed(2)} left` : 'separate budget';
    out.push(el('p', { className: 'std', textContent: `Standard lane (OpenRouter): ${std}. Not used by Pouch, which sends only sealed requests.` }));
  }
  out.push(el('h3', { textContent: 'Tokens by session' }));
  const counted = rows.filter((r) => r.input || r.output);
  if (!counted.length) out.push(el('p', { className: 'muted', textContent: 'No tokens counted yet. Totals appear after a session\'s first turn.' }));
  else {
    const anyCost = counted.some((r) => r.cost > 0);
    const head = el('tr', {}, el('th', { textContent: 'Session' }), el('th', { textContent: 'In' }), el('th', { textContent: 'Out' }), ...(anyCost ? [el('th', { textContent: 'Cost' })] : []));
    const body = counted.map((r) => el('tr', { className: r.current ? 'current' : '' },
      el('td', { textContent: r.title, title: r.title }), el('td', { textContent: fmt(r.input) }), el('td', { textContent: fmt(r.output) }),
      ...(anyCost ? [el('td', { textContent: r.cost > 0 ? `$${r.cost.toFixed(4)}` : '' })] : [])));
    const cols = el('colgroup', {}, el('col'), ...Array.from({ length: anyCost ? 3 : 2 }, () => el('col', { className: 'n' })));
    out.push(el('table', { className: 'tokens' }, cols, el('thead', {}, head), el('tbody', {}, ...body)));
  }
  host.replaceChildren(...out);
}
