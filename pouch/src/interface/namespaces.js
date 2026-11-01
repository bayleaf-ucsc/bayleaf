// Control plane wiring: per-session namespaces and the terminal.

import { defaultSubagentNs, describeSpecs } from '../tools.js';
import { $ } from '../dom.js';
import { MAIN, asRef, refOf } from '../graph.js';
import { createTerminal } from '../terminal.js';
import { sameId, titleOf } from '../sessions.js';
import { over } from '../ns/namespace.js';
import { createChanges, createControl } from '../ns/control.js';
import { TaskFs } from '../ns/tasks.js';

export function createNamespacesRegion(app) {
  let settingsTimer = null;
  const renderLocalSettingsSoon = () => { if (!settingsTimer) settingsTimer = setTimeout(() => { settingsTimer = null; app.providers.renderLocalSettings(); }, 250); };

  // ── Control plane (src/ns/control.js, README "Control plane") ─────────
  // Everything that acts is a file under /session (agents) or /task (runs,
  // terminal commands, watches). The Interface is one client: its buttons call
  // ctl(), which writes those files through the user's namespace, exactly as
  // the terminal's `echo stop > ...` does. What a write does is the harness
  // side, below ("Control plane: the harness side"). The agent files are served
  // from the same caches the Interface draws (kids, sessions.running), so the
  // two cannot disagree; the Interface hears changes from the events tail.
  const mainSince = new Map(); // session id -> when main's current turn started
  async function agentRows(sid) {
    const k = String(sid);
    const l = app.subagents.kids.has(k) ? app.subagents.kids.get(k) : await app.subagents.loadKids(sid);
    const working = app.sessionList.sessions.running.has(k);
    const state = app.queues.stopping.has(k) ? 'stopping' : working ? (app.state.agent?.subagents?.blocked(sid).length ? 'waiting' : 'working') : 'idle';
    return [{ ref: MAIN, name: 'main', kind: 'main', state, since: working ? mainSince.get(k) : undefined, ns: app.state.vfs.describe() },
      ...l.map((c) => ({ ref: refOf(l, c), name: c.name, kind: 'subagent', state: c.status, since: c.resumed ?? c.started, ended: c.status === 'running' ? undefined : c.ended, task: c.task,
        ns: describeSpecs(app.state.vfs, c.ns?.length ? c.ns : defaultSubagentNs(app.state.vfs)) }))];
  }
  const changes = createChanges(); // what the agents changed this turn, per session
  const control = createControl({
    sessions: async () => (await app.sessionList.sessions.all()).map((x) => ({ id: x.id, title: titleOf(x) })),
    current: () => app.sessionList.sessions.current?.id ?? null,
    agents: agentRows,
    last: async (sid, ref) => {
      if (asRef(ref) === MAIN) return (await app.state.agent?.snapshot(sid).catch(() => null))?.items.findLast((i) => i.type === 'assistant' && i.text)?.text ?? '';
      const l = app.subagents.kids.get(String(sid)) ?? [], c = l.find((x) => refOf(l, x) === ref);
      return c && app.state.agent?.subagents ? (await app.state.agent.subagents.summary(sid, c.id).catch(() => null))?.answer ?? '' : '';
    },
    // /session/<sid>/usage: the allowance, this turn's requests (spend) and today's (the ledger).
    usage: async (sid) => ({ allowance: app.state.usage.state, turn: app.queues.spend.get(String(sid)) ?? 0, today: (await app.state.ledger.snapshot().catch(() => null))?.bySid?.[String(sid)] ?? 0 }),
    changes: (sid) => changes.list(sid),
  });
  // The user's namespace: the shared tree plus /session with the user's authority.
  const userNs = over(app.state.vfs.fs, [['/session', control.view({ by: 'user' }), { label: 'control (you)' }]]);
  // Every acting control in the Interface goes through here (test/controlplane-node.mjs).
  const ctl = (path, text) => userNs.writeFile(path, text);
  const agentFile = (sid, ref, file) => `/session/${sid}/agents/${asRef(ref)}/${file}`;
  // Main sees its own session's control files, ctl writable, in refused (control.js).
  const mainNs = new Map(); // sid -> namespace
  function mainNamespace(sid, base) {
    if (sid == null) return base;
    // /task too is cut to this session: its runs, subagents and watches (src/ns/tasks.js).
    if (!mainNs.has(String(sid))) mainNs.set(String(sid), over(base, [['/session', control.view({ by: 'agent', sid }), { label: 'control (a1)' }],
      ['/task', new TaskFs(app.state.vfs.tasks, () => app.state.vfs.watches, { sid }), { label: 'tasks (this session)' }]]));
    return mainNs.get(String(sid));
  }
  { // main's working/idle state, for /session and its events
    const r = app.sessionList.sessions.running, add = r.add.bind(r), del = r.delete.bind(r);
    r.add = (k) => { const had = r.has(k); add(k); if (!had) { mainSince.set(k, Date.now()); control.state(k, MAIN, 'working'); } return r; };
    r.delete = (k) => { const had = del(k); if (had) control.state(k, MAIN, 'idle'); return had; };
  }
  // The events tail: a blocking-read loop, as any client would run it. Writes
  // that came from the terminal or the main agent are said out loud here.
  (async () => {
    for await (const evs of control.tail()) {
      let mine = false;
      for (const e of evs) {
        const [, sid, ref, kind, ...rest] = e.line.split(' ');
        if (!sameId(sid, app.sessionList.sessions.current?.id)) continue;
        mine = true;
        const by = rest.join(' ').match(/by (you \(terminal\)|main \(a1\))/)?.[1];
        if (by && (kind === 'ctl' || kind === 'in')) app.queues.announce(`${by === 'main (a1)' ? 'Main' : 'From the terminal'}: ${kind === 'ctl' ? rest[0] + (rest[1] === 'all' ? ' all' : '') : rest[0]} ${app.subagents.whoRef(ref)}.`, false);
      }
      if (mine) { app.state.composer?.renderTray(); app.queues.updateSend(); app.sessionList.sessions.render(); }
    }
  })();

  // ── Terminal (terminal.js) ──────────────────────────────────────────
  // The user's shell over the same namespace; `bayleaf` asks every use. Ctrl+`
  // opens it (or focuses it); opening it never sends anything.
  const terminal = createTerminal({ vfs: app.state.vfs, fs: over(app.state.vfs.as('user'), [['/session', control.view({ by: 'user', label: 'terminal' }), { label: 'control (you)' }]]), onChange: () => app.tree.renderTree(),
    hooks: { bayleafCredential: () => app.state.key, approveEgress: (req) => app.sessionList.egress.approve(req, null, undefined, 'you, in the terminal'), models: app.sessionList.modelService, pdf: app.sessionList.pdfService, media: app.sessionList.mediaService,
      openFile: ({ path, mode, interactive }) => app.editing.openFile(path, undefined, { mode, interactive }), revealDir: (path) => app.transcript.revealDir(path) } });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '`' || !e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    if (app.state.layout.current() === 'terminal' && document.activeElement === $('term-input')) app.state.layout.close();
    else { app.state.layout.open('terminal'); terminal.focus(); }
  });

  return {
    agentFile,
    changes,
    control,
    ctl,
    mainNamespace,
    renderLocalSettingsSoon,
  };
}
