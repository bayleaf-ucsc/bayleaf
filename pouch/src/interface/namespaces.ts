// Control plane wiring: per-session namespaces and the terminal.

import { defaultSubagentNs, describeSpecs } from '../tools.ts';
import { $ } from '../dom.ts';
import { MAIN, asRef, refOf } from '../graph.ts';
import { createTerminal } from '../terminal.ts';
import { sameId, titleOf } from '../sessions.ts';
import { over } from '../ns/namespace.ts';
import { createChanges, createControl } from '../ns/control.ts';
import { TaskFs } from '../ns/tasks.ts';
import type { AssistantItem, SessionId } from '../agent-types.ts';
import type { AgentRow, Changes, Control, UsageFacts } from '../ns/control.ts';
import type { TerminalVfs } from '../terminal.ts';
import type { ViewMode } from '../preview.ts';
import type { Namespace } from '../ns/namespace.ts';
import type { App } from './app.ts';

export interface NamespacesRegion {
  // The path of one agent's control file: /session/<sid>/agents/<ref>/<file>.
  agentFile(sid: SessionId, ref: string, file: string): string;
  // What the agents changed this turn, per session.
  changes: Changes;
  control: Control;
  // Every acting control in the Interface: a write through the user's namespace.
  ctl(path: string, text: string): Promise<unknown>;
  // Main's namespace: base plus its own session's /session and /task.
  mainNamespace(sid: SessionId | null | undefined, base: Namespace): Namespace;
  renderLocalSettingsSoon(): void;
}

export function createNamespacesRegion(app: App): NamespacesRegion {
  let settingsTimer: ReturnType<typeof setTimeout> | null = null;
  const renderLocalSettingsSoon = () => { if (!settingsTimer) settingsTimer = setTimeout(() => { settingsTimer = null; app.providers.renderLocalSettings(); }, 250); };

  // ── Control plane (src/ns/control.ts, README "Control plane") ─────────
  // Everything that acts is a file under /session (agents) or /task (runs,
  // terminal commands, watches). The Interface is one client: its buttons call
  // ctl(), which writes those files through the user's namespace, exactly as
  // the terminal's `echo stop > ...` does. What a write does is the harness
  // side, below ("Control plane: the harness side"). The agent files are served
  // from the same caches the Interface draws (kids, sessions.running), so the
  // two cannot disagree; the Interface hears changes from the events tail.
  const mainSince = new Map<string, number>(); // session id -> when main's current turn started
  async function agentRows(sid: string): Promise<AgentRow[]> {
    const k = String(sid);
    const l = app.subagents.kids.has(k) ? app.subagents.kids.get(k)! : await app.subagents.loadKids(sid);
    const working = app.sessionList.sessions.running.has(k);
    const state = app.queues.stopping.has(k) ? 'stopping' : working ? (app.state.agent?.subagents?.blocked(sid).length ? 'waiting' : 'working') : 'idle';
    return [{ ref: MAIN, name: 'main', kind: 'main', state, since: working ? mainSince.get(k) : undefined, ns: app.state.vfs.describe() },
      ...l.map((c) => ({ ref: refOf(l, c), name: c.name, kind: 'subagent' as const, state: c.status, since: c.resumed ?? c.started, ended: c.status === 'running' ? undefined : c.ended, task: c.task,
        ns: describeSpecs(app.state.vfs, c.ns?.length ? c.ns : defaultSubagentNs(app.state.vfs)) }))];
  }
  const changes = createChanges(); // what the agents changed this turn, per session
  const control = createControl({
    sessions: async () => (await app.sessionList.sessions.all()).map((x) => ({ id: x.id, title: titleOf(x) })),
    current: () => app.sessionList.sessions.current?.id ?? null,
    agents: agentRows,
    last: async (sid, ref) => {
      if (asRef(ref) === MAIN) return ((await app.state.agent?.snapshot(sid).catch(() => null))?.items.findLast((i) => i.type === 'assistant' && i.text) as AssistantItem | undefined)?.text ?? '';
      const l = app.subagents.kids.get(String(sid)) ?? [], c = l.find((x) => refOf(l, x) === ref);
      return c && app.state.agent?.subagents ? (await app.state.agent.subagents.summary(sid, c.id).catch(() => null))?.answer ?? '' : '';
    },
    // /session/<sid>/usage: the allowance, this turn's requests (spend) and today's (the ledger).
    usage: async (sid) => ({ allowance: app.state.usage.state as UsageFacts['allowance'], turn: app.queues.spend.get(String(sid)) ?? 0, today: (await app.state.ledger.snapshot().catch(() => null))?.bySid?.[String(sid)] ?? 0 }), // usage.ts's resetsAt is a Date; new Date() takes it
    changes: (sid) => changes.list(sid),
  });
  // The user's namespace: the shared tree plus /session with the user's authority.
  const userNs = over(app.state.vfs.fs, [['/session', control.view({ by: 'user' }), { label: 'control (you)' }]]);
  // Every acting control in the Interface goes through here (test/controlplane-node.mjs).
  const ctl = (path: string, text: string) => userNs.writeFile(path, text);
  const agentFile = (sid: SessionId, ref: string, file: string) => `/session/${sid}/agents/${asRef(ref)}/${file}`;
  // Main sees its own session's control files, ctl writable, in refused (control.ts).
  const mainNs = new Map<string, Namespace>(); // sid -> namespace
  function mainNamespace(sid: SessionId | null | undefined, base: Namespace) {
    if (sid == null) return base;
    // /task too is cut to this session: its runs, subagents and watches (src/ns/tasks.ts).
    if (!mainNs.has(String(sid))) mainNs.set(String(sid), over(base, [['/session', control.view({ by: 'agent', sid }), { label: 'control (a1)' }],
      ['/task', new TaskFs(app.state.vfs.tasks, () => app.state.vfs.watches, { sid }), { label: 'tasks (this session)' }]]));
    return mainNs.get(String(sid))!;
  }
  { // main's working/idle state, for /session and its events
    const r = app.sessionList.sessions.running, add = r.add.bind(r), del = r.delete.bind(r);
    r.add = (k: string) => { const had = r.has(k); add(k); if (!had) { mainSince.set(k, Date.now()); control.state(k, MAIN, 'working'); } return r; };
    r.delete = (k: string) => { const had = del(k); if (had) control.state(k, MAIN, 'idle'); return had; };
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

  // ── Terminal (terminal.ts) ──────────────────────────────────────────
  // The user's shell over the same namespace; `bayleaf` asks every use. Ctrl+`
  // opens it (or focuses it); opening it never sends anything.
  const terminal = createTerminal({ vfs: app.state.vfs as TerminalVfs, fs: over(app.state.vfs.as('user'), [['/session', control.view({ by: 'user', label: 'terminal' }), { label: 'control (you)' }]]), onChange: () => app.tree.renderTree(),
    hooks: { bayleafCredential: () => app.state.key, approveEgress: (req) => app.sessionList.egress.approve(req, null, undefined, 'you, in the terminal'), models: app.sessionList.modelService, pdf: app.sessionList.pdfService, media: app.sessionList.mediaService,
      openFile: ({ path, mode, interactive }) => app.editing.openFile(path, undefined, { mode: mode as ViewMode, interactive }) as Promise<boolean>, revealDir: (path) => app.transcript.revealDir(path) } });
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
