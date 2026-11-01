// Subagent views: the registry per session, child transcripts and cards.

import { defaultSubagentNs, describeSpecs } from '../tools.ts';
import { shownLines } from '../open-cli.ts';
import { $, el, seeded } from '../dom.ts';
import { fold, reduced, snapshot } from '../motion.ts';
import { MAIN, asRef, refOf } from '../graph.ts';
import { sameId, titleOf } from '../sessions.ts';
import { why } from '../ns/control.ts';

export function createSubagentsRegion(app) {
  // ── Subagents (subagents.js, D15/D16) ───────────────────────────────
  // kids: session id -> its registry rows, as last changed. A report starts a
  // parent run nobody sent; drive() does a send's bookkeeping for it.
  const kids = new Map();
  const childViews = new Map(); // child id -> normalized view (current session's children)
  let childWatches = new Map(); // child id -> dispose
  async function loadKids(sid) {
    if (sid == null || !app.state.agent?.subagents) return [];
    const l = await app.state.agent.subagents.list(sid);
    kids.set(String(sid), l);
    return l;
  }
  function watchKids() {
    const sid = app.sessionList.sessions.current?.id;
    const want = new Set((kids.get(String(sid)) ?? []).map((c) => c.id));
    for (const [id, d] of childWatches) if (!want.has(id)) { d(); childWatches.delete(id); childViews.delete(id); }
    for (const id of want) {
      if (childWatches.has(id)) continue;
      childWatches.set(id, () => {});
      app.state.agent.subagents.watch(sid, id, (v) => { childViews.set(id, v); app.transcript.scheduleRender(); })
        .then((d) => { if (childWatches.has(id)) childWatches.set(id, d); else d(); }, () => childWatches.delete(id));
    }
  }
  function dropKidWatches() { for (const d of childWatches.values()) d(); childWatches = new Map(); childViews.clear(); }
  let tick = 0;
  // Subagents as /task entries (src/ns/tasks.ts), so the agent and the tray read one source.
  const TASK_STATE = { running: 'running', finished: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
  function onKids(sid, list) {
    kids.set(String(sid), list);
    if (app.queues.childFollowUps.size) app.harness.flushChildFollowUps(sid, list);
    for (const c of list) app.state.vfs.tasks.upsert('sa:' + c.id, { kind: 'subagent', sid, label: c.name, status: TASK_STATE[c.status] ?? c.status,
      ns: describeSpecs(app.state.vfs, c.ns?.length ? c.ns : defaultSubagentNs(app.state.vfs)), kill: () => app.harness.stopChildOf(sid, c.id) });
    for (const c of list) app.namespaces.control.state(sid, refOf(list, c), c.status);
    app.sessionList.sessions.render();
    if (sameId(sid, app.sessionList.sessions.current?.id)) { watchKids(); app.transcript.scheduleRender(); app.state.composer?.renderTray(); }
    if (app.state.layout.current() === 'usage') app.meters.renderUsagePanel();
    // Elapsed times on running cards.
    const anyRunning = [...kids.values()].some((l) => l.some((c) => c.status === 'running'));
    if (anyRunning && !tick) tick = setInterval(() => { if (app.sessionList.sessions.current && (kids.get(String(app.sessionList.sessions.current.id)) ?? []).some((c) => c.status === 'running')) app.transcript.scheduleRender(); }, 1000);
    if (!anyRunning && tick) { clearInterval(tick); tick = 0; }
  }
  async function drive(sid, wait) {
    const t0 = Date.now();
    app.sessionList.sessions.running.add(String(sid)); app.sessionList.sessions.render();
    const mine = !app.sessionList.activeRun;
    if (mine) app.sessionList.activeRun = String(sid);
    try { await wait(); } catch {}
    finally {
      app.sessionList.sessions.running.delete(String(sid));
      if (mine) app.sessionList.activeRun = null;
    }
    const ms = Date.now() - t0;
    const v = await app.state.agent.snapshot(sid).catch(() => null);
    await app.transcript.recordTurn(sid, v, ms);
    await app.sessionList.sessions.afterTurn(sid, v, true);
  }
  const lowAllowance = () => {
    const s = app.state.usage.state;
    if (s.remaining == null) return null;
    if (s.remaining <= 15) return `only ${s.mode === 'campus' ? 'about ' : ''}${s.remaining} requests are left today, and a subagent may use many of them; tell the user.`;
    return null;
  };
  // Agent graphs (G9): message counts per edge, from the registry rows.
  const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  const msgCount = (c) => sum(c.got) + sum(c.sent);
  const refName = (l, ref) => { ref = asRef(ref); if (ref === MAIN) return `main (${MAIN})`; const c = l.find((x) => refOf(l, x) === ref); return c ? `${c.name} (${ref})` : ref; };
  const byRef = (o) => Object.entries(o ?? {}).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
  const edgeText = (l, c) => [...byRef(c.got).map(([r, n]) => `from ${refName(l, r)} ${n}`), ...byRef(c.sent).map(([r, n]) => `to ${refName(l, r)} ${n}`)].join(', ');
  // A small to/from list, each peer in its own color (continuity: G9).
  function edgeLine(l, c) {
    const entry = (dir, [r, n]) => seeded(el('li', { className: 'sa-edge' }, el('span', { className: 'sa-dot', ariaHidden: 'true' }), `${dir} ${refName(l, r)} `, el('span', { className: 'n', textContent: String(n) })), r);
    const got = byRef(c.got).map((e) => entry('from', e)), sent = byRef(c.sent).map((e) => entry('to', e));
    if (!got.length && !sent.length) return null;
    return el('div', { className: 'sa-edges', ariaLabel: 'Messages' }, el('span', { className: 'sa-edges-k', textContent: 'Messages' }),
      el('ul', {}, ...got, ...sent));
  }
  // Who a handle is, for pills: "chair (a2)", "main (a1)".
  const whoRef = (ref) => refName(kids.get(String(app.sessionList.sessions.current?.id)) ?? [], String(ref));
  const refRange = (ids) => {
    ids = ids.map(asRef);
    const n = ids.map((x) => /^a(\d+)$/.exec(x)?.[1]).map(Number);
    if (ids.length > 2 && n.every((x, i) => x && (i === 0 || x === n[i - 1] + 1))) return `${ids[0]}-${ids.at(-1)}`;
    return ids.join(', ');
  };
  // The agents and subagent tools in words, not JSON (critique 9).
  function agentSummary(name, a) {
    if (!a || typeof a !== 'object') return String(a ?? '');
    const ids = [].concat(a.ids ?? (a.action === 'join' ? a.id ?? [] : [])).map(String);
    const quote = (t) => t ? `: "${app.commands.excerpt(t, 60)}"` : '';
    switch (a.action) {
      case 'message': { const to = [].concat(a.to ?? (ids.length ? ids : a.id ?? [])).map(String); return `message -> ${to.map(whoRef).join(', ') || '?'}${quote(a.text)}`; }
      case 'join': return `join ${refRange(ids)}`;
      case 'spawn': return `spawn ${a.mode === 'oneshot' ? 'one-shot ' : ''}${a.name ?? 'subagent'}${a.background === false ? ' (waits)' : ''}`;
      case 'list': return 'list';
      case 'stop': case 'status': return `${a.action} ${a.id ? whoRef(a.id) : ''}`.trim();
      default: return a.action ?? '';
    }
  }
  const fmtDur = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`; };
  function messageChild(c) {
    const box = el('textarea', { className: 'sa-input', rows: 3, placeholder: `What should ${c.name} do or know?`, ariaLabel: `Message to subagent ${c.name}` });
    app.state.sheet(`Message subagent ${c.name}`, [[c.status === 'running' ? 'Send (joins its work)' : 'Send (it starts again)', async () => {
      const t = box.value.trim();
      if (!t) return;
      await app.namespaces.ctl(app.namespaces.agentFile(app.sessionList.sessions.current.id, c.ref ?? refOf(kids.get(String(app.sessionList.sessions.current.id)) ?? [], c), 'in'), 'message\n' + t).catch((e) => app.tree.fail(why(e)));
    }]], el('div', {}, el('p', { textContent: c.status === 'running' ? 'It reads this after its current step. Its report will reflect it.' : 'It continues from where it ended and posts a new report.' }), box));
    setTimeout(() => box.focus(), 0);
  }
  // What a child is doing, in the words the session list and its view use:
  // working, waiting (an approval of its is open), finished, stopped, failed, interrupted.
  function childState(sid, c) {
    if (c.status === 'running') return app.sessionList.egress.pending.some((p) => sameId(p.sid, sid) && p.agentName === c.name) ? 'waiting' : 'working';
    return c.status;
  }
  // The composer's text belongs to the view it was typed in: main's draft waits
  // while a subagent is open, and that subagent's waits for its next opening.
  const drafts = new Map();
  function swapDraft(from, to) {
    const i = $('input');
    drafts.set(from, i.value);
    i.value = drafts.get(to) ?? '';
    drafts.delete(to);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // Opening and leaving a subagent view (README "Subagent views"): the view zooms
  // out of what was clicked (its card, tray row or sidebar row) and folds back
  // into its card; under reduced motion the frame flashes instead.
  function zoomIn(rect) {
    const log = $('log');
    if (reduced() || !rect?.width) { flash($('chat')); return; }
    const r = log.getBoundingClientRect();
    log.style.transformOrigin = '0 0';
    const a = log.animate([{ transform: `translate(${rect.left - r.left}px, ${rect.top - r.top}px) scale(${rect.width / r.width}, ${rect.height / r.height})`, opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: 'ease-out' });
    a.id = 'child-open';
    a.finished.catch(() => {}).finally(() => { log.style.transformOrigin = ''; });
  }
  function flash(node) {
    if (!node) return;
    node.classList.add('still-mark');
    setTimeout(() => node.classList.remove('still-mark'), 900);
  }
  // Open a subagent's own view (S2): select its parent session first if needed.
  // from: what was clicked, the motion's origin (default: its card in the log).
  async function openChild(sid, id, from = null) {
    const card = () => $('log').querySelector(`.subagent[data-child="${CSS.escape(String(id))}"]`);
    const origin = (from?.isConnected && from.getClientRects().length ? from : null) ?? card();
    const rect = origin?.getBoundingClientRect();
    if (!sameId(sid, app.sessionList.sessions.current?.id)) await app.sessionList.sessions.select(sid);
    if (!sameId(sid, app.sessionList.sessions.current?.id)) return;
    const prev = app.sessionList.focus;
    if (prev?.id === id) return;
    swapDraft(prev ? 'child:' + prev.id : 'main', 'child:' + id);
    // Reached from another subagent's view (a peer): the crumbs say so.
    app.sessionList.focus = { sid: String(sid), id, from: prev ? (kids.get(prev.sid) ?? []).find((c) => c.id === prev.id)?.name ?? null : null };
    // Back pops out (one history entry per stay in subagent views).
    if (!prev) history.pushState({ pouchChild: id }, ''); else history.replaceState({ pouchChild: id }, '');
    if (app.state.layout.narrow() || app.state.layout.overlaid()) app.state.layout.setSide(false, false);
    // Open at the top, task header in view (critique 76-78); the transcript
    // fills in asynchronously, so stay there until the user scrolls.
    app.sessionList.focus.pinTop = true;
    app.transcript.renderLog(); app.queues.updateSend(); app.sessionList.sessions.render();
    $('log').scrollTop = 0;
    zoomIn(rect);
    $('input').focus();
  }
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) $('log').addEventListener(ev, () => { if (app.sessionList.focus) app.sessionList.focus.pinTop = false; }, { passive: true });
  // fromHistory: Back already took the entry off.
  function closeChild(fromHistory = false) {
    if (!app.sessionList.focus) return;
    const id = app.sessionList.focus.id, snap = reduced() ? null : snapshot($('log'));
    swapDraft('child:' + id, 'main');
    app.sessionList.focus = null;
    app.transcript.renderLog(); app.queues.updateSend(); app.sessionList.sessions.render();
    const card = $('log').querySelector(`.subagent[data-child="${CSS.escape(String(id))}"]`);
    card?.scrollIntoView({ block: 'center' });
    if (reduced()) flash(card ?? $('chat'));
    else { const a = fold(snap, card, 200); if (a) a.id = 'child-close'; }
    if (!fromHistory && history.state?.pouchChild != null) history.back();
  }
  addEventListener('popstate', () => { if (app.sessionList.focus && history.state?.pouchChild == null) closeChild(true); });
  // Esc pops out of a subagent view once nothing nearer took it (a popover,
  // the completion list, a sheet: they call preventDefault). Drafts are kept.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !app.sessionList.focus || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    closeChild();
  });
  const focusedChild = () => app.sessionList.focus && (kids.get(app.sessionList.focus.sid) ?? []).find((c) => c.id === app.sessionList.focus.id);

  // A child's transcript, for its card (compact: one line per tool call, the
  // final answer set apart) and for its own view (full: the session's own
  // rendering). The user's steering messages are marked in both.
  function childItems(v, name, childId, compact) {
    const out = [], nextCache = new Map(), items = v?.items ?? [];
    const final = compact && !v?.busy ? items.findLast((x) => x.type === 'assistant' && x.text && !x.streaming) : null;
    let first = true;
    for (const x of items) {
      if (x.type === 'user') {
        const label = x.steer ? app.state.STEER_LABEL : x.from ? `from ${x.from.name} (${x.from.ref})` : first ? 'Task' : 'Message';
        const who = el('span', { className: `sa-who${x.from ? ' msg-from' : ''}`, textContent: label });
        if (x.from) seeded(who, x.from.ref);
        out.push(el('div', { className: `msg user bare${x.steer ? ' steer' : ''}${x.from ? ' from' : ''}`, role: 'article', ariaLabel: x.steer ? 'Your steering message' : x.from ? `Message to ${name} ${label}` : `${label} for ${name}` },
          who, el('div', { className: 'body', textContent: x.text })));
        first = false;
      } else if (x.type === 'assistant') {
        if (x === final) continue;
        out.push(el('div', { className: `msg assistant bare${x.streaming ? ' streaming' : ''}`, role: 'article', ariaLabel: `Reply from ${name}` },
          ...(x.thinking && !compact ? [app.transcript.reasoningCard(x, `child:${childId}:${items.indexOf(x)}`)] : []),
          ...(x.text ? [app.transcript.replyBody(x.text, nextCache)] : []),
          ...(x.error ? [el('div', { className: 'body bad', textContent: x.error })] : []),
          ...(x.streaming && !compact ? [el('span', { className: 'typing', role: 'img', ariaLabel: `${name} is replying`, title: 'Replying' }, el('i'), el('i'), el('i'))] : [])));
      } else if (x.type === 'tool') {
        // Spawns in one round read as one line: "spawn 4 one-shot judges".
        const prev = out.at(-1), spawn = x.name === 'subagent' && x.args?.action === 'spawn' ? x.args : null;
        if (compact && spawn && prev?.dataset?.spawn === (spawn.mode ?? 'agent')) {
          const names = [...JSON.parse(prev.dataset.names), spawn.name ?? 'subagent'];
          prev.dataset.names = JSON.stringify(names);
          prev.textContent = `subagent: ${spawnGroupText(names, spawn.mode)}`;
          prev.title = names.join(', ');
          continue;
        }
        const line = compact ? el('div', { className: 'sa-line' + (x.status === 'error' ? ' error' : ''), title: app.transcript.argSummary(x.name, x.args) },
          `${x.status === 'running' ? '... ' : x.status === 'error' ? '! ' : ''}${x.name}: ${app.transcript.argSummary(x.name, x.args)}`) : app.transcript.toolCard(x, 'sa:');
        if (compact && spawn && x.status !== 'error') { line.dataset.spawn = spawn.mode ?? 'agent'; line.dataset.names = JSON.stringify([spawn.name ?? 'subagent']); }
        out.push(line);
        if (x.name === 'bash') out.push(...shownLines(x.output).map(app.editing.shownCard));
      } else if (x.type === 'notice') out.push(el('p', { className: 'notice', textContent: x.text }));
    }
    if (final) out.push(el('div', { className: 'sa-final', role: 'article', ariaLabel: `Final answer from ${name}` }, el('span', { className: 'sa-who', textContent: 'Final answer' }), app.transcript.replyBody(final.text, nextCache)));
    if (!items.length) out.push(el('p', { className: 'notice', textContent: v ? 'Nothing yet.' : 'Loading...' }));
    return out;
  }

  // "spawn 4 one-shot judges" from judge-argument, judge-evidence, ...
  function spawnGroupText(names, mode) {
    const stem = names.every((n) => n.includes('-')) && new Set(names.map((n) => n.split('-')[0])).size === 1 ? names[0].split('-')[0] : null;
    return `spawn ${names.length} ${mode === 'oneshot' ? 'one-shot ' : ''}${stem ? stem + 's' : 'subagents'}`;
  }
  // The parent's name in a subagent's header and notes: its title once it has
  // one, not the first-message placeholder, and never with a trailing period.
  const parentName = (s) => (s?.titleSource || s?.titleEdited ? titleOf(s) : 'main').replace(/[.\s]+$/, '');
  let saDetails = false; // the subagent header's Details disclosure, across renders

  // The subagent's own view (S2, S3): who it is and what it may reach, its
  // live transcript, and an end note once it is done. The composer steers it.
  function childLog() {
    const c = focusedChild(), v = childViews.get(app.sessionList.focus.id);
    const parent = parentName(app.sessionList.sessions.current);
    if (!c) return [el('p', { className: 'notice bad', textContent: 'That subagent is no longer in this session.' })];
    const st = childState(app.sessionList.focus.sid, c), t = app.state.vfs.tasks.byKeyOf('sa:' + c.id);
    // One bar (critique 3): back, name in its color, state, elapsed, requests,
    // Details, Stop. Task, messages and namespace fold under Details once the
    // transcript scrolls; at the top they show.
    // Breadcrumbs (Batch D): <this session> > <subagent>; the first pops out.
    const title = titleOf(app.sessionList.sessions.current).replace(/[.\s]+$/, '');
    const back = el('button', { type: 'button', className: 'link sa-back', textContent: title, title: `Back to ${title} (Esc)` });
    back.onclick = () => closeChild();
    const crumbs = el('nav', { className: 'sa-crumbs', ariaLabel: 'Where you are' }, el('ol', {},
      el('li', {}, back),
      el('li', {}, el('span', { className: 'sa-dot', ariaHidden: 'true' }), el('span', { className: 'sa-name', ariaCurrent: 'page', textContent: c.name }),
        ...(app.sessionList.focus.from ? [el('span', { className: 'sa-from muted', textContent: ` opened from ${app.sessionList.focus.from}` })] : []))));
    const more = el('button', { type: 'button', className: 'sa-more-btn', textContent: 'Details', ariaExpanded: String(saDetails) });
    const acts = el('span', { className: 'sa-acts' }, more);
    if (c.status === 'running') {
      const stop = el('button', { type: 'button', className: 'danger', textContent: 'Stop', ariaLabel: `Stop subagent ${c.name}` });
      stop.onclick = () => { stop.disabled = true; app.namespaces.ctl(app.namespaces.agentFile(app.sessionList.focus.sid, refOf(kids.get(String(app.sessionList.focus.sid)) ?? [], c), 'ctl'), 'stop').catch((e) => app.tree.fail(why(e))); };
      acts.append(stop);
    }
    const mounts = t ? app.state.vfs.tasks.mounts(t) : describeSpecs(app.state.vfs, c.ns?.length ? c.ns : defaultSubagentNs(app.state.vfs));
    const body = el('div', { className: 'sa-more', id: 'sa-more' },
      el('p', { className: 'sa-meta', textContent: [...(c.ref ? [c.ref] : []), `subagent of ${parent}`, ...(t ? [`/task/${t.id}`] : [])].join(' · ') }),
      el('p', { className: 'sa-task', textContent: c.task, title: c.task }),
      ...[edgeLine(kids.get(app.sessionList.focus.sid) ?? [], c)].filter(Boolean),
      el('p', { className: 'sa-mounts', title: 'What this subagent can reach (its namespace)' }, 'Sees: ', ...mounts.map((m) => el('code', { textContent: m }))));
    more.setAttribute('aria-controls', 'sa-more');
    const head = seeded(el('section', { className: 'sa-view-head' + (saDetails ? ' details' : '') + ($('log').scrollTop > 24 ? ' collapsed' : ''), ariaLabel: `Subagent ${c.name} of ${parent}` },
      el('div', { className: 'sa-bar' }, crumbs,
        el('span', { className: `sa-status ${c.status}`, textContent: st }),
        el('span', { className: 'sa-meta sa-stats', textContent: [fmtDur((c.status === 'running' ? Date.now() : c.ended ?? Date.now()) - (c.resumed ?? c.started)), `${v?.steps ?? c.requests ?? 0} req`, ...((v?.toolErrors ?? c.toolErrors) ? [`${v?.toolErrors ?? c.toolErrors} tool err`] : [])].join(' · ') }),
        acts),
      body), c.ref);
    more.onclick = () => { saDetails = !saDetails; head.classList.toggle('details', saDetails); more.ariaExpanded = String(saDetails); };
    // On a phone the stats ride under Details, so the name keeps the bar (critique 7).
    body.prepend(el('p', { className: 'sa-stats-more muted', textContent: head.querySelector('.sa-stats').textContent }));
    const out = [head, ...childItems(v, c.name, c.id, false)];
    if (c.status !== 'running') {
      // Ended: one compact bar in place of the composer (critique 7).
      const b = el('button', { type: 'button', textContent: 'Back', ariaLabel: `Back to ${title}`, title: `Back to ${title} (Esc)` });
      b.onclick = () => closeChild();
      out.push(el('p', { className: 'notice sa-ended', role: 'status' }, el('span', { textContent: st === 'finished' ? `${c.name} finished; its report is in main's thread.` : `${c.name} ${{ stopped: 'was stopped', failed: 'failed', interrupted: 'was interrupted' }[st] ?? 'ended'}; its last output is in main's thread.` }), b));
    }
    return out;
  }
  let lastHeight = null; // the transcript's height at the last render (the "New reply below" pill)
  $('below').onclick = () => { app.state.follow.pin(!matchMedia('(prefers-reduced-motion: reduce)').matches); $('below').hidden = true; };
  $('log').addEventListener('scroll', () => { if (app.state.follow.following) $('below').hidden = true; }, { passive: true });
  // The header folds to its bar once the transcript scrolls (critique 3).
  $('log').addEventListener('scroll', () => {
    const h = app.sessionList.focus && $('log').querySelector('.sa-view-head');
    if (h) h.classList.toggle('collapsed', $('log').scrollTop > 24);
  }, { passive: true });

  // The card at the spawn point (D16): status, time, requests, Stop, Message,
  // Open (its own view), the transcript (compact; filled when opened, live while
  // it runs), and the files it changed.
  function subagentCard(it, childId) {
    const c = (kids.get(String(app.sessionList.sessions.current?.id)) ?? []).find((x) => x.id === childId);
    const v = childViews.get(childId);
    const name = c?.name ?? it.details?.name ?? it.args?.name ?? 'subagent';
    const st = c?.status ?? (it.status === 'running' ? 'starting' : 'unknown');
    const box = seeded(el('section', { className: `subagent ${st}`, ariaLabel: `Subagent ${name}: ${st}` }), c?.ref ?? it.details?.ref);
    box.dataset.child = childId;
    const meta = [];
    if (c?.ref) meta.push(c.ref);
    if (c?.oneshot ?? it.details?.oneshot) meta.push('one-shot');
    if (c) meta.push(fmtDur((c.status === 'running' ? Date.now() : c.ended ?? Date.now()) - (c.resumed ?? c.started)));
    const steps = v?.steps ?? c?.requests;
    if (steps != null) meta.push(`${steps} request${steps === 1 ? '' : 's'}`);
    const fails = v?.toolErrors ?? c?.toolErrors;
    if (fails) meta.push(`${fails} tool error${fails === 1 ? '' : 's'}`);
    const head = el('div', { className: 'sa-head' },
      el('span', { className: 'sa-dot', ariaHidden: 'true' }),
      el('span', { className: 'sa-name', textContent: name }),
      el('span', { className: `sa-status ${st}`, textContent: st }),
      el('span', { className: 'sa-meta', textContent: meta.join(' · ') }));
    const acts = el('span', { className: 'sa-acts' });
    if (c) {
      const open = el('button', { type: 'button', textContent: 'Open', ariaLabel: `Open subagent ${name}` });
      open.onclick = () => openChild(app.sessionList.sessions.current.id, c.id, box);
      const msg = el('button', { type: 'button', textContent: 'Message', ariaLabel: `Message subagent ${name}` });
      msg.onclick = () => messageChild(c);
      acts.append(open, ...(c.oneshot ? [] : [msg])); // a one-shot takes no messages
    }
    if (c?.status === 'interrupted') {
      const res = el('button', { type: 'button', className: 'primary', textContent: 'Resume', ariaLabel: `Resume subagent ${name}` });
      res.onclick = () => { res.disabled = true; app.namespaces.ctl(app.namespaces.agentFile(app.sessionList.sessions.current.id, refOf(kids.get(String(app.sessionList.sessions.current.id)) ?? [], c), 'in'), 'message\nContinue your task where you left off: a page reload interrupted you.').catch((e) => app.tree.fail(why(e))); };
      acts.append(res);
    }
    if (c?.status === 'running') {
      const stop = el('button', { type: 'button', className: 'danger', textContent: 'Stop', ariaLabel: `Stop subagent ${name}` });
      stop.onclick = () => { stop.disabled = true; app.namespaces.ctl(app.namespaces.agentFile(app.sessionList.sessions.current.id, refOf(kids.get(String(app.sessionList.sessions.current.id)) ?? [], c), 'ctl'), 'stop').catch((e) => app.tree.fail(why(e))); };
      acts.append(stop);
    }
    head.append(acts);
    box.append(head, el('p', { className: 'sa-task', textContent: c?.task ?? it.args?.task ?? '', title: c?.task ?? '' }));
    const edges = c && edgeLine(kids.get(String(app.sessionList.sessions.current?.id)) ?? [], c);
    if (edges) box.append(edges);
    if (c?.error && st === 'failed') box.append(el('p', { className: 'sa-err', textContent: c.error }));
    const key = 'sa:' + childId;
    // The body is built when the disclosure opens, not only at the next render:
    // a toggle used to record the state and draw nothing until something else
    // re-rendered the log (never, once the child had finished).
    const d = el('details', { className: 'sa-log', open: app.transcript.openTools.has(key) });
    const n = v?.items.length ?? 0, steered = v?.items.filter((x) => x.steer).length ?? 0;
    d.append(el('summary', { textContent: (v ? `Transcript (${n} item${n === 1 ? '' : 's'})` : 'Transcript') + (steered ? `, steered by you ${steered === 1 ? 'once' : steered + ' times'}` : '') }));
    // Expanded, the transcript scrolls in its own tinted box under a sticky
    // "Collapse <name>" bar, so it never passes for the main session (critique 5).
    const fill = () => {
      if (d.querySelector('.sa-items')) return;
      const fold = el('button', { type: 'button', className: 'sa-fold', textContent: `Collapse ${name}`, ariaLabel: `Collapse the transcript of ${name}` });
      fold.onclick = () => { d.open = false; box.scrollIntoView({ block: 'nearest' }); };
      const items = el('div', { className: 'sa-items', tabIndex: 0, role: 'region', ariaLabel: `Transcript of ${name}` }, fold, ...childItems(childViews.get(childId), name, childId, true));
      items.dataset.sk = key; // keeps its place across re-renders (src/follow.ts)
      d.append(items);
    };
    if (d.open) fill();
    d.ontoggle = () => { if (d.open) { app.transcript.openTools.add(key); fill(); } else app.transcript.openTools.delete(key); };
    box.append(d);
    return box;
  }

  return {
    agentSummary,
    childLog,
    childState,
    childViews,
    drive,
    dropKidWatches,
    edgeText,
    fmtDur,
    focusedChild,
    kids,
    get lastHeight() { return lastHeight; }, set lastHeight(v) { lastHeight = v; },
    loadKids,
    lowAllowance,
    msgCount,
    onKids,
    openChild,
    parentName,
    subagentCard,
    swapDraft,
    watchKids,
    whoRef,
  };
}
