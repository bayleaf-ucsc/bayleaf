// Session list, egress consent hooks and the shared model, pdf and media services.

import * as store from '../store.js';
import { $, el } from '../dom.js';
import { exhaustedText } from '../usage.js';
import { createPdfService } from '../pdf.js';
import { createMediaService } from '../media.js';
import { createSessions, revertKey, sameId, titleOf } from '../sessions.js';
import { createEgress, grantsFor, revoke, serviceName } from '../egress.js';
import { LOCAL, models as modelStore } from '../local/engine.js';
import { createModelService } from '../models-cli.js';

export function createSessionListRegion(app) {
  // ── Sessions (sessions.js) ──────────────────────────────────────────
  // focus: the subagent of the current session whose view fills the chat pane
  // (its live transcript; the composer steers it), or null for the session.
  let focus = null; // { sid, id }
  const sessions = createSessions({
    forgetWatches: (id) => app.boot.watches.removeSession(id),
    agent: () => app.state.agent, view: () => app.state.view, connected: () => (app.state.agent && app.state.verified ? app.state.client : null),
    model: () => $('model').value, setModel: (id) => { $('model').value = id; app.providers.pickerProvider(); }, hasModel: (id) => app.state.models.some((m) => m.id === id) || (app.providers.localOk.ok && id === app.providers.LOCAL_ID) || app.providers.lhModels().some((m) => 'localhost:' + m.id === id), isLocal: app.providers.offSealed,
    attach: () => app.transcript.attach(), status: app.state.status, ask: app.tree.ask, sheet: app.state.sheet, countRequest: (id, kind) => app.state.ledger.add(id, kind).then(app.state.meter), layout: app.state.layout, usage: app.state.usage, quotaError: (msg) => app.send.quotaError(msg), exhaustedText,
    agentError: () => app.boot.agentError,
    runningChildren: (sid) => (app.subagents.kids.get(String(sid)) ?? []).filter((c) => c.status === 'running').length,
    // Nested rows (steer journey S1): running children of any session, and
    // every child of the current one, newest first, at most five.
    children: (sid) => {
      const l = app.subagents.kids.get(String(sid)) ?? [], cur = sameId(sid, sessions.current?.id);
      return l.filter((c) => c.status === 'running' || cur).slice(-5).reverse()
        .map((c) => ({ id: c.id, ref: c.ref, name: c.name, task: c.task, state: app.subagents.childState(sid, c), msgs: app.subagents.msgCount(c), edges: app.subagents.edgeText(l, c), open: sameId(focus?.sid, sid) && focus?.id === c.id }));
    },
    openChild: (sid, id, from) => app.subagents.openChild(sid, id, from),
    onRender: (list) => { if (app.state.layout.current() === 'usage') app.meters.renderUsagePanel(list); },
    grants: async (id) => (await grantsFor(id)).map((service) => ({ service, label: serviceName(service) })),
    revoke,
    // While a revert of this session can be undone (D12).
    extraActions: async (s) => {
      const t = await store.getSetting(revertKey(s.id));
      return t ? [[`Undo revert to ${app.transcript.shortTime(t.at)}`, () => app.transcript.undoRevert(s.id)]] : [];
    },
  });

  // ── Leaving the pouch (egress.js, D10) ──────────────────────────────
  // The bayleaf command asks before every request; a run belongs to the
  // session it was sent from, even if you switch away meanwhile.
  // The session whose run is active (a turn, a resumed run or Run script), if any.
  let activeRun = null;
  const runSession = () => activeRun ?? (sessions.current ? String(sessions.current.id) : null);
  const egress = createEgress({ sessionTitle: async (sid) => titleOf(await sessions.find(sid)), onPending: () => { app.state.composer?.renderTray(); sessions.render(); }, onGrant: () => app.state.composer?.refreshShield() });
  // Running bash card id -> { commands, audiences }, until its output carries the marker.
  const liveEgress = new Map();
  function noteEgress(e) {
    if (!sameId(runSession(), sessions.current?.id)) return; // shown from the marker when you switch back
    const t = app.state.view?.items.findLast?.((i) => i.type === 'tool' && i.name === 'bash' && i.status === 'running');
    if (!t) return;
    const prev = liveEgress.get(t.id) ?? { commands: [], audiences: [] };
    liveEgress.set(t.id, {
      commands: [...new Set([...prev.commands, e.command.replace(/^bayleaf /, '')])],
      audiences: [...new Set([...prev.audiences, ...e.audiences])],
    });
    app.transcript.scheduleRender();
  }
  // caller: the conversation whose tool asks (agent.js); a subagent's request
  // belongs to its own session and names it on the sheet.
  const childOf = (caller) => {
    const w = caller == null ? null : app.state.agent?.who(caller);
    return w?.child != null ? { sid: w.sid, id: w.child, name: (app.subagents.kids.get(String(w.sid)) ?? []).find((c) => c.id === w.child)?.name ?? 'subagent' } : null;
  };
  const egressHooks = {
    bayleafCredential: () => app.state.key,
    approveEgress: (req, caller) => {
      const c = childOf(caller);
      return c ? egress.approve(req, c.sid, c.name) : egress.approve(req, runSession());
    },
    onEgress: (e, caller) => { if (!childOf(caller)) noteEgress(e); },
  };

  // ── Models (src/models-cli.js): weights from the BayLeaf HF gateway ─────
  // One service for the `models` command (agents and the terminal) and
  // Settings. Downloads ask on the approval sheet, one at a time; only a
  // click approves. Each download is a /task entry with its own ctl.
  const modelsWho = (caller) => {
    const w = caller == null ? null : app.state.agent?.who(caller), c = childOf(caller);
    return { by: 'agent', caller, sid: w?.sid ?? null, name: c ? `subagent "${c.name}"` : 'main (a1)' };
  };
  let modelAsks = Promise.resolve();
  function approveModel(req, who) {
    const run = modelAsks.then(async () => {
      const asker = who.by === 'agent' ? `${who.sid != null ? `${titleOf(await sessions.find(who.sid).catch(() => null))} › ` : ''}${who.name}` : `you, in ${who.via ?? 'Pouch'}`;
      const get = req.action === 'get';
      const row = (k, v) => v ? [el('dt', { textContent: k }), el('dd', { textContent: v })] : [];
      const body = el('div', { className: 'model-approval' },
        el('p', { textContent: who.by === 'agent' ? `Asked by ${asker}. Only you can approve.` : `Asked by ${asker}.` }),
        el('dl', {}, ...row(get ? 'Size' : 'Frees', app.providers.mib(req.bytes) + (get && req.bytes < req.total ? ` (of ${app.providers.mib(req.total)}; the rest is already kept)` : '')),
          ...row('Kept in', req.location), ...row('License', req.license + (req.licenseUrl ? ` (${req.licenseUrl})` : '')), ...row('Attribution', req.attribution),
          ...row('Redistribution', req.distribution), ...row('From', req.origin)),
        el('p', { className: 'muted', textContent: get ? 'Every file is checked against the SHA-256 this page was built with. Nothing you type is sent; the gateway sees only which file ranges are requested. Stop any time from /task, Settings or the terminal; remove it any time.' : 'Sessions and files stay. Downloading it again takes the full size.' }));
      return app.tree.ask(body, get ? 'Download' : 'Remove', get ? 'primary' : 'danger', get ? (who.by === 'agent' ? `${who.name} asks to download ${req.label}` : `Download ${req.label}?`) : `${who.name} asks to remove ${req.label}`);
    });
    modelAsks = run.catch(() => {});
    return run;
  }
  const modelService = createModelService({ store: modelStore, tasks: app.state.vfs.tasks, approve: approveModel,
    supports: (id) => (LOCAL && id === LOCAL.id ? app.providers.localOk : { ok: true }),
    onChange: () => { const t = LOCAL && modelService.downloads.get(LOCAL.id); if (t?.status === 'running' && t.progress) app.providers.localProgress({ ...t.progress, downloading: true }); app.namespaces.renderLocalSettingsSoon(); } });
  // pdfinfo, pdftotext, pdftoppm (src/pdf.js): one pdf.js worker for the terminal and every agent, its runs /task jobs.
  const pdfService = createPdfService({ tasks: app.state.vfs.tasks });
  // ffprobe, ffmpeg (src/media.js): one libav.js worker, the same way.
  const mediaService = createMediaService({ tasks: app.state.vfs.tasks });

  return {
    get activeRun() { return activeRun; }, set activeRun(v) { activeRun = v; },
    egress,
    egressHooks,
    get focus() { return focus; }, set focus(v) { focus = v; },
    liveEgress,
    mediaService,
    modelService,
    modelsWho,
    pdfService,
    sessions,
  };
}
