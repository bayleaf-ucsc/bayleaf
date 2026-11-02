# HF artifact gateway

Issue [#121](https://github.com/bayleaf-ucsc/bayleaf/issues/121). Keyless, read-only
delivery of approved Hugging Face model artifacts from `https://api.bayleaf.dev/hf/`,
for clients whose network egress is limited to that origin: a browser app whose CSP
names only the API (BayLeaf Pouch, #120), a sandbox, or a lab machine. It is useful
beyond Pouch: any client that can set an HF-style base URL can use it.

## Design: mirror ahead of time, never proxy

Requests never reach Hugging Face. An approved file is copied into R2 once, by the
hourly cron, and every download is served from R2. The issue proposed streaming from
the Hub per request; research before implementation (2026-11-01) rejected that:

- The Hub's resolver answers large (LFS/Xet) files with a 302 to a signed URL on
  `us.aws.cdn.hf.co/xet-bridge-us/...` valid about an hour, and small files with a 307
  to `/api/resolve-cache/...`. The storage host has changed repeatedly
  (`cdn-lfs` → `cas-bridge.xethub` → `xet-bridge`) and is not documented as stable.
- Cloudflare's cache limit is 512 MB on non-Enterprise plans, and the Cache API
  refuses 206 responses, so a 1.09 GB weights file would be re-fetched from HF on
  every download.
- Anonymous Hub rate limits are per IP (3,000 resolver requests per 5 minutes,
  [rate limits](https://huggingface.co/docs/hub/rate-limits)); Worker egress shares
  Cloudflare IPs with other tenants. Avoiding that means the operator token on every
  user request, and HF's [content policy](https://huggingface.co/content-policy)
  names proxies used to bypass restrictions as abuse.

Mirroring removes all three: no request-time upstream, no runtime redirect handling,
no operator credential on any download path, and Hugging Face sees no per-user
traffic at all (stronger than "hides the caller's IP"). R2 egress is free; storage is
$0.015/GB-month.

## Approval unit and registry

`src/hfReleases.json`, bundled into the Worker. One release approves **one repository
at one commit, an explicit file inventory, and recorded distribution terms**; nothing
else in the repository is served. `aliases` (such as `main`) name the approved commit
and never follow upstream. Approving or revoking a release is a reviewed commit plus
an API deploy, so the public git history logs every release.

`scripts/hf-release.mjs <repo> <commit> <path>...` authors the `files` array and ties
each file to the commit: LFS files take SHA-256 from the commit's LFS pointer
(`lfs.oid`, via `paths-info`); small files are downloaded, checked against the commit's
git blob SHA-1, and hashed. `license`, `distribution` and `qualification` are written
by hand: they record decisions, not facts a script can establish. The license file
must be in the inventory (`registryProblems()` enforces it; `npm run test:hf` runs it
against the real registry).

## Mirror (`src/hfMirror.ts`)

The hourly cron mirrors every approved blob missing from R2 (`HF_ARTIFACTS`, bucket
`bayleaf-hf-artifacts`), keyed `sha256/<hex>`. No key is ever derived from caller input.

- **Credential boundary.** `HF_TOKEN` (Worker secret; a read-only token of Adam's HF
  account, made for this purpose) is sent only to `huggingface.co`. Redirects are
  followed manually; `*.hf.co` storage URLs are fetched without it; any other host is
  refused. The download path never uses the token.
- **Integrity.** `put()` carries the registry's SHA-256, and R2 rejects bytes that do
  not match; a `FixedLengthStream` rejects short or long bodies. Wrong bytes never land
  under an approved key.
- **Bounds.** A run starts no new blob after 10 minutes (the hourly cron's wall limit
  is 15). Failures throw after the run so the cron reports them; the next hour retries.
  Logs carry public artifact metadata and counts only; observability stays disabled.

Revocation: remove the release and deploy; downloads 404 at once. Blobs no longer
referenced stay in R2 until deleted by hand (`wrangler r2 object delete
bayleaf-hf-artifacts/sha256/<hex> --remote`).

## Routes

Exact contracts are in `/docs/openapi.json` (tag **Artifacts**). In brief:

| Route | Contract |
|---|---|
| `GET /hf/catalog` | Approved releases with inventory, hashes, download URLs, license, distribution basis and qualification. Filters `task`, `library`; other query keys 400. |
| `GET /hf/catalog/{namespace}/{repo}` | One repository's releases, with per-file `mirrored`. 404 if none approved. |
| `GET`/`HEAD /hf/{namespace}/{repo}/resolve/{revision}/{path}` | Approved bytes. Hub-shaped for Transformers.js. |

Download behaviour:

- One byte range per request (`bytes=a-b`, `a-`, `-n`) → 206 with `Content-Range`;
  multiple, malformed or unsatisfiable → 416 with `Content-Range: bytes */size`.
- `ETag` and `X-Linked-Etag` are the quoted SHA-256; `If-None-Match` → 304; a stale
  `If-Range` serves the whole file. `X-Repo-Commit` names the commit served;
  `X-Linked-Size` the size.
- `application/octet-stream`, `nosniff`, `CSP: default-src 'none'; sandbox`,
  `Content-Disposition: attachment`. Commit URLs are `immutable`; aliases `no-cache`.
  Everything is `no-transform`. No `X-Xet-Hash` or Xet `Link` header, which would send
  `huggingface_hub` to Xet servers.
- Unknown repository, revision or file → 404 (Transformers.js treats 404 as "optional
  file absent"; other errors are fatal). Methods other than GET/HEAD → 405. Any query
  string → 400. Each path segment is decoded once; a segment that decodes to contain
  `/` never matches.
- Approved but not yet mirrored → 503 with `Retry-After: 3600`.
- `Authorization` and cookies are ignored, including temporary inference tokens (the
  global grant guard skips `/hf`). CORS: any origin, no credentials; `Range`,
  `If-None-Match`, `If-Range` allowed; range, hash and commit headers exposed.
- `HF_GATEWAY_ENABLED` must be exactly `"true"`; otherwise every `/hf` route answers
  503 and the mirror does nothing.

## Boundaries

- **Data posture.** R2 holds only operator-approved public artifacts, never request
  content. No request is logged or stored; nothing is collected for telemetry. This is
  a new kind of stored data in the API, outside the inference ZDR boundary only in the
  sense that it is not inference: it holds no user data.
- **Metadata.** Cloudflare and BayLeaf process the caller's IP, timing and which files
  and ranges were requested. Keyless access means requests carry no BayLeaf identity.
  File and range choice could serve a compromised client as a signal to BayLeaf; it no
  longer reaches any third party.
- **Integrity is not provenance.** A compromised deploy could serve different bytes
  with a matching catalog. Clients should pin hashes in their own release (as Pouch's
  manifest does) and verify every byte. Anyone can reproduce the registry's hashes
  from the Hub at the pinned commit with `scripts/hf-release.mjs`.
- **No code execution.** The gateway serves bytes; it never runs repository code.
- **Gated models** are out of scope. HF grants gated access to individuals; an
  operator account's approval is not redistribution permission for everyone. Each
  future gated release needs its own terms review, and must not be unlocked for all
  callers merely because the token can read it.
- **Sufficiency cap.** Two releases (~2.38 GB): LFM3 1.7B (~1.1 GB) and Parakeet TDT 0.6B v3 (~1.28 GB: fp16 encoder and
  decoder, vocabulary, config, README and ATTRIBUTION; CC-BY-4.0). Downloads cost R2 reads ($0.36
  per million; a 20 MiB-ranged 1 GB download is about 52) and Worker requests. Add a
  per-IP rate-limit binding if abuse appears; none is needed at birth.

## Clients

**Transformers.js** (vanilla): `env.remoteHost = 'https://api.bayleaf.dev/hf/'` and,
under a restrictive CSP, serve the ORT wasm yourself (`env.backends.onnx.wasm.wasmPaths`).
Pin `revision` to the commit for immutable caching.

**Pouch** (#120): keep the manifest's per-part SHA-256 and change only where parts
come from: each part becomes a byte range of an upstream file, fetched from the
gateway with `Range: bytes=a-b` (a CORS-safelisted single range, no preflight). The
ORT wasm and worker bundle are not HF artifacts and stay on Pouch's own origin. A
deploy then no longer uploads or re-downloads the weights; checking that
`models.lock.json` matches `GET /hf/catalog/{repo}` hashes replaces it.

**`huggingface_hub`** is not supported yet: `snapshot_download` needs the Hub's
`/api/models/.../revision/...` listing. `hf_hub_download` at a pinned revision may
work with `HF_ENDPOINT=https://api.bayleaf.dev/hf`, unqualified. It sends any HF token
the user has configured to that endpoint; the gateway ignores it, but set
`HF_HUB_DISABLE_IMPLICIT_TOKEN=1`.

## Agent capability exposure

| Surface | Decision | Reason |
|---|---|---|
| `/llms.txt` and OpenAPI | expose | Keyless, read-only; agents building local-inference clients should find it. |
| Hosted OpenChamber, Nanobot | defer | Sandboxes have open egress; no tool needed until a restricted sandbox profile exists. |
| BayLeaf Chat | not applicable | Chat does not run models in the browser. |
| Desktop agents | omit | Unrestricted egress; documentation is enough. |

## Tests and evidence

- `npm run test:hf`: real workerd with local R2 and a synthetic Hub (18 checks):
  token only to the Hub, storage redirects without it, off-Hub redirect refused,
  wrong bytes rejected by R2, ranges, conditionals, 404/405/400/416/503, CORS,
  catalog, and no upstream request while serving. Also checks the real registry.
- `scripts/qualify-hf-browser.mjs`: unmodified Transformers.js in real Chrome with
  every destination except the gateway's origin blocked.
- `scripts/verify-hf-release.mjs`: live catalog against the registry, then every
  file downloaded in 20 MiB ranges and hashed (`--catalog-only` skips downloads).

Production record (2026-11-01 UTC):

- Deployed as API version `2d5b651c-14a5-45bf-91ef-8c0284617b8f` (then `c1b51813-…` with docs) from `main`
  (`0bedebe`, then identical to production) plus this change. Bucket
  `bayleaf-hf-artifacts` and secret `HF_TOKEN` created. Before the first cron:
  catalog listed the release with every file `mirrored: false`; approved files 503
  with `Retry-After`; an unapproved dtype (`onnx/model_q4.onnx`) 404.
- The 05:00 cron mirrored all ten LFM3 files (1.106 GB) within four minutes.
- `verify-hf-release.mjs`: all ten files byte-exact by SHA-256; the 1.09 GB weights
  file took 81 s in 20 MiB ranges, four at a time, from a home connection. HEAD
  returns `Content-Length` (Static Assets did not, for Pouch); no compression with
  `Accept-Encoding: gzip, br`.
- `qualify-hf-browser.mjs` (Chrome, M3 Max, WebGPU; Transformers.js 4.3.2, ORT Web
  1.31.0-dev): LFM3 q4f16 at the pinned commit loaded in 97 s (cold, no browser
  cache) and generated text. Network origins: `api.bayleaf.dev` only; 0 blocked
  requests; 0 redirects. Transformers.js's `bytes=0-0` size probe got 206.
- Not yet measured: concurrent load from many clients, mobile browsers, Pouch's
  ranged-part integration (follows in the Pouch branch).
- 2026-11-02: the Parakeet TDT 0.6B v3 release deployed as API version
  `cc70d86c-825b-4937-b45d-f1654bf2bf64` from the `pouch-parakeet` branch; the live
  catalog matched the registry (`--catalog-only`), files awaiting the hourly cron.
- 2026-11-02: every Parakeet file mirrored; `verify-hf-release.mjs` found all six
  byte-exact by SHA-256 (PASS, 86 s from a home connection; the 1.24 GB fp16 encoder
  took 83 s in 20 MiB ranges).
