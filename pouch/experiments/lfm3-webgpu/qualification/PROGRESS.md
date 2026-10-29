# LFM3 qualification progress

Scope: isolated local WebGPU experiments only. Existing experiment and Pouch sources are read-only inputs. No remote inference or fallback. Branch observed: `pouch`.

## Started

Read experiment README and repository AGENTS.md. Existing smoke-test files preserved. Port 8768 is free. A new browser profile will keep prior browser caches untouched. Next gate: reproduce generation and record pinned assets/GPU work.

## Milestone 1: known-good local WebGPU starting point

PASS, evidence `results/baseline.json`, `assets-manifest.json`. Chrome 156.0.8078.73, Apple `metal-3`, shader-f16, Transformers.js 4.3.2, ORT Web 1.31.0-dev.20260914-8d85527a0. Model revision ab9fec4c681a25bec3b48b0b97a62fc2660a2985, q4f16. Paris answer reproduced with 2,633 dispatches and 212 submissions. Warm model load 925 ms; generation 725 ms, TTFT 413 ms, eight callbacks. Not sustained throughput.

All 11 runtime/model/tokenizer/template assets downloaded with hosts, bytes and SHA256 recorded. All browser requests are localhost, no inference server. Existing caches preserved; new profile uses Cache Storage `transformers-cache`, approximately 1.088 GB, no IndexedDB databases. Persistence false, quota approximately 11.83 GB. Initial local-alias tokenizer discovery failures preserved in separate JSON results, fixed by constructing the runtime tokenizer from its two pinned JSON assets, without modifying runtime code. Dedicated worker runs with experimental strict CSP, no unsafe-eval or blob worker permission; zero CSP violations. Next gate: actual native XML tool calls and byte-checked bounded agent trials.
