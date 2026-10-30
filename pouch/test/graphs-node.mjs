// Node check of agent graphs (JOURNEYS G2-G7, G10, caps, scope) against the
// scripted fake in test/graph-fixture.js: no network, no real model requests.
// The browser journey is test/graphs-browser.mjs; this one is for routing.
// Run: node test/graphs-node.mjs
import { openAgent, MemoryStorage } from '../src/agent.js';
import { createScope, MAX_PAIR_MESSAGES, MAX_SCOPE_MESSAGES } from '../src/graph.js';
import { createFake, panelRules } from './graph-fixture.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
const until = async (f, ms = 5000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) return false; await sleep(25); } return true; };

// 0. graph.js alone: caps, cycles, join release, detach.
{
  const s = createScope();
  let refused = null;
  for (let i = 0; i <= MAX_PAIR_MESSAGES && !refused; i++) refused = s.admit(i % 2 ? 's2' : 's3', i % 2 ? 's3' : 's2');
  ok(/exchanged 8 messages/.test(refused ?? ''), `pair cap after ${MAX_PAIR_MESSAGES} in both directions`);
  s.newTurn();
  for (let i = 0; i < MAX_SCOPE_MESSAGES; i++) s.admit('s1', `s${2 + (i % 6)}`);
  ok(/sent 40 messages/.test(s.admit('s1', 's2') ?? ''), 'scope cap after 40');
  let q = false;
  const p1 = s.hold('s1', { ids: ['s3'], ready: () => q }), p2 = s.hold('s2', { ids: ['s3'], ready: () => q });
  ok(s.cycle('s3', ['s1'])?.join('>') === 's3>s1>s3' && s.cycle('s4', ['s1']) === null, 'cycle found through a hold, none otherwise');
  q = true; s.checkAll();
  ok((await p1).type === 'ready' && (await p2).type === 'ready', 'two joiners released by one check');
  const p = s.hold('s1', { ids: ['s2'], timeoutMs: 5000 });
  ok(s.held('s1').length === 1, 'held while joining');
  s.release('s1', { type: 'detached', note: 'x' });
  ok((await p).type === 'detached' && !s.held('s1').length, 'detach releases the join');
  ok((await s.hold('s1', { ids: ['s9'], timeoutMs: 50 })).type === 'timeout', 'timeout');
}

const fake = createFake();
const client = { getVerificationDocument: async () => ({ securityVerified: true }), secureClient: { fetch: fake.fetch }, openAIOptions: { apiKey: 'test' } };
const regs = new Map(), caps = [], turns = [];
const agent = await openAgent({
  storage: new MemoryStorage(), tools: [], systemPrompt: () => 'You are BayLeaf Pouch.',
  getClient: async () => client, models: [{ id: 'm', contextWindow: 131072 }],
  subagents: {
    reg: { get: async (sid) => regs.get(sid), set: async (sid, l) => (l ? regs.set(sid, l) : regs.delete(sid)) },
    onReport: (sid, sub) => turns.push(sub.wait()),
    onCap: (sid, e) => caps.push(e),
  },
});
const sid = await agent.createSession('m');

// 1. The panel (G2-G7).
panelRules(fake);
await agent.send(sid, 'Use the panel skill. review this draft');
await until(() => Promise.all(turns).then(() => true));
await until(async () => (await agent.subagents.list(sid)).every((c) => c.status !== 'running'), 8000);
await sleep(200);
const l = await agent.subagents.list(sid);
ok(l.map((c) => `${c.ref}:${c.name}`).join(' ') === 's2:chair s3:judge-argument s4:judge-evidence s5:judge-clarity s6:judge-audience', 'ids in spawn order: ' + l.map((c) => c.ref).join(','));
ok(/You are a subagent named "chair" \(id s2\)[\s\S]*"main" \(id s1\)/.test(fake.requests.chair[0].messages[0].content), 'child prompt names its id and its parent');
ok(fake.requests.chair[0].tools?.some((t) => t.function.name === 'agents') && !fake.requests.chair[0].tools.some((t) => t.function.name === 'subagent'), 'child is offered agents, not subagent');
ok(!fake.requests.main[0].tools.some((t) => t.function.name === 'agents'), 'main is not offered agents');
const chairSeen = fake.seen('chair');
ok(['argument', 'evidence', 'clarity', 'audience'].every((j, i) => chairSeen.includes(`[from judge-${j} (s${i + 3})] RAW-${j}`)), 'fan-in: every judge message reached the chair, sender-tagged');
ok(/- s1 main: the top-level agent[\s\S]*- s2 chair \(you\): running, parent s1[\s\S]*- s6 judge-audience/.test(chairSeen), 'list shows the scope with ids, states, parents');
ok(fake.seen('judge-evidence').includes('[from judge-argument (s3)] RAW-argument-peer') && fake.seen('judge-argument').includes('[from judge-evidence (s4)] RAW-evidence-peer'), 'G5: peer-to-peer exchange between s3 and s4');
ok(chairSeen.includes('[from judge-argument (s3)] RAW-argument-final') && chairSeen.includes('[from judge-evidence (s4)] RAW-evidence-final'), 'G5: both conclusions reached the chair');
const mainSeen = fake.seen('main');
ok(/Joined: chair \(s2\) quiet, fresh/.test(mainSeen), 'main joined the chair: fresh result');
ok(mainSeen.includes('[from chair (s2)] Prioritized review'), 'G7: the review reached main, tagged');
ok(!/RAW-/.test(mainSeen), 'G7: no judge raw output in any main request');
ok(/1\. Name the thesis/.test((await agent.snapshot(sid)).items.findLast((i) => i.type === 'assistant')?.text ?? ''), 'G8: main shows numbered suggestions');
const chair = l.find((c) => c.name === 'chair');
ok(chair.got?.s1 === 1 && chair.got?.s3 === 2 && chair.got?.s4 === 2 && chair.got?.s5 === 1 && chair.sent?.s1 === 1 && chair.sent?.s3 === 1, 'G9: per-edge counts on the rows: ' + JSON.stringify({ got: chair.got, sent: chair.sent }));
const v = await agent.snapshot(sid);
const reps = v.items.filter((i) => i.type === 'report');
ok(reps.every((r) => r.text === '') && reps.some((r) => r.name === 'judge-audience'), `judges: quiet reports without bodies (${reps.length})`);
ok(!reps.some((r) => r.name === 'chair'), 'chair (report: false, and joined by main) posted no report');
ok(v.items.some((i) => i.type === 'user' && i.from?.ref === 's2'), 'the chair message renders as a user item with a sender');
ok(!fake.unmatched.filter((u) => u.who === 'main').length, 'main had no unscripted requests: ' + JSON.stringify(fake.unmatched.filter((u) => u.who === 'main')));
if (process.env.DBG) for (const w of ['chair', 'judge-argument', 'judge-evidence']) fake.requests[w].forEach((b, i) => { const k = b.messages.findLastIndex((m) => m.role === 'assistant'); console.log(w, i + 1, JSON.stringify(b.messages.slice(k + 1).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 90)))); }); console.log("  requests:", Object.fromEntries(Object.entries(fake.requests).map(([k, b]) => [k, b.length])), 'unmatched:', fake.unmatched.length, 'pending:', fake.pending().join(', '));

// 2. Caps: a scripted ping-pong between two children stops at the pair cap, visibly.
fake.rules.length = 0;
fake.rule({ who: 'main', when: (c) => /ping/.test(c.since), reply: [['subagent', { action: 'message', to: 's3', text: 'Ping-pong with s4 until refused.' }]] });
fake.rule({ who: 'main', reply: 'ok' });
for (let i = 0; i < 12; i++) {
  fake.rule({ who: 'judge-argument', when: (c) => !/Not sent/.test(c.since), reply: [['agents', { action: 'message', to: 's4', text: 'ping ' + i }]] });
  fake.rule({ who: 'judge-evidence', when: (c) => !/Not sent/.test(c.since), reply: [['agents', { action: 'message', to: 's3', text: 'pong ' + i }]] });
}
fake.rule({ who: '*', when: (c) => /Not sent/.test(c.since), reply: 'Stopping: limit reached.' });
fake.rule({ who: '*', when: (c) => /Not sent/.test(c.since), reply: 'Stopping: limit reached.' });
await agent.send(sid, 'ping');
await until(() => caps.length > 0, 8000);
await until(async () => (await agent.subagents.list(sid)).every((c) => c.status !== 'running'), 8000);
ok(caps.length >= 1 && /exchanged 8 messages/.test(caps[0].text) && /judge-/.test(caps[0].from), 'pair cap hit, reported to onCap: ' + JSON.stringify(caps[0]));
const both = await agent.subagents.list(sid);
const pair = (both.find((c) => c.ref === 's3').sent?.s4 ?? 0) + (both.find((c) => c.ref === 's4').sent?.s3 ?? 0);
ok(pair === 1 + 1 + 6 || pair >= 6, `pair exchanged ${pair} messages in all (8 per turn, including the panel turn's 2? no: caps reset per user turn)`);
ok(/Not sent/.test(fake.seen('judge-argument') + fake.seen('judge-evidence')), 'the refused sender read a clear tool error');

// 3. Detach (G10): main blocked in a wait on a busy child; the user writes.
fake.rules.length = 0; caps.length = 0;
fake.rule({ who: 'main', when: (c) => /slow job/.test(c.since), reply: [['subagent', { action: 'spawn', name: 'slow', task: 'A slow job.' }]] });
fake.rule({ who: 'main', when: (c) => /Started subagent "slow" \(id s7\)/.test(c.since), reply: [['subagent', { action: 'join', ids: ['s7'] }]] });
fake.rule({ who: 'main', when: (c) => /detached: slow \(s7\) continues/.test(c.since) && /what about lunch/.test(c.since), reply: 'Lunch: soup. slow keeps working.' });
fake.rule({ who: 'slow', gate: 'slow', reply: 'SLOW-DONE: the slow result.' });
fake.rule({ who: 'main', when: (c) => /SLOW-DONE/.test(c.since), reply: 'slow finished: the slow result.' });
const turn = agent.send(sid, 'slow job please');
await until(() => agent.subagents.blocked(sid).length === 1);
ok(agent.subagents.blocked(sid)[0].kind === 'join' && agent.subagents.blocked(sid)[0].ids[0] === 's7', 'main is blocked in a join on s7');
const t0 = Date.now();
await agent.subagents.detach(sid, 'what about lunch?');
await turn;
ok(Date.now() - t0 < 2000, `join detached at once (${Date.now() - t0} ms)`);
let mv = await agent.snapshot(sid);
ok(/Lunch: soup/.test(mv.items.findLast((i) => i.type === 'assistant')?.text ?? ''), 'the user message reached main\'s next step');
ok(mv.items.some((i) => i.type === 'user' && i.text === 'what about lunch?'), 'the user message is in main\'s transcript');
ok((await agent.subagents.list(sid)).find((c) => c.ref === 's7').status === 'running', 'detaching never stops the subagent');
turns.length = 0;
fake.gates.slow = true;
await until(() => turns.length > 0);
await Promise.all(turns);
mv = await agent.snapshot(sid);
ok(mv.items.some((i) => i.type === 'report' && i.name === 'slow' && /SLOW-DONE/.test(i.text)) && /slow finished/.test(mv.items.findLast((i) => i.type === 'assistant')?.text ?? ''), 'its report arrived later as a message and started a turn (nothing lost)');

// 3b. Detach a foreground spawn (G10) and Background (G12, no text).
fake.rules.length = 0;
fake.rule({ who: 'main', when: (c) => /fg job/.test(c.since), reply: [['subagent', { action: 'spawn', name: 'fg', task: 'A foreground job.', background: false }]] });
fake.rule({ who: 'main', when: (c) => /detached: fg \(s8\) continues in the background; the user sent it to the background/.test(c.since), reply: 'OK, fg runs in the background.' });
fake.rule({ who: 'fg', gate: 'fg', reply: 'FG-DONE.' });
fake.rule({ who: 'main', when: (c) => /FG-DONE/.test(c.since), reply: 'fg reported.' });
const turn2 = agent.send(sid, 'fg job');
await until(() => agent.subagents.blocked(sid).length === 1);
ok(agent.subagents.blocked(sid)[0].kind === 'spawn', 'main blocked on a foreground spawn');
await agent.subagents.detach(sid);
await turn2;
ok(/fg runs in the background/.test((await agent.snapshot(sid)).items.findLast((i) => i.type === 'assistant')?.text ?? ''), 'Background: the spawn returned with "the user sent it to the background"');
turns.length = 0;
fake.gates.fg = true;
await until(() => turns.length > 0);
await Promise.all(turns);
ok(/fg reported/.test((await agent.snapshot(sid)).items.findLast((i) => i.type === 'assistant')?.text ?? ''), 'the detached foreground child reported later');

// 5. join semantics.
const lastTool = async () => (await agent.snapshot(sid)).items.findLast((i) => i.type === 'tool');
const joinOut = (t) => JSON.parse(t.output.slice(t.output.indexOf('\n') + 1));
fake.rules.length = 0;
// 5a. Cached: a quiet target returns at once with its age, and is not woken.
fake.rule({ who: 'main', when: (c) => /join clarity/.test(c.since), reply: [['subagent', { action: 'join', ids: ['judge-clarity'] }]] });
fake.rule({ who: 'main', when: (c) => /Joined:/.test(c.since), reply: 'ok' });
let nClar = fake.requests['judge-clarity'].length;
await sleep(1100);
await agent.send(sid, 'join clarity');
let j = joinOut(await lastTool())[0];
ok(j.cached === true && j.state === 'quiet' && j.blocked_ms === 0 && j.age_s >= 1 && j.quiet_since && /Sent my findings/.test(j.last), 'cached join: quiet, at once, with quiet_since and age: ' + JSON.stringify({ ...j, last: j.last.slice(0, 30) }));
ok(fake.requests['judge-clarity'].length === nClar, 'join never wakes a thread');
// 5b. Message then join: a result newer than the message, never the stale one.
fake.rule({ who: 'main', when: (c) => /ask clarity again/.test(c.since), reply: [['subagent', { action: 'message', to: 'judge-clarity', text: 'one more pass' }]] });
fake.rule({ who: 'main', when: (c) => /woke it/.test(c.since), reply: [['subagent', { action: 'join', ids: ['s5'] }]] });
fake.rule({ who: 'judge-clarity', gate: 'clar', reply: 'CLARITY-SECOND-PASS.' });
fake.rule({ who: 'main', when: (c) => /Joined:/.test(c.since), reply: 'ok' });
const turn5 = agent.send(sid, 'ask clarity again');
await sleep(300);
fake.gates.clar = true;
await turn5;
j = joinOut(await lastTool())[0];
ok(j.fresh === true && j.last === 'CLARITY-SECOND-PASS.' && j.blocked_ms >= 200, `message-then-join: fresh result newer than the message (blocked ${j.blocked_ms} ms)`);
// 5c. Two joiners (main and a watcher subagent) released together with the same message;
//     5f no duplicate: main joined, so no separate report for the target.
fake.rule({ who: 'main', when: (c) => /two joiners/.test(c.since), reply: [['subagent', { action: 'spawn', name: 'target', task: 'Produce TARGET-DONE.' }], ['subagent', { action: 'spawn', name: 'watcher', task: 'Join target.', report: false }]] });
fake.rule({ who: 'main', when: (c) => /Started subagent "watcher"/.test(c.since), reply: [['subagent', { action: 'join', ids: ['target'] }]] });
fake.rule({ who: 'watcher', reply: [['agents', { action: 'join', ids: ['target'] }]] });
fake.rule({ who: 'watcher', when: (c) => /Joined:/.test(c.since), reply: 'watched.' });
fake.rule({ who: 'target', gate: 'target', reply: 'TARGET-DONE.' });
fake.rule({ who: 'main', when: (c) => /Joined:/.test(c.since), reply: 'both joined.' });
turns.length = 0;
const turn6 = agent.send(sid, 'two joiners');
await until(async () => agent.subagents.blocked(sid).length === 1 && fake.requests.watcher?.length === 1);
await sleep(300);
fake.gates.target = true;
await turn6;
await until(() => fake.requests.watcher.length >= 2);
const jm = joinOut(await lastTool())[0];
const wv = fake.requests.watcher[1].messages.at(-1);
const jw = JSON.parse(wv.content.slice(wv.content.indexOf('\n') + 1))[0];
ok(jm.fresh && jw.fresh && jm.last === 'TARGET-DONE.' && jw.last === jm.last && jm.blocked_ms > 0 && jw.blocked_ms > 0 , `two joiners released together, same message, own blocked_ms (${jm.blocked_ms}, ${jw.blocked_ms})`);
await sleep(300);
const v6 = await agent.snapshot(sid);
ok(!v6.items.some((i) => i.type === 'report' && i.name === 'target') && (fake.seen('main').match(/TARGET-DONE/g) ?? []).length >= 1 && !turns.length, 'no duplicate: the joined target\'s answer came as the join result only (no report, no extra turn)');
// 5d. Timeout: timed_out with the state so far; the target keeps running.
fake.rule({ who: 'main', when: (c) => /timeout test/.test(c.since), reply: [['subagent', { action: 'spawn', name: 'sleeper', task: 'Sleep.' }]] });
fake.rule({ who: 'main', when: (c) => /Started subagent "sleeper"/.test(c.since), reply: [['subagent', { action: 'join', ids: ['sleeper'], timeout: 1 }]] });
fake.rule({ who: 'sleeper', gate: 'sleeper', reply: 'SLEEPER-DONE.' });
fake.rule({ who: 'main', when: (c) => /timed out/.test(c.since), reply: 'it is still going.' });
await agent.send(sid, 'timeout test');
j = joinOut(await lastTool())[0];
ok(j.timed_out === true && j.state === 'running' && 'last' in j, 'timeout: timed_out, state running, last so far');
ok((await agent.subagents.list(sid)).find((c) => c.name === 'sleeper').status === 'running', 'timeout: the target keeps running');
// 5e. Cycle: x joins y, then y joins x: refused, naming the cycle.
fake.rule({ who: 'main', when: (c) => /cycle test/.test(c.since), reply: [['subagent', { action: 'spawn', name: 'cyc-x', task: 'Join cyc-y.' }], ['subagent', { action: 'spawn', name: 'cyc-y', task: 'Join cyc-x.' }]] });
fake.rule({ who: 'main', when: (c) => /Started subagent "cyc-y"/.test(c.since), reply: 'started.' });
fake.rule({ who: 'cyc-x', reply: [['agents', { action: 'join', ids: ['cyc-y'] }]] });
fake.rule({ who: 'cyc-x', when: (c) => /Joined:/.test(c.since), reply: 'x done.' });
fake.rule({ who: 'cyc-y', gate: 'cyc', reply: [['agents', { action: 'join', ids: ['cyc-x'] }]] });
fake.rule({ who: 'cyc-y', when: (c) => /Refused/.test(c.since), reply: 'y done.' });
fake.gates.sleeper = true;
await until(async () => (await agent.subagents.list(sid)).find((c) => c.name === 'sleeper').status !== 'running');
await agent.send(sid, 'cycle test');
await until(() => fake.requests['cyc-x']?.length >= 1);
await sleep(200);
fake.gates.cyc = true;
await until(() => fake.requests['cyc-y']?.length >= 2 && fake.requests['cyc-x']?.length >= 2);
const yErr = fake.requests['cyc-y'][1].messages.at(-1).content;
ok(/Refused: joining would close a cycle of blocked sessions \(cyc-y \(s\d+\) -> cyc-x \(s\d+\) -> cyc-y/.test(yErr), 'cycle refused, naming it: ' + yErr.slice(0, 120));
ok(/Joined: cyc-y/.test(fake.requests['cyc-x'][1].messages.at(-1).content), 'the first joiner was released when the other went quiet');
await until(async () => (await agent.subagents.list(sid)).every((c) => c.status !== 'running'));

// 4. Wake a finished child by message; cross-scope refusal.
fake.rules.length = 0;
fake.rule({ who: 'judge-clarity', when: (c) => /\[from main \(s1\)\] one more/.test(c.since), reply: 'CLARITY-AGAIN.' });
const before = fake.requests['judge-clarity'].length;
fake.rule({ who: 'main', when: (c) => /wake clarity/.test(c.since), reply: [['subagent', { action: 'message', to: 's5', text: 'one more thing' }]] });
fake.rule({ who: 'judge-clarity', when: (c) => /one more thing/.test(c.since), reply: 'CLARITY-AGAIN.' });
fake.rule({ who: 'main', when: (c) => /woke it/.test(c.since), reply: 'Woke it.' });
await agent.send(sid, 'wake clarity');
const out = (await agent.snapshot(sid)).items.findLast((i) => i.type === 'tool')?.output ?? '';
ok(/judge-clarity \(s5\) had finished; this message woke it/.test(out), 'message to a finished child wakes it: ' + out);
await until(async () => (await agent.subagents.list(sid)).find((c) => c.ref === 's5').status === 'finished' && fake.requests['judge-clarity'].length > before);
ok(fake.requests['judge-clarity'].length === before + 1, 'the wake cost exactly one step');
const sid2 = await agent.createSession('m');
fake.rule({ who: 'main', when: (c) => /other scope/.test(c.since), reply: [['subagent', { action: 'message', to: 's2', text: 'hello' }]] });
fake.rule({ who: 'main', reply: 'ok' });
await agent.send(sid2, 'other scope: message s2');
const t = (await agent.snapshot(sid2)).items.findLast((i) => i.type === 'tool');
ok(t?.status === 'error' && /No session "s2" in this scope[\s\S]*never leave this scope/.test(t.output), 'cross-scope: s2 of another session is unknown here: ' + t?.output.slice(0, 80));
const t2 = await agent.subagents.message(sid2, chair.id, 'x').catch((e) => e.message);
ok(/No (session|subagent)/.test(t2), 'cross-scope: another scope\'s conversation id is refused too');

await agent.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
