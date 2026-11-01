import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionOptions, gemmaArguments, parseToolCalls, withToolIds } from './model-adapters.mjs';
import { generationMetrics, measure, memorySummary, median, processMemory } from './measurements.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('legacy execution defaults and invalid families fail closed', () => {
  assert.deepEqual(executionOptions(), { loader: 'text-generation', toolFormat: 'xml' });
  assert.throws(() => executionOptions({ toolFormat: 'guess' }));
  assert.throws(() => executionOptions({ loader: 'remote-code' }));
});
test('Gemma comparison configs pin text assets and hold evaluation conditions fixed', () => {
  const configs = ['lfm3-gemma-control', 'gemma4-e2b-qat', 'gemma4-e4b-qat'].map((id) => JSON.parse(readFileSync(new URL(`./configs/${id}.json`, import.meta.url), 'utf8')));
  const conditions = ({ setups, tasks, heldOut, stepCap, budget, maxNew, trials, measurements }) => ({ setups, tasks, heldOut, stepCap, budget, maxNew, trials, measurements });
  for (const c of configs.slice(1)) {
    assert.deepEqual(conditions(c), conditions(configs[0]));
    assert.match(c.model.revision, /^[a-f0-9]{40}$/);
    assert.ok(c.model.files.reduce((n, f) => n + f.bytes, 0) < 3.5e9);
    for (const f of c.model.files) { assert.match(f.sha256, /^[a-f0-9]{64}$/); assert.ok(!/vision_encoder|audio_encoder/.test(f.name)); }
  }
});
test('Gemma native arguments preserve literal bytes and nested values', () => {
  const source = '{path:<|"|>x.txt<|"|>,content:<|"|>a, {b}: "c"\\n\n<tool_call|><|"|>,edits:[{oldText:<|"|>a<|"|>,newText:<|"|><|"|>}],replaceAll:true,count:2,other:null}';
  assert.deepEqual(gemmaArguments(source), { path: 'x.txt', content: 'a, {b}: "c"\\n\n<tool_call|>', edits: [{ oldText: 'a', newText: '' }], replaceAll: true, count: 2, other: null });
  const calls = parseToolCalls(`<|tool_call>call:write${source}<tool_call|>`, 'gemma4');
  assert.equal(calls[0].function.arguments.content, gemmaArguments(source).content);
  assert.equal(parseToolCalls('<|tool_call>call:read{path:<|"|>a<|"|>}<tool_call|><|tool_call>call:read{path:<|"|>b<|"|>}<tool_call|>', 'gemma4').length, 2);
  const json = '{"path":"src/a.js","content":"a, {b}\\n<tool_call|> \\"quoted\\""}';
  assert.deepEqual(gemmaArguments(json), JSON.parse(json));
  assert.deepEqual(parseToolCalls(`<|tool_call>call:write${json}<tool_call|>`, 'gemma4')[0].function.arguments, JSON.parse(json));
});
test('pinned runtime streamer preserves special tool tokens needed by Gemma', async () => {
  const { TextStreamer } = await import('../../../node_modules/@huggingface/transformers/dist/transformers.js');
  const pieces = ['prompt', '<|tool_call>', 'call:read{path:<|"|>a<|"|>}', '<tool_call|>'];
  const tokenizer = { all_special_ids: [1, 3], decode: (ids, { skip_special_tokens }) => ids.filter((id) => !skip_special_tokens || ![1, 3].includes(Number(id))).map((id) => pieces[Number(id)]).join('') };
  let text = '';
  const streamer = new TextStreamer(tokenizer, { skip_prompt: true, skip_special_tokens: false, callback_function: (delta) => { text += delta; } });
  for (let i = 0; i < pieces.length; i++) streamer.put([[BigInt(i)]]);
  streamer.end();
  assert.equal(parseToolCalls(text, 'gemma4')[0].function.arguments.path, 'a');
});
test('malformed/unsafe arguments rejected, executable-looking text remains literal data', () => {
  for (const source of ['{a:1,a:2}', '{__proto__:{x:1}}', '{a:<|"|>unfinished}', '{} trailing', '[]', '{a:1,}', '{a:1e999}']) assert.throws(() => gemmaArguments(source), source);
  assert.deepEqual(gemmaArguments('{path:src/convert.js,command:ls /work}'), { path: 'src/convert.js', command: 'ls /work' });
  assert.deepEqual(gemmaArguments('{a:alert(1)}'), { a: 'alert(1)' }); // Data, not code.
  assert.throws(() => parseToolCalls('<|tool_call>call:read{}', 'gemma4'));
  assert.throws(() => parseToolCalls('<tool_call>broken', 'xml'));
});
test('XML recipe remains byte-compatible and coerces schema types', () => {
  const tools = [{ function: { name: 'edit', parameters: { properties: { replaceAll: { type: 'boolean' } } } } }];
  const [call] = parseToolCalls('<tool_call><function=edit><parameter=oldText>\na\n\n</parameter><parameter=replaceAll>\ntrue\n</parameter></function></tool_call>', 'xml', tools);
  assert.deepEqual(call.function.arguments, { oldText: 'a\n', replaceAll: true });
});
test('Gemma transcript ids pair parallel and few-shot tool results without mutation', () => {
  const messages = [{ role: 'assistant', tool_calls: ['read', 'write'].map((name) => ({ function: { name, arguments: {} } })) }, { role: 'tool', content: 'one' }, { role: 'tool', content: 'two' }];
  const fixed = withToolIds(messages);
  assert.equal(fixed[1].tool_call_id, fixed[0].tool_calls[0].id);
  assert.equal(fixed[2].name, 'write');
  assert.equal(messages[0].tool_calls[0].id, undefined);
  assert.throws(() => withToolIds([{ role: 'tool', content: 'orphan' }]));
});
test('RSS includes Chrome descendants without a profile flag, excludes other runs', () => {
  const ps = ' 10 1 100 /Chrome --user-data-dir=/run/a\n11 10 200 /Helper\n12 11 300 /GPU\n13 1 900 /Chrome --user-data-dir=/run/b';
  assert.equal(processMemory(ps, '/run/a'), 600);
  assert.equal(processMemory(ps, '/missing'), null);
  assert.equal(processMemory('10 1 100 /Chrome --user-data-dir=/run/ab', '/run/a'), null);
});
test('memory nulls and sampled peaks remain honest', () => {
  assert.deepEqual(memorySummary([{ chromeRssKB: null, gpuInUseBytes: null }]).chromeRssPeakKB, null);
  assert.equal(memorySummary([{ chromeRssKB: 10, gpuInUseBytes: 100 }, { chromeRssKB: 30, gpuInUseBytes: 150 }, { chromeRssKB: 15, gpuInUseBytes: 110 }]).gpuPeakDeltaBytes, 50);
  assert.equal(median([null, 2, 4]), 3);
  assert.equal(median([null]), null);
});
test('measurement samples operations and preserves failure metrics', async () => {
  let i = 0;
  const measured = await measure(async () => { await new Promise((r) => setTimeout(r, 25)); return 'ok'; }, { sample: () => ({ chromeRssKB: ++i }), intervalMs: 5 });
  assert.equal(measured.value, 'ok'); assert.ok(measured.measurement.samples >= 3);
  await assert.rejects(measure(async () => { throw Error('load failed'); }, { sample: () => ({ chromeRssKB: 9 }) }), (e) => e.measurement.chromeRssPeakKB === 9);
});
test('generation rates avoid Infinity and do not invent TTFT for empty output', () => {
  assert.equal(generationMetrics({ input_tokens: 100, output_tokens: 11, ttft_ms: 50, decode_ms: 100 }).decode_tok_s, 100);
  const empty = generationMetrics({ output_tokens: 0, ttft_ms: null, decode_ms: 0 });
  assert.equal(empty.prefill_tok_s, null); assert.equal(empty.decode_tok_s, null);
});
test('summarizer accepts legacy, partial perf and context results without fabricated metrics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pouch-summary-test-'));
  const base = { model: { repo: 'test/model', revision: 'abcdef12', dtype: 'q4f16', download_bytes: 1000 }, externalRequests: [] };
  try {
    for (const perf of [undefined, { coldLoadMs: 2, rows: [] }, { context: { oneshot: [{ length: 4096, error: 'load failed' }] } }]) {
      const path = join(dir, 'result.json'); writeFileSync(path, JSON.stringify({ ...base, perf }));
      const out = execFileSync(process.execPath, [new URL('./summarize.mjs', import.meta.url).pathname, path], { encoding: 'utf8' });
      assert.ok(!out.includes('undefined')); assert.ok(!out.includes('NaN'));
      if (perf?.context) assert.ok(out.includes('load failed'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
