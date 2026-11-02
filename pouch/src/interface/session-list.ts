// Session list, egress consent hooks and the shared model, pdf and media services.

import * as store from '../store.ts';
import { $, el } from '../dom.ts';
import { exhaustedText } from '../usage.ts';
import { createPdfService } from '../pdf.ts';
import { createMediaService } from '../media.ts';
import { createSessions, revertKey, sameId, titleOf } from '../sessions.ts';
import { createEgress, grantsFor, revoke, serviceName } from '../egress.ts';
import { LOCAL, models as modelStore } from '../local/engine.ts';
import { createModelService } from '../models-cli.ts';
import type { ConversationId } from '@earendil-works/pi-durable';
import type { ThreadView, ToolItem } from '../agent-types.ts';
import type { Egress } from '../egress.ts';
import type { EgressNotice, EgressTrace } from '../trust.ts';
import type { MediaService } from '../media.ts';
import type { ModelRequest, ModelService, ModelWho } from '../models-cli.ts';
import type { PdfService } from '../pdf.ts';
import type { Caller, ToolsHooks } from '../tools-types.ts';
import type { App } from './app.ts';

// The subagent whose view fills the chat pane; from: the peer it was opened from.
export interface SubagentFocus { sid: string; id: ConversationId; from: string | null; pinTop?: boolean }
export type AgentWho = Extract<ModelWho, { by: 'agent' }>;

export interface SessionListRegion {
  // The session whose run is active (a turn, a resumed run or Run script), if any.
  get activeRun(): string | null; set activeRun(v: string | null);
  egress: Egress;
  // The tools' egress hooks: approvals belong to the run's session, or a subagent's.
  egressHooks: Required<Pick<ToolsHooks, 'bayleafCredential' | 'approveEgress' | 'onEgress'>>;
  get focus(): SubagentFocus | null; set focus(v: SubagentFocus | null);
  // Running bash card id -> what left so far, until its output carries the marker.
  liveEgress: Map<string, Omit<EgressTrace, 'text'>>;
  mediaService: MediaService;
  modelService: ModelService;
  modelsWho(caller: Caller): AgentWho;
  pdfService: PdfService;
  sessions: ReturnType<typeof createSessions>;
}

export function createSessionListRegion(app: App): SessionListRegion {
  // ── Sessions (sessions.ts) ──────────────────────────────────────────
  // focus: the subagent of the current session whose view fills the chat pane
  // (its live transcript; the composer steers it), or null for the session.
  let focus: SubagentFocus | null = null;
  const sessions = createSessions({
    forgetWatches: (id) => app.boot.watches.removeSession(id as string), // watches key sessions by string id
    agent: () => app.state.agent, view: () => app.state.view as ThreadView | null, connected: () => (app.state.agent && app.state.verified ? app.state.client : null),
    model: () => $<HTMLSelectElement>('model').value, setModel: (id) => { $<HTMLSelectElement>('model').value = id; app.providers.pickerProvider(); }, hasModel: (id) => app.state.models.some((m) => m.id === id) || (app.providers.localOk.ok && id === app.providers.LOCAL_ID) || app.providers.lhModels().some((m) => 'localhost:' + m.id === id), isLocal: app.providers.offSealed,
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
      const t = await store.getSetting<{ at?: number }>(revertKey(s.id)); // transcript.ts's revert token
      return t ? [[`Undo revert to ${app.transcript.shortTime(t.at)}`, () => app.transcript.undoRevert(s.id)]] : [];
    },
  });

  // ── Leaving the pouch (egress.ts, D10) ──────────────────────────────
  // The bayleaf command asks before every request; a run belongs to the
  // session it was sent from, even if you switch away meanwhile.
  // The session whose run is active (a turn, a resumed run or Run script), if any.
  let activeRun: string | null = null;
  const runSession = () => activeRun ?? (sessions.current ? String(sessions.current.id) : null);
  const egress = createEgress({ sessionTitle: async (sid) => titleOf(await sessions.find(sid)), onPending: () => { app.state.composer?.renderTray(); sessions.render(); }, onGrant: () => app.state.composer?.refreshShield() });
  // Running bash card id -> { commands, audiences }, until its output carries the marker.
  const liveEgress: SessionListRegion['liveEgress'] = new Map();
  function noteEgress(e: EgressNotice) {
    if (!sameId(runSession(), sessions.current?.id)) return; // shown from the marker when you switch back
    const t = app.state.view?.items.findLast?.((i) => i.type === 'tool' && i.name === 'bash' && i.status === 'running') as ToolItem | undefined;
    if (!t) return;
    const prev = liveEgress.get(t.id) ?? { commands: [], audiences: [] };
    liveEgress.set(t.id, {
      commands: [...new Set([...prev.commands, e.command.replace(/^bayleaf /, '')])],
      audiences: [...new Set([...prev.audiences, ...e.audiences])],
    });
    app.transcript.scheduleRender();
  }
  // caller: the conversation whose tool asks (agent.ts); a subagent's request
  // belongs to its own session and names it on the sheet.
  const childOf = (caller: Caller) => {
    const w = caller == null ? null : app.state.agent?.who(caller);
    return w?.child != null ? { sid: w.sid, id: w.child, name: (app.subagents.kids.get(String(w.sid)) ?? []).find((c) => c.id === w.child)?.name ?? 'subagent' } : null;
  };
  const egressHooks: SessionListRegion['egressHooks'] = {
    bayleafCredential: () => app.state.key,
    approveEgress: (req, caller) => {
      const c = childOf(caller);
      return c ? egress.approve(req, c.sid, c.name) : egress.approve(req, runSession());
    },
    onEgress: (e, caller) => { if (!childOf(caller)) noteEgress(e); },
  };

  // ── Models (src/models-cli.ts): weights from the BayLeaf HF gateway ─────
  // One service for the `models` command (agents and the terminal) and
  // Settings. Downloads ask on the approval sheet, one at a time; only a
  // click approves. Each download is a /task entry with its own ctl.
  const modelsWho = (caller: Caller): AgentWho => {
    const w = caller == null ? null : app.state.agent?.who(caller), c = childOf(caller);
    return { by: 'agent', caller, sid: w?.sid ?? null, name: c ? `subagent "${c.name}"` : 'main (a1)' };
  };
  let modelAsks: Promise<unknown> = Promise.resolve();
  function approveModel(req: ModelRequest, who: ModelWho) {
    const run = modelAsks.then(async () => {
      const asker = who.by === 'agent' ? `${who.sid != null ? `${titleOf(await sessions.find(who.sid).catch(() => null))} › ` : ''}${who.name}` : `you, in ${who.via ?? 'Pouch'}`;
      const get = req.action === 'get';
      const row = (k: string, v: string | null | undefined) => v ? [el('dt', { textContent: k }), el('dd', { textContent: v })] : [];
      const body = el('div', { className: 'model-approval' },
        el('p', { textContent: who.by === 'agent' ? `Asked by ${asker}. Only you can approve.` : `Asked by ${asker}.` }),
        el('dl', {}, ...row(get ? 'Size' : 'Frees', app.providers.mib(req.bytes) + (get && req.bytes < req.total ? ` (of ${app.providers.mib(req.total)}; the rest is already kept)` : '')),
          ...row('Kept in', req.location), ...row('License', req.license + (req.licenseUrl ? ` (${req.licenseUrl})` : '')), ...row('Attribution', req.attribution),
          ...row('Redistribution', req.distribution), ...row('From', req.origin)),
        el('p', { className: 'muted', textContent: get ? 'Every file is checked against the SHA-256 this page was built with. Nothing you type is sent; the gateway sees only which file ranges are requested. Stop any time from /task, Settings or the terminal; remove it any time.' : 'Sessions and files stay. Downloading it again takes the full size.' }));
      return app.tree.ask(body as unknown as string, get ? 'Download' : 'Remove', get ? 'primary' : 'danger', get ? (who.by === 'agent' ? `${who.name} asks to download ${req.label}` : `Download ${req.label}?`) : `${(who as { name?: string }).name} asks to remove ${req.label}`); // TreeRegion.ask is typed string; it takes a Node body too
    });
    modelAsks = run.catch(() => {});
    return run;
  }
  const modelService = createModelService({ store: modelStore, tasks: app.state.vfs.tasks, approve: approveModel,
    supports: (id) => (LOCAL && id === LOCAL.id ? app.providers.localOk : { ok: true }),
    onChange: () => { const t = LOCAL && modelService.downloads.get(LOCAL.id); if (t?.status === 'running' && t.progress) app.providers.localProgress({ ...t.progress, downloading: true }); app.namespaces.renderLocalSettingsSoon(); } });
  // pdfinfo, pdftotext, pdftoppm (src/pdf.ts): one pdf.js worker for the terminal and every agent, its runs /task jobs.
  const pdfService = createPdfService({ tasks: app.state.vfs.tasks });
  // ffprobe, ffmpeg (src/media.ts): one libav.js worker, the same way.
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
