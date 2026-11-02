// Slash commands, the activity tray and the composer widget.

import { normalize } from '../vfs.ts';
import { CWD, loadContext } from '../tools.ts';
import { $, el } from '../dom.ts';
import { refOf } from '../graph.ts';
import { sameId, titleOf } from '../sessions.ts';
import { why } from '../ns/control.ts';
import { createComposer } from '../composer.ts';
import { grantsFor, revoke, serviceName } from '../egress.ts';
import { LOCAL } from '../local/engine.ts';
import type { App } from './app.ts';
import type { ThreadItem } from '../agent-types.ts';
import type { SubagentHost, SubagentRow } from '../subagents-types.ts';
import type { ComposerCommand, TrayRow } from '../composer.ts';

// A message refused at a cap (graph.js), shown in the tray until dismissed.
export type CapEvent = Parameters<NonNullable<SubagentHost['onCap']>>[1];
// What the tray reads of a thread item (a tool call's args and details).
export interface ActivityItem {
  type: string; id: string; name?: string; status?: string; at?: number; details?: { child?: unknown };
  args?: { name?: string; task?: string; action?: string; path?: string; code?: string };
}

export interface CommandsRegion {
  // Per session id: the last three cap refusals.
  capEvents: Map<string, CapEvent[]>;
  excerpt(t: unknown, n?: number): string;
  // The running subagent a spawn call started, once it exists.
  spawnedAs(it: ThreadItem | ActivityItem): SubagentRow | undefined;
  // A spawn call still streaming or running, before its subagent exists.
  startingSpawn(it: ThreadItem | ActivityItem): boolean;
}

export function createCommandsRegion(app: App): CommandsRegion {
  // Slash commands: typed whole ("/rename Notes") or picked from the list.
  async function revertLast() {
    if (app.queues.busy()) return app.state.status('Stop Pouch before reverting.', 'bad');
    const items = (app.state.view?.items ?? []) as Parameters<App['transcript']['revertTo']>[0][], u = items.findLastIndex((i) => i.type === 'user');
    const target = u < 0 ? null : items.slice(0, u).findLast((i) => i.entry && !i.streaming && (i.type === 'user' || i.text || i.error));
    if (u < 0) return app.state.status('Nothing to revert yet.', 'bad');
    return app.transcript.revertTo(target ?? items[u]); // the first turn: revert to empty (revertFirst)
  }
  const COMMANDS: ComposerCommand[] = [
    { name: 'new', hint: 'Start a new session', run: () => app.sessionList.sessions.blank() },
    { name: 'seed', hint: '<archive> stacks /work over a read-only .zip or .tar; /seed off removes it', run: async (arg) => {
      if (arg === 'off') { await app.state.vfs.unstack(); app.tree.renderTree(); return app.state.status('Removed the seed layer; /work shows only your files.'); }
      if (!arg) return app.state.status(app.state.vfs.seedLayer ? `/work is stacked over ${app.state.vfs.seedLayer.name}. /seed off removes it.` : 'Give an archive: /seed /work/starter.zip', app.state.vfs.seedLayer ? '' : 'bad');
      await app.tree.stackSeed(normalize(arg.startsWith('/') ? arg : CWD + '/' + arg));
    } },
    // Hints that name a cost are getters: worded for the current session's provider.
    { name: 'compact', get hint() { return `Summarize older turns (${app.sessionList.sessions.costOf()})`; }, run: async () => {
      if (!app.sessionList.sessions.current) return app.state.status('No session to compact yet.', 'bad');
      await app.sessionList.sessions.compact(app.sessionList.sessions.current.id);
    } },
    { name: 'rename', get hint() { return `Rename this session: /rename Title, or /rename alone to let the model suggest one (${app.sessionList.sessions.costOf()})`; }, run: async (arg) => {
      if (!app.sessionList.sessions.current) return app.state.status('No session to rename yet.', 'bad');
      if (!arg) {
        app.state.status(`Suggesting a title (${app.sessionList.sessions.costOf()})...`);
        if (await app.sessionList.sessions.renameAuto(app.sessionList.sessions.current.id)) app.state.status('Renamed: ' + titleOf(app.sessionList.sessions.current));
        return;
      }
      Object.assign(app.sessionList.sessions.current, { title: arg.slice(0, 120), titleSource: 'user' });
      await app.sessionList.sessions.save(); app.sessionList.sessions.render();
      app.state.status('Renamed.');
    } },
    { name: 'revert', hint: 'Revert the last turn (asks first, can be undone)', run: revertLast },
    { name: 'usage', hint: 'Show today\'s allowance and tokens', run: () => app.state.layout.open('usage') },
    { name: 'files', hint: 'Show your files', run: () => app.state.layout.open('files') },
    { name: 'erase', hint: 'Erase all Pouch data in this browser (asks first)', run: () => app.auth.eraseAll() },
    { name: 'help', hint: 'What you can type here', run: () => app.state.sheet('Typing in Pouch', [], el('div', {},
      el('p', { textContent: '@ inserts a path from your files. $ asks Pouch to use a skill. / runs a command instead of sending; a / followed by anything else is sent as text.' }),
      el('ul', {}, ...COMMANDS.map((c) => el('li', {}, el('code', { textContent: '/' + c.name }), ' ' + c.hint))),
      el('p', { textContent: 'Enter sends (on touch screens, tap Send). Shift+Enter is a new line. While Pouch works, Enter steers: Pouch reads your message after its current step. Alt+Enter (Option+Enter on a Mac) sends it as a follow-up, after the turn, instead; Settings can swap the two. Esc stops; Alt+Up takes a follow-up back to edit.' }))) },
  ];
  const capEvents = new Map<string, CapEvent[]>(); // message-cap refusals shown in the tray
  // A spawn call still streaming or running, before its subagent exists.
  // Once a subagent of that name runs, it has its own card and row instead.
  const spawnedAs = (it: ActivityItem) => (app.subagents.kids.get(String(app.sessionList.sessions.current?.id)) ?? []).find((c) => c.name === it.args?.name && c.status === 'running' && (!it.at || c.started >= it.at - 1000));
  const startingSpawn = (it: ActivityItem) => it.type === 'tool' && it.name === 'subagent' && it.status === 'running' && it.details?.child == null && (it.args?.action === 'spawn' || (it.args?.action == null && it.args?.task != null)) && !spawnedAs(it);
  const runSeen = new Map<string, number>(); // running `run` call id -> first seen (ms), for the tray's elapsed time
  const excerpt = (t: unknown, n = 90) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  function activity() {
    const sid = app.sessionList.sessions.current?.id, key = app.queues.curKey(), rows: TrayRow[] = [];
    // Subagents main is blocked on (a foreground spawn, a wait): Background detaches (G12).
    const held = new Set<string>(sid != null && app.state.agent?.subagents ? app.state.agent.subagents.blocked(sid).flatMap((h) => h.ids) : []);
    const l = app.subagents.kids.get(String(sid)) ?? [];
    // A spawn the model is still writing (or starting): a row at once, so the
    // seconds before the subagent exists are not a dead zone (critique 48).
    if (!app.sessionList.focus) for (const it of (app.state.view?.items ?? []) as ActivityItem[]) if (startingSpawn(it)) {
      const since = runSeen.get(it.id) ?? Date.now(); runSeen.set(it.id, since);
      rows.push({ key: 'sa-start:' + it.id, kind: 'subagent', text: `${it.args?.name ?? 'subagent'}: starting`, title: it.args?.task ?? 'A subagent is starting', origin: 'starting', since });
    }
    for (const c of l) if (c.status === 'running') {
      const t = app.state.vfs.tasks.byKeyOf('sa:' + c.id), ref = refOf(l, c), waited = held.has(ref);
      rows.push({ key: 'sa:' + c.id, kind: 'subagent', seed: ref, text: `${c.name}: ${excerpt(c.task)}`, title: `Open ${c.name}: ` + c.task + (t ? `\n/task/${t.id} sees:\n${app.state.vfs.tasks.mounts(t).join('\n')}` : ''), origin: waited ? `main waits on ${ref}` : t ? `subagent ${ref}, /task/${t.id}` : `subagent ${ref}`, since: c.resumed ?? c.started,
        open: (e?: Event) => app.subagents.openChild(sid!, c.id, e?.currentTarget as HTMLElement | undefined), stop: () => app.namespaces.ctl(app.namespaces.agentFile(sid!, ref, 'ctl'), 'stop').catch((e) => app.state.status(why(e), 'bad')),
        ...(waited ? { background: () => app.namespaces.ctl(app.namespaces.agentFile(sid!, ref, 'ctl'), 'detach').catch((e) => app.state.status(why(e), 'bad')) } : {}) });
    }
    // A message refused at a cap (graph.js): visible until dismissed.
    for (const [i, e] of (capEvents.get(String(sid)) ?? []).entries()) {
      rows.push({ key: `cap:${e.at}:${i}`, kind: 'cap', text: `${e.from} to ${e.to}: not sent`, title: e.text, origin: 'message limit', stopLabel: 'Dismiss',
        stop: () => { const list = capEvents.get(String(sid)) ?? []; list.splice(list.indexOf(e), 1); app.state.composer!.renderTray(); } });
    }
    const live = new Set<string>();
    for (const t of (app.state.view?.items ?? []) as ActivityItem[]) if (t.type === 'tool' && t.name === 'run' && t.status === 'running') {
      live.add(t.id);
      if (!runSeen.has(t.id)) runSeen.set(t.id, Date.now());
      const task = app.state.vfs.tasks.byKeyOf(t.id);
      rows.push({ key: 'run:' + t.id, kind: 'run', text: 'run ' + (t.args?.path ?? excerpt(t.args?.code?.split('\n').find((l) => l.trim()) ?? '', 70)),
        title: (t.args?.code ?? t.args?.path) + (task ? `\n/task/${task.id} sees:\n${app.state.vfs.tasks.mounts(task).join('\n')}` : ''),
        origin: task ? `run, /task/${task.id}` : 'run', since: runSeen.get(t.id), stop: () => (task ? app.namespaces.ctl(`/task/${task.id}/ctl`, 'kill').catch((e) => app.state.status(why(e), 'bad')) : app.state.status('That run already finished.')) });
    }
    for (const id of runSeen.keys()) if (!live.has(id)) runSeen.delete(id);
    for (const p of app.sessionList.egress.pending) {
      rows.push({ key: 'eg:' + p.id, kind: 'approval', text: p.command, origin: p.agentName ? `${p.agentName}: waiting for you` : 'waiting for you', since: p.since, open: () => app.sessionList.egress.focus() });
    }
    // Pending input (D25): steers not yet read, the follow-up or paused message.
    for (const st of app.queues.steers.get(key) ?? []) {
      rows.push({ key: 'steer:' + st.id, kind: 'steer', seed: st.child ? (app.subagents.kids.get(String(sid)) ?? []).find((c) => c.id === st.child)?.ref : undefined, text: excerpt(st.text), title: st.text,
        origin: (st.child ? `Steering ${st.name}` : 'Steering') + ' · after current step' + (st.detach ? ` · detaches ${st.detach}` : ''), since: st.at,
        stopLabel: 'Cancel', stopAria: 'Cancel steering message',
        stop: async () => {
          const back = await app.queues.withdrawSteers(key, (st.child ? app.sessionList.focus?.sid ?? sid : sid)!, (x) => x === st);
          if (back.length) { app.queues.putBack(back[0]); app.queues.announce('Steering message cancelled and put back in the box.'); }
          else app.queues.announce(`Already delivered to ${st.child ? st.name : 'Pouch'}.`);
          app.state.composer!.renderTray();
        } });
    }
    const q = app.queues.followUps.get(key);
    if (q) {
      const on = app.queues.waitingOn(sid);
      rows.push({ key: 'followup', kind: 'followup', paused: q.paused, text: excerpt(q.text), title: q.text,
        origin: q.paused ? 'Paused after Stop' : app.queues.busy() ? 'Follow-up · after this turn' + (on.length ? ` (main is waiting on ${on.join(', ')})` : '') : 'Follow-up · sends when ready',
        actions: q.paused ? [{ label: 'Send', act: 'send', ariaLabel: 'Send paused message', run: () => app.send.sendNow(key, false) }]
          : [{ label: 'Edit', act: 'edit', ariaLabel: 'Edit follow-up (Alt+Up)', run: () => app.queues.cancelFollowUp(key, 'edit') },
            ...(app.queues.busy() ? [{ label: 'Steer now', act: 'promote', ariaLabel: 'Steer now: send the follow-up into the current turn' + (on.length ? `; detaches ${on.join(', ')}` : ''), run: () => app.send.sendNow(key, true) }] : [])],
        stopLabel: 'Cancel', stopAria: q.paused ? 'Cancel paused message' : 'Cancel follow-up', stop: () => app.queues.cancelFollowUp(key) });
    }
    if (sid != null) rows.push(...app.boot.watchRows(sid));
    for (const [id, cq] of app.queues.childFollowUps) if (sameId(cq.sid, sid)) {
      const c = (app.subagents.kids.get(String(sid)) ?? []).find((x) => x.id === id);
      rows.push({ key: 'cq:' + id, kind: 'followup', paused: cq.paused, text: excerpt(cq.text), title: cq.text,
        origin: cq.paused ? `Paused for ${cq.name}` : `Follow-up for ${cq.name} · after its turn`,
        actions: cq.paused ? [{ label: 'Send', act: 'send', ariaLabel: `Send paused message to ${cq.name}`, run: async () => { app.queues.childFollowUps.delete(id); app.state.composer!.renderTray(); await app.namespaces.ctl(app.namespaces.agentFile(sid!, (c ? refOf(app.subagents.kids.get(String(sid)) ?? [], c) : id) as string, 'in'), 'message\n' + cq.text).catch((e) => app.state.status(why(e), 'bad')); } }]
          : c?.status === 'running' ? [{ label: 'Steer now', act: 'promote', ariaLabel: `Steer now: send to ${cq.name} after its current step`, run: async () => {
            app.queues.childFollowUps.delete(id);
            await app.namespaces.ctl(app.namespaces.agentFile(sid!, refOf(app.subagents.kids.get(String(sid)) ?? [], c), 'in'), 'steer\n' + cq.text).catch((e) => app.state.status(why(e), 'bad'));
          } }] : [],
        stopLabel: 'Cancel', stopAria: `Cancel follow-up for ${cq.name}`, stop: () => { app.queues.childFollowUps.delete(id); app.queues.putBack(cq.text); app.queues.announce('Follow-up cancelled and put back in the box.'); app.state.composer!.renderTray(); } });
    }
    return rows;
  }
  app.state.composer = createComposer({
    vfs: app.state.vfs, input: $<HTMLTextAreaElement>('input'), fail: app.tree.fail,
    roots: () => ['/work', '/pouch', '/tmp', ...[...app.state.vfs.mounts].filter(([, m]) => m.live).map(([n]) => '/mnt/' + n)],
    skills: async () => (await loadContext(app.state.vfs)).skills,
    commands: COMMANDS,
    activity,
    turnSpend: app.queues.turnSpend,
    mainBusy: () => app.queues.busy(),
    // Stop all: main's run and every subagent and run of this session. Requests
    // in flight are aborted (the encrypted fetch carries the abort signal), and
    // stopped work starts no new request.
    stopAll: async () => {
      const sid = app.sessionList.sessions.current?.id;
      if (sid != null) await app.namespaces.ctl(`/session/${sid}/ctl`, 'stop').catch((e) => app.state.status(why(e), 'bad'));
      app.queues.announce('Stopped everything in this session. Requests in flight were cancelled; one BayLeaf had already received may still count, and no new one starts.');
    },
    shield: async () => {
      const sid = app.sessionList.sessions.current?.id;
      if (app.providers.localhostPicked()) return {
        provider: 'Localhost: your machine runs the model', icon: 'laptop',
        detail: `${$<HTMLSelectElement>('model').value.slice('localhost:'.length)} runs on your server at ${app.providers.lh?.base ?? 'this computer'}. Pouch sends that server this session's messages, the files the model reads and tool results, in plain text over loopback; it never leaves this computer through Pouch. What your server does with them (logs, or forwarding them as a proxy) is your responsibility. No BayLeaf allowance is used, and it works with Wi-Fi off. Tools run here, in the page.`,
        grants: (await grantsFor(sid)).map((service) => ({ label: serviceName(service), revoke: async () => {
          await revoke(sid, service); app.state.status(`Pouch will ask again before ${serviceName(service)} in this session.`);
        } })),
        trust: () => app.state.layout.open('trust'),
      };
      if (app.providers.localPicked()) return {
        provider: 'Transformers.js: in this browser, nothing sent',
        detail: `${LOCAL!.label} runs in this browser on your GPU. Prompts, files and replies stay here; no request leaves for any model. Tools run here, in the page. Switch to a BayLeaf Sealed model in the picker for larger tasks.`,
        grants: (await grantsFor(sid)).map((service) => ({ label: serviceName(service), revoke: async () => {
          await revoke(sid, service); app.state.status(`Pouch will ask again before ${serviceName(service)} in this session.`);
        } })),
        trust: () => app.state.layout.open('trust'),
      };
      return {
        provider: app.state.verified ? 'BayLeaf Sealed: encrypted to the enclave' : app.connection.offline ? 'BayLeaf Sealed: offline, nothing is sent' : 'BayLeaf Sealed: verifying the enclave',
        detail: app.state.verified ? 'This session\'s model requests are encrypted in this page to an attested enclave; BayLeaf relays ciphertext. Tools run here, in the page.'
          : 'Nothing is sent until the enclave verifies. There is no plaintext fallback.',
        grants: (await grantsFor(sid)).map((service) => ({ label: serviceName(service), revoke: async () => {
          await revoke(sid, service); app.state.status(`Pouch will ask again before ${serviceName(service)} in this session.`);
        } })),
        trust: () => app.state.layout.open('trust'),
      };
    },
    onRow: app.queues.trayRowMotion,
    onTray: () => app.state.follow.stick(),
  });

  return {
    capEvents,
    excerpt,
    // ThreadItem's args and details are unknown: read as an ActivityItem.
    spawnedAs: spawnedAs as CommandsRegion['spawnedAs'],
    startingSpawn: startingSpawn as CommandsRegion['startingSpawn'],
  };
}
