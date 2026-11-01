// Qualification worker: loads one ONNX model with Transformers.js on WebGPU and runs
// bounded agent trials over an in-memory /work. Everything model-specific arrives as
// data from qualify.mjs (model files under /m/model/, recipe, tool layer, limits), so
// this file changes only when the agent loop or the tool semantics change.
// Generation options mirror pouch/src/local/worker.js (enable_thinking false, native
// tokens kept in the stream, greedy unless the trial samples).
import { pipeline, PreTrainedTokenizer, TextStreamer, env, InterruptableStoppingCriteria, random } from '/runtime/transformers.js';
import { Bash, InMemoryFs } from './tools.bundle.js';

env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = new URL('/m/', location.href).href;
env.useBrowserCache = true; env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = { mjs: '/runtime/ort-wasm-simd-threaded.asyncify.mjs', wasm: '/runtime/ort-wasm-simd-threaded.asyncify.wasm' };
env.backends.onnx.wasm.numThreads = 1;

let generator, fs, layer, toolSet;

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

// ── Native XML tool calls (as src/local/provider.js parseToolCalls). A model with a
// different tool-call format needs its own parser here and in Pouch: record that at intake.
function coerce(name, key, v) {
  const t = toolSet.find((x) => x.function.name === name)?.function.parameters.properties?.[key]?.type;
  if (!t || t === 'string') return v; try { return JSON.parse(v); } catch { return v; }
}
function parse(text) {
  const calls = [];
  for (const m of text.matchAll(/<tool_call>\s*<function=([^>\n]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g)) {
    const args = {}; for (const p of m[2].matchAll(/<parameter=([^>\n]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) args[p[1]] = coerce(m[1], p[1], p[2]);
    calls.push({ type: 'function', function: { name: m[1].trim(), arguments: args } });
  }
  if (text.includes('<tool_call>') && !calls.length) throw Error('Malformed/incomplete native XML tool call'); return calls;
}

async function generate(messages, { maxNew = 384, budget = 8192, withTools = false, sampling = null, minNew = 0 } = {}) {
  const prompt = generator.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true, enable_thinking: false, ...(withTools ? { tools: toolSet } : {}) });
  const inputTokens = generator.tokenizer.encode(prompt, { add_special_tokens: false }).length;
  if (inputTokens > budget) { const e = Error(`context budget ${budget} exceeded: ${inputTokens}`); e.context = true; throw e; }
  const sample = sampling ? { do_sample: true, temperature: sampling.temperature, top_p: sampling.top_p ?? 1, top_k: 0 } : { do_sample: false };
  if (minNew) sample.min_new_tokens = minNew;
  const start = performance.now(); let first = null, last = null, tokens = 0;
  const out = await generator(prompt, { max_new_tokens: maxNew, ...sample, return_full_text: false, add_special_tokens: false, stopping_criteria: new InterruptableStoppingCriteria(),
    streamer: new TextStreamer(generator.tokenizer, { skip_prompt: true, skip_special_tokens: false, callback_function: () => {}, token_callback_function: () => { tokens++; first ??= performance.now(); last = performance.now(); } }) });
  return { text: out[0].generated_text, input_tokens: inputTokens, output_tokens: tokens, generation_ms: performance.now() - start, ttft_ms: first === null ? null : first - start, decode_ms: first === null ? null : last - first };
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
    let calls; try { calls = parse(g.text); } catch (e) { trace.push({ ...g, error: String(e) }); status = 'parse_error'; break; }
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
      generator = await pipeline('text-generation', 'model', { dtype: data.dtype, device: 'webgpu', ...(data.loadOptions ?? {}) });
      // The pipeline registry does not discover tokenizer files for a local alias.
      generator.tokenizer ??= new PreTrainedTokenizer(...await Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(async (f) => (await fetch('/m/model/' + f)).json())));
      result = { load_ms: performance.now() - start, userAgent: navigator.userAgent, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, shaderF16: adapter.features.has('shader-f16'), ort: env.backends.onnx.versions };
    } else if (action === 'agent') result = await agent(data);
    else if (action === 'generate') { toolSet = []; result = await generate(data.messages, data.options); }
    else if (action === 'dispose') { await generator?.dispose(); generator = null; result = 'disposed'; }
    else throw Error('Unknown action');
    postMessage({ id, result });
  } catch (e) { postMessage({ id, error: String(e) + '\n' + e.stack }); }
};
