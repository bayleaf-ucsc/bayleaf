# LFM3 browser WebGPU qualification

**Verdict: technically viable local inference and offline tool use on this Mac, but not qualified as a byte-precise general coding agent or as a mobile implementation.** No Pouch integration is authorized or implemented. No public deployment, commits, cloud inference or automatic remote fallback occurred.

Qualification ran October 29, 2026 on Apple M3 Max, 64 GiB RAM. The initial worktree was accidentally deleted by the user during testing. Adam explicitly authorized rebuilding in the current tree. All final evidence below was rerun and retained here; the earlier lost results are not relied upon. The current repository branch is `main`, rather than the original worktree's `pouch` branch. Only this new qualification directory was created in the current tree.

## Gates and evidence

| Gate | Verdict | Evidence |
|---|---|---|
| Actual local WebGPU generation | PASS | `results/baseline.json`: correct Paris answer, 2,633 compute dispatches, 212 queue submissions |
| Native-format bounded tools | PARTIAL | `results/agent.json`: 12/15 strict fixture passes; all calls parsed, no runtime/round-limit failures |
| Precise three-file modification | FAIL | 0/3 strict byte checks: an extra blank line was added in every trial |
| Complete installed-profile offline reload | PASS | `results/offline.json`: full reload, new worker/model, generation and byte-correct tool loop |
| Browser restart while offline | PASS | `results/restart-offline.json`: same persistent profile, no previous model in memory, generation/tool loop pass |
| Fresh uninstalled profile offline | EXPECTED FAILURE | `results/fresh-offline.json`: navigation visibly fails, no fallback |
| Ten-turn state/fact retention | PARTIAL | `results/resources.json`: correct fact recall/edits, but final newline lost and stray reasoning tags emitted |
| Resource/performance characterization | PARTIAL | Three 384-token warm runs, cancellation and bounded context probes; total memory and thermal limits unmeasured |
| Strict same-origin worker CSP | PASS | Actual GPU generation and offline tools, without JS unsafe-eval, CDN scripts or blob worker permissions |
| Unchanged API-only connect-src | FAIL for tested loader | `results/csp-api-only.json`: actual worker CSP violation blocks same-origin config fetch |
| WASM without wasm-unsafe-eval | FAIL as expected | `results/csp-no-wasm.json`: actual wasm-eval CSP violations prevent runtime initialization |
| Real mobile inference | UNTESTED | No phone connection/setup available; no emulation-based hardware claims |

Machine-readable aggregate: `results/summary.json`. Full prompts, raw model output, rendered chat templates, parsed calls, tool results, byte snapshots and timing/dispatch counters: phase JSON files under `results/`. Reproducible commands: `README.md`.

## 1. Known-good inventory

- Browser: installed Google Chrome **156.0.8078.73**, headed, new isolated persistent profile. User-agent exposes Chrome 156 with macOS compatibility text, not the hardware identity. Runner uses `--enable-unsafe-webgpu`; qualification without that launch flag has not been established.
- Adapter: `apple`, architecture `metal-3`, `shader-f16`. Browser-reported max buffer/storage-buffer binding sizes: 4,294,967,292 bytes. This is browser WebGPU, not native Metal inference.
- Runtime: `@huggingface/transformers@4.3.2`, bundled ONNX Runtime common `1.31.0-dev.20260911-2a43ec07e`, Web `1.31.0-dev.20260914-8d85527a0`. Matching asyncify MJS/WASM are served locally. WASM orchestration/tokenization does not invalidate the measured GPU compute work or imply all operations run on GPU.
- Model: `onnx-community/LFM3-1.7B-ONNX`, revision **ab9fec4c681a25bec3b48b0b97a62fc2660a2985**, `q4f16`, explicit WebGPU device. No MLC/wllama paths retried.
- Assets: **11 files, 1,134,290,334 bytes** total (asset sizes, not wire/compression accounting). `assets-manifest.json` contains every public source URL, final download hostname, exact bytes and SHA-256. Hosts: `cdn.jsdelivr.net`, `huggingface.co`, redirect host `us.aws.cdn.hf.co`. No signed redirect URLs retained.

| Asset | Bytes |
|---|---:|
| Transformers.js | 1,352,822 |
| ORT asyncify MJS | 53,057 |
| ORT asyncify WASM | 26,861,777 |
| Model config | 1,549 |
| Generation config | 241 |
| Tokenizer | 17,908,635 |
| Tokenizer config | 14,262 |
| Special-token map | 92 |
| Chat template | 12,129 |
| q4f16 ONNX graph | 296,714 |
| q4f16 external weights | 1,087,789,056 |

The tokenizer config embeds the same 12,129-byte template as `chat_template.jinja` (SHA-256 `f45005c50cd2a97329722bf3a2dee9f16c04cdf825a589b280fb7e99e6827818`). Actual rendering uses that published template with `enable_thinking:false`, tools supplied as structured schemas, tool-call argument mappings rather than JSON-encoded strings, and tool-role results. Native calls are XML-style `<tool_call><function=...><parameter=...>`, not OpenAI JSON tool output.

Transformers.js pipeline and AutoTokenizer local-alias metadata discovery did not find the tokenizer. The harness constructs the library's `PreTrainedTokenizer` directly from the two pinned JSON assets after loading the pipeline. No runtime source patching was needed. This workaround belongs in any future loader qualification, not just the prompt.

The initial fresh-profile **locally served** model/tokenizer load was 1,647 ms; Paris generation 168 ms, first callback 91 ms, eight callbacks. This excludes asset download and is not cold internet timing or sustained throughput. Later profile loads were about 0.78–0.82 seconds. Existing earlier browser caches were not intentionally cleared; all HTTP-cache clearing here targets newly launched isolated test profiles.

The harness dependencies (`just-bash` 3.6.0, esbuild 0.28.2, playwright-core 1.58.2) are pinned with npm package-lock integrity and public registry URLs. Their installation/build machinery is separate from the inference-asset byte total above. `tools.bundle.js` is generated locally and its SHA-256 is recorded in the summary, not downloaded as opaque agent tool code.

## 2. Bounded agent-loop qualification

The published template actually produced usable native calls. A dedicated worker implements real read/write/edit and just-bash over a tiny in-memory fixture. Tool errors, output and subsequent model responses are recorded. No host files, credentials, live mounts, unrestricted network, real shell processes, or generated-code evaluation are available. Pouch's source tool semantics were read before deletion and adapted, not integrated. Exact-match edit refuses zero/multiple matches before writing. The error-recovery conditions are real failing tool calls deliberately injected into the starting conversation, not claims that the model independently made those mistakes.

Bounds: eight model/tool rounds per task; at most eight calls per round; 384 output tokens per generation; 8,192 input-plus-output harness context cap; 120-second between-round task deadline; three-second shell abort signal and 1,000-command/loop limits. A wedged GPU operation is not hard-preempted by that between-round deadline. The tested explicit interruption mechanism is described below.

| Task | Strict passes | Model rounds | Tool calls | Task duration range |
|---|---:|---:|---:|---:|
| Inspect unfamiliar tree and summarize | 3/3 | 4 | 5 | 4.37–4.61 s |
| Exact one-file offset correction | 3/3 | 3 | 2 | 1.53 s |
| Three-file feature/config/documentation | 0/3 | 3 | 5 | 2.93–3.02 s |
| Recover from missing converter filename | 3/3 | 4 | 3 | 2.20–2.23 s |
| Recover from ambiguous replacement | 3/3 | 3 | 2 | 1.64–1.65 s |

All requested three-file functional changes occurred, but the model inserted an unrequested blank line before the new export. The full-workspace byte oracle correctly rejected this. It nevertheless claimed completion, an AX/correctness issue relevant to Pouch's minimal-change policy. No prompt tweaking was used to redefine this failure away. Greedy repeated trials were deterministic and not independent stochastic samples. Peak input in these fixtures was only 765 tokens. This is not evidence of broad repository-level coding reliability. The upstream model card itself cautions against agentic coding/complex multistep reasoning; these controlled successes do not overturn that warning.

The experimental parser supports only the four tools' string arguments. Exhaustive native-format/schema validation, escaped delimiter handling, mixed complete/incomplete calls and malformed/truncated output need hardening before any production adapter. The harness does not claim Pouch's paging, multi-edit/replaceAll, binary handling, live mounts, egress commands, subagents or UI change hooks are qualified. It does not test a fuller Pouch system prompt; adding unavailable tool instructions would introduce a different condition.

## 3. Offline boundary, storage and CSP

### What was actually disconnected

The installer primed the document, application script, inference worker, just-bash bundle, service worker, asset manifest and **all eleven** asset files. After priming, Chrome's HTTP cache was cleared and disabled with CDP, and the browser context was set offline. A full document reload created a new inference worker and model instance. Correct Paris generation and byte-correct read/edit/final response passed. Recorded application request events include workers and service workers: nine same-origin requests on reload, **zero external attempts**, not merely zero successful external responses. These are browser application observations, not a claim to inspect all browser/OS background traffic.

The runner then closed that browser process. A subsequent launch of the same isolated profile, offline before navigation, cleared/disabled HTTP cache again and passed generation/tool use. Thus the evidence distinguishes:

- Warm same-tab inference: demonstrated, but insufficient alone.
- Cache Storage-backed full reload: demonstrated, with no loaded-model reuse.
- Actual browser restart, same installed profile: demonstrated.
- Browser HTTP cache: explicitly cleared/disabled for these offline gates, not the required source of assets.
- Cache Storage: `transformers-cache` for runtime model caching plus `lfm3-qualification-v1` for the complete installed app.
- IndexedDB: no databases reported.
- Fresh profile, cold offline: visibly fails before app load, as expected without installed assets.

Total origin storage was about **2.23 GB**, with approximately 12.97 GB quota at measurement time. The simple installer duplicates weights between its whole-app cache and the library cache. `navigator.storage.persisted()` returned **false**. No persistent-storage permission was requested. Eviction/disk pressure, browser policy, private browsing, profile deletion and origin changes can remove availability. Installed assets are not a guarantee of permanent offline access. Interrupted installation, eviction of one cache, runtime upgrade and corruption recovery have not been tested.

All browser asset requests target loopback. The app contains no inference API client and no remote fallback. CSP reserves `api.bayleaf.dev` only to explore future coexistence with Sealed; **no Sealed/Tinfoil requests occurred**. Local prompts/results never leave the browser. Asset downloading still exposes normal download/network metadata to the asset hosts. Local and remote execution must remain explicit separate choices in any future Pouch mode.

### Experimentally tested policy

```text
default-src 'none';
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self';
connect-src 'self' https://api.bayleaf.dev;
style-src 'self'; img-src 'self';
base-uri 'none'; object-src 'none'
```

COOP `same-origin` and COEP `require-corp` were also served. The dedicated module worker, same-origin runtime MJS/WASM and single WASM thread ran under this policy. **JavaScript `unsafe-eval` and `blob:` worker permission were not needed.** This validates the tested single-threaded architecture, not every ORT threading/proxy configuration or Pouch's full UI CSP.

Two negative controls establish actual restrictions:

1. With exactly `connect-src https://api.bayleaf.dev`, the worker reports a **connect-src violation on same-origin model/config.json** and fails visibly. The tested fetch-based loader therefore cannot retain that exact worker policy unchanged merely because its files are same-origin or cached. It needs a narrowly scoped same-origin connection allowance. A differently packaged loader or independently served worker CSP might preserve a stricter main-document policy, but that alternative was not qualified.
2. Removing `wasm-unsafe-eval`, while retaining same-origin connections, produces **wasm-eval script-src violations** and ORT backend initialization failure. The Chrome error text mentions unsafe-eval generically, but the successful positive control needs only the narrower **wasm-unsafe-eval**, not JavaScript unsafe-eval.

No production CSP was edited. API-only and no-WASM policies ran on separate loopback ports 8769 and 8770 with their own test profiles.

### Asset supply chain is a separate trust boundary

Model revision, runtime versions and all inference-asset hashes are pinned. Host-side download code records hashes; **the browser installer does not yet enforce them**. Cache version v1 also needs explicit upgrade/invalidation; it will otherwise serve old application bytes. A future installer should verify an authenticated/versioned manifest, hash assets before atomic activation, avoid duplicated weights, retain a known-good version until upgrade succeeds, and expose readiness/missing-asset errors. Hashes establish identity, not that the community ONNX graph/tokenizer/runtime is benign. Runtime JS/MJS/WASM and tools are executable supply-chain inputs; model/export/template provenance remains a separate concern from remote inference privacy. No signature/authenticated-release verification was qualified.

## 4. Multi-turn, context, interruption and resources

Ten successive user turns completed, including read/edit/write/append, fact recall without rereading and final summary. Histories and file snapshots are replayed between turns; this qualifies transcript-backed state retention, **not persistent KV reuse**. Inputs grew from 383 to 1,357 tokens. Original/current color, project name and count were recalled correctly. The facts file ended byte-correct. The marker file ended `READY\nDONE` instead of required `READY\nDONE\n`, while the model claimed a final newline existed. Two outputs included stray `</think>` and duplicate explanatory text despite thinking disabled. Final exact-bytes oracle therefore fails; state retention is useful but not fully precise.

Three warm sustained runs each reached the configured 384-token output cap:

| Run | Generation | TTFT | Post-first-token callback rate |
|---|---:|---:|---:|
| 1 | 3,173 ms | 44.8 ms | 122.4/s |
| 2 | 3,125 ms | 44.7 ms | 124.4/s |
| 3 | 3,084 ms | 45.1 ms | 126.1/s |

Each recorded 124,089 GPU compute dispatches and 9,425 queue submissions. Rate is `(callback_count - 1) / (last_callback_time - first_callback_time)`, not end-to-end task throughput. These are short, capped, greedy laptop samples after warmup, not completed 350-word responses, a thermal soak, multiuser performance or advertised mobile performance. Hardware power/temperature were not controlled.

A 500-ms interrupt request returned in **506 ms**, with 51 callbacks and the stopping criterion marked interrupted. Subsequent generation returned **OK.** This tests generation interruption, not transactional cancellation/rollback across an agent's prior edits or device-loss recovery.

A **3,616-token** input ran in 2,294 ms with TTFT 2,101 ms, without graph/runtime failure, but failed the exact `READY` instruction. A separate 18,012-token input was rejected before generation by the harness's 8,192-token cap. The published 262,144-token model context is **not qualified**. No explicit 256-token chunked-prefill implementation was added; accepted graph input shapes are not proof of long-context/state correctness or compliance with the upstream export's prefill guidance. Maximum safe context and behavior near 8,192 remain untested.

Main-page heap telemetry was about 8.4 MB and explicitly excludes the worker, WASM/GPU allocations and much of model memory. It is **not total model memory**. The memory-measurement API exists but no full worker/GPU peak-memory measurement was performed. GPU OOM/device-loss and storage eviction remain untested.

No adb executable or connected-phone workflow was available. No phone setup or mobile browser inference was attempted. Desktop viewport emulation would test UI only, not actual mobile WebGPU support, memory, load time, decode or battery. **Mobile status: UNTESTED.**

## 5. Minimum future work, proposal only

1. Add an explicitly selected optional local provider adapter, keeping Sealed separate. No automatic fallback in either direction. Show which engine runs before accepting prompts; fail visibly when assets/GPU are unavailable.
2. Implement a versioned same-origin asset installer with authenticated hashes, quota/persistence UX, atomic ready state, cache deduplication and tested offline upgrade/repair. Keep executable app/runtime supply chain distinct from model/export provenance.
3. Keep inference in a dedicated worker. Requalify minimum CSP directives against Pouch's actual policy and hosting. The tested loader needs same-origin connections plus wasm-unsafe-eval; do not broadly enable JS unsafe-eval or arbitrary network access.
4. Adapt actual native XML calls and template histories to the existing tool interface with strict schema/format validation, cancellation and truncation handling, traceability and conservative context/output limits. Handle reasoning delimiters without hiding tool outcomes or silently rewriting generated file content.
5. Preserve byte-level tests and diff/review controls. Add harder unfamiliar tasks, varied trials/prompts, realistic code fixtures, long-context correctness, error/cancel/device-loss tests, peak memory and actual phone qualification before making reliability claims.

**Practical recommendation:** continue treating this as an optional local-mode research candidate. Local text generation, small real tool loops and complete installed-profile offline operation are demonstrated. Exact editing reliability, context/resource limits and mobile portability do not yet justify treating it as a drop-in Pouch coding backend.
