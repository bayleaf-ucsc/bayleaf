// Composer: send button and modes, steering and follow-up queues, the context meter.

import { createAttachments, type Attachments } from '../attachments.ts';
import { compactionFor } from '../agent.ts';
import { autoCompactAt, contextFor, describe as describeContext } from '../context.ts';
import { $ } from '../dom.ts';
import { arm, armed, flipFrom, fold, play, snapshot } from '../motion.ts';
import { labelComposer } from '../usage.ts';
import { MAIN, refOf } from '../graph.ts';
import { why } from '../ns/control.ts';
import { BUDGET, isLocal } from '../local/provider.ts';
import { isLocalhost } from '../localhost.ts';
import type { ConversationId, SubmissionId } from '@earendil-works/pi-durable';
import type { App } from './app.ts';
import type { SessionId } from '../agent-types.ts';
import type { ContextMeter, ContextSize } from '../context.ts';
import type { Snapshot } from '../motion.ts';
import type { TrayRow } from '../composer.ts';
import type { SendMode } from '../settings.ts';

export type Attached = Awaited<ReturnType<Attachments['prepare']>>;
// A Follow-up (LANGUAGE.md), or after Stop a paused message.
export interface FollowUp { text: string; attached: Attached; turnModel: string; at: number; paused?: boolean; tries?: number }
// A Steer not yet placed; child: a subagent's (its registry id).
export interface SteerItem { id: SubmissionId; text: string; at: number; detach?: string; child?: ConversationId; name?: string; withdrawing?: boolean }
export interface ChildFollowUp { sid: SessionId; text: string; name: string; at: number; paused?: boolean }
// Resolves once a steer left the inbox: late (it started the next turn), or null (withdrawn).
export type Placement = Promise<{ late: boolean } | null>;
export interface HeldCard { id: ConversationId; card: Snapshot | null }
interface Arrival { text: string; first: DOMRect; kf?: Keyframe[] }
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ENDED: Record<string, string> = { stopped: 'was stopped', failed: 'failed', interrupted: 'was interrupted' };

export interface QueuesRegion {
  // To the polite live region; to the status line too when seen.
  announce(text: string, seen?: boolean): void;
  attachments: Attachments;
  // The agent in view is in a model run.
  busy(): boolean;
  cancelFollowUp(key: string, how?: string): void;
  childFollowUps: Map<ConversationId, ChildFollowUp>;
  contextNow(): { ctx: ContextSize; d: ContextMeter } | null;
  countRequest(): void;
  // The current session's key, 'new' before it exists.
  curKey(): string;
  deleting: Set<string>;
  dispatch(key: string, prepare: () => FollowUp | null | Promise<FollowUp | null>): Promise<void>;
  foldIntoTray(held: HeldCard[]): void;
  followUpMain(key: string, text: string, prepare: () => Promise<FollowUp>): Promise<void>;
  followUps: Map<string, FollowUp>;
  hasDraft(): boolean;
  heldCards(sid: SessionId): HeldCard[];
  holdFollowUp(key: string, prepare: () => Promise<FollowUp>): Promise<void>;
  noFiles(): Attached;
  otherMode(m: SendMode): SendMode;
  PLACEHOLDER: string;
  playArrivals(log: HTMLElement): void;
  readonly promoteNext: boolean;
  pump(): void;
  putBack(text: string): void;
  // Per session key: requests since its user's last message.
  spend: Map<string, number>;
  steerMain(key: string, text: string, promoted?: boolean): Promise<void>;
  steers: Map<string, SteerItem[]>;
  stopMain(sid?: SessionId | null): Promise<void>;
  stopping: Set<string>;
  submitting: Set<string>;
  track(key: string, sid: SessionId, s: SteerItem, placed: Placement, promoted?: boolean): void;
  trayRowMotion(li: HTMLLIElement, r: TrayRow): void;
  turnSpend(): number | null;
  updateSend(): void;
  waitingOn(sid?: SessionId | null): string[];
  withdrawSteers(key: string, sid: SessionId, which?: (s: SteerItem) => boolean): Promise<string[]>;
}

export function createQueuesRegion(app: App): QueuesRegion {
  // ── Composer (composer.ts) ──────────────────────────────────────────
  const busy = () => !!app.state.view?.busy;
  const PLACEHOLDER = 'Ask Pouch. @ for files, $ for skills, / for commands';
  const attachments = createAttachments({ vfs: app.state.vfs, composer: $('composer'), input: $('input'), picker: $<HTMLInputElement>('attachment-picker'), button: $('attach-file'), chips: $('attachment-chips'), warning: $('attachment-warning'), status: app.state.status });
  const submitting = new Set<string>(); // per session: a send from Enter until its model turn ends (after-turn chores run on)
  const deleting = new Set<string>(); // sessions a first-message revert is deleting: sends to them wait for it to settle
  // While Pouch works (JOURNEYS D25), a message is a Steer or a Follow-up
  // (LANGUAGE.md). A steer joins the running turn at its next step boundary: a
  // pi-durable steer, tracked here so Stop can take it back. A follow-up is held
  // here (one slot per session; queuing is the strategy, not the name) and starts
  // the next turn once the model's turn ends, before any wake from an agent
  // (subagents.ts userFirst). Input is never dropped: it is steered, held as a
  // follow-up, paused after Stop, or refused with a reason.
  const followUps = new Map<string, FollowUp>(); // by session key
  const steers = new Map<string, SteerItem[]>(); // by session key
  const childFollowUps = new Map<ConversationId, ChildFollowUp>();
  let holdingFollowUp = false;
  const curKey = () => String(app.sessionList.sessions.current?.id ?? 'new');
  const noFiles = (): Attached => ({ files: [], images: [] });
  const otherMode = (m: SendMode): SendMode => (m === 'steer' ? 'followup' : 'steer');
  const MODE_LABEL: Record<SendMode, string> = { steer: 'Steer', followup: 'Follow-up' };
  const MODE_VERB: Record<SendMode, string> = { steer: 'steer', followup: 'send a follow-up' };
  // Changes to pending input go to a polite live region; shown too when `seen`.
  let liveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  function announce(text: string, seen = true) {
    const r = $('send-live');
    r.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { r.textContent = text; }, 40);
    if (seen) app.state.status(text);
  }
  // The subagents main's running turn is blocked on (a foreground spawn, a join), by name.
  function waitingOn(sid: SessionId | null | undefined = app.sessionList.sessions.current?.id): string[] {
    if (sid == null || !app.state.agent?.subagents) return [];
    const l = app.subagents.kids.get(String(sid)) ?? [];
    return [...new Set(app.state.agent.subagents.blocked(sid).flatMap((h) => h.ids))].map((ref) => l.find((c) => refOf(l, c) === ref)?.name ?? ref);
  }
  const hasDraft = () => !!$<HTMLTextAreaElement>('input').value.trim() || (!app.sessionList.focus && attachments.files.length > 0);
  // The accessible name starts with the visible label (WCAG 2.5.3), so "Stop"
  // and "Stop all" name the same action here, in the tray and on a phone.
  function setSend(kind: 'stop' | 'followup' | 'send', title: string, label = { stop: 'Stop', followup: 'Follow-up', send: 'Send' }[kind], name: string | null = null) {
    $('send-label').textContent = label;
    $('send').title = title;
    $('send').ariaLabel = kind === 'stop' ? name ?? label : null;
    if (kind === 'stop' && !app.sessionList.focus) $('send').setAttribute('aria-keyshortcuts', 'Escape'); else $('send').removeAttribute('aria-keyshortcuts');
    $('send').classList.toggle('stop', kind === 'stop');
    $('send').classList.toggle('followup', kind === 'followup');
    $('send').querySelector('use')?.setAttribute('href', kind === 'stop' ? '#i-stop' : '#i-send');
  }
  // The split button (Steer or Follow-up, and a menu) beside Stop: shown while the
  // agent in view works and the draft is not empty.
  function showSplit(on: boolean, who: string | undefined) {
    const box = $('sendmode'), m = app.state.settings.sendMode(), other = otherMode(m);
    box.hidden = !on;
    if (!on) return app.send.closeSendMenu();
    const blocked = !app.sessionList.focus ? waitingOn() : [];
    $('sendmode-label').textContent = MODE_LABEL[m];
    const what = m === 'steer' ? `Steer: send into ${who}'s current turn, read after its current step (Enter)` : `Follow-up: send after ${who}'s turn ends (Enter)`;
    const label = `${what}. Alt+Enter to ${MODE_VERB[other]} instead.` + (m === 'steer' && blocked.length ? ` Steering will detach ${blocked.join(', ')}.` : '');
    $('sendmode-main').ariaLabel = label;
    $('sendmode-main').title = label;
    // One-shot sends are plain menu items (critique 4): the key that does the
    // same is said in text; the setting is its own item below a separator.
    const draft = hasDraft();
    $<HTMLButtonElement>('sendmode-main').disabled = !draft;
    for (const b of $('sendmode-menu').querySelectorAll<HTMLElement>('[data-mode]')) {
      const keys = b.dataset.mode === m ? 'Enter' : b.dataset.mode === other ? 'Alt+Enter' : null;
      const k = b.querySelector('.sm-key');
      if (k) k.textContent = keys ? ` (${keys})` : '';
      b.title = (b.firstElementChild?.textContent ?? '') + (keys ? ` (${keys})` : '');
      if (b.dataset.mode !== 'settings') b.ariaDisabled = String(!draft);
    }
    $('sendmode-enter').textContent = `Enter now ${m === 'steer' ? 'steers' : 'sends a follow-up'}.`;
    const note = $('sendmode-detach');
    note.hidden = !blocked.length;
    note.textContent = blocked.length ? `Steering will detach ${blocked.join(', ')}` : '';
    const stopSend = $('sendmode-menu').querySelector<HTMLElement>('[data-mode="stopsend"]');
    if (stopSend) stopSend.hidden = !!app.sessionList.focus;
  }
  // The context meter (src/context.ts): about how many tokens main's next request
  // would carry, against the window of the model in the picker (where it goes).
  // From the stored transcript only: computing it sends nothing. Hidden in a
  // subagent's view and before the session holds anything.
  function contextNow() {
    // None in a subagent's view.
    const id = $<HTMLSelectElement>('model').value, c = app.sessionList.focus ? null : contextFor(app.state.view?.context, isLocal(id));
    if (!c?.tokens) return null;
    const sealed = app.state.models.find((m) => m.id === id), host = isLocalhost(id) ? app.providers.lh?.models?.find((m) => 'localhost:' + m.id === id) : null;
    const known = isLocal(id) ? null : host ? host.contextWindow ?? null : sealed?.windowReported ? sealed.contextWindow : null;
    // Where pi-durable compacts uses the window pi-ai was given, defaults included (src/agent.ts, src/localhost.ts).
    const used = isLocal(id) ? null : host ? host.contextWindow ?? 32_768 : sealed?.contextWindow ?? null;
    const d = describeContext(c, { window: known, budget: isLocal(id) ? BUDGET : null, auto: used && autoCompactAt(used, compactionFor(used)) });
    return d && { ctx: c, d };
  }
  function renderCtx() {
    const b = $('composer-ctx');
    if (!b) return;
    const now = contextNow();
    b.hidden = !now;
    if (!now) { if ('ctx' in $('composer-usage').dataset) { delete $('composer-usage').dataset.ctx; labelComposer(); } return; }
    const { d, ctx } = now;
    b.dataset.level = d.level;
    b.style.setProperty('--fill', d.fill == null ? '0%' : `${Math.round(d.fill * 100)}%`);
    $('composer-ctx-num').textContent = d.count;
    $('composer-ctx-of').textContent = d.of ? ` / ${d.of}` : '';
    $('composer-ctx-trim').hidden = !ctx.trimmed;
    if ($('composer-usage').dataset.ctx !== d.label) { $('composer-usage').dataset.ctx = d.label; labelComposer(); }
  }
  function updateSend() {
    renderCtx();
    const input = $<HTMLTextAreaElement>('input');
    if (app.sessionList.focus) {
      // The subagent's view: steer or follow up while it works; once it is done
      // the composer says so and sends nothing (it never starts a new turn).
      const c = app.subagents.focusedChild(), live = c?.status === 'running';
      input.dataset.child = String(app.sessionList.focus.id);
      input.disabled = !live;
      const ended = ENDED[c?.status ?? ''] ?? 'has finished';
      input.placeholder = live ? `Steer ${c.name}: it reads this after its current step` : `${c?.name ?? 'This subagent'} ${ended}. Go back to ${app.subagents.parentName(app.sessionList.sessions.current)} to continue.`;
      if (live) setSend('stop', `Stop ${c.name}`, 'Stop', `Stop ${c.name}`);
      else setSend('send', `The subagent ${ended}`);
      $<HTMLButtonElement>('send').disabled = !live;
      showSplit(live, c?.name);
      return;
    }
    if (input.dataset.child) {
      delete input.dataset.child;
      input.disabled = false;
      input.placeholder = app.connection.offline && !app.providers.localPicked() ? 'Offline: keep typing; Send comes back with the network' : PLACEHOLDER;
    }
    const b = busy(), finishing = !b && submitting.has(curKey());
    // Stop here also stops this session's subagents: then it says Stop all, as the tray does.
    const others = b && (app.subagents.kids.get(String(app.sessionList.sessions.current?.id)) ?? []).some((c) => c.status === 'running');
    if (b) setSend('stop', others ? 'Stop Pouch and its subagents (Esc)' : 'Stop Pouch (Esc)', others ? 'Stop all' : 'Stop');
    else if (finishing) setSend('followup', 'Pouch is starting the turn. Send this as a follow-up; it goes when Pouch is ready.');
    else setSend('send', 'Send');
    $<HTMLButtonElement>('send').disabled = !b && !app.providers.canSend();
    if (!b && app.connection.offline && !app.providers.localPicked()) $('send').title = app.connection.OFFLINE;
    $('composer').classList.toggle('offline', app.connection.offline);
    showSplit(b, 'Pouch');
    if (followUps.size) queueMicrotask(pump);
  }
  // Send the current session's follow-up once the model's turn is over.
  function pump() {
    const key = curKey(), q = followUps.get(key);
    if (!q || q.paused || busy() || submitting.has(key) || deleting.has(key) || holdingFollowUp || !(app.providers.offSealed(q.turnModel) ? app.state.agent : app.state.agent && app.state.verified && !app.connection.offline)) return;
    followUps.delete(key);
    announce('Follow-up sent: it starts the next turn.', false);
    dispatch(key, () => q);
  }
  // One send with its bookkeeping. prepare() -> { text, attached, turnModel }.
  async function dispatch(key: string, prepare: () => FollowUp | null | Promise<FollowUp | null>) {
    spend.delete('new'); spend.set(String(key), 0); // this session's "requests this turn" starts over
    app.namespaces.changes.begin(key); // and so does /session/<sid>/changes
    submitting.add(key); updateSend(); app.state.composer?.renderTray();
    let q: FollowUp | null = null, k = key;
    const runEnded = () => { submitting.delete(k); updateSend(); app.state.composer?.renderTray(); };
    // A first message's session is made inside send(): from then on this send
    // belongs to it, so "new" is free for the next New (New, then Enter).
    const adopted = (id: SessionId) => { submitting.delete(k); k = String(id); submitting.add(k); };
    try { q = await prepare(); if (q) await app.send.send(q.text, q.attached, q.turnModel, runEnded, adopted); }
    catch (e) {
      // The watched view can say idle a moment before pi-durable's run ends:
      // then the follow-up waits and goes on the next try.
      if (q && /still running/.test(messageOf(e)) && !followUps.has(key) && (q.tries = (q.tries ?? 0) + 1) <= 25) { followUps.set(key, q); setTimeout(pump, 400); }
      else {
        app.state.status(messageOf(e), 'bad');
        if (q && !$<HTMLTextAreaElement>('input').value.trim()) { $<HTMLTextAreaElement>('input').value = q.text; app.send.autosize(); } // not sent: the text comes back
      }
    }
    finally { runEnded(); }
  }
  // Back into the composer, before what is typed there (Edit, Cancel, Alt+Up).
  function putBack(text: string) {
    const now = $<HTMLTextAreaElement>('input').value.trim();
    $<HTMLTextAreaElement>('input').value = now ? `${text}\n\n${now}` : text;
    app.send.autosize(); updateSend();
    $('input').focus();
  }
  function cancelFollowUp(key: string, how = 'cancelled') {
    const q = followUps.get(key);
    if (!q) return;
    followUps.delete(key);
    putBack(q.text);
    announce(how === 'edit' ? 'Follow-up back in the box for editing.' : q.attached.files.length ? 'Follow-up cancelled and put back; its attachments are still in your files.' : 'Follow-up cancelled and put back in the box.');
    app.state.composer?.renderTray(); updateSend();
  }
  // Hold the draft as the follow-up, or add it to the one follow-up (said so).
  async function holdFollowUp(key: string, prepare: () => Promise<FollowUp>) {
    if (key === 'new') return app.state.status('Wait a moment: the session is still starting. Your message stays here.', 'bad');
    if (holdingFollowUp) return app.state.status('Still holding the last follow-up. This one stays here.', 'bad');
    holdingFollowUp = true;
    try {
      const q = await prepare(), had = followUps.get(key);
      if (had) {
        followUps.set(key, { ...had, text: `${had.text}\n\n${q.text}`, attached: { files: [...had.attached.files, ...q.attached.files], images: [...had.attached.images, ...q.attached.images] } });
        announce(had.paused ? 'Added to the paused message.' : 'Added to the follow-up: both go together after this turn.');
      } else {
        followUps.set(key, q);
        announce('Follow-up: it goes after this turn.');
      }
    } catch (err) { app.state.status(messageOf(err), 'bad'); }
    finally { holdingFollowUp = false; app.state.composer?.renderTray(); updateSend(); }
  }
  // Steer main (the composer, Steer now): written to main's in file; the
  // harness side (steerSession) detaches a subagent main waits on, tracks it in
  // the tray and announces it, whoever wrote.
  let promoteNext = false; // Steer now: the tray row morphs in place
  async function steerMain(key: string, text: string, promoted = false) {
    $<HTMLTextAreaElement>('input').value = ''; app.send.autosize();
    promoteNext = promoted;
    try { await app.namespaces.ctl(app.namespaces.agentFile(key, MAIN, 'in'), 'steer\n' + text); }
    catch (e) { putBack(text); app.state.status(why(e), 'bad'); }
    finally { promoteNext = false; }
  }
  // The composer's follow-up for main, text only, is a file write too; one
  // with attachments is held directly, because attachments are page-held
  // files and blobs a write to in cannot carry (README "Control plane").
  async function followUpMain(key: string, text: string, prepare: () => Promise<FollowUp>) {
    if (key === 'new' || attachments.files.length) return holdFollowUp(key, prepare);
    $<HTMLTextAreaElement>('input').value = ''; app.send.autosize();
    try { await app.namespaces.ctl(app.namespaces.agentFile(key, MAIN, 'in'), 'followup\n' + text); }
    catch (e) { putBack(text); app.state.status(why(e), 'bad'); }
  }
  // Follow a steer until it is placed: delivered into the turn, or (it raced
  // the turn's end) the start of the next turn, which runs like any other.
  // Steer now keeps the row in place; only its label and edge change (morph).
  function track(key: string, sid: SessionId, s: SteerItem, placed: Placement, promoted = false) {
    steers.set(key, [...(steers.get(key) ?? []), s]);
    if (promoted) arm('morph:steer:' + s.id);
    app.state.composer?.renderTray();
    placed.then(async (p) => {
      const list = steers.get(key) ?? [], i = list.indexOf(s);
      if (i < 0) return; // taken back (Cancel, Stop)
      // Delivered: the tray item travels into its place in the transcript (FLIP).
      const row = $('tray-list').querySelector(`[data-key="steer:${CSS.escape(String(s.id))}"]`);
      if (p && !p.late && row && !$('tray').classList.contains('collapsed')) { arrivals.set(s.id, { text: s.text, first: row.getBoundingClientRect() }); arm('arrive:' + s.id); arm('glow:' + s.id); }
      list.splice(i, 1);
      if (!list.length) steers.delete(key);
      app.state.composer?.renderTray(); updateSend();
      if (/^Steering/.test($('status').textContent)) app.state.status(''); // critique 8: it was read
      if (!p && !s.withdrawing) return unplaced(key, s);
      if (!p) return;
      const who = s.child ? s.name : 'Pouch';
      if (!p.late) { app.transcript.scheduleRender(); return announce(`Steering delivered to ${who}.`, false); }
      announce(`${who} had finished its turn, so your steering message was sent as the next turn.`);
      const agent = app.state.agent;
      if (!s.child && agent) app.subagents.drive(sid, () => agent.waitFor(sid, s.id));
    }, () => {});
  }
  // A steer that raced the run's end and was never placed (nor withdrawn):
  // it becomes the follow-up and goes as the next turn, never lost.
  function unplaced(key: string, s: SteerItem) {
    if (s.child) { putBack(s.text); return app.state.status(`${s.name} ended before it read your message; it is back in the box.`, 'bad'); }
    const q = followUps.get(key);
    followUps.set(key, { attached: noFiles(), turnModel: $<HTMLSelectElement>('model').value, at: Date.now(), ...q, text: [q?.text, s.text].filter(Boolean).join('\n\n'), paused: false });
    announce('Pouch had just finished, so your message is a follow-up and goes as the next turn.');
    app.state.composer?.renderTray(); updateSend(); queueMicrotask(pump);
  }
  // Steering messages travelling from the tray into the transcript.
  const arrivals = new Map<SubmissionId, Arrival>();
  const norm = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim();
  function playArrivals(log: HTMLElement) {
    for (const [id, a] of arrivals) {
      if (!armed('arrive:' + id) && !armed('glow:' + id)) { arrivals.delete(id); continue; }
      const want = norm(a.text).slice(0, 80);
      const m = [...log.querySelectorAll<HTMLElement>('.msg')].findLast((n) => n.querySelector('.sa-who')?.textContent === app.state.STEER_LABEL && norm(n.querySelector('.body')?.textContent).startsWith(want));
      if (!m) continue;
      m.classList.add('arrived');
      m.dataset.arrival = String(id);
      a.kf ??= flipFrom(a.first)(m); // measured once, on the first node it lands in
      play(m, 'arrive:' + id, a.kf, 200);
      // No glow box: it drew a second border around the bubble mid-move (critique 9).
    }
  }
  // Detach (G10, G12): the foreground card folds into its tray row, keeping its hue.
  function heldCards(sid: SessionId): HeldCard[] {
    const refs = new Set(app.state.agent?.subagents?.blocked(sid).flatMap((h) => h.ids) ?? []);
    const l = app.subagents.kids.get(String(sid)) ?? [];
    // Its card, or while a foreground spawn is still running, its spawn pill.
    const pill = (c: { name: string }) => [...$('log').querySelectorAll('details.tool')].findLast((d) => new RegExp(`spawn (one-shot )?${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(d.querySelector('.what')?.textContent ?? ''));
    return l.filter((c) => refs.has(refOf(l, c))).map((c) => ({ id: c.id, card: snapshot($('log').querySelector(`.subagent[data-child="${CSS.escape(String(c.id))}"]`) ?? pill(c)) }));
  }
  function foldIntoTray(held: HeldCard[]) {
    app.state.composer?.renderTray();
    for (const h of held) {
      arm('fold:sa:' + h.id);
      const row = $('tray-list').querySelector(`[data-key="sa:${CSS.escape(String(h.id))}"]`);
      if (h.card && row) fold(h.card, row);
    }
    app.state.composer?.renderTray();
  }
  // What a tray row carries over a rebuild: its fold or morph highlight.
  function trayRowMotion(li: HTMLLIElement, r: TrayRow) {
    play(li, 'fold:' + r.key, [{ opacity: 0.4, transform: 'scale(1.02)' }, { opacity: 1, transform: 'none' }], 900);
    if (r.kind === 'steer') play(li, 'morph:' + r.key, [{ opacity: 0.6 }, { opacity: 1 }], 600, { mark: 'morphed' });
  }
  // Take back steers that are not placed yet (Cancel, Stop); their texts.
  async function withdrawSteers(key: string, sid: SessionId, which: (s: SteerItem) => boolean = () => true) {
    const list = steers.get(key) ?? [], back: string[] = [];
    const mine = list.filter(which);
    for (const s of mine) s.withdrawing = true; // its placement may resolve null meanwhile: not lost
    for (const s of mine) {
      const r = app.state.agent ? await app.state.agent.withdraw(sid, s.id).catch(() => 'settled') : 'settled';
      list.splice(list.indexOf(s), 1);
      if (r === 'aborted') back.push(s.text);
    }
    if (!list.length) steers.delete(key);
    return back;
  }
  // Stop (button, Esc, Stop and send): never sends anything by itself. Steers
  // not yet read and the follow-up become one paused item: Send or Cancel.
  // Sealed requests sent since the user's last message (all sessions of the page:
  // one at a time is the norm), for the tray header.
  // Per session: sid -> requests since its user's last message. A request is
  // counted for the session whose run is active (with its subagents); when
  // several run at once, for the one in view if it is among them.
  const spend = new Map<string, number>();
  const activeSids = () => {
    const out = new Set([...app.sessionList.sessions.running].map(String));
    for (const [sid, l] of app.subagents.kids) if (l.some((c) => c.status === 'running')) out.add(String(sid));
    return [...out];
  };
  function countRequest() {
    const act = activeSids(), cur = app.sessionList.sessions.current?.id != null ? String(app.sessionList.sessions.current.id) : 'new';
    const sid = act.includes(cur) || !act.length ? cur : act[0];
    spend.set(sid, (spend.get(sid) ?? 0) + 1);
    app.state.ledger.add(sid, 'turn').then(app.state.meter);
    app.state.composer?.renderTray();
  }
  // A first message is dispatched as 'new' before its session exists.
  const turnSpend = () => spend.get(String(app.sessionList.sessions.current?.id ?? 'new')) ?? spend.get('new') ?? null;
  // Keys of sessions whose Stop is still winding down (the abort not settled).
  const stopping = new Set<string>();
  // Stop main (the button, Esc, Stop and send): Stop in a session stops its
  // subagents too, so the Interface writes "stop all" to main's ctl.
  async function stopMain(sid: SessionId | null | undefined = app.sessionList.sessions.current?.id) {
    if (sid == null) return;
    await app.namespaces.ctl(app.namespaces.agentFile(sid, MAIN, 'ctl'), 'stop all').catch((e) => app.state.status(why(e), 'bad'));
  }

  return {
    announce,
    attachments,
    busy,
    cancelFollowUp,
    childFollowUps,
    contextNow,
    countRequest,
    curKey,
    deleting,
    dispatch,
    foldIntoTray,
    followUpMain,
    followUps,
    hasDraft,
    heldCards,
    holdFollowUp,
    noFiles,
    otherMode,
    PLACEHOLDER,
    playArrivals,
    get promoteNext() { return promoteNext; },
    pump,
    putBack,
    spend,
    steerMain,
    steers,
    stopMain,
    stopping,
    submitting,
    track,
    trayRowMotion,
    turnSpend,
    updateSend,
    waitingOn,
    withdrawSteers,
  };
}
