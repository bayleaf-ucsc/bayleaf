// Live smoke test of src/agent.js against the BayLeaf Sealed lane.
//   set -a; source ~/.tokens/bayleaf-api; set +a; node test/agent-smoke.mjs
// Checks: streaming, tool round trip, abort, session independence, manual
// compaction, and that no request body reaches the network as plaintext.
import assert from 'node:assert/strict';

// Wiretap below the Tinfoil SDK: whatever reaches the real fetch is what the
// network (and BayLeaf's relay) sees.
const wire = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const bytes = new Uint8Array(await req.clone().arrayBuffer());
  let plaintext = false;
  try { JSON.parse(new TextDecoder().decode(bytes)); plaintext = bytes.length > 0; } catch {}
  wire.push({ method: req.method, path: new URL(req.url).pathname, headers: [...req.headers.keys()], bytes: bytes.length, plaintext });
  return realFetch(req);
};

const { TinfoilAI } = await import('tinfoil');
const { openAgent, MemoryStorage, Type } = await import('../src/agent.js');

const key = process.env.BAYLEAF_API_KEY;
assert.ok(key, 'BAYLEAF_API_KEY not set');
const client = new TinfoilAI({ bearerToken: key, baseURL: 'https://api.bayleaf.dev/sealed/v1/', attestationBundleURL: 'https://api.bayleaf.dev/sealed', userCacheSecret: 'pouch-smoke' });
await client.ready();
assert.equal((await client.getVerificationDocument()).securityVerified, true);
let signedIn = true;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});
const tools = [
  { name: 'echo', label: 'Echo', description: 'Echo the given text back verbatim.', parameters: Type.Object({ text: Type.String() }),
    execute: async ({ text }) => text },
  { name: 'bash', label: 'Bash', description: 'Run a shell command. (Fake: "sleep N" sleeps, "big" prints a large file, anything else prints a line per word.)',
    parameters: Type.Object({ command: Type.String() }),
    execute: async ({ command }, { signal, output }) => {
      const m = /^sleep (\d+)/.exec(command);
      if (m) { output('sleeping…\n'); await sleep(Number(m[1]) * 1000, signal); return 'slept'; }
      if (command === 'big') return Array.from({ length: 700 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join('\n');
      let out = '';
      for (const w of command.split(/\s+/)) { out += `${w}\n`; output(`${w}\n`); await sleep(50, signal); }
      return out;
    } },
];

// A deliberately small window for glm-5-3 so manual compaction has something
// older than keepRecentTokens to summarize in a short test.
const agent = await openAgent({
  storage: new MemoryStorage(), tools,
  systemPrompt: async () => 'You are a terse test agent. Use tools exactly when asked.',
  getClient: async () => (signedIn ? client : null),
  models: [{ id: 'glm-5-3', contextWindow: 32_768, reasoning: true }],
});

// Compact rendering of a normalized view for the log.
const brief = (v) => `${v.busy ? 'BUSY' : 'idle'} ` + v.items.map((i) => {
  const t = (s, n = 40) => JSON.stringify(String(s ?? '').slice(0, n));
  if (i.type === 'user') return `U${t(i.text, 25)}`;
  if (i.type === 'assistant') return `A${i.streaming ? '~' : ''}${t(i.text)}${i.thinking ? `(think ${i.thinking.length})` : ''}${i.error ? `!${i.error}` : ''}`;
  if (i.type === 'tool') return `T:${i.name}${t(typeof i.args === 'string' ? i.args : JSON.stringify(i.args), 30)}[${i.status}]${t(i.output, 20)}`;
  if (i.type === 'compaction') return `C${t(i.summary, 50)}`;
  return `N${t(i.text)}`;
}).join(' | ') + (v.usage ? ` (${v.usage.input}/${v.usage.output} tok)` : '');

const views = { a: [], b: [] };
const a = await agent.createSession('glm-5-3');
const b = await agent.createSession('glm-5-3');
const stopA = await agent.watch(a, (v) => views.a.push(v));
const stopB = await agent.watch(b, (v) => views.b.push(v));
const last = (k) => views[k].at(-1);
const log = (label, k) => {
  const seen = new Set(), lines = views[k].map(brief).filter((l) => !seen.has(l) && seen.add(l));
  console.log(`\n== ${label} (${views[k].length} views, ${lines.length} distinct; showing up to 8)`);
  for (const l of lines.length > 8 ? [...lines.slice(0, 4), '…', ...lines.slice(-4)] : lines) console.log('  ' + l.slice(0, 300));
  views[k].length = 0;
};

// 1. Streamed answer.
await agent.send(a, 'Write two short sentences about bay leaves.');
assert.ok(views.a.some((v) => v.items.some((i) => i.type === 'assistant' && i.streaming && i.text)), 'no streamed partial seen');
assert.ok(last('a').items.at(-1).type === 'assistant' && !last('a').busy);
log('A: streamed answer', 'a');

// 2. Tool round trip, with live streamed output.
await agent.send(a, 'Use the echo tool with text "pouch". Then use the bash tool with command "alpha beta gamma". Then reply "ok".');
const toolsA = last('a').items.filter((i) => i.type === 'tool');
assert.deepEqual(toolsA.map((t) => [t.name, t.status]), [['echo', 'done'], ['bash', 'done']]);
assert.equal(toolsA[0].output, 'pouch');
assert.ok(views.a.some((v) => v.items.some((i) => i.type === 'tool' && i.name === 'bash' && i.status === 'running' && i.output)), 'no live tool output seen');
log('A: tool round trip', 'a');

// 3. Abort in session B while a tool runs; A is untouched.
const pending = agent.send(b, 'Use the bash tool with command "sleep 60", then say done.');
const started = Date.now();
while (!last('b')?.items.some((i) => i.type === 'tool' && i.status === 'running')) {
  assert.ok(Date.now() - started < 60_000, 'tool never started'); await sleep(100);
}
await agent.abort(b);
const aborted = await pending.then(() => 'resolved', (e) => `rejected: ${e.message}`);
assert.ok(Date.now() - started < 50_000, 'abort did not interrupt the sleep');
assert.equal(last('b').busy, false);
assert.equal(last('b').items.find((i) => i.type === 'tool').status, 'error');
console.log(`\nabort -> send ${aborted}; tool output: ${JSON.stringify(last('b').items.find((i) => i.type === 'tool').output)}`);
log('B: abort', 'b');

// 4. Independence: B still works, and neither transcript leaks into the other.
await agent.send(b, 'Reply with exactly the word "zucchini".');
assert.match(last('b').items.at(-1).text, /zucchini/i);
const snapshot = async (id) => { let v; (await agent.watch(id, (x) => (v = x)))(); return v; };
const [va, vb] = [await snapshot(a), await snapshot(b)];
assert.ok(!va.items.some((i) => /zucchini|sleep 60/.test(i.text ?? JSON.stringify(i.args ?? ''))), 'B leaked into A');
assert.ok(!vb.items.some((i) => /bay leaves|pouch/.test(i.text ?? '')), 'A leaked into B');
log('B: after abort, independent', 'b');

// 5. Manual compaction (needs some bulk older than keepRecentTokens).
await agent.send(a, 'Use the bash tool with command "big", then reply with only the last line number you saw.');
await agent.send(a, 'Now reply "fine".');
views.a.length = 0;
await agent.compact(a);
const comp = last('a').items.find((i) => i.type === 'compaction');
assert.ok(comp?.summary, 'no compaction item');
assert.ok(last('a').items[0].text?.startsWith('Write two short'), 'history before the compaction vanished from the view');
log('A: compaction', 'a');
await agent.send(a, 'What was the text I asked you to echo earlier? One word.');
console.log('  after compaction ->', JSON.stringify(last('a').items.at(-1).text));
views.a.length = 0;

// 6. Signed out: send fails fast with a readable error, nothing queued.
signedIn = false;
await assert.rejects(agent.send(a, 'hello?'), /Not connected/);
signedIn = true;

stopA(); stopB();
await agent.close();

// Encryption check over every inference request that hit the wire.
const posts = wire.filter((w) => w.method === 'POST');
assert.ok(posts.length > 0);
for (const p of posts) {
  assert.equal(p.plaintext, false, `plaintext body to ${p.path}`);
  assert.ok(p.headers.includes('ehbp-encapsulated-key'), `no EHBP header on ${p.path}`);
}
console.log(`\nwire: ${posts.length} POSTs to ${[...new Set(posts.map((p) => p.path))]}, all EHBP (no plaintext JSON bodies)`);
console.log('request headers:', posts[0].headers.join(', '));
console.log('\nALL CHECKS PASSED');
