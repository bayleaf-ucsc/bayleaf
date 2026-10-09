# Data Retention: BayLeaf API

What `api.bayleaf.dev` stores, where, and for how long.

This service is the platform's **zero-operator-access (ZOA) target**, in the
sense of the [AWS Mantle design](https://aws.amazon.com/blogs/machine-learning/exploring-the-zero-operator-access-design-of-mantle/):
it retains no prompt or completion content, and exposes no operator interface to
read request content in flight (no request-body logging, Workers Observability
disabled, no interactive shell into the runtime). The only operator-observable
signal is request metadata. This is a strong ZOA *posture*, not a
hardware-attested ZOA *guarantee*: there is no signed-deploy/attestation barrier,
so an operator with deploy rights could in principle ship a content-logging
revision. We commit not to, and treat any such change as material.

---

## Plaintext OpenRouter Traffic

**Not stored, not logged, not observable in flight.** Requests and responses are
streamed through to the upstream provider with zero local caching and are never
written to any store or log. The provider operates under zero-data-retention
(ZDR): prompts and completions are not logged or used for training, and only
request metadata is retained provider-side.

The user's email is injected as the `user` field in upstream requests (keyed
users only; campus-pass users send `"campus-anonymous"`). OpenRouter receives
this for per-user rate limiting but does not retain it under ZDR.

Plaintext inference permits a model only when OpenRouter publishes a nonempty
`hugging_face_id` and the corresponding Hugging Face repository resolves.
Missing, malformed, negative, or unavailable evidence fails closed with HTTP
403.

### Model-policy KV (`MODEL_STATUS`)

This KV namespace stores only model-eligibility verdicts keyed by OpenRouter
model slug. Positive (`open`) and definite-negative (`closed`) verdicts expire
after 24 hours. Lookup failures, upstream errors, and malformed responses produce
an `unknown` verdict that is denied but not cached. No prompt, completion, user
identity, or request body enters this cache.

---

## Sealed Lane Traffic (`/sealed/*`, enabled)

**Prompt and completion content is not stored, not logged, and not readable by
BayLeaf.** The Sealed lane (issue #55) differs from the proxy above in kind, not
degree. For the ordinary proxy, "we do not read your prompts" is a *commitment*
an operator could break by deploying a body-logging revision. For Sealed it is a
*structural* property:
clients verify a hardware attestation and encrypt request bodies to the enclave's
public key (EHBP, RFC 9180 HPKE, applied at the application layer independently
of TLS) before those bytes reach BayLeaf. BayLeaf does not hold the
enclave-bound private key, so a body-logging revision would capture ciphertext.

Requests lacking end-to-end encryption are **rejected**, not served over a
readable path. There is no plaintext fallback on this lane.

Tinfoil's current Sealed catalog lists only open-weight models. The requested
model field is inside the encrypted request body and is unreadable by BayLeaf.
For non-streaming responses, however, Tinfoil's usage header reports the model
that executed, so model choice is not categorically hidden from BayLeaf.

What BayLeaf *does* observe on Sealed traffic, and this is the honest boundary of
the claim:

- caller identity (BayLeaf key or Campus Pass IP), timestamps, request counts;
- request and response byte sizes;
- token counts and executed model for non-streaming requests, via an upstream response header.
  (Streaming token counts arrive in an HTTP trailer that the Cloudflare Workers
  runtime does not expose, so BayLeaf does not observe them in flight.)

None of the above is written to D1 or to any log. Content is unreachable; the
fact that you asked is not.

The Sealed lane also introduces the confidential-inference provider (currently
Tinfoil) as a **metadata processor**: it receives a per-user API key, token
counts, and timestamps. It cannot decrypt prompts or completions. As of
2026-07-29 the deliberate decision is that the per-user key may carry the user's
email, on the grounds that the property being defended is the opacity of *data*,
not of identity or metadata.

---

## D1 Database (`user_keys`)

| Column | Sensitivity | Notes |
|---|---|---|
| `email` | PII | UCSC email, primary key |
| `bayleaf_token` | Secret | User-facing `sk-bayleaf-*` credential |
| `or_key_hash` | Low | Truncated hash for dashboard display; nullable until first plaintext use |
| `or_key_secret` | Secret | Full OpenRouter API key; nullable until first plaintext use |
| `revoked` | — | 0 = active, 1 = revoked |
| `created_at` | — | ISO timestamp |
| `daytona_sandbox_id` | Low | Cached sandbox UUID (nullable) |
| `tinfoil_key` | Secret | Full Tinfoil key; nullable until first Sealed use |
| `tinfoil_key_name` | PII | Tinfoil billing-attribution name derived from the user's email |
| `sealed_rpd_count`, `sealed_rpd_date` | Low | Sealed request guardrail state |

**Retention:** Account rows persist while the key is active. Revoked keys remain
in D1 indefinitely (needed for reject-on-use behavior). No automatic purge of
old revoked rows exists today.

**Future:** Consider periodic scrubbing of `or_key_secret` from revoked rows
after a grace period (the key is already deleted at OpenRouter on revocation,
so the stored value is inert).

---

## Temporary inference tokens (enabled) ✨

This opt-in capability uses the existing plaintext inference path and adds no
provider or content store. Apps receiving a token may handle or retain the
content entered into them; BayLeaf's no-content-retention commitment does not
describe those apps.

| State | Retention |
|---|---|
| Signed client descriptor (app-supplied name and exact callback) | Valid ten minutes; held by the app, with no app-registration row |
| Authorization transaction: descriptor, callback, app name, model, lifetime, state, browser-proof hash, PKCE challenge; after approval, code hash, owner email and key fingerprint | Expires within ten minutes; approved code within two minutes; successful exchange or denial deletes the row |
| Grant: ID, memorable name (named-token revision), owner email and key fingerprint, model, creation/expiry, optional app name and callback | Until expiry (administrator maximum, initially one hour) or individual revocation |
| Browser proof and login-return cookies (`bl_grant_flow`, `bl_grant_return`) | Host-only, HttpOnly, SameSite=Lax, Secure on HTTPS; at most ten minutes |

The hourly scheduler deletes expired transaction and grant rows, normally within
the following hour, while `GRANTS_ENABLED=true`. Cleanup pauses when disabled.
D1 backup retention also applies to deleted rows. Tokens are signed credentials,
not plaintext secrets stored in these tables. There is no separate app registry,
remembered app consent, or per-grant inference-content/usage ledger.

See [GRANTS.md](GRANTS.md) for the grant/token distinction, expiry and revocation
semantics, and rollout status.

---

## Code Sandbox (Daytona)

| User type | Sandbox lifecycle | Auto-delete |
|---|---|---|
| Keyed | New creation policy: medium (2 vCPU, 4 GiB RAM, 8 GiB disk), stop after 1 hour idle, archive after 24 hours stopped | Daily deletion after **90 days without Daytona-recorded activity**, enabled 2026-10-06 |
| Campus Pass | Ephemeral: created per-request, destroyed immediately after | Immediate |

Sandbox content (filesystem, installed packages, user files) lives entirely on
Daytona's infrastructure, labeled by email. BayLeaf stores only the sandbox ID
in D1 as a cache (cleared on explicit deletion).

The shared creation policy and 24-hour browser-link simplification were deployed
on 2026-10-06 (Worker `09db2448-eb9f-4c72-98a7-6e4ac9834125`). Existing machines
are not resized or retimed by these changes. Browser-link expiry revokes gateway access, not
managed application processes, in the new installer. Prior runtimes keep their
old supervisor until the next deliberate setup/restart installs the new layout.

Users who need to preserve sandbox artifacts should copy them out before the
90-day inactivity window closes. Daytona-recorded activity includes Toolbox calls,
preview/SSH interactions, explicit keepalive, and lifecycle state changes. Status
reads do not renew activity. This is not an exact last-human-interaction clock.

The daily reaper (`src/sandboxReaper.ts`) is scheduled for 08:17 UTC, separately
from hourly credential cleanup. `SANDBOX_REAPER_MODE=delete` is deployed;
`dry-run` inspects without deleting, other values disable the sweep. It scans all inventory
pages, restricts ownership to `DAYTONA_DEPLOYMENT_LABEL`, and re-fetches candidates
before deleting only stopped/archived machines with unchanged ownership and
activity at least 90 days old. Invalid/missing timestamps and active/transitional
machines are skipped. Deletion is verified before clearing cached IDs by exact ID.
Browser status already treats a missing machine as absent; preview leases expire
within 24 hours, well before the inactivity cutoff. The reaper does not contact
Toolbox or start machines to clean up inside them.

Daytona offers no conditional deletion, so activity can race the final read and
DELETE. The policy runs on the next successful daily sweep after the cutoff,
normally within 24 hours, not precisely at the 90-day instant. Failures/pending
deletions mark the scheduled invocation failed for operator inspection; there is
no new metrics store or automatic alert delivery. Dry-run reports contain only
aggregate counts, no names or content. Workers observability remains disabled.

Daytona's `autoDeleteInterval` covers stopped, runner-assigned machines, not
archived machines in the public server implementation examined on 2026-10-06.
Existing BayLeaf machines now have it disabled; API creation defaults likewise
use `-1`. Chat/Lathe now has automatic creation disabled and directs users to
the API dashboard; its old creation-time lifecycle valves are inactive. The old claim of deletion 90 days after archive was not
enforced. Adam approved scheduled deletion of the initial overdue inventory on
2026-10-06; no immediate sweep was triggered. Worker version
`564723be-75de-4dc3-adfa-e39bacc510cd` was deployed, with both cron expressions
and deletion mode verified through Cloudflare's API. The first actual scheduled
run and deletion outcome have not yet been verified. ✨

---

## Session Cookies

### Transient previews (bounded POC)

Preview traffic on `*.bayleaf-proxies.dev` passes through the API Worker to the
sandbox application. The gateway does not store or log HTTP bodies. It stores
the upstream access URL and optional configured application headers encrypted
together in D1 so it can forward requests; this
credential is decryptable by the gateway, not a zero-operator-access guarantee.
The application and sandbox may retain their own files and state. ✨

| State | Retention |
|---|---|
| Preview registration, access policy, encrypted upstream URL and configured headers, owner email, internal slot, issuer, generation | Registration lasts 24 hours; hourly cleanup removes expired rows (normally within the following hour). Upstream unavailability does not remove the registration. |
| Browser-login transaction and cookie/code digests | Transaction expires within five minutes, issued code within 60 seconds; successful redemption deletes it; hourly cleanup removes expired leftovers |
| Canonical owner email/hostname reservation and installation-subject mapping | Indefinite, to prevent hostname reassignment and subject rebinding |
| Preview-host session cookie | Secure, HttpOnly, host-only; until registration expiry, at most 24 hours |
| Preview transaction, API broker, and login-resume cookies | Secure, HttpOnly, host-only; at most five minutes |
| Transported application cookies | Browser-only, Secure/HttpOnly/host-only, registration-generation scoped; no longer than registration expiry |
| WebSocket connection-manager metadata | Durable Object stores the public hostname and alarm; removed when its last connection is gone (normally on the next alarm, within 30 seconds). Frames are never persisted. |
| Retired-origin invalidation queue | Public hostname, owner, and slot until successful connection invalidation; hourly cleanup retries leftovers |

D1's backup retention also applies to deleted rows. Registration replacement and
revocation invalidate gateway grants, but do not erase application local storage
or stop scripts in already-open browser tabs. Each new registration has a fresh
nonce origin. Service workers and browser caches may persist on retired origins,
but those origins are not reused for the next application registration.

The header-capable revision was deployed on 2026-10-08 Pacific (issue #86). Configured
headers are excluded from registration responses and ordinary metadata. They are
model-supplied tool arguments, so may already be retained in Chat or agent history;
applications may reflect or store them. Public preview visitors can exercise
injected application credentials. Replacement, revocation and expiry retire the
encrypted configuration alongside its destination. ✨

### API login

| Cookie | Content | Expiry |
|---|---|---|
| `bayleaf_session` | JWT with email, name, picture (signed, not encrypted) | 24 hours |
| `oauth_state` | Random UUID (OIDC CSRF token) | 10 minutes |

API login has no server-side session store. Logout deletes its cookie immediately.

### Sandboxes dashboard login

The separate `sandbox.bayleaf.dev` dashboard reuses API sign-in, with a narrowly
scoped handoff rather than a shared-domain cookie. The API stores only login
metadata in `service_login_flows` and `service_sessions`:

| Data | Retention |
|---|---|
| Login transaction ID, verifier/broker/code digests, stage, and authorized email/name | Ten-minute transaction; an issued code expires within 60 seconds; successful exchange consumes the row |
| Opaque session-token digest, email/name, owner-key fingerprint, expiry | 24 hours; logout deletes it; owner-key rotation or revocation invalidates it immediately |
| Sandbox-host session cookie | Secure, HttpOnly, host-only, SameSite=Lax; 24 hours |
| Sandbox transaction and API broker/return cookies | Secure, HttpOnly, host-only, SameSite=Lax; at most ten minutes |

Expired database rows are removed by scheduled hourly cleanup. Session secrets
are never stored in plaintext in D1. Signing out of Sandboxes revokes only its
session, not the independent API or preview sessions. Successful sign-in may
create the normal account identity record for a new user, without provisioning
an inference-provider key. It also makes one best-effort wake/activity refresh
of existing sandbox compute, counted by the existing sandbox inactivity policy.
Reloads and status requests do not renew activity. ✨

---

## Web Search and Fetch

**Not stored.** Search queries and URL extractions are forwarded to Tavily;
responses are returned to the caller without caching. Tavily does not receive
user identity.

---

## Cloudflare Workers Platform

Observability (request tracing) is **disabled** in the worker configuration, so
no request or response bodies are captured by the platform. Standard Cloudflare
edge logs (IP, URL, status code) are subject to Cloudflare's platform retention
(~72 hours for non-Enterprise); these are metadata only and never include
prompt or completion content.

---

## Summary

| Data class | Location | Retention |
|---|---|---|
| Prompts and completions | Not stored, not logged (ZDR passthrough, ZOA posture) | — |
| Sealed-lane prompts and completions | Not stored, not logged, and not decryptable by BayLeaf (attested E2EE) | — |
| Plaintext model-policy verdicts | Cloudflare `MODEL_STATUS` KV | 24 hours for positive and definite-negative; unknown is not stored |
| Account records (D1) | Cloudflare D1 | Indefinite while active |
| Sandbox content | Daytona | 90 days after last activity |
| API session state | Client cookie | 24 hours |
| Sandboxes session metadata | Cloudflare D1 and host-only client cookie | 24 hours, then scheduled cleanup; explicit logout removes the session row |
| Edge logs | Cloudflare | ~72 hours (platform default) |
