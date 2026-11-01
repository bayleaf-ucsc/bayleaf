# Gemma 4 intake and comparison plan

Research and qualification, 2026-11-01. Initial research below preceded the
evaluation run; dated run notes distinguish completed evidence from plans.
No gateway releases approved or production default changed.

## Published comparisons

[Liquid's LFM3-1.7B model card](https://huggingface.co/LiquidAI/LFM3-1.7B)
reports a direct comparison with Gemma 4 E4B:

| Benchmark (higher is better) | LFM3-1.7B | Gemma 4 E4B |
|---|---:|---:|
| BFCL V4 | 71.39 | 48.25 |
| ToolSandbox | 80.36 | 69.27 |
| IFBench | 73.03 | 44.56 |
| GPQA Diamond | 63.37 | 57.88 |
| LiveCodeBench v6 | 73.46 | 71.00 |
| SWE-bench Verified (OpenCode) | 43.40 | 0.50 |

These are **Liquid-run**, not independent replications. All models used vLLM
BF16 at full context length; default sampling was T=0.6/top_p=0.95, with
benchmark-specific exceptions (BFCL and ToolSandbox greedy). The unusually
large SWE-bench gap warrants replication and inspection of harness/template
compatibility, not a claim that Gemma cannot code. No independent direct
E2B/E4B versus LFM3-1.7B comparison was located in this preliminary search.

[Google's technical report](https://arxiv.org/html/2607.02770v2) gives E4B/E2B
GPQA Diamond 58.6/43.4 and LiveCodeBench v6 52.0/44.0 in thinking mode.
The disagreement with Liquid's E4B LiveCodeBench score (71.0) demonstrates why
scores from different evaluation recipes must not be treated as interchangeable.
Neither source predicts Pouch's no-thinking, short-budget, quantized WebGPU loop.

LFM3 text released October 27, 2026; Gemma 4 initially released April 2026.
Larger does not imply newer or better adapted to Pouch's agent harness.
Gemma does offer image/audio input in one model and Apache-2.0 licensing,
unlike the shipped text-only LFM3's revenue-restricted LFM Open License v1.0.
Other LFM3 modalities are separate checkpoints, not the shipped Pouch model.

## Export intake (metadata only)

Transformers.js added Gemma 4 in v4.1. Pouch pins v4.3.2, so architecture
support does not itself require a runtime bump. QAT-mobile exports require
2-bit gather support introduced in v4.3. Actual pinned-runtime WebGPU loading
still needs a smoke test.

Inspected Hugging Face model metadata and ONNX file trees:

| Export under `onnx-community/` | Revision | ONNX bytes, decimal GB |
|---|---|---:|
| `gemma-4-E2B-it-ONNX`, q4f16 | `6f21c99d7e18237f8d2ce92aadfdbfeba877f63a` | 3.382 |
| `gemma-4-E4B-it-ONNX`, q4f16 | `2b6d2e26a962f70a33da8f7cd81e1afdd8d9cfb2` | 5.179 |
| `gemma-4-E2B-it-qat-mobile-ONNX`, q2f16 plus fp16 vision | `a7f19b0ab28252b77cea830f52b8290b2479c87d` | 2.572 |
| `gemma-4-E4B-it-qat-mobile-ONNX`, q2f16 plus fp16 vision | `8bd93f348b091ba6976d502da00350b4ce133f36` | 3.614 |

Totals include decoder, embeddings, vision and audio ONNX graphs and external
data, not tokenizer/processor metadata or runtime, cache duplication or KV memory.
Text-only loading may omit encoders, but that must be verified, not assumed.
These ONNX exports are substantially larger than advertised LiteRT mobile
footprints: those are different artifacts. E4B q4f16 exceeds the current
qualification playbook's approximately 3.5 GB download ceiling. Do not silently
relax that ceiling. Both E4B exports have split decoder external data.

The E2B export config declares `gemma4` /
`Gemma4ForConditionalGeneration`. Its template accepts tools and
`enable_thinking`, with native calls of the form
`<|tool_call>call:name{...}<tool_call|>`, not LFM3's XML. A dedicated safe
parser and transcript adapter are needed in qualification and production;
never evaluate model-generated argument text as JavaScript. Complete intake
still needs exact license text, each candidate's template/config inspection,
artifact hashes and a verified minimal file set.

## Pouch implementation direction

Add-ons (`src/addons.ts`, one registry in `src/addons-registry.ts`, the
`addons` command and Settings > Add-ons) already provide pinned gateway
downloads (`src/models.ts`), consent tiers, resume, verify, removal and task
progress; LFM3's weights are one entry there. Register any further model as an
add-on rather than building a second manager. The single `LOCAL_MODEL` build
define (`src/local/host.ts`) and the LFM3-hard-coded worker
(`src/local/worker.ts`: `'lfm3'`, `q4f16`, the native XML parser in
`src/local/provider.ts`) are the actual multi-model bottlenecks.

1. Introduce pinned per-model execution descriptors: architecture, dtype,
   tool format, context/output budgets and measured device requirements.
2. Let the existing manager list/select supported pinned models, distinguish
   downloaded from loaded, report storage, and unload before switching. Keep
   download approval and no-network worker boundaries intact.
3. Add Gemma-specific loading, template/transcript handling and parser tests.
   Begin with text/tool use; multimodal qualification is a separate capability,
   not implied by a successful text smoke test.
4. Compare the shipped LFM3 with E2B and E4B in the existing qualification
   harness: identical tasks/tools and budgets, generic baseline and separately
   qualified family recipes, greedy plus seven sampled trials. Keep held-out
   traces out of tuning. Preserve the current LFM3 recipe as a control.
5. Record correctness, parse errors, cap/timeouts, TTFT, decode rate, load time,
   downloaded bytes and Chrome RSS. Use small smoke runs before full matrices.
   Broaden tasks if the existing near-ceiling LFM3 suite cannot distinguish
   useful capability gains. Measure performance without competing GPU work.
6. Only qualified options become shipping entries. Keep LFM3 as default unless
   evidence and Adam's hands-on use justify changing it. Gateway publication,
   production deployment, commits and PR publication need explicit approval.

Existing LFM3 shipped-recipe reference: core 54/56, held-out 16/16, zero
parse/timeouts (`../lfm3-webgpu/README.md`, shipped recipe qualification).

The evaluation ran on branch `pouch-gemma-models` (PR #146), before Pouch's
TypeScript port and add-ons landed; it was ported onto `main` afterwards
(2026-11-02) without rerunning. Receipts keep the source hashes they were run
with.

## QAT-mobile evaluation intake (2026-11-01)

Adam requested actual evaluations of both small Gemmas. Selected pinned
QAT-mobile ONNX exports, **text-only**, to keep both downloads inside the
existing 3.5 GB ceiling. Exact configs:
`../lfm3-webgpu/qualification/configs/gemma4-e2b-qat.json` and
`gemma4-e4b-qat.json`. Text asset totals, including tokenizer/template/configs:
**2,324,194,060 bytes** (E2B), **3,361,444,484 bytes** (E4B).

- License: **Apache License, Version 2.0**, verified against the model cards'
  linked [Google license text](https://ai.google.dev/gemma/docs/gemma_4_license).
  Neither ONNX export includes a standalone LICENSE file. The declared base
  checkpoints are Google's `gemma-4-E2B-it-qat-mobile-transformers` and
  `gemma-4-E4B-it-qat-mobile-transformers`; the exporter procedure and exact base
  SHAs are not documented, so do not imply reproducible conversion provenance.
  Artifact revision and every file SHA256 are pinned. LFS hashes come from the
  HF tree API; small metadata files were read and hashed before fetching weights.
- Configs declare `gemma4` / `Gemma4ForConditionalGeneration`. Pinned
  Transformers.js 4.3.2 exposes `Gemma4ForCausalLM` and text-only decoder/embed
  session mapping; no runtime bump. Both use `q2f16` artifact suffixes, but these
  are **mixed QAT precision**, not uniformly 2-bit models. The source configs
  specify 2/4/8-bit submodules. E4B requires both external decoder data shards.
  `shader-f16` is required. Actual browser memory is an eval outcome, not assumed
  from weight size.
- Both pinned templates are byte-identical. They accept system prompts,
  structured tool definitions/results and `enable_thinking`; the experiment
  disables thinking and preserves native special tokens for parsing.
- Vendor sampling: T=1.0/top_p=.95/top_k=64. This controlled Pouch comparison
  intentionally uses greedy plus seven sampled trials at T=.3/top_p=.95 with
  top_k disabled, matching the existing qualification protocol. This is not
  an eval of each model at its vendor-optimal sampling recipe.
- Every model uses the same four tools, two setups (generic baseline and
  unchanged shipped Pouch recipe), 8 steps, 4096 prompt tokens and 512 new
  tokens. The explicit limits also apply to baseline, avoiding its legacy
  larger-context defaults. No recipe tuning or held-out inspection for tuning.
  `lfm3-gemma-control.json` supplies the contemporaneous LFM3 control.
- Trials and perf run sequentially, never competing models on the GPU. Each
  run records sampled Chrome process-tree RSS, noisy system GPU counters,
  per-turn timing/tokens, and repeated standalone throughput/load measures.
  Other system GPU activity is not controlled, so document that limitation.
  All inference stays on loopback; weight fetches only from pinned HF revisions.

Disk intake: 124 GiB free before downloads, sufficient for persistent assets
and the temporary browser cache. No production model pins, gateway mirror,
local-manager UI or defaults change as part of evaluation.

Smoke findings before the full matrix:

- The local alias is not in Transformers.js's tokenizer-file registry, so
  `AutoTokenizer.from_pretrained('model')` cannot discover its files. The
  Gemma adapter now explicitly constructs `PreTrainedTokenizer` (the base of
  its otherwise empty GemmaTokenizer subclass) from pinned JSON and the pinned
  standalone chat template. With that fix, E2B loads successfully.
- `TextGenerationPipeline` hard-codes special-token removal in returned text.
  Parsing the explicitly preserved streamer output is required, not just
  setting streamer options while still consuming the stripped return value.
- E2B emits bare string values (`path:src/convert.js`), which Google's
  [reference extractor](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4)
  accepts. Added safe literal parsing for those values, without code execution.
  No prompt/recipe tuning was performed.
- Corrected E2B smoke: parsed read call, then explained the requested edit
  without applying it. Classified as behavioral failure, not parser failure.
- Before full matrices, set **20 GB emergency Chrome RSS cutoff** for all three
  configs on this 64 GB desktop. This is a safety guard for evaluation, **not**
  a relaxation of the approximately 5 GB shipping target. E2B's load already
  approaches the old default 12 GB guard, and prematurely killing E4B would
  prevent measuring its actual resource cost.

First matrix and adapter correction:

- `gemma4-e2b-qat-all.json` is **diagnostic, not the final comparison**. It
  completed 144 trials and performance, but inspection of core-task failures
  exposed another adapter issue: ordinary JSON-quoted strings were retained
  with their quotes (e.g. a lookup for the literal file name `"config.json"`).
  That confounds its behavioral score and makes its zero pass count unsuitable
  for a model-capability claim. The result/source hashes preserve that condition.
- The parser now supports native delimited strings, bare literals and ordinary
  JSON strings/keys, decoding JSON escapes without code execution. Call-boundary
  scanning respects both native and JSON strings so a closing-tag literal in
  file content is not mistaken for the end of a call. Regression tests cover
  embedded braces, commas, newlines, escaped quotes and closing-tag literals.
  This is family-adapter repair, not prompt tuning, and was based on core traces.
- E4B's edit smoke passed before the correction. The final three-model run uses
  the corrected adapter throughout, unchanged recipes, and output names ending
  `-comparison`. Runs are sequential: E4B, corrected E2B, LFM3 control. Every
  model repeats the complete matrix and resource benchmarks; no old behavioral
  result or smoke run is substituted into that comparison.

### Completed E4B run (corrected adapter)

Evidence: `../lfm3-webgpu/qualification/results/gemma4-e4b-qat-comparison.json`.
144 behavioral trials, then repeated performance measures; zero external
requests. Same pinned runtime and limits described above.

| Setup | Core | Held-out | Total | Parse failures | Step caps |
|---|---:|---:|---:|---:|---:|
| Generic baseline | 19/56 | 2/16 | 21/72 | 0 | 21 |
| Shipped Pouch recipe | 11/56 | 0/16 | 11/72 | 0 | 4 |

E4B passes the simple `edit` task 8/8 under either setup. With the shipped
recipe it also passes `jsonlist` 3/8, but none of the other seven tasks. The
unchanged LFM3-oriented recipe is **worse than generic baseline for E4B**;
this evaluates the pairing, not the best possible Gemma-specific recipe.
Both setups fall far short of the existing shipping bar.

Resource measurements on this reference machine (diagnostic, other system
GPU activity not controlled):

- Text assets: 3.36 decimal GB.
- Initial / warm model load: 5,180 / 2,127 ms, loopback not internet download.
- Throughput prompts: 1,013 / 4,172 actual tokens, three repetitions each,
  256 forced output tokens.
- Median TTFT: 1,234.5 / 7,524.6 ms.
- Median decode: 31.9 / 15.9 tokens/s.
- Sampled full-browser process-tree RSS peak: 11.57 GB, including loading.
- Noisy system-wide GPU counter peak growth from initial baseline: 21.18 GB.
  This is **not** per-model VRAM and is not additive with RSS.

The final three-model comparison is recorded below. No Gemma recipe tuning
has been attempted.

### Corrected E2B behavioral matrix

The corrected `gemma4-e2b-qat-comparison.json` completed all
144 trials: **0/72** under generic baseline and **0/72** under the shipped
recipe. Parse failures: 17 baseline, 18 recipe. Other failures include returning
prose instead of performing file operations. This condition includes native,
bare and JSON-quoted argument handling; it is distinct from the invalidated
first matrix above. No external requests, no recipe tuning.

E2B resource benchmarks: 2.32 GB text assets; initial/warm loopback load
4,111/1,695 ms; 1,013/4,172 actual prompt tokens, three repetitions with 256
forced output tokens. Median TTFT 2,185.5/10,648.4 ms; median decode
47.0/26.7 tokens/s. Sampled full-browser process-tree RSS peaks at 11.13 GB.
Noisy system-wide GPU counter peak growth is 17.30 GB, not model VRAM.
The fresh LFM3 control is included below.

## Final matched comparison (2026-11-01)

**Decision: retain LFM3 as the default. Neither tested Gemma QAT-mobile export
qualifies for Pouch's current local-agent pairing.** This is not a claim about
unquantized Gemmas, a different export, multimodal ability, thinking mode, or
the best possible family-specific recipe.

Completed **432 behavioral trials** (3 models x 2 setups x 9 tasks x 8 trials)
and **18 throughput repetitions**, plus initial/warm loading. One greedy and
seven sampled trials per task/setup. All three runs exited successfully with
**zero external requests**. A separate post-run verification confirmed exact
equality of runtime hashes, harness source hashes, recipe hashes, tool-layer
hashes and behavioral limits across the three final results. No held-out
traces were used for tuning; prompts/recipes were unchanged throughout.

| Model / export | Generic baseline | Shipped recipe | Recipe core | Recipe held-out | Recipe parse failures |
|---|---:|---:|---:|---:|---:|
| LFM3 1.7B q4f16 | 40/72 | **70/72** | **54/56** | **16/16** | 0 |
| Gemma 4 E2B QAT-mobile q2f16 | 0/72 | **0/72** | 0/56 | 0/16 | 18 |
| Gemma 4 E4B QAT-mobile q2f16 | 21/72 | **11/72** | 11/56 | 0/16 | 0 |

LFM3 reproduces the earlier 54/56 core and 16/16 held-out result exactly.
E4B's generic baseline is better than the unchanged shipped recipe, showing
recipe transfer is not automatic. Its zero parse failures also mean parser
rejection does not explain its poor success rate. Both Gemmas miss the
behavioral bar (core >= 52/56, no core task below 6/8, held-out >= reference).
E2B's remaining malformed calls are measured failures after the known adapter
bugs were repaired, not evidence that its native format cannot be supported.

### Resource results

Reference: Apple M3 Max, 64 GB unified memory, Chrome 156.0.8078.74 / Metal,
Transformers.js 4.3.2 and pinned ORT Web. Runs were sequential, in order E4B,
E2B, LFM3; other system GPU activity was not controlled. The identical filler
text tokenizes to 960/3,780 tokens for LFM3 and 1,013/4,172 for the Gemmas.
Throughput medians use three repetitions of 256 forced output tokens per size.

| Model | Text asset GB | Sampled Chrome RSS peak GB | TTFT ~1k / ~4k, seconds | Decode ~1k / ~4k, tokens/s | Initial / warm load, seconds |
|---|---:|---:|---:|---:|---:|
| LFM3 | 1.11 | **5.64** | **0.42 / 2.22** | **105.9 / 74.4** | 2.33 / 2.81 |
| Gemma E2B QAT | 2.32 | **11.13** | **2.19 / 10.65** | **47.0 / 26.7** | 4.11 / 1.70 |
| Gemma E4B QAT | 3.36 | **11.57** | **1.23 / 7.52** | **31.9 / 15.9** | 5.18 / 2.13 |

Both Gemmas fail the approximately 60 tok/s at ~4k reference target. Their
browser RSS peaks are roughly twice LFM3's and well above the approximate
5 GB target. **LFM3's newly measured 5.64 GB full-run peak also exceeds that
approximate target**: the corrected instrument needs a new reference, not an
assertion that the old memory gate passed. Its behavioral-phase peak was
approximately 5 GB; standalone perf raised the full-run peak. No memory budget
was silently relaxed, and this experiment makes no new production deployment.

RSS covers the full Chrome process tree and may double-count shared pages;
these are sampled lower bounds, not model-only physical memory. It is not
directly comparable to v1's undercounting sampler. System-wide GPU counter
peak deltas were 6.42/17.30/21.18 GB for LFM3/E2B/E4B: noisy, not per-model
VRAM and never additive with RSS. Load times are loopback with warm OS page
cache, not internet download times. No memory/performance population claim
follows from one desktop or this sequential, non-interleaved run order.

### Evidence and reproduction

All paths below are relative to `../lfm3-webgpu/qualification/`:

- `results/lfm3-gemma-control-comparison.json`
- `results/gemma4-e2b-qat-comparison.json`
- `results/gemma4-e4b-qat-comparison.json`
- Corresponding pinned configs in `configs/` (same stem without `-comparison`).
  Smoke runs and multi-MB traces remain gitignored.
- `results/gemma4-e2b-qat-all.json` is the invalidated diagnostic first matrix,
  not an input to these tables.

From the repository root, with dependencies installed and assets cached:

```sh
node pouch/qualify-model.mjs pouch/experiments/lfm3-webgpu/qualification/configs/gemma4-e4b-qat.json --out gemma4-e4b-qat-comparison
node pouch/qualify-model.mjs pouch/experiments/lfm3-webgpu/qualification/configs/gemma4-e2b-qat.json --out gemma4-e2b-qat-comparison
node pouch/qualify-model.mjs pouch/experiments/lfm3-webgpu/qualification/configs/lfm3-gemma-control.json --out lfm3-gemma-control-comparison
```

First-time downloads require explicit `--fetch`; all bytes must match pins.
12 unit tests pass, including special-token streaming, alternate argument
quoting, transcript pairing, measurement nulls, memory accounting and fixed
comparison conditions. The resource watchdog was separately tested to close
Chrome and save evidence with nonzero exit under an intentionally tiny limit.

No production model lock, gateway approval or deployment changed. Publishing
the evaluation harness and evidence does not expand the supported app models.
The generalized harness remains useful independently of these failed candidates.
The planned multi-model manager and actual app integration are not implemented
by this evaluation; exposing Gemma as a qualified option would be misleading.
