// Sessions: the sidebar list, create/select/rename/delete, titles and naming
// (D3, D8, L2). Owns which session is current; main.js reads it through
// `current` and supplies the transcript (attach) and the agent.
//
// A session record: { id, title, titleSource?, updated, model, usage? }.
// titleSource is 'user' for a title someone typed (never overwritten),
// 'auto' for a generated one, and absent for the first-message fallback.
import * as store from './store.js';
import { $, el, icon } from './dom.js';
import { digest, suggestTitle, titleEditor } from './naming.js';

const SPARK_TIP = 'Suggest a title from the conversation (uses 1 Sealed request from today\'s allowance)';
const LEGACY_TIP = 'Saved before each session had its own storage. Deleting it stops and resets it; its history is purged once no such session is left, or by Erase all.';
// pi-durable conversation ids are numbers, but data attributes are strings,
// and IndexedDB keys 13 and "13" differ. Match on the string form.
export const sameId = (a, b) => a != null && b != null && String(a) === String(b);
export const titleOf = (s) => s?.title || 'New session';
export const notesKey = (sid) => 'agentNotes:' + sid; // per-session notes for the agent (main.js)
export const grantsKey = (sid) => 'egressGrants:' + sid; // "Allow for this session" services (egress.js)
export const convKey = (sid) => 'conversation:' + sid; // the current conversation in its database (agent.js, D12)
export const interruptedKey = (sid) => 'interrupted:' + sid; // a reload cut off its run; Resume offered (main.js)
export const subagentsKey = (sid) => 'subagents:' + sid; // the session's subagents and their state (subagents.js)
export const revertKey = (sid) => 'revert:' + sid; // the last revert, while it can be undone, with file bytes (D12)

function ago(t) {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  if (m < 1440) return Math.round(m / 60) + 'h';
  if (m < 10_080) return Math.round(m / 1440) + 'd';
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// deps: { agent(), view(), connected() -> verified client or null, model(),
//   setModel(id), hasModel(id), attach(), status(text, cls), sheet, layout,
//   review, usage, quotaError, exhaustedText, agentError(), onRender(list),
//   grants(id) -> Promise<[{ service, label }]>, revoke(id, service) }
export function createSessions(deps) {
  const { layout, review, status } = deps;
  let session = null; // current { id, title, updated, model }
  const running = new Set(); // string ids with a send in flight: the sidebar's busy mark

  const all = async () => (await store.all('sessions')).sort((a, b) => b.updated - a.updated);
  const find = async (id) => sameId(id, session?.id) ? session : (await all()).find((x) => sameId(x.id, id));
  const save = () => session && store.put('sessions', session.id, session);

  // Patch a stored session; the current one is patched in memory too.
  async function update(id, patch) {
    const s = await find(id);
    if (!s) return null;
    Object.assign(s, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete s[k];
    await store.put('sessions', s.id, s);
    return s;
  }

  // ── The list ──────────────────────────────────────────────────────
  // Shift held (desktop only): each row grows a trash button that deletes at
  // once, no confirm. The row menu's Delete still asks.
  let shift = false;
  const setShift = (on) => {
    on = on && !matchMedia('(pointer: coarse)').matches;
    if (on === shift) return;
    shift = on;
    $('session-list').classList.toggle('quick-delete', shift);
  };
  addEventListener('keydown', (e) => { if (e.key === 'Shift') setShift(true); });
  addEventListener('keyup', (e) => { if (e.key === 'Shift') setShift(false); });
  addEventListener('blur', () => setShift(false));
  document.addEventListener('visibilitychange', () => setShift(false));

  function row(s) {
    const li = el('li', { className: 'session' });
    li.dataset.id = s.id;
    if (sameId(s.id, session?.id)) li.setAttribute('aria-current', 'true');
    const busyNow = running.has(String(s.id));
    const legacy = deps.agent()?.isLegacy?.(s.id);
    const kids = deps.runningChildren?.(s.id) ?? 0; // background subagents (D16)
    const open = el('button', { type: 'button', className: 's-open', title: titleOf(s) + (legacy ? '\n' + LEGACY_TIP : '') },
      el('span', { className: 's-title', textContent: titleOf(s) }),
      ...(legacy ? [el('span', { className: 's-legacy', textContent: 'legacy' })] : []),
      ...(kids ? [el('span', { className: 's-kids', textContent: String(kids), title: `${kids} subagent${kids > 1 ? 's' : ''} running`, role: 'img', ariaLabel: `${kids} subagent${kids > 1 ? 's' : ''} running` })] : []),
      busyNow ? el('span', { className: 'spin', role: 'img', ariaLabel: 'running', title: 'Running' })
        : el('span', { className: 's-time', textContent: ago(s.updated), title: new Date(s.updated).toLocaleString() }));
    open.onclick = async () => { if (layout.narrow()) layout.setSide(false, false); await select(s.id); };
    const more = el('button', { type: 'button', className: 'icon s-more', ariaLabel: 'Actions for ' + titleOf(s), title: 'Session actions' }, icon('ellipsis'));
    more.onclick = () => menu(s, li);
    const trash = el('button', { type: 'button', className: 'icon danger s-trash', ariaLabel: 'Delete ' + titleOf(s), title: 'Delete now (Shift held: no confirm)', tabIndex: -1 }, icon('trash'));
    trash.onclick = () => remove(s.id, false);
    li.append(open, more, trash);
    return li;
  }

  async function render() {
    const list = await all();
    $('session-list').replaceChildren(...list.map(row));
    if (!list.length) $('session-list').append(el('li', { className: 'empty muted', textContent: 'No sessions yet' }));
    renderTitle();
    deps.onRender?.(list);
  }
  function renderTitle() {
    $('title').textContent = titleOf(session);
    document.title = session?.title ? `${session.title} – BayLeaf Pouch` : 'BayLeaf Pouch';
  }

  async function menu(s, li) {
    // Active "Allow for this session" grants, each revocable here (D10).
    const grants = (await deps.grants?.(s.id)) ?? [];
    const extra = (await deps.extraActions?.(s)) ?? [];
    deps.sheet(titleOf(s), [
      ...extra,
      ...grants.map((g) => [`Stop allowing ${g.label} without asking`, async () => {
        await deps.revoke(s.id, g.service); status(`Pouch will ask again before ${g.label} in this session.`);
      }]),
      ['Rename', () => editTitle(s, li.querySelector('.s-open'))],
      ['Suggest a title (1 Sealed request)', () => renameAuto(s.id)],
      ['Compact now (summarize older turns)', async () => {
        status('Compacting...');
        try { await deps.agent().compact(s.id); status('Older turns summarized.'); } catch (e) { status(e.message, 'bad'); }
      }],
      ['Delete session', () => remove(s.id), 'danger'],
    ]);
  }
  async function renameAuto(id) {
    const t = await nameFrom(id, true);
    if (t) { await update(id, { title: t, titleSource: 'auto' }); render(); }
  }

  // ── Delete (L2) ───────────────────────────────────────────────────
  // Erases the transcript (its own database), its review records and notes.
  // A legacy session is stopped and reset; once none is left, the shared
  // legacy database goes too.
  async function remove(id, ask = true) {
    const legacy = deps.agent()?.isLegacy?.(id);
    if (ask && !confirm(legacy ? 'Delete this session? It was saved before per-session storage: it is stopped and reset now, and its history is purged once no such session is left (or by Erase all).' : 'Delete this session? Its conversation is erased from this browser.')) return;
    try { await deps.agent()?.deleteSession(id); }
    catch (e) { return status('Could not delete: ' + e.message, 'bad'); }
    await store.del('sessions', id); await review.forget(id);
    await store.setSetting(notesKey(id), undefined);
    await store.setSetting(grantsKey(id), undefined);
    await store.setSetting(convKey(id), undefined);
    await store.setSetting(revertKey(id), undefined);
    await store.setSetting(subagentsKey(id), undefined);
    await store.setSetting(interruptedKey(id), undefined);
    if (sameId(await store.getSetting('lastSession'), id)) await store.setSetting('lastSession', undefined);
    await dropLegacyIfDone();
    if (sameId(id, session?.id)) {
      session = null; await deps.attach();
      const rest = await all();
      if (rest.length) return select(rest[0].id);
    }
    render();
  }
  async function dropLegacyIfDone() {
    const agent = deps.agent();
    if (!agent?.dropLegacy || (await all()).some((s) => agent.isLegacy(s.id))) return;
    await agent.dropLegacy().catch(() => {});
  }

  // Click-to-edit in place, in the top bar and in a sidebar row (naming.js).
  // A title someone typed is 'user'; a kept suggestion is 'auto'; empty
  // falls back to the first message.
  function editTitle(s, host) {
    titleEditor(host, {
      value: s.title ?? '',
      tip: SPARK_TIP,
      suggest: () => nameFrom(s.id, true),
      save: (t, source) => update(s.id, t ? { title: t, titleSource: source } : { title: '', titleSource: undefined }),
      done: () => render(),
    });
  }
  $('title').onclick = () => { if (session) editTitle(session, $('title')); };

  // A title suggestion from the conversation, through the verified Sealed
  // client only (naming.js). quiet: after a first turn, skip without a word.
  async function nameFrom(id, recent, quiet = false, turnModel) {
    const client = deps.connected();
    if (!deps.agent() || !client) {
      if (!quiet) status('Titles are suggested by the sealed model: sign in, or use Campus Pass on campus, and wait for the enclave check.', 'bad');
      return null;
    }
    try {
      const v = sameId(id, session?.id) && deps.view() ? deps.view() : await deps.agent().snapshot(id);
      const text = digest(v?.items, recent);
      if (!text) { if (!quiet) status('Nothing to name yet: send a message first.'); return null; }
      const s = await find(id);
      const t = await suggestTitle(client, turnModel || s?.model || 'glm-5-3', text);
      if (!t && !quiet) status('No title came back; the old one stays.');
      return t;
    } catch (e) {
      if (!quiet) status(deps.quotaError(e.message) ? deps.exhaustedText(await deps.usage.refresh()) : 'Could not suggest a title: ' + e.message, 'bad');
      return null;
    } finally { deps.usage.refresh(); }
  }

  // After a send settles: record time and usage, and name the session after
  // its first turn unless someone already typed a title (D8). One sealed
  // request; silent when not connected.
  async function afterTurn(sid, v, ok, turnModel) {
    await update(sid, { updated: Date.now(), ...(v?.usage ? { usage: v.usage } : {}) });
    render();
    deps.usage.refresh();
    const fresh = await find(sid);
    if (ok && fresh && !fresh.titleSource && v?.items.filter((i) => i.type === 'user').length === 1) {
      const t = await nameFrom(sid, false, true, turnModel);
      const now = await find(sid);
      if (t && now && !now.titleSource) { await update(sid, { title: t, titleSource: 'auto' }); render(); }
    }
  }

  async function create() {
    const agent = deps.agent();
    if (!agent) return status(deps.agentError() ?? 'The agent is not available.', 'bad');
    const model = deps.model() || 'glm-5-3';
    const id = await agent.createSession(model);
    session = { id, title: '', updated: Date.now(), model };
    await save();
    store.setSetting('lastSession', id);
    await deps.attach();
    await render();
    if (layout.narrow()) layout.setSide(false, false);
    $('input').focus();
  }

  async function select(id) {
    const found = (await store.all('sessions')).find((s) => sameId(s.id, id));
    if (!found) return;
    session = found;
    store.setSetting('lastSession', session.id);
    if (session.model && deps.hasModel(session.model)) deps.setModel(session.model);
    await render();
    await deps.attach();
  }
  const startNew = () => create().catch((e) => status(e.message, 'bad'));
  $('new').onclick = startNew;
  $('new-top').onclick = startNew;

  // Boot: the last session (or the newest), and drop a legacy database that
  // only holds sessions deleted before L2.
  async function boot() {
    await dropLegacyIfDone();
    const list = await all();
    const last = await store.getSetting('lastSession');
    const pick = list.find((s) => sameId(s.id, last)) ?? list[0];
    if (pick && deps.agent()) await select(pick.id); else await render();
    return !!pick && !!deps.agent();
  }

  return {
    get current() { return session; },
    running, all, find, save, update, render, create, select, remove, afterTurn, boot,
  };
}
