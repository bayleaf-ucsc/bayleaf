// The Local lane's model worker: LFM3 1.7B (q4f16) on WebGPU through
// Transformers.js and ONNX Runtime Web, both from npm (exact-pinned in
// package-lock.json) and bundled into this one script by build.mjs
// --with-models. The page fetches that script, checks its SHA-256 against the
// manifest it trusts, and starts it from a blob: URL (CSP worker-src blob:).
//
// Boundary: this worker has no network. The page hands it every model file as
// an already-verified Blob, and the ORT wasm as bytes, so fetch() is replaced
// by a refusal before anything else runs. Prompts and outputs never leave it
// except back to the page.
import { pipeline, PreTrainedTokenizer, TextStreamer, InterruptableStoppingCriteria, env } from '@huggingface/transformers';

const refused = [];
self.fetch = async (input) => { refused.push(String(input?.url ?? input)); throw new TypeError('The Local model has no network access.'); };

let generator = null;
let stopping = null;

// Transformers.js asks its cache for each file by URL; answer from the
// verified blobs by file name (".../onnx/model_q4f16.onnx" -> that file).
function blobCache(files) {
  const names = Object.keys(files).sort((a, b) => b.length - a.length);
  return {
    async match(key) {
      const url = String(key?.url ?? key);
      const name = names.find((n) => url.endsWith('/' + n));
      return name ? new Response(files[name], { headers: { 'content-length': String(files[name].size) } }) : undefined;
    },
    async put() {},
  };
}

async function load({ files, wasm }) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU has no adapter in this browser.');
  Object.assign(env, { allowRemoteModels: false, allowLocalModels: true, localModelPath: '/pouch-local/', useBrowserCache: false, useWasmCache: false, useCustomCache: true, customCache: blobCache(files) });
  const ort = env.backends.onnx.wasm;
  // No wasmPaths: the ORT WebGPU bundle uses its embedded glue, and the binary comes from here.
  ort.wasmPaths = undefined;
  ort.wasmBinary = new Uint8Array(await wasm.arrayBuffer());
  ort.numThreads = 1;
  const t0 = performance.now();
  generator = await pipeline('text-generation', 'lfm3', { dtype: 'q4f16', device: 'webgpu', progress_callback: (p) => postMessage({ progress: p }) });
  // The pipeline does not discover tokenizer files for a local alias (experiment note).
  if (!generator.tokenizer) {
    const json = async (n) => JSON.parse(await files[n].text());
    generator.tokenizer = new PreTrainedTokenizer(await json('tokenizer.json'), await json('tokenizer_config.json'));
  }
  return { load_ms: Math.round(performance.now() - t0), adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture }, refused: [...refused] };
}

const render = (messages, tools) => generator.tokenizer.apply_chat_template(messages, {
  tokenize: false, add_generation_prompt: true, enable_thinking: false, ...(tools?.length ? { tools } : {}),
});
const count = (prompt) => generator.tokenizer.encode(prompt, { add_special_tokens: false }).length;

// Fit the prompt in the budget: drop the oldest earlier turns whole (a turn
// starts at a user message), then shorten the current turn's oldest tool
// results. head (system + example) and the latest user message always stay.
function fit(head, history, tools, budget) {
  let rest = [...history], trimmed = 0;
  let prompt = render([...head, ...rest], tools), tokens = count(prompt);
  const lastUser = () => rest.findLastIndex((m) => m.role === 'user');
  while (tokens > budget) {
    const cut = rest.findIndex((m, i) => i > 0 && m.role === 'user');
    if (cut <= 0 || cut > lastUser()) break;
    rest = rest.slice(cut); trimmed++;
    prompt = render([...head, ...rest], tools); tokens = count(prompt);
  }
  for (let i = lastUser() + 1; tokens > budget && i < rest.length; i++) {
    const m = rest[i];
    if (m.role !== 'tool' || m.content.length <= 600) continue;
    rest[i] = { ...m, content: m.content.slice(0, 600) + '\n[shortened: the Local lane keeps about 4k tokens of context]' };
    trimmed++;
    prompt = render([...head, ...rest], tools); tokens = count(prompt);
  }
  return { prompt, tokens, trimmed, over: tokens > budget };
}

async function generate(id, { head, history, tools, budget = 4096, maxNew = 512 }) {
  if (!generator) throw new Error('The Local model is not loaded.');
  const { prompt, tokens, trimmed, over } = fit(head, history, tools, budget);
  if (over) return { over: true, input_tokens: tokens, trimmed };
  stopping = new InterruptableStoppingCriteria();
  let output = 0, first = null;
  const t0 = performance.now();
  // Greedy decoding: the qualified recipe (sampling cost 2–2.5x and was no more accurate).
  const out = await generator(prompt, {
    max_new_tokens: maxNew, do_sample: false, return_full_text: false, add_special_tokens: false, stopping_criteria: stopping,
    streamer: new TextStreamer(generator.tokenizer, { skip_prompt: true, skip_special_tokens: false,
      callback_function: (t) => postMessage({ id, delta: t }),
      token_callback_function: () => { output++; first ??= performance.now(); } }),
  });
  const interrupted = !!stopping.interrupted;
  stopping = null;
  return { text: out[0].generated_text, input_tokens: tokens, output_tokens: output, trimmed, interrupted, length: output >= maxNew,
    ttft_ms: first && Math.round(first - t0), ms: Math.round(performance.now() - t0) };
}

self.onmessage = async ({ data }) => {
  const { id, action } = data;
  if (action === 'interrupt') { stopping?.interrupt(); return; }
  try {
    let result;
    if (action === 'load') result = await load(data);
    else if (action === 'generate') result = await generate(id, data);
    else if (action === 'dispose') { await generator?.dispose(); generator = null; result = 'disposed'; }
    else throw new Error('Unknown action ' + action);
    postMessage({ id, result });
  } catch (e) { postMessage({ id, error: String(e?.message ?? e) }); }
};
