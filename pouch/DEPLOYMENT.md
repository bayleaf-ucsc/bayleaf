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
- Only `pouch.html`, `SHA256SUMS`, and static `_headers`/`_redirects` configuration
  enter the allowlisted upload. `/` rewrites internally to `/pouch.html` (200).
  Unmatched paths return 404 rather than exposing source or SPA fallback.
- The host may process/retain request metadata, including IP addresses, paths,
  timestamps and security events. No claim that static hosting proves API/model
  statelessness: those services have their own data boundaries.
- Browser conversation/file storage remains local. Sealed inference uses the existing
  BayLeaf API/Tinfoil encrypted path. The `bayleaf` tool's approved non-inference
  egress is a separate plaintext boundary, as described in the README.
- CSP is the built page's exact hash-based script policy, with only
  `connect-src https://api.bayleaf.dev`; the response additionally denies framing and
  objects. `no-store, no-transform`, no-referrer, nosniff, HSTS, noindex and restrictive
  camera/microphone/geolocation policy are static response headers.
- Cloudflare initially injected NEL network-error-reporting headers. Removing them
  in `_headers` did not suppress late injection. Explicit `NEL: {"max_age":0}` and
  an empty, expired `cf-nel` reporting group do: these disable reporting for this
  origin and clear any policy cached from initial qualification. No zone-wide
  settings were changed. No platform script injection was observed: served bytes
  match the local artifact exactly.

## Current themed artifact: 2026-10-29 UTC

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
node build.mjs
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
