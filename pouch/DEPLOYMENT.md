# Experimental static deployment

Live at **https://pouch.bayleaf.dev/**, also **/pouch.html**. This is an authorized
uncommitted proof of concept, not a tagged reproducible release or a transparency log.
There have been no git commits or pushes for this deployment. A checksum served by
the same operator identifies bytes but is not independent evidence of their provenance.

## Architecture and privacy

- Cloudflare Workers Static Assets, project `bayleaf-pouch`, BayLeaf account
  `1a49fb69291d42e23c4ed4dcffce5bbc`; configuration: `wrangler.jsonc`.
- No Worker script, SSR, functions, runtime bindings, middleware, analytics bundle,
  telemetry collector, conversation store or server-side application code.
  `run_worker_first: false`, observability disabled, workers.dev and preview URLs disabled.
- Only `pouch.html`, `SHA256SUMS`, the app shell (`sw.js`, `manifest.webmanifest`,
  `icons/*.png`), static `_headers`/`_redirects` configuration and the tool
  runtimes under `runtime/<group>/` listed in `SHA256SUMS` enter the allowlisted
  upload (see "Transformers.js artifact" below). Model weights are not uploaded: they
  come from the BayLeaf HF gateway. `/` rewrites internally to `/pouch.html` (200).
  Unmatched paths return 404 rather than exposing source or SPA fallback.
- The host may process/retain request metadata, including IP addresses, paths,
  timestamps and security events. No claim that static hosting proves API/model
  statelessness: those services have their own data boundaries.
- Browser conversation/file storage remains local. Sealed inference uses the existing
  BayLeaf API/Tinfoil encrypted path. The `bayleaf` tool's approved non-inference
  egress is a separate plaintext boundary, as described in the README.
- CSP is the built page's exact hash-based script policy, with only
  `connect-src 'self' https://api.bayleaf.dev http://localhost:* http://127.0.0.1:*` (`'self'` since the Transformers.js provider: model files; loopback since the Localhost provider, not yet deployed; `deploy.mjs` checks this exact list); the response additionally denies framing and
  objects. `no-store, no-transform`, no-referrer, nosniff, HSTS, noindex and restrictive
  camera/microphone/geolocation policy are static response headers.
- Cloudflare initially injected NEL network-error-reporting headers. Removing them
  in `_headers` did not suppress late injection. Explicit `NEL: {"max_age":0}` and
  an empty, expired `cf-nel` reporting group do: these disable reporting for this
  origin and clear any policy cached from initial qualification. No zone-wide
  settings were changed. No platform script injection was observed: served bytes
  match the local artifact exactly.

## Transformers.js artifact (weights from the BayLeaf HF gateway since 2026-11-01; not deployed)

Weights left the artifact (issue #121). The page downloads the LFM3 files from
`https://api.bayleaf.dev/hf/onnx-community/LFM3-1.7B-ONNX/resolve/<commit>/<path>` in
32 MiB byte ranges and checks each whole file against `models.lock.json` (pinned into the
page by the build); `src/models.js`, README "Transformers.js". `node build.mjs` always
builds the runtime (`--no-models` omits the provider; `--with-models` is accepted and
does nothing more) and needs no model files. Shape of the tested build (2026-11-01):

| File | Count | Size |
|---|---:|---|
| `runtime/transformers/manifest.<sha16>.json` (each file's parts, sizes, SHA-256) | 1 | ~1 KB |
| `runtime/transformers/<sha256>.bin`: the worker bundle (Transformers.js 4.3.2 + ORT Web 1.31.0-dev WebGPU, CDN and Hub defaults rewritten to nothing and the gateway) | 1 | 0.56 MB |
| `runtime/transformers/<sha256>.bin`: the ORT wasm, split at 20 MiB | 2 | 26.9 MB |
| whole artifact with the page, sums and app shell | 12 | 31 MiB |

With `_headers` and `_redirects` the upload is 14 files (was 70 files, 1,086 MiB).
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
origin). `connect-src` is unchanged: `https://api.bayleaf.dev` was already listed.

Deploy (needs approval; not run): `npm ci && node build.mjs && node deploy.mjs --check &&
node deploy.mjs`. After deploy, `deploy.mjs` downloads every runtime part (about 30 MiB)
and checks its SHA-256 and the immutable cache policy. Users who downloaded the model
from pouch.bayleaf.dev keep it: the page reassembles the old parts, checks them against
the lock and moves them (README "Transformers.js"). The old `models/` parts on the host
stop being uploaded; a release without them makes those URLs 404.

## pdf.js runtime (built and tested locally, not deployed; 2026-11-01)

Pouch's first heavy-tool runtime: `build-pdf.mjs` builds `runtime/pdf/` from
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

Total 3.9 MiB in 4 files, well under the 25 MiB part limit; `deploy.mjs` needed no
change (its allowlist already covers `runtime/<group>/`). Not shipped: pdf.js's
scripting sandbox (`quickjs-eval.wasm`, `pdf.sandbox.mjs`), the `*_nowasm_fallback.js`
decoders, `legacy/` and the `web/` viewer. CSP delta: none; the worker is a `blob:` module
worker (`worker-src 'self' blob:`), wasm runs under the existing `'wasm-unsafe-eval'`,
and pdf.js makes no request of its own (checked with no CSP violation in
`test/pdf-browser.mjs`, Chromium only). Privacy: Cloudflare sees that this browser
fetched the pdf runtime; no PDF content leaves the page.

## libav.js runtime (built and tested locally, not deployed; 2026-11-01)

Pouch's second heavy-tool runtime: `build-libav.mjs` builds `runtime/libav/` from
`@libav.js/variant-webm-vp9-cli` 6.10.9 (exact pin in `package.json`; npm integrity in the
lockfile; the build also checks the SHA-256 of the wrapper, factory and wasm, which equal
the libav.js 6.10.9.0 release zip's `dist/`). The page embeds its manifest's SHA-256
(define `POUCH_LIBAV_RUNTIME`) and fetches it only when `ffprobe` or `ffmpeg` first runs.

| File | Count | Size |
|---|---:|---|
| `runtime/libav/manifest.<sha16>.json` | 1 | ~1 KB |
| `worker.js` part: src/media/worker.js with libav.js's wrapper and Emscripten factory | 1 | 214 KB |
| `libav.wasm` part: the released `libav-6.10.9.0-webm-vp9-cli.wasm.wasm`, unmodified | 1 | 3.9 MiB |
| `NOTICE.txt` part: what is shipped, where the source is, and the LGPL-2.1, FFmpeg, libav.js, libvpx (license and patent grant), Opus and emfiberthreads licenses, verbatim | 1 | 38 KB |

Total 4.2 MiB in 4 files. Why `webm-vp9-cli` and not `default-cli` (2.2 MiB wasm):
`default-cli` has no video decoder at all, so it cannot extract a frame; `webm-vp9-cli`
adds VP8, VP9, swscale and the video filters for 1.8 MiB more. Not threaded (no
SharedArrayBuffer, so no COOP/COEP). CSP delta: none; the worker is a `blob:` module
worker and wasm runs under the existing `'wasm-unsafe-eval'` (checked with no CSP violation
in `test/media-browser.mjs`, Chromium only). Privacy: Cloudflare sees that this browser
fetched the media runtime; no media content leaves the page.

**LGPL-2.1 corresponding source (decision, for Adam to confirm).** libav.js's README says
anyone distributing it must provide the sources; its release zip carries them in
`sources/`. Pouch hosts them from the same site as the binary (LGPL-2.1 section 6(d):
equivalent access from the same place), as a second group the page names but never
fetches: `runtime/libav-source/`, 33.4 MiB in 6 files (largest part 11.5 MiB, so no file
needed splitting), listed in SHA256SUMS so `deploy.mjs` uploads it:

| Tarball | Size | Source |
|---|---:|---|
| `libav.js-6.10.9.0.tar.gz` | 6.5 MiB | GitHub archive of tag v6.10.9.0 (build scripts, configs, patches) |
| `ffmpeg-9.0.tar.xz` | 11.5 MiB | ffmpeg.org |
| `opus-1.6.1.tar.gz` | 10.0 MiB | downloads.xiph.org |
| `libvpx-1.16.0.tar.gz` | 5.4 MiB | GitHub archive of tag v1.16.0 |
| `emfiberthreads-1.3.tar.gz` | 8 KB | GitHub archive of tag v1.3 |

Four are byte-identical to the release zip's `sources/` (SHA-256 checked 2026-11-01); the
fifth is GitHub's archive of the libav.js tag, the same tree as the zip's `libav.js.tar.xz`
(`git archive HEAD | xz`) in a different compression. `build-libav.mjs` downloads them once
into `node_modules/.cache/pouch-libav-source/` (so the first build needs the network) and
checks each pinned SHA-256 on every build. `NOTICE.txt` and `ffmpeg -h` name the source
manifest; the manifest lists each tarball's parts in order. Uncertain, for Adam: (1)
whether the libav.js tag archive (not the release's own `.tar.xz`) is acceptable as its
corresponding source, (2) whether the libvorbis, libogg, lame, libaom and zlib tarballs in
the release's `sources/`, which this variant does not link (its `deps.mk`), should ship
anyway for simplicity (about 11 MiB more), and (3) a written offer is not made, because the
source sits next to the binary. The wasm is unmodified and the wrapper is bundled
unmodified apart from the four rewrites, which disable code paths and are visible in
`build-libav.mjs`.

## Installable app shell (built and tested locally, not deployed; 2026-10-30)

`build.mjs` now also emits `sw.js`, `manifest.webmanifest` and `icons/*.png`
(generated by `icons/make-icons.py` from the BayLeaf logo), all listed in
`SHA256SUMS` after `pouch.html`; the page embeds `sw.js`'s SHA-256. `deploy.mjs`
allowlists exactly these paths, requires all of them, checks that the page expects the
shipped `sw.js`, stages and snapshots them, and after deploy verifies their bytes and
cache headers. README "Install and the offline copy" has the policy.

- CSP delta: `worker-src blob:` becomes `worker-src 'self' blob:` (registering
  `/sw.js`); `manifest-src 'self'` is added; `img-src data: blob:` becomes
  `img-src 'self' data: blob:` (the manifest and apple-touch icons). The first PWA
  deploy omitted that last change on the claim that Chromium loads manifest icons
  without it; real Chrome blocked them, while the Playwright installability check
  had passed. `deploy.mjs` now requires all three directives.
- `_headers`: `/sw.js` and `/manifest.webmanifest` are `no-cache, no-transform`
  (revalidated every time, so a release reaches them at once); `/icons/*`
  `public, max-age=86400`; the page and `SHA256SUMS` stay `no-store`.
- Local build (`--with-models`, label `767214c+dirty 2026-10-30`): 70 files, 1,086 MiB;
  `node deploy.mjs --check` passes. The default build is 7 files, 5 MiB.
- Tests: `test/pwa-browser.mjs` (Chromium 17/17: installability, offline reload, update
  and refusal, pass-through, trust panel, uninstall, Erase all). To check after deploy:
  the Content-Type Cloudflare serves for `.webmanifest`, install on Android and iOS.

## Pending: HTML reports and previews (Batch G, not deployed)

- CSP delta (page): `frame-src 'self'; media-src blob:` (embed `/viewer.html`; play audio
  and video previews from memory). No other directive changes; `deploy.mjs` rejects any
  network source in `frame-src`, `child-src` or `media-src`.
- New shell file `viewer.html` (in SHA256SUMS, the offline copy and the deploy allowlist)
  with its own policy: no network of any kind (README "HTML reports"). `_headers` now comes
  from `headers.mjs`: `/viewer.html` detaches the page's CSP, `X-Frame-Options` and
  `Permissions-Policy` and sets its own CSP with `frame-ancestors 'self'; sandbox
  allow-scripts`, `X-Frame-Options: SAMEORIGIN` and `Cache-Control: no-cache`. Detach
  semantics checked with `wrangler dev` 4.91 (asset worker); recheck the served headers
  after the first deploy (`deploy.mjs` verifies them).

## Current artifact: terminal, control plane, report viewer, gateway weights (2026-11-01)

- Built from commit `98f90d0` (clean; label `98f90d0 2026-11-01`) in a temporary clean
  checkout with `node build.mjs` (weights no longer in the artifact; the Transformers.js
  provider is included, its weights come from https://api.bayleaf.dev/hf at run time).
- HTML SHA-256: `b7f0c1d471de62b92deb3a565398e98b9b8b06356bde0f40215841c5468a7909`.
- 12 files, 31 MiB staged (previously 70 files, 1,086 MiB); 6 uploaded, 7 unchanged.
- CSP delta: `frame-src 'self'`, `media-src blob:`. New path `/viewer.html` with its own
  headers (CSP without network sources, `sandbox allow-scripts`, `frame-ancestors 'self'`,
  Permissions-Policy, `X-Frame-Options: SAMEORIGIN`); confirmed live as the only CSP on
  that path.
- Cloudflare version: `118dbb23-1b6e-4d31-80e7-03a04bf40702`. Previous: `194f6ac7-…`.
- `deploy.mjs` passed first time (page, sums, 7 shell files, 4 runtime parts; gateway
  catalog checked against `models.lock.json` instead of downloading weights). Headless
  Chromium on the live site: service worker active, no installability errors, no CSP
  violations, no native dialogs; only pouch.bayleaf.dev and api.bayleaf.dev contacted;
  the gateway catalog is reachable from the page; the viewer loads sandboxed.
- Includes Batches E (terminal, provider-true titles), F (control plane), G (report
  viewer, previews) and H (gateway weights, models command). Existing users' cached
  weights migrate on first load without re-downloading.

## Earlier artifact: Localhost provider (2026-11-01)

- Built from commit `93798dc` (clean; label `93798dc 2026-11-01`) in a temporary clean
  checkout with `node build.mjs --with-models`.
- HTML SHA-256: `c404ceca98c4e882dda471df7932ff066fbd4df7e982aec56c02a62200f0ebc1`.
- 70 files staged; 2 uploaded, 69 unchanged.
- CSP delta: `connect-src 'self' https://api.bayleaf.dev http://localhost:* http://127.0.0.1:*`
  (the user's own machine as a trust root; `[::1]` is not a valid CSP source in Chromium).
- Cloudflare version: `194f6ac7-75b2-4b95-9228-60579d300f65`. Previous: `bda3612f-…`.
- `deploy.mjs` passed first time (page, sums, 6 shell files, all 63 model files
  byte-exact). Headless Chromium on the live site: service worker active, no
  installability errors, no native dialogs.
- Local Network Access from the public origin, checked against a real oMLX on
  127.0.0.1:12348: without the permission Chromium blocks the request ("Permission was
  denied"); with `local-network-access` granted it reaches the server (401 without a
  key, as expected). Real Chrome shows a permission prompt at that point.

## Earlier artifact: ubiquitous language realignment (2026-10-31)

- Built from commit `2237d6c` (clean; label `2237d6c 2026-10-31`) in a temporary clean
  checkout with `node build.mjs --with-models`. Includes Batch D (`a6c5aea`: scrolling,
  subagent framing, dismissal, polish) and the adopted language (`ec88ab0`).
- HTML SHA-256: `b07c94e5c6667295a5f79c931a3d0cb7e14ddbbe218702c644ba59738e81abf2`.
- 70 files staged; 4 uploaded (page, sums, model manifest and worker), 67 unchanged.
  No CSP change.
- Cloudflare version: `bda3612f-8108-4056-8c00-353664e5c6a4`. Previous: `74c3c358-…`.
- `deploy.mjs` passed first time (page, sums, 6 shell files, all 63 model files
  byte-exact). Headless Chromium on the live site: service worker active, no
  installability errors, no CSP violations, no native dialogs.
- Existing profiles migrate on read (s-handles to a-handles, "queue" send mode to
  "followup"); no IndexedDB version bump.

## Earlier artifact: real-use bug fixes (2026-10-30)

- Built from commit `c41c8b2` (clean; label `c41c8b2 2026-10-30`) in a temporary clean
  checkout with `node build.mjs --with-models`.
- HTML SHA-256: `e28f6cc9f144e6a5ded2e9a430d1b3e55674a26dffa9d71bbdbb1cb2ef940bed`.
- 70 files staged; 2 uploaded, 69 unchanged. No CSP change.
- Cloudflare version: `74c3c358-aa0b-42fe-a393-54455fd71d40`. Previous: `6be12e2c-…`.
- `deploy.mjs` passed first time (page, sums, 6 shell files, all 63 model files
  byte-exact). Headless Chromium on the live site: service worker active, no
  installability errors, no CSP violations, no native dialogs.
- Fixes two data-loss bugs live in `91b1b01`: the conflict diff's native confirm()
  could discard the agent's edit, and Enter during a stop could lose the draft.

## Earlier artifact: agent graphs, namespaces, send modes, watches (2026-10-30)

- Built from commit `91b1b01` (clean; label `91b1b01 2026-10-30`) in a temporary clean
  checkout with `node build.mjs --with-models`.
- HTML SHA-256: `440ca991e0b7291322666f67270fc2cdb57489febf540da5ec8d539ac5ee0e77`.
- 70 files staged, 1,086 MiB; 2 uploaded, 69 unchanged. No CSP change.
- Cloudflare version: `6be12e2c-5965-41d6-a153-568d4934199a`. Previous: `17557e96-…`.
- `deploy.mjs` passed first time: `/`, `/pouch.html`, `/SHA256SUMS`, 6 shell files and all
  63 model files byte-exact. A headless Chromium load of the live site showed the service
  worker active, no installability errors and no CSP violations (only the expected
  "No available adapters" WebGPU warning in a GPU-less browser).
- Contains a database upgrade (version 4) that deletes the old `changes` store, since
  change review is removed.

## Earlier artifact: installable offline app (2026-10-30)

- Redeployed from `e2bda0f` (clean) as Cloudflare version
  `17557e96-c2ad-4316-90fb-5f362561b0e8`, HTML SHA-256
  `d932a669340ccd1ca008ac6b98d32596b359d9bef9ded25cdae6140a5f5e155b`, adding
  `img-src 'self'` so Chrome loads the install icons. `deploy.mjs` passed with every
  model file downloaded and hash-checked. Built in a temporary clean checkout because
  the working tree held unrelated uncommitted work. The entries below describe the
  first PWA upload.

- Built from commit `a1df65d` (clean; label `a1df65d 2026-10-30`) with
  `node build.mjs --with-models`.
- HTML SHA-256: `0e1ca58ca3725de5fe48db5b87477ae3d95e85df95bf0401743d1fc9eaae1b97`.
- 70 files staged, 1,086 MiB; adds `sw.js`, `manifest.webmanifest` and `icons/`.
  CSP delta: `worker-src 'self' blob:`, `manifest-src 'self'`.
- Cloudflare version: `f20277af-fd25-4a2b-90bc-b854912b7c9e` (an earlier upload the
  same day, `c6585532-…`, carried a `+dirty` label and was replaced).
- `deploy.mjs` failed after both uploads. The `/` failure was real propagation (the
  edge briefly served the previous page), so byte mismatches are now retried (6 tries,
  15 s apart). The model-part failures, here and on 2026-10-29, were not propagation
  but a bug in the check: Cloudflare omits `Content-Length` on HEAD for cached parts,
  so the size compared as 0. The check now downloads and hashes every model file. A full HTTPS re-verification of all 72 URLs (including `/`) found 0
  mismatches; the live manifest is served as `application/manifest+json`.
- Untested on real Safari, iOS, Android and Firefox; Playwright WebKit fails the
  offline path (see JOURNEYS).

## Earlier artifact: run, offline, composer, Local lane (2026-10-29)

- Built from commit `7c6b546` (clean; label `7c6b546 2026-10-29`) with
  `node fetch-models.mjs && node build.mjs --with-models`.
- HTML SHA-256: `fe7aed307a9d8daeda15a23ba6332d41858114b9422a12d1e618cff61a450463` (4,695 KiB).
- 65 files, 1,086 MiB; largest 20.0 MiB (Cloudflare Static Assets limit 25 MiB per file).
  `models/lfm3-1.7b-q4f16/`: 61 content-hash-named parts, a hashed manifest and worker.
- CSP delta from the previous artifact: `script-src` adds `'wasm-unsafe-eval'`,
  `worker-src blob:`; `connect-src 'self' https://api.bayleaf.dev`.
- Cloudflare version: `c452b7f2-369a-4836-aa00-f97c75965ab5`.
- `deploy.mjs` verified `/`, `/pouch.html`, `/SHA256SUMS`, then reported one model
  part differing: post-deploy propagation (the same URL served exact bytes on retry).
  A full re-verification afterwards fetched all 65 files over HTTPS: 0 mismatches.
- Privacy note: the static host can see that a client downloaded the local model;
  local inference itself sends nothing.

## Earlier themed artifact: 2026-10-29 UTC

- Light/Dark/System theme deployed as static assets.
- HTML SHA-256: `32d65e0e10db7163e09ea3bd4c13955cc1d251548fc057456bb94c405cdac153`.
- Cloudflare version: `1cb37fec-23f2-4f69-9a05-118efc3786a6`.
- HTTPS `/`, `/pouch.html`, and `/SHA256SUMS` verified against exact local bytes, without cookies.
- Theme browser checks used offline fixtures and spent no inference quota.

## Initial qualified artifact: 2026-10-29 UTC (2026-10-28 Pacific)

- Build label: `d286752+dirty 2026-10-29`.
- HTML size: 3,686,558 bytes.
- SHA-256 (both `/` and `/pouch.html`):
  `ccba69a49c81d3aa9f812f7ce0480ed38dcb623401890ad42c0c4cd50f99fd9e`.
- Manifest: `/SHA256SUMS`, containing that hash and the canonical name `pouch.html`.
- Final qualified Cloudflare version: `9e727046-7c1c-49b0-a242-989b7dfa7ccc`.
- Existing `dist/` bytes and their matching manifest were snapshotted before upload;
  concurrent theme source edits were not built into this deployment.

Qualification: valid HTTPS, root and `/pouch.html` GET/HEAD 200, exact downloaded
hashes, manifest matching HTML, no Set-Cookie, source path 404, strict CSP preserved.
Cloudflare version metadata confirms `serve_directly: true`, script handlers null,
no bindings, and `raw_run_worker_first: false`. The custom domain created only the
proxied, managed `pouch.bayleaf.dev` DNS record in the existing active BayLeaf zone.

A real browser booted and displayed **Sealed: enclave verified**. Its Trust panel
reported all five checks successful at `2026-10-29T06:20:06.599Z`, with published and
running code measurements equal, release `v0.0.168`, enclave `inference.tinfoil.sh`.
No message was sent, no inference request was made and no inference quota was spent.
Attestation/catalog/allowance metadata requests are not inference. This is boot and
attestation qualification, not an end-to-end inference test.

## Deploy and verify

Use the approved `cf` profile `ucsc` and installed Wrangler (qualified with 4.91.0).
From `pouch/`, after concurrent source editing has stopped:

```bash
npm ci
node build.mjs                # or: node fetch-models.mjs && node build.mjs --with-models
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

To restore the initial qualified bytes, from `pouch/`:

```bash
node deploy.mjs .deploy/ccba69a49c81d3aa9f812f7ce0480ed38dcb623401890ad42c0c4cd50f99fd9e
```

This creates a new deployment using preserved bytes and current deployment policy;
it does not rewrite git history. Other snapshots use the same command with their
hash. The version ID above is an additional Cloudflare dashboard rollback reference.
Removing this public surface/domain is a separate operator decision, not automatic.

## Deferred

Public tagged reproducible-release transparency, independent hash distribution,
release automation, broader discovery/documentation and inference qualification.
The existing page's release-check language describes the intended trust practice,
not proof that this experimental build has received a public tagged release.
