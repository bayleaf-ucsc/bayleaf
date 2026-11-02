// Session list, egress consent hooks and the shared add-ons, pdf and media services.

import * as store from '../store.ts';
import { $, el } from '../dom.ts';
import { exhaustedText } from '../usage.ts';
import { createPdfService } from '../pdf.ts';
import { createMediaService } from '../media.ts';
import { createDuckdbService } from '../duckdb.ts';
import { createSessions, revertKey, sameId, titleOf } from '../sessions.ts';
import { createEgress, grantsFor, revoke, serviceName } from '../egress.ts';
import { LOCAL, localWorker, setSource } from '../local/host.ts';
import { askTitle, buildLock, createAddons, sizeText } from '../addons.ts';
import { DUCKDB, LFM3, LIBAVJS, PDFJS, REGISTRY, TRANSFORMERSJS } from '../addons-registry.ts';
import type { ConversationId } from '@earendil-works/pi-durable';
import type { ThreadItem, ToolItem } from '../agent-types.ts';
import type { Egress } from '../egress.ts';
import type { EgressNotice, EgressTrace } from '../trust.ts';
import type { MediaService } from '../media.ts';
import type { AddonRequest, AddonWho, Addons } from '../addons.ts';
import type { DuckdbService } from '../duckdb.ts';
import type { PdfService } from '../pdf.ts';
import type { Caller, ToolsHooks } from '../tools-types.ts';
import type { App } from './app.ts';

// The subagent whose view fills the chat pane; from: the peer it was opened from.
export interface SubagentFocus { sid: string; id: ConversationId; from: string | null; pinTop?: boolean }
export type AgentWho = Extract<AddonWho, { by: 'agent' }>;

export interface SessionListRegion {
  // The session whose run is active (a turn, a resumed run or Run script), if any.
  get activeRun(): string | null; set activeRun(v: string | null);
  egress: Egress;
  // The tools' egress hooks: approvals belong to the run's session, or a subagent's.
  egressHooks: Required<Pick<ToolsHooks, 'bayleafCredential' | 'approveEgress' | 'onEgress'>>;
  get focus(): SubagentFocus | null; set focus(v: SubagentFocus | null);
  // Running bash card id -> what left so far, until its output carries the marker.
  liveEgress: Map<string, Omit<EgressTrace, 'text'>>;
  addons: Addons;
  // This page's pouch-build:<sha256> lock (boot holds it); the sweep reads the others.
  build: ReturnType<typeof buildLock>;
  addonsWho(caller: Caller): AgentWho;
  duckdbService: DuckdbService;
  mediaService: MediaService;
  pdfService: PdfService;
  sessions: ReturnType<typeof createSessions>;
}

export function createSessionListRegion(app: App): SessionListRegion {
  // ── Sessions (sessions.ts) ──────────────────────────────────────────
  // focus: the subagent of the current session whose view fills the chat pane
  // (its live transcript; the composer steers it), or null for the session.
  let focus: SubagentFocus | null = null;
  const sessions = createSessions({
    forgetWatches: (id) => app.boot.watches.removeSession(String(id)), // watches key sessions by string id
    agent: () => app.state.agent, view: () => app.transcript.view, connected: () => (app.state.agent ? app.connection.sealed() : null),
    model: () => $<HTMLSelectElement>('model').value, setModel: (id) => { $<HTMLSelectElement>('model').value = id; app.providers.pickerProvider(); }, hasModel: (id) => app.connection.models.some((m) => m.id === id) || (app.providers.localOk.ok && id === app.providers.LOCAL_ID) || app.providers.lhModels().some((m) => 'localhost:' + m.id === id), isLocal: app.providers.offSealed,
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
    const t = app.transcript.view?.items.findLast((i: ThreadItem): i is ToolItem => i.type === 'tool' && i.name === 'bash' && i.status === 'running');
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
    bayleafCredential: () => app.auth.key,
    approveEgress: (req, caller) => {
      const c = childOf(caller);
      return c ? egress.approve(req, c.sid, c.name) : egress.approve(req, runSession());
    },
    onEgress: (e, caller) => { if (!childOf(caller)) noteEgress(e); },
  };

  // ── Add-ons (src/addons.ts): one service for the `addons` command (agents
  // and the terminal), Settings > Add-ons and the workers that need one.
  // Asked installs open the approval sheet, one at a time; only a click
  // approves. Each install is a /task entry with its own ctl.
  const addonsWho = (caller: Caller): AgentWho => {
    const w = caller == null ? null : app.state.agent?.who(caller), c = childOf(caller);
    return { by: 'agent', caller, sid: w?.sid ?? null, name: c ? `subagent "${c.name}"` : 'main (a1)' };
  };
  let addonAsks: Promise<unknown> = Promise.resolve();
  function approveAddon(req: AddonRequest) {
    const run = addonAsks.then(async () => {
      const who = req.who;
      const asker = who.by === 'agent' ? `${who.sid != null ? `${titleOf(await sessions.find(who.sid).catch(() => null))} › ` : ''}${who.name}` : `you, in ${who.via ?? 'Pouch'}`;
      const install = req.action === 'install';
      const row = (k: string, v: string | null | undefined) => v ? [el('dt', { textContent: k }), el('dd', { textContent: v })] : [];
      const items = req.items.map((i) => el('dl', {}, ...(req.items.length > 1 ? row('Add-on', i.label) : []),
        ...row(install ? 'Size' : 'Frees', sizeText(i.bytes) + (install && i.bytes < i.size ? ` (of ${sizeText(i.size)}; the rest is already kept)` : '')),
        ...row('License', i.license + (i.licenseUrl ? ` (${i.licenseUrl})` : '')), ...row('Attribution', i.attribution),
        ...row('Redistribution', i.distribution), ...row('From', i.from.join('; '))));
      const body = el('div', { className: 'model-approval' },
        el('p', { textContent: who.by === 'agent' ? `Asked by ${asker}. Only you can approve.` : `Asked by ${asker}.` }),
        ...items, el('dl', {}, ...row('Kept in', req.location)),
        el('p', { className: 'muted', textContent: install ? 'Every file is checked against the SHA-256 this page was built with. Nothing you type is sent; the server sees only which files or byte ranges are requested. Stop any time from /task, Settings or the terminal; remove it any time.' : 'Sessions and files stay. Installing it again takes the full size.' }));
      return app.tree.ask(body, install ? 'Install' : 'Remove', install ? 'primary' : 'danger', askTitle(req));
    });
    addonAsks = run.catch(() => {});
    return run;
  }
  const build = buildLock(globalThis.navigator?.locks);
  const addons = createAddons({ entries: REGISTRY, tasks: app.state.vfs.tasks, approve: approveAddon, otherBuilds: () => build.others(),
    // A loaded worker holds its add-on's code (and LFM3's weights): let it go first,
    // so the next use goes through the install path again.
    beforeRemove: (id) => (id === LFM3 || id === TRANSFORMERSJS ? localWorker.dispose() : id === PDFJS ? pdfService.jobs.unload('pdf') : id === LIBAVJS ? mediaService.jobs.unload('libav') : id === DUCKDB ? duckdbService.jobs.unload('duckdb') : undefined),
    onChange: () => {
      const t = LFM3 ? addons.installing(LFM3) : undefined;
      if (t?.progress) app.providers.localProgress({ ...t.progress, installing: true });
      app.addons.renderSoon();
    } });
  // The Transformers.js worker starts only from installed, verified files.
  if (LOCAL && LFM3) {
    const model = LFM3;
    setSource(async ({ network, onProgress }) => {
      const got = await addons.files(model, { network, onProgress: (p) => onProgress?.({ done: p.done, total: p.total, ...(p.id === TRANSFORMERSJS ? { phase: 'code' as const } : {}) }) });
      const w = got[model], c = got[TRANSFORMERSJS];
      return { weights: w.files, code: { files: c.files, manifest: c.manifest }, repaired: w.repaired + c.repaired };
    });
  }
  // pdfinfo, pdftotext, pdftoppm (src/pdf.ts): one pdf.js worker for the terminal and every agent, its runs /task jobs.
  const pdfService = createPdfService({ tasks: app.state.vfs.tasks, addons });
  // ffprobe, ffmpeg (src/media.ts): one libav.js worker, the same way.
  const mediaService = createMediaService({ tasks: app.state.vfs.tasks, addons });
  // duckdb (src/duckdb.ts): one DuckDB-Wasm worker, the same way; an asked add-on (src/addons-registry.ts).
  const duckdbService = createDuckdbService({ tasks: app.state.vfs.tasks, addons });

  return {
    get activeRun() { return activeRun; }, set activeRun(v) { activeRun = v; },
    egress,
    egressHooks,
    get focus() { return focus; }, set focus(v) { focus = v; },
    liveEgress,
    addons,
    addonsWho,
    duckdbService,
    build,
    mediaService,
    pdfService,
    sessions,
  };
}
