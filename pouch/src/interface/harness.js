// Control plane, the harness side: stop, steer and follow-up through ctl files.

import { $ } from '../dom.js';
import { MAIN, asRef, refOf } from '../graph.js';
import { sameId } from '../sessions.js';

export function createHarnessRegion(app) {
  // ── Control plane: the harness side ───────────────────────────────
  // What a write to /session does, whoever wrote it (the Interface, the
  // terminal, the main agent). The only place the Interface calls the harness
  // to act; test/controlplane-node.mjs checks that nothing outside does.
  const busyIn = (sid) => (sameId(sid, app.sessionList.sessions.current?.id) ? app.queues.busy() : app.sessionList.sessions.running.has(String(sid)));
  const childByRef = (sid, ref) => { const l = app.subagents.kids.get(String(sid)) ?? []; return l.find((x) => refOf(l, x) === asRef(ref)) ?? l.find((x) => x.id === ref); };
  const ctlErr = (msg) => Object.assign(new Error(msg), { code: 'EINVAL' });
  async function stopSession(sid, all) {
    const key = String(sid);
    if (!app.sessionList.sessions.running.has(key) && !busyIn(sid)) { if (all) await app.state.agent?.subagents?.stopAll?.(sid); return all ? 'stopped its subagents' : 'main (a1) is idle'; }
    app.queues.stopping.add(key); app.queues.updateSend();
    try {
      const back = await app.queues.withdrawSteers(key, sid, (s) => !s.child);
      const q = app.queues.followUps.get(key);
      if (back.length || q) {
        app.queues.followUps.set(key, { attached: app.queues.noFiles(), turnModel: $('model').value, at: Date.now(), ...q, text: [...back, q?.text].filter(Boolean).join('\n\n'), paused: true });
        app.queues.announce('Stopped. Your unsent message is paused: Send it or Cancel it in the activity tray.');
      }
      app.state.composer.renderTray();
      // Stop in a session stops its subagents too (as Stop all does).
      await Promise.allSettled([app.state.agent.abort(sid), all ? app.state.agent?.subagents?.stopAll?.(sid) : null]);
      // A steer that slipped in while the run wound down (Enter right after
      // Stop) has no step left to be read after: it becomes the next turn.
      const late = await app.queues.withdrawSteers(key, sid, (s) => !s.child);
      if (late.length) {
        const q2 = app.queues.followUps.get(key);
        app.queues.followUps.set(key, { attached: app.queues.noFiles(), turnModel: $('model').value, at: Date.now(), ...q2, text: [q2?.text, ...late].filter(Boolean).join('\n\n'), paused: q2?.paused ?? false });
        app.queues.announce(q2?.paused ? 'Pouch stopped before reading your message: it joined the paused message in the activity tray.' : 'Pouch stopped before reading your message, so it goes as the next turn.');
      }
    } finally { app.queues.stopping.delete(key); app.state.composer.renderTray(); app.queues.updateSend(); queueMicrotask(app.queues.pump); }
  }
  // Stop one subagent: steers not yet read and its follow-up become one paused item.
  async function stopChildOf(sid, id) {
    const c = childByRef(sid, id) ?? (app.subagents.kids.get(String(sid)) ?? []).find((x) => x.id === id);
    if (!c) throw ctlErr(`no agent ${id} in this session`);
    const key = String(sid);
    const back = await app.queues.withdrawSteers(key, sid, (s) => s.child === c.id);
    const q = app.queues.childFollowUps.get(c.id);
    if (back.length || q) {
      app.queues.childFollowUps.set(c.id, { sid, name: c.name, at: Date.now(), ...q, text: [...back, q?.text].filter(Boolean).join('\n\n'), paused: true });
      app.queues.announce(`Stopped ${c.name}. Your unsent message to it is paused in the activity tray.`);
    }
    app.state.composer.renderTray();
    const note = await app.state.agent.subagents.stop(sid, c.id);
    // A ctl write returns once it took effect: reading its status next says stopped.
    for (let i = 0; i < 60 && (await app.subagents.loadKids(sid)).find((x) => x.id === c.id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    return note;
  }
  // Main's steer: detach a subagent it waits on (G10), then track it in the tray.
  async function steerSession(sid, text) {
    const key = String(sid), names = app.queues.waitingOn(sid);
    let s = names.length ? await app.state.agent.subagents.detach(sid, text) : null;
    if (!s || s === true) s = await app.state.agent.steer(sid, text);
    app.boot.watches.userSpoke(sid);
    const held = names.length && sameId(sid, app.sessionList.sessions.current?.id) ? app.queues.heldCards(sid) : [];
    app.queues.track(key, sid, { id: s.id, text, at: Date.now(), ...(names.length ? { detach: names.join(', ') } : {}) }, s.placed, app.queues.promoteNext);
    if (held.length) app.queues.foldIntoTray(held);
    app.queues.announce(names.length ? `Steering: Pouch reads this after its current step. Main stopped waiting on ${names.join(', ')}; it keeps running.` : 'Steering: Pouch reads this after its current step.');
    return { id: s.id };
  }
  // A subagent's follow-up goes once its turn ends (it finished): the
  // message wakes it, like Message on its card. Stopped or failed: paused.
  function flushChildFollowUps(sid, list) {
    for (const [id, q] of app.queues.childFollowUps) {
      if (q.paused || String(q.sid) !== String(sid)) continue;
      const c = list.find((x) => x.id === id);
      if (c?.status === 'running') continue;
      if (c?.status !== 'finished') { app.queues.childFollowUps.set(id, { ...q, paused: true }); app.queues.announce(`${q.name} ${c?.status ?? 'is gone'}; your follow-up to it is paused.`); continue; }
      app.queues.childFollowUps.delete(id);
      app.state.agent.subagents.message(sid, id, q.text).then(() => app.queues.announce(`Follow-up sent to ${q.name}; it works on it now.`, false), (e) => { app.queues.childFollowUps.set(id, { ...q, paused: true }); app.state.status(e.message, 'bad'); });
    }
  }
  app.namespaces.control.drive({
    async stop(sid, ref, { all }) {
      if (!app.state.agent) throw ctlErr('the agent is not available');
      if (asRef(ref) === MAIN) return stopSession(sid, all);
      return stopChildOf(sid, ref);
    },
    async detach(sid, ref) {
      const held = app.state.agent?.subagents?.blocked(sid).flatMap((h) => h.ids) ?? [];
      if (!held.length) throw ctlErr('main is not waiting on any subagent');
      if (asRef(ref) !== MAIN && !held.includes(asRef(ref))) throw ctlErr(`main is not waiting on ${asRef(ref)} (it waits on ${held.join(', ')})`);
      const cards = sameId(sid, app.sessionList.sessions.current?.id) ? app.queues.heldCards(sid) : [];
      await app.state.agent.subagents.detach(sid);
      app.queues.foldIntoTray(cards);
      const names = held.map((r) => childByRef(sid, r)?.name ?? r);
      app.state.status(`${names.join(', ')} ${names.length > 1 ? 'continue' : 'continues'} in the background; main stopped waiting.`);
      return { detached: held };
    },
    async send(sid, ref, mode, text) {
      if (!app.state.agent) throw ctlErr('the agent is not available');
      const key = String(sid);
      if (asRef(ref) === MAIN) {
        const working = busyIn(sid) || app.queues.submitting.has(key);
        if (mode === 'followup') { await app.queues.holdFollowUp(key, async () => ({ text, attached: app.queues.noFiles(), turnModel: $('model').value, at: Date.now() })); return { followup: true }; }
        if (working) return steerSession(sid, text);
        if (mode === 'steer') throw ctlErr('main (a1) is idle, so there is no turn to steer: write message to start one, or followup');
        if (!sameId(sid, app.sessionList.sessions.current?.id)) throw ctlErr('a turn starts only in the session open in the Interface: open it, or write followup to queue this');
        app.queues.dispatch(key, async () => ({ text, attached: app.queues.noFiles(), turnModel: $('model').value, at: Date.now() }));
        return { started: true };
      }
      const c = childByRef(sid, ref);
      if (!c) throw ctlErr(`no agent ${ref} in this session`);
      if (mode === 'steer') {
        if (c.status !== 'running') throw ctlErr(`${c.name} (${asRef(ref)}) is not running (${c.status}): write message to start it again`);
        const s = await app.state.agent.subagents.steerTracked(sid, c.id, text);
        app.queues.track(key, sid, { id: s.id, text, at: Date.now(), child: c.id, name: c.name }, s.placed);
        app.queues.announce(`Steering ${c.name}: it reads this after its current step.`);
        return { id: s.id };
      }
      if (mode === 'followup' && c.status === 'running') {
        const had = app.queues.childFollowUps.get(c.id);
        app.queues.childFollowUps.set(c.id, { sid, name: c.name, at: Date.now(), ...had, text: had ? `${had.text}\n\n${text}` : text, paused: false });
        app.queues.announce(had ? `Added to the follow-up for ${c.name}.` : `Follow-up for ${c.name}: it goes when its turn ends.`);
        app.state.composer.renderTray(); app.queues.updateSend();
        return { followup: true };
      }
      if (c.oneshot) throw ctlErr(`${c.name} is a one-shot and takes no messages`);
      app.queues.childFollowUps.delete(c.id);
      const note = await app.state.agent.subagents.message(sid, c.id, text);
      app.state.status(`Sent to ${c.name}.`);
      return { note };
    },
  });
  // ── End of the harness side ───────────────────────────────────────

  return {
    flushChildFollowUps,
    stopChildOf,
  };
}
