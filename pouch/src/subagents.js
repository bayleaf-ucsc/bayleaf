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
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';

export const REPORT_KIND = 'pouch.subagent';
export const MAX_RUNNING = 3;
export const SUBAGENT_DIR = '/work/.subagents';
const ctx0 = undefined;

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const textOf = (content) => typeof content === 'string' ? content
  : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');

function instructions(name, task) {
  return `You are a subagent named "${name}", started by the main BayLeaf Pouch agent to work on one task in the background while it keeps talking to the user. Work only on this task:
<task>
${task}
</task>
You cannot start subagents yourself (ignore any guidance about them above) and nobody will answer questions: make reasonable assumptions and say what they were. Write any long output (notes, lists, drafts) to a file under ${SUBAGENT_DIR}/, for example ${SUBAGENT_DIR}/${name}.md. Finish with a concise report (at most about 200 words) that states what you found or did and lists the paths of files you wrote; the main agent reads only that report.`;
}

// deps: { ctx, laneOf(sid), lane(name), conv(sid), modelRef(id), normalizeView(view, entries),
//         reg: { get(sid), set(sid, list) }, onChange(sid, list), onReport(sid, submission, child),
//         onSettle(sid, child), lowAllowance() -> string|null, sidOf(convId) }
export function createSubagents(deps) {
  const ctx = deps.ctx ?? ctx0;
  const tracking = new Set();
  let closing = false;
  const owners = new Map(); // child conversation id -> { sid, child id }
  const locks = new Map();  // sid -> promise chain for registry updates

  // Serialize read-modify-write of one session's registry.
  function update(sid, fn) {
    const prev = locks.get(String(sid)) ?? Promise.resolve();
    const next = prev.then(async () => {
      const list = (await deps.reg.get(String(sid))) ?? [];
      const out = (await fn(list)) ?? list;
      await deps.reg.set(String(sid), out.length ? out : undefined);
      for (const c of out) owners.set(c.id, { sid, id: c.id });
      deps.onChange?.(sid, out);
      return out;
    });
    locks.set(String(sid), next.catch(() => {}));
    return next;
  }
  const list = async (sid) => (await deps.reg.get(String(sid))) ?? [];
  const running = (l) => l.filter((c) => c.status === 'running');
  const find = (l, ref) => l.find((c) => c.id === ref || c.name === ref || c.name === slug(ref));

  async function harnessOf(sid) { return (await deps.lane(deps.laneOf(sid))).harness; }
  async function childConv(sid, id) {
    const c = await (await harnessOf(sid)).conversation(id, ctx);
    if (!c) throw new Error('That subagent no longer exists.');
    return c;
  }

  // The child's final state: its last answer and how many model requests it made.
  async function summary(sid, id) {
    const c = await childConv(sid, id);
    let answer = '', requests = 0, cursor;
    do {
      const page = await c.entries(cursor ? {} : { order: 'ascending' }, 500, cursor, ctx);
      for (const e of page.items) {
        if (e.kind !== 'pi.assistant') continue;
        requests++;
        const t = textOf(e.model?.[0]?.content);
        if (t.trim()) answer = t;
      }
      cursor = page.next;
    } while (cursor);
    return { answer, requests };
  }

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
      const { answer, requests } = await summary(sid, childId).catch(() => ({ answer: '', requests: 0 }));
      let child;
      await update(sid, (l) => l.map((c) => {
        if (c.id !== childId || c.sub !== subId) return c;
        child = { ...c, status, ended: Date.now(), requests, ...(why ? { error: String(why).slice(0, 300) } : {}) };
        return child;
      }));
      if (!child) return; // superseded by a later message to the child
      deps.onSettle?.(sid, child);
      if (child.foreground || child.reported === subId) return;
      await report(sid, child, answer, quiet);
    } catch (e) {
      if (!/closed|deleted|No such session|no longer exists/i.test(e.message)) console.warn('Pouch subagent watcher:', e);
    } finally { tracking.delete(key); }
  }

  // force quiet: after a reload, so a report never starts a parent run by itself.
  async function report(sid, child, answer, forceQuiet = false) {
    const verb = { finished: 'finished', failed: 'failed', stopped: 'was stopped by the user', interrupted: 'was interrupted by a page reload (the user can resume it from its card)' }[child.status];
    const body = answer?.trim() || (child.status === 'finished' ? '(It gave no answer.)' : '(No answer yet.)');
    const content = `[Subagent report from Pouch, not typed by the user] Subagent "${child.name}" ${verb}${child.error && child.status === 'failed' ? ` (${child.error})` : ''}. Its task: ${child.task.slice(0, 300)}\n\n${body}` +
      (child.status === 'finished' ? '\n\nUse this report to continue helping the user; mention briefly what it found.' : '\n\nIts partial work, if any, may be under ' + SUBAGENT_DIR + '/. Tell the user only if it matters now.');
    const data = { child: child.id, name: child.name, status: child.status, text: answer ?? '', task: child.task };
    const parent = await deps.conv(sid);
    const requestId = `sa-report:${child.sub ?? child.id}`;
    const quiet = forceQuiet || child.status === 'stopped' || child.status === 'interrupted';
    const sub = await parent.submit(quiet
      ? { type: 'write', requestId, entry: { kind: REPORT_KIND, data, model: [{ role: 'user', content, timestamp: Date.now() }] } }
      : { type: 'input', requestId, content, entry: { kind: REPORT_KIND, data } }, ctx);
    await update(sid, (l) => l.map((c) => (c.id === child.id ? { ...c, reported: child.sub } : c)));
    if (!quiet) deps.onReport?.(sid, sub, child);
  }

  // After a reload (agent.js aborted every live run, `aborted`): a child that
  // was running is interrupted until the user resumes it; one whose
  // submission settled before its report was posted reports now. Both
  // reports are quiet writes (deduplicated by request id): no request spent.
  async function resume(sid, aborted = []) {
    const cut = new Set(aborted);
    for (const c of await list(sid)) owners.set(c.id, { sid, id: c.id });
    for (const c of await list(sid)) {
      if (c.status === 'running' && (cut.has(c.id) || !c.sub)) {
        const { answer, requests } = await summary(sid, c.id).catch(() => ({ answer: '', requests: c.requests }));
        let child;
        await update(sid, (l) => l.map((x) => (x.id === c.id ? (child = { ...x, status: 'interrupted', ended: Date.now(), requests }) : x)));
        if (child && !child.foreground) await report(sid, child, answer, true).catch(() => {});
      } else if (c.status === 'running' || (!c.foreground && c.sub && c.reported !== c.sub)) track(sid, c.id, c.sub, true);
    }
  }

  async function spawn(sid, parentModel, { task, name, background = true }, signal) {
    if (!task?.trim()) throw new Error('task is empty: describe the self-contained job for the subagent.');
    const l = await list(sid);
    if (running(l).length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} subagents are already running in this session, the limit. Wait for a report, or stop one (action "stop"), then spawn again. Running: ${running(l).map((c) => c.name).join(', ')}.`);
    let base = slug(name) || slug(task.split(/\s+/).slice(0, 4).join(' ')) || 'subagent', n = base, i = 2;
    while (l.some((c) => c.name === n)) n = `${base}-${i++}`;
    const harness = await harnessOf(sid);
    const child = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { model: parentModel, modelTools: { remove: [tool] }, instructions: instructions(n, task) },
    }, ctx);
    const sub = await child.submit({ type: 'input', content: task, requestId: `sa-task:${child.id}` }, ctx);
    const entry = { id: child.id, name: n, task, status: 'running', started: Date.now(), sub: sub.id, requests: 0, ...(background ? {} : { foreground: true }) };
    await update(sid, (x) => [...x, entry]);
    const low = deps.lowAllowance?.();
    if (background) {
      track(sid, child.id, sub.id);
      return { child: entry, text: `Started subagent "${n}" in the background. Its report will arrive later as a message; keep helping the user meanwhile and do not poll for it. (Check on it with action "status", steer it with "message", end it with "stop".)${low ? ` Warning: ${low}` : ''}` };
    }
    const abort = () => child.abort(ctx).catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await track(sid, child.id, sub.id);
      const done = find(await list(sid), child.id);
      const { answer } = await summary(sid, child.id);
      if (done?.status !== 'finished') throw new Error(`Subagent "${n}" ${done?.status ?? 'failed'}${done?.error ? `: ${done.error}` : ''}.${answer ? `\nLast output:\n${answer}` : ''}`);
      return { child: done, text: `Subagent "${n}" finished:\n\n${answer}` };
    } finally { signal?.removeEventListener('abort', abort); }
  }

  async function message(sid, ref, text) {
    const l = await list(sid), c = find(l, ref);
    if (!c) throw new Error(`No subagent "${ref}" in this session. Known: ${l.map((x) => x.name).join(', ') || 'none'}.`);
    if (!text?.trim()) throw new Error('text is empty.');
    const conv = await childConv(sid, c.id);
    if (c.status === 'running') {
      await conv.submit({ type: 'input', content: text, whenBusy: 'steer' }, ctx);
      return `Sent to "${c.name}" while it works; its report will reflect it.`;
    }
    if (running(l).length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} subagents are already running; wait for one to finish first.`);
    const sub = await conv.submit({ type: 'input', content: text }, ctx);
    await update(sid, (x) => x.map((y) => (y.id === c.id ? { ...y, status: 'running', sub: sub.id, started: y.started, resumed: Date.now(), error: undefined } : y)));
    track(sid, c.id, sub.id);
    return `"${c.name}" is working on it again in the background; a new report will arrive as a message.`;
  }

  async function stop(sid, ref) {
    const l = await list(sid), c = find(l, ref);
    if (!c) throw new Error(`No subagent "${ref}" in this session.`);
    if (c.status !== 'running') return `"${c.name}" is not running (${c.status}).`;
    await (await childConv(sid, c.id)).abort(ctx);
    return `Stopped "${c.name}".`;
  }

  async function status(sid, ref) {
    const l = await list(sid);
    if (!ref) {
      if (!l.length) return 'No subagents in this session.';
      return l.map((c) => `- ${c.name}: ${c.status}, ${Math.round(((c.ended ?? Date.now()) - c.started) / 1000)}s, ${c.requests ?? '?'} requests. Task: ${c.task.slice(0, 100)}`).join('\n');
    }
    const c = find(l, ref);
    if (!c) throw new Error(`No subagent "${ref}" in this session.`);
    const { answer, requests } = await summary(sid, c.id);
    return `${c.name}: ${c.status}, ${requests} requests so far.\nTask: ${c.task}\nLatest output:\n${answer.slice(-1500) || '(nothing yet)'}`;
  }

  const tool = defineTool({
    name: 'subagent', label: 'Subagent',
    description: 'Run a self-contained task in a background subagent (a separate Pouch agent with read/write/edit/bash and the bayleaf CLI, but no subagents of its own) while you keep talking to the user. ' +
      `action "spawn" starts one (background by default: returns at once; its report arrives later as a message). "message" sends it more instructions; "status" lists subagents or shows one; "stop" ends one. At most ${MAX_RUNNING} run at once. Each of its steps costs one request from the daily allowance.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal('spawn'), Type.Literal('message'), Type.Literal('status'), Type.Literal('stop')]),
      task: Type.Optional(Type.String({ description: 'spawn: the complete, self-contained task (the subagent sees nothing else of this conversation)' })),
      name: Type.Optional(Type.String({ description: 'spawn: a short name, e.g. "related-work"' })),
      background: Type.Optional(Type.Boolean({ description: 'spawn: false waits for the answer instead (default true)' })),
      id: Type.Optional(Type.String({ description: 'message/status/stop: the subagent name' })),
      text: Type.Optional(Type.String({ description: 'message: what to tell it' })),
    }),
    execute: async (args, api, context) => {
      const sid = deps.sidOf(api.conversationId);
      if (owners.has(api.conversationId)) throw new Error('Subagents cannot start subagents.');
      let text;
      if (args.action === 'spawn') {
        const agent = await api.agent(context);
        const r = await spawn(sid, agent.model, args, context.abortSignal);
        await api.details({ child: r.child.id, name: r.child.name }, context);
        text = r.text;
      } else if (args.action === 'message') text = await message(sid, args.id ?? args.name, args.text);
      else if (args.action === 'stop') text = await stop(sid, args.id ?? args.name);
      else text = await status(sid, args.id ?? args.name);
      return { output: [{ type: 'text', text }] };
    },
  });

  return {
    close() { closing = true; },
    tool, list, resume, spawn, message, stop, status, summary, childConv,
    // The child behind a conversation id, if it is one: { sid, id }.
    owner: (convId) => owners.get(convId) ?? null,
    async stopAll(sid) {
      for (const c of running(await list(sid))) await (await childConv(sid, c.id).catch(() => null))?.abort(ctx).catch(() => {});
    },
  };
}
