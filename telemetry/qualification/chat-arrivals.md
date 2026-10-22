# Signed-out Chat root arrivals

2026-10-20, issue #112. **ACTIVE: signed-out Chat root arrivals deployed and live
browser/collector verification passed.** Parent reviewed and published the runtime
in `13a3a67`; the approved rollout changed only the independent arrivals switch
and refreshed source. No commit/push, production account access, inference,
manual retention execution or email was performed by the deployment agent.

## Exact semantics and privacy boundary

An arrival means one **initial HTTPS document at `https://chat.bayleaf.dev/`**
whose ordinary OWUI session resolution subsequently renders the sign-in card at
`/auth`. The HTTP ingress redirect has no document execution; the subsequent
root-to-auth redirect is a single SPA document. Query strings are never read.
The loader captures eligibility before that SPA redirect, then observes only
element presence, never text or input values. No generic SPA-navigation tracker.

Direct `/auth` entries are deliberately **not** arrivals, including ordinary
direct sign-in links, OAuth returns, logout, MFA, pending approval and error
entries. Private deep-link documents never qualify, even if redirected to auth.
These cases cannot be distinguished in the approved three-field schema, so we
do not silently combine them with root arrivals. Reloading a public root is a new
arrival, not a new person. Back/forward restoration does not create another event.

An existing `localStorage` token **property** or token-cookie name permanently
disqualifies the initial document, including expired/invalid tokens. Only local
presence checks are used: no token value is extracted, retained or transmitted.
The cookie string is inspected locally for the cookie name, not parsed into an
account/session record. Denied storage access fails closed. Missing token markers
alone never authorize an event: the resolved auth card is also mandatory. The
client rechecks sign-out after loading and immediately before the actual fetch.

The gate disconnects on success, session/private-route detection, pagehide or a
15-second deadline. Its separate collection module loads only after the sign-out
gate succeeds. One attempt per document, no retry, a 1-second transport deadline.
No storage writes, visitor ID, persistent deduplication, per-account linkage,
client timestamp, raw URL, query, referrer, DOM text, chat or input collection.
Module delivery has a separate 1-second deadline: a late-loading module cannot
create a delayed arrival. The browser's module download itself is not abortable,
but its late completion does not invoke collection.
Slow/unresolved sessions and existing token markers cause conservative undercount.

The sole payload is:

```json
{"schema_version":1,"destination":"chat","referring_hostname":null}
```

Chat does not even read `document.referrer`. Transport reuses the existing
audited browser adapter: credentials omitted, no Authorization, empty referrer,
`no-referrer`, no-store, no redirect following. The collector's existing schema
and exact Chat origin/destination allowlists admit this unchanged v1 client payload.
The subsequently deployed coarse network classification stores browser records
with schema **2**, policy **3**; no further collector change was needed for Chat
activation. New collector
tests explicitly exercise matching and mismatched origins and forbidden fields.
The generic `publicArrival` helper intentionally still excludes Chat: it cannot
infer authentication from a shared root shell.

## Pinned integration, not a frontend fork

The actual qualified v0.12.3 image was inspected, not just upstream documentation:

- `/app/build/index.html` loads `/static/loader.js` with `defer`.
- `/app/build/static/loader.js` is exactly zero bytes (SHA-256 `e3b0c442…b855`).
- `/app/backend/open_webui/config.py` clears top-level served static files and
  repopulates them from `/app/build/static`, including the loader.
- Root layout resolves its session before exposing routed content. The auth
  route awaits OAuth cookie resolution before rendering `#auth-login-card`.
  MFA, pending approval and trusted-header/disabled-auth auto-login do not render
  that card. A pre-existing signed-in auth redirect is excluded by the initial
  token-marker rule. These are pinned release invariants, not a stable plugin API.

`otlp/browser_assets.py` separately hash-locks the actual HTML shell, root/auth
compiled nodes, config copy logic and start script. It permits only the stock
loader or this exact integration's output, refusing foreign loader content
without overwriting it. The stock prefix is preserved; changing upstream loader
content requires review and requalification, not an unconditional append.
No compiled bundle, HTML shell or backend source is modified for arrivals.
The collection module has a content-addressed asset name.

The existing native `validate_versions`, `validate_environment` and `patch`
calls remain mandatory and unchanged. Browser installation runs afterward,
before the same `exec bash start.sh` handoff. A browser asset/config mismatch
also prevents startup; it never falls back to unguarded native metrics.

## Local qualification evidence

- Shared collector/source suite: **68 tests passed**, including the new Chat
  origin/schema privacy test, SQLite and workerd/D1 paths.
- Browser adapter/bundle suite: **21 tests passed**, including the final Chat
  generated module, duplicate-call suppression, a login-before-fetch race,
  unresolved-state deadline and initial token/private/auth gating. Existing
  landing/API/Sandbox generated artifacts and activation were not changed.
- Browser asset installer unit test passed: default-off, enable, idempotence,
  disable/removal, ambiguous-switch refusal, foreign-loader preservation and
  source-drift rejection.
- Existing native synthetic startup/export qualification rerun passed: same
  installed metrics/setup/runtime hashes, all five metrics, 99 points/export,
  trace/log/resource minimization, bounded callbacks and all prior boot guards.
  Historical checked-in native proof measurements were preserved, not replaced.
- Real arm64 custom-image build and normal guarded boot passed. In-container
  checks confirmed the source and runtime-served loader/client bytes match after
  actual config import. Native metrics were independently off in this synthetic
  SQLite test instance; no native production environment was changed.
  This local build layered onto the cached, already-qualified native image of
  the same pinned upstream release, rather than downloading that large base
  again. The release Dockerfile still defaults to the immutable upstream digest.
- Real amd64 image asset checks passed, including all frontend hashes,
  default-off, enable, repeated enable and disable.
- A separate real arm64 default-off boot returned health 200, served the stock
  empty loader, and had no arrival module in source or runtime static directories.
- Final enabled image: loader **1,815 bytes**, collection module **2,967 bytes**,
  module name `bayleaf-chat-4d9161865769d44e.mjs`; served/source loader SHA-256
  `e5583a87b82e67abc2f55e8eef7eddd61178fd19aab29eca6f3897211fd54504`.

The **15-case real Chromium run passed** against the final built image:
anonymous root, HTTP-to-HTTPS-to-auth, query-bearing root, direct auth, logout,
MFA, pending, private deep link, authenticated root, authenticated auth, OAuth
token-cookie root, expired-token-marker root, collector 503, delayed module
delivery, and delayed session resolution. Expected public roots each made exactly one request with the fixed
payload and no Cookie, Authorization or Referer headers. All documents excluded
for session/private/direct-auth scope loaded **no collection module** and sent
nothing. Repeated DOM/SPA changes sent
nothing extra. A real local form login completed and subsequent authenticated
navigation sent nothing extra. Holding `/api/config` beyond the 15-second gate
deadline, then releasing it to render the real sign-in card, still loaded no
collection module and sent nothing. Holding the module request past its separate
deadline, then delivering the module, also produced no event. Collector failure
did not break sign-in.
The separate **16th browser check** used the default-off container on port 18881:
the real sign-in card rendered normally, with no collection module request and
no arrival. Both local synthetic containers were removed after qualification;
the local qualification image remains available for reproduction.

Reproduce after the local synthetic container is ready on port 18880:

```bash
node --test telemetry/browser/chat.test.mjs telemetry/browser/browser.test.mjs telemetry/adapters/adapters.test.mjs
python3 -m unittest discover -s chat/image -p 'test_browser_assets.py'
uv run --script telemetry/browser/test-chat-browser.py
# Separate default-off container on loopback port 18881:
uv run --script telemetry/browser/test-chat-browser.py source-disabled
```

The browser test creates only a synthetic account in that local container. A
test-harness issue was isolated during qualification: synchronously closing an
intercepted Playwright WebSocket deadlocked its sync API. The final harness
does not use WebSocket interception; its loopback TLS proxy refuses upgrades.
That failed harness run is not counted as a product/privacy qualification pass.

The test harness uses a temporary loopback-only TLS
reverse proxy, actual pinned frontend/backend, a synthetic local account, and
an in-memory local collector. Chromium host-resolution rules map the apparent
Chat and telemetry domains to that loopback proxy. All other browser HTTP
destinations are blocked. No production account, collector or inference path.

## Exact activation environment and rollback

Build the reviewed repo-root `chat/image/Dockerfile`, retaining its immutable
upstream digest and all existing native environment/secrets and run command:

```text
BAYLEAF_CHAT_ARRIVALS_ENABLED=true
run_command: python /opt/bayleaf-otlp/startup_patch.py
```

`BAYLEAF_CHAT_ARRIVALS_ENABLED` is an independent plain-text runtime variable.
Absent or exactly `false` means off. Only exact `true` enables; other values
refuse boot. Do not add/change `FRONTEND_BUILD_DIR` or `STATIC_DIR`: even empty
overrides are unqualified and refused. No browser token/secret or configurable
external endpoint enters Chat. The fixed endpoint is
`https://telemetry.bayleaf.dev/v1/browser`.

**Rollback:** set only `BAYLEAF_CHAT_ARRIVALS_ENABLED=false` and restart/redeploy
the same image. Guarded startup restores the exact stock source loader and
removes this module from the source assets; normal config import refreshes the
served assets. Leave native OTEL flags, credentials and intervals untouched.
Retain the native custom image and guarded entrypoint: do not roll back to an
unpatched upstream image while native metrics remain enabled.

Existing open documents cannot be remotely unloaded. They can finish their
already-loaded gate within its 15-second observation lifetime, followed by at
most 1 second for module delivery and 1 second for its single transport attempt;
a fresh document gets the disabled loader. There is no service worker,
persistent registry, storage key or listener surviving the document.

Release gates are review/publication of the final diff and disclosure, review of
the browser evidence above, actual build/source/switch verification and live
anonymous browser/collector readback. Signed-in non-collection must be qualified
without altering real user sessions. Local proof and live readback are distinct.

## Completed production activation

The operator approved deployment on 2026-10-20 after parent review/publication of
`13a3a67b6642e49429ac22483121df9e389057ab`. Deployment
`a5319b41-56ca-452d-a74e-bee904458baf` reached **ACTIVE** from exactly that commit
on its first attempt, using `--update-sources`. The only app-spec change was
`BAYLEAF_CHAT_ARRIVALS_ENABLED=true` at runtime. Structural comparison verified
all native environment/secrets, five-minute interval, one-worker/one-instance
size, repository-push auto-deploy disabled, scheduled job and unrelated settings
preserved. No native kill switch or startup guard was bypassed.

Read-only post-startup audit verified native source/dependency/environment guards,
pinned frontend hashes, uvicorn PID 1, and identical source/runtime/publicly served
loader and module bytes. Exact served hashes:

- Loader: `e5583a87b82e67abc2f55e8eef7eddd61178fd19aab29eca6f3897211fd54504`.
- `bayleaf-chat-4d9161865769d44e.mjs`:
  `4d9161865769d44ecb7b9434e09ee44f742e07fb820e53806bce92e6db9d3ea8`.

Public health returned HTTP 200. A new isolated anonymous headless Chromium
context, with no existing credentials or session, navigated the real
`http://chat.bayleaf.dev/`. Both HTTP and HTTPS root navigation were observed,
followed by the real HTTPS `/auth` sign-in card. It requested the module once and
sent **one** HTTPS POST with exactly the three-field payload above, with no Cookie,
Authorization or Referer header. The collector acknowledged it. Repeated DOM
changes produced no second event. The context was then closed; no account was
created and no sign-in/inference attempted.

A nontruncated private bounded read found a matching Chat arrival in that browser
request window with exactly the stored field allowlist, null referrer, browser
schema 2/policy 3, an approved coarse network-location value and expiry exactly
90 days after observation. Only pass/fail flags were retained, not row values or
identities. There is deliberately no per-visitor correlation marker; the live
proof combines one acknowledged browser request with bounded stored readback.
Signed-in/private-route/login non-collection remains the previously completed
isolated local browser proof, not a newly claimed live authenticated test. No
existing user session was read, modified or logged out.

After this activation, private collector readback also verified fresh native
exports containing all five names, observed batches within 99 points and unchanged
90-day expiry. This was a continuity check, not another overhead experiment.

The fresh pre-change protected spec and deployment evidence are under
`/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/bayleaf-chat-arrivals-20261020/`.
The directory is mode 0700 and specs/evidence are mode 0600. `rollback-spec.json`
is distinct from the earlier native rollout snapshot and retains the healthy
native custom-image configuration; do not substitute the old stock-image spec.
Evidence includes `runtime-audit.json`, `browser-live-flags.json` and
`native-continuity-flags.json`. No rollback was needed. The integration registry
was marked Chat/browser enabled only after these checks; dashboard publication is
a separate parent-owned action.
