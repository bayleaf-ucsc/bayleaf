// Background subagents (JOURNEYS D15, D16): the main agent hands a
// self-contained task to a child conversation and keeps talking to the user.
//
// Shape, and why:
// - A child is an ownerless pi-durable conversation in the session's own
//   database, so deleting the session erases it, and the parent is never busy
//   because of it (it is not owned by any parent task).
// - The reporter lives in the page, not in a durable task: in a browser the
//   page is the only process, so a page-level watcher has the same lifetime as
//   a task would. On reopen pi-durable resumes the child's run (harness.resume)
//   and resume() here re-attaches the watcher through harness.submission(id).
// - A report is posted to the parent with requestId `sa-report:<submission>`,
//   so a reload that finds the same settled submission cannot post it twice.
//   Finished and failed children report as a follow-up input (the parent gets
//   a turn to use the answer); a child the user stopped, or one whose run was
//   lost, is a model-visible write (no request spent; seen at the next turn).
// - Which children a session has, and their state, is a small registry kept in
//   Pouch settings (reg.get/set), deleted with the session.
// - Agent graphs (G1-G12): the sessions of one scope (main, s1, and its
//   children s2, s3, ...) message each other by id. Spawning stays flat (only
//   main spawns); graphs come from messages. Every message is one entry in the
//   recipient's conversation, tagged with its sender: it joins a running
//   session's next step (a steer), wakes a finished child, or starts a turn of
//   an idle main, the way reports do. Caps, arrivals and blocking calls are
//   src/graph.js. Children get the trimmed `agents` tool (list, message, join).
// - join (not a mailbox wait): block until targets go quiet and return each
//   one's last message, fresh or cached; every settle bumps the child's
//   result number `seq`, so a join after a message waits for a newer result.
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { createScope, MAIN, JOIN_DEFAULT_S, JOIN_MAX_S, MAX_SCOPE_MESSAGES, MAX_PAIR_MESSAGES } from './graph.js';
export { MAIN, MAX_SCOPE_MESSAGES, MAX_PAIR_MESSAGES };

export const REPORT_KIND = 'pouch.subagent';
// A message the user typed to a child (its view's composer, or its card's
// Message): the model sees `content`, the transcripts show data.text marked as
// the user's, and the report quotes it so the parent knows it was steered.
export const STEER_KIND = 'pouch.steer';
const fromUser = (text) => `[Message from the user, who is watching your work; not from the main agent] ${text}`;
// A message from another session of the scope: the model sees the tag and
// the text; data { from, name, to, text } lets every view label the sender.
export const MESSAGE_KIND = 'pouch.msg';
// A file-watch event (src/ns/watch.js): data { watches: [{ id, note }], lines, mode }.
export { WATCH_KIND } from './ns/watch.js';
export const tagOf = (name, ref) => `[from ${name} (${ref})]`;
// Five is the panel (a chair and four judges); one spare for a helper.
export const MAX_RUNNING = 6;
export const SUBAGENT_DIR = '/work/.subagents';
const ctx0 = undefined;

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const textOf = (content) => typeof content === 'string' ? content
  : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');

// The harness gloss on messaging, shared by main's prompt and every child's.
export const GRAPH_GLOSS = `Sessions in this scope message each other by id: main is ${MAIN}, subagents are s2, s3 and so on. Common shapes: many-to-one (several send findings to one collector), pipeline (each passes its result to the next), cross-check (two answer each other). Messages arrive between your steps, tagged [from <name> (<id>)]; do not poll. join blocks until subagents go quiet and returns their last messages; it never wakes one, so to get new work, message it and then join it. When your part is done, send your result to whoever asked, then stop.`;

// Where a subagent keeps notes: /work/.subagents when it may write /work,
// else its private /tmp (a spawn that narrowed /work to read-only files).
export function scratchOf(ns) {
  if (!ns?.length) return SUBAGENT_DIR;
  const rw = ns.filter((s) => !/:ro$/.test(s)).map((s) => s.replace(/:rw$/, '').replace(/\/+$/, ''));
  return rw.some((p) => (SUBAGENT_DIR + '/').startsWith(p + '/')) ? SUBAGENT_DIR : '/tmp';
}

function instructions(name, ref, task, ns) {
  const dir = scratchOf(ns);
  const where = dir === '/tmp' ? `/tmp (your private scratch, lost on reload; /work is read-only for you, so never write there), for example /tmp/${name}.md` : `${dir}/, for example ${dir}/${name}.md`;
  return `You are a subagent named "${name}" (id ${ref}), started by the main BayLeaf Pouch agent, "main" (id ${MAIN}), to work on one task while it keeps talking to the user. Work only on this task:
<task>
${task}
</task>
You cannot start subagents yourself (ignore any guidance about them above). ${GRAPH_GLOSS} Use the agents tool for that (actions list, message, join). Nobody else will answer questions: make reasonable assumptions and say what they were. Write any long output (notes, lists, drafts) to a file under ${where}. If your task says to send your result to a session, send it there with the agents tool and then end with one short line; otherwise finish with a concise report (at most about 200 words) that states what you found or did and lists the paths of files you wrote: main reads only that report. To stop, simply finish your reply.`;
}

// A one-shot subagent: one model request, no tools, no Pouch prompt. It sees
// the task and the files main attached; its reply is its report (or goes to
// `to`, forwarded by the harness, since it cannot message anyone itself).
function oneshotInstructions(name, ref, toLabel) {
  return `You are "${name}" (id ${ref}), a one-shot helper started by the BayLeaf Pouch agent. You have no tools and exactly one reply: answer the task below from the text you are given, concisely and concretely, quoting the text where it helps. Nobody will answer questions: make reasonable assumptions and say what they were. Your reply goes to ${toLabel}.`;
}
export const MAX_FILE_CHARS = 48_000, MAX_FILES_CHARS = 120_000;

// deps: { ctx, laneOf(sid), lane(name), conv(sid), modelRef(id), normalizeView(view, entries),
//         reg: { get(sid), set(sid, list) }, onChange(sid, list), onReport(sid, submission, child),
//         onSettle(sid, child), lowAllowance() -> string|null, sidOf(convId) }
export function createSubagents(deps) {
  const ctx = deps.ctx ?? ctx0;
  const tracking = new Set();
  let closing = false;
  const owners = new Map(); // child conversation id -> { sid, child id, ns? }
  const locks = new Map();  // sid -> promise chain for registry updates
  const scopes = new Map(); // sid -> createScope(): caps, arrivals, blocking calls
  const scope = (sid) => { const k = String(sid); if (!scopes.has(k)) scopes.set(k, createScope()); return scopes.get(k); };
  const results = new Map(); // "childId:seq" -> its last message at that result (join)
  const reserved = new Map(); // sid -> { n: last short id number given, names }
  const last = new Map();   // sid -> registry rows as last written (synchronous reads for waits)

  // Serialize read-modify-write of one session's registry.
  function update(sid, fn) {
    const prev = locks.get(String(sid)) ?? Promise.resolve();
    const next = prev.then(async () => {
      const list = (await deps.reg.get(String(sid))) ?? [];
      const out = (await fn(list)) ?? list;
      await deps.reg.set(String(sid), out.length ? out : undefined);
      for (const c of out) owners.set(c.id, { sid, id: c.id, ns: c.ns });
      last.set(String(sid), out);
      deps.onChange?.(sid, out);
      scope(sid).checkAll(); // a child that went quiet may release joins
      return out;
    });
    locks.set(String(sid), next.catch(() => {}));
    return next;
  }
  const list = async (sid) => (await deps.reg.get(String(sid))) ?? [];
  const running = (l) => l.filter((c) => c.status === 'running');
  // A submission the page can await without a pi-durable context (drive()).
  const waitable = (sub) => ({ id: sub.id, wait: () => sub.wait(ctx) });
  // Short ids: s2, s3, ... in spawn order (rows made before graphs have none).
  const refOf = (l, c) => c.ref ?? `s${l.indexOf(c) + 2}`;
  const find = (l, ref) => l.find((c) => c.id === ref || c.name === ref || refOf(l, c) === ref || c.name === slug(ref));
  const label = (l, ref) => { if (ref === MAIN) return `main (${MAIN})`; const c = l.find((x) => refOf(l, x) === ref); return c ? `${c.name} (${ref})` : ref; };
  // Whether a session of the scope is in a model run right now.
  async function busy(conv) {
    const state = await conv.viewState(ctx), b = !!state.value.docs['pi.live']?.run;
    state.dispose();
    return b;
  }

  // The user's queued message starts main's next turn before any wake that
  // comes from an agent (a report, a message to an idle main): such a wake
  // waits while main works or the page holds a queued message for it, so it
  // follows the user's turn. deps.userQueued(sid) says whether one is held.
  // idleOnly: wait only for the queued message (a busy main takes it as a steer).
  async function userFirst(sid, parent, idleOnly = false) {
    if (!deps.userQueued) return;
    while (!closing && (deps.userQueued(sid) || (!idleOnly && await busy(parent)))) await new Promise((r) => setTimeout(r, 150));
  }
  async function harnessOf(sid) { return (await deps.lane(deps.laneOf(sid))).harness; }
  async function childConv(sid, id) {
    const c = await (await harnessOf(sid)).conversation(id, ctx);
    if (!c) throw new Error('That subagent no longer exists.');
    return c;
  }

  // The child's final state: its last answer, how many model requests it
  // made, and what the user told it (placed steering messages, in order).
  async function summary(sid, id) {
    const c = await childConv(sid, id);
    let answer = '', requests = 0, cursor;
    const steers = [];
    do {
      const page = await c.entries(cursor ? {} : { order: 'ascending' }, 500, cursor, ctx);
      for (const e of page.items) {
        if (e.kind === STEER_KIND) steers.push(String(e.data?.text ?? ''));
        if (e.kind !== 'pi.assistant') continue;
        requests++;
        const t = textOf(e.model?.[0]?.content);
        if (t.trim()) answer = t;
      }
      cursor = page.next;
    } while (cursor);
    // Its tokens (pi.usage), rolled into the parent's row of the Usage panel.
    let usage;
    try {
      const st = await c.viewState(ctx);
      usage = { input: 0, output: 0, cost: 0 };
      for (const m of Object.values(st.value.docs['pi.usage']?.models ?? {})) { usage.input += m.input ?? 0; usage.output += m.output ?? 0; usage.cost += m.cost?.total ?? 0; }
      st.dispose();
    } catch { usage = undefined; }
    return { answer, requests, steers, usage };
  }
  // For the parent model: the user's words to the child, quoted.
  const steerNote = (steers) => steers?.length
    ? `\n\nThe user steered this subagent while it worked (typed into its view, not by you): ${steers.map((t) => JSON.stringify(t.slice(0, 500))).join('; ')}.` : '';

  // Wait for one child submission to settle, record it, and tell the parent.
  async function track(sid, childId, subId, quiet = false) {
    const key = `${childId}:${subId}`;
    if (tracking.has(key)) return;
    tracking.add(key);
    try {
      const harness = await harnessOf(sid);
      const sub = subId ? await harness.submission(subId, ctx) : null;
      const settled = sub ? await sub.wait(ctx).catch((e) => ({ status: 'unanswered', reason: 'error', detail: e.message })) : null;
      if (closing) return; // the page is going away: the next open decides (resume())
      const status = !settled ? 'interrupted' : settled.status === 'done' ? 'finished' : settled.reason === 'aborted' ? 'stopped' : 'failed';
      const why = settled && settled.status !== 'done' ? (typeof settled.detail === 'string' ? settled.detail : settled.detail?.message ?? settled.reason ?? '') : '';
      const { answer, requests, steers, usage } = await summary(sid, childId).catch(() => ({ answer: '', requests: 0, steers: [] }));
      // Main joined on it: the join result carries this answer, so no report
      // is posted besides (no duplicates). Decided before the update below
      // releases the join.
      const l0 = await list(sid), row = l0.find((c) => c.id === childId);
      const joined = row && row.sub === subId && scope(sid).held(MAIN).some((h) => h.kind === 'join' && h.ids.includes(refOf(l0, row)));
      let child;
      await update(sid, (l) => l.map((c) => {
        if (c.id !== childId || c.sub !== subId) return c;
        child = { ...c, status, ended: Date.now(), requests, ...(usage ? { usage } : {}), seq: (c.seq ?? 0) + 1, ...(why ? { error: String(why).slice(0, 300) } : {}), ...(joined ? { reported: subId, joinedBy: MAIN } : {}) };
        results.set(`${childId}:${child.seq}`, answer);
        return child;
      }));
      if (!child) return; // superseded by a later message to the child
      // A one-shot with `to`: the harness forwards its reply (it has no tools),
      // tagged as from it, so it counts as delivered by message.
      if (child.oneshot && child.to && status === 'finished' && answer.trim() && !(child.to === MAIN && (child.foreground || joined))) {
        try {
          await send(sid, { ref: child.ref, name: child.name, child }, child.to, answer);
          child = (await list(sid)).find((c) => c.id === childId) ?? child;
        } catch (e) { child = { ...child, error: `its reply could not be forwarded: ${e.message}`.slice(0, 300) }; }
      }
      deps.onSettle?.(sid, child);
      if (child.foreground || child.reported === subId) return;
      // Spawned with report: false (a chair that idles until it is messaged):
      // others collect it by join or message; main is never sent a report.
      if (child.noReport) return void await update(sid, (l) => l.map((c) => (c.id === childId ? { ...c, reported: subId } : c)));
      // A child that delivered its work by message (to the chair, a peer, or
      // main) reports only that it finished: its raw output stays out of
      // main's context (G7), and no turn is started for it.
      if (child.sentIn === subId || child.wokenBy) return await report(sid, child, null, true, steers, true);
      await report(sid, child, answer, quiet, steers);
    } catch (e) {
      if (!/closed|deleted|No such session|no longer exists/i.test(e.message)) console.warn('Pouch subagent watcher:', e);
    } finally { tracking.delete(key); }
  }

  // force quiet: after a reload, so a report never starts a parent run by itself.
  // byMessage: it sent its work to other sessions; say so, without its words.
  async function report(sid, child, answer, forceQuiet = false, steers = [], byMessage = false) {
    const verb = { finished: 'finished', failed: 'failed', stopped: 'was stopped by the user', interrupted: 'was interrupted by a page reload (the user can resume it from its card)' }[child.status];
    const l = await list(sid), ref = child.ref ?? refOf(l, find(l, child.id) ?? child);
    const to = Object.keys(child.sent ?? {}).map((r) => label(l, r)).join(', ');
    const body = byMessage && child.sentIn !== child.sub ? `A message from ${label(l, child.wokenBy)} woke it, and it ended without sending anything; its reply stays in its transcript.`
      : byMessage ? `It delivered its work by message (to ${to || 'other sessions'}), so its output is not repeated here.`
      : answer?.trim() || (child.status === 'finished' ? '(It gave no answer.)' : '(No answer yet.)');
    const content = `[Subagent report from Pouch, not typed by the user] Subagent "${child.name}" (${ref}) ${verb}${child.error && child.status === 'failed' ? ` (${child.error})` : ''}. Its task: ${child.task.slice(0, 300)}${steerNote(steers)}\n\n${body}` +
      (byMessage ? '' : child.status === 'finished' ? '\n\nUse this report to continue helping the user; mention briefly what it found.' : child.oneshot ? '' : '\n\nIts partial work, if any, may be under ' + scratchOf(child.ns) + '/. Tell the user only if it matters now.');
    const data = { child: child.id, ref, name: child.name, status: child.status, text: byMessage ? '' : answer ?? '', task: child.task, ...(byMessage ? { byMessage: to, ...(child.lastSent ? { lastSent: child.lastSent } : {}) } : {}), ...(steers.length ? { steers } : {}), ...(child.oneshot ? { oneshot: true } : {}) };
    const parent = await deps.conv(sid);
    const requestId = `sa-report:${child.sub ?? child.id}`;
    const quiet = forceQuiet || child.status === 'stopped' || child.status === 'interrupted';
    // Main blocked on this child's foreground spawn (detached meanwhile): the
    // report joins that run's next step rather than waiting for it to end.
    const waitedOn = !quiet && scope(sid).held(MAIN).some((h) => h.kind === 'spawn' && h.ids.includes(ref));
    if (!quiet && !waitedOn) await userFirst(sid, parent);
    const sub = await parent.submit(quiet
      ? { type: 'write', requestId, entry: { kind: REPORT_KIND, data, model: [{ role: 'user', content, timestamp: Date.now() }] } }
      : { type: 'input', requestId, content, entry: { kind: REPORT_KIND, data }, ...(waitedOn ? { whenBusy: 'steer' } : {}) }, ctx);
    await update(sid, (l) => l.map((c) => (c.id === child.id ? { ...c, reported: child.sub } : c)));
    if (!quiet && !waitedOn) deps.onReport?.(sid, waitable(sub), child);
  }

  // After a reload (agent.js aborted every live run, `aborted`): a child that
  // was running is interrupted until the user resumes it; one whose
  // submission settled before its report was posted reports now. Both
  // reports are quiet writes (deduplicated by request id): no request spent.
  async function resume(sid, aborted = []) {
    const cut = new Set(aborted);
    for (const c of await list(sid)) owners.set(c.id, { sid, id: c.id, ns: c.ns });
    for (const c of await list(sid)) {
      if (c.status === 'running' && (cut.has(c.id) || !c.sub)) {
        const { answer, requests } = await summary(sid, c.id).catch(() => ({ answer: '', requests: c.requests }));
        let child;
        await update(sid, (l) => l.map((x) => (x.id === c.id ? (child = { ...x, status: 'interrupted', ended: Date.now(), requests }) : x)));
        if (child && !child.foreground) await report(sid, child, answer, true).catch(() => {});
      } else if (c.status === 'running' || (!c.foreground && c.sub && c.reported !== c.sub)) track(sid, c.id, c.sub, true);
    }
  }

  // Attached files for a one-shot, read in main's namespace, size-capped.
  async function attach(files) {
    if (!files?.length) return '';
    if (!deps.readFile) throw new Error('files: attaching files is not available here.');
    let out = '', total = 0;
    for (const f of files) {
      const { path, text } = await deps.readFile(String(f));
      if (text.length > MAX_FILE_CHARS) throw new Error(`files: ${path} is ${text.length.toLocaleString('en-US')} characters, over the ${MAX_FILE_CHARS.toLocaleString('en-US')} limit for one attached file. Attach a shorter excerpt (write it to /tmp first) or spawn a full subagent that reads it.`);
      total += text.length;
      if (total > MAX_FILES_CHARS) throw new Error(`files: together they are over ${MAX_FILES_CHARS.toLocaleString('en-US')} characters. Attach fewer or shorter files.`);
      out += `\n\n<file path="${path}">\n${text}\n</file>`;
    }
    return out;
  }

  async function spawn(sid, parentModel, { task, name, background = true, ns, report: reports = true, mode, files, to }, signal) {
    if (!task?.trim()) throw new Error('task is empty: describe the self-contained job for the subagent.');
    const oneshot = mode === 'oneshot';
    if (!oneshot && files?.length) throw new Error('files is for mode "oneshot" only; a full subagent reads files itself (give the paths in its task).');
    if (!oneshot && to != null) throw new Error('to is for mode "oneshot" only; tell a full subagent in its task where to send its result.');
    const l = await list(sid);
    let toRef = null;
    if (oneshot && to != null && String(to).trim()) {
      toRef = to === MAIN || to === 'main' ? MAIN : refOf(l, find(l, String(to)) ?? {});
      if (toRef !== MAIN && !find(l, String(to))) throw new Error(`to: no session "${to}" in this scope. Known: ${[`main (${MAIN})`, ...l.map((c) => label(l, refOf(l, c)))].join(', ')}.`);
    }
    const attached = oneshot ? await attach(files) : '';
    if (running(l).length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} subagents are already running in this session, the limit. Wait for a report, or stop one (action "stop"), then spawn again. Running: ${running(l).map((c) => c.name).join(', ')}.`);
    // Ids and names are reserved before the next await: parallel spawns in
    // one tool round must not take the same ones.
    const k = String(sid), taken = reserved.get(k) ?? { n: 0, names: new Set() };
    reserved.set(k, taken);
    let base = slug(name) || slug(task.split(/\s+/).slice(0, 4).join(' ')) || 'subagent', n = base, i = 2;
    while (l.some((c) => c.name === n) || taken.names.has(n)) n = `${base}-${i++}`;
    taken.n = Math.max(l.length + 2, taken.n + 1);
    taken.names.add(n);
    const ref = `s${taken.n}`;
    const harness = await harnessOf(sid);
    const toLabel = toRef ? `${label(l, toRef)}, forwarded by Pouch` : background ? 'main, as your report' : 'main, which is waiting for it';
    const child = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      // A one-shot selects no extensions: no Pouch prompt, no tools, one request.
      agent: oneshot ? { model: parentModel, extensions: [], modelTools: [], instructions: oneshotInstructions(n, ref, toLabel) }
        : { model: parentModel, modelTools: { remove: [tool], add: [peerTool] }, instructions: instructions(n, ref, task, ns) },
    }, ctx);
    // Known as a subagent (and its namespace) before its first tool call can run.
    owners.set(child.id, { sid, id: child.id, ns: ns?.length ? ns : undefined });
    const sub = await child.submit({ type: 'input', content: task + attached, requestId: `sa-task:${child.id}` }, ctx);
    const entry = { id: child.id, ref, name: n, task, status: 'running', started: Date.now(), sub: sub.id, requests: 0, ...(ns?.length && !oneshot ? { ns } : {}), ...(background ? {} : { foreground: true }), ...(reports === false ? { noReport: true } : {}),
      ...(oneshot ? { oneshot: true, ...(files?.length ? { files: files.map(String) } : {}), ...(toRef ? { to: toRef } : {}) } : {}) };
    await update(sid, (x) => [...x, entry]);
    const low = deps.lowAllowance?.();
    if (background && oneshot) {
      track(sid, child.id, sub.id);
      return { child: entry, text: `Started one-shot "${n}" (id ${ref}): one request, no tools${files?.length ? `, with ${files.length} attached file${files.length > 1 ? 's' : ''}` : ''}. Its reply ${toRef ? `goes to ${label(l, toRef)} as a message from it` : 'arrives later as its report'}; do not poll. Join it with "join" when you have nothing else to do.${low ? ` Warning: ${low}` : ''}` };
    }
    if (background) {
      track(sid, child.id, sub.id);
      return { child: entry, text: `Started subagent "${n}" (id ${ref}) in the background. Its report will arrive later as a message; keep helping the user meanwhile and do not poll for it. (List sessions with action "list", message it by id with "message", block until it goes quiet with "join" only when you have nothing else to do, end it with "stop".)${low ? ` Warning: ${low}` : ''}` };
    }
    const abort = () => child.abort(ctx).catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    // A foreground spawn blocks main, so the user can detach it (G10, G12):
    // then the child carries on in the background and reports as usual.
    const held = scope(sid).hold(MAIN, { kind: 'spawn', ids: [ref] });
    deps.onBlocked?.(sid);
    held.then(() => deps.onBlocked?.(sid));
    try {
      const done = track(sid, child.id, sub.id).then(() => ({ type: 'done' }));
      const r = await Promise.race([done, held]);
      if (r.type === 'detached') return { child: entry, text: r.note };
      scope(sid).release(MAIN, { type: 'done' }, (h) => h.kind === 'spawn' && h.ids.includes(ref));
      const fin = find(await list(sid), child.id);
      const { answer, steers } = await summary(sid, child.id);
      if (fin?.status !== 'finished') throw new Error(`Subagent "${n}" (${ref}) ${fin?.status ?? 'failed'}${fin?.error ? `: ${fin.error}` : ''}.${steerNote(steers)}${answer ? `\nLast output:\n${answer}` : ''}`);
      return { child: fin, text: fin.sentIn === fin.sub ? `Subagent "${n}" (${ref}) finished; it delivered its work by message.` : `Subagent "${n}" (${ref}) finished:${steerNote(steers)}\n\n${answer}` };
    } finally { signal?.removeEventListener('abort', abort); }
  }

  // Detach main's blocking calls (G10, G12): each returns at once, the
  // subagents it waited on keep running, and a foreground child reports
  // later like a background one. input: the user's message, a pi-durable
  // input draft (agent.js builds it) placed at main's next step; without it,
  // the user pressed Background. Never stops anything.
  async function detach(sid, { text, input } = {}) {
    const held = scope(sid).held(MAIN);
    if (!held.length) return false;
    scope(sid).newTurn();
    const sub = input ? await (await deps.conv(sid)).submit({ ...input, whenBusy: 'steer' }, ctx) : null;
    const l = await list(sid), refs = [...new Set(held.flatMap((h) => h.ids))];
    const fg = new Set(held.filter((h) => h.kind === 'spawn').flatMap((h) => h.ids));
    if (fg.size) await update(sid, (x) => x.map((c) => (fg.has(refOf(x, c)) ? { ...c, foreground: undefined } : c)));
    const who = refs.map((r) => label(l, r)).join(', ');
    const verb = refs.length > 1 ? 'continue' : 'continues';
    const note = `detached: ${who} ${verb} in the background; ` + (text != null ? `the user said: '${String(text).slice(0, 500)}'. Their message follows.` : 'the user sent it to the background.') +
      ' Its report arrives later as a message (never lost). You may continue, message it, join it again, or stop it.';
    scope(sid).release(MAIN, { type: 'detached', note });
    return sub ?? true;
  }

  // A file-watch event (src/ns/watch.js) for main or a subagent of the scope.
  // 'steer' joins a busy session's next step; 'wake' starts a turn of an idle
  // one, like a report (user-first holds; the page drives main's turn). Not
  // counted against the message caps: watches have their own wake cap.
  // Resolves to { done } for a wake (its run's end), {} otherwise.
  async function notify(sid, ref, { content, entry, mode }) {
    if (ref === MAIN) {
      const parent = await deps.conv(sid);
      if (mode === 'steer' || await busy(parent)) { await parent.submit({ type: 'input', content, entry, whenBusy: 'steer' }, ctx); return {}; }
      await userFirst(sid, parent, true);
      const sub = await parent.submit({ type: 'input', content, entry }, ctx);
      deps.onReport?.(sid, waitable(sub), null);
      return { done: sub.wait(ctx) };
    }
    const l = await list(sid), target = find(l, ref);
    if (!target || target.oneshot || ['stopped', 'failed'].includes(target.status)) return {}; // its watches go with it
    const conv = await childConv(sid, target.id);
    if (target.status === 'running' && (mode === 'steer' || await busy(conv))) { await conv.submit({ type: 'input', content, entry, whenBusy: 'steer' }, ctx); return {}; }
    if (running(l).length >= MAX_RUNNING) throw new Error(`waking ${label(l, ref)} would make ${MAX_RUNNING + 1} subagents run at once`);
    const sub = await conv.submit({ type: 'input', content, entry }, ctx);
    await update(sid, (x) => x.map((y) => (y.id === target.id ? { ...y, status: 'running', sub: sub.id, resumed: Date.now(), error: undefined, wokenBy: undefined } : y)));
    track(sid, target.id, sub.id);
    return { done: sub.wait(ctx) };
  }
  async function busyOf(sid, ref) {
    if (ref === MAIN) return busy(await deps.conv(sid));
    const l = await list(sid), target = find(l, ref);
    return !!target && target.status === 'running' && busy(await childConv(sid, target.id));
  }

  // Who is a caller: main (s1) or one of the scope's children.
  async function senderOf(sid, convId) {
    const o = owners.get(convId);
    if (!o) return { ref: MAIN, name: 'main', child: null };
    let l = await list(sid), c = l.find((x) => x.id === o.id);
    // Its first step can outrun the registry write of its own spawn.
    if (!c) { await locks.get(String(sid)); l = await list(sid); c = l.find((x) => x.id === o.id); }
    if (!c) throw new Error('This subagent is not registered yet; try again.');
    return { ref: refOf(l, c), name: c.name, child: c };
  }

  // One message from a session of the scope to another (G4, G5, G11).
  async function send(sid, from, to, text) {
    if (!text?.trim()) throw new Error('text is empty.');
    if (to == null || !String(to).trim()) throw new Error('to is empty: give the id of a session in this scope (action "list" shows them).');
    const l = await list(sid);
    const target = to === MAIN || to === 'main' ? null : find(l, String(to));
    if (to !== MAIN && to !== 'main' && !target) throw new Error(`No session "${to}" in this scope (main ${MAIN} and its subagents). Known: ${[`main (${MAIN})`, ...l.map((c) => label(l, refOf(l, c)))].join(', ')}. Messages never leave this scope.`);
    const toRef = target ? refOf(l, target) : MAIN;
    if (toRef === from.ref) throw new Error('That is you: message another session.');
    if (target?.oneshot) throw new Error(`${label(l, toRef)} is a one-shot: it makes one request and takes no messages. Spawn another one-shot with the question (and what it needs attached).`);
    if (target && target.status !== 'running' && from.child && target.status !== 'finished') throw new Error(`${label(l, toRef)} ${target.status === 'stopped' ? 'was stopped by the user' : `is ${target.status}`}; only main or the user can restart it.`);
    const refused = scope(sid).admit(from.ref, toRef);
    if (refused) { deps.onCap?.(sid, { from: label(l, from.ref), to: label(l, toRef), text: refused, at: Date.now() }); throw new Error(refused); }
    // A later join by the sender must see a result newer than this message.
    if (target) scope(sid).markSent(from.ref, toRef, target.seq ?? 0);
    const content = `${tagOf(from.name, from.ref)} ${text}`;
    const entry = { kind: MESSAGE_KIND, data: { from: from.ref, name: from.name, to: toRef, text } };
    let result;
    if (!target) {
      const parent = await deps.conv(sid);
      if (await busy(parent)) { await parent.submit({ type: 'input', content, entry, whenBusy: 'steer' }, ctx); result = `Sent to main (${MAIN}); it reads this before its next step.`; }
      else { await userFirst(sid, parent, true); const sub = await parent.submit({ type: 'input', content, entry }, ctx); deps.onReport?.(sid, waitable(sub), from.child); result = `Sent to main (${MAIN}); it starts a turn to read it.`; }
    } else {
      const conv = await childConv(sid, target.id);
      if (target.status === 'running' && await busy(conv)) {
        await conv.submit({ type: 'input', content, entry, whenBusy: 'steer' }, ctx);
        result = `Sent to ${label(l, toRef)}; it reads this before its next step.`;
      } else {
        if (running(l).length >= MAX_RUNNING) { scope(sid).undo(from.ref, toRef); throw new Error(`Not sent: ${label(l, toRef)} has finished, and waking it would make ${MAX_RUNNING + 1} subagents run at once (the limit is ${MAX_RUNNING}). Try again after one finishes.`); }
        const sub = await conv.submit({ type: 'input', content, entry }, ctx);
        await update(sid, (x) => x.map((y) => (y.id === target.id ? { ...y, status: 'running', sub: sub.id, resumed: Date.now(), error: undefined, wokenBy: from.child ? from.ref : undefined } : y)));
        track(sid, target.id, sub.id);
        result = `${label(l, toRef)} had finished; this message woke it (one more step from the allowance).`;
      }
    }
    // Edge counts, kept with the rows: sent on the sender's, got on the recipient's.
    await update(sid, (x) => x.map((y) => {
      const r = refOf(x, y);
      if (r === from.ref) return { ...y, sent: { ...y.sent, [toRef]: (y.sent?.[toRef] ?? 0) + 1 }, sentIn: y.sub, lastSent: { to: label(l, toRef), text: text.replace(/\s+/g, ' ').slice(0, 160) } };
      if (r === toRef) return { ...y, got: { ...y.got, [from.ref]: (y.got?.[from.ref] ?? 0) + 1 } };
      return y;
    }));
    return result;
  }

  // join (G4, G7): block until every target is quiet (no step running,
  // nothing queued) with a result newer than the joiner's last message to it,
  // and return each one's last message. Already quiet: at once, cached, with
  // its age. Never wakes anyone. Several joiners of one target are released
  // in the same tick (graph.js check) with the same text (results cache).
  async function join(sid, from, ids, timeout, signal) {
    const want = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null && String(x).trim()).map(String);
    if (!want.length) throw new Error('ids is empty: give the subagent ids to join (action "list" shows them).');
    const l = await list(sid), refs = [];
    for (const w of want) {
      if (w === MAIN || w === 'main') throw new Error(`main (${MAIN}) cannot be joined: it answers by message. Join subagents only.`);
      const c = find(l, w);
      if (!c) throw new Error(`No session "${w}" in this scope. Known: ${[`main (${MAIN})`, ...l.map((x) => label(l, refOf(l, x)))].join(', ')}.`);
      refs.push(refOf(l, c));
    }
    if (refs.includes(from.ref)) throw new Error('You cannot join yourself.');
    const loop = scope(sid).cycle(from.ref, refs);
    if (loop) throw new Error(`Refused: joining would close a cycle of blocked sessions (${loop.map((r) => label(l, r)).join(' -> ')}). One of you must answer by message instead.`);
    const secs = Math.min(Math.max(Number(timeout) || JOIN_DEFAULT_S, 1), JOIN_MAX_S);
    const rowOf = (ref) => { const x = last.get(String(sid)) ?? l; return x.find((y) => refOf(x, y) === ref); };
    const ready = (ref) => { const c = rowOf(ref); return !c || (c.status !== 'running' && (c.seq ?? 0) > scope(sid).sentSeq(from.ref, ref)); };
    const t0 = Date.now(), cached = new Set(refs.filter(ready));
    let r = { type: 'ready' };
    if (cached.size < refs.length) {
      const holding = scope(sid).hold(from.ref, { kind: 'join', ids: refs, ready, timeoutMs: secs * 1000, signal });
      deps.onBlocked?.(sid);
      r = await holding;
      deps.onBlocked?.(sid);
    }
    if (r.type === 'aborted') throw new Error('Stopped.');
    if (r.type === 'detached') return r.note;
    const now = await list(sid), blocked = Date.now() - t0;
    const STATE = { finished: 'quiet', stopped: 'stopped', interrupted: 'stopped', failed: 'failed', running: 'running' };
    const out = [];
    for (const ref of refs) {
      const c = now.find((y) => refOf(now, y) === ref);
      const key = `${c.id}:${c.seq ?? 0}`;
      const text = c.status === 'running' ? (await summary(sid, c.id).catch(() => ({ answer: '' }))).answer
        : results.get(key) ?? (await summary(sid, c.id).catch(() => ({ answer: '' }))).answer;
      if (c.status !== 'running') results.set(key, text);
      const lastMsg = text.length > 4000 ? text.slice(0, 4000) + ` [${text.length - 4000} more characters]` : text;
      const o = { id: ref, name: c.name, state: STATE[c.status] ?? c.status, blocked_ms: cached.has(ref) ? 0 : blocked };
      if (r.type === 'timeout' && c.status === 'running') o.timed_out = true;
      else if (cached.has(ref)) Object.assign(o, { cached: true, quiet_since: new Date(c.ended ?? Date.now()).toISOString(), age_s: Math.round((Date.now() - (c.ended ?? Date.now())) / 1000) });
      else o.fresh = true;
      o.last = lastMsg;
      // Its reply was empty, but it sent its work by message this turn: say where.
      if ((!text.trim() || c.oneshot) && c.lastSent && c.sentIn === c.sub) Object.assign(o, { sent_to: c.lastSent.to, sent_preview: c.lastSent.text });
      out.push(o);
    }
    const head = r.type === 'timeout' ? `Joined: timed out after ${secs}s; ${out.filter((o) => o.timed_out).map((o) => `${o.name} (${o.id})`).join(', ')} still running (it keeps running; its last message so far is below).`
      : `Joined: ${out.map((o) => `${o.name} (${o.id}) ${o.state}, ${o.cached ? `cached ${o.age_s}s` : 'fresh'}${o.sent_to ? `, sent its findings to ${o.sent_to}` : ''}`).join('; ')}.`;
    return `${head} Messages they sent you are separate entries tagged [from <name> (<id>)].\n${JSON.stringify(out)}`;
  }

  // The scope, for `list` (G5): id, name, state, parent, task, message counts.
  async function roster(sid, from) {
    const l = await list(sid);
    const inOf = (ref) => l.reduce((n, c) => n + (c.sent?.[ref] ?? 0), 0);
    const lines = [`- ${MAIN} main${from.ref === MAIN ? ' (you)' : ''}: the top-level agent, talking with the user. Messages received: ${inOf(MAIN)}.`];
    for (const c of l) {
      const ref = refOf(l, c), got = Object.values(c.got ?? {}).reduce((a, b) => a + b, 0), sent = Object.values(c.sent ?? {}).reduce((a, b) => a + b, 0);
      lines.push(`- ${ref} ${c.name}${ref === from.ref ? ' (you)' : ''}: ${c.status}, parent ${MAIN}, messages in ${got} / out ${sent}. Task: ${c.task.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    const w = deps.watchLines?.(sid, from.ref);
    if (w) lines.push(w);
    return lines.join('\n');
  }

  // user: typed by the user (marked STEER_KIND and quoted in the report),
  // otherwise sent by the main agent's tool (tagged as from main).
  async function message(sid, ref, text, { user = false } = {}) {
    if (!user) return send(sid, { ref: MAIN, name: 'main', child: null }, ref, text);
    const l = await list(sid), c = find(l, ref);
    if (!c) throw new Error(`No subagent "${ref}" in this session. Known: ${l.map((x) => x.name).join(', ') || 'none'}.`);
    if (!text?.trim()) throw new Error('text is empty.');
    if (c.oneshot) throw new Error(`"${c.name}" is a one-shot: it makes one request and takes no messages.`);
    const conv = await childConv(sid, c.id);
    const input = { type: 'input', content: fromUser(text), entry: { kind: STEER_KIND, data: { text } } };
    if (c.status === 'running') {
      await conv.submit({ ...input, whenBusy: 'steer' }, ctx);
      scope(sid).release(refOf(l, c), { type: 'detached', note: `Interrupted: the user wrote to you (their message follows). Join again afterwards if you still need to.` });
      return `Sent to "${c.name}" while it works; its report will reflect it.`;
    }
    if (running(l).length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} subagents are already running; wait for one to finish first.`);
    const sub = await conv.submit(input, ctx);
    await update(sid, (x) => x.map((y) => (y.id === c.id ? { ...y, status: 'running', sub: sub.id, started: y.started, resumed: Date.now(), error: undefined, wokenBy: undefined } : y)));
    track(sid, c.id, sub.id);
    return `"${c.name}" is working on it again in the background; a new report will arrive as a message.`;
  }

  // Steering from the subagent's own view: joins the running work at its
  // next step boundary (pi-durable places a steer after the current tool
  // round, before the next model request) and never starts a new turn, so a
  // child that has finished refuses. The check reads the live run right
  // before submitting; a run ending in between is the one remaining race.
  // A child blocked in `join` is released first: user steering preempts
  // blocking, as it does for main (G10).
  // out (optional): its .sub is set to the submission, so the page can track
  // and withdraw it.
  async function steer(sid, ref, text, out) {
    const l = await list(sid), c = find(l, ref);
    if (!c) throw new Error(`No subagent "${ref}" in this session.`);
    if (!text?.trim()) throw new Error('text is empty.');
    if (c.oneshot) throw new Error(`"${c.name}" is a one-shot: it makes one request and cannot be steered; nothing was sent.`);
    const conv = await childConv(sid, c.id);
    if (c.status !== 'running' || !(await busy(conv))) throw new Error(`"${c.name}" has finished; nothing was sent. Its report went to the main conversation.`);
    if (out) out.sub = await conv.submit({ type: 'input', content: fromUser(text), entry: { kind: STEER_KIND, data: { text } }, whenBusy: 'steer' }, ctx);
    else await conv.submit({ type: 'input', content: fromUser(text), entry: { kind: STEER_KIND, data: { text } }, whenBusy: 'steer' }, ctx);
    scope(sid).release(refOf(l, c), { type: 'detached', note: `Interrupted: the user wrote to you (their message follows). Join again afterwards if you still need to.` });
    return `Sent to "${c.name}"; it reads this before its next step.`;
  }

  async function stop(sid, ref) {
    const l = await list(sid), c = find(l, ref);
    if (!c) throw new Error(`No subagent "${ref}" in this session.`);
    if (c.status !== 'running') return `"${c.name}" is not running (${c.status}).`;
    await (await childConv(sid, c.id)).abort(ctx);
    return `Stopped "${c.name}" (${refOf(l, c)}).`;
  }

  async function status(sid, ref) {
    const l = await list(sid);
    if (!ref) {
      if (!l.length) return 'No subagents in this session.';
      return roster(sid, { ref: MAIN });
    }
    const c = find(l, ref);
    if (!c) throw new Error(`No subagent "${ref}" in this session.`);
    const { answer, requests } = await summary(sid, c.id);
    return `${c.name} (${refOf(l, c)}): ${c.status}, ${requests} requests so far.\nTask: ${c.task}\nLatest output:\n${answer.slice(-1500) || '(nothing yet)'}`;
  }

  const ID = Type.Optional(Type.String({ description: 'message: the recipient id, e.g. "s3" (or "s1" for main)' }));
  const JOIN_IDS = Type.Optional(Type.Array(Type.String(), { description: 'join: subagent ids; returns when each is quiet, with its last message' }));
  const TIMEOUT = Type.Optional(Type.Number({ description: `join: give up after this many seconds (default ${JOIN_DEFAULT_S}, at most ${JOIN_MAX_S}); the targets keep running` }));
  const TEXT = Type.Optional(Type.String({ description: 'message: what to tell it' }));
  const CAPS = `At most ${MAX_SCOPE_MESSAGES} messages per user turn in this scope and ${MAX_PAIR_MESSAGES} between any two sessions.`;

  async function act(args, api, context, from, sid) {
    if (args.action === 'list') return roster(sid, from);
    if (args.action === 'message') return send(sid, from, args.to ?? args.id ?? args.name, args.text);
    if (args.action === 'join') return join(sid, from, args.ids ?? args.id ?? args.to, args.timeout, context.abortSignal);
    return null;
  }

  const tool = defineTool({
    name: 'subagent', label: 'Subagent',
    description: 'Run self-contained tasks in subagents (separate Pouch agents with read/write/edit/bash and the bayleaf CLI, but no subagents of their own) while you keep talking to the user, and connect them by messages. ' +
      `action "spawn" starts one and returns its id (background by default: returns at once; its report arrives later as a message). "list" shows the sessions of this scope (you are main, ${MAIN}). "message" sends text to one id (to: "s3"). "join" blocks until the given subagents are quiet and returns each one's last message (fresh, or cached with its age if it was already quiet; it never wakes one: message, then join). "stop" ends one. At most ${MAX_RUNNING} run at once. ${CAPS} Each of their steps costs one request from the daily allowance; mode "oneshot" costs exactly one. Several spawns with background false in one step run in parallel and return together.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal('spawn'), Type.Literal('list'), Type.Literal('message'), Type.Literal('join'), Type.Literal('stop'), Type.Literal('status')]),
      task: Type.Optional(Type.String({ description: 'spawn: the complete, self-contained task (the subagent sees nothing else of this conversation)' })),
      name: Type.Optional(Type.String({ description: 'spawn: a short name, e.g. "related-work"' })),
      background: Type.Optional(Type.Boolean({ description: 'spawn: false waits for the answer instead (default true)' })),
      report: Type.Optional(Type.Boolean({ description: 'spawn: false means it never posts a report to you when it goes quiet (collect it with join or have it message you), e.g. a chair that idles until messaged (default true)' })),
      ns: Type.Optional(Type.Array(Type.String(), { description: 'spawn: folders it may reach, each "path" or "path:ro" (default: /work, /pouch:ro and mounted folders; always a private /tmp)' })),
      mode: Type.Optional(Type.Union([Type.Literal('agent'), Type.Literal('oneshot')], { description: 'spawn: "oneshot" makes exactly one request with no tools: it answers the task from the files you attach, and its reply is its report (cheapest; for judging or summarizing given text). Default "agent": a full subagent with tools' })),
      files: Type.Optional(Type.Array(Type.String(), { description: `spawn oneshot: file paths whose contents are attached to the task (at most ${MAX_FILE_CHARS.toLocaleString('en-US')} characters each)` })),
      to: Type.Optional(Type.String({ description: 'message: the recipient id, e.g. "s3" (or "s1" for main). spawn oneshot: send its reply to this id as a message from it, instead of a report' })),
      id: Type.Optional(Type.String({ description: 'stop/status: the subagent id or name' })),
      ids: JOIN_IDS, timeout: TIMEOUT, text: TEXT,
    }),
    execute: async (args, api, context) => {
      const sid = deps.sidOf(api.conversationId);
      if (owners.has(api.conversationId)) throw new Error('Subagents cannot start subagents; use the agents tool.');
      let text;
      if (args.action === 'spawn') {
        const agent = await api.agent(context);
        const r = await spawn(sid, agent.model, args, context.abortSignal);
        await api.details({ child: r.child.id, name: r.child.name, ref: r.child.ref, ...(r.child.oneshot ? { oneshot: true } : {}) }, context);
        text = r.text;
      } else if (args.action === 'stop') text = await stop(sid, args.id ?? args.to ?? args.name);
      else if (args.action === 'status') text = await status(sid, args.id ?? args.to ?? args.name);
      else text = await act(args, api, context, { ref: MAIN, name: 'main', child: null }, sid);
      return { output: [{ type: 'text', text }] };
    },
  });

  // The subagents' trimmed tool (deferred: offered only where modelTools adds it).
  const peerTool = defineTool({
    name: 'agents', label: 'Agents', deferred: true,
    description: `Talk to the other sessions of your scope by id: main is ${MAIN}, subagents are s2, s3, ... "list" shows them (id, name, state, task). "message" sends text to one id (to: "s2"); it arrives between their steps, tagged with your name and id. "join" blocks until the given subagents are quiet and returns each one's last message (cached if already quiet; it never wakes one: message, then join); use it only when you have nothing else to do. You cannot spawn or stop sessions; to stop, finish your reply. ${CAPS}`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('message'), Type.Literal('join')]),
      to: ID, ids: JOIN_IDS, timeout: TIMEOUT, text: TEXT,
    }),
    execute: async (args, api, context) => {
      if (!owners.has(api.conversationId)) throw new Error('This tool is for subagents; use the subagent tool.');
      const sid = owners.get(api.conversationId).sid;
      const from = await senderOf(sid, api.conversationId);
      const text = await act(args, api, context, from, sid);
      if (text == null) throw new Error(`Unknown action "${args.action}": use list, message or join.`);
      return { output: [{ type: 'text', text }] };
    },
  });

  return {
    close() { closing = true; },
    tool, peerTool, list, resume, spawn, message, steer, stop, status, summary, childConv, detach, notify, busyOf,
    // What main (or a child ref) is blocked on: [{ kind, ids, since }].
    blocked: (sid, ref = MAIN) => scope(sid).held(ref),
    // The user wrote to main: the message caps start over (graph.js).
    newTurn: (sid) => scope(sid).newTurn(),
    refOf: (l, c) => refOf(l, c),
    // The child behind a conversation id, if it is one: { sid, id }.
    owner: (convId) => owners.get(convId) ?? null,
    async stopAll(sid) {
      for (const c of running(await list(sid))) await (await childConv(sid, c.id).catch(() => null))?.abort(ctx).catch(() => {});
    },
  };
}
