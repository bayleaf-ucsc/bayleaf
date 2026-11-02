# Pouch in-browser model qualification

This is Pouch's shared model evaluation harness. Its historical `lfm3-webgpu`
path stays stable so old configurations, results and reproduction commands keep
working. `pouch/qualify-model.mjs` is the model-neutral entry point.

This is developer evaluation machinery, not an expansion of Pouch's supported
models. **LFM3-1.7B q4f16 remains the only supported and recommended in-browser
model.** Candidate configs and adapters are experimental and never populate
the app's picker, model store, production lock or gateway catalog.

```sh
npm ci --ignore-scripts --prefix pouch
npm ci --ignore-scripts --prefix pouch/experiments/lfm3-webgpu/qualification
node --test pouch/experiments/lfm3-webgpu/qualification/test.mjs

# Full behavioral matrix plus performance: this is the default phase.
node pouch/qualify-model.mjs pouch/experiments/lfm3-webgpu/qualification/configs/lfm3-q4f16.json

# Small regression smoke. No downloading without explicit --fetch.
node pouch/qualify-model.mjs --phase agent --setups recipe --tasks edit --trials 0 --out smoke

# Resource benchmark alone: cold/warm loads and six throughput trials.
node pouch/qualify-model.mjs --phase perf --out perf
node pouch/experiments/lfm3-webgpu/qualification/summarize.mjs \
  pouch/experiments/lfm3-webgpu/qualification/results/perf.json
```

Dependencies are pinned. The runtime and every model file are hash-verified;
missing weights fail unless `--fetch` explicitly permits fetching the pinned
Hugging Face revision. Read the model-intake playbook before downloading a new
candidate. Runs use a fresh Chrome profile and a loopback-only origin with a
strict CSP, record external requests (must be zero), then remove the profile.
Inference does not contact BayLeaf or an upstream provider.

`--fetch-only` stages/verifies pinned files without launching Chrome; add
`--fetch` to permit missing-file downloads. This lets the next candidate's
assets download while the current candidate runs, without competing GPU jobs.

## Model families

Existing configs remain valid: `model.lockId` resolves the shipping pins, or
`model` contains `repo`, full `revision`, `dtype` and `files` with `name`, `bytes`
and `sha256`. `dtype` may also be a per-session map for mixed-precision exports.
Execution is separate from artifact pins and recipe/tool semantics:

```json
{
  "execution": { "loader": "gemma4", "toolFormat": "gemma4" },
  "loadOptions": {},
  "measurements": { "sampleMs": 500, "abortGB": 12 }
}
```

- Default `loader: "text-generation"`, `toolFormat: "xml"` preserves LFM3.
- `loader: "gemma4"` explicitly loads `Gemma4ForCausalLM` with a tokenizer and
  text-generation pipeline. This tests **text and tool use only**, not vision
  or audio. The pinned runtime's causal-LM mapping selects text-only sessions.
- `toolFormat: "gemma4"` parses native `call:name{...}` syntax with literal
  `<|"|>` strings through recursive descent, plus bare string values and
  JSON-quoted strings/keys seen in model output. No `eval`, function constructor or
  generated code execution. Transcript conversion pairs few-shot/parallel
  tool results with assistant call ids. Keep special tokens when decoding.
- New loaders/formats must be registered explicitly in `model-adapters.mjs`
  and the worker, not inferred from repository names or `trust_remote_code`.
- Direct-forward `--lengths` context sweeps and synthetic tail-cache probes
  still depend on LFM3 cache shapes. Other families are explicitly refused
  there; ordinary behavioral and throughput phases are family-neutral.

Both small QAT-mobile Gemmas have completed full matched evaluations against
LFM3. Neither qualifies for the current Pouch pairing. Full comparison evidence
and adapter-repair caveats are in `../../gemma4/README.md`. Loading/smoke alone
does not qualify a shipping model.

## Measurements are part of the evaluation

Schema `pouch-qualify-v2` adds measurements without removing legacy result
fields. The summarizer also reads v1, and prints `n/a` for missing metrics.

Every load, agent trial, generation and disposal records elapsed wall time,
memory before/after, sample count, sampled Chrome RSS peak and system GPU
counter peak delta. Sampling defaults to 500 ms (`--sample-ms`), includes
endpoints and covers failed operations too. A 12 GB Chrome RSS watchdog
(`--abort-gb`) and per-call 900 s timeout (`--timeout-s`) close the browser on
overrun, preserve partial evidence, and produce a nonzero exit. Choose limits
before running a larger candidate, not after observing its score.

Each behavioral trial retains per-turn input/output counts, generation time,
TTFT, decode time, prefill proxy and decode rate in the **summary result**, not
only in gitignored traces. Summary tables show behavioral success alongside
token workload, latency, throughput and sampled memory. Full runs also measure
cold/warm loads and three repetitions each of approximately 1k/4k prompt tokens
with 256 forced output tokens. Actual token counts are saved because tokenizers
differ. Setup order is sequential, not interleaved.

Interpretation:

- RSS follows the Chrome process tree, including helpers that lack the profile
  path in their command line. It is not JS heap or exclusive model memory;
  shared pages may be counted more than once. Units are converted from `ps`
  KiB to decimal GB using 1024 bytes per KiB.
  V1 counted only command lines containing the profile path and could miss
  helpers. Do not treat v1 and v2 RSS numbers as the same instrument or infer
  a model memory regression from that measurement change alone.
- Peaks are **sampled lower bounds**, not exact allocator high-water marks.
  Very short allocations can fall between samples. Sampling has overhead.
- Apple's IOAccelerator counter is **system-wide**, noisy and platform-specific,
  not per-model VRAM. Never add it to RSS on unified-memory machines.
- Unavailable counters/rates are `null`, never fabricated zeros or Infinity.
- Prefill proxy = input tokens / TTFT, including generation setup, not a pure
  prefill-kernel timer. Decode = (output tokens - 1) / decode interval.
- Cold load means fresh browser Cache Storage with loopback assets and a warm
  OS page cache, **not** an internet-download benchmark.
- Hardware, browser/runtime versions, model pins, harness source hashes, recipe
  hash and tool-layer hash accompany results. A runtime/recipe/tool change is a
  new evaluation condition. Other GPU-heavy work invalidates comparative perf.

Use the same tasks, budgets, trial plan and tool semantics across families;
evaluate generic baselines separately from family-tuned recipes. Do not tune
on held-out traces. A smoke test proves plumbing, not full qualification.
