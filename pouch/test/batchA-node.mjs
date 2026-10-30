// Node check of batch A (play-test fixes) against the scripted fake in
// test/graph-fixture.js: one-shot subagents (one request, no tools, attached
// files, routed replies), join naming where a quiet child sent its work,
// scratch notes in /tmp when /work is read-only, and Stop aborting a request
// in flight. No network, no real model requests.
// Run: node test/batchA-node.mjs
import { openAgent, MemoryStorage } from '../src/agent.js';
import { scratchOf, SUBAGENT_DIR, MAX_FILE_CHARS } from '../src/subagents.js';
import { createFake } from './graph-fixture.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
const until = async (f, ms = 5000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) return false; await sleep(25); } return true; };

// Fix 4: where notes go.
ok(scratchOf(undefined) === SUBAGENT_DIR && scratchOf(['/work']) === SUBAGENT_DIR && scratchOf(['/work/.subagents']) === SUBAGENT_DIR, 'scratch: /work/.subagents when /work is writable');
ok(scratchOf(['/work/essay.md:ro']) === '/tmp' && scratchOf(['/work:ro', '/pouch:ro']) === '/tmp' && scratchOf(['/work/data']) === '/tmp', 'scratch: /tmp when /work is read-only or narrowed');

const ESSAY = '# Walkable towns\n\nTowns should be walkable.\n\nWalking cuts car trips by 40%.\n\nSo plan for feet.\n';
const files = { '/work/essay.md': ESSAY, '/work/big.md': 'x'.repeat(MAX_FILE_CHARS + 1) };
const fake = createFake();
const client = { getVerificationDocument: async () => ({ securityVerified: true }), secureClient: { fetch: fake.fetch }, openAIOptions: { apiKey: 'test' } };
const regs = new Map(), turns = [];
const agent = await openAgent({
  storage: new MemoryStorage(), tools: [], systemPrompt: () => 'You are BayLeaf Pouch, a coding agent.',
  getClient: async () => client, models: [{ id: 'm', contextWindow: 131072 }],
  subagents: {
    reg: { get: async (sid) => regs.get(sid), set: async (sid, l) => (l ? regs.set(sid, l) : regs.delete(sid)) },
    onReport: (sid, sub) => turns.push(sub.wait()),
    readFile: async (f) => { const path = f.startsWith('/') ? f : '/work/' + f; if (!(path in files)) throw new Error(`files: ${path} could not be read (it does not exist).`); return { path, text: files[path] }; },
  },
});
const settle = async (sid) => {
  await until(() => Promise.all(turns).then(() => true));
  await until(async () => (await agent.subagents.list(sid)).every((c) => c.status !== 'running'), 8000);
  await sleep(150);
};

// Fix 1: the one-shot panel the skill describes. Main spawns four one-shot
// judges in one step (foreground, so they run in parallel and return
// together), then one one-shot chair given their findings, then answers.
const JUDGES = ['argument', 'evidence', 'clarity', 'audience'];
{
  const sid = await agent.createSession('m');
  fake.rule({ who: 'main', when: (c) => /panel/.test(c.since), reply: JUDGES.map((j) => ['subagent', { action: 'spawn', mode: 'oneshot', background: false, name: `judge-${j}`, task: `Judge only the ${j} of the attached draft. At most 5 points.`, files: ['/work/essay.md'] }]) });
  for (const j of JUDGES) fake.rule({ who: `judge-${j}`, reply: `FINDING-${j}: ${j === 'evidence' ? 'the 40% claim needs a source' : 'fine'}.` });
  fake.rule({ who: 'main', when: (c) => (c.since.match(/FINDING-/g) ?? []).length === 4, reply: [['subagent', { action: 'spawn', mode: 'oneshot', background: false, name: 'chair', task: 'Chair: merge these findings into at most 5 numbered suggestions.\n' + JUDGES.map((j) => `judge-${j}: ...`).join('\n') }]] });
  fake.rule({ who: 'chair', reply: 'REVIEW: 1. Cite a source for the 40% claim.' });
  fake.rule({ who: 'main', when: (c) => /REVIEW:/.test(c.since), reply: 'The panel suggests:\n1. Cite a source for the 40% claim.' });
  const before = fake.total();
  await agent.send(sid, 'Use the panel skill. review this draft');
  await settle(sid);
  const used = fake.total() - before;
  ok(used === 8, `one-shot panel: ${used} requests (main 3, judges 4, chair 1), was 41 in the play-test`);
  const j0 = fake.requests['judge-argument']?.[0];
  ok(j0 && !(j0.tools?.length), 'a one-shot is offered no tools');
  ok(j0 && !/coding agent/.test(JSON.stringify(j0.messages[0])) && /one-shot/.test(j0.messages[0].content), 'a one-shot gets its own short prompt, not the Pouch prompt');
  ok(j0 && JSON.stringify(j0.messages).includes('<file path=\\"/work/essay.md\\">') && JSON.stringify(j0.messages).includes('Walking cuts car trips'), 'the attached file is in its one request');
  const l = await agent.subagents.list(sid);
  ok(l.length === 5 && l.every((c) => c.oneshot && c.status === 'finished' && c.requests === 1), 'five one-shots, each finished after one request: ' + l.map((c) => `${c.name}:${c.status}:${c.requests}`).join(' '));
  ok(/FINDING-evidence/.test(fake.seen('main')), 'foreground one-shot replies reach main as spawn results');
}

// Fix 1: routed one-shots (to: a full collector), refusal of messages, the file cap.
{
  const sid = await agent.createSession('m');
  fake.rule({ who: 'main', when: (c) => /route/.test(c.since), reply: [['subagent', { action: 'spawn', name: 'collector', task: 'Collect findings; reply when you have two.', report: false }]] });
  fake.rule({ who: 'collector', reply: 'Waiting.' });
  fake.rule({ who: 'main', when: (c) => /Started subagent "collector" \(id s2\)/.test(c.since), reply: [
    ['subagent', { action: 'spawn', mode: 'oneshot', name: 'j-a', task: 'Judge A.', files: ['essay.md'], to: 's2' }],
    ['subagent', { action: 'spawn', mode: 'oneshot', name: 'j-b', task: 'Judge B.', files: ['/work/big.md'] }],
    ['subagent', { action: 'spawn', mode: 'oneshot', name: 'j-c', task: 'Judge C.', files: ['/work/nope.md'] }],
  ] });
  fake.rule({ who: 'j-a', reply: 'ROUTED-A: thesis is clear.' });
  fake.rule({ who: 'collector', when: (c) => /\[from j-a \(s3\)\] ROUTED-A/.test(c.since), reply: 'Got A.' });
  fake.rule({ who: 'main', when: (c) => /Started one-shot "j-a"/.test(c.since), reply: [['subagent', { action: 'message', to: 's3', text: 'one more thing' }]] });
  fake.rule({ who: 'main', when: (c) => /is a one-shot: it makes one request and takes no messages/.test(c.since), reply: 'ok.' });
  await agent.send(sid, 'route test');
  await settle(sid);
  const seen = fake.seen('main');
  ok(/Started one-shot "j-a" \(id s3\)[^]*goes to collector \(s2\)/.test(seen), 'a routed one-shot says where its reply goes');
  ok(/big\.md is 48,001 characters, over the 48,000 limit/.test(seen) && /nope\.md could not be read \(it does not exist\)/.test(seen), 'oversized and missing files fail with a clear error, no request spent');
  ok(!fake.requests['j-b'] && !fake.requests['j-c'], 'no request for a one-shot whose files failed');
  ok(/\[from j-a \(s3\)\] ROUTED-A/.test(fake.seen('collector')), 'the harness forwarded the one-shot reply to s2, tagged as from it');
  ok(!/ROUTED-A/.test(seen), 'a routed reply never entered main\'s context');
  ok(/s3\) is a one-shot: it makes one request and takes no messages/.test(seen), 'messaging a one-shot is refused');
  ok((fake.requests['j-a'] ?? []).length === 1, 'the one-shot made exactly one request');

  // Fix 2: joining j-a (quiet, its reply went by message) names where it went.
  fake.rule({ who: 'main', when: (c) => /join a/.test(c.since), reply: [['subagent', { action: 'join', ids: ['s3'] }]] });
  fake.rule({ who: 'main', when: (c) => /Joined:/.test(c.since), reply: 'joined.' });
  await agent.send(sid, 'join a');
  await settle(sid);
  const jr = fake.requests.main.at(-1).messages.at(-1).content;
  ok(/j-a \(s3\) quiet, cached \d+s, sent its findings to collector \(s2\)/.test(JSON.stringify(jr)) && /"sent_preview":"ROUTED-A/.test(JSON.stringify(jr).replaceAll('\\"', '"')), 'join of a child that sent its findings by message names the recipient and a preview');
}

// Fix 6: Stop aborts a request in flight, for main and for subagents.
{
  const sid = await agent.createSession('m');
  fake.rule({ who: 'main', when: (c) => /slow/.test(c.since), reply: [['subagent', { action: 'spawn', name: 'worker', task: 'Work slowly.' }]] });
  fake.rule({ who: 'worker', gate: 'never', reply: 'never sent' });
  fake.rule({ who: 'main', when: (c) => /Started subagent "worker"/.test(c.since), gate: 'never', reply: 'never sent' });
  const a0 = fake.aborted.length;
  const sending = agent.send(sid, 'slow job').catch(() => {});
  await until(() => (fake.requests.worker?.length ?? 0) >= 1 && fake.pending().filter((p) => /gate never/.test(p)).length === 0, 4000);
  const n0 = fake.total();
  await agent.abort(sid);
  await agent.subagents.stopAll(sid);
  await sending;
  await sleep(600);
  const ab = fake.aborted.slice(a0).map((a) => a.who).sort();
  ok(ab.includes('main') && ab.includes('worker'), 'Stop aborted the in-flight requests of main and the subagent: ' + ab.join(','));
  ok(fake.total() === n0, `no new request after Stop (${fake.total() - n0} more)`);
  const w = (await agent.subagents.list(sid)).find((c) => c.name === 'worker');
  ok(w?.status === 'stopped', 'the subagent is stopped: ' + w?.status);
}

agent.close?.();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
