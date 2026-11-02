# Experimental static deployment

Live at **https://pouch.bayleaf.dev/**, also **/pouch.html**. This is an experimental
deployment built from `main`, not a tagged reproducible release or a transparency log
(issue #138). A checksum served by the same operator identifies bytes but is not
independent evidence of their provenance.

## Architecture and privacy

- Cloudflare Workers Static Assets, project `bayleaf-pouch`, BayLeaf account
  `1a49fb69291d42e23c4ed4dcffce5bbc`; configuration: `wrangler.jsonc`.
- No Worker script, SSR, functions, runtime bindings, middleware, analytics bundle,
  telemetry collector, conversation store or server-side application code.
  `run_worker_first: false`, observability disabled, workers.dev and preview URLs disabled.
- Only `pouch.html`, `SHA256SUMS`, the app shell (`sw.js`, `manifest.webmanifest`,
  `icons/*.png`), static `_headers`/`_redirects` configuration and the tool
  runtimes under `runtime/<group>/` listed in `SHA256SUMS` enter the allowlisted
  upload (see "Transformers.js code and LFM3 weights" below; README "Add-ons"). Model weights are not uploaded: they
  come from the BayLeaf HF gateway. `/` rewrites internally to `/pouch.html` (200).
  Unmatched paths return 404 rather than exposing source or SPA fallback.
- The host may process/retain request metadata, including IP addresses, paths,
  timestamps and security events. No claim that static hosting proves API/model
  statelessness: those services have their own data boundaries.
- Browser conversation/file storage remains local. Sealed inference uses the existing
  BayLeaf API/Tinfoil encrypted path. The `bayleaf` tool's approved non-inference
  egress is a separate plaintext boundary, as described in the README.
- CSP is the built page's exact hash-based script policy, with only
  `connect-src 'self' https://api.bayleaf.dev http://localhost:* http://127.0.0.1:*` (`'self'`: runtime files; `api.bayleaf.dev`: inference, the `bayleaf` tool and model weights; loopback: the Localhost provider, where `[::1]` is not a valid CSP source in Chromium; `deploy.mjs` checks this exact list); the response additionally denies framing and
  objects. `no-store, no-transform`, no-referrer, nosniff, HSTS, noindex and restrictive
  camera/microphone/geolocation policy are static response headers.
- Cloudflare injects NEL network-error-reporting headers, and removing them in
  `_headers` does not suppress the injection. Explicit `NEL: {"max_age":0}` and an
  empty, expired `cf-nel` reporting group disable reporting for this origin; no
  zone-wide settings are changed. `deploy.mjs` checks that served bytes match the
  local artifact exactly (no platform script injection).

## Transformers.js code and LFM3 weights

Both are one asked add-on (README "Add-ons"): installed only after the user approves.
Weights are not in the artifact (issue #121). The page fetches the LFM3 files from
`https://api.bayleaf.dev/hf/onnx-community/LFM3-1.7B-ONNX/resolve/<commit>/<path>` in
32 MiB byte ranges and checks each whole file against `models.lock.json` (pinned into the
page by the build); `src/models.ts`, README "Transformers.js". `node build.mjs` builds the
Transformers.js code and needs no model files; `--no-models` builds without the code and the
provider, and `--with-models` is accepted and does nothing more. Shape of the build:

| File | Count | Size |
|---|---:|---|
| `runtime/transformers/manifest.<sha16>.json` (each file's parts, sizes, SHA-256) | 1 | ~1 KB |
| `runtime/transformers/<sha256>.bin`: the worker bundle (Transformers.js 4.3.2 + ORT Web 1.31.0-dev WebGPU, CDN and Hub defaults rewritten to nothing and the gateway) | 1 | 0.56 MB |
| `runtime/transformers/<sha256>.bin`: the ORT wasm, split at 20 MiB | 2 | 26.9 MB |
| with the page, `SHA256SUMS` and the 7 app-shell files | 13 | 31 MiB |

`deploy.mjs` refuses any listed file over 25 MiB (Cloudflare Static Assets' limit,
<https://developers.cloudflare.com/workers/platform/limits/#static-assets>), any path
outside the allowlist (`pouch.html`, the shell, `runtime/<group>/manifest.<hex16>.json`,
`runtime/<group>/<sha256>.bin`), any name that is not its content hash, any file whose
bytes differ from `SHA256SUMS`, a runtime manifest that `pouch.html` does not embed, and
a manifest part that is missing or different. Instead of downloading 1 GB of weights to
verify them, it checks that `GET /hf/catalog/<repo>` approves the lock's commit with every
file at the same size and SHA-256 and already mirrored (metadata, a few KB).

Headers: `Cache-Control` is set per path, never on `/*`: `/`, `/pouch.html`,
`/SHA256SUMS` stay `no-store, no-transform`; `/runtime/*` is `public, max-age=31536000,
immutable` (content-addressed names). The security headers and CSP stay on `/*`.

Privacy: Cloudflare (the static host) sees runtime downloads; the BayLeaf API's gateway
sees which LFM3 files and byte ranges a client fetched, with its IP and timing (no
identity: the gateway is keyless and ignores credentials; see the API's HF-GATEWAY.md).
Hugging Face sees nothing. No prompt, file or reply goes anywhere with Transformers.js.
The page asks before downloading (an approval sheet naming size, storage, license and
origin).

Weights that earlier builds served from pouch.bayleaf.dev's `models/` path (now 404) are
not migrated: the first load deletes their cache (`pouch-local-models`), so LFM3 must be
installed again (`src/interface/boot.ts`).

## pdf.js add-on

Pouch's first heavy-tool add-on (quiet: 3.9 MiB from this origin, so it installs on first
use and says so): `build-pdf.mjs` builds `runtime/pdf/` from
`pdfjs-dist` 6.4.299 (exact pin in `package.json`; npm integrity in the lockfile; the
build also checks the SHA-256 of `pdf.mjs` and `pdf.worker.mjs`). The page embeds its
manifest's SHA-256 (define `POUCH_PDF_RUNTIME`) and fetches it only when a pdf command
first runs.

| File | Count | Size |
|---|---:|---|
| `runtime/pdf/manifest.<sha16>.json` | 1 | ~1 KB |
| `worker.js` part: pdf.js library and worker code in one module worker (fetch helpers rewritten to read `data.pack`) | 1 | 1.6 MiB |
| `data.pack` part: 168 cmaps, 14 standard fonts, `openjpeg.wasm`, `jbig2.wasm`, `qcms_bg.wasm`, the CMYK ICC profile | 1 | 2.3 MiB |
| `NOTICE.txt` part: pdf.js Apache-2.0 and the OpenJPEG (BSD-2), JBIG2 and Foxit (PDFium BSD), qcms (MIT), Liberation fonts, Adobe cmaps and ICC profile licenses, verbatim | 1 | 61 KB |

Total 3.9 MiB in 4 files, well under the 25 MiB part limit (the `deploy.mjs` allowlist
covers `runtime/<group>/`). Not shipped: pdf.js's
scripting sandbox (`quickjs-eval.wasm`, `pdf.sandbox.mjs`), the `*_nowasm_fallback.js`
decoders, `legacy/` and the `web/` viewer. CSP delta: none; the worker is a `blob:` module
worker (`worker-src 'self' blob:`), wasm runs under the existing `'wasm-unsafe-eval'`,
and pdf.js makes no request of its own (checked with no CSP violation in
`test/pdf-browser.mjs`, Chromium only). Privacy: Cloudflare sees that this browser
fetched pdf.js; no PDF content leaves the page.

## DuckDB-Wasm add-on

Pouch's third heavy-tool runtime: `build-duckdb.mjs` builds `runtime/duckdb/` from
`@duckdb/duckdb-wasm` 1.32.0 (exact pin in `package.json`; npm integrity in the lockfile; the
build also checks the SHA-256 of `duckdb-eh.wasm` and `duckdb-browser-blocking.mjs`) and the
DuckDB v1.4.3 `parquet` and `json` extensions from `extensions.duckdb.org` (fetched once with
curl into `node_modules/.cache/pouch-duckdb-ext/`, pinned by SHA-256 in `EXTENSIONS`). The page
embeds its manifest's SHA-256 (define `POUCH_DUCKDB_RUNTIME`). It is the asked add-on `duckdb`
(`src/addons-registry.ts`): the page fetches it only when the person installs it, never on a command.

| File | Count | Size |
|---|---:|---|
| `runtime/duckdb/manifest.<sha16>.json` | 1 | ~1 KB |
| `worker.js` part: src/duckdb/worker.ts with DuckDB-Wasm's synchronous browser bindings and apache-arrow 17 | 1 | 1.3 MiB |
| `duckdb-eh.wasm` parts: the released `duckdb-eh.wasm` with one 48-byte string rewritten (an unpkg stylesheet link in the EXPLAIN html template) | 2 | 32.7 MiB (20.0 + 12.7) |
| `extensions.pack` part: the signed `parquet` (2.9 MiB) and `json` (0.8 MiB) extensions for v1.4.3 `wasm_eh`, unmodified | 1 | 3.7 MiB |
| `NOTICE.txt` part: DuckDB's MIT license (the npm package ships none), a pointer to its third_party licenses, apache-arrow's LICENSE and NOTICE | 1 | 112 KB |

Total 37.8 MiB in 6 files (largest 20.0 MiB, under the 25 MiB per-file limit). Only the
`eh` build ships (every browser Pouch supports has Wasm exceptions); not the `mvp` or `coi`
builds or the library's own async worker. Not threaded (no SharedArrayBuffer, so no
COOP/COEP). CSP delta: none; the worker is a `blob:` module worker and wasm runs under the
existing `'wasm-unsafe-eval'` (checked with no CSP violation in `test/duckdb-browser.mjs`,
Chromium only). Privacy: Cloudflare sees that this browser fetched the DuckDB runtime; no
data leaves the page.

## libav.js add-on

Pouch's second heavy-tool add-on (quiet: 7.8 MiB from this origin; the 44 MiB source offer
is never fetched by the page): `build-libav.mjs` builds `runtime/libav/` from
`@libav.js/variant-webm-vp9-cli` and `@libav.js/variant-webcodecs-avf` 6.10.9 (exact pins in
`package.json`; npm integrity in the lockfile; the build also checks the SHA-256 of each
wrapper, factory and wasm; the webm-vp9-cli ones equal the libav.js 6.10.9.0 release zip's
`dist/`, the webcodecs-avf ones are npm's, not yet compared with the zip). The page embeds its manifest's SHA-256
(define `POUCH_LIBAV_RUNTIME`) and fetches it only when `ffprobe` or `ffmpeg` first runs.

| File | Count | Size |
|---|---:|---|
| `runtime/libav/manifest.<sha16>.json` | 1 | ~1 KB |
| `worker.js` part: src/media/worker.ts (and src/media/wc.ts) with both variants' wrappers and Emscripten factories | 1 | 450 KB |
| `libav.wasm` part: the released `libav-6.10.9.0-webm-vp9-cli.wasm.wasm`, unmodified | 1 | 3.9 MiB |
| `libav-avf.wasm` part: the released `libav-6.10.9.0-webcodecs-avf.wasm.wasm`, unmodified (the WebCodecs path: MOV demuxer, swresample, audio filters, FLAC and Opus encoders) | 1 | 3.4 MiB |
| `NOTICE.txt` part: what is shipped, where the source is, and the LGPL-2.1, FFmpeg, libav.js, libvpx (license and patent grant), Opus and emfiberthreads licenses, verbatim | 1 | 39 KB |

Total 7.8 MiB in 5 files (largest 3.9 MiB, under the 25 MiB per-file limit). Both wasm
files are fetched together on the first media command. `webcodecs-avf` is built from the
same FFmpeg 9.0, opus 1.6.1, libav.js and emfiberthreads tarballs already in
`runtime/libav-source/` (it has no libvpx), so it adds no corresponding source.
H.264, HEVC, AAC and MP3 are decoded by the browser's WebCodecs, so Pouch ships no
decoder for them. Why `webm-vp9-cli` and not `default-cli` (2.2 MiB wasm):
`default-cli` has no video decoder at all, so it cannot extract a frame; `webm-vp9-cli`
adds VP8, VP9, swscale and the video filters for 1.8 MiB more. Not threaded (no
SharedArrayBuffer, so no COOP/COEP). CSP delta: none; the worker is a `blob:` module
worker and wasm runs under the existing `'wasm-unsafe-eval'` (checked with no CSP violation
in `test/media-browser.mjs`, Chromium only). Privacy: Cloudflare sees that this browser
fetched the media runtime; no media content leaves the page.

**LGPL-2.1 corresponding source (decided by Adam).** libav.js's README says
anyone distributing it must provide the sources; its release zip carries them in
`sources/`. Pouch hosts them from the same site as the binary (LGPL-2.1 section 6(d):
equivalent access from the same place), as a second group the page names but never
fetches: `runtime/libav-source/`, 43.9 MiB in 11 files (largest part 11.5 MiB, so no file
needed splitting), listed in SHA256SUMS so `deploy.mjs` uploads it. It is the release's
whole `sources/`: the five tarballs this variant links, then the five it does not.

| Tarball | Size | Source |
|---|---:|---|
| `libav.js-6.10.9.0.tar.gz` | 6.5 MiB | GitHub archive of tag v6.10.9.0 (build scripts, configs, patches) |
| `ffmpeg-9.0.tar.xz` | 11.5 MiB | ffmpeg.org |
| `opus-1.6.1.tar.gz` | 10.0 MiB | downloads.xiph.org |
| `libvpx-1.16.0.tar.gz` | 5.4 MiB | GitHub archive of tag v1.16.0 |
| `emfiberthreads-1.3.tar.gz` | 8 KB | GitHub archive of tag v1.3 |
| `libvorbis-1.3.7.tar.xz` (not linked) | 1.1 MiB | downloads.xiph.org |
| `libogg-1.3.6.tar.xz` (not linked) | 430 KB | downloads.xiph.org |
| `lame-3.100.tar.gz` (not linked) | 1.5 MiB | sourceforge.net |
| `libaom-03087864.tar.gz` (not linked) | 6.1 MiB | GitLab archive of webmproject/libaom at 03087864 |
| `zlib-1.3.2.tar.gz` (not linked) | 1.4 MiB | zlib.net fossils |

Nine are byte-identical to the release zip's `sources/` (SHA-256 checked); the
tenth is GitHub's archive of the libav.js tag, the same tree as the zip's `libav.js.tar.xz`
(`git archive HEAD | xz`) in a different compression (accepted by Adam). `build-libav.mjs`
downloads them once into `node_modules/.cache/pouch-libav-source/` (so the first build needs
the network) and checks each pinned SHA-256 on every build. `NOTICE.txt` and `ffmpeg -h`
name the source manifest; the manifest lists each tarball's parts in order, and `NOTICE.txt`
lists the five unlinked ones as included for completeness, not linked. No written offer is
made, because the source sits next to the binary. The wasm is unmodified; the wrapper is
bundled unmodified, and the Emscripten factory with three rewrite rules (six replacements)
that disable code paths, visible in `build-libav.mjs`.

## Installable app shell

`build.mjs` also emits `sw.js`, `manifest.webmanifest` and `icons/*.png`
(generated by `icons/make-icons.py` from the BayLeaf logo), all listed in
`SHA256SUMS` after `pouch.html`; the page embeds `sw.js`'s SHA-256. `deploy.mjs`
allowlists exactly these paths, requires all of them, checks that the page expects the
shipped `sw.js`, stages and snapshots them, and after deploy verifies their bytes and
cache headers. README "Install and the offline copy" has the policy.

- CSP: `worker-src 'self' blob:` (registering `/sw.js`), `manifest-src 'self'` and
  `img-src 'self' data: blob:` (the manifest and apple-touch icons: real Chrome blocks
  them without `'self'` even though Playwright's installability check passes).
  `deploy.mjs` requires all three directives.
- `_headers`: `/sw.js` and `/manifest.webmanifest` are `no-cache, no-transform`
  (revalidated every time, so a release reaches them at once); `/icons/*`
  `public, max-age=86400`; the page and `SHA256SUMS` stay `no-store`.
- Tests: `test/pwa-browser.mjs` (Chromium: installability, offline reload, update and
  refusal, pass-through, trust panel, uninstall, Erase all). Cloudflare serves the
  manifest as `application/manifest+json`. Not verified: install on Android and iOS,
  Safari, Firefox (Playwright WebKit fails the offline path; see JOURNEYS).

## Report viewer and previews

- CSP (page): `frame-src 'self'; media-src blob:` (embed `/viewer.html`; play audio
  and video previews from memory). No other directive changes; `deploy.mjs` rejects any
  network source in `frame-src`, `child-src` or `media-src`.
- New shell file `viewer.html` (in SHA256SUMS, the offline copy and the deploy allowlist)
  with its own policy: no network of any kind (README "HTML reports"). `_headers` now comes
  from `headers.mjs`: `/viewer.html` detaches the page's CSP, `X-Frame-Options` and
  `Permissions-Policy` and sets its own CSP with `frame-ancestors 'self'; sandbox
  allow-scripts`, `X-Frame-Options: SAMEORIGIN` and `Cache-Control: no-cache`. Detach
  semantics confirmed live: the viewer's CSP is the only one on that path (`deploy.mjs`
  verifies the served headers).

## Current artifact

- `e4bfeb9` (label `e4bfeb9 2026-11-02`), the head of #148 stacked on #147 (not yet on
  `main`), built from a clean tree with `npm ci` and `node build.mjs` (which now also runs
  `tsc` on both projects), deployed with `node deploy.mjs` for playtesting.
- HTML SHA-256: `492d41198448f522629c670ed6c625bddfe50c408ac16cc64af9b04527a65290`.
- Cloudflare version: `ddc52cdd-ca0a-4c78-87e6-14d993cacde3`.
- `deploy.mjs` verified the page, `SHA256SUMS`, 7 shell files and 24 runtime parts,
  byte-exact and immutable.
- Includes the TypeScript migration (#147) and the type-debt pay-down with its bug fixes
  and guards (#148).
- Before the playtest, the live Sealed journey suites and twelve scripted journeys against
  the deployed site passed (about 137 Sealed requests); then playtested on Mac Chrome.
  Not verified: Firefox and Safari end to end.

## Deploy and verify

Use the approved `cf` profile `ucsc` and installed Wrangler (qualified with 4.91.0).
From `pouch/`, after concurrent source editing has stopped:

```bash
npm ci
node build.mjs
node deploy.mjs --check       # verify and stage only
node deploy.mjs
```

`deploy.mjs` never builds implicitly. It checks the prebuilt manifest and inline
script hashes, records `.deploy/<sha256>/`, stages only approved assets in an isolated
temporary directory, pins the BayLeaf account, refreshes the approved OAuth login by
an API read, passes its bearer privately to Wrangler, and verifies served bytes and
headers afterward. Wrangler CLI metrics are disabled. No token is written to the
upload or printed. `.deploy/` is ignored and contains rollback artifacts, not secrets.
This deploy command publishes and must only be run when publishing is authorized.

Independent verification of the canonical download:

```bash
curl --fail --output pouch.html https://pouch.bayleaf.dev/pouch.html
curl --fail --output SHA256SUMS https://pouch.bayleaf.dev/SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

Run downloads in a scratch directory, not over source `pouch.html`. Recheck browser
boot/attestation and no injected scripts after any host or build change.

## Rollback

To redeploy an earlier artifact, from `pouch/` on the machine that deployed it. The
snapshot `.deploy/<html-sha256>/` keeps the page, `SHA256SUMS`, the shell files and the
headers, but only lists the runtime parts: rebuild them at the artifact's commit
(`node build.mjs`, pinned packages) and copy `dist/runtime/` into the snapshot first.

```bash
cp -R dist/runtime .deploy/<html-sha256>/   # from a build at that commit
node deploy.mjs .deploy/<html-sha256>
```

This creates a new deployment using preserved bytes and current deployment policy;
it does not rewrite git history. Earlier HTML hashes and Cloudflare version IDs are in
this file's git history; the Cloudflare dashboard can also roll back by version ID.
Removing this public surface/domain is a separate operator decision, not automatic.

## Deferred

Public tagged reproducible-release transparency, independent hash distribution and
release automation (issue #138), broader discovery/documentation and inference
qualification.
The existing page's release-check language describes the intended trust practice,
not proof that this experimental build has received a public tagged release.
