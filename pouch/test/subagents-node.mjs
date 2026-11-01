// Node check of background subagents (src/subagents.js) against a scripted
// fake Sealed endpoint: no network, no real model requests.
// Run: node test/subagents-node.mjs (section 5 needs fake-indexeddb at /tmp/pouch-scratch/fidb, as vfs-node.mjs)
import { openAgent, MemoryStorage, Type } from '../src/agent.js';
import { MAX_RUNNING } from '../src/subagents.js';

const sleep = (ms, signal) => new Promise((r, j) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); j(new DOMException('aborted', 'AbortError')); }, { once: true });
});
let signal = null;
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };

// Scripted model: decides from the last message of each request.
const log = [];
let childDelay = 300;
function sse(chunks) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) {
      for (const ch of chunks) { c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`)); }
      c.enqueue(enc.encode('data: [DONE]\n\n')); c.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta, finish = null) => ({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
const say = (text) => sse([chunk({ role: 'assistant', content: text }), chunk({}, 'stop')]);
let callN = 0;
const call = (name, args) => sse([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${++callN}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, 'tool_calls')]);
const script = [];
async function fakeFetch(_url, init) {
  const body = JSON.parse(init.body);
  const sys = body.messages.find((m) => m.role === 'system')?.content ?? '';
  const last = body.messages.at(-1);
  const lastText = typeof last.content === 'string' ? last.content : (last.content ?? []).map((b) => b.text ?? '').join('');
  const child = /You are a subagent named "([^"]+)"/.exec(typeof sys === 'string' ? sys : JSON.stringify(sys))?.[1];
  const tools = (body.tools ?? []).map((t) => t.function.name);
  signal = init.signal;
  log.push({ child, last: last.role, text: lastText.slice(0, 80), tools });
  for (const s of script) { const r = s({ child, last, lastText, tools }); if (r) return typeof r === 'function' ? r() : r; }
  return say('ok');
}
const client = {
  getVerificationDocument: async () => ({ securityVerified: true }),
  secureClient: { fetch: fakeFetch },
  openAIOptions: { apiKey: 'test' },
};

const regs = new Map();
const reports = [];
const agent = await openAgent({
  storage: new MemoryStorage(), tools: [], systemPrompt: () => 'You are BayLeaf Pouch.',
  getClient: async () => client, models: [{ id: 'm', contextWindow: 131072 }],
  subagents: {
    reg: { get: async (sid) => regs.get(sid), set: async (sid, l) => (l ? regs.set(sid, l) : regs.delete(sid)) },
    onReport: (sid, sub, child) => reports.push({ sid, child: child.name, status: child.status, sub }),
  },
});
const sid = await agent.createSession('m');
const names = (o) => o.items.filter((i) => i.type === 'tool').map((i) => i.name);

// 1. Background spawn: the parent answers while the child works.
script.push(({ child, last, lastText }) => !child && last.role === 'user' && /please explore/.test(lastText) && call('subagent', { action: 'spawn', task: 'Explore /work/proj and summarize it', name: 'explorer' }));
script.push(({ child, last }) => !child && last.role === 'tool' && say('Started it. Here is a joke meanwhile.'));
script.push(({ child, tools }) => child && (ok(!tools.includes('subagent'), 'child is not offered the subagent tool'), () => sleep(childDelay).then(() => say('Architecture: three modules. Wrote /work/.subagents/explorer.md'))));
script.push(({ child, lastText }) => !child && /Subagent report/.test(lastText) && say('The explorer reports three modules.'));
const t0 = Date.now();
await agent.send(sid, 'please explore in the background');
const parentDone = Date.now() - t0;
let l = await agent.subagents.list(sid);
ok(l.length === 1 && l[0].status === 'running', `child running after parent answered (${parentDone} ms, status ${l[0]?.status})`);
for (let i = 0; i < 50 && !reports.length; i++) await sleep(50);
ok(reports.length === 1 && reports[0].child === 'explorer', 'report posted to the parent');
await reports[0]?.sub.wait();
let v = await agent.snapshot(sid);
const rep = v.items.find((i) => i.type === 'report');
ok(rep && rep.name === 'explorer' && rep.status === 'finished' && /three modules/.test(rep.text), 'report entry renders as type report with the answer');
if (process.env.DBG) { console.log(JSON.stringify(log, null, 0)); console.log(JSON.stringify(v.items.map((i) => [i.type, i.name, i.text?.slice(0, 60), i.details]))); }
ok(v.items.at(-1).type === 'assistant' && /three modules/.test(v.items.at(-1).text), 'parent used the report in its next run');
l = await agent.subagents.list(sid);
ok(l[0].status === 'finished' && l[0].requests === 1, `registry finished, ${l[0].requests} request`);
const spawnCall = v.items.find((i) => i.type === 'tool' && i.name === 'subagent');
ok(spawnCall?.details?.child === l[0].id, `spawn call carries details.child (${JSON.stringify(spawnCall?.details)})`);

// 2. Resume on the same submission does not post twice.
await agent.subagents.resume(sid);
await sleep(200);
ok(reports.length === 1, 'resume() after settle does not post a second report');

// 3. Concurrency cap and stop.
script.unshift(({ child, last, lastText }) => !child && last.role === 'user' && /four/.test(lastText) && call('subagent', { action: 'spawn', task: `slow job ${callN}`, name: `slow${callN}` }));
script.unshift(({ child, last }) => !child && last.role === 'tool' && say('spawned'));
script.unshift(({ child }) => child && (() => sleep(60_000, signal).then(() => say('late'))));
for (let i = 0; i < MAX_RUNNING; i++) await agent.send(sid, 'spawn four');
l = await agent.subagents.list(sid);
ok(l.filter((c) => c.status === 'running').length === MAX_RUNNING, `${MAX_RUNNING} running`);
await agent.send(sid, 'spawn four');
v = await agent.snapshot(sid);
const refused = v.items.filter((i) => i.type === 'tool' && i.name === 'subagent').at(-1);
ok(refused.status === 'error' && new RegExp(`${MAX_RUNNING} subagents are already running`).test(refused.output), `spawn past the cap refused: ${refused.output.slice(0, 80)}`);
const first = l.find((c) => c.status === 'running');
await agent.subagents.stop(sid, first.id);
for (let i = 0; i < 40 && (await agent.subagents.list(sid)).find((c) => c.id === first.id).status === 'running'; i++) await sleep(50);
await sleep(200);
v = await agent.snapshot(sid);
const stopRep = v.items.filter((i) => i.type === 'report').at(-1);
ok(stopRep?.status === 'stopped' && stopRep.name === first.name, 'stopped child: quiet report entry in parent');
ok(!v.busy, 'parent not busy after a stop report (no request spent)');
ok(!(await agent.snapshot(sid)).busy, `parent idle while ${MAX_RUNNING - 1} children still run`);

// 4. Deleting is covered in the browser test; close everything.
for (const c of await agent.subagents.list(sid)) if (c.status === 'running') await agent.subagents.stop(sid, c.id);
await sleep(300);
await agent.close();

// 5. Reopen ("reload") never spends requests: a run cut off mid-request and a
// running child are aborted and reported interrupted, not resumed.
// Reopening needs storage that outlives a Harness: IndexedDB (fake-indexeddb,
// as in vfs-node.mjs) and per-session databases, like the page.
await import('/tmp/pouch-scratch/fidb/node_modules/fake-indexeddb/auto/index.mjs');
{
  const ptr = new Map();
  const mk = (onInterrupted) => openAgent({
    tools: [], pointer: { get: async (k) => ptr.get(k), set: async (k, v) => ptr.set(k, v) }, systemPrompt: () => 'You are BayLeaf Pouch.',
    getClient: async () => client, models: [{ id: 'm', contextWindow: 131072 }], onInterrupted,
    subagents: { reg: { get: async (k) => regs.get(k), set: async (k, l) => (l ? regs.set(k, l) : regs.delete(k)) } },
  });
  script.length = 0;
  script.push(({ child, last, lastText }) => !child && last.role === 'user' && /spawn one/.test(lastText) && call('subagent', { action: 'spawn', task: 'long job', name: 'longjob' }));
  script.push(({ child, last }) => !child && last.role === 'tool' && say('spawned'));
  script.push(({ child }) => child && (() => sleep(60_000, signal).then(() => say('late'))));
  script.push(({ child, lastText }) => !child && /hang/.test(lastText) && (() => sleep(60_000, signal).then(() => say('late'))));
  let a1 = await mk();
  const s2 = await a1.createSession('m');
  await a1.send(s2, 'spawn one');
  await sleep(300);
  a1.send(s2, 'hang please').catch(() => {});
  await sleep(300);
  ok((await a1.subagents.list(s2))[0]?.status === 'running', 'child running, parent mid-request before reload');
  await a1.close().catch(() => {});
  let interrupted = [];
  for (let round = 1; round <= 3; round++) {
    const n0 = log.length;
    const a2 = await mk((sids) => interrupted.push(...sids));
    await a2.snapshot(s2); // opens the lane, as attaching does
    await sleep(800);
    ok(log.length === n0, `reopen ${round}: ${log.length - n0} model requests`);
    if (round === 1) {
      const c = (await a2.subagents.list(s2))[0];
      ok(c.status === 'interrupted', `child marked interrupted (${c.status})`);
      ok(interrupted.includes(s2), 'parent reported interrupted');
      const v = await a2.snapshot(s2);
      ok(!v.busy && v.items.some((i) => i.type === 'report' && i.status === 'interrupted'), 'quiet interrupted report in parent, parent idle');
    }
    await a2.close();
  }
  ok(interrupted.filter((x) => x === s2).length === 1, `parent interrupted once, not on later reopens (${interrupted.length})`);
  // One click resumes the child: it spends requests then, and reports.
  script.length = 0;
  script.push(({ child }) => child && say('done after resume'));
  const a3 = await mk();
  await a3.snapshot(s2);
  const n1 = log.length;
  await a3.subagents.message(s2, 'longjob', 'continue');
  for (let i = 0; i < 40 && (await a3.subagents.list(s2))[0].status === 'running'; i++) await sleep(50);
  ok((await a3.subagents.list(s2))[0].status === 'finished' && log.length > n1, 'Resume (message) runs the child again');
  await sleep(300);
  await a3.close();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS', `requests: ${log.length}`);
process.exit(fails ? 1 : 0);
