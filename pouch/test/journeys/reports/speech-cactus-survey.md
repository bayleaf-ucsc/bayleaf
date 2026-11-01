# Cactus-Compute survey for BayLeaf Pouch local inference

Surveyed 2026-10-29. Disciplines: ML systems (runtimes, quantization formats), web platform engineering (WASM, WebGPU, CSP, cross-browser), software licensing and supply-chain trust, and privacy design (ZDR/ZOA posture).

Evidence tags: **[verified]** = I checked it myself (HF API, repo tree, file hash, or local test). **[vendor claim]** = stated by the vendor and not reproduced. **[unverified]** = my inference or memory, not checked today.

Raw data: `data/models.json` (HF API, 63 repos), `data/cards/`, `data/trees/`, `smoke-whistle.json`.

---

## 1. What Cactus is

Cactus Compute, Inc. ships two separate runtimes. They are easy to conflate.

### A. Cactus engine (`github.com/cactus-compute/cactus`, 6.2k stars)

- A native C/C++ inference stack for phones and wearables: Engine (OpenAI-style chat, tools, STT, embeddings, RAG, vision, "cloud handoff"), then Graph, then Kernels (ARM NEON, Metal, NPU), then Cactus Quants (rotation plus codebook quantization) [verified, README]. It has bindings for Swift, Kotlin, Flutter, React Native, Python and Rust.
- **There is no browser build.** The repo tree (831 paths) has no wasm, emscripten or WebGPU paths [verified, GitHub tree API].
- **The license is not open source.** It is free only for individuals, education, 501(c)(3) organizations, or organizations under $2M in funding and revenue. Everyone else needs a commercial license (<https://github.com/cactus-compute/cactus/blob/main/LICENSE>) [verified]. UCSC qualifies under 2(c), but the terms are not OSI-compatible and carry an automatic-termination clause.
- **It phones home.** `cactus-engine/src/telemetry_impl.cpp` posts to a Supabase project, keyed by a `device_id`, and reads the git remote URL from `$PWD/.git/config`. Opt out with `CACTUS_NO_CLOUD_TELE` [verified, source grep]. `cloud.cpp` implements cloud handoff.
- **HF artifact format:** most `Cactus-Compute/<model>` repos hold `config.json` plus `weights/*.zip` in int4, int8, `-apple` (NPU) and `cq4` variants. These are the engine's own weight folders: not GGUF, not ONNX [verified, trees]. They are useless in a browser unless someone ports the engine.
- Exceptions: `gemma-4-e2b-it-hybrid` (safetensors with custom modeling code), `-GGUF` (Q4_K_M at 3.43 GB, plus a 0.99 GB mmproj, for llama.cpp), and `-mlx` [verified].

### B. Needle 3 and Whistle engine (`github.com/cactus-compute/needle`, Apache-2.0)

- This is a separate, tiny CPU engine of under 1 MB per platform. It loads `.cact` files: a 196-byte header, a nameless positional tensor directory, CQ2/CQ4 blobs at 2.125 or 4.125 bits per weight, and the tokenizer embedded (<https://cactuscompute.com/blog/cact-format>) [vendor claim, well documented].
- **It has an official browser target:** `wasm/needle.js` (63 KB) and `wasm/needle.wasm` (923 KB) in `Cactus-Compute/needle3` [verified, tree]. The devices guide says the cactuscompute.com sandbox runs it (<https://cactuscompute.com/blog/needle-supported-devices>). It is CPU-only, with no WebGPU.
- **Engine source is not in the GitHub repo.** The needle repo contains only Python (training, export, wrappers); engines ship as prebuilt binaries on HF [verified, tree has no C/C++]. The weights and binaries are Apache-2.0, but the WASM is an opaque blob you can't audit. The "Porting Needle" blog invites third-party runtimes.
- The Python package has opt-out telemetry (`NEEDLE_TELEMETRY=0`, posts to Supabase) [verified, `needle/_telemetry.py`]. The WASM path showed no telemetry: the wrapper overrides `fetch` during inference, and my CSP test saw no violations [verified, see section 5].
- The community npm wrapper `cactus-needle@0.3.0` (Apache-2.0, maintainer afshinmeh, not official) [verified]:
  - vendors the needle3 WASM at pinned revision `2ae11323…`, with SHA-256 values in `vendor/manifest.json`;
  - pins `whistle.cact` and `needle3.cact` by HF revision, size and SHA-256;
  - accepts `model:` as any URL or `Uint8Array`, so the weights can be self-hosted or user-loaded;
  - needs no SharedArrayBuffer or COOP/COEP (single-threaded; `crossOriginIsolated` was false in the test) and runs in a module Worker;
  - uses plain relative ESM, so no bundler is required. I imported `dist/browser/index.js` directly.

---

## 2. Cactus models relevant to Pouch

Sizes come from the HF tree API in MB [verified]. "Browser path" means a route that exists today.

| Repo | Task | Base | Size per quant | Format | License | Browser path |
|---|---|---|---|---|---|---|
| **whistle** | STT, 7 languages (en de fr es it nl pl), word timestamps, audio embeddings | Cactus original | **16.9** (`whistle.cact`, 2–4 bit); 220.6 checkpoint | .cact | Apache-2.0 | **Yes: needle WASM, CPU. Tested in Chromium and WebKit** |
| **needle3** | Tool calls, structured extraction, text embeddings (not chat) | Cactus original, 121M (the "50M arithmetic" claim is the vendor's) | **35.3** (`needle3.cact`, 20 layers, CQ2); ladder down to about 8 at 4 layers | .cact | Apache-2.0 | Yes: same WASM, CPU (not tested by me) |
| needle2 / needle | Older tool callers | Cactus | 90 pkl / 16 cq4 zip | pkl, zip | Apache / MIT | Superseded |
| silero-vad | VAD | Silero | 0.6 | Cactus zip | MIT | No (use the upstream ONNX, 0.6–2.2, via ORT Web) |
| whisper-tiny / base / small / medium / large-v3 | STT | OpenAI | tiny 49–65; base 76–131 | Cactus zip | Apache-2.0 tag (upstream MIT) | No (use `onnx-community` ONNX or whisper.cpp GGML) |
| moonshine-base | STT, English | Useful Sensors | 49–98 | Cactus zip | MIT | No (use `onnx-community` ONNX) |
| parakeet-tdt-0.6b-v2 / v3, ctc-0.6b / 1.1b | STT | NVIDIA | v3: 384 (cq4) – 1266 | Cactus zip | CC-BY-4.0 | No (sherpa-onnx WASM has Parakeet [unverified]) |
| LFM2 / LFM2.5 (350M–2.6B, 8B-A1B), -Tool, -RAG, -Thinking | LLM | Liquid | e.g. 1.2B-Tool: 773 int4 / 1303 int8 | Cactus zip | LFM Open (other) | No |
| Qwen3-0.6B / 1.7B, Qwen3.5-0.8B / 2B | LLM / VLM | Qwen | 0.6B: 376 int4 | Cactus zip | Apache-2.0 | No (upstream ONNX exists [unverified]) |
| gemma-3 / 3n / 4, functiongemma-270m | LLM / VLM | Google | n/a | Cactus zip | Gemma / Apache | No |
| gemma-4-e2b-it-hybrid(-GGUF) | LLM + confidence probe | Gemma 4 E2B | Q4_K_M 3428, f16 9312, mmproj 986 | GGUF | Gemma | Theoretical via wllama, but over 3.4 GB and needs a custom probe head: not practical |
| LFM2.5-VL-450M / 1.6B | Vision | Liquid | 345–577 | Cactus zip | other | No |
| nomic-embed-v2-moe, Qwen3-Embedding-0.6B | Embeddings | n/a | 341–485 | Cactus zip | Apache | No (Transformers.js ONNX of upstream) |
| segmentation-3.0, wespeaker | Diarization | pyannote | small | Cactus zip | MIT / CC-BY | No |
| `*-cq` repos (May 2026) | Experimental CQ dumps | n/a | e.g. whisper-tiny CQ4 21.7 | zip | none listed | No |

**Bottom line:** the only Cactus artifacts that run in a browser are **Whistle** and **Needle 3**, through the needle WASM engine. Everything else is the native engine's weight format (re-quantized copies of upstream models). For a browser, the upstream ONNX or GGUF versions are the right source.

---

## 3. Speech: best browser-runnable options, any vendor

Sizes are from the HF trees [verified]. Browser support reflects general platform status, not testing here, except Whistle.

### STT

| Option | Runtime | Size (smallest usable) | WebGPU needed? | Chrome / Safari / Firefox | Quality / latency notes | License | Network caveats |
|---|---|---|---|---|---|---|---|
| **Whistle** | needle WASM (cactus-needle) | **16.9 MB** + 0.9 MB wasm | No (CPU, single thread) | **Tested in Chromium 156 and WebKit 27.2**; Firefox untested (harness) | 3.6 s clip: about 315 ms in Chromium, about 400 ms in WebKit, TTFT about 133–184 ms on M3 Max [verified]. Vendor: 6.6x faster TTFT than Whisper base, and lower WER on LibriSpeech, SPGI, Earnings-22 and FLEURS-avg (<https://github.com/cactus-compute/needle>) [vendor claim] | Apache-2.0 (weights and binary); engine source closed | Defaults to HF URLs; override `model` and `wasmUrl` |
| Moonshine tiny / base | Transformers.js or `@moonshine-ai/moonshine-js` (MIT) | tiny int8: encoder about 8–31 + decoder 20; base int8 about 20 + 42 | No (WASM works; WebGPU faster) | All three via WASM [unverified per browser] | English only (plus tiny-ar/ja/ko/uk/vi variants). Its paper claims about 5x less compute than Whisper tiny on 10 s clips [unverified figure] | MIT | Transformers.js defaults to HF weights and jsDelivr ORT wasm; set `env.allowRemoteModels=false`, `env.localModelPath`, `env.backends.onnx.wasm.wasmPaths` |
| Whisper tiny / base (ONNX) | Transformers.js | tiny.en int8: about 10 enc + 31 dec; base int8: about 23 + 54 | No | All via WASM; WebGPU on Chrome and Safari 26+ [unverified] | Multilingual; WASM latency on weak devices is seconds per clip [unverified] | MIT (upstream) | Same as above |
| whisper.cpp WASM | Emscripten build | base q5_1: 59.7; tiny about 31 [unverified] | No, but **threads need SharedArrayBuffer**, so COOP/COEP headers are required | All with cross-origin isolation [unverified] | Mature; no maintained npm package (`whisper-wasm@0.0.1` is stale) | MIT | Self-host the wasm and GGML |
| sherpa-onnx WASM | ORT plus k2 | Parakeet, Zipformer, Moonshine and others [unverified] | No | WASM [unverified] | Best streaming options; heavy build | Apache-2.0 | Self-host |
| Web Speech API | Browser vendor | 0 | n/a | Chrome sends audio to Google servers; Safari uses Apple, partly on-device | n/a | n/a | **Phones home. Disqualified** |

### TTS

| Option | Runtime | Size | WebGPU? | Notes | License | Caveats |
|---|---|---|---|---|---|---|
| **Kokoro-82M** (`kokoro-js` 1.2.1) | Transformers.js | q8f16 **86 MB**, quantized 92, fp16 163; voices 0.5 MB each | No (WASM q8; WebGPU fp32 is faster) | Best quality among small open TTS [unverified ranking]; WASM real-time factor on weak CPUs may be at or above 1 [unverified] | Apache-2.0 weights | Uses `phonemizer` (npm says Apache-2.0, but its README says it wraps **eSpeak NG, which is GPL-3.0**): a license tension to resolve before redistribution [verified README text; legal reading unverified] |
| **Piper** (`@mintplex-labs/piper-tts-web`, `@diffusionstudio/vits-web`) | ORT Web WASM | x_low 20.6, low/medium about 63 per voice | No | Fast on CPU, many languages, more robotic | Code MIT; voices vary per voice card | Also uses espeak-ng phonemization (GPL); the wrapper defaults fetch voices from HF [unverified] |
| **Kitten TTS nano** | ORT Web (`kitten-tts-js`) | **23.8 MB** | No | Tiny CPU model, English, 8 voices; quality below Kokoro [unverified] | Apache-2.0 | `kitten-tts-js` pulls in `@huggingface/hub` and phonemizer |
| `speechSynthesis` | OS voices | 0 | n/a | Zero download; on-device on macOS/iOS; on ChromeOS/Android some voices are "Google network" voices | n/a | Must filter `localService === true` to avoid network voices |

Cactus has **no TTS model**.

---

## 4. Recommendation for Pouch

### STT: prototype Whistle first

It is the only option that is:

- small (17.8 MB total);
- CPU-only, so it works on Safari, Firefox and weak devices without WebGPU;
- free of COOP/COEP and SharedArrayBuffer requirements;
- already pinned and hash-checked by its wrapper;
- confirmed to run under a single-peer CSP: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'`.

It also offers streaming and keyword biasing. The keyword list could be fed from the project's identifiers. Risks:

- an opaque engine binary;
- a third-party npm wrapper;
- 7 languages only;
- a 30 s single pass (windowed beyond that).

**Fallback and comparison:** Moonshine base via Transformers.js on the same pipeline Pouch already uses for LFM3, which amortizes the ORT Web runtime. Use Whisper base if multilingual coverage matters.

### TTS: two tiers

1. **`speechSynthesis` filtered to `localService` voices as the zero-download default.** No assets, works everywhere. Verify Firefox and Linux voice behavior.
2. **Kokoro-82M q8f16 (86 MB) as the opt-in "good voice".** Use Kitten nano (24 MB) if Kokoro's WASM latency on weak hardware proves poor. Resolve the eSpeak NG GPL question first. Alternatively, a GPL-compatible distribution is fine because Pouch is public. Pouch's license and a GPL-3 WASM blob loaded at runtime is a question for counsel or a policy call, not for this survey.

### Asset hosting under the single-peer CSP

1. Mirror the exact files to a BayLeaf origin (R2 behind `api.bayleaf.dev` or a sibling path):
   - `needle.wasm` (sha256 `c43f48e1…`);
   - `whistle.cact` (`b6e02f04…`), at HF revision `b358ddad…` (verified locally);
   - the worker JS.
2. Embed the SHA-256 values in the Pouch file. Pass `model`, `modelSha256`, `wasmUrl` and `workerUrl` explicitly.
3. Also accept a user-supplied `File`, which the wrapper takes as a `Uint8Array` and hash-checks.
4. Vendor (rather than CDN-load) the ~1.5 MB `cactus-needle` dist, or reimplement its thin worker shim. It is small and readable, a good pedagogical single-file candidate.
5. For Transformers.js models, set `allowRemoteModels=false`, `localModelPath` to the BayLeaf mirror, and `wasmPaths` to the self-hosted ORT files. **Note:** the existing LFM3 experiment loads from HF and jsDelivr, so it does not yet meet the single-peer posture.
6. Cache Storage is fine. Size: Whistle plus engine is about 18 MB, versus about 1.1 GB for LFM3.

### Local LLM lane

- **Needle 3 (35 MB, CPU WASM) is worth a bounded trial as a tool-router or extractor, not a chat model.** For example: map a dictated command to one of Pouch's tools offline, with a calibrated confidence score. That would give a "dictate, Whistle, Needle, tool call" path in about 53 MB with no GPU. It cannot replace LFM3-1.7B (1.1 GB, WebGPU-only in practice) for open-ended coding conversation; vendor docs say it trades away general chat.
- Nothing else in the Cactus catalog has a browser path. Their LFM2 and Qwen zips are native-only. Hybrid Gemma GGUF is 3.4 GB plus a custom probe. Skip them.

---

## 5. Smoke test (done)

Setup in `/tmp/cactus-survey/`:

- `site/` holds a static page, the `cactus-needle@0.3.0` package, `whistle.cact` (hash checked) and `clip.wav` (macOS `say`, 16 kHz mono, 3.6 s).
- `serve.py` serves it with the strict CSP above and `no-store`.
- `pw/run.mjs` drives Playwright 1.64.1.

Results, recorded in `smoke-whistle.json`, for the target text "Please open the settings file and read the third paragraph aloud.":

| Browser | Load | Cold transcribe | Warm | TTFT | Output |
|---|---|---|---|---|---|
| Chromium 156 headless | 79 ms (local, cache off) | 315 ms | 347 ms | 133 ms | exact match |
| WebKit 27.2 headless | 95 ms | 414 ms | 372 ms | 150–184 ms | exact match |
| Firefox (Playwright 1555) | **did not launch**: `sandbox_extension_issue_file_to_process … Operation not permitted`, likely the harness's macOS sandbox, not the page | n/a | n/a | n/a | n/a |

There were no console errors or CSP violations in either engine that ran. This was synthetic TTS speech on an M3 Max; real microphone audio and weak devices are not qualified.

### How to finish the Firefox and WebKit testing

1. Run `PLAYWRIGHT_BROWSERS_PATH=/tmp/cactus-survey/browsers node pw/run.mjs` from a normal Terminal (outside the agent sandbox) to get the Firefox row.
2. For real Safari rather than WebKit, use `safaridriver --enable` with WebDriver, or test manually.
3. For microphone tests, Chromium and Firefox take `--use-fake-device-for-media-stream` / `--use-file-for-fake-audio-capture=clip.wav` (Firefox: prefs `media.navigator.streams.fake`). WebKit in Playwright has no fake mic, so test `decodeAudioData` on a file there.
4. To simulate weak devices, use Chromium CDP `Emulation.setCPUThrottlingRate` (4–6x).

A TTS smoke test (Kokoro or Kitten) was not run. It is the next cheap step: about 24 MB for Kitten.
