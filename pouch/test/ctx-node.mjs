// The context meter, node: src/context.ts counting (measured usage plus an
// estimate of what came after, compaction heads, failed replies), the meter's
// words and levels per provider, and end to end through openAgent: a Sealed
// reply's reported usage reaches view.context; a Transformers.js reply that
// fit() trimmed is stored as trimmed (message.contextTrimmed) and survives a
// fresh watch. No network: a fake verified client and a fake engine.
// Run: node test/ctx-node.mjs
import assert from 'node:assert/strict';
const { contextOf, contextFor, describe, short, autoCompactAt } = await import('../src/context.ts');
const { openAgent, MemoryStorage, compactionFor } = await import('../src/agent.ts');

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };

const usage = (input, output, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: 0 } });
let nextId = 0;
const e = (kind, ...model) => ({ id: ++nextId, kind, model });
const user = (text) => e('pi.user', { role: 'user', content: text, timestamp: 1 });
const reply = (text, u, extra = {}) => e('pi.assistant', { role: 'assistant', content: [{ type: 'text', text }], usage: u, stopReason: 'stop', timestamp: 2, ...extra });
const tool = (text) => e('pi.tool-result', { role: 'toolResult', toolCallId: 'c', toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: 3 });

// 1. Measured plus estimated.
{
  const only = contextOf([user('hi'), reply('hello', usage(1000, 50, 200))]);
  assert.deepEqual({ tokens: only.tokens, measured: only.measured, added: only.added, exact: only.exact }, { tokens: 1250, measured: 1250, added: 0, exact: true });
  const more = contextOf([user('hi'), reply('hello', usage(1000, 50, 200)), tool('x'.repeat(350)), user('y'.repeat(7))]);
  assert.equal(more.measured, 1250);
  assert.equal(more.added, 100 + 2, '3.5 characters a token, rounded up per message');
  assert.equal(more.exact, false);
  // Nothing measured: everything is an estimate.
  const none = contextOf([user('z'.repeat(35))]);
  assert.deepEqual({ tokens: none.tokens, measured: none.measured, exact: none.exact }, { tokens: 10, measured: 0, exact: false });
  assert.equal(contextOf([]).tokens, 0);
  ok('measured usage plus an estimate of what came after; nothing measured means all estimated');
}

// 2. What does not count as measured.
{
  const failed = contextOf([user('hi'), reply('a', usage(900, 10)), user('b'), reply('', usage(5000, 0), { stopReason: 'error' }), reply('', usage(6000, 0), { stopReason: 'aborted' })]);
  assert.equal(failed.measured, 910, 'error and aborted replies are skipped');
  const zero = contextOf([user('hi'), reply('a', usage(0, 0))]);
  assert.equal(zero.measured, 0, 'a server that reports no usage leaves it estimated');
  // A compaction head: replies before it are gone from the active entries, and the head's own messages are estimated.
  const head = e('pi.compaction', { role: 'user', content: 's'.repeat(70), timestamp: 5 });
  const compacted = contextOf([head, user('q'.repeat(7))]);
  assert.deepEqual({ tokens: compacted.tokens, measured: compacted.measured, compacted: compacted.compacted }, { tokens: 22, measured: 0, compacted: true });
  const after = contextOf([head, user('q'), reply('r', usage(400, 20))]);
  assert.equal(after.measured, 420, 'a reply after the summary is measured');
  // A kept turn: after the head in order, but older (lower id), so its usage predates the summary.
  const kept = reply('kept', usage(9000, 10)), head2 = e('pi.compaction', { role: 'user', content: 's'.repeat(70), timestamp: 6 });
  const stale = contextOf([head2, user('k'), kept]);
  assert.equal(stale.measured, 0, 'a kept reply older than the summary is estimated, not measured');
  ok('error, aborted and zero-usage replies are not measured; a compaction summary starts the count');
}

// 3. The meter's words and levels.
{
  assert.deepEqual([812, 1000, 12_431, 98_304, 131_072, 1_000_000, 1_048_576].map((n) => short(n)), ['812', '1k', '12.4k', '98.3k', '131k', '1M', '1M']);
  assert.deepEqual([4096, 131_072, 1_048_576, 200_000].map((n) => short(n, true)), ['4k', '128k', '1M', '200k']);
  const w = 131_072, auto = autoCompactAt(w, compactionFor(w));
  assert.equal(auto, 98_304, 'a 128k window compacts by itself from about 98k');
  const big = autoCompactAt(1_048_576, compactionFor(1_048_576));
  assert.ok(big < 262_144, 'a 1M window compacts as if it were at most 256k');
  const sealed = describe({ tokens: 12_431, measured: 12_431, added: 0, exact: true, trimmed: 0 }, { window: w, auto });
  assert.equal(sealed.text, '12.4k / 128k');
  assert.equal(sealed.level, 'ok');
  assert.match(sealed.label, /^Context: 12,431 tokens of a 131,072-token window; as the last reply's server reported\.$/);
  const est = describe({ tokens: 80_000, measured: 79_000, added: 1000, exact: false, trimmed: 0 }, { window: w, auto });
  assert.equal(est.text, '~80k / 128k');
  assert.equal(est.level, 'near');
  assert.match(est.label, /about 80,000 tokens.*79,000 as the last reply's server reported, plus about 1,000 estimated since.*compacts by itself at about 98.3k; \/compact does it now/);
  assert.equal(describe({ tokens: 99_000, measured: 99_000, added: 0, exact: true }, { window: w, auto }).level, 'over');
  const unknown = describe({ tokens: 3000, measured: 0, added: 3000, exact: false }, { window: null, auto: autoCompactAt(32_768, compactionFor(32_768)) });
  assert.equal(unknown.text, '~3k');
  assert.equal(unknown.fill, null);
  assert.match(unknown.label, /window is unknown.*estimated from text length: no reply has reported usage yet\./);
  ok('meter text, levels and labels: window when known, count only when not, near and past auto-compaction');
}

// 4. Transformers.js: against BUDGET, and saying when the model did not see everything.
{
  const fits = describe({ tokens: 2000, measured: 2000, added: 0, exact: true, trimmed: 0 }, { budget: 4096 });
  assert.deepEqual([fits.text, fits.level], ['2k / 4k', 'ok']);
  assert.match(fits.label, /of the Transformers\.js model's 4,096-token budget/);
  assert.equal(describe({ tokens: 3500, measured: 3500, added: 0, exact: true, trimmed: 0 }, { budget: 4096 }).level, 'near');
  const next = describe({ tokens: 4500, measured: 3900, added: 600, exact: false, trimmed: 0 }, { budget: 4096 });
  assert.equal(next.level, 'over');
  assert.match(next.label, /your next message will leave out older turns/);
  const trimmed = describe({ tokens: 3900, measured: 3900, added: 0, exact: true, trimmed: 2 }, { budget: 4096 });
  assert.equal(trimmed.level, 'over');
  assert.match(trimmed.label, /not seeing the whole conversation/);
  ok('Transformers.js: shown against its 4,096-token budget; trimming and an over-budget next message are said in words');
}

// 5. End to end: openAgent stores usage and the trim mark; watch() carries view.context.
{
  const sse = (text, u) => new Response(['data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'glm-5-3', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }),
    'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'glm-5-3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'glm-5-3', choices: [], usage: u }), 'data: [DONE]', ''].join('\n\n'),
  { headers: { 'content-type': 'text/event-stream' } });
  const client = { openAIOptions: { apiKey: 'k' }, async getVerificationDocument() { return { securityVerified: true }; },
    secureClient: { fetch: async () => sse('Sealed reply.', { prompt_tokens: 3210, completion_tokens: 45, prompt_tokens_details: { cached_tokens: 3000 } }) } };
  let trim = 0;
  const engine = { async generate() { return { text: 'Browser reply.', input_tokens: 4000, output_tokens: 20, trimmed: trim }; } };
  const agent = await openAgent({ storage: new MemoryStorage(), tools: [], systemPrompt: async () => 'Test agent.', getClient: async () => client,
    models: [{ id: 'glm-5-3', contextWindow: 32_768 }], local: { info: { id: 'lfm3', label: 'LFM3' }, worker: engine } });
  const settle = async (id) => { for (let k = 0; k < 200 && (await agent.snapshot(id)).busy; k++) await new Promise((r) => setTimeout(r, 25)); };
  try {
    const s = await agent.createSession('glm-5-3');
    await agent.send(s, 'hello', [], undefined, 'glm-5-3'); await settle(s);
    let v = await agent.snapshot(s);
    assert.equal(v.context.measured, 3210 + 45, 'prompt (cached included) plus reply, as the server reported');
    assert.equal(v.context.exact, true);
    // A real compaction: the summary becomes the head, the old measurement no longer applies.
    for (let i = 0; i < 2; i++) { await agent.send(s, `Turn ${i}: ` + 'bay leaves and walking routes '.repeat(600), [], undefined, 'glm-5-3'); await settle(s); }
    await agent.compact(s);
    v = await agent.snapshot(s);
    assert.equal(v.context.compacted, true, 'the context starts from the summary');
    assert.equal(v.context.measured, 0, 'the kept turns\' usage predates the summary');
    assert.ok(v.context.tokens < 3210 + 45 + 2 * 5000, `smaller after compaction: ${JSON.stringify(v.context)}`);
    const l = await agent.createSession('local:lfm3');
    await agent.send(l, 'first', [], undefined, 'local:lfm3'); await settle(l);
    assert.equal((await agent.snapshot(l)).context.trimmed, 0);
    trim = 3;
    await agent.send(l, 'second', [], undefined, 'local:lfm3'); await settle(l);
    v = await agent.snapshot(l);
    assert.deepEqual([v.context.measured, v.context.trimmed], [4020, 3], 'what the model saw, and how much fit() left out');
    assert.equal(contextFor(v.context, true), v.context, 'Transformers.js keeps its measurement');
    const away = contextFor(v.context, false);
    assert.ok(away.tokens === v.context.full && away.trimmed === 0 && !away.exact && away.measured === 0, `another provider gets the whole estimate: ${JSON.stringify(away)}`);
    trim = 0;
    await agent.send(l, 'third', [], undefined, 'local:lfm3'); await settle(l);
    assert.equal((await agent.snapshot(l)).context.trimmed, 0, 'the mark is the newest reply\'s, not sticky');
    ok('end to end: Sealed usage reaches view.context; a real compaction restarts the count; a Transformers.js trim is stored with its reply and read back, and switching provider estimates the whole context');
  } finally { await agent.close(); }
}

console.log(`\n${passed} passed`);
process.exit(0);
