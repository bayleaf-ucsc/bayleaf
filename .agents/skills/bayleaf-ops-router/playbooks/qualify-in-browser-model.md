---
source-skill: bayleaf-ops-router
description: Qualify a model (or a new revision, dtype, runtime or recipe) for BayLeaf Pouch's Transformers.js provider, from license intake to shipping, with one config-driven harness.
last-reviewed: 2026-11-01
---

# Qualify an In-Browser Model for Pouch

## When

- A candidate model for Pouch's **Transformers.js** provider (LANGUAGE.md
  "Provider"): a new family, size or vendor export.
- Any re-qualification trigger in step 10 for the model that ships
  (`pouch/models.lock.json`).
- Choosing a dtype, or deciding whether to offer users a choice.
- Editing the `transformersjs` profile text in `pouch/src/profiles.ts`.

Canonical facts: `pouch/experiments/lfm3-webgpu/README.md` (capability
boundary, quantization), `pouch/LANGUAGE.md` (Provider; Harness = engine +
profile), `pouch/models.lock.json`. This playbook is the workflow. The harness
is `pouch/experiments/lfm3-webgpu/qualification/`: `qualify.mjs` (runner,
loopback server, verification), `qualify-worker.js` (agent loop and tool
layer), `tasks.mjs` (benchmark), `recipes.mjs` (recipe sources and tool
layers), `summarize.mjs` (tables), `configs/*.json`.

**What is being qualified is a tuned pair.** A recipe and a model succeed
together, not separately. In the quantization run, q8 was the most robust
dtype *without* the recipe (it fixed `yaml`), yet it failed `feature` 8/8
*with* it, while q4f16 went 40/40. A model swap therefore re-qualifies the
recipe too, and a recipe edit re-qualifies the model.

## Gates

- Zero BayLeaf requests. The harness serves only loopback, its CSP has
  `connect-src 'self'`, and every result records `externalRequests` (must be
  0). Nothing in a qualification run touches api.bayleaf.dev.
- Downloads come only from the pinned Hugging Face revision, with `--fetch`,
  after intake (step 1). Check `df -h ~` first. Transformers.js keeps a second
  copy of the weights in the browser profile's Cache Storage, so plan for about
  2x the weights. The `/tmp` profile is deleted after each run.
- Shipping (step 8) is a Pouch deploy: Adam's go-ahead, deploy first, commit
  later, never push unasked (root `AGENTS.md`).

## Steps

1. **Intake, before any download.** Write the answers into the candidate's
   config `comment`, or a short note in the experiment README. Read the model
   card, `config.json`, `chat_template.jinja`, the LICENSE and the Hugging Face
   file tree (`/api/models/<repo>/tree/<rev>/onnx`) through the API, not by
   downloading.
   - **License.** Record the exact name and version. BayLeaf's stance is open
     weights. Apache-2.0/MIT-style passes. **[HUMAN GATE]** Any
     non-permissive, revenue-capped or use-restricted license goes to Adam for
     an explicit decision. One example is LFM Open License v1.0: commercial
     use only below $10M annual revenue, and its nonprofit carve-out covers
     non-commercial use only. That is the license of the model that ships
     today, so record it in `models.lock.json` instead of "see the upstream
     model card".
   - **Architecture support** in the pinned Transformers.js/ORT Web
     (`models.lock.json` `runtime`). Check `model_type` against the
     Transformers.js release notes and PRs. If support needs a version bump,
     that is its own re-qualification of the model that ships (step 10). Run
     it as a separate config with `runtime.expect`. Known hazards include
     hybrid conv/SWA models needing newer ORT kernels (LFM3:
     transformers.js#1839) and `trust_remote_code` architectures with no JS
     port.
   - **ONNX export**: official vendor or `onnx-community` preferred. A
     community export needs its provenance stated: the base revision, how it
     was built, and whether hashes were published. Note which dtypes exist and
     how Transformers.js maps them to file names (`q8` → `model_quantized`).
     Note any external-data shards (`.onnx_data_1`).
   - **Size budget**: total download (aim at ≤ ~1.5 GB, hard bound ~3.5 GB),
     an expected Chrome RSS peak under ~5 GB at 4k context, and shader-f16
     needs (`q4f16`). Cloudflare's 25 MiB per-file limit is not a constraint:
     `build-models.mjs` splits every file into 20 MiB hashed parts
     automatically.
   - **Tool-call format and special tokens.** Production Pouch parses
     Qwen3-Coder-style native XML (`<tool_call><function=…><parameter=…>`).
     Qualification's `model-adapters.mjs` registers XML and Gemma formats;
     shipping another format still needs a parser in `src/local/provider.ts`.
     Check whether the call tags are special tokens.
     MiniCPM5's `<function>`/`<param>` tags are, so a decoder with
     `skip_special_tokens: true` deletes them and calls never parse (Ollama
     #18483). Both workers stream with `skip_special_tokens: false`. Keep it
     that way, and confirm the parser sees the tags. Transformers.js's pipeline
     returned text strips special tokens regardless of its streamer settings:
     qualification consumes the preserved stream instead. A setting alone is
     not proof. Note CDATA, Python-literal
     arrays and how values carry newlines (the LFM3 template wraps each value
     in one `\n`, the root of the byte-fidelity failures).
   - **Chat template**: does it accept `tools` and `enable_thinking: false`?
     Is thinking on by default (LFM3 and Qwen3.5 are)? What sampling does the
     vendor recommend?
   Pass: every item answered with a source; license cleared by Adam if
   gated; parser and runtime work listed.

2. **Pin and hash.** Write `configs/<id>.json` with `model: { repo,
   revision (full sha), dtype, license, files: [{ name, bytes, sha256 }] }`.
   Take sizes and LFS sha256s from the tree API. Small files without LFS need
   hashing after the first fetch: run once with `--fetch`, confirm, then pin.
   `qualify.mjs` refuses any byte mismatch. It hard-links identical files
   already in `~/.cache/bayleaf-pouch/` (shared config/tokenizer files cost
   nothing). On ship, the same entry moves into `pouch/models.lock.json` and
   `node pouch/fetch-models.mjs` must verify it.
   Pass: every file pinned by sha256; a second run prints no `fetched`.

3. **Smoke.** `cd pouch/experiments/lfm3-webgpu/qualification && npm ci`
   (once). Then run
   `node qualify.mjs configs/<id>.json --phase agent --tasks edit --trials 0 --out smoke-<id> --fetch`.
   Chrome runs headless with `--enable-unsafe-webgpu --enable-features=WebGPU`
   in a fresh `/tmp` profile. Pass: the `load` line prints a time (not
   `FAILED`); `node summarize.mjs results/smoke-<id>.json` shows the adapter
   (Apple `metal-3` on the reference machine), 0 external requests, and no
   `parse` failures. In the trace (`results/traces/smoke-<id>.json`), check
   that at least one tool call parsed with the right argument types. A
   `load` error here usually means an unsupported op or architecture (back to
   step 1), not a harness bug.

4. **Baseline, then recipe.** `configs/<id>.json` gets two setups:
   `baseline` (`recipe: "none"`: generic prompt, the same four schemas, no
   few-shot) and `recipe` (`recipe: "profiles"`, the shipped
   `transformersjs` text, imported from `src/profiles.ts`, so what is
   qualified is what ships), both with `toolLayer: "pouch"` (mirrors
   `src/tools.ts`). Tasks: `"core"` (tree, edit, feature, rename, config,
   jsonlist, yaml) plus `heldOut: "all"`. Trials: greedy x1 plus 7 sampled at
   T 0.3/top_p 0.95 (seeds 1–7). Step cap, token budget and max new tokens
   come from the profile (8 steps, 4096 prompt tokens, 512 new). Run
   `node qualify.mjs configs/<id>.json --phase agent` (a 9-task x 2-setup x 8-trial matrix
   takes 15–30 min on the M3 Max; use `background: true`), then
   `node summarize.mjs results/<id>-agent.json`.
   Pass (to ship): recipe core ≥ 52/56, with no task below 6/8; held-out ≥ the
   current model's; zero `parse` and `timeout` failures. Read the failure
   classes: `cap` usually means a loop or a bad path prior, `wrong` means a
   byte-fidelity problem the tool layer may absorb, and `parse` means
   parser or template work.

5. **Recipe tuning, only if step 4 fails.** Write candidate recipes as JSON
   (`{ system, tools, fewshot }`) and reference them by path
   (`"recipe": "recipes/<name>.json"`). Change one thing at a time; agent-v2's
   18 variants showed single changes interact (the multi-edit schema without
   grounding caused tree re-read loops).
   **Overfitting guard:** tune on core only, never look at held-out traces
   while tuning, and report both. A few-shot turn must not resemble a core
   task. The current few-shot (append plus create) resembles `feature`, so
   that row's lift is partly teaching to the test. Add new held-out tasks to
   `HELD_OUT` in `tasks.mjs` (never to `CORE`), and treat a held-out
   regression as a failed candidate even if core improves. Tool-layer changes
   (`src/tools.ts`) count as recipe changes here: they apply to every provider,
   so take them only when the change is honest for all (disclosed in the tool
   description, like newline matching).
   Pass: a candidate meets step 4's bar; core and held-out both reported.

6. **Quantization comparison** (when choosing a dtype). Write one config per
   dtype with identical setups. Run them sequentially and delete each dtype's
   cache directory under `~/.cache/bayleaf-pouch/qualify/` after its run if
   disk is short. Summarize all of them in one call (`node summarize.mjs
   results/<id>-*-agent.json`). **Decision rule:** switch away from the shipped
   dtype only if the candidate gains ≥ +4/40 on the five agent-v2 recipe tasks
   (the `five` column), has no regression on `jsonlist`, `yaml` or held-out
   tasks, and costs ≤ 1.25x the shipped dtype's TTFT and Chrome RSS. Offer users
   a dtype choice only if two dtypes both pass and differ in a way users can
   weigh. The October 2026 result: q4f16 at ceiling, q4 no gain, q8 a
   regression with the recipe.
   Pass: the rule applied and written down with the numbers.

7. **Perf and memory.** `node qualify.mjs configs/<id>.json --phase perf`
    (or `--phase all`). It records the download size, cold load (first load in
   the fresh profile), warm load (page reload, then from Cache Storage), TTFT,
   prefill and decode tok/s at ~1k and ~4k prompt tokens (3 runs each, 256
   forced tokens), the Chrome RSS peak, and GPU deltas. Caveats to state with
   the numbers: assets come from loopback with a warm OS page cache, so "cold"
   is not a network download. The IOAccelerator GPU counter is system-wide and
   noisy (its baseline moved from 2.3 to 9 GB between runs), so trust Chrome
   RSS and relative ordering over absolute GPU deltas. Close other GPU-heavy
    apps. One reference machine (M3 Max, Chrome stable) is not a population.
    The generalized v2 runner defaults to `--phase all` and samples Chrome's
    full process tree during load, agent trials and performance operations.
    Per-turn timing/token metrics are saved in behavioral summaries too.
    Peaks are sampled lower bounds; absent counters are null. V1's profile-path
    command-line matcher could miss renderer/GPU helpers, so its RSS is not
    directly comparable with v2. Re-establish the LFM3 reference with v2 before
    making a cross-family memory decision; do not silently relax the budget.
    Busy-machine timing is diagnostic only, not comparative qualification.
   Pass: decode ≥ ~60 tok/s at ~4k and RSS peak within budget on the
   reference machine; otherwise shrink the context budget or reject.

8. **Integration.**
   - Profile text changes (`TJS` in `src/profiles.ts`) only after re-running
     step 4 with `recipe: "profiles"`. Record the new `recipeSha256` from the
     results file in the README. Proposed (not yet built): a test pinning
     that hash so drift fails CI.
   - `node pouch/test/prompt-node.mjs` (the transformersjs prompt stays
     verbatim, without the UL gloss).
   - A new model or dtype: update `models.lock.json` (id, label, repo,
     revision, dtype, license, files), the worker's `pipeline(...)` dtype in
     `src/local/worker.ts`, and any parser or template changes from step 1.
   - `node pouch/fetch-models.mjs`, `node pouch/build.mjs --with-models`, then
     `node pouch/deploy.mjs --check`.
   - In the real app: run the in-app agent tasks through
     `pouch/test/journeys/t17-local.mjs`, at least greedy. This is the only
     check of Pouch's real tools, pi transcript conversion and context
     trimming, which the harness's tool layer only mirrors.
   - **[HUMAN GATE]** Adam uses the Transformers.js provider on the deployed
     build before it becomes a default.
   Pass: guards green, `--check` clean, t17 greedy passes, Adam's go-ahead.

9. **Record.**
   - An experiment README section (or a new `pouch/experiments/<model>/`):
     the intake answers, tables from `summarize.mjs`, caveats, the decision.
   - Commit `results/<id>-agent.json` and `-perf.json`. Traces
     (`results/traces/`) and smoke runs stay gitignored.
   - Hand a JOURNEYS F4/AX note to Adam's main agent rather than editing
     `pouch/JOURNEYS.md` mid-flight: what the agent can now do on
     Transformers.js, and where it should suggest BayLeaf Sealed.
   - If the model changes: the Provider table in `pouch/LANGUAGE.md` names the
     model, and `pouch/MODELS.md` lists it.
   - On ship: a `pouch/DEPLOYMENT.md` entry (model, revision, dtype, recipe
     sha, results file).
   - Commit message, after Adam's go-ahead, e.g.
     `update: qualify <model> <dtype> for Pouch's Transformers.js provider`.

10. **Re-qualification triggers.** Re-run steps 3, 4 and 7 (and 8's t17) when any
    of these change: the model, its revision, the dtype or export, the
    Transformers.js or ORT Web version, the recipe (system prompt, few-shot,
    tool schemas or descriptions), the tool set or tool semantics/wording in
    `src/tools.ts` (newline matching, error text), the step cap or context
    budget, or a major Chrome version on the reference machine. A
    runtime-only bump uses `runtime.expect` in the config. It must hold every
    core cell within 1/8 and not regress perf by more than 10%.

## Reusing this for Localhost model families

Pouch's **Localhost** provider (`src/localhost.ts`, profile `localhost`) runs
OpenAI-compatible servers on loopback (oMLX, Ollama, LM Studio). Use the same
tasks (`tasks.mjs`, imported as data) and the same trial plan, failure
classes and summary tables, through an OpenAI-compatible driver:
`pouch/test/localhost-omlx.mjs` is the current one. Its comment still points
at `run2.mjs`, and it should import `tasks.mjs`. What differs:

- **Profile per family, not one recipe.** Localhost agents get main's prompt
  and page tools minus subagents (24 steps). Tool calls arrive already parsed
  by the server's own template and parser, so the parser hazards move server
  side (Ollama's special-token stripping is exactly such a bug). Record the
  server version and its tool parser setting.
- **Pinning is weaker.** Model files belong to the user's server. Record the
  server's model id and quantization, and the file hash when the server
  exposes it. Treat results as indicative for that setup, not a pin.
- **No Chrome memory or WebGPU caveats**; measure server RSS and tok/s from
  the server's own usage fields. Context is the server's, so the 4k budget
  does not apply. Test at the profile's real context sizes.
- License and open-weight intake (step 1) applies unchanged.

## Refinement log

### 2026-11-01: Gemma E2B/E4B QAT-mobile evaluation (full matrices and perf)

- Ran three matched 144-trial matrices plus six throughput repetitions each:
  E4B, corrected E2B, fresh LFM3. Verified identical runtime/harness, recipes,
  tool layers and limits across final receipts; zero external requests. Results
  and caveats: `pouch/experiments/gemma4/README.md`. Neither Gemma qualifies;
  LFM3 reproduces core 54/56 and held-out 16/16. No deployment/model change.
- Reality corrected three adapter assumptions: the tokenizer registry cannot
  discover the local alias; pipeline returned text strips special tokens even
  when its streamer preserves them; Gemma emits both bare and JSON-quoted
  argument strings. Explicit pinned tokenizer/template construction and safe
  parser variants were needed. Invalidated the first E2B matrix and reran all
  three final comparisons on the same repaired adapter, without prompt tuning.
- Used text-only QAT-mobile files (2.32/3.36 GB) to stay inside the download
  ceiling. q2f16 is a mixed-QAT artifact label, not uniform two-bit precision.
  Missing standalone LICENSE files were resolved through the cards' linked
  Google Apache-2.0 text; conversion provenance remains weaker than artifact pins.
- Before full matrices, explicitly chose a 20 GB emergency desktop RSS guard
  for measurement, not shipping acceptance. Sampled full-run RSS peaks were
  5.64/11.13/11.57 GB (LFM3/E2B/E4B). Even LFM3 exceeds the old approximate
  5 GB target under the corrected instrument; do not silently call that gate
  passed or reinterpret noisy system GPU deltas as model VRAM.
- Added --fetch-only so the next candidate can download while current GPU work
  runs, without simultaneous models. Monitoring stdout at every milestone
  caused many session wakes and repeated cached-context traffic; future long
  batches should favor one completion event and durable logs over chatty wakes.

### 2026-11-01: generalized harness and resource instrumentation (partial run)

- Kept historical paths and added `pouch/qualify-model.mjs` as the neutral entry.
  Added explicit loader/tool-format adapters and Gemma parser/transcript tests;
  Gemma weight loading and qualification remain pending.
- Found that old RSS sampling could omit helpers without the profile path in
  their command line. V2 follows the Chrome process tree, samples operation
  peaks and retains per-turn performance in behavioral results. The old RSS
  budget needs a same-instrument LFM3 reference, not an automatic relaxation.
- Standard `all` now runs behavior and standalone perf; `agent` still records
  trial memory and per-turn timings. Tests cover null counters, failed-operation
  measurements and legacy/partial/context summary rendering. Direct cache
  sweeps retain LFM3-specific assumptions and reject other families explicitly.
- This is instrumentation/regression work, not a full step-4 qualification or
  a model/default change. No new weights, production deployment or publication.

<!-- One dated entry per run: what differed from these steps, what surprised you,
what you fixed. This playbook has not yet guided a full qualification. -->

### 2026-11-01: shipped LFM3 q4f16 recipe, re-qualification (first real use)

Scope: step 4 only, as a recipe re-qualification (step 10 trigger: the shipped few-shot
tool-result wording had never been run verbatim). Config `configs/lfm3-q4f16-requal.json`, four
setups (shipped, v8-pouch, v8-v8, baseline) x 9 tasks x 8 trials, 288 trials in ~30 min, 0
external requests, cached weights verified, nothing fetched. Result: shipped core 54/56,
held-out 16/16, zero parse/timeout: passes; identical to v8 text on the Pouch tool layer; v8 on
its own tool layer 56/56. Write-up: experiment README "Shipped recipe qualification (2026-11-01)".

- Matched: steps 2–4 ran as written; `lockId` reuse, hash verification, the summarize tables and
  failure classes needed no changes. The step-4 bar was decisive.
- Deviated: added setups beyond baseline/recipe to separate *recipe text* from *tool layer*. That
  split was the finding (the text was irrelevant; the 2/8 `feature` loss follows the tool result
  format). Step 4 should say: when comparing against a frozen recipe, also run it on the shipped
  tool layer, or the comparison confounds text and tools.
- Deviated: the harness runs setups sequentially, not interleaved; under shared-GPU load,
  conditions are equal only to the extent the load is steady. Consider a `--interleave` option
  (trial-major order) for A/B runs.
- Gap: step 4 gives no rule for comparing two passing recipes. Step 6's ±4/40 `five` threshold was
  borrowed; state it in step 4 too, and say that n = 8 cannot resolve 2/8 differences (check
  whether failing seeds coincide before calling a regression).
- Gap: `recipeSha256` hashes the recipe only, not the tool layer, so v8-pouch and v8-v8 share a
  hash. Record the tool layer alongside it (step 8's proposed hash pin should cover both).
- Step 7 (perf) skipped: another agent was running browser tests concurrently. Note in step 7
  that a busy machine invalidates perf but not pass rates.
