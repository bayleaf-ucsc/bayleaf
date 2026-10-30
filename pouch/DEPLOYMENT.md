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
  `icons/*.png`), static `_headers`/`_redirects` configuration and,
  for a `--with-models` build, the Local lane's `models/<id>/` files listed in
  `SHA256SUMS` enter the allowlisted upload (see "Local lane artifact" below). `/` rewrites internally to `/pouch.html` (200).
  Unmatched paths return 404 rather than exposing source or SPA fallback.
- The host may process/retain request metadata, including IP addresses, paths,
  timestamps and security events. No claim that static hosting proves API/model
  statelessness: those services have their own data boundaries.
- Browser conversation/file storage remains local. Sealed inference uses the existing
  BayLeaf API/Tinfoil encrypted path. The `bayleaf` tool's approved non-inference
  egress is a separate plaintext boundary, as described in the README.
- CSP is the built page's exact hash-based script policy, with only
  `connect-src 'self' https://api.bayleaf.dev` (`'self'` since the Local lane: model files); the response additionally denies framing and
  objects. `no-store, no-transform`, no-referrer, nosniff, HSTS, noindex and restrictive
  camera/microphone/geolocation policy are static response headers.
- Cloudflare initially injected NEL network-error-reporting headers. Removing them
  in `_headers` did not suppress late injection. Explicit `NEL: {"max_age":0}` and
  an empty, expired `cf-nel` reporting group do: these disable reporting for this
  origin and clear any policy cached from initial qualification. No zone-wide
  settings were changed. No platform script injection was observed: served bytes
  match the local artifact exactly.

## Local lane artifact (built and tested locally, not deployed)

`node build.mjs --with-models` adds `dist/models/lfm3-1.7b-q4f16/`; the default build
stays models-free and unchanged. Shape of the tested build (2026-10-29):

| File | Count | Size |
|---|---:|---|
| `manifest.<sha16>.json` (every part's order, size, SHA-256; each whole file's size and SHA-256) | 1 | ~15 KB |
| `worker.<sha16>.js` (Transformers.js 4.3.2 + ORT Web 1.31.0-dev WebGPU bundle) | 1 | ~0.56 MB |
| `<sha256>.bin` parts (ORT wasm: 2; model, tokenizer, config: 59) | 61 | ≤ 20 MiB each |
| total | 63 | 1,081 MB (1.056 GiB) |

With `pouch.html`, `SHA256SUMS`, `_headers` and `_redirects` the upload is 67 files.
Limits (Cloudflare Workers platform limits, Static Assets, checked 2026-10-29,
<https://developers.cloudflare.com/workers/platform/limits/#static-assets>): 25 MiB per
file, 20,000 files per version (Free) or 100,000 (Paid), 100 `_headers` rules. Parts are
20 MiB for margin; the ORT wasm (26.9 MB) is over the per-file limit and is split too.
`deploy.mjs` refuses any listed file over 25 MiB, any path outside the allowlist
(`pouch.html`, `models/<id>/manifest.<hex16>.json`, `worker.<hex16>.js`,
`<sha256>.bin`), any name that is not its content hash, any file whose bytes differ
from `SHA256SUMS`, a manifest that `pouch.html` does not embed, and a manifest part
that is missing or different.

Headers: `Cache-Control` is set per path, never on `/*` (Cloudflare merges matching
rules and comma-joins a repeated header): `/`, `/pouch.html`, `/SHA256SUMS` stay
`no-store, no-transform`; `/models/*` is `public, max-age=31536000, immutable`
(content-addressed names). The security headers and CSP stay on `/*`.

Privacy: the static host (Cloudflare, the same operator and service that already serve
the page) sees that a client downloaded the model files: request metadata such as IP
address, paths and timestamps. No prompt, file or reply goes anywhere in the Local lane;
there is no new operator, endpoint or Worker script. The page asks before downloading.
Pouch fetches only from its own origin, never from Hugging Face or a CDN at run time.

Deploy (needs approval; not run): `npm ci && node fetch-models.mjs && node build.mjs
--with-models && node deploy.mjs --check && node deploy.mjs`. `--check` verifies and
stages without publishing. The first upload sends about 1.1 GB; later deploys reuse
unchanged parts by hash. After deploy, `deploy.mjs` downloads every model file (about
1 GB, four at a time) and checks its SHA-256 and the immutable cache policy. A cheaper
size check is not possible: Cloudflare omits `Content-Length` on HEAD for cached assets
and ignores `Range` on them.
`.deploy/<sha256>/` snapshots keep `pouch.html` and the part list (`SHA256SUMS`), not the
1 GB of parts: rebuild them from `models.lock.json` to roll back a models build.

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

## Current artifact: agent graphs, namespaces, send modes, watches (2026-10-30)

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
