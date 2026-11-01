// File watches and boot: opening the agent and the first render.

import * as store from '../store.ts';
import { normalize } from '../vfs.ts';
import { CWD, createTools, defaultSubagentNs, systemPrompt } from '../tools.ts';
import { Type, openAgent } from '../agent.ts';
import { $ } from '../dom.ts';
import { arm } from '../motion.ts';
import { MAIN, asRef, refOf } from '../graph.ts';
import { convKey, interruptedKey, sameId, subagentsKey, watchesKey } from '../sessions.ts';
import { MAX_WAKES, baseOf, createWatches, isGlob, watchTool } from '../ns/watch.ts';
import { parseSpecs } from '../ns/namespace.ts';
import { why } from '../ns/control.ts';
import { LOCAL, engine as localEngine, support as localSupport, models as modelStore } from '../local/engine.ts';

export function createBootRegion(app) {
  // ── File watches (JOURNEYS G13-G17, src/ns/watch.ts) ────────────────
  // Each watch belongs to a session and an owner in it (main s1 or a
  // subagent). Events reach the owner through the same paths as messages
  // (agent.subagents.notify); the tray shows every watch with Stop watching.
  let agentReady;
  const agentStarted = new Promise((r) => { agentReady = r; });
  const refOfChild = (sid, id) => { const l = app.subagents.kids.get(String(sid)) ?? [], c = l.find((x) => x.id === id); return c ? { ref: refOf(l, c), name: c.name, c } : null; };
  const watches = app.state.vfs.watches = createWatches({
    fs: app.state.vfs.fs,
    load: (sid) => store.getSetting(watchesKey(sid)),
    save: (sid, l) => store.setSetting(watchesKey(sid), l.length ? l : undefined),
    sessions: async () => (await app.sessionList.sessions.all()).map((x) => x.id),
    // A subagent watches only inside its own mounts; main sees the whole tree.
    scopeOf: (sid, owner) => {
      if (asRef(owner) === MAIN) return null;
      const l = app.subagents.kids.get(String(sid)) ?? [], c = l.find((x) => refOf(l, x) === asRef(owner));
      return parseSpecs(c?.ns?.length ? c.ns : defaultSubagentNs(app.state.vfs)).map((x) => x.path);
    },
    followUpHeld: (sid) => { const q = app.queues.followUps.get(String(sid)); return !!q && !q.paused; },
    userSending: (sid) => app.queues.submitting.has(String(sid)),
    busy: (sid, owner) => app.state.agent?.subagents?.busyOf(sid, owner) ?? false,
    deliver: (sid, owner, { paths = [], ...ev }) => {
      for (const p of paths) arm('pulse:' + p);
      if (paths.length) app.tree.renderTree();
      return app.state.agent.subagents.notify(sid, owner, ev);
    },
    ready: agentStarted,
    onChange: () => app.state.composer?.renderTray(),
  });
  async function watchCaller(caller) {
    const w = app.state.agent?.who(caller) ?? {};
    const sid = w.sid ?? caller;
    if (w.child != null) {
      const r = refOfChild(sid, w.child);
      if (!r) throw new Error('This subagent is not registered yet; try again.');
      return { sid, owner: r.ref, ownerName: r.name };
    }
    return { sid, owner: MAIN, ownerName: 'main' };
  }
  const watchByText = (w) => (w.by === 'user' ? 'by you' : w.by === 'agent' ? 'by agents' : 'by anyone');
  const shortPath = (p) => (p.startsWith('/work/') ? p.slice(6) : p);
  function watchRows(sid) {
    const rows = [];
    for (const w of watches.list(sid)) {
      const what = w.paths.map(shortPath).join(', ');
      const origin = `${w.id} · changes ${watchByText(w)}${w.owner !== MAIN ? ` · for ${w.ownerName} (${w.owner})` : ''} · /task/watch/${w.id}`;
      const title = `${w.note ? w.note + '\n' : ''}${w.paths.join('\n')}\n${w.once ? 'Removed after its first event.' : `Wakes the agent at most ${MAX_WAKES} times between your messages.`}`;
      const stop = () => app.namespaces.ctl(`/task/watch/${w.id}/ctl`, 'stop').then(() => app.queues.announce(`Stopped watching ${what}.`), (e) => app.state.status(why(e), 'bad'));
      if (w.held.length) {
        const files = [...new Set(w.held.map((h) => shortPath(h.path)))];
        rows.push({ key: 'watch:' + w.id, kind: 'watch', text: `${w.held.length} change${w.held.length === 1 ? '' : 's'} to ${files.join(', ')}, not delivered`, title, origin,
          actions: [{ label: 'Deliver', act: 'deliver', ariaLabel: `Deliver ${w.held.length} held changes to the agent`, run: () => app.namespaces.ctl(`/task/watch/${w.id}/ctl`, 'deliver').catch((e) => app.state.status(why(e), 'bad')) }],
          stopLabel: 'Stop watching', stopAria: `Stop watching ${what}`, stop });
      } else if (w.once && w.paths.some(isGlob)) {
        rows.push({ key: 'watch:' + w.id, kind: 'watch', text: `Waiting for files in ${w.paths.map((p) => shortPath(baseOf(p))).join(', ')}${w.note ? ': ' + w.note : ''}`, title, origin, since: w.created,
          stopLabel: 'Cancel', stopAria: `Cancel waiting for files in ${what}`, stop });
      } else {
        rows.push({ key: 'watch:' + w.id, kind: 'watch', text: `Watching ${what}${w.note ? ': ' + w.note : ''}`, title, origin,
          stopLabel: 'Stop watching', stopAria: `Stop watching ${what}`, stop });
      }
    }
    return rows;
  }

  // ── Boot ────────────────────────────────────────────────────────────
  // Files first, so the workspace is usable even if the network or the agent is not.
  let agentError = null;
  let toolList = []; // kept for Run script, which uses the run tool without the model
  // The watch tool joins the page's tools (BayLeaf Sealed, main and subagents;
  // the transformersjs profile keeps its four qualified tools).
  const withWatch = (list) => { list.push(watchTool({ Type, watches, callerOf: watchCaller })); return list; };
  (async () => {
    app.state.usage.subscribe(async (st) => { await app.state.ledger.observe(st.remaining); app.state.meter(); if (app.state.layout.current() === 'usage') app.meters.renderUsagePanel(); if (!app.state.key && app.state.verified && /^Not signed in/.test($('status').textContent)) app.state.status(app.auth.campusLine(st)); });
    if (location.hash === '#erased') { history.replaceState(null, '', location.pathname + location.search); $('erased').hidden = false; }
    navigator.storage.persist?.().catch(() => {});
    // Not awaited: the offline copy must never hold up files or the agent.
    app.install.shellCopy.start().then(() => app.install.shellCopy.supported && app.install.shellCopy.enabled() && navigator.onLine && app.install.checkUpdate(false))
      .catch((e) => app.install.renderCopy('Offline copy: ' + e.message, 'bad'));
    try { await app.state.vfs.init(); } catch (e) { app.state.status('Storage problem: ' + e.message, 'bad'); }
    app.tree.offerDefaults();
    app.tree.renderTree();
    $('welcome').hidden = !!(await store.getSetting('welcomed').catch(() => true));
    app.state.key = (await store.getSetting('key')) ?? null;
    app.providers.lh = (await store.getSetting('localhost')) ?? null;
    app.providers.renderLocalhostSettings();
    app.auth.renderAuth();
    app.state.usage.refresh();
    app.providers.localOk = await localSupport();
    await app.connection.loadModels();
    app.providers.renderLocalSettings();
    // Parts kept from pouch.bayleaf.dev before the gateway: reassembled, checked
    // against the pins and moved, so nobody downloads 1.1 GB again (src/models.ts).
    if (LOCAL) modelStore.migrate().then((r) => {
      if (!r) return;
      if (r.migrated.length || r.partial.length) app.state.status(`Moved the Transformers.js model kept by an earlier Pouch (${app.providers.mib(r.bytes)}, checked against this page's pins)${r.partial.length ? '; Download fetches the rest' : ''}. Nothing was downloaded again.`);
      else if (r.refused.length) app.state.status(`An earlier Pouch kept files that do not match this page's pins (${r.refused.join(', ')}); they were removed. Download fetches them from api.bayleaf.dev.`, 'bad');
      app.providers.renderLocalSettings();
    }, (e) => app.state.status('Could not move the model kept by an earlier Pouch: ' + e.message, 'bad'));
    try {
      app.state.agent = await openAgent({
        local: LOCAL && app.providers.localOk.ok ? { info: LOCAL, engine: localEngine, onHint: app.providers.showHint } : null,
        localhost: { config: app.providers.lhAgentConfig(), onWait: app.providers.localhostWait },
        tools: toolList = withWatch(createTools(app.state.vfs, Type, {}, {
          // A subagent's writes carry its name for file watches.
          sourceOf: (caller) => { const w = app.state.agent?.who(caller); const r = w?.child != null && refOfChild(w.sid, w.child); return r ? `subagent ${r.name} (${r.ref})` : 'subagent'; },
          // A subagent's change is its own run; the main agent's joins the turn.
          // A subagent's namespace: what its spawn declared, or the default view.
          namespaceFor: (caller) => { const w = caller == null ? null : app.state.agent?.who(caller); return w?.child != null ? (w.ns?.length ? w.ns : defaultSubagentNs(app.state.vfs)) : null; },
          // Main's tools see its own session's control files at /session (src/ns/control.ts).
          sessionOf: (caller) => (caller == null ? null : app.state.agent?.who(caller)?.sid ?? null),
          mainView: (caller, base) => { const w = caller == null ? null : app.state.agent?.who(caller); return w && w.child == null && w.sid != null ? app.namespaces.mainNamespace(w.sid, base) : base; },
          // Every change an agent makes, for /session/<sid>/changes (subagents marked by their ref).
          onChange: (caller, op, path) => { const w = app.state.agent?.who(caller); if (w?.sid != null) app.namespaces.changes.note(w.sid, op, path, w.child != null ? refOfChild(w.sid, w.child)?.ref ?? 'subagent' : MAIN); },
          ...app.sessionList.egressHooks,
          models: app.sessionList.modelService, modelsWho: app.sessionList.modelsWho, pdf: app.sessionList.pdfService, media: app.sessionList.mediaService,
          show: app.editing.show,
        })),
        systemPrompt: () => systemPrompt(app.state.vfs),
        getClient: async () => (app.state.verified ? app.state.client : null),
        onRequest: app.queues.countRequest,
        models: app.state.models,
        pointer: { get: (id) => store.getSetting(convKey(id)), set: (id, c) => store.setSetting(convKey(id), c) },
        onInterrupted: async (sids) => {
          for (const sid of sids) if (sid != null) await store.setSetting(interruptedKey(sid), true);
          if (sids.some((x) => sameId(x, app.sessionList.sessions.current?.id))) { app.transcript.interrupted = true; app.transcript.scheduleRender(); }
        },
        subagents: {
          reg: { get: (sid) => store.getSetting(subagentsKey(sid)), set: (sid, l) => store.setSetting(subagentsKey(sid), l) },
          onChange: app.subagents.onKids,
          onCap: (sid, e) => { const list = app.commands.capEvents.get(String(sid)) ?? []; list.push(e); app.commands.capEvents.set(String(sid), list.slice(-3)); if (sameId(sid, app.sessionList.sessions.current?.id)) app.state.composer?.renderTray(); },
          onBlocked: (sid) => { if (sameId(sid, app.sessionList.sessions.current?.id)) { app.state.composer?.renderTray(); app.queues.updateSend(); } },
          onReport: (sid, sub) => app.subagents.drive(sid, () => sub.wait()),
          // The user's follow-up goes before agent wakes (D25).
          followUpHeld: (sid) => { const q = app.queues.followUps.get(String(sid)); return (!!q && !q.paused) || app.queues.submitting.has(String(sid)); },
          onSettle: async (sid, c) => { toolList.closeView?.(c.id); app.state.usage.refresh(); },
          lowAllowance: app.subagents.lowAllowance,
          // A one-shot's attached files, read in main's namespace (paths relative to /work).
          readFile: async (f) => {
            const path = normalize(f.startsWith('/') ? f : CWD + '/' + f);
            const text = await app.state.vfs.fs.readFile(path).catch((e) => { throw new Error(`files: ${path} could not be read (${/ENOENT/.test(e.code ?? e.message) ? 'it does not exist' : e.message}).`); });
            return { path, text };
          },
          watchLines: (sid, ref) => { const l = watches.list(sid).filter((w) => ref === MAIN || w.owner === ref); return l.length ? 'Watches: ' + l.map((w) => `${w.id} ${w.paths.join(', ')}${w.note ? ` (${w.note})` : ''}`).join('; ') : ''; },
        },
      });
    } catch (e) {
      agentError = 'The agent could not start: ' + e.message;
      app.state.status(agentError, 'bad');
    }
    if (!(await app.sessionList.sessions.boot())) app.transcript.renderLog();
    // Sessions whose subagents were running when the page went away: open them
    // so pi-durable resumes their runs and the reports still arrive.
    if (app.state.agent?.subagents) {
      const ids = [];
      for (const s of await app.sessionList.sessions.all()) if ((await app.subagents.loadKids(s.id)).some((c) => c.status === 'running' || (c.sub && !c.foreground && c.reported !== c.sub))) ids.push(s.id);
      if (ids.length) { app.sessionList.sessions.render(); app.state.agent.open(ids); }
    }
    // Watches come back after a reload; files changed meanwhile fire once.
    agentReady();
    watches.boot().catch((e) => console.warn('Pouch watches:', e));
    await app.connection.connect();
  })();

  return {
    get agentError() { return agentError; },
    get toolList() { return toolList; },
    watches,
    watchRows,
  };
}
