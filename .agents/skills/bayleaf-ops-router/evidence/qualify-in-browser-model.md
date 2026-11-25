# Run evidence: qualify-in-browser-model

Dated record of past runs of [`qualify-in-browser-model.md`](../playbooks/qualify-in-browser-model.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

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

## Moved from the body

Original wording, verbatim, as it stood in the procedure.

What is being qualified:

```text
succeed
together, not separately. In the quantization run, q8 was the most robust
dtype *without* the recipe (it fixed `yaml`), yet it failed `feature` 8/8
*with* it, while q4f16 went 40/40. A model swap therefore re-qualifies the
recipe too, and a recipe edit re-qualifies the model.
```

Step 1, license:

```text
non-commercial use only. That is the license of the model that ships
     today, so record it in `models.lock.json` instead of "see the upstream
     model card".
```

Step 5, recipe tuning:

```text
Change one thing at a time; agent-v2's
   18 variants showed single changes interact (the multi-edit schema without
   grounding caused tree re-read loops).
```

Step 6, quantization decision rule:

```text
 Offer users
   a dtype choice only if two dtypes both pass and differ in a way users can
   weigh. The October 2026 result: q4f16 at ceiling, q4 no gain, q8 a
   regression with the recipe.
```

Step 7, GPU counter caveat:

```text
The IOAccelerator GPU counter is system-wide and
   noisy (its baseline moved from 2.3 to 9 GB between runs), so trust Chrome
   RSS and relative ordering over absolute GPU deltas.
```

Step 7, memory reference:

```text
    directly comparable with v2. Re-establish the LFM3 reference with v2 before
    making a cross-family memory decision; do not silently relax the budget.
```

Localhost driver (since fixed in the repo):

```text
`pouch/test/localhost-omlx.mjs` is the current one. Its comment still points
at `run2.mjs`, and it should import `tasks.mjs`. What differs:
```
