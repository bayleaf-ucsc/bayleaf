# Pouch media / document / data tool survey

Date: 2026-11-01. Read-only research for BayLeaf Pouch (static, browser-only agent at pouch.bayleaf.dev).
Constraints assumed: CSP `default-src 'none'`; `script-src` hashes + `'wasm-unsafe-eval'`; `worker-src 'self' blob:`;
`connect-src 'self' https://api.bayleaf.dev http://localhost:* http://127.0.0.1:*`; `img-src 'self' data: blob:`;
no COOP/COEP today; cross-browser; self-hosted, hash-pinned assets, each <= 25 MiB (Cloudflare Static Assets per-file limit).

Sizes below are MiB (1,048,576 bytes), from the jsDelivr flat file listing API
(`https://data.jsdelivr.com/v1/packages/npm/<pkg>@<ver>?structure=flat`) and the Hugging Face tree API
(`https://huggingface.co/api/models/<repo>/tree/main`), unless marked "unverified". Nothing over a few MB was downloaded.

Disciplines in play: web platform security (CSP, cross-origin isolation), systems packaging (Emscripten/WASM),
ML deployment (ONNX Runtime, quantization), software licensing (LGPL/AGPL/CC-BY), and data-protection posture.

---

## 0. Shared substrate findings (read these first)

### 0.1 ONNX Runtime Web is the shared ML runtime
PaddleOCR (all credible JS ports), parakeet.js, and Pouch's existing LFM3 path (transformers.js) all ride on
`onnxruntime-web`. One pinned ORT build should serve all three.

- npm `onnxruntime-web` 1.31.1 (2026-10-26), MIT, Microsoft maintainers. https://www.npmjs.com/package/onnxruntime-web
- Per-file sizes (1.31.1 `dist/`):
  - `ort-wasm-simd-threaded.wasm` 14.16 MiB (CPU EP only) – under limit
  - `ort-wasm-simd-threaded.asyncify.wasm` 27.42 MiB (WebGPU EP, new) – **over 25 MiB**
  - `ort-wasm-simd-threaded.jsep.wasm` 28.15 MiB (WebGPU/WebNN JSEP) – **over 25 MiB**
  - `ort-wasm-simd-threaded.jspi.wasm` 17.09 MiB
  - JS loaders `ort.*.min.mjs` 0.05–0.8 MiB; glue `.mjs` ~0.05 MiB
- Pouch's own LFM3 qualification already ships the asyncify WASM at 26,861,777 bytes (25.62 MiB, 1.31.0-dev), i.e.
  this limit is already live for Pouch (`pouch/experiments/lfm3-webgpu/qualification/REPORT.md`). Workarounds:
  split into parts and pass bytes via `ort.env.wasm.wasmBinary` (ORT API), or a same-origin Service Worker that
  reassembles parts and answers the canonical URL (keeps `connect-src` free of `blob:`).
- Threads: ORT WASM EP is multithreaded only when `crossOriginIsolated`; otherwise `numThreads` is pinned to 1
  (stated in ppu-paddle-ocr README and parakeet.js README). WebGPU needs no isolation.
- CSP: ORT does `import()` of its glue `.mjs` from `wasmPaths`; default `wasmPaths` is jsDelivr (ppu README: "When
  `ort.env.wasm.wasmPaths` is unset, pages and workers load the jsDelivr copy") so it **must** be set to a self path.
  The LFM3 report shows the worker needs same-origin `connect-src` and `'wasm-unsafe-eval'`; no JS `unsafe-eval`, no blob workers.
- Browser support (MDN BCD): WebGPU Chrome 113+ (full desktop 144+), Firefox 141+, Safari 26+.

### 0.2 The 25 MiB rule bites three places
DuckDB-Wasm engine (34–39 MiB), ORT WebGPU WASM (27–28 MiB), and every ASR model file (622 MiB–2.3 GiB). A single
generic "part-file reassembler" (Service Worker or `fetch`-and-concat with SHA-256 verification against the manifest)
should be built once and reused, as was done for LFM3 weights.

### 0.3 Emscripten glue loading under hash-only `script-src`
Every candidate loads an Emscripten `.mjs`/`.js` glue file at runtime (dynamic `import()` or `importScripts`). Hashes
alone do not authorize external script URLs fetched by dynamic import. Options: run each tool inside a dedicated
same-origin module worker whose own response CSP permits `'self'` (the LFM3 pattern, which qualified), add
`'strict-dynamic'`, or add `'self'` to `script-src`. Requalify per tool; do not assume.

---

## 1. libav.js (Yahweasel)

- Repo: https://github.com/Yahweasel/libav.js (531 stars, pushed 2026-08-31, sole maintainer `yahweasel`).
- npm: `libav.js` 6.10.9 (2026-08-18; monolith 179 MB unpacked, all variants) and per-variant `@libav.js/variant-<name>`.
- License: wrapper code 0BSD; built libraries **LGPL-2.1** (npm `license: LGPL-2.1`). README: "if you distribute this
  library, you must provide sources. The sources are included in the `sources/` directory of the compiled version"
  and "you are contractually obligated to release the source code of libav.js and all of its dependencies".
  Bundled codecs (libopus, FLAC native, libvpx, libvorbis, libmp3lame (LGPL), libaom) are BSD/LGPL; no GPL in the
  published variants. Author refuses to publish MPEG-patent variants (AAC, H.264, HEVC) and you'd have to build them.
- CLI: **yes.** `default-cli`, `webm-cli`, `webm-vp9-cli` subvariants add `ffmpeg` and `ffprobe` functions
  (README: "The `-cli` subvariant additionally includes the CLI (`ffmpeg` and `ffprobe` functions)"). Non-cli variants
  expose only the libav API (`ff_init_demuxer_file`, `ff_decode_multi`, filter graphs, etc.).
- Variants (README, "Variants and Building"):
  - `default`/`default-cli`: Opus, FLAC, WAV in ogg/WebM/FLAC/wav + audio filters.
  - `opus[-af]`, `flac[-af]`, `wav[-af]`: single-format slices.
  - `obsolete`: default + Vorbis + MP3 (libmp3lame) + MP3 container.
  - `webm`, `webm-cli`, `webm-vp9[-cli]`: default + VP8 (+VP9) + video filters.
  - `webcodecs[-avf]`: demux/mux ogg/WebM/MP4/FLAC/wav with *parsers* for AAC/H.264/H.265/VP8/VP9/AV1, decode via
    WebCodecs (pair with libavjs-webcodecs-bridge).
  - `vp8-opus`, `vp9-opus`, `av1-opus` (AV1 "effectively unusable" for speed).
  - Reprobate (not built): `aac`, `h264-aac`, `hevc-aac`.
  - Modular (GitHub releases only): `demuxer-<fmt>`, `decoder-<codec>`; pair with AVGuesser/TransAVormer.
  - No variant named "mediarecorder-transcode" exists in the current README; MediaRecorder output (WebM/Opus or MP4/AAC
    on Safari) is handled by `webm`/`default` (WebM) or `webcodecs` + WebCodecs AudioDecoder (MP4/AAC).
- Sizes, 6.10.9 (jsDelivr):
  - default: `.wasm.wasm` 1.59, `.thr.wasm` 1.76, `.wasm.mjs` 0.27, `.asm.js` 3.31 (skip asm.js)
  - default-cli: `.wasm.wasm` 2.24, `.thr.wasm` 2.46, glue 0.29, entry 0.03
  - webm: `.wasm.wasm` 2.16, `.thr.wasm` 2.30, glue 0.27
  - All far below 25 MiB. Realistic self-host set: entry + `.wasm.mjs` + `.wasm.wasm` ≈ 2.6 MiB per variant.
- Threads/COI: three modes `direct`, `worker` (default), `threads` (opt-in `yesthreads`, requires SharedArrayBuffer).
  Single-threaded fallback is the default; threads matter for video, not audio ("audio ... much faster than real time").
- CSP: worker mode spawns a Worker from its own same-origin script URL (README: workers "cannot be loaded from a
  different origin"); `wasmurl`, `toImport`, `factory`, `base` options let us pin exact self-hosted URLs. No eval.
  Needs `'wasm-unsafe-eval'` (have) and `worker-src 'self'` (have).
- VFS fit: libav has its own Emscripten FS: `writeFile(name, Uint8Array)`, `readFile`, `unlink`, plus block/stream
  "devices" (`mkreadaheadfile`, `mkblockreaderdev`, `mkwriterdev`) for large or streaming I/O (docs/IO.md). A Pouch
  `ffmpeg`/`ffprobe` command = copy VFS bytes in (or attach an OPFS-backed block device), call
  `libav.ffmpeg(...argv)` / `libav.ffprobe(...)`, copy outputs back. Capture of stdout/stderr text: unverified, check
  Emscripten print hooks in the cli build.
- Gotchas: version-stamped filenames by design ("Caching is Hell"); one variant per instance (load several instances
  for several variants); MP3 input needs `obsolete`; AAC/M4A (phone voice memos!) needs WebCodecs path, Safari/Chrome
  only for AAC decode, or `decodeAudioData` on the main thread (OfflineAudioContext is not available in workers).
- Sources: README https://github.com/Yahweasel/libav.js/blob/master/README.md, API https://github.com/Yahweasel/libav.js/blob/master/docs/API.md,
  IO https://github.com/Yahweasel/libav.js/blob/master/docs/IO.md

## 2. PaddleOCR in JS (+ Tesseract.js fallback)

Model side (primary): PaddlePaddle publishes official ONNX exports on Hugging Face, Apache-2.0.
- PP-OCRv6 (2026-06-18), one unified multilingual family (50+ languages per ppu README):
  - `PaddlePaddle/PP-OCRv6_tiny_det_onnx` 1.7 MiB, `..._tiny_rec_onnx` 4.3 MiB (≈6 MiB total, ~6.9k-char dictionary)
  - `..._small_det_onnx` 9.4 MiB, `..._small_rec_onnx` 20.2 MiB (full dictionary)
  - `..._medium_rec_onnx` 73.0 MiB (needs splitting)
- PP-OCRv5: mobile rec 15.8 MiB, server rec 80.6 MiB; per-script recognizers (latin, cyrillic, arabic, devanagari,
  korean, thai, greek, tamil, telugu, eslav, en). https://huggingface.co/PaddlePaddle
- Upstream: https://github.com/PaddlePaddle/PaddleOCR (Apache-2.0, 92k stars, active).

JS runtimes, ranked by credibility for Pouch:
1. **`ppu-paddle-ocr`** 6.6.1 (2026-10-08), MIT, repo pushed 2026-11-01, signed npm provenance, OpenSSF badges.
   https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr . Default PP-OCRv6 tiny; presets v3–v6 incl. per-language v5.
   `/web` entry runs in workers with OffscreenCanvas; accepts ArrayBuffer/canvas; WebGPU auto with WASM fallback;
   self-host by setting `ort.env.wasm.wasmPaths` and pointing model URLs/ArrayBuffers at our copies (it otherwise
   fetches models and ORT from remote by default). Ships an opt-in coi-serviceworker (we would not use it). Depends on
   `ppu-ocv` (canvas engine default; an OpenCV engine exists, avoid it for size). Single maintainer (`snowfluke`).
   Default model files are `.ort` format; portable `.onnx` available.
2. **`paddleocr` (paddleocr.js, x3zvawq)** 1.2.0 (2026-07-03), MIT on npm (no LICENSE detected by GitHub API),
   23 stars, single maintainer. Zero dependencies, BYO ORT, takes `{width,height,data}` pixels and model ArrayBuffers:
   the cleanest API for a VFS CLI. Also table recognition, layout, formula (big models). Approximates OpenCV/pyclipper.
3. `@gutenye/ocr-browser` (MIT, active), `esearch-ocr` (Apache-2.0, active): credible but smaller communities.
4. `@paddlejs-models/ocr` (Baidu Paddle.js, WebGL backend): last release 2023-11, stale; do not adopt.

Tesseract.js fallback: `tesseract.js` 7.0.0 (2025-12-15), Apache-2.0, 38.8k stars, 4 maintainers.
- Core (`tesseract.js-core` 7.0.0): `tesseract-core-simd-lstm.wasm` 2.73 MiB (+ `.wasm.js` 3.72 MiB); relaxed-SIMD
  variants too. Language data `@tesseract.js-data/eng` `4.0.0_best_int/eng.traineddata.gz` 2.82 MiB (full 10.42).
- Self-host: set `workerPath`, `corePath` (directory with all 4 core files), `langPath`; set `workerBlobURL:false`
  (default true creates a blob worker; our CSP allows blob workers but same-origin is cleaner). Caches traineddata in
  IndexedDB (idb-keyval) – decide whether that is acceptable or point `cacheMethod` elsewhere.
- No COI needed; CPU only. Accuracy: strong on clean Latin print, weaker on photos, rotated text, CJK, and mixed layouts;
  PP-OCRv5/v6 is generally much stronger there. Docs: https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md

## 3. parakeet.js (NVIDIA Parakeet TDT 0.6B v3)

- Repo https://github.com/ysdede/parakeet.js (MIT, 73 stars, pushed 2026-10-24, single maintainer `ysdede`).
  npm `parakeet.js` 1.4.4 (2026-04-01), pure JS source (no bundled wasm), depends on `onnxruntime-web`.
  Credits istupakov/onnx-asr (MIT) for the reference implementation.
- Runtime: ORT Web. `backend: 'webgpu'` = encoder on WebGPU, decoder on WASM (recommended); also `webgpu-strict`, `wasm`.
  README: "In WebGPU modes, `int8` encoder requests are upgraded to `fp32`" and "Multithreaded WASM needs cross-origin
  isolation (COOP/COEP)". JS mel preprocessor default (`preprocessorBackend: 'js'`), optional `nemo128.onnx`.
- Model files (HF `ysdede/parakeet-tdt-0.6b-v3-onnx`, CC-BY-4.0, updated 2026-10-25, with provenance manifest; also
  `istupakov/parakeet-tdt-0.6b-v3-onnx`):
  - encoder fp32: `encoder-model.onnx` 39.8 MiB + `.onnx.data` 2,322.6 MiB
  - encoder fp16: 1,181.6 MiB (single file)
  - encoder int8: 622.0 MiB
  - decoder_joint: fp32 69.2, fp16 34.6, int8 17.4 MiB; `vocab.txt` 0.1; `nemo128.onnx` 0.1
  - All encoders need splitting into ≤25 MiB parts (25–93 parts). parakeet.js `fromUrls` takes URLs (incl.
    `encoderDataUrl`), so either a Service Worker reassembler or a small patch to pass ArrayBuffers.
- Realistic choice: WebGPU + fp16 encoder (≈1.18 GiB, verify fp16 is honoured on WebGPU; README only says int8 is
  upgraded) + int8 decoder; WASM-only fallback with int8 encoder (622 MiB), slow single-threaded without COI.
  WebGPU + fp32 means a 2.3 GiB download: avoid.
- Model card https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 : 25 European languages (bg, hr, cs, da, nl, en, et,
  fi, fr, de, el, hu, it, lv, lt, mt, pl, pt, ro, sk, sl, es, sv, ru, uk) with auto language detection; punctuation and
  capitalization; word/segment/char timestamps; up to 24 min with full attention (on A100 80GB) or 3 h with local
  attention; license **CC-BY-4.0** (attribution required in UI/docs).
- API: `transcribe(pcm Float32Array mono, 16000, {returnTimestamps, returnConfidences})`, `transcribeLongAudio`
  (chunking with sentence-aware merge), `createStreamingTranscriber().pushAudioChunk`. Input must already be 16 kHz mono
  float PCM: pair with libav.js (`aresample`/`aformat` filter graph in `default` variant) or WebCodecs/decodeAudioData.
- Gotchas: `fromHub` hits huggingface.co and caches in IndexedDB (`parakeet-cache-db`): never call it in Pouch, use
  `fromUrls`. No published speed numbers in README (unverified; benchmark in-browser). Not Asian languages.

## 4. pdf.js (Mozilla)

- https://github.com/mozilla/pdf.js (Apache-2.0, 54k stars, pushed 2026-10-31); npm `pdfjs-dist` 6.4.299 (2026-10-03).
- Self-host set (6.4.299): `build/pdf.min.mjs` 0.44, `build/pdf.worker.min.mjs` 1.21, `wasm/` 1.47 total
  (`openjpeg.wasm` 0.24 JPEG2000, `jbig2.wasm` 0.10, `qcms_bg.wasm` 0.09 color mgmt, `quickjs-eval.wasm` 0.45 for PDF
  scripting, plus `*_nowasm_fallback.js`), `cmaps/` 1.11, `standard_fonts/` 0.76, `iccs/` 0.01. Library total ≈ 5 MiB;
  `legacy/` (15.7) and `web/` viewer (1.3) optional. Bundled decoder licenses in `wasm/LICENSE_*` (OpenJPEG BSD-2,
  qcms MIT, JBIG2 per its LICENSE file) must ship alongside.
- CSP: grep of 6.4.299 `pdf.mjs`/`pdf.worker.mjs` finds **no `new Function`/`eval` and no `isEvalSupported` option**
  (the old eval-compiled glyph path is gone). Worker: set `GlobalWorkerOptions.workerSrc` to the self-hosted
  `pdf.worker.min.mjs` (module worker, `worker-src 'self'`). Pass `wasmUrl`, `cMapUrl` (+`cMapPacked`),
  `standardFontDataUrl` to self paths (same-origin `connect-src 'self'` covers the worker fetches). Fonts are loaded via
  `new FontFace(name, ArrayBuffer)` (binary source; verify no `font-src` violation in Safari/Firefox). Worker emits
  `blob:` image URLs (already allowed in `img-src`). Text/annotation layers set styles via CSSOM; the full viewer needs
  `style-src`.
- Capabilities: `page.getTextContent()` for text extraction with positions; `page.render()` to a canvas or
  OffscreenCanvas at chosen scale → pixels for OCR (feed PaddleOCR). Viewer vs library: we want only the library.
- Can't: merge, split, reorder, rotate-and-save, encrypt/decrypt-and-save, form flattening (limited write support only
  in the viewer's save path). Companions:
  - `qpdf` WASM: `@neslinesli93/qpdf-wasm` 0.3.0 (ISC wrapper, `qpdf.wasm` 1.27 MiB, repo pushed 2026-10-30);
    `qpdf-wasm` (jsscheller) 0.1.0, 2.16 MiB, 2025-07. qpdf itself Apache-2.0. Emscripten `callMain(argv)` + FS:
    the most CLI-native fit (merge `--pages`, split, decrypt, linearize, repair, JSON inspection).
  - `pdf-lib` 1.17.1 is unmaintained since 2021-11; the active fork is `@cantoo/pdf-lib` 2.11.1 (MIT, 2026-09-15).
    Pure JS, no wasm; good for programmatic edits (stamping, forms, page copy).

## 5. DuckDB-Wasm

- https://github.com/duckdb/duckdb-wasm (MIT, 2.2k stars, pushed 2026-10-29). Docs: https://duckdb.org/docs/2.0/clients/wasm/overview
- Versioning is messy: npm `latest` = `1.33.1-dev57.0` (2026-06-22), `next` = `1.33.1-dev110.0`; last GitHub release
  v1.33.0 (2025-12-16); the 2.0 docs page says "latest stable ... is 2.0.0" but no 2.0.0 is on npm. Pin by exact
  version and record `PRAGMA version` in the manifest.
- Bundles (docs "Deploy"): `mvp` (Wasm 1.0), `eh` (exception handling, faster), `coi` (EH + threads, requires
  cross-origin isolation, "experimental"; must be opted into explicitly). Sizes (1.33.1-dev57.0):
  `duckdb-mvp.wasm` 39.41, `duckdb-eh.wasm` 34.25, `duckdb-coi.wasm` 33.99 MiB – **all over 25 MiB**;
  workers 0.74–0.85 MiB, `duckdb-browser-coi.pthread.worker.js` 0.64; main lib ~1.1 MiB. Ship `eh` only (all target
  browsers have Wasm EH) → ~36 MiB, split engine into 2 parts. Alternative: custom build dropping tpch/tpcds.
- Statically linked extensions per `extension_config_wasm.cmake` on main: json, parquet, autocomplete, icu, tpcds,
  tpch, nanoarrow (Arrow IPC). Verify in situ with `SELECT * FROM duckdb_extensions()`.
- Loadable extensions (sqlite_scanner for `.sqlite`/`.db`, excel for xlsx, spatial, fts, inet) are fetched at LOAD from
  `extensions.duckdb.org/duckdb-wasm/$version/$platform/$name.duckdb_extension.wasm` (Brotli, signed in a custom
  section). **Self-hostable**: `SET custom_extension_repository='https://pouch.bayleaf.dev/duckdb-ext'` with the same
  path layout; signatures survive copying. Also set `allow_community_extensions=false` and consider disabling
  autoload/autoinstall plus `lock_configuration`, so SQL cannot reach the network. Extension sizes unverified (paths for
  this dev version 404'd for v1.4.x/v1.5.x guesses; derive the exact `$version` from the engine).
- Security note (docs): "DuckDB-Wasm in the default setting can access remote endpoints". With our `connect-src`, httpfs
  could only reach `api.bayleaf.dev`/localhost/self, but still lock it down in config.
- Files: `registerFileBuffer` (Uint8Array), `registerFileHandle` (File / FileSystemFileHandle with
  `BROWSER_FSACCESS`), `registerFileText`, `registerFileURL`; built-in `opfs://` path handling
  (`opfs.fileHandling: 'auto'`, `registerOPFSFileName`) seen in the 1.33 bundle. Reads CSV, Parquet, JSON natively;
  SQLite via extension; Arrow IPC in/out. 4 GB Wasm memory ceiling, browsers lower.
- Shell: `@duckdb/duckdb-wasm-shell` (1.8 MiB, xterm.js + webgl addon) is a full terminal UI, not a stdin/stdout
  program. For Pouch, write our own `duckdb` command: `duckdb [-csv|-json|-markdown] [-c SQL] [db]` over the VFS,
  rendering Arrow results. Single worker, `AsyncDuckDB`.
- CSP: CDN example uses a blob worker with `importScripts`; with self-hosted files use `new Worker('/…/duckdb-browser-eh.worker.js')`
  directly (no blob). Needs `'wasm-unsafe-eval'`. Arrow version pinning matters (apache-arrow ^17).

## 6. PondPilot and PondPilot Widget

- PondPilot app: https://github.com/pondpilot/pondpilot , **AGPL-3.0**, v0.10.0 (2026-07-11), 256 stars, active.
  React + Mantine + Monaco + DuckDB-Wasm + SheetJS `xlsx` + FlowScope + recharts + reactflow; PWA. Formats: CSV,
  Parquet, JSON, XLSX, DuckDB, Stata, SAS, SPSS; remote HTTP/S3/Iceberg; built-in CORS proxy; AI SQL assistant with
  OpenAI/Anthropic/custom endpoints.
  - Hosted app observations (curl of https://app.pondpilot.io/, 2026-11-01): loads **Cloudflare Web Analytics**
    (`static.cloudflareinsights.com/beacon.min.js`); sends `COOP: same-origin`, `COEP: credentialless`;
    CSP is report-only with `connect-src https: http:` and script-src allowing jsDelivr, cdn.sheetjs.com,
    extensions.duckdb.org, community-extensions, ext.motherduck.com; `frame-ancestors 'none'` (cannot be iframed).
  - Embeddability: not a component; would be an iframe of a self-built copy (Docker image or Vite build). Under our
    posture it needs a fork that strips analytics, CORS proxy, AI providers, remote sources and CDN loads. AGPL means
    our modified hosted copy must offer its source to users. Large Monaco + React bundle (size unverified, several MiB
    before DuckDB). Not a good fit for Pouch's single-file, high-sensitivity design; borrow ideas, not code.
- PondPilot Widget: https://github.com/pondpilot/pondpilot-widget , MIT, npm `pondpilot-widget` 1.4.0 (2025-11-03),
  13 stars, ~22 KB min, unpacked 140 KB. Turns `<pre class="pondpilot-snippet">` into runnable SQL. By default imports
  DuckDB from `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@<ver>/+esm` and builds a blob worker with
  `importScripts`; override with the `duckdbModule` option (pass our own module/instance). Data via `baseUrl`/init
  queries, i.e. URL-oriented, not "files we pass in"; we'd need to pre-register VFS files on the shared DuckDB. Light,
  but its value over our own small result-table renderer is modest. Stale since 2025-11.

## 7. File-browser previews and CSP deltas

| Type | Mechanism | CSP delta |
|---|---|---|
| Images (png/jpg/gif/webp/avif/svg) | `<img src=blob:>` from VFS bytes | none (`img-src blob:` present). Render SVG only via `<img>` (scripts inert), never inline. |
| Audio/video | `<audio>/<video src=blob:>` | **add `media-src 'self' blob:`** (falls back to `default-src 'none'` today). Codec support is browser-dependent; libav.js can transcode to WebM/Opus for preview. |
| PDF | pdf.js render to `<canvas>` | worker/wasm/cmaps/fonts are same-origin (`connect-src 'self'`, `worker-src 'self'`). Do **not** use native viewer in `<iframe>/<object>` (would need `frame-src`/`object-src blob:` and differs per browser). Possibly `font-src` if FontFace path changes; verify. |
| DB (sqlite, duckdb, parquet, csv, xlsx) | DuckDB-Wasm query → table | none beyond `'wasm-unsafe-eval'`; self-host extensions under `'self'`. |
| Text/code | existing | none |

Canvas drawing itself is not governed by CSP.

---

## 8. Cross-cutting

### Total bytes if everything ships (approximate, MiB)
| Component | Eager | Lazy on first use |
|---|---|---|
| libav.js default-cli (+ webm-cli or obsolete optionally) | – | 2.6 each |
| pdf.js library + wasm + cmaps + fonts | – (or eager ~1.7 for core) | ≈5 |
| qpdf.wasm | – | 1.3 |
| @cantoo/pdf-lib | – | ~1 (unverified) |
| DuckDB-Wasm eh (engine split in 2 parts) | – | ≈36 |
| DuckDB extensions (sqlite_scanner, excel) | – | unverified, likely a few MiB each |
| ORT Web (CPU 14.2, or WebGPU asyncify 27.4 split) | – | 14–28 (shared with LFM3) |
| PP-OCRv6 tiny det+rec | – | ≈6 (small ≈30) |
| Tesseract core + eng best_int | – | ≈6.5 |
| Parakeet v3 (fp16 enc + int8 dec) | – | ≈1,200 (int8 WASM path ≈640) |

Everything except the file-browser shell should be lazy. Excluding Parakeet, the full toolset is ≈75–100 MiB;
Parakeet dominates and belongs in the same explicit "download model" consent flow as LFM3.

### COOP/COEP
- Gains: SharedArrayBuffer → ORT WASM threads (the CPU fallback for OCR/ASR on browsers or devices without WebGPU;
  multi-x speedups), DuckDB `coi` bundle (experimental), libav.js `thr` (video only matters). WebGPU paths gain nothing.
- Header choice: `COOP: same-origin` + `COEP: require-corp`. `credentialless` is unsupported in Safari (MDN BCD:
  safari false; Chrome 96, Firefox 119). COEP supported Chrome 83, Firefox 79, Safari 15.2.
- What it would break: (a) `fetch()` to `api.bayleaf.dev` and localhost are CORS-mode requests and are fine under
  `require-corp` provided those servers send correct CORS headers (they must already); (b) any **no-cors** cross-origin
  subresource (img/script/iframe from another origin) would need CORP headers – Pouch self-hosts everything, so likely
  none; (c) COOP `same-origin` severs `window.opener` for cross-origin popups – check any popup-based login/device
  flow to api.bayleaf.dev; (d) blob workers inherit the creator's policy and keep working; (e) Cloudflare Static Assets
  supports a `_headers` file, so this is cheap to add, and the headers must also apply to worker script responses.
  Pouch's LFM3 qualification already ran successfully with COOP same-origin + COEP require-corp.
- Verdict: moderately helpful, low risk for this static, self-hosted app. Adopt only after auditing popup/auth flows
  and confirming CORS on api.bayleaf.dev; keep single-threaded fallbacks everywhere regardless (Safari private mode,
  memory limits, and COI regressions).

### Licensing posture for a public repo
- libav.js: LGPL-2.1 → must provide corresponding source for the exact build; serve the release `sources/` alongside
  (or a durable link with a written offer), and keep the libraries replaceable (they are separate files: satisfied).
- pdf.js Apache-2.0 (+ bundled OpenJPEG BSD, qcms MIT, JBIG2 license files), DuckDB MIT, ORT MIT, ppu/paddleocr.js MIT,
  Tesseract Apache-2.0, qpdf Apache-2.0 (+ ISC wrapper), pdf-lib MIT: ship NOTICE/LICENSE files.
- Models: PP-OCR Apache-2.0; Parakeet v3 CC-BY-4.0 (attribution in UI and docs); Tesseract traineddata Apache-2.0.
- PondPilot AGPL-3.0: network-use source obligation if we host a modified copy; avoid unless deliberate.
- Avoid MPEG-patent codec builds (Yahweasel's own refusal; also patent exposure for a public university service).

### Top risks
1. 25 MiB per-file limit: DuckDB engine, ORT WebGPU WASM and all ASR weights need a verified part-reassembly path.
2. Parakeet download size (0.6–2.3 GiB) and GPU memory on student laptops; fp16-on-WebGPU behaviour needs testing.
3. Default-to-CDN behaviour in ORT (`wasmPaths`), ppu-paddle-ocr (models), parakeet.js (`fromHub`), DuckDB
   (extensions, `getJsDelivrBundles`), Tesseract (core/lang), pondpilot-widget (jsDelivr). CSP will block these, but
   every default must be overridden explicitly or tools fail at runtime.
4. Single-maintainer dependencies: libav.js, parakeet.js, ppu-paddle-ocr, paddleocr.js. Pin, hash, vendor.
5. DuckDB-Wasm version confusion (dev builds as npm `latest`) and extension path tied to exact engine version.
6. Hash-only `script-src` vs Emscripten dynamic glue loading: each tool needs CSP qualification in a dedicated worker.
7. AAC/M4A audio has no libav.js published decoder; relies on WebCodecs or main-thread `decodeAudioData`.
