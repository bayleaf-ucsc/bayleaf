# LFM3 long-context qualification on WebGPU (2026-11-01)

**Question.** How long a prompt can Pouch's local lane (LFM3-1.7B q4f16, Transformers.js on WebGPU)
take, how long does prefill (time to first token) take, and can prefill be chunked so progress
can be shown? Pouch caps prompts at `BUDGET = 4096` (`pouch/src/profiles.js:61`) on the claim
"past ~4k decode halves and memory roughly quadruples", which had not been measured.

**Short answer.**

- **30 s threshold (measured):** about **22–23K prompt tokens** with chunked prefill (20,480
  tokens: TTFT 24.7 s; 24,576: 32.9 s). One-shot prefill, which Pouch uses today, never gets there
  because it fails first (next item). Without a progress indicator the comfortable range is
  **16K and below** (TTFT 17.7 s).
- **Hard ceiling, one-shot (boundary measured, cause inferred):** a single forward pass works
  up to **11,585 tokens**, and fails at **11,586 and above** with `SafeInt ... Integer overflow`.
  The boundary matches an **fp16 attention-score tensor of 16 heads x S x T** in ORT-Web's
  non-flash GroupQueryAttention to the token (16 x 11,586² x 2 B is just past 2³² B), but the
  ORT kernel was not traced. Separately, a prompt of
  **exactly 8,192 tokens** silently returns **non-finite logits**, with no exception.
- **Hard ceiling, chunked (measured):** chunked prefill (512-token chunks carrying
  `past_key_values`) works to **131,072 tokens end to end**, with 3/3 needles. A synthetic tail
  probe shows the kernels also work to the model's 262,144-position limit, given chunk x context
  < 2²⁷ (512-token chunks overflow only on the very last chunk). The true wall is
  **prompt + output ≤ 262,144**: the rotary cache has exactly 262,144 rows. In practice, 128K
  takes **11.6 min** of prefill and decodes at **5 tok/s**; 256K would be about 45 min
  (extrapolated) at about 2.6 tok/s.
- **Recommendation:** adopt chunked prefill in Pouch (512-token chunks), raise `BUDGET` to
  **16,384**, and show a percent-progress indicator for any prefill over about 8K tokens
  (TTFT > 6 s). If Pouch keeps one-shot prefill, `BUDGET` must stay **≤ 8,000**: below the
  8,192 NaN case and the 11,585 overflow, with margin.

## Setup

MacBook Pro M3 Max, 64 GB. Chrome 156 (Playwright `launchPersistentContext`, headless, fresh
`/tmp` profile), WebGPU adapter `apple`/`metal-3`, `shader-f16`. Device limits (recorded per
run): `maxBufferSize = maxStorageBufferBindingSize = 4,294,967,292`.
`onnx-community/LFM3-1.7B-ONNX@ab9fec4c`, `q4f16`, the `fetch-models.mjs` cache, every file
sha256-verified against `models.lock.json`. Transformers.js 4.3.2 / ORT-Web 1.31.0-dev (lock).
Loopback only: external requests 0 in every run.

**Contention.** Runs took place 07:51–08:22 PST. Other agents were running Playwright browser
tests of Pouch on this machine during at least part of that window (`chrome-headless-shell`
processes were seen at 08:20 and 08:23), so timings may carry GPU/CPU noise. Repeats at 4K and
8K agree within about 4%.

**Graph facts (read from `model_q4f16.onnx`).** 24 layers: 13 conv (`CausalConvWithState`),
6 full attention (layers 2, 6, …, 22) and 5 sliding attention (4, 8, …, 20). Each attention
layer is one `com.microsoft.GroupQueryAttention` with `num_heads 16, kv_num_heads 4`, rotary
inside the op (`do_rotary 1`), and `local_window_size 256` on sliding layers. Every GQA also
receives an explicit additive `attention_bias` of shape `[B, 1, S, T]` (fp16), built from
`attention_mask`. The rotary caches are `[262144, 32|64]`.

## Harness changes (in this directory only)

- `qualify.mjs`: in the perf phase, `--lengths a,b,...` switches to a context sweep;
  without it, the old ~1k/~4k rows run unchanged. Options:
  - `--modes oneshot,chunk:<n>,tail:<n>,tailgpu:<n>`
  - `--repeats` (default 3 at ≤ 8,192, otherwise 1)
  - `--cap-s` (prefill cap, default 600)
  - `--timeout-s` (kills a hung call)
  - `--abort-gb` (memory watchdog, default 40, on Chrome RSS or growth in the system GPU counter)
  - `--keep-going`

  Each length gets a fresh page and model load, so ORT's buffer pool starts empty.
- `qualify-worker.js`: a `context` action drives `model.forward` directly.
  - **One-shot** runs the whole document in one pass, as `generator()` does: the document is
    one forward, and the ~34-token question suffix is a second, tiny forward.
  - **Chunked** feeds `past_key_values` forward chunk by chunk and posts a progress event per
    chunk.
  - Prompts are built from token ids to an exact length N: template prefix, seeded and varied
    "field notes" filler (16 subjects x 16 verbs x 16 objects x 12 places x 8 times, plus
    numbers and section headings), three needles, then question and template suffix.
  - It records TTFT, prefill tok/s, 96 forced greedy decode tokens, top-5 first-token logits,
    KV tensor shapes, and uncaptured WebGPU errors (`requestDevice` is wrapped to listen).

  A `tail` action runs one real chunk plus 16 decode steps on top of a **zero-filled cache**
  of length T. This tests kernel limits, per-chunk time, decode speed and memory at the far
  end of the context without a full prefill. Its content is meaningless.
- `qualify-page.js` forwards progress events to the console. `summarize-context.mjs` prints
  the tables below.

**Needle probe.** Each document holds three sentences, "The passphrase for the
north|east|west gate is amber-falcon-4821 | cobalt-meadow-7360 | saffron-quill-2957.", at 10%,
50% and 90% of the document's tokens. After prefill, each question ("what is the passphrase
for the <gate> gate? Answer with the passphrase only.") runs on a fork of the document's KV
cache and decodes greedily. Pass = the reply contains the exact phrase. Prefill is paid once
per length.

## Results

Prefill = the document forward(s). TTFT = prefill + the question suffix + first token.
Decode = 95 tokens after the first. RSS = Chrome processes in this profile, which does not
include Metal allocations. GPU Δ = the system-wide `IOAccelerator` "In use system memory"
peak minus the value before the call. **GPU Δ is noisy**: other apps move it, and it sometimes
reads 0 when allocations are reused.

### One-shot (Pouch's current behavior): `results/context-oneshot.json`

| length | n | prefill s | prefill tok/s | TTFT s | decode tok/s | RSS peak GB | GPU Δ peak GB | needles 10/50/90% | error |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 4,096 | 3 | 2.60 | 1,564 | 2.74 | 71.8 | 4.63 | 0.78 | 3/3 3/3 3/3 | |
| 8,192 | 3 | 6.97 | 1,171 | 7.17 | 52.2 | 4.25 | 6.75 | 3/3 3/3 3/3 | |
| 16,384 | 1 | | | | | 4.32 | 0 | | `SafeInt ... Integer overflow` (OrtRun) |

The one-shot boundary, bisected by document length (`context-bisect-oneshot*.json`,
`context-pow2.json`):

| document tokens | result | 16 x S² x 2 B |
|---:|---|---:|
| 2,048 / 4,096 / 6,144 | ok | |
| 8,160 / 8,191 | ok | |
| **8,192** | **non-finite logits, no exception, no WebGPU error** (reproduced 3 times) | 2.15e9 |
| 8,193 / 8,194 / 10,240 | ok | |
| 11,585 | ok (prefill 13.0 s, GPU Δ peak **23 GB**) | 4,294,791,200 < 2³² |
| **11,586** | `SafeInt ... Integer overflow` | 4,295,532,672 > 2³² |
| 12,288 / 16,383 | same SafeInt overflow | |
| 16,384 | `Tensor::CalculateTensorStorageSize ... Tensor shape is too large` | |

### Chunked, 512-token chunks: `results/context-chunk512.json`, `context-threshold.json`

| length | n | prefill s | prefill tok/s | TTFT s | decode tok/s | RSS peak GB | GPU Δ peak GB | needles 10/50/90% | error |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 4,096 | 3 | 2.27 | 1,789 | 2.41 | 73.9 | 4.60 | 0.46 | 3/3 3/3 3/3 | |
| 8,192 | 3 | 5.71 | 1,429 | 5.91 | 52.3 | 4.44 | 1.47 | 3/3 3/3 3/3 | |
| 16,384 | 1 | 17.34 | 943 | 17.67 | 32.4 | 4.75 | 0.87 | 1/1 1/1 1/1 | |
| 20,480 | 1 | 24.24 | 843 | 24.65 | 27.5 | 4.44 | 2.27 | 1/1 1/1 1/1 | |
| 24,576 | 1 | 32.44 | 757 | 32.91 | 24.5 | 4.36 | 2.10 | 1/1 1/1 1/1 | |
| 32,768 | 1 | 54.07 | 605 | 54.67 | 18.0 | 4.73 | 2.88 | 1/1 1/1 1/1 | |
| 65,536 | 1 | 190.3 | 344 | 191.4 | 9.3 | 4.76 | 6.05 | 1/1 1/1 **0/1** | |
| 131,072 | 1 | 693.9 | 189 | 696.3 | 5.0 | 4.84 | 9.88 | 1/1 1/1 1/1 | |
| 262,144 | | | | | | | | | not run end to end: projected about 45 min of prefill (see the tail probe) |

At 65,536, the 90%-depth question was answered with the 50% needle's phrase. 131,072 ran with
a 900 s cap (it took 694 s). This exceeds the brief's ~10 min escalation rule, so 262,144 was
not run end to end.

Chunk size at 16,384 (`context-chunksizes-16k.json`): 256 → 20.3 s, **512 → 16.2 s**,
1024 → 17.7 s, 2048 → 17.2 s. All passed 3/3 needles.

### Synthetic tail probe (one chunk ending at T, zero cache on GPU): `context-tailgpu*.json`

| context end T | chunk | chunk ms | decode tok/s at T | GPU Δ peak GB | result |
|---:|---:|---:|---:|---:|---|
| 131,072 | 512 | 5,157 | 5.0 | 10.95 | ok (real run's last chunk: 5,389 ms, decode 5.0) |
| 196,608 | 512 | 7,881 | 3.3 | 15.79 | ok |
| 245,760 | 512 | 9,806 | 2.6 | 18.75 | ok |
| 262,144 | 512 | | | 0 | `SafeInt ... Integer overflow` (32 x 512 x 262,144 = 2³² exactly) |
| 131,072 | 256 | 3,870 | 4.8 | 7.81 | ok |
| 245,760 | 256 | 6,933 | 2.7 | 13.23 | ok |
| 262,144 | 256 | 7,157 | n/a | 14.14 | chunk ok, finite; the next decode step fails: `cos_cache dimension 0 shall not be less than total_sequence_length` |

The first tail run fed its zero cache as CPU tensors (`context-tail.json`). It matched at 131K
but failed at 262K with `RuntimeError: null function`. ORT stages CPU inputs through the
4 GiB wasm32 heap, and 22 x 268 MB does not fit there. That is a probe artifact: real chunked
runs keep the cache on the GPU. The GPU-allocated rerun replaces it.

### Other measurements

- **Sliding-window KV is not truncated (measured).** At every length, the KV tensor of the
  sliding layer equals the full layer's, e.g. `[1, 4, 131038, 128]` for both layers at 131,072.
  The window applies only as a mask inside GQA, so all 11 attention layers keep full history:
  22,528 B per token, which is 2.95 GB at 128K and 5.9 GB at 256K, per cache copy.
- **One-shot vs chunked outputs (measured).** At 4,096 and 8,192 both modes give the same
  needle results. The first-token top-5 ids agree with logits within about 0.35. The 96-token
  greedy continuations match for the first 49 (4K) and 82 (8K) tokens, then drift.
  fp16 accumulation order differs, so this is numeric drift, not a functional difference.
- **Chunking is faster, not slower.** 4K: 2.27 vs 2.60 s; 8K: 5.71 vs 6.97 s. One-shot's
  transient GPU peak is larger: 6.75 vs 1.47 GB at 8K, and 23 GB at 11,585 tokens. This fits a
  non-flash kernel that scores the full S x T rectangle, including the masked upper triangle;
  chunking scores only about the lower half. (Inference: the kernel path was not traced.)
- **Prefill cost is quadratic, so progress over tokens is not progress over time.** At 128K,
  chunk times grow linearly with position: chunk 0 takes 278 ms, chunk 128 takes 2.65 s,
  chunk 255 takes 5.39 s. Time-to-first-token fits t ≈ 4.7e-4·N + 3.6e-8·N² s.
- **Memory.** Chrome RSS stayed at 4.0–4.8 GB at every length: Metal buffers are not counted
  in RSS. The system GPU counter peaked at about 10 GB at 128K and about 19 GB at 245K (tail).
  The watchdog (40 GB) never fired. GPU Δ is a noisy system-wide counter: it read 0 for some
  successful runs.
- **The old claim, revisited.** Decode goes 72–74 tok/s (4K) → 52 (8K) → 32 (16K) → 18 (32K)
  → 9 (64K) → 5 (128K) → 2.6 (245K). It roughly halves for each doubling *beyond 8K*, not
  "past 4k". Memory "quadrupling" holds only for one-shot's transient score buffer (0.8 → 6.8 GB
  from 4K to 8K), not for steady state or for chunked prefill.
- **Needle probe at shallow and medium depths.** In the main runs, the 10% and 50% needles
  passed at every length. The 90% needle failed at 65,536 (chunked), and in single runs at
  2,048, 6,144 and 8,160 in the bisect runs, in both modes. The 50% needle failed once, at 11,585 one-shot. So these failures are the model's
  quality, not a runtime artifact. Some answers repeat the phrase after a `</think>` token
  ("amber-falcon-4821</think>amber-falcon-4821"). That is a template/model quirk, harmless to
  this check but worth knowing for Pouch's stream parser.

## Score-buffer hypothesis

**Confirmed, with a correction.** The hypothesis was a 16 x N² **fp32** score buffer failing at
exactly N = 8,192. The ceiling is set by a 16 x S x T **fp16** tensor whose byte size
overflows 32-bit `size_t` (wasm32, ORT `SafeInt`) at S·T ≥ 2²⁷. One-shot breaks at
S = T = 11,586 (exact match: 11,585 passes). Chunked breaks only when chunk x context reaches
2²⁷, which for 512-token chunks is exactly the last chunk at 262,144 (also measured). The
WebGPU `maxBufferSize` (2³² − 4) would bind at the same point. The size check trips first.
LiquidAI's "prefill chunks ≤ 256 tokens" is exactly the size that keeps this product under 2²⁷
across the full 262,144 context.

The **8,192 failure is real but separate.** Exactly 8,192 document tokens in one pass gives
non-finite logits, reproduced 3 times, with no exception and no uncaptured WebGPU error, while
8,191 and 8,193 work. A 2³¹-byte score tensor at exactly a power of two suggests a 32-bit
signed offset or an exact-fit tiling edge case in a kernel. That is inference: the WGSL was not
traced. Chunked prefill passes through T = 8,192 without the problem.

## Recommendation for Pouch

1. **Chunked prefill is required to go past about 11.5K, and it is a free win below that**
   (10–18% faster prefill, a smaller transient GPU peak, and natural progress events). Use
   512-token chunks: fastest at 16K, and valid up to about 262K context. For contexts ≥ 256K
   use `chunk ≤ floor((2²⁷ − 1) / T)`, or simply 256. This needs a forward-pass loop around
   `model.forward` with `num_logits_to_keep = 1`, as `qualify-worker.js` `context()` does;
   `generator()` cannot chunk.
2. **BUDGET.**
   - Keep one-shot: `BUDGET ≤ 8,000`. That avoids the exact-8,192 NaN and the 11,585 wall, and
     gives TTFT ≈ 7 s and decode ≈ 52 tok/s.
   - Ship chunked: `BUDGET = 16,384`, with TTFT ≈ 17.7 s and decode ≈ 32 tok/s, inside the
     30 s tolerance without a progress UI.
   - Going above 16K needs a progress indicator, because TTFT exceeds 30 s at about 23K. The
     decode collapse (18 tok/s at 32K, 9 at 64K) also makes longer contexts poor for an agent
     loop.
3. **Progress indicator.** Show it when the predicted prefill exceeds about 6–8 s
   (≥ 8K tokens). Report percent of **work**, not tokens: chunk k costs about a + b·T_k, so
   use the cumulative Σ T_k / Σ T over all chunks (roughly (done/N)² for long prompts).
   Otherwise the bar races to 50% and then stalls.
4. **Agent loops multiply prefill.** Pouch re-renders and re-prefills the whole history every
   step (inferred from the provider design, not measured here), so an 8-step task at 16K could
   spend more than 2 minutes in prefill. Prefix KV reuse across steps, keeping the cache and
   feeding only the new tokens, is the next lever. The fork-from-cache technique in this
   harness shows the cache survives reuse.

## Measured vs inferred

- **Measured:**
  - every row in the tables
  - the 11,585/11,586 boundary and the error texts
  - the 8,192 NaN and its neighbors
  - KV shapes
  - mode agreement at 4K and 8K
  - 128K end to end
  - kernel viability and decode speed to 245,760 (synthetic content)
  - the 262,144 chunk and rotary-limit errors
- **Inferred, not verified:**
  - that the overflowing tensor is specifically the attention probabilities (the arithmetic
    matches to the token, but the ORT kernel was not traced)
  - the cause of the 8,192 NaN
  - the 256K end-to-end prefill time (~45 min, extrapolated from the linear chunk-cost curve
    and tail probes)
  - quality (needles) above 131,072
  - behavior on other GPUs, browsers, or machines with less memory (a 64 GB Mac is the best
    case: 128K needed a ~10 GB GPU peak)
  - phone viability
  - effects of the concurrent tests on timings
  - the agent-loop cost
- **Not run:** 256K end to end (escalation rule), chunk sizes other than 512 above 16K
  (except the tail probes at 256 and 512), sampled decoding, any change to `pouch/src`.

## Reproduce

```sh
cd pouch/experiments/lfm3-webgpu/qualification
node qualify.mjs configs/lfm3-q4f16.json --phase perf --lengths 4096,8192,16384 --modes oneshot --out context-oneshot
node qualify.mjs configs/lfm3-q4f16.json --phase perf --lengths 4096,8192,16384,32768,65536,131072 --modes chunk:512 --cap-s 900 --timeout-s 1500 --out context-chunk512
node qualify.mjs configs/lfm3-q4f16.json --phase perf --lengths 20480,24576 --modes chunk:512 --repeats 1 --out context-threshold
node qualify.mjs configs/lfm3-q4f16.json --phase perf --lengths 131072,196608,262144 --modes tailgpu:512,tailgpu:256 --repeats 1 --keep-going --out context-tailgpu
# one-shot boundary: a length of N gives N - 34 document tokens
node qualify.mjs configs/lfm3-q4f16.json --phase perf --lengths 8194,8226,8228,10274,11619,11620,12322,16417,16418 --modes oneshot --repeats 1 --keep-going --out context-bisect-oneshot
node summarize-context.mjs results/context-*.json
```

Evidence: `results/context-{oneshot,chunk512,threshold,tailgpu,tailgpu-240k,tail,tail-cpu-smoke,bisect-oneshot,bisect-oneshot-8191,bisect-oneshot-8193,pow2,chunksizes-16k}.json`.
Each row carries an ISO timestamp, greedy token ids, and per-chunk timings (`prefillChunksMs`).
