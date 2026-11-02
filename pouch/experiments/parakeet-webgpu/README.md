# Parakeet TDT 0.6B v3 on WebGPU (spike)

**Question.** Can Pouch transcribe speech in the browser with parakeet.js and NVIDIA
Parakeet TDT 0.6B v3, loading the model the way a network-less Pouch worker must (graphs
as bytes, no CDN, no Hugging Face from the page), and which file set should ship: does
parakeet.js with ONNX Runtime Web honor the fp16 encoder on WebGPU, and is its output right?

**Answer.** Yes. fp16 is honored on WebGPU (Apple M3 Max, `shader-f16`): 31.7 minutes of
speech in 27 s (70x real time) with an fp16 decoder, 2.0% word error rate on English,
using the same onnxruntime-web build Pouch already ships for Transformers.js. The int8
encoder is no alternative on WebGPU (20-35x slower). **Ship fp16 encoder and fp16
decoder** (1.28 GB): this changes the brief's default decoder (int8) and the upstream
asrjs profile, for the reasons below.

## Method

- `fetch.mjs` downloads the candidate files from Hugging Face at one pinned commit of
  `ysdede/parakeet-tdt-0.6b-v3-onnx` (`e5356bf6`) into `~/.cache/bayleaf-pouch/models/`
  (outside the repo), checking each against the Hub's LFS SHA-256 and the repository's
  `asrjs-manifest.json`. Only this script talks to Hugging Face.
- `run.mjs` makes clips with macOS `say` (16 kHz WAV) from known public-domain text,
  bundles `spike.js` with Pouch's pinned `parakeet.js` 1.4.4 and `onnxruntime-web`
  1.31.0-dev (package.json overrides parakeet.js's 1.24.1 pin; `import('onnxruntime-web')`
  is aliased to ORT's WebGPU bundle), serves it and the files from localhost, and drives
  installed Chrome headless with WebGPU through Playwright. Each encoder/decoder pair runs
  in a fresh page; each clip is transcribed twice (cold, warm) with
  `transcribeLongAudio(pcm, 16000, { returnTimestamps: true })`.
- `spike.js` loads as the Pouch worker does: `encoderUrl`/`decoderUrl` are `Uint8Array`s
  (ORT's `InferenceSession.create` takes bytes; parakeet.js passes them through), the ORT
  wasm is `env.wasm.wasmBinary`, single-threaded (Pouch is not cross-origin isolated), the
  vocab is answered by a `fetch` shim from memory (a `blob:` URL would not do: Pouch's
  CSP `connect-src` lists no `blob:`, and a blob worker inherits it), and every other
  fetch is refused and counted. It counts `dispatchWorkgroups` calls to show GPU work.
- Word error rate: Levenshtein over lowercased words without punctuation.

Run: `node experiments/parakeet-webgpu/fetch.mjs --all`, then
`node experiments/parakeet-webgpu/run.mjs [--pair fp16-int8,int8-int8,fp16-fp16] [--marathon 35]`.

## Findings that shaped the build

- **parakeet.js defaults ORT's wasm to jsDelivr.** `initOrt` sets `env.wasm.wasmPaths`
  to `https://cdn.jsdelivr.net/npm/onnxruntime-web@<ver>/dist/` when it is unset, and with
  any `wasmPaths` ORT's WebGPU bundle imports its glue `.mjs` from there instead of its
  embedded copy (first attempt: "Failed to fetch dynamically imported module
  .../ort-wasm-simd-threaded.asyncify.mjs"). Removing that one line at build time (and
  leaving `wasmPaths` unset) makes the bundle use its own glue and the wasm handed in.
  `build-parakeet.mjs` does the same rewrite, matched exactly once.
- **hub.js is never needed.** Importing `parakeet.js/src/parakeet.js` directly leaves out
  `fromHub` (Hugging Face fetches, an IndexedDB cache); the build fails if it is bundled.
- **The shared ORT works.** parakeet.js 1.4.4 targets ORT 1.24.1; with 1.31.0-dev (the
  build Pouch's Transformers.js runtime pins) every pair loaded and transcribed
  correctly. One ORT version for both runtimes; the wasm bytes are identical (lock hash).
- **No network.** 0 refused fetches in every run: with bytes in, nothing asks for a URL
  except the vocab, answered from memory.
- `say` at 16 kHz is clean speech; real interviews (room noise, crosstalk, accents) will
  do worse than these numbers. Spanish (voice Paulina) loses accents and one word
  ("rocín" as "rocí"); the 12% WER there is mostly orthography.

## Results (2026-11-02, Chrome 156, Apple M3 Max, `metal-3`, `shader-f16`)

Download is the model files Pouch would fetch (encoder, decoder, vocab). Load is session
creation from bytes in memory (weights already read). RTF is wall time over audio time,
warm pass; lower is faster. `long` is 190 s, over parakeet.js's 180 s threshold, so it is
cut into 90 s windows and merged at sentence gaps. Full numbers: `results/`.

| Encoder + decoder | Download | Load | gettysburg 30 s | spanish 11 s | long 190 s | WER (gettysburg / long) |
|---|---:|---:|---:|---:|---:|---:|
| fp16 + int8 (upstream "approved" asrjs profile) | 1,257 MB | 1.45 s | RTF 0.017 | 0.021 | 0.027 | 3.9% / 2.1% |
| int8 + int8 | 670 MB | 1.59 s | RTF 0.38 | 0.39 | 0.50 | 1.9% / 1.0% |
| fp16 + fp16 | 1,275 MB | 1.44 s | RTF 0.011 | 0.013 | 0.014 | 3.9% / 1.9% |

- The encoder runs on the GPU: 1,279 compute dispatches per 90 s window with fp16;
  int8's quantized matmuls fall back to wasm, 20-35x slower. fp32 (2.4 GB) was not run:
  over any sensible download budget, and fp16 is already correct.
- The fp16 encoder's only consistent "error" on Gettysburg is "Fourscore" for "Four
  score"; int8 gets that right and so scores lower WER on these clips. Not a quality
  difference that matters next to its speed.
- The decoder runs on ORT's wasm in every pair (parakeet.js's `webgpu-hybrid`). The fp16
  decoder is twice as fast as int8 on the windowed clip, equal or better on WER, for
  +18 MB (1.4%). Wasm is the same code on every CPU, so this is not an Apple-only effect.

### Interview length (`--marathon 35`: the English paragraphs cycled, 31.7 min, 1,902 s)

| Encoder + decoder | Wall (warm) | RTF | WER | Windows (merged chunks) | This Chrome's peak RSS |
|---|---:|---:|---:|---:|---:|
| fp16 + fp16 | 26.7 s | 0.014 | 2.0% | 101 | 7.2 GiB (0.9 before) |
| fp16 + int8 | 47.3 s | 0.025 | 2.2% | 90 | 6.5 GiB (1.0 before) |

Peak memory is every process of the Playwright-launched Chrome (browser, GPU, renderer),
sampled each second. It overstates Pouch: this page keeps the encoder's 1.24 GB of bytes
in JavaScript for the whole run, plus the 61 MB WAV and its samples. The Pouch worker drops
its copy after loading; `test/parakeet-browser.mjs` measures the real thing.

## Decision

- **Encoder fp16 on WebGPU**, as the brief proposed: correct output and 20-35x faster
  than int8, which ORT's WebGPU EP runs mostly on wasm.
- **Decoder fp16, not int8** (changed from the brief's default, with evidence): twice as
  fast at interview length (26.7 s against 47.3 s for 31.7 minutes) with equal accuracy
  (2.0% and 2.2%) for 18 MB more (1.4% of the download). The decoder runs in ORT's wasm in
  both cases, which is the same code on every CPU, so the gain is not Apple-specific. The
  upstream asrjs "approved" profile (fp16 encoder on WebGPU, int8 decoder on wasm) was
  validated on one English fixture; this one is validated by these runs and Pouch's tests.
  `decoder_joint-model.int8.onnx` stays in this cache for comparison; it is not approved
  in the gateway release.
- **One repository at one commit**: `ysdede/parakeet-tdt-0.6b-v3-onnx@e5356bf6` over
  `istupakov/parakeet-tdt-0.6b-v3-onnx`: the same graphs (identical int8 and fp32 hashes),
  plus the fp16 files, a provenance manifest and attribution, and the vocab parakeet.js's
  model table expects (its `MODELS['parakeet-tdt-0.6b-v3'].repoId`). istupakov has no fp16
  encoder, so it would mean the 2.4 GB fp32 pair or the slow int8 one.
- **nemo128.onnx is not used**: parakeet.js's JavaScript mel preprocessor is its default
  and the validated profile's; the ONNX preprocessor would need another wasm session.
- Not measured here: other GPUs (Intel, AMD, NVIDIA on Windows or Linux), Firefox and
  Safari WebGPU, noisy real-world speech, and accents.
