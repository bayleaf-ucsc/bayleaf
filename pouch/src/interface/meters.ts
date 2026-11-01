// Usage panel: token totals per session.

import { $, el } from '../dom.ts';
import { renderPanel } from '../usage.ts';
import { sameId, titleOf } from '../sessions.ts';
import { LOCAL } from '../local/engine.ts';

export function createMetersRegion(app) {
  // Token totals per session (Usage panel): the live view for the current
  // session, otherwise what was recorded when its last run settled.
  async function renderUsagePanel(list) {
    list ??= await app.sessionList.sessions.all();
    const led = await app.state.ledger.snapshot();
    // Subagents' tokens roll into their parent session's row; requests come
    // from today's ledger (subagents and titles are counted under the session).
    const rows = await Promise.all(list.map(async (s) => {
      const current = sameId(s.id, app.sessionList.sessions.current?.id);
      const u = (current && app.state.view?.usage) || s.usage || {};
      const subs = (await app.subagents.loadKids(s.id).catch(() => [])) ?? [];
      const sum = (k) => subs.reduce((n, c) => n + (c.usage?.[k] ?? 0), 0);
      return { title: titleOf(s), input: (u.input ?? 0) + sum('input'), output: (u.output ?? 0) + sum('output'), cost: (u.cost ?? 0) + sum('cost'),
        requests: led.bySid[String(s.id)] ?? 0, subagents: subs.length, current };
    }));
    const known = new Set(list.map((s) => String(s.id)));
    const gone = Object.entries(led.bySid).filter(([k]) => !known.has(k)).reduce((n, [, v]) => n + v, 0);
    if (gone) rows.push({ title: 'Deleted sessions', requests: gone, input: null, output: null });
    renderPanel($('usage-body'), app.state.usage.state, rows, led);
    // This session's context (the composer's meter, spelled out), above the allowance.
    const now = app.queues.contextNow();
    if (now) {
      const s = app.sessionList.sessions.current;
      const box = el('section', { className: 'ctx-now', ariaLabel: 'This session\'s context' },
        el('h3', { textContent: 'This session\'s context' }),
        el('div', { className: 'big' }, now.d.count, el('small', { textContent: now.d.of ? ` of ${now.d.of} tokens` : ' tokens' })),
        el('p', { textContent: now.d.label }),
        el('p', { className: 'muted', textContent: 'Counted in this browser from the stored conversation: the newest reply\'s own usage, as its server reported it, plus an estimate (about 3.5 characters a token) for anything since. Nothing is sent to count it.' }),
        el('button', { type: 'button', className: 'ctx-compact', textContent: `Compact now (${app.sessionList.sessions.costOf(s)})`, onclick: async () => { await app.sessionList.sessions.compact(s.id); if (app.state.layout.current() === 'usage') renderUsagePanel(); } }));
      box.dataset.level = now.d.level;
      $('usage-body').prepend(box);
    }
    if (LOCAL) $('usage-body').querySelector('.quota')?.after(el('p', { className: 'local-usage muted', textContent:
      `Transformers.js turns (${LOCAL.label}, in this browser) use none of this allowance: they send no requests.` }));
    // Subagents spend the same allowance (D16).
    const live = [...app.subagents.kids.entries()].flatMap(([sid, l]) => l.filter((c) => c.status === 'running').map((c) => ({ sid, c })));
    if (live.length) {
      $('usage-body').querySelector('.quota')?.after(el('p', { className: 'sa-usage', role: 'status', textContent:
        `${live.length} subagent${live.length > 1 ? 's are' : ' is'} running (${live.map(({ c }) => c.name).join(', ')}). Each of their steps uses a request too, so the number above is still going down.` }));
    }
  }
  $('usage-refresh').onclick = () => app.state.usage.refresh();

  return {
    renderUsagePanel,
  };
}
