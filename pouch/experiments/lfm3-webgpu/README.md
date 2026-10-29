# LFM3 browser WebGPU experiment

**Result: working browser generation, verified October 28, 2026.**

Isolated from Pouch's build and dependencies. No native inference or HTTP inference
server is used. Python serves static files only; model downloads come from Hugging
Face and runtime JavaScript comes from jsDelivr. Prompts stay in the browser.

## Run

```sh
python3 pouch/experiments/lfm3-webgpu/serve.py
```

Open <http://127.0.0.1:8768/onnx.html> and click **Load and generate**. This
downloads about 1.1 GB of model weights, cached by Transformers.js. The runtime is
`@huggingface/transformers@4.3.2`; the model is
`onnx-community/LFM3-1.7B-ONNX`, `q4f16`, explicitly `device: 'webgpu'`.
The external weight file is `onnx/model_q4f16.onnx_data`, 1,087,789,056 bytes.
The page records load time, output, generation time and first-token timing.

## Observed generation

Chrome `152.0.7977.167` on this Mac, WebGPU adapter vendor `apple`, architecture
`metal-3`, with `shader-f16` available. The model repository's main revision at
test time was `ab9fec4c681a25bec3b48b0b97a62fc2660a2985`.

Prompt: “What is the capital of France? Answer in one sentence.”

Output: **“The capital of France is Paris.”**

| Measurement | Cold run | Cached second run |
|---|---:|---:|
| Load, including first download | 33,781.69 ms | 897.39 ms |
| Generation, including prompt processing | 694.48 ms | 182.95 ms |
| First streamed token | 372.94 ms | 120.82 ms |
| Streamed token callbacks | 8 | 8 |
| WebGPU compute dispatches during generation | not instrumented | **2,633** |
| WebGPU queue submissions during generation | not instrumented | **212** |

The second run wraps the browser's real WebGPU compute-dispatch and queue-submit
methods immediately before generation. This establishes actual browser GPU work,
not merely a `device` string, CPU WASM generation, native Metal or HTTP inference.
CPU-side tokenization, sampling and graph orchestration are still normal parts of
the browser runtime; this is not proof every auxiliary graph operation runs on GPU.
Eight tokens are too few to claim a sustained decode benchmark.

No long-context, streaming cancellation, tool calls, phone compatibility or Pouch
integration has been qualified. The smallest next step is adapting this same
pipeline to a Pouch provider adapter, after a bounded multi-turn/tool-call trial.

Use `dist/transformers.js`, not `dist/transformers.web.js`: the latter leaves a
bare `onnxruntime-web/webgpu` import unresolved without a bundler/import map.

## Other routes checked

- **WebLLM/MLC:** upstream MLC's centralized model registry has no LFM3
  architecture. A renamed model or converted weight format alone cannot fix that.
  <https://github.com/mlc-ai/mlc-llm/blob/main/python/mlc_llm/model/model.py>
- **Browser llama.cpp:** wllama 3 does have real WebGPU support. However, npm's
  latest published version at the time of this experiment is **3.8.1**, released
  October 2, 2026. Its llama.cpp submodule is
  `46ca246de9bb1c35269722a6240d37d9dfd79cad`, before LFM3 support merged on
  October 27 in `19cce6919992fdffd92e0ac152caaf1e2b8f254e`.
  Even wllama master points to a pre-release llama.cpp revision (last sync October
  20). The master package.json version (3.12.0) is not the npm release version.
- **Rebuilding wllama:** no `emcc` installed and Docker's daemon is not running.
  Its provided builder uses Emscripten 4.0.20 in Docker. Stopped short of installing
  that toolchain. With a rebuilt latest-llama.cpp WebGPU WASM binary, LFM3's graph
  and actual GPU operation coverage still need testing: native support is not a
  browser qualification.
- **ONNX:** the community export documents Transformers.js >=4.3.2 WebGPU use.
  The official LiquidAI ONNX export also explicitly documents the WebGPU entry
  point, q4f16, and maximum 256-token prefill chunks. This experiment uses a short
  prompt only, not a long-context or Pouch tool-calling qualification.
  <https://huggingface.co/onnx-community/LFM3-1.7B-ONNX>
  <https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX>

## Optional wllama negative test

```sh
python3 pouch/experiments/lfm3-webgpu/prepare-wllama.py
```

Then open <http://127.0.0.1:8768/>. This fetches a 20 MB runtime and only the
first 16 MiB of `LiquidAI/LFM3-1.7B-GGUF/LFM3-1.7B-QAD-Q4_0.gguf`.
The diagnostic copy sets the GGUF tensor count from 287 to zero, retaining all
metadata, to get past truncated-tensor bounds validation. It is not a usable
model and must never be presented as a generation test. The observed error is:

```text
llama_model_load: error loading model: unknown model architecture: 'lfm3'
```

This negative test also initialized `ggml_webgpu` successfully on Apple
`metal-3` in Chrome 152. `metal-3` is the browser adapter's reported architecture,
not use of the native llama.cpp Metal backend.

## Capability boundary (agent v2, October 29, 2026)

Evidence: `qualification/results/agent-v2.json` (summary table, perf) with full traces in
`agent-v2-agent-{a,b}.json` and `agent-v2-perf.json`. Harness: `qualification/run2.mjs`,
headless Chrome 156 in a fresh `/tmp` profile, Apple `metal-3`, loopback only (zero external
requests). Five synthetic tasks, byte-exact grading (config is graded by executing `show(10)`).

**Root causes of the v1 `feature` failure.** It was not a step-budget loop: both trials
ended `final` after 3 generations (~2.9 s), identically, because decoding was greedy. Tool XML,
parser and chat template were all correct. The model mishandles newlines inside native
`<parameter>` values (the template wraps each value in exactly one `\n`): it inserts a blank
separator line, drops a file's final newline (`Fahrenheit\n</parameter>`), or gives
`oldText` and `newText` different trailing newlines. Prompt wording alone did not fix this,
and neither did few-shot alone (0/40 byte-exact; semantically right in most runs). The new `rename` task
failed for different reasons: a prior for `/workspace`, just-bash grep returning a silent
`exit code 1`, and `oldText`/`newText` scope mismatches that duplicate code.

| Variant (greedy n=2 + T=0.3 n=6) | tree | edit | feature | rename | config |
|---|---:|---:|---:|---:|---:|
| v0 original | 8/8 | 8/8 | 0/8 | 0/8 | 8/8 |
| v2 fidelity wording | 8/8 | 8/8 | 0/8 | 0/8 | 8/8 |
| v3 few-shot | 8/8 | 8/8 | 0/8 | 0/8 | 8/8 |
| v4 multi-edit schema | 3/8 | 8/8 | 0/8 | 0/8 | 8/8 |
| v7 grounded + multi-edit | 8/8 | 8/8 | 0/8 | 7/8 | 8/8 |
| v9 grounded + newline-normalized tools | 8/8 | 8/8 | 0/8 | 0/8 | 8/8 |
| **v8 grounded + few-shot + newline-normalized** | 8/8 | 8/8 | **7/8** | **8/8** | 8/8 |

(Each row pools the greedy and sampled runs. v0 pools with v1; the full 18-row table with medians is in `agent-v2.json`.) "Grounded"
names `/work` in the system prompt and makes empty grep failures informative.
"Newline-normalized" is a disclosed tool policy, not a model capability: an edit's `newText`
inherits `oldText`'s trailing newline, and `write` ends text with one newline. The few-shot
turn (append plus create) resembles `feature`, so treat that row's lift as partly
teaching to the test. `rename` and `config` were not shown in the few-shot turn. Median v8 latency: 2–4 s
greedy, 3–9 s sampled. Sampling costs 2–2.5× because Transformers.js does top-p on the CPU.

**Throughput** (greedy, 256 forced output tokens, 3 runs each): 960-token prompt,
prefill ≈2,100–2,300 tok/s (TTFT ≈0.43 s), decode ≈111–114 tok/s; 3,780-token prompt,
prefill ≈1,570–1,670 tok/s (TTFT ≈2.3 s), decode ≈65–73 tok/s. Memory: system-wide
unified GPU memory rose about 1.2 GB on load and about 5.1 GB at the 4k-context peak (ORT's
buffer pool is not released). Chrome RSS for the profile was about 3.4–3.8 GB. Warm load from
Cache Storage took 1.9 s.

**Recommended Local-lane scope in Pouch.** Offer it for workspace inspection and
summaries, single-file targeted edits, small multi-file edits where intent is stated
literally, and JSON config edits. Use the v8 recipe: name the cwd, make tool errors
informative, include a one-turn byte-exact example, normalize newlines in the tools, and decode
greedily (cheaper, and no less accurate here). Cap steps at 8 and context near 4k. Past
4k, decode halves and memory roughly quadruples. Show a "try Sealed" suggestion when
Local reaches the step cap, repeats a failing edit twice, the task spans more than about 3 files
or asks for open-ended refactoring/design, or context would exceed ~4k. Have Local re-read
files after edits and show diffs. Small models make plausible-but-wrong bytes.

**Integration needs.** (1) A pi-ai custom provider that forwards `generate` to this
worker and streams `TextStreamer` chunks as text deltas. It must parse the native XML
tool calls into pi tool-call events, coercing non-string parameters with JSON per schema, and render
history with the model's own chat template (`enable_thinking:false`). Abort should map to
`InterruptableStoppingCriteria`. (2) Assets under a single-peer CSP. Either serve
the pinned, hash-checked ~1.13 GB set (see `assets-manifest.json`) from `api.bayleaf.dev`,
which is already the only `connect-src` peer, verifying SHA256 before caching. Or let the user
pick local files (File System Access / `<input type=file>`), hash-check them against the manifest,
and store them in OPFS. Either way, `script-src 'self' 'wasm-unsafe-eval'` must ship the ORT
`.mjs/.wasm` with Pouch, since the runtime cannot come from a CDN. (3) Note: the tool layer
in this experiment duplicates Pouch's tools. Adopt newline normalization and informative
empty errors in Pouch's own `edit`/`write`/`bash`, not in the provider.
