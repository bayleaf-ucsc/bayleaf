// One live run of the panel journey (JOURNEYS G1-G7) against BayLeaf Sealed,
// to learn whether a real model follows the graph protocol.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/graphs-sealed.mjs [model]
// Spends real requests: hard stop at CAP. Tools: a read-only `read` over the
// essay and the bundled panel skill, plus Pouch's subagent/agents tools.
// Prints an outline only (who called what, sender tags, sizes), not content.
import assert from 'node:assert/strict';
const { TinfoilAI } = await import('tinfoil');
const { openAgent, MemoryStorage, Type } = await import('../src/agent.js');
const { GRAPH_GLOSS } = await import('../src/subagents.js');
const defaults = (await import('../src/defaults.js')).default;

const CAP = Number(process.env.CAP ?? 32), MODEL = process.argv[2] ?? 'glm-5-3';
const ESSAY = `# Walkable towns

Cities have spent a century designing for cars, and the results are in. In this
essay I look at several things about streets, parking and how people move.

Walking cuts car trips by 40% in towns that try it. Shops on walkable streets
earn more, and residents are healthier. Everyone agrees on this.

Consider a second example: parking minimums. A parking minimum is a rule that
each building must provide a set number of parking spaces, which leverages
negative externalities into the built form via induced demand dynamics.

My point is that towns should be walkable, and the way to get there is to
remove parking minimums, widen sidewalks, and let mixed uses back in.

So plan for feet.
`;
const files = { '/work/essay.md': ESSAY, '/pouch/skills/panel/SKILL.md': defaults['/skills/panel/SKILL.md'] };

const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const client = new TinfoilAI({ bearerToken: key, baseURL: 'https://api.bayleaf.dev/sealed/v1/', attestationBundleURL: 'https://api.bayleaf.dev/sealed', userCacheSecret: 'pouch-graphs' });
await client.ready();
assert.equal((await client.getVerificationDocument()).securityVerified, true);
const real = client.secureClient.fetch.bind(client.secureClient);
const counted = { getVerificationDocument: () => client.getVerificationDocument(), get openAIOptions() { return client.openAIOptions; }, secureClient: { fetch: null } };
const calls = [];
let agent, sid, stopped = false;
counted.secureClient.fetch = async (u, init) => {
  const b = JSON.parse(init.body);
  const sys = typeof b.messages[0]?.content === 'string' ? b.messages[0].content : JSON.stringify(b.messages[0]?.content);
  const who = /You are a subagent named "([^"]+)"/.exec(sys)?.[1] ?? 'main';
  calls.push({ who, t: Date.now() });
  if (calls.length > CAP) {
    if (!stopped) { stopped = true; console.log(`ABORT: request cap ${CAP} reached`); setTimeout(() => stopEverything(), 0); }
    throw new Error('request cap reached');
  }
  return real(u, init);
};
async function stopEverything() {
  for (const c of await agent.subagents.list(sid)) if (c.status === 'running') await agent.subagents.stop(sid, c.id).catch(() => {});
  await agent.abort(sid).catch(() => {});
}

const read = { name: 'read', label: 'Read', description: 'Read a file by absolute path.', parameters: Type.Object({ path: Type.String() }),
  execute: async ({ path }) => { if (!(path in files)) throw new Error(`ENOENT: ${path}`); return files[path]; } };
const prompt = `You are BayLeaf Pouch, a coding agent running inside the user's web browser. You work on files with the read tool (read-only in this run).
The subagent tool runs a self-contained task in a background subagent while you keep talking with the user. Each subagent step costs a request from the same daily allowance; its report arrives later as a message, so do not poll for it.
${GRAPH_GLOSS} You are main (s1); only you spawn and stop subagents.
Be concise.

<skills>
Read a skill's SKILL.md before acting on a task it covers.
- panel: ${/description: (.*)/.exec(files['/pouch/skills/panel/SKILL.md'])[1]} (/pouch/skills/panel/SKILL.md)
</skills>`;

agent = await openAgent({
  storage: new MemoryStorage(), tools: [read], systemPrompt: () => prompt,
  getClient: async () => counted, models: [{ id: MODEL, contextWindow: 131072, reasoning: true }],
  subagents: { reg: (() => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, l) => (l ? m.set(k, l) : m.delete(k)) }; })(),
    onReport: () => {}, onCap: (s, e) => console.log('CAP', e.from, '->', e.to) },
});
sid = await agent.createSession(MODEL);
const t0 = Date.now();
const deadline = setTimeout(() => { console.log('ABORT: 8 minute deadline'); stopEverything(); }, 8 * 60_000);
await agent.send(sid, 'Use the panel skill. Review this draft: /work/essay.md').catch((e) => console.log('main turn:', e.message));
// Later turns (a message or report to an idle main) start by themselves; wait for quiet.
const quiet = async () => (await agent.subagents.list(sid)).every((c) => c.status !== 'running') && !(await agent.snapshot(sid)).busy;
for (let i = 0; i < 480 && !(await quiet()); i++) await new Promise((r) => setTimeout(r, 1000));
clearTimeout(deadline);

const outline = (items) => items.map((x) => {
  if (x.type === 'user') return x.from ? `  << [from ${x.from.name} (${x.from.ref})] ${x.text.length}ch` : x.steer ? '  << user steer' : `  << user/task ${x.text.length}ch`;
  if (x.type === 'tool') return `  -- ${x.name} ${JSON.stringify({ action: x.args?.action, to: x.args?.to, ids: x.args?.ids, name: x.args?.name, path: x.args?.path })}${x.status === 'error' ? ' ERROR: ' + x.output.slice(0, 160) : ''}`;
  if (x.type === 'assistant') return x.text ? `  >> reply ${x.text.length}ch${x.error ? ' ERROR ' + x.error : ''}` : null;
  if (x.type === 'report') return `  << report ${x.name} (${x.ref}) ${x.status}${x.byMessage != null ? ' by message' : ''} ${x.text.length}ch`;
  return `  .. ${x.type}`;
}).filter(Boolean).join('\n');
const l = await agent.subagents.list(sid);
const mv = await agent.snapshot(sid);
console.log(`\n== main (s1)\n${outline(mv.items)}`);
for (const c of l) {
  let v; const d = await agent.subagents.watch(sid, c.id, (x) => { v = x; }); d();
  console.log(`\n== ${c.name} (${c.ref}) ${c.status} sent ${JSON.stringify(c.sent ?? {})} got ${JSON.stringify(c.got ?? {})}\n${outline(v?.items ?? [])}`);
}
const per = {}; for (const c of calls) per[c.who] = (per[c.who] ?? 0) + 1;
console.log(`\nrequests ${calls.length} ${JSON.stringify(per)}; ${Math.round((Date.now() - t0) / 1000)}s; final main reply:\n${mv.items.findLast((i) => i.type === 'assistant' && i.text)?.text ?? '(none)'}`);
await agent.close();
process.exit(0);
