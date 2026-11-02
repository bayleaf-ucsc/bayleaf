// Qualification worker: loads one ONNX model with Transformers.js on WebGPU and runs
// bounded agent trials over an in-memory /work. Everything model-specific arrives as
// data from qualify.mjs (model files under /m/model/, recipe, tool layer, limits), so
// this file changes only when the agent loop or the tool semantics change.
// Generation options mirror pouch/src/local/worker.js (enable_thinking false, native
// tokens kept in the stream, greedy unless the trial samples).
import { pipeline, PreTrainedTokenizer, Gemma4ForCausalLM, TextGenerationPipeline, TextStreamer, env, InterruptableStoppingCriteria, random, Tensor } from '/runtime/transformers.js';
import { Bash, InMemoryFs } from './tools.bundle.js';
import { executionOptions, parseToolCalls, withToolIds } from './model-adapters.mjs';

env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = new URL('/m/', location.href).href;
env.useBrowserCache = true; env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = { mjs: '/runtime/ort-wasm-simd-threaded.asyncify.mjs', wasm: '/runtime/ort-wasm-simd-threaded.asyncify.wasm' };
env.backends.onnx.wasm.numThreads = 1;

let generator, fs, layer, toolSet;
let execution = executionOptions();

// ── Tool layer. Two wordings: 'v8' (the experiment) and 'pouch' (mirrors src/tools.js).
const CWD = '/work';
function abs(p) {
  if (typeof p !== 'string') throw Error('path must be string');
  const a = []; for (const x of (p.startsWith('/') ? p : CWD + '/' + p).split('/')) { if (x === '..') a.pop(); else if (x && x !== '.') a.push(x); }
  const n = '/' + a.join('/'); if (n !== CWD && !n.startsWith(CWD + '/')) throw Error('Only synthetic /work permitted'); return n;
}
// newText ends with a newline exactly when oldText does; write ends with one newline.
function matchNewline(e) {
  if (typeof e.oldText !== 'string' || typeof e.newText !== 'string' || (layer.format === 'pouch' && e.newText === '')) return [e, false];
  const o = e.oldText.endsWith('\n'), n = e.newText.endsWith('\n');
  return o === n ? [e, false] : [{ ...e, newText: o ? e.newText + '\n' : e.newText.replace(/\n+$/, '') }, true];
}
function finalNewline(c) {
  if (typeof c !== 'string' || !c) return [c, false];
  const f = layer.format === 'pouch' ? c.replace(/\n*$/, '') + '\n' : c.endsWith('\n') ? c : c + '\n';
  return [f, f !== c];
}
const lineOf = (text, i) => text.slice(0, i).split('\n').length;

async function execute(name, a) {
  const pouch = layer.format === 'pouch';
  if (name === 'bash') {
    const b = new Bash({ fs, cwd: CWD, ...(pouch ? {} : { commands: ['ls', 'find', 'cat', 'grep', 'rg', 'sed', 'awk', 'printf', 'echo', 'head', 'tail', 'wc', 'sort', 'mkdir', 'touch', 'pwd', 'test'] }), executionLimits: { maxCommandCount: 1000, maxLoopIterations: 1000 } });
    const r = await b.exec(a.command, { signal: AbortSignal.timeout(3000) });
    const out = r.stdout + (r.stderr ? (r.stdout && pouch ? '\n' : '') + r.stderr : '');
    if (pouch) {
      if (r.exitCode && !out.trim()) throw Error(`no output, exit ${r.exitCode}${layer.explainEmpty && /(^|[|;&(\s])(e?grep|rg)\s/.test(a.command) ? ` (for grep this means no matches; paths are relative to ${CWD})` : ''}`);
      if (r.exitCode) throw Error(`${out.trimEnd()}\n[exit code ${r.exitCode}]`);
      return out.trimEnd().slice(0, 50000) || '(no output)';
    }
    if (r.exitCode) throw Error((r.stderr || (layer.explainEmpty ? 'no output (for grep: no matches or path missing; workspace is /work)' : '')) + ' [exit code ' + r.exitCode + ']');
    return out.slice(0, 10000) || '(no output)';
  }
  const p = abs(a.path), dir = p.slice(0, p.lastIndexOf('/')) || '/';
  const missing = () => Error(pouch ? `${p} does not exist. List ${dir} with bash \`ls ${dir}\`, or search with \`find ${CWD} -name '<name>'\`.` : p + ' does not exist. List /work with bash ls or find.');
  if (name === 'read') { const t = await fs.readFile(p).catch(() => { throw missing(); }); return pouch ? t || '(empty file)' : t; }
  if (name === 'write') {
    if (typeof a.content !== 'string') throw Error('content must be string');
    const [text, fixed] = layer.normalizeNl ? finalNewline(a.content) : [a.content, false];
    await fs.mkdir(dir, { recursive: true }); await fs.writeFile(p, text);
    return pouch ? `Wrote ${text.split('\n').length} lines (${text.length} characters) to ${p}${fixed ? ' (saved ending with exactly one newline)' : ''}` : 'Wrote ' + text.length + ' characters to ' + p;
  }
  if (name === 'edit') {
    let matched = 0;
    const list = (Array.isArray(a.edits) && a.edits.length ? a.edits : [a]).map((e) => { if (!layer.normalizeNl) return e; const [x, c] = matchNewline(e); matched += c; return x; });
    let text = await fs.readFile(p).catch(() => { throw missing(); });
    const starts = [];
    for (const [n, e] of list.entries()) {
      const which = list.length > 1 ? ` (edit ${n + 1} of ${list.length}; nothing was written)` : '';
      if (!e.oldText) throw Error(`oldText is empty${which}; use write to create a file`);
      if (typeof e.newText !== 'string') throw Error(`newText is missing${which}`);
      const count = text.split(e.oldText).length - 1;
      if (!pouch && list.length === 1 && count !== 1) throw Error('oldText matches ' + count + ' times in ' + p + '; read the file and include neighboring lines to make it unique. Nothing written.');
      if (count === 0) throw Error(`oldText was not found in ${p}${which}.${text.includes(e.oldText.trim()) ? ' It matches if you ignore leading/trailing whitespace: copy the exact indentation.' : ' Read the file again and copy the text exactly.'}`);
      if (count > 1 && e.replaceAll !== true) throw Error(`oldText matches ${count} times in ${p}${which}; include neighboring lines to make it unique, or set replaceAll.`);
      starts.push([lineOf(text, text.indexOf(e.oldText)), e.newText.split('\n').length]);
      text = e.replaceAll === true ? text.split(e.oldText).join(e.newText) : text.replace(e.oldText, () => e.newText);
    }
    await fs.writeFile(p, text);
    if (!pouch) return 'Applied ' + list.length + ' edit' + (list.length > 1 ? 's' : '') + ' to ' + p + '\n' + text;
    const lines = text.split('\n');
    const shown = starts.slice(0, 5).map(([s, len]) => { const from = Math.max(1, s - 1), to = Math.min(lines.length, s + len); return lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n'); }).join('\n...\n');
    const note = matched ? ` (newText's final newline was matched to oldText's${list.length > 1 ? ` in ${matched}` : ''})` : '';
    return `Applied ${list.length} edit${list.length > 1 ? 's' : ''} to ${p}${note}. Edited lines now read:\n${shown}`;
  }
  throw Error('Unknown tool ' + name);
}

async function generate(messages, { maxNew = 384, budget = 8192, withTools = false, sampling = null, minNew = 0 } = {}) {
  if (execution.toolFormat === 'gemma4') messages = withToolIds(messages);
  const prompt = generator.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true, enable_thinking: false, ...(withTools ? { tools: toolSet } : {}) });
  const inputTokens = generator.tokenizer.encode(prompt, { add_special_tokens: false }).length;
  if (inputTokens > budget) { const e = Error(`context budget ${budget} exceeded: ${inputTokens}`); e.context = true; throw e; }
  const sample = sampling ? { do_sample: true, temperature: sampling.temperature, top_p: sampling.top_p ?? 1, top_k: 0 } : { do_sample: false };
  if (minNew) sample.min_new_tokens = minNew;
  const start = performance.now(); let first = null, last = null, tokens = 0, text = '';
  // TextGenerationPipeline hard-codes skip_special_tokens=true for its returned
  // generated_text, even when the streamer preserves them. Gemma's call tags
  // are special tokens: parse the preserved stream, never that stripped result.
  await generator(prompt, { max_new_tokens: maxNew, ...sample, return_full_text: false, add_special_tokens: false, stopping_criteria: new InterruptableStoppingCriteria(),
    streamer: new TextStreamer(generator.tokenizer, { skip_prompt: true, skip_special_tokens: false, callback_function: (delta) => { text += delta; }, token_callback_function: () => { tokens++; first ??= performance.now(); last = performance.now(); } }) });
  return { text, input_tokens: inputTokens, output_tokens: tokens, generation_ms: performance.now() - start, ttft_ms: first === null ? null : first - start, decode_ms: first === null ? null : last - first };
}

// ── Long-context sweep (perf phase with --lengths). Drives model.forward directly so
// prefill runs either one-shot (one pass over the whole document, as generator() does) or in
// chunks that carry past_key_values forward, which also yields progress events. Each prompt
// holds three needles (10/50/90% depth); each question forks the document's KV cache.
const gpuErrors = [];
if (self.GPUAdapter) {
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...a) {
    const d = await requestDevice.apply(this, a);
    d.addEventListener('uncapturederror', (e) => gpuErrors.push(String(e.error?.message ?? e.error).slice(0, 600)));
    d.lost.then((i) => gpuErrors.push(`device lost (${i.reason}): ${i.message}`.slice(0, 600)));
    self.gpuDevice = d; self.gpuLimits = { maxBufferSize: d.limits.maxBufferSize, maxStorageBufferBindingSize: d.limits.maxStorageBufferBindingSize };
    return d;
  };
}
// Varied filler: seeded field notes from small word lists (about 16 tokens a sentence).
const FILL = {
  who: ['the survey team', 'a volunteer botanist', 'the harbor pilot', 'two students', 'the night watch', 'an elderly beekeeper', 'the ferry crew', 'a cartographer', 'the mill foreman', 'our cook', 'the archivist', 'a visiting geologist', 'the lamplighter', 'the youngest sailor', 'a quiet engineer', 'the orchard keeper'],
  did: ['counted', 'sketched', 'repaired', 'measured', 'catalogued', 'photographed', 'weighed', 'relocated', 'cleaned', 'labelled', 'inspected', 'traded away', 'collected', 'painted', 'tested', 'sorted'],
  what: ['the copper pipes', 'a crate of lemons', 'seventeen fence posts', 'the tide tables', 'a broken compass', 'the rain gauges', 'several clay pots', 'the old ledgers', 'a nest of swallows', 'the signal flags', 'the brass hinges', 'a bundle of reeds', 'the cider barrels', 'the weather vane', 'a box of candles', 'the fishing nets'],
  where: ['near the north pier', 'behind the granary', 'along the ridge trail', 'inside the boathouse', 'at the market square', 'by the dry creek', 'under the cedar grove', 'beside the lighthouse', 'on the upper terrace', 'past the salt flats', 'in the east meadow', 'at the stone bridge'],
  when: ['before dawn', 'after the storm', 'during the noon break', 'at dusk', 'on a windy morning', 'while it drizzled', 'late in the evening', 'just after breakfast'],
  unit: ['kilograms', 'meters', 'liters', 'paces', 'bundles', 'centimeters'],
};
const NEEDLES = [{ gate: 'north', phrase: 'amber-falcon-4821', depth: 0.1 }, { gate: 'east', phrase: 'cobalt-meadow-7360', depth: 0.5 }, { gate: 'west', phrase: 'saffron-quill-2957', depth: 0.9 }];
function* fieldNotes(seed) {
  let s = seed >>> 0; const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32, p = (a) => a[Math.floor(r() * a.length)];
  for (let n = 0; ; n++) {
    if (n % 14 === 0) yield `\n\n## Field note ${n / 14 + 1}\n`;
    const w = p(FILL.who), extra = r() < 0.35 ? `, a total of ${Math.floor(r() * 900 + 100)} ${p(FILL.unit)}` : '';
    yield `${n % 14 ? ' ' : ''}${w[0].toUpperCase() + w.slice(1)} ${p(FILL.did)} ${p(FILL.what)} ${p(FILL.where)} ${p(FILL.when)}${extra}.`;
  }
}
const question = (gate) => `\n\nQuestion: According to the field notes above, what is the passphrase for the ${gate} gate? Answer with the passphrase only.`;
// Exact-length prompt as token ids: template prefix, document (needles spliced in at
// sentence boundaries), question + template suffix. Pieces are encoded separately (each
// starts at a space or newline, so this matches joint encoding up to rare boundary merges).
function buildPrompt(N, seed = 7) {
  const tok = generator.tokenizer, enc = (t) => tok.encode(t, { add_special_tokens: false });
  const tpl = tok.apply_chat_template([{ role: 'user', content: '\u0001SPLIT\u0001' }], { tokenize: false, add_generation_prompt: true, enable_thinking: false });
  const [pre, post] = tpl.split('\u0001SPLIT\u0001');
  const preIds = enc(pre), suffixes = NEEDLES.map((n) => [...enc(question(n.gate)), ...enc(post)]);
  const docLen = N - preIds.length - suffixes[0].length, doc = [], at = [];
  const gen = fieldNotes(seed); let k = 0;
  while (doc.length < docLen) {
    if (k < NEEDLES.length && doc.length >= NEEDLES[k].depth * docLen) { at.push(preIds.length + doc.length); doc.push(...enc(` The passphrase for the ${NEEDLES[k].gate} gate is ${NEEDLES[k].phrase}.`)); k++; continue; }
    doc.push(...enc(gen.next().value));
  }
  if (k < NEEDLES.length) throw Error('document too short for all needles');
  doc.length = docLen;
  return { prefix: [...preIds, ...doc], suffixes, needleTokenAt: at, docLen };
}
const I64 = (ids) => BigInt64Array.from(ids, (x) => BigInt(x));
const disposeAll = (c) => Promise.all(Object.values(c ?? {}).map((t) => t.location === 'gpu-buffer' ? t.dispose() : null));
// One forward pass over ids on top of cache (a plain {past name: tensor} object, or null),
// returning argmax/top logits and the new cache. The caller disposes what it no longer needs.
async function step(ids, cache, total, wantTop = false) {
  const out = await generator.model.forward({ input_ids: new Tensor('int64', I64(ids), [1, ids.length]), attention_mask: new Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]), past_key_values: cache, num_logits_to_keep: new Tensor('int64', [1n], []) });
  const next = {}; for (const [k, v] of Object.entries(out)) if (k.startsWith('present')) next[k.replace('present_conv', 'past_conv').replace('present', 'past_key_values')] = v;
  const l = out.logits.to('float32').data; let best = 0, finite = true;
  for (let i = 0; i < l.length; i++) { if (!Number.isFinite(l[i])) finite = false; if (l[i] > l[best]) best = i; }
  const top = wantTop && [...l.keys()].sort((a, b) => l[b] - l[a]).slice(0, 5).map((i) => [i, +l[i].toFixed(3)]);
  return { cache: next, token: best, finite, top };
}
const progress = (p) => postMessage({ progress: p });
const isEOS = (id) => {
  const eos = generator.model.generation_config?.eos_token_id ?? generator.model.config.eos_token_id;
  return (Array.isArray(eos) ? eos : [eos]).includes(id);
};
async function context({ length: N, chunk = 0, decodeTokens = 96, answerTokens = 24, capMs = 600000, label = '' }) {
  gpuErrors.length = 0;
  const t0 = performance.now(), P = buildPrompt(N), tokenizeMs = performance.now() - t0;
  const size = chunk > 0 ? chunk : P.prefix.length, chunks = [];
  const row = { length: N, mode: chunk > 0 ? `chunk-${chunk}` : 'oneshot', docTokens: P.prefix.length, needleTokenAt: P.needleTokenAt, tokenizeMs: Math.round(tokenizeMs) };
  let doc = null;
  try {
    const start = performance.now();
    for (let i = 0; i < P.prefix.length; i += size) {
      const ids = P.prefix.slice(i, i + size), c0 = performance.now();
      const s = await step(ids, doc, i + ids.length);
      await disposeAll(doc); doc = s.cache;
      if (!s.finite) throw Error(`non-finite logits after chunk ending at ${i + ids.length}`);
      chunks.push(Math.round(performance.now() - c0));
      progress({ label, done: i + ids.length, of: N, ms: Math.round(performance.now() - start) });
      if (performance.now() - start > capMs && i + size < P.prefix.length) { row.error = `prefill cap: ${capMs / 1000} s exceeded after ${i + ids.length}/${P.prefix.length} tokens`; break; }
    }
    row.prefillChunksMs = chunks;
    row.chunkMsSummary = { n: chunks.length, first: chunks[0], last: chunks.at(-1), max: Math.max(...chunks) };
    const shape = (n) => doc[`past_key_values.${n}.key`]?.dims;
    row.kvShapes = { 'full (layer 2)': shape(2), 'sliding (layer 4)': shape(4) };
    if (row.error) { row.prefillPartialMs = Math.round(performance.now() - start); return row; }
    row.needles = [];
    for (const [q, n] of NEEDLES.entries()) {
      const s0 = performance.now(), suf = P.suffixes[q];
      let total = P.prefix.length + suf.length, s = await step(suf, doc, total, q === 0);
      if (q === 0) { row.ttftMs = Math.round(s0 - start + performance.now() - s0); row.prefillMs = Math.round(s0 - start); }
      const ids = [s.token], first = q === 0 ? s.top : undefined; let fork = s.cache, tFirst = performance.now();
      const want = q === 0 ? decodeTokens : answerTokens;
      while (ids.length < want && (q === 0 || !isEOS(ids.at(-1)))) {
        const d = await step([ids.at(-1)], fork, ++total); await disposeAll(fork); fork = d.cache;
        if (!d.finite) throw Error(`non-finite logits while decoding at ${total}`);
        ids.push(d.token);
      }
      const tLast = performance.now(); await disposeAll(fork);
      const eosAt = ids.findIndex(isEOS);
      const answer = generator.tokenizer.decode(ids.slice(0, eosAt < 0 ? ids.length : eosAt), { skip_special_tokens: true }).trim();
      row.needles.push({ gate: n.gate, depth: n.depth, pass: answer.toLowerCase().includes(n.phrase), answer: answer.slice(0, 80) });
      if (q === 0) { row.decodeTokens = ids.length; row.decodeTokS = +((ids.length - 1) / ((tLast - tFirst) / 1000)).toFixed(1); row.firstTop5 = first; row.greedyIds = ids; }
    }
    row.prefillTokS = +(P.prefix.length / (row.prefillMs / 1000)).toFixed(1);
  } catch (e) { row.error = String(e).slice(0, 1500); }
  finally { await disposeAll(doc); row.gpuErrors = gpuErrors.slice(0, 10); row.gpuLimits = self.gpuLimits; }
  return row;
}

// Synthetic tail probe: one chunk of real tokens on top of a zero-filled cache of length past
// (one shared zero buffer per shape), then a few decode steps. Content is meaningless; it tests
// kernel size limits, per-chunk time, decode speed and memory at the far end of the context
// without the full prefill. Prefix-free, so it says nothing about quality.
// gpu: allocate the zero cache as GPU buffers (WebGPU zero-initializes them) instead of CPU
// arrays, which ORT stages through the 4 GiB wasm32 heap (fails near 256K: 'null function').
async function tail({ past, chunk = 512, decodeTokens = 16, gpu = false }) {
  gpuErrors.length = 0;
  const row = { mode: `tail-${chunk}${gpu ? '-gpu' : ''}`, past, chunk }, sess = generator.model.sessions.model, cache = {}, zeros = new Map(), owned = [];
  const OrtTensor = new Tensor('float32', new Float32Array(1), [1]).ort_tensor.constructor;
  for (const m of sess.inputMetadata) {
    if (!m.name.startsWith('past_')) continue;
    const dims = m.shape.map((d) => d === 'batch_size' ? 1 : d === 'past_sequence_length' ? past : d), n = dims.reduce((a, b) => a * b, 1);
    if (!gpu) { if (!zeros.has(n)) zeros.set(n, new Uint16Array(n)); cache[m.name] = new Tensor(m.type, zeros.get(n), dims); continue; }
    const buf = self.gpuDevice.createBuffer({ size: Math.ceil(n * 2 / 16) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }); owned.push(buf);
    cache[m.name] = new Tensor(OrtTensor.fromGpuBuffer(buf, { dataType: m.type, dims }));
  }
  const P = buildPrompt(4096);
  let c = cache, total = past;
  try {
    const t0 = performance.now(); const s = await step(P.prefix.slice(0, chunk), c, total += chunk); row.chunkMs = Math.round(performance.now() - t0); c = s.cache;
    row.finite = s.finite;
    const ids = [s.token], t1 = performance.now();
    while (ids.length < decodeTokens) { const d = await step([ids.at(-1)], c, ++total); await disposeAll(c); c = d.cache; if (!d.finite) row.finite = false; ids.push(d.token); }
    row.decodeTokS = +((ids.length - 1) / ((performance.now() - t1) / 1000)).toFixed(1);
    row.kvShapes = { 'full (layer 2)': c['past_key_values.2.key']?.dims, 'sliding (layer 4)': c['past_key_values.4.key']?.dims };
  } catch (e) { row.error = String(e).slice(0, 1500); }
  finally { if (c !== cache) await disposeAll(c); for (const b of owned) b.destroy(); row.gpuErrors = gpuErrors.slice(0, 10); }
  return row;
}

async function snapshot() { const out = {}; async function walk(p) { for (const n of await fs.readdir(p)) { const q = p + '/' + n; if ((await fs.stat(q)).isDirectory) await walk(q); else out[q] = await fs.readFile(q); } } await walk(CWD); return out; }

// One trial: a fresh /work, the recipe's system prompt and few-shot turns, one user prompt.
async function agent({ prompt, files, recipe, layer: l, sampling = null, seed = null, stepCap = 8, maxNew = 384, budget = 8192, timeoutMs = 120000 }) {
  layer = l; toolSet = recipe.tools; if (seed != null) random.seed(seed);
  fs = new InMemoryFs(files); await fs.mkdir(CWD, { recursive: true });
  const history = [{ role: 'system', content: recipe.system }, ...structuredClone(recipe.fewshot), { role: 'user', content: prompt }];
  const trace = [], start = performance.now(); let status = 'round_limit', rounds = 0;
  for (let round = 0; round < stepCap; round++) {
    rounds = round + 1;
    if (performance.now() - start > timeoutMs) { status = 'timeout'; break; }
    let g; try { g = await generate(history, { withTools: true, sampling, maxNew, budget }); } catch (e) { trace.push({ error: String(e) }); status = e.context ? 'context' : 'generation_error'; break; }
    let calls; try { calls = parseToolCalls(g.text, execution.toolFormat, toolSet); } catch (e) { trace.push({ ...g, error: String(e) }); status = 'parse_error'; break; }
    trace.push({ ...g, calls }); history.push({ role: 'assistant', content: calls.length ? '' : g.text, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) { status = g.output_tokens >= maxNew ? 'token_limit' : 'final'; break; }
    if (calls.length > 8) { status = 'call_limit'; break; }
    for (const c of calls) { let result; try { result = await execute(c.function.name, c.function.arguments); } catch (e) { result = 'ERROR: ' + e.message; } trace.push({ call: c, result }); history.push({ role: 'tool', content: result }); }
  }
  return { status, rounds, duration_ms: performance.now() - start, trace, files: await snapshot() };
}

self.onmessage = async ({ data }) => {
  const { id, action } = data;
  try {
    let result;
    if (action === 'load') {
      const adapter = await navigator.gpu.requestAdapter(); const start = performance.now();
      if (!adapter) throw Error('No WebGPU adapter');
      execution = executionOptions(data.execution);
      const options = { dtype: data.dtype, device: 'webgpu', ...(data.loadOptions ?? {}) };
      if (execution.loader === 'gemma4') {
        // The runtime's tokenizer-file registry knows HF ids, not our local alias.
        // GemmaTokenizer is a plain PreTrainedTokenizer subclass. Construct from
        // pinned files explicitly, including its separately stored chat template.
        const [json, tokenizerConfig, template] = await Promise.all([
          fetch('/m/model/tokenizer.json').then((r) => r.json()),
          fetch('/m/model/tokenizer_config.json').then((r) => r.json()),
          fetch('/m/model/chat_template.jinja').then((r) => r.text()),
        ]);
        const tokenizer = new PreTrainedTokenizer(json, { ...tokenizerConfig, chat_template: template });
        const model = await Gemma4ForCausalLM.from_pretrained('model', options);
        generator = new TextGenerationPipeline({ task: 'text-generation', model, tokenizer });
      } else generator = await pipeline('text-generation', 'model', options);
      // The pipeline registry does not discover tokenizer files for a local alias.
      generator.tokenizer ??= new PreTrainedTokenizer(...await Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(async (f) => (await fetch('/m/model/' + f)).json())));
      result = { load_ms: performance.now() - start, userAgent: navigator.userAgent, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, shaderF16: adapter.features.has('shader-f16'), ort: env.backends.onnx.versions };
    } else if (action === 'agent') result = await agent(data);
    else if (action === 'generate') { toolSet = []; result = await generate(data.messages, data.options); }
    else if (action === 'context' || action === 'tail') {
      // Direct-forward/cache probes retain LFM3-specific cache assumptions. Do not
      // silently label them cross-family tests; agent/throughput phases are generic.
      if (execution.loader !== 'text-generation' || generator.model.config.model_type !== 'lfm3') throw Error('Direct context/tail probes currently support LFM3 only');
      result = action === 'context' ? await context(data) : await tail(data);
    }
    else if (action === 'dispose') { await generator?.dispose(); generator = null; result = 'disposed'; }
    else throw Error('Unknown action');
    postMessage({ id, result });
  } catch (e) { postMessage({ id, error: String(e) + '\n' + e.stack }); }
};
