// Sending: a turn's admission, errors and the composer's key and menu wiring.

import * as store from '../store.ts';
import { $ } from '../dom.ts';
import { exhaustedText } from '../usage.ts';
import { refOf } from '../graph.ts';
import { interruptedKey, notesKey, type SessionRecord } from '../sessions.ts';
import { why } from '../ns/control.ts';
import { isLocal } from '../local/provider.ts';
import { explainMessage, isLocalhost } from '../localhost.ts';
import { dismissible } from '../dismiss.ts';
import type { App } from './app.ts';
import type { Attachments, SessionId } from '../agent-types.ts';
import type { SubagentRow } from '../subagents-types.ts';

export interface SendRegion {
  autosize(): void;
  closeSendMenu(refocus?: boolean): void;
  // HTTP 429 or a quota message, from the relay or the model provider.
  quotaError(msg: string | null | undefined): boolean;
  // runEnded: the model's turn is over (before the after-turn chores); adopted: a first message's session was made.
  send(text: string, attached?: Attachments, turnModel?: string, runEnded?: () => void, adopted?: (id: SessionId) => void): Promise<void>;
  // A paused message or follow-up goes now: the next turn when idle, else into the running turn (steer).
  sendNow(key: string, steer: boolean): Promise<void>;
}

export function createSendRegion(app: App): SendRegion {
  // The composer exists once the regions are created (src/interface/commands.ts).
  const renderTray = () => app.state.composer?.renderTray();
  const composer = () => app.state.composer ?? (() => { throw new Error('The composer is not ready.'); })();
  // A thrown value as an Error (a library may throw a non-Error).
  const errorOf = (x: unknown) => (x instanceof Error ? x : new Error(typeof x === 'object' && x && 'message' in x ? String(x.message) : String(x)));
  // A paused message or follow-up goes now: as the next turn when idle, or into
  // the running turn (Steer now).
  async function sendNow(key: string, steer: boolean) {
    const q = app.queues.followUps.get(key);
    if (!q) return;
    if (!app.queues.busy() && !app.queues.submitting.has(key)) { app.queues.followUps.delete(key); return app.queues.dispatch(key, () => q); }
    if (!steer) { app.queues.followUps.set(key, { ...q, paused: false }); app.queues.announce('Follow-up: it goes after this turn.'); return renderTray(); }
    if (q.attached.files.length || q.attached.images.length) return app.state.status('This follow-up has attachments, which go only with a new turn; it stays a follow-up.', 'bad');
    app.queues.followUps.delete(key);
    const keep = $<HTMLTextAreaElement>('input').value;
    await app.queues.steerMain(key, q.text, true);
    if (keep && !$<HTMLTextAreaElement>('input').value) { $<HTMLTextAreaElement>('input').value = keep; autosize(); }
    renderTray(); app.queues.updateSend();
  }
  const NOT_ADMITTED = /^Not connected|still running/;
  // HTTP 429 or a quota message, from the relay or the model provider.
  function quotaError(msg: string | null | undefined) { return /\b429\b|quota|rate.?limit|too many requests|allowance/i.test(msg ?? ''); }

  // runEnded: called once the model's turn is over, before the after-turn
  // chores (title, usage), so a follow-up need not wait for them.
  async function send(text: string, attached: Attachments = { files: [], images: [] }, turnModel = $<HTMLSelectElement>('model').value, runEnded = () => {}, adopted: (id: SessionId) => void = () => {}) {
    app.state.follow.pin();
    app.editing.handOver();
    const t0 = Date.now();
    let s: SessionRecord | null | void = app.sessionList.sessions.current; // the run belongs to this session even if you switch away
    if (!s) {
      s = await app.sessionList.sessions.create((made) => { app.state.ledger.adopt('new', made.id); adopted(made.id); });
      if (!s) throw new Error(app.boot.agentError ?? 'The agent is not available.');
    }
    const sid = s.id;
    s.model = turnModel;
    // Until a real title comes: the prompt's start, cut at a word, without trailing / . , : (critique 6).
    if (!s.title) { const t = text.replace(/\s+/g, ' ').trim(); s.title = (t.length > 60 ? t.slice(0, 60).replace(/\s+\S*$/, '') || t.slice(0, 60) : t).replace(/[\s/.,:;-]+$/, ''); }
    s.updated = Date.now(); await app.sessionList.sessions.save(s);
    app.transcript.clearInterrupted(sid);
    await store.setSetting(interruptedKey(sid), undefined);
    app.sessionList.sessions.running.add(String(sid)); app.sessionList.sessions.render();
    app.connection.lostRuns.delete(String(sid));
    if (isLocal(turnModel)) { app.providers.localRuns.add(String(sid)); app.providers.clearHint(sid); }
    if (isLocalhost(turnModel)) app.providers.lhRuns.add(String(sid));
    app.sessionList.activeRun = String(sid);
    const notes = (await store.getSetting<string[]>(notesKey(sid))) ?? [];
    const admitted = () => notes.length && store.setSetting(notesKey(sid), undefined);
    let ok = false, refused: Error | null = null;
    app.boot.watches.userSpoke(String(sid)); // the user wrote: watches may wake it again
    const agent = app.state.agent;
    try {
      // Not admitted: dispatch keeps the text (NOT_ADMITTED).
      if (!agent) throw new Error('Not connected: the agent is not available.');
      await agent.send(sid, text, notes, attached, turnModel); admitted(); ok = true;
    }
    catch (x) {
      const e = errorOf(x);
      // Refused before admission: nothing entered the transcript. The caller
      // holds it as a follow-up or restores the text (dispatch), so it is never lost.
      if (NOT_ADMITTED.test(e.message)) refused = e;
      // Stopped before the message entered the transcript: it was never sent,
      // so it comes back to the box (dispatch) rather than vanishing.
      else if (e.message === 'Stopped.' && !(await agent?.snapshot(sid).catch(() => null))?.items.some((i) => i.type === 'user' && i.text === text)) refused = new Error('Stopped before your message was sent; it is back in the box.');
      else admitted();
      // The run's own error (an assistant item) may carry the HTTP status the summary lost.
      const failed = app.transcript.view?.items.findLast?.((i) => i.type === 'assistant' && !!i.error);
      const detail = e.message + ' ' + (failed?.type === 'assistant' ? failed.error ?? '' : '');
      if (isLocalhost(turnModel)) { if (!refused && e.message !== 'Stopped.') app.state.status('Localhost: ' + (explainMessage(detail, turnModel.slice('localhost:'.length)) ?? e.message), 'bad'); }
      else if (quotaError(detail)) app.state.status(exhaustedText(await app.state.usage.refresh()), 'bad');
      else if (!isLocal(turnModel) && (app.connection.lostRuns.has(String(sid)) || app.connection.isNetworkError(detail))) {
        app.connection.lostRuns.add(String(sid));
        if (!navigator.onLine || !(await app.connection.probe())) app.connection.goOffline();
        else app.state.status('Connection lost during the turn; nothing more was sent. Send again to continue.', 'bad');
      }
      else if (!refused && e.message !== 'Stopped.') app.state.status('Request failed: ' + e.message, 'bad');
    }
    finally { app.sessionList.sessions.running.delete(String(sid)); app.providers.localRuns.delete(String(sid)); app.providers.lhRuns.delete(String(sid)); app.sessionList.activeRun = null; runEnded(); if (app.providers.lhWaitShown) app.providers.localhostWait('flowing'); }
    if (refused) throw refused;
    const ms = Date.now() - t0;
    const v = (await agent?.snapshot(sid).catch(() => null)) ?? null;
    await app.transcript.recordTurn(sid, v, ms);
    await app.sessionList.sessions.afterTurn(sid, v, ok, turnModel);
  }

  // mode: 'default' (Enter, the setting), 'other' (Alt+Enter), or one of
  // 'steer', 'followup', 'stopsend' (the split button and its menu).
  let nextMode: string = 'default';
  $('composer').onsubmit = async (e) => {
    e.preventDefault();
    const asked = nextMode; nextMode = 'default';
    const mode = asked === 'default' ? app.state.settings.sendMode() : asked === 'other' ? app.queues.otherMode(app.state.settings.sendMode()) : asked;
    const raw = $<HTMLTextAreaElement>('input').value;
    if (app.sessionList.focus) return toChild(raw.trim(), mode);
    if (composer().runCommand(raw)) { $<HTMLTextAreaElement>('input').value = ''; autosize(); return; }
    const key = app.queues.curKey();
    const text = raw.trim() || (app.queues.attachments.files.length ? 'Please examine the attached files.' : '');
    if (!text) return;
    if (app.queues.deleting.has(key)) return app.state.status('This session is being deleted. Your message stays here.', 'bad');
    const turnModel = $<HTMLSelectElement>('model').value; // freeze before any asynchronous preparation
    if (isLocalhost(turnModel)) {
      // Localhost needs your server, not the internet or the enclave.
      if (!app.state.agent) return app.state.status(app.boot.agentError ?? 'The agent is not available.', 'bad');
      if (!app.providers.lhModels().some((m) => 'localhost:' + m.id === turnModel)) return app.state.status('That Localhost model is not set up in this browser: Settings > Providers > Localhost, Test connection. Your message stays here.', 'bad');
    } else if (isLocal(turnModel)) {
      // Transformers.js needs no network or enclave, only the model in this browser.
      if (!app.state.agent) return app.state.status(app.boot.agentError ?? 'The agent is not available.', 'bad');
      if (!(await app.providers.ensureLocal())) return; // the text stays in the composer
    } else {
      if (app.connection.offline) return app.state.status(app.connection.OFFLINE, 'offline'); // the text stays in the composer
      if (!app.state.agent || !app.connection.verified) return app.state.status(app.boot.agentError ?? 'Not ready yet: Pouch is still verifying the enclave. Your message stays here.', 'bad');
    }
    const prepare = async () => {
      const attached = await app.queues.attachments.prepare(app.connection.models.find((m) => m.id === turnModel));
      if (key !== app.queues.curKey()) throw new Error('Session changed while preparing attachments. Review this message and press Send again. Nothing was sent.');
      $<HTMLTextAreaElement>('input').value = ''; autosize(); app.queues.attachments.clear(attached.files);
      return { text, attached, turnModel, at: Date.now() };
    };
    if (!app.queues.busy() && !app.queues.submitting.has(key)) { app.state.status(''); return app.queues.dispatch(key, prepare); }
    if (app.queues.busy() && mode === 'stopsend') {
      await app.queues.stopMain();
      return app.queues.dispatch(key, prepare);
    }
    // Stop is winding down: no step is left to read a steer, so the text
    // waits as a follow-up and goes as the next turn once the run has ended.
    if (app.queues.stopping.has(key)) { app.queues.announce('Pouch is stopping: your message goes as the next turn.'); return app.queues.followUpMain(key, text, prepare); }
    // Steering carries text only; attachments go with a follow-up.
    if (app.queues.busy() && mode === 'steer' && !app.queues.attachments.files.length) return app.queues.steerMain(key, text);
    if (app.queues.busy() && mode === 'steer') app.queues.announce('Attachments go only with a new turn, so this message is a follow-up for after this turn.');
    return app.queues.followUpMain(key, text, prepare);
  };
  function blockedNow() { const sid = app.sessionList.sessions.current?.id; return sid != null && !!app.state.agent?.subagents?.blocked(sid).length; }
  // While the agent in view works, the round button is Stop.
  $('send').onclick = (e) => {
    if (app.sessionList.focus) {
      const c = app.subagents.focusedChild();
      if (c?.status === 'running') { e.preventDefault(); stopChild(c); }
      return;
    }
    if (app.queues.busy()) { e.preventDefault(); app.queues.stopMain(); }
  };
  // The subagent's view: steer joins its run at its next step boundary (S3);
  // follow-up waits for its turn to end, then messages it. Both are writes to
  // its in file; Stop writes its ctl. The harness side does the rest.
  async function toChild(text: string, mode: string) {
    const c = app.subagents.focusedChild(), f = app.sessionList.focus;
    if (!text || !c || !f) return;
    $<HTMLTextAreaElement>('input').value = ''; autosize();
    try { await app.namespaces.ctl(app.namespaces.agentFile(f.sid, refOf(app.subagents.kids.get(String(f.sid)) ?? [], c), 'in'), `${mode}\n${text}`); }
    catch (e) { app.queues.putBack(text); app.state.status(why(e), 'bad'); app.queues.updateSend(); }
  }
  async function stopChild(c: SubagentRow) {
    const sid = app.sessionList.focus?.sid ?? app.sessionList.sessions.current?.id;
    if (sid == null) return;
    await app.namespaces.ctl(app.namespaces.agentFile(sid, refOf(app.subagents.kids.get(String(sid)) ?? [], c), 'ctl'), 'stop').catch((e) => app.state.status(why(e), 'bad'));
  }
  // Keys (D25): Enter sends with the default mode, Alt/Option+Enter with the
  // other, Shift+Enter is a new line, Esc stops, Alt+Up takes the follow-up
  // message back. Ctrl+Alt is AltGr (a character), never Alt. On touch
  // screens Enter is a new line and the buttons send.
  const altOnly = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey;
  $('input').onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return; // an IME is composing: its Enter is not ours
    if (composer().onKeydown(e)) return;
    if (e.key === 'Escape' && $('sendmode-menu').hidden) {
      // In a subagent view Esc returns to the parent (the document handler);
      // its Stop is a button. In main, Esc stops the run.
      if (!app.sessionList.focus && app.queues.busy()) { e.preventDefault(); app.queues.stopMain(); }
      return;
    }
    if (e.key === 'ArrowUp' && altOnly(e)) {
      const key = app.queues.curKey();
      if (!app.sessionList.focus && app.queues.followUps.has(key)) { e.preventDefault(); app.queues.cancelFollowUp(key, 'edit'); }
      else if (app.sessionList.focus) {
        const id = app.sessionList.focus.id, q = app.queues.childFollowUps.get(id);
        if (q) { e.preventDefault(); app.queues.childFollowUps.delete(id); app.queues.putBack(q.text); renderTray(); }
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      nextMode = e.altKey ? 'other' : 'default';
      $<HTMLFormElement>('composer').requestSubmit();
    }
  };
  // The split stays for the whole running turn (critique 5); its send actions wait for a draft.
  $('input').addEventListener('input', () => { if ($<HTMLButtonElement>('sendmode-main').disabled === app.queues.hasDraft()) app.queues.updateSend(); });
  // The split button: its main part sends with the default mode; the chevron
  // opens a menu (arrow keys move, Esc closes and returns focus).
  function closeSendMenu(refocus?: boolean) {
    const menu = $('sendmode-menu');
    if (menu.hidden) return;
    menu.hidden = true; $('sendmode-more').ariaExpanded = 'false';
    if (refocus) $('sendmode-more').focus();
  }
  function openSendMenu() {
    const menu = $('sendmode-menu');
    menu.hidden = false; $('sendmode-more').ariaExpanded = 'true';
    // Focus what Enter would do (or, with no draft yet, the setting).
    const enter = menu.querySelector<HTMLElement>(`[data-mode="${app.state.settings.sendMode()}"]`);
    (enter?.ariaDisabled === 'true' ? menu.querySelector<HTMLElement>('[data-mode="settings"]') : enter ?? menu.querySelector('button'))?.focus();
  }
  $('sendmode-main').onclick = () => { nextMode = 'default'; $<HTMLFormElement>('composer').requestSubmit(); };
  $('sendmode-more').onclick = () => ($('sendmode-menu').hidden ? openSendMenu() : closeSendMenu(true));
  $('sendmode-menu').onclick = (e) => {
    const b = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-mode]') : null;
    if (!b || b.ariaDisabled === 'true') return;
    closeSendMenu();
    if (b.dataset.mode === 'settings') return app.state.layout.open('settings');
    nextMode = b.dataset.mode ?? 'default';
    $<HTMLFormElement>('composer').requestSubmit();
    $('input').focus();
  };
  $('sendmode-menu').onkeydown = (e) => {
    const items = [...$('sendmode-menu').querySelectorAll<HTMLElement>('button:not([hidden])')], i = items.findIndex((x) => x === document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items.at(e.key === 'Home' ? 0 : -1)?.focus(); }
    else if (e.key === 'Tab') closeSendMenu();
  };
  dismissible({ isOpen: () => !$('sendmode-menu').hidden, inside: () => [$('sendmode')], close: (how) => closeSendMenu(how === 'esc') });
  document.addEventListener('pouch-sendmode', () => app.queues.updateSend());
  function autosize() { const i = $<HTMLTextAreaElement>('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight + 2, innerHeight * 0.4) + 'px'; }
  $('input').addEventListener('input', autosize);
  $('composer-usage').onclick = () => app.state.layout.toggle('usage');
  // Follow-ups and paused messages live in this page only: ask before a reload or close drops them.
  addEventListener('beforeunload', (e) => { if (app.queues.followUps.size || app.queues.childFollowUps.size || app.queues.steers.size) e.preventDefault(); });

  return {
    autosize,
    closeSendMenu,
    quotaError,
    send,
    sendNow,
  };
}
