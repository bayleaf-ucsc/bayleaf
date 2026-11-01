// Batch E, node: titles and compaction stay on the session's provider
// (agent.complete, naming.js suggestTitle, pi-durable compaction), for BayLeaf
// Sealed (a fake verified client whose encrypting fetch records every request),
// Localhost (the loopback dummy, test/dummy-openai.mjs) and Transformers.js (a
// fake engine). Asserts which provider received each request, and that a
// Localhost or Transformers.js session sends nothing to BayLeaf. Also: costNote
// wording, the terminal's output cap, and the shared per-path write queue.
// Run: node test/batchE-node.mjs
import assert from 'node:assert/strict';
import { startDummy } from './dummy-openai.mjs';
const { openAgent, MemoryStorage } = await import('../src/agent.ts');
const { suggestTitle, costNote, providerOf } = await import('../src/naming.ts');

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };

const sse = (text) => new Response(['data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'glm-5-3', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }),
  'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'glm-5-3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]', ''].join('\n\n'),
{ headers: { 'content-type': 'text/event-stream' } });
const sealed = [];
const client = {
  openAIOptions: { apiKey: 'k' },
  async getVerificationDocument() { return { securityVerified: true }; },
  secureClient: { fetch: async (u, init) => { const body = JSON.parse(init.body); sealed.push({ url: String(u), body }); return sse(body.tools?.length ? 'Sealed reply.' : 'Sealed Title'); } },
};
const engineCalls = [];
const engine = { async generate(req) { engineCalls.push(req); return { text: req.tools.length ? 'Browser reply.' : 'Browser Title', input_tokens: 10, output_tokens: 3 }; } };
const KEY = 'dummy-key-0123456789';
const dummy = await startDummy({ key: KEY, cors: ['*'] });
const gens = () => dummy.log.filter((e) => e.model);
let onRequests = 0;

const agent = await openAgent({
  storage: new MemoryStorage(), tools: [], systemPrompt: async () => 'Test agent.',
  getClient: async () => client, onRequest: () => { onRequests++; },
  models: [{ id: 'glm-5-3', contextWindow: 32_768 }],
  local: { info: { id: 'lfm3', label: 'LFM3' }, engine },
  localhost: { config: { base: dummy.url + '/v1', key: KEY, transport: 'completions', models: [{ id: 'dummy-small', contextWindow: 32_768 }] } },
});
const complete = (...a) => agent.complete(...a);
const text = 'User: plan a walking tour of Santa Cruz\nAssistant: Start at the wharf.';
try {
  // Titles: each model id reaches its own provider and only that one.
  const counts = () => ({ sealed: sealed.length, lh: gens().length, tjs: engineCalls.length });
  let c0 = counts();
  assert.equal(await suggestTitle(complete, 'glm-5-3', text), 'Sealed Title');
  assert.deepEqual(counts(), { ...c0, sealed: c0.sealed + 1 });
  assert.match(sealed.at(-1).url, /^https:\/\/api\.bayleaf\.dev\/sealed\/v1\//);
  assert.equal(sealed.at(-1).body.max_tokens ?? sealed.at(-1).body.max_completion_tokens, 400);
  assert.equal(onRequests, 0, 'a title is counted by its caller as a title, not as a turn');
  c0 = counts();
  const lhTitle = await suggestTitle(complete, 'localhost:dummy-small', text);
  assert.ok(lhTitle, 'a Localhost title came back');
  assert.deepEqual(counts(), { ...c0, lh: c0.lh + 1 });
  assert.equal(gens().at(-1).auth, 'good');
  c0 = counts();
  assert.equal(await suggestTitle(complete, 'local:lfm3', text), 'Browser Title');
  assert.deepEqual(counts(), { ...c0, tjs: c0.tjs + 1 });
  assert.equal(engineCalls.at(-1).maxNew, 24, 'Transformers.js titles stay short');
  assert.equal(engineCalls.at(-1).tools.length, 0);
  ok('titles: Sealed via the encrypting fetch (1 request, not counted as a turn), Localhost via the dummy, Transformers.js via the engine (24 new tokens); each reaches only its own provider');

  // No fallback: an unknown Localhost model fails and nothing is sent anywhere.
  c0 = counts();
  await assert.rejects(complete('localhost:gone', 'x'), /not available in this browser now; nothing was sent/);
  assert.deepEqual(counts(), c0);
  ok('an unavailable provider fails with nothing sent to any other provider');

  // Compaction: pi-durable summarizes on the conversation's own model.
  const long = (n) => `Turn ${n}: ` + 'bay leaves and walking routes '.repeat(600);
  for (const [model, key] of [['glm-5-3', 'sealed'], ['localhost:dummy-small', 'lh'], ['local:lfm3', 'tjs']]) {
    const id = await agent.createSession(model);
    for (let i = 0; i < (key === 'tjs' ? 6 : 2); i++) {
      await agent.send(id, long(i), [], undefined, model);
      for (let k = 0; k < 200 && (await agent.snapshot(id)).busy; k++) await new Promise((r) => setTimeout(r, 25));
    }
    const before = counts();
    await agent.compact(id);
    const after = counts();
    const grew = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
    assert.ok(grew[key] >= 1, `${model}: compaction went to its provider ${JSON.stringify(grew)}`);
    for (const k of Object.keys(grew)) if (k !== key) assert.equal(grew[k], 0, `${model}: nothing to ${k}`);
    console.log(`  compaction on ${model}: ${JSON.stringify(grew)}`);
  }
  ok('compaction runs on the session\'s provider for all three; zero BayLeaf requests for Localhost and Transformers.js');

  // Labels.
  assert.equal(costNote('glm-5-3'), '1 request from today\'s BayLeaf Sealed allowance');
  assert.equal(costNote('localhost:x'), 'runs on your machine (Localhost), no allowance');
  assert.equal(costNote('local:lfm3'), 'runs in this browser (Transformers.js), no allowance');
  assert.deepEqual(['glm-5-3', 'localhost:x', 'local:y'].map(providerOf), ['BayLeaf Sealed', 'Localhost', 'Transformers.js']);
  ok('costNote and providerOf word each provider');
} finally { await dummy.close?.(); }

// The terminal's pieces that need no page.
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { capOutput } = await import('../src/terminal.ts').catch(() => ({}));
if (capOutput) {
  const big = capOutput(Array.from({ length: 2500 }, (_, i) => 'line ' + i).join('\n'));
  assert.equal(big.text.split('\n').length, 2000); assert.match(big.note, /500 more lines not shown/);
  assert.equal(capOutput('short').note, '');
  ok('terminal output cap: 2000 lines with a note');
}
const { oneAtATime, serialized } = await import('../src/tools.ts');
const order = [];
let release; const gate = new Promise((r) => { release = r; });
const first = oneAtATime('/work/a.txt', async () => { await gate; order.push('agent edit'); });
const fake = { writeFile: async (p) => { order.push('terminal write ' + p); } };
const second = serialized(fake).writeFile('/work/a.txt', 'x');
await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(order, []);
release(); await Promise.all([first, second]);
assert.deepEqual(order, ['agent edit', 'terminal write /work/a.txt']);
ok('a terminal write waits for an agent edit of the same path (shared per-path queue)');

console.log(`\n${passed} passed`);
process.exit(0);
