# Small local models for BayLeaf Pouch: MiniCPM5-2B vs LFM3-1.7B (survey, 2026-11-01)

Scope: Is MiniCPM5-2B (OpenBMB) a better, or at least reasonable, alternative to LFM3-1.7B (Liquid AI) as Pouch's small local model? Pouch runs it two ways: in-browser (Transformers.js / ORT-Web on WebGPU, q4f16, about 1–2 GB, about 4k context) and native (oMLX, 4–8 bit).
Method: primary sources (HF model cards, configs, file trees, vendor blog, GitHub issues and PRs, Artificial Analysis). No downloads, no runs.
Disciplines in play: ML evaluation methodology (who measured what), systems (runtimes, quantization, tokenizer and parser plumbing), licensing and political economy (Apache-2.0 vs a revenue-gated license).

## 1. Release order (did "newest in size class" hold?)

| Model | HF repo created | Announcement |
|---|---|---|
| Qwen3.5-2B / 4B | 2026-02-27/28 | Qwen3.5 blog |
| Gemma 4 E2B-it | 2026-03-02 | Google |
| MiniCPM5-1B | 2026-05-21 | card |
| granite-4.2-3B | 2026-08-07 | IBM |
| LFM2.5-2.6B | 2026-07-28 | Liquid |
| **MiniCPM5-2B** | 2026-09-05/06 | AA article 2026-09-07 |
| **LFM3-1.7B** | 2026-10-23 (GGUF/ONNX 10-24, MLX 10-27) | Liquid blog dated 2026-10-27 |

Yes: LFM3-1.7B is about seven weeks newer than MiniCPM5-2B. It is also the only one of the two whose launch compares against the other: Liquid's blog benchmarks MiniCPM5-2B, while OpenBMB's card predates LFM3. So the heuristic picked the newest model, and that model's vendor claims to beat MiniCPM5-2B. Those are vendor numbers, though, and they partly contradict OpenBMB's numbers for the same model (see section 3).

Sources: HF API `https://huggingface.co/api/models?search=...` (createdAt fields); https://www.liquid.ai/blog/lfm3 ; https://artificialanalysis.ai/articles/openbmb-releases-minicpm5-2b

## 2. Specs

| | MiniCPM5-2B | MiniCPM5-1B | LFM3-1.7B | LFM2.5-2.6B | Qwen3.5-4B | Qwen3.5-2B |
|---|---|---|---|---|---|---|
| License | Apache-2.0 | Apache-2.0 | LFM Open License v1.0 (commercial use only below $10M annual revenue; the nonprofit carve-out covers non-commercial/research use only) | LFM Open v1.0 | Apache-2.0 | Apache-2.0 |
| Params | 2.52B total, 1.98B non-embedding (untied embeddings) | 1.08B (0.68B non-emb) | 1.73B (tied embeddings) | 2.6B | ~4.7B incl. vision | ~2.3B incl. vision |
| Architecture | Plain `LlamaForCausalLM`, 42 layers, GQA 16q/2kv, dense | Llama, 24 layers | Tri-hybrid, 24 layers: 13 gated short-conv (k=7), 5 SWA (256-token window), 6 global attention (partial RoPE, head-gated, sandwich norm); `trust_remote_code` | conv+attn hybrid | 8×(3×Gated DeltaNet + 1×Gated Attention), 32 layers, MTP, vision encoder | same family |
| Context | 131,072 | 131,072 | 262,144 | 128K | 262,144 | 262,144 |
| Vocab | 130,560 | | 128,000 | 65K | 248,320 | 248,320 |
| Thinking | Reasoning model; `enable_thinking` switch in template; trained mostly on deep-thinking SFT; recommended temp 1.0 | hybrid think | Thinking on by default; `enable_thinking=False` is "inconsistent" per card; recommended temp 0.1 for agents | | Thinking on by default | |
| Tool-call format | `<function name="x"><param name="k">v</param></function>`, CDATA for values with `<`, `&`, newlines; **the tags are special vocab tokens**; arrays/objects rendered as Python literals | same | Qwen3-Coder-style XML: `<tool_call><function=x><parameter=k>v</parameter></function></tool_call>`; deferred-tool search support | | Qwen3-Coder XML (`qwen3_coder`) | |

Sources: https://huggingface.co/openbmb/MiniCPM5-2B (README, config.json, chat_template.jinja); https://huggingface.co/openbmb/MiniCPM5-1B ; https://huggingface.co/LiquidAI/LFM3-1.7B (README, config.json, LICENSE); https://huggingface.co/Qwen/Qwen3.5-4B

## 3. Benchmarks: three vendors, three different scoreboards

All numbers in this section are vendor-reported. Where a vendor measures a rival, the number is still vendor-run and not independent.

| Benchmark | MiniCPM5-2B (OpenBMB) | MiniCPM5-2B (Liquid-run) | LFM3-1.7B (Liquid) | Qwen3.5-4B (Qwen) | Qwen3.5-4B (OpenBMB-run) | Qwen3.5-4B (Liquid-run) | LFM2.5-2.6B (OpenBMB-run / Liquid) |
|---|---|---|---|---|---|---|---|
| BFCL v4 | 66.6 | 62.65 | **71.39** | 50.3 | 56.8 | 55.12 | 61.1 / 55.89 |
| τ²-Telecom | 97.1 | – | – | TAU2 79.9 | 92.1 | – | 90.4 |
| τ³-bench | Banking 20.8 (AA) | 69.44 | 68.01 | – | 6.8 (AA) | 65.98 | – |
| ToolSandbox | – | 68.16 | **80.36** | – | – | 75.40 | 78.04 |
| MCP-Atlas | – | 26.38 | 32.57 | – | – | 41.37 | 16.45 |
| SWE-bench Verified | **46.4** | 34.8 (OpenCode) | 43.4 (OpenCode) | – | 33.6 | 41.2 | 6.0 / 18.0 |
| Terminal-Bench 2.1 | 8.6 (AA) | 5.62 | 12.92 | – | 25.8 (AA) | 13.48 | 4.5 / 0 |
| LiveCodeBench v6 | 69.1 | 70.52 | 73.46 | 55.8 | 56.4 | 61.99 | 42.1 / 60.57 |
| IFEval | 86.7 | 87.83 | **96.66** | 89.8 | 90.2 | 92.52 | 93.4 / 95.39 |
| IFBench | 66.3 | 62.08 | **73.03** | 59.2 | 59.0 | 38.16 | 59.0 / 60.48 |
| Multi-IF | 71.8 | 73.19 | 89.10 | – | 73.6 | 80.32 | 76.8 / 84.8 |
| MMLU-Pro | 70.8 | – | – | 79.1 | 78.0 | – | 65.2 |
| GPQA-D | 70.2 (AA) | 65.15 | 63.37 | 76.2 | 77.1 (AA) | 75.76 | 55.8 |
| AA-LCR | 59.0 (AA) | 49.34 | 52.83 | 57.0 | 61.0 | 52.67 | 5.3 / 6.0 |
| Claw-type agent evals | Claw-Gym 59.2, QwenClaw 42.9 | LiveClaw 30.37 | LiveClaw 45.6 | – | Claw-Gym 51.6 | LiveClaw 19.94 | |
| Vendor's overall avg | 53.9 (own suite) | 39.19 (Liquid suite) | 49.37 (Liquid suite) | | 51.1 (OpenBMB suite) | 39.27 (Liquid suite) | |

Readings:
- Each vendor wins its own suite. OpenBMB's suite tilts toward math, competitive code and SWE-bench; Liquid's suite tilts toward instruction following, BFCL, ToolSandbox and Claw/agent-harness tasks. This is the familiar benchmark-selection effect (Goodhart pressure on model cards).
- Disagreements on the same model: SWE-bench Verified for MiniCPM5-2B is 46.4 by OpenBMB and 34.8 by Liquid (Liquid used an OpenCode harness). Qwen3.5-4B IFBench is 59.2 by Qwen and 38.16 by Liquid. Expect harness and sampling settings to move numbers by 10+ points at this size.
- Consistent across vendors: LFM3 leads on instruction following (IFEval/IFBench/Multi-IF) and on BFCL. MiniCPM5-2B is stronger on knowledge/reasoning (GPQA, MMLU-Pro, HLE) and long context. Both are roughly even on SWE-bench-type coding depending on who measured. Liquid's own card says LFM3-1.7B is "not recommended for agentic coding or complex multi-step reasoning."
- Independently measured: Artificial Analysis (AA) evaluated MiniCPM5-2B (2026-09-07). It scored 15 on Intelligence Index v4.2, the top open-weights model under 4B params at that time (Qwen3.5-4B Reasoning 14, estimated; Granite 4.2 3B 11). It scored τ³-Banking 21%, GDPval-AA Elo 831, Terminal-Bench 2.1 9%, used 19k output tokens per task (11k of them reasoning), and attempted only 29% of AA-Omniscience questions, which gives it a high abstention/non-hallucination rate. **AA has not yet published LFM3** (the model page 404s and the Liquid creator page has no LFM3 entry as of 2026-11-01). No BFCL leaderboard entry was found for either.
- Community, single-source and anecdotal: a MacPaw engineer (quoted in Liquid's own blog, so not independent) reports LFM3-1.7B beat Qwen3.5-2B on 65 macOS agent tasks, 64% vs 48% success, stuck rate under 1% vs 15%. MindStudio's hands-on test (2026-10-28; https://www.mindstudio.ai/blog/liquid-ai-lfm3-1-7b-local-agent-model) passed JSON extraction, IF and dual tool calls, but **failed a bug-fix agent task (claimed success without changing anything) and an HTML/JS fix twice**. An X post by @PaulGug says LFM3 "finished all 18 agent loops" and nearly matched a 4B on schedule-and-draft tasks.

Sources: MiniCPM5-2B card eval table (OpenBMB; † marks rows taken from AA); Liquid blog LFM3 table; Qwen3.5-4B card; https://artificialanalysis.ai/articles/openbmb-releases-minicpm5-2b ; https://artificialanalysis.ai/models/minicpm5-2b

## 4. Runtime availability and known issues

### In-browser (Transformers.js / ORT-Web WebGPU)

- **LFM3-1.7B**: official `LiquidAI/LFM3-1.7B-ONNX` (2026-10-24; q4 1.63 GB, **q4f16 1.38 GB**, q4f32, q8, fp16) and `onnx-community/LFM3-1.7B-ONNX` (2026-10-27). Transformers.js PR #1821 "Add support for LFM3 and LFM3-VL" was merged/closed 2026-10-27. Open follow-ups: #1839 (bump ORT-Web ≥1.31.1 for SWA flash attention on WebGPU), #1838 (prefix caching across generate() for hybrid models; matters for multi-turn agent latency), #1836 (chunked prefill), #1827 (iOS Safari OOM on large onnx_data).
- **MiniCPM5-2B**: no official or onnx-community WebGPU build. OpenBMB's official ONNX covers the 1B only and is CPU-shaped (per RASMUS's README). The usable builds are community ones:
  - `RASMUS/MiniCPM5-2B-ONNX` (2026-09-08): q4f16 only, **1.83 GB** single shard. The embedding is not quantized (untied, 267M params ≈ 535 MB). Requires `shader-f16`.
  - `Mike0021/MiniCPM5-2B-ONNX` (2026-09-11): ORT-GenAI 0.15.2 int4 bs32, about 1.86 GB in 7 shards, built from the pinned official revision with SHA-256 verified. The card claims "corrected tool-history serialization and Jinja compatibility", and there is a WebGPU demo Space.
  - Because the architecture is plain Llama, Transformers.js supports it with no custom code. That is a real robustness plus.
- **Footprint at Pouch's 4k context** (my arithmetic from the configs, fp16 KV): MiniCPM5-2B ≈ 42 layers × 2 kv × 128 × 2 × 2 B ≈ 43 KB/token, about 175 MB at 4k. LFM3 ≈ 12 KB/token on its 6 global layers plus fixed SWA/conv state, under 60 MB. Weights: 1.83 vs 1.38 GB. MiniCPM5-2B sits at the top of the 1–2 GB budget, and with 42 dense layers and about 2B non-embedding params against LFM3's conv-heavy 24 layers, expect noticeably slower decode in the browser. Liquid reports LFM3 decodes 1.8–2.8× faster than the next model on its devices (llama.cpp Q4_0, 32K context; vendor) and quotes 128K KV of 1.6 GB vs 5.6 GB for MiniCPM5-2B.
- **Tool-call parsing hazard for MiniCPM5 in-browser**: the `<function>`/`<param>` tags are special tokens. Ollama issue #18483 / PR #18499 (2026-09-17) found the runner stripped them during detokenization, so calls "never parse." A Transformers.js harness decoding with `skip_special_tokens: true` would hit the same trap. Pouch would need a MiniCPM5-specific parser that keeps those tokens, handles CDATA, tolerates `<`/`&` without CDATA, and `ast.literal_eval`-style decodes Python-literal arrays/objects.

### Native (MLX / oMLX)

- LFM3: official `LiquidAI/LFM3-1.7B-MLX-4bit` and `-MLX-8bit` (2026-10-27). LFM3 needs an MLX/oMLX build with `lfm3` model support and the `qwen3_coder`-style parser. mistral.rs #2520 (2026-10-30) shows a constrained Qwen-XML grammar blocking `</parameter>`, so the model rambles to max_tokens. Unconstrained, the model writes the format correctly.
- MiniCPM5-2B: official `openbmb/MiniCPM5-2B-MLX` (4-bit) and `mlx-community/MiniCPM5-2B-mlx-4Bit`. Parser support is fragmented: OpenBMB recommends SGLang's `minicpm5` parser. Open issues from 2026-10-19 (eejd/py-quantbench review) include rapid-mlx returning HTTP 400 on all 8 array/object-argument cases and treating CDATA-less markup as text, mlx-vlm dropping 4/20 calls without CDATA, and zig-mlx-serve returning arrays as strings. That same review reports **oMLX, vllm-mlx, sglang and mlx-lm do parse the CDATA-less cases**. Other open items: mlx-swift-lm PR #637 (add parser), oh-my-pi PR #14450, sglang PR #47454 (CDATA boundaries), and MiniCPM PR #386 (llama.cpp multi-turn tool template). A third party (larsboes/Sjel #240, 2026-10-21) is running exactly our experiment, MiniCPM5-2B on oMLX after a Qwen3.5-4B trial, and it is unresolved.
- Our run, MiniCPM5-2B oQ8 on oMLX, untuned, 4/5 per transport, is consistent with "works on oMLX, args with arrays/objects are the risk."

Sources: HF file trees via `https://huggingface.co/api/models/<id>/tree/main/onnx`; https://huggingface.co/RASMUS/MiniCPM5-2B-ONNX ; https://huggingface.co/Mike0021/MiniCPM5-2B-ONNX ; https://github.com/huggingface/transformers.js/pull/1821 and issues 1827/1836/1838/1839; https://github.com/ollama/ollama/pull/18499 ; https://github.com/eejd/py-rapid-mlx/issues/6 ; https://github.com/eejd/py-mlx-vlm/issues/6 ; https://github.com/eejd/zig-mlx-serve/issues/14 ; https://github.com/EricLBuehler/mistral.rs/issues/2520 ; https://github.com/larsboes/Sjel/issues/240 ; https://github.com/ml-explore/mlx-swift-lm/pull/637 ; https://github.com/sgl-project/sglang/pull/47454

## 5. Context models (vendor numbers as run by OpenBMB, from the MiniCPM5-2B card)

| | Gemma 4 E2B-it | Gemma 4 E4B-it | granite-4.2-3B | Nemotron-3-Nano-4B | LFM2.5-8B-A1B |
|---|---|---|---|---|---|
| BFCL v4 | 36.6 | 47.0 | 52.2 | 43.7 | 49.2 |
| IFEval | 31.4 (sic; likely a harness/thinking artifact) | 44.4 | 93.7 | 88.0 | 90.8 |
| SWE-V | 2.0 | 15.0 | 36.8 | 3.0 | 0.4 |

granite-4.2-3B (Apache-2.0, 2026-08) is the only other credible sub-4B agent candidate here: IFEval 93.7 and SWE-V 36.8 as run by OpenBMB. AA ranks it second under 4B (11). I did not verify its ONNX or WebGPU availability. Gemma 4 small models look weak for tool loops on these numbers. I found no SmolLM4. I did not survey Phi or Llama small models; at the time of writing they don't appear in any 2026 small-agent comparison I found.

## 6. Why Qwen3.5-4B likely felt lackluster

Reported tool scores are middling for its size, and the vendors disagree: BFCL v4 is 50.3 (Qwen), 56.8 (OpenBMB) and 55.1 (Liquid), all below LFM3's claimed 71.4. TAU2 is strong (79.9). So the published scores already predict "not better than a good 2B on function calling." Several harness factors probably made it worse in Pouch:
- Thinking is on by default and the recommended sampling is temp 0.6–1.0 with presence_penalty 1.5. At a 4k context, think traces eat the budget, and greedy decoding with a presence penalty can corrupt exact-whitespace edits.
- The 248K vocab means a big embedding, and the ONNX build is a multimodal package (decoder about 2.4 GB q4f16 plus embed plus vision). It is heavy for the browser budget.
- The Gated DeltaNet layers rely on newer ORT-Web ops (`onnx-community/...-ONNX-OPT` exists as a newer version).
- Its native format is Qwen3-Coder XML. A harness expecting JSON tool calls would misparse it.

Our own LFM3 data (24/40 untuned to 39/40 tuned) shows harness and recipe dominate at this scale. A fair Qwen3.5-4B verdict needs `enable_thinking=False` plus the same 4-tool recipe.

## 7. Verdict

- **In-browser: keep LFM3-1.7B.** It is smaller (1.38 vs 1.83 GB), faster (conv-hybrid, small KV), has official ONNX plus merged Transformers.js support, uses a Qwen-style tool format without special-token traps, and leads on instruction following and BFCL by every vendor's count. MiniCPM5-2B is runnable through community builds and could match LFM3 on coding-flavored tasks, but it costs more memory and latency and needs a bespoke parser. Confidence: moderate–high on the runtime side, moderate on quality (vendor-only).
- **MLX / oMLX: MiniCPM5-2B is a reasonable alternative, possibly better for code edits.** At 8-bit the size gap stops mattering. It has the only independent evaluation of the pair (AA), it is Apache-2.0, and it is stronger on reasoning, knowledge and long context. Risks: array/object args as Python literals, CDATA handling, and a temp-1.0 reasoning style that may be verbose. Confidence: low–moderate. The head-to-head numbers are vendor-only and contradictory.
- **License (a BayLeaf-specific consideration):** MiniCPM5 is Apache-2.0. LFM3's license gates commercial use at $10M revenue; UC exceeds that, and the nonprofit carve-out covers only non-commercial/research use. Pouch as a free campus tool is plausibly fine, but LFM3 is not open in the OSI sense, and that matters if Pouch is offered to others to remix.

## 8. Smallest settling experiment

Same harness, same five tasks × 8 seeds (40 runs per cell), both with and without the tuned recipe (4 tools, few-shot, greedy, 8 steps). Log parse failures separately from task failures.

| Cell | Model / quant | Runtime |
|---|---|---|
| A (baseline) | LiquidAI/LFM3-1.7B-ONNX q4f16 | Transformers.js WebGPU |
| B | Mike0021/MiniCPM5-2B-ONNX q4f16 (or RASMUS) | Transformers.js WebGPU, with a MiniCPM5 parser that keeps special tokens, handles CDATA, and literal-evals args |
| C | LiquidAI/LFM3-1.7B-MLX-8bit | oMLX |
| D | openbmb/MiniCPM5-2B-MLX 4-bit plus our oQ8 | oMLX |
| optional E | Qwen3.5-4B-MLX-4bit, `enable_thinking=False` | oMLX, to test the "harness, not model" hypothesis |

Add one task specifically with array/object tool arguments (for example a JSON config edit passing a list) and one exact-whitespace edit, since those are the known MiniCPM5 failure surfaces. Record tokens/s, time-to-first-token and peak memory per cell. Decision rule: switch a runtime to MiniCPM5 only if it beats LFM3 by 4+/40 with the tuned recipe at acceptable latency.
