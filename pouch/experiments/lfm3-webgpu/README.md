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
`agent-v2-agent-{a,b}.json` and `agent-v2-perf.json`. Harness: `qualification/run2.mjs`
(now replaced by `qualify.mjs`; see "Qualification harness" below), headless Chrome 156 in a fresh `/tmp` profile, Apple `metal-3`, loopback only (zero external
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
greedily (cheaper, and no less accurate here). Cap steps at 8 and context near 4k. (The
claim that decode halves and memory quadruples past 4k was not measured here; the
2026-11-01 long-context qualification, `qualification/context-2026-11-01/REPORT.md`, measured
decode roughly halving per doubling beyond 8K, a one-shot prefill wall at 11,585 tokens, and
recommends chunked prefill with a 16,384 budget.) Show a "try Sealed" suggestion when
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

## Quantization (October 31, 2026)

Evidence: `qualification/results/quant.json` (summary), per-variant `quant-<dtype>-perf.json`
(committed) and `quant-<dtype>-agent.json` (gitignored traces, about 0.7 MB each). Harness:
`qualification/run-quant.mjs` with `worker-quant.js`/`quant.html` (copies of the v2 worker
and page that take a `dtype`), `download-quant.py` (pinned revision, sha256 checked against
HF LFS metadata) and `summarize-quant.py`. Those scripts were never committed and are now
replaced by `qualify.mjs` with `configs/lfm3-<dtype>-repro.json` (see "Qualification harness"). Same machine, Chrome 156 headless, fresh `/tmp`
profile per run, zero external requests. Weights lived in `~/.cache/bayleaf-pouch/quant-exp/`
during the run and were deleted afterwards.

Protocol: run2's five tasks plus `jsonlist` (three keys in one JSON edit, one a list append)
and `yaml` (insert a step at exact indentation, byte-exact). Each task ran greedy x1, then
T=0.3/top_p=0.95 with seeds 1–7. Transformers.js's own sampler RNG (`random.seed`) is seeded,
so a given seed replays identically across variants up to numerical drift. "Original" is agent-v2's v0
setup; "recipe" is v8. No early stopping: every cell got 8 trials.

| Variant (file, bytes) | recipe, five | recipe, all 7 | original, five | original, all 7 | failure classes (recipe / original) |
|---|---:|---:|---:|---:|---|
| **q4f16** (`model_q4f16`, 1,088,085,770) | **40/40** | **56/56** | 24/40 | 33/56 | – / 15 cap, 8 wrong |
| q4 (`model_q4`, 1,297,549,403) | 40/40 | 56/56 | 24/40 | 35/56 | – / 13 cap, 8 wrong |
| q8 (`model_quantized`, 2,175,882,841) | 32/40 | 48/56 | 24/40 | 40/56 | 8 wrong / 8 cap, 8 wrong |

No variant had a single tool-call parse failure, and none timed out. Original-setup failures:
`feature` always fails as wrong-but-well-formed (blank line), `rename` always hits the step cap
(`/workspace` prior), and `yaml` hits the cap in 7/5/0 trials for q4f16/q4/q8 (the model
strips the indentation from `oldText`, then retries the identical edit). q8 under the recipe
fails `feature` 8/8: in 6 it inserts the blank separator line anyway, and in 2 it emits literal `\n`
escapes. Higher-precision weights followed the few-shot byte pattern *less* faithfully. This
is one task and one prompt, so read it as the recipe's sensitivity to small logit shifts,
not as q8 being generally worse. q8 is the most robust variant *without* the recipe (it fixes
`yaml`).

| Variant | decode tok/s ~1k / ~4k | TTFT ~1k / ~4k | load (fresh profile / reload) | GPU Δ load / peak | Chrome RSS peak | median trial (recipe) |
|---|---:|---:|---:|---:|---:|---:|
| q4f16 | **112** / **73** | **0.42** / **2.4 s** | 1.5 / 2.7 s | +1.2 / +1.3 GB | 4.7 GB | 6.0 s |
| q4 | 98 / 65 | 0.58 / 3.3 s | 1.6 / 3.9 s | +2.0 / +1.7 GB | 4.6 GB | 6.2 s |
| q8 | 81 / 58 | 0.53 / 3.0 s | 2.5 / 8.4 s | +2.4 / +2.4 GB | 7.0 GB | 7.7 s |

Not run: **fp16** (3,558,502,927 bytes in two shards). It is over the ~3.5 GB bound, and
Transformers.js's Cache Storage keeps a second copy of the weights inside the browser profile
(2.2 GB measured for q8), so fp16 needed about 7.1 GB against 7.5 GB free. No `int8`/`uint8`
files exist at this revision. Transformers.js maps dtype `q8` to `model_quantized`, whose
graph uses the same `MatMulNBits`/`GatherBlockQuantized` ops as q4f16 (8-bit blocks, fp32
activations and fp32 KV cache), so q8 runs on the GPU with no CPU fallback. **Native MLX
comparison (oMLX) was skipped**: LiquidAI's MLX 4-bit (991 MB) and 8-bit (1.86 GB) builds
declare `model_type: lfm3`, oMLX 0.7.2 bundles mlx-lm 0.31.4.dev without an lfm3 module, and
the model card says mlx-lm support is in progress. Nothing was downloaded for that part.

**Recommendation: keep q4f16, and offer no user choice yet.** Decision rule: switch only if
another variant gains at least +4/40 on the five recipe tasks with no regression on
`jsonlist`/`yaml`, at no more than 1.25× q4f16's TTFT and memory. No variant could gain:
q4f16 is already at ceiling (40/40, 56/56). It is also the smallest download, the fastest
(15–40% faster decode) and the lightest in memory. q4 adds 19% more bytes and fp32
activations and buys nothing. q8 doubles the download, costs about 1.5× the RSS, and *loses*
`feature` under the recipe. A "higher-precision" toggle would cost users more and would not
buy accuracy on these tasks.

Caveats: the ceiling hides small differences. Seven synthetic tasks, eight trials each, one
prompt recipe and one machine; the trials are not independent samples of the task space.
The recipe's few-shot example resembles `feature`. The system-wide IOAccelerator counter is noisy:
the baseline was ~9 GB this time against 2.3 GB on October 29, and these 4k peaks (+1.3 GB for
q4f16) disagree with v2's +5.1 GB. Trust the relative ordering and Chrome RSS more than the
absolute GPU deltas. "Load" uses loopback assets with a warm OS page cache. It is not a
network download, and the reload after `dispose()` was oddly slower than the first load for
every variant.

## Qualification harness (October 31, 2026)

One config-driven runner replaces `run2.mjs` (agent-v2) and the uncommitted quant scripts.
The workflow around it, from license intake to shipping, is the ops playbook
`.agents/skills/bayleaf-ops-router/playbooks/qualify-in-browser-model.md`.

| File | Concern |
|---|---|
| `qualification/qualify.mjs` | verify model and runtime sha256s, serve loopback with a strict CSP, drive headless Chrome, write `results/<id>-<phase>.json` (schema `pouch-qualify-v1`) and gitignored `results/traces/` |
| `qualification/qualify-worker.js`, `qualify-page.js`, `qualify.html` | the agent loop, native XML parser and tool layer in a module worker; the page only bridges |
| `qualification/tasks.mjs` | the seven core tasks (verbatim from run2/run-quant) and held-out tasks (`delete-line`, `replace-all`) |
| `qualification/recipes.mjs` | recipe sources (`profiles` = `src/profiles.js` TJS, what ships; `v8`, `none` frozen from agent-v2; or a JSON path) and tool layers (`pouch` mirrors `src/tools.js`; `v8`; `v8-raw`) |
| `qualification/summarize.mjs` | pass/n tables (five, core, held-out), failure classes, perf; `--against` replays a legacy trace file trial by trial |
| `qualification/configs/` | `lfm3-q4f16.json` (standard matrix: baseline vs shipped recipe), `lfm3-{q4f16,q4,q8}-repro.json` (quant reproduction) |

The runtime is Pouch's own `node_modules` copy, checked against `models.lock.json`. The model is
the `fetch-models.mjs` cache (`lockId`) or a pinned file list. Failure classes: parse, cap (step
cap), wrong (well-formed but wrong bytes), timeout, load, other (token/call/context limits).

**Reproduction.** `node qualify.mjs configs/lfm3-q4f16-repro.json --tasks feature,yaml --trials 0,1`
then `node summarize.mjs results/<out>.json --against results/quant-q4f16-agent.json`: 8/8 trials
match the quant run on class and round count (original: feature wrong x2, yaml cap x2; recipe:
4/4 pass), 0 external requests. A full `lfm3-<dtype>-repro.json` run reproduces a quant.json row.
agent-v2's v0 and v8 rows are the `five` column of the same configs. Its exact trials are not
replayable, because v2's sampled trials were unseeded (n=2 greedy + 6 unseeded; now 1 + 7 seeded).
Its other 16 ablations can be rebuilt as recipe JSON files, and `run2.mjs` remains in git history.
`run.mjs` (with `worker.js`, `app.js`, `index.html`, `sw.js`, `server.py`, `download.py`) is kept
for milestone 1's baseline, offline Service Worker and multi-turn resource phases, which
`qualify.mjs` does not cover.

**Shipped recipe, first look.** `recipe: "profiles"` differs from v8 only in the few-shot
tool-result wording: Pouch's "Edited lines now read" format. So it had never been qualified
verbatim against Pouch-worded tools. A 4-task x 2-trial smoke (`configs/lfm3-q4f16.json`, tasks
feature, yaml, delete-line, replace-all; trials 0–1) passed 8/8 with the recipe. The baseline
passed 2/8: delete-line left a blank line in both trials. The full standard matrix follows below.

## Shipped recipe qualification (2026-11-01)

The first full standard matrix on the recipe Pouch actually ships: the `transformersjs` text
imported verbatim from `src/profiles.js` (working tree, recipe sha256 prefix `3f58dd31`), against
agent-v2's v8 text, in one headless Chrome session. Config `qualification/configs/lfm3-q4f16-requal.json`,
results `qualification/results/lfm3-q4f16-requal-agent.json` (traces gitignored). Model: the
`fetch-models.mjs` cache of `lfm3-1.7b-q4f16` (`onnx-community/LFM3-1.7B-ONNX@ab9fec4c`), every
file sha256-verified, nothing fetched. Chrome 156.0.8078.74, `metal-3`, runtime 4.3.2 /
ORT 1.31.0-dev (lock). 9 tasks x 4 setups x (greedy 1 + T 0.3/top_p 0.95 seeds 1–7) = 288 trials,
about 30 min. External requests: 0.

Setups run sequentially (the harness loops setup, then task, then trial; it does not interleave):
`shipped` (profiles text, Pouch tool layer), `v8-pouch` (v8 text, Pouch tool layer: isolates the
text), `v8-v8` (v8 text, v8 tool layer: the original 39/40, 56/56 reference), `baseline` (no
recipe, Pouch tool layer).

| setup | tree | edit | feature | rename | config | jsonlist | yaml | delete-line | replace-all | five | core | held-out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| shipped | 8/8 | 8/8 | 6/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 38/40 | 54/56 | 16/16 |
| v8-pouch | 8/8 | 8/8 | 6/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 38/40 | 54/56 | 16/16 |
| v8-v8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 40/40 | 56/56 | 16/16 |
| baseline | 8/8 | 8/8 | 0/8 | 0/8 | 8/8 | 7/8 | 1/8 | 0/8 | 8/8 | 24/40 | 32/56 | 8/16 |

Failure classes: shipped and v8-pouch 2 `wrong` each (all `feature`), zero `parse`, `cap`,
`timeout`; v8-v8 none; baseline 16 `cap` (rename 8, yaml 7, jsonlist 1) and 16 `wrong` (feature 8,
delete-line 8). Median trial 5.1–5.4 s with the recipe, 6.7 s baseline.

**The text is not what differs.** `profiles` and `v8` share the system prompt and tool schemas
byte for byte; the few-shot differs only in two tool results:

```
- Applied 1 edit to /work/x.txt\na = 1\nb = 2\n
+ Applied 1 edit to /work/x.txt. Edited lines now read:\n1: a = 1\n2: b = 2\n3: 
- Wrote 3 characters to /work/y.txt
+ Wrote 2 lines (3 characters) to /work/y.txt
```

Swapping that text changed nothing (shipped = v8-pouch, cell for cell). The two lost `feature`
trials follow the tool layer, whose only difference is the result wording (`format`; both normalize
newlines and explain empty matches). The failures are byte fidelity: three trials left a blank
line between `label` and the appended `unit` export in `src/ui.js`, one (shipped, seed 3) never
appended the export. The failing seeds differ between setups (shipped 2, 3; v8-pouch 5, 6), so
this is sampled noise at n = 8 around a weak spot, not a systematic regression; and `feature` is
the core task the few-shot most resembles (playbook step 5), so its 8/8 was partly teaching to
the test.

**Verdict: the shipped recipe qualifies.** Playbook step 4's bar holds: core 54/56 (≥ 52), no task
below 6/8, held-out 16/16 (the v8 reference is 16/16), zero `parse` and `timeout`. Against v8's
reference it is −2 on `five` (38 vs 40), inside step 6's +4/40 decision threshold, with no
`jsonlist`, `yaml` or held-out regression. Keep the shipped text: v8's few-shot would misdescribe
what Pouch's tools actually return, for no measured gain. Do not adopt the v8 tool result
wording in `src/tools.js` on this evidence either; if `feature` matters, test a blank-line-aware
result format as a candidate (step 5), with held-out guarded.

Caveats: another agent ran fake-model browser tests on the same machine during this run, so
timings are indicative only (no perf phase was run). n = 8 per cell cannot resolve a 2/8
difference. The profiles text was the working tree, not a commit; record `3f58dd31…` (full hash in
the results file) and rerun if `TJS` changes before it is committed.
