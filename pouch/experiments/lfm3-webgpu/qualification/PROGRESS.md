# LFM3 qualification progress

Scope: isolated local WebGPU experiments only. Existing experiment and Pouch sources are read-only inputs. No remote inference or fallback. Branch observed: `pouch`.

## Started

Read experiment README and repository AGENTS.md. Existing smoke-test files preserved. Port 8768 is free. A new browser profile will keep prior browser caches untouched. Next gate: reproduce generation and record pinned assets/GPU work.

## Milestone 1: known-good local WebGPU starting point

PASS, evidence `results/baseline.json`, `assets-manifest.json`. Chrome 156.0.8078.73, Apple `metal-3`, shader-f16, Transformers.js 4.3.2, ORT Web 1.31.0-dev.20260914-8d85527a0. Model revision ab9fec4c681a25bec3b48b0b97a62fc2660a2985, q4f16. Paris answer reproduced with 2,633 dispatches and 212 submissions. Warm model load 925 ms; generation 725 ms, TTFT 413 ms, eight callbacks. Not sustained throughput.

All 11 runtime/model/tokenizer/template assets downloaded with hosts, bytes and SHA256 recorded. All browser requests are localhost, no inference server. Existing caches preserved; new profile uses Cache Storage `transformers-cache`, approximately 1.088 GB, no IndexedDB databases. Persistence false, quota approximately 11.83 GB. Initial local-alias tokenizer discovery failures preserved in separate JSON results, fixed by constructing the runtime tokenizer from its two pinned JSON assets, without modifying runtime code. Dedicated worker runs with experimental strict CSP, no unsafe-eval or blob worker permission; zero CSP violations. Next gate: actual native XML tool calls and byte-checked bounded agent trials.

## Milestone 3: agent failure diagnosis and v2 qualification (2026-10-29)

- Assets were absent after restore; re-ran `download.py`: 11 files, 1,134,290,334 bytes, all SHA256/bytes match `assets-manifest.json` (original manifest restored to keep its recorded hosts).
- Diagnosis of `results/agent.json` feature 1–2: NOT an 8-step loop. Both ended `final` after 3 generations (~2.9 s). Tool XML, parser and template are correct; the only wrong byte is a blank line the model inserted in `src/ui.js` (`newText` = label line + `\n\n` + unit line). Greedy decoding made both trials identical. The run also stopped before missing/ambiguous trials.
- Headless Chrome (fresh /tmp profile) WebGPU OK on apple metal-3. Perf (results/agent-v2-perf.json): 960-tok prompt prefill ~2.2k tok/s (TTFT ~0.43 s), decode ~113 tok/s; 3,780-tok prefill ~1.6k tok/s (TTFT ~2.35 s), decode ~65–73 tok/s.
- New tasks rename/config added (run2.mjs). Greedy rename fails at round limit: model greps hallucinated /workspace; just-bash grep returns empty-stderr exit 1 ('ERROR:  [exit code 1]'), 6 of 8 rounds lost before pwd. Added v6/v7 'grounded' variants (cwd named in system, informative empty-error).
- Deeper root cause: trailing-newline encoding in native XML <parameter> values (template wraps value in one 
 each side). Model is inconsistent: 'Fahrenheit
</parameter>' (no final newline after parse), asymmetric oldText/newText endings (few-shot run left 'unit = "F";

'), or a blank line between declarations. Fidelity prompt and few-shot do not fix byte-exactness (0/20 so far). Added disclosed tool-side newline normalization variants v8/v9.
- v6–v9 run: grounding (cwd named, informative empty grep error) unlocks rename; v8 grounded+few-shot+newline-normalized tools passes 39/40 over all 5 tasks (feature 7/8 byte-exact). Few-shot alone or normalization alone does not; multi-edit schema without grounding caused tree re-read loops.
- Wrote results/agent-v2.json (18 variants x 5 tasks, perf, memory) and README 'Capability boundary' section with Local-lane scope and integration needs. Zero external requests in all v2 runs; only console error is a 404 (likely favicon). Server on 8768 stopped.
