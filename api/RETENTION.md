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

**Separate opt-in boundary:** Inboxes intentionally stores content, unlike the
inference proxy. Its operator-only pilot has its own Worker, D1 and private R2.
Messages expire from accessible reads 90 days after receipt; read/archive does
not extend this. Deletion uses durable retry and orphan reconciliation. Inbox
destruction revokes reception/access immediately, with at least 15 minutes of
quiescence before a scheduled sweep can finalize. Physical cleanup can lag during
outages/backlogs. Opaque cleanup ids/cursors persist indefinitely without owner,
address or payload; D1 Paid Time Travel can retain deleted metadata/indexed text
for 30 days. Exact raw MIME/HTTP data may contain IPs and secrets despite selected
HTTP header redaction. Operator/provider access remains possible. Account-retirement
and recovery integration are not yet qualified for campus rollout. See
[`inbox/DESIGN.md`](../inbox/DESIGN.md) and [`inbox/QUALIFICATION.md`](../inbox/QUALIFICATION.md).

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

### User-level activity (migration 0017, deployed 2026-10-18 Pacific)

The separate `users` table stores email, account `created_at`, and
`last_active_at` as UTC epoch seconds. These belong to the person/account, not
an API credential: revoking or reissuing an ordinary key neither deletes the
user nor resets their account clock or deletes their sandbox. `user_keys`
still holds credentials, allowances, and existing sandbox/session linkage;
this is an incremental separation, not a migration of every ownership field.

Successful identity checks refresh activity at most once per UTC day, including
ordinary API keys, temporary inference tokens, sandbox credentials, API browser
sessions and Sandboxes dashboard sessions. Subsequent quota, validation or
provider failures do not undo authenticated activity. An open dashboard that
polls with an authenticated session can keep the user active. This records one
timestamp, not a request history; no paths, IPs, prompts or completions are stored.
Freshly read authentication rows skip the write entirely. Concurrent stale reads
are coalesced by a conditional SQL update; writes cannot move activity backwards.
Metadata-write failures do not reject otherwise valid authentication.

Campus Pass, invalid/revoked credentials, operator database reads, provider
polling and scheduled cleanup do not refresh an identified user's activity.
Successful browser login can establish a user record without issuing a key.

Existing creation dates are copied from `user_keys`; prior key reissuance may
already have reset those legacy dates. Historical last activity is unknown and
is migrated as NULL, not as rollout-time activity. New accounts initialize both
timestamps. Retention preserves unknown, invalid or future timestamps, following
Chat's conservative eligibility rule. The clock is `max(created_at, last_active_at)`
and 18 calendar months. Activity preparation initially enabled no deletion; the
separate account retirement mechanism below is now enabled. D1 backup retention
also applies.

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

**Retention:** User-level inactivity, not key revocation, governs retirement.
Both active and revoked ordinary keys are removed when their owner qualifies
under the 18-calendar-month account policy below. Unknown activity, holds,
exemptions and resource dependencies can extend retention.

Revocation disables the ordinary BayLeaf token only. Backend keys remain stored
and may still be used through independently authorized sandbox access. Their
retirement belongs to user-level cleanup, not ordinary-key revocation.

### Account retirement mechanism (migration 0018, enabled)

`src/userRetention.ts` implements the same **18-calendar-month** account clock
as Chat: subtract months from UTC run time, clamp to the target month's last
day, and require `max(created_at, last_active_at)` strictly before that cutoff.
Both timestamps must be positive integer epochs, known, and not in the future.
Unknown legacy activity is preserved, not treated as inactivity or given a
fabricated rollout-time value. Consequently, dormant legacy accounts without
an observed activity timestamp cannot currently qualify.

The API has no Chat admin roles or groups. Operator-managed `users.retention_exempt`
and `users.retention_hold` are its equivalents; only exact zero in both permits
retirement. Set a hold/exemption directly in D1 before enabling deletion when
required. Ordinary-key `revoked` status is irrelevant to eligibility.

The mechanism runs in the existing daily scheduler after the sandbox reaper:

- `USER_RETENTION_MODE` unset or any value other than `dry-run`/`delete`: disabled,
  with no database/provider access.
- `dry-run`: discover at most 20 candidates, no writes or provider requests,
  including no pending-outbox processing.
- `delete`: atomically recheck creation/activity, current holds/exemptions and
  resource dependencies before removing user and key rows. Associated grants,
  authorization transactions, service sessions/login flows and approved claim
  rows are removed in the same D1 transaction. The old ordinary token immediately
  stops authenticating. Fresh activity or a new hold before that transaction
  prevents retirement; D1 makes local recheck and deletion atomic, unlike Chat's
  separate HTTP recheck/delete calls.

Production uses `USER_RETENTION_MODE=delete`, explicitly approved after dry-run
qualification. No extra rollout grace period or automated advance-warning email
is added. At most 20 accounts and 20 provider-cleanup outbox rows are processed
per successful daily invocation; backlog or failures may delay retirement.

Retirement skips accounts with a cached sandbox ID, any sandbox credential
(including pending provider cleanup), an unexpired Sandboxes session, or any
preview registration. It never wakes or deletes compute. The independent 90-day
sandbox reaper and hourly credential/preview cleanup must finish first. A
missing OpenRouter management handle also blocks retirement when a secret exists.
Permanent preview-name reservations and installation-subject mappings are not
erased: their independent indefinite-retention rule prevents origin reassignment.
Chat accounts and provider billing/history are outside this cleanup's scope.

Provider revocation cannot join a D1 transaction. The same transaction therefore
detaches old OpenRouter handles/Tinfoil keys into `user_retention_outbox`, which
stores no owner email or ordinary BayLeaf token. Up to 20 outbox rows are retried
per live daily invocation using bounded, no-redirect provider DELETEs. A 2xx
other than 202 or a 404 acknowledges removal; failures retain only remaining
provider credentials for retry. Confirmed credentials are scrubbed immediately,
and empty outbox rows removed. A newly signed-in account at the same email gets
fresh credentials; retries only address the captured old ones. Until confirmation,
provider-side revocation is pending even though the local account is removed.
No enumeration of provider keys or content is required. D1 backups may retain
deleted metadata/credentials under the platform backup window.

Reports are aggregate-only. Pending upstream revocations fail the scheduled
invocation; there is no new observability store or alert integration. No rollout
email will be sent for this change, by operator decision. Enabling live mode is
not evidence of a completed scheduled run.
Run `npm run test:user-retention` for synthetic D1/provider failure and race checks.

### Inbox retirement hardening (deployed 2026-10-21 UTC)

Migration `0019_inbox_retirement.sql` adds a separate permanent retirement ledger:
opaque account generation, retirement time, inbox-fence acknowledgement time and
last retry/check time. Generation capture joins the same eligibility-rechecking
transaction as account deletion. The existing provider-key outbox is unchanged;
provider confirmation does not delete this ledger. Malformed generations on key
rows block retirement rather than losing the inbox cleanup target.

Daily cleanup attempts at most 20 pending generation fences and replays at most
20 acknowledged entries, regardless of user-facing Inboxes/pilot flags. A missing
binding, RPC failure or lost acknowledgement retains retry state and marks the
report pending/partial. Inbox fencing is **eventual across the service boundary**:
reception can continue between API identity deletion and inbox acknowledgement.
The acknowledgement means reception/read/creation authority is fenced and inbox
destruction requested, not that payloads or provider history have vanished.

The separate inbox database retains an opaque generation/timestamp fence
indefinitely. These new records are linkable account metadata, distinct from
owner-free object-cleanup prefixes. They preserve revocation even if an API-only
restore reintroduces old identity rows. Inbox-only recovery must replay the API
ledger and verify fences **before** re-enabling receipt or owner reads. If both
ledgers roll back without complete independent deletion history, Inboxes must
remain closed pending an operator recovery decision. Restoring sufficient history
can preserve surviving access. Resetting old generations/endpoints requires
explicit later operator authorization for that incident; it is a tested emergency
option, not standing permission to discard access. Standard backups do not
guarantee complete deletion history. No independent ledger infrastructure is being
added, and automatic no-resurrection recovery from two rolled-back databases is
not implemented or claimed. See [the recovery runbook](../inbox/OPERATIONS.md#recovery-remain-closed-until-reconciliation-is-verified).

Migration 0018 and dry-run Worker `d533ffae-0340-42bf-b5e3-693c69e4666d` were
deployed 2026-10-18 Pacific. A SELECT-only execution of the same eligibility
module against production D1 at 2026-10-19 05:10 UTC found **0 candidates among
122 accounts**: no account creation predates the 18-month cutoff. Three accounts
had observed activity and 119 still had unknown historical activity. No writes
or provider revocations occurred during qualification. This directly qualifies
the eligibility module and database, not a completed scheduled Worker invocation.

With explicit operator approval, live mode was deployed as Worker
`0922678e-ef4c-44ab-bb2e-ab901ba0c09d`. Cloudflare's deployed settings confirmed
`USER_RETENTION_MODE=delete`, and the production health endpoint passed. The next
daily invocation owns enforcement; no immediate destructive sweep was triggered.

---

## Temporary inference tokens (enabled)

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
run and deletion outcome have not yet been verified.

---

## Session Cookies

### Transient previews (bounded POC)

Preview traffic on `*.bayleaf-proxies.dev` passes through the API Worker to the
sandbox application. The gateway does not store or log HTTP bodies. It stores
the upstream access URL and optional configured application headers encrypted
together in D1 so it can forward requests; this
credential is decryptable by the gateway, not a zero-operator-access guarantee.
The application and sandbox may retain their own files and state.

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
encrypted configuration alongside its destination.

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
| Opaque session-token digest, email/name, account generation, expiry | 24 hours; logout deletes it; ordinary-key rotation/revocation does not invalidate it (issue #90 implementation, rollout pending) |
| Sandbox-host session cookie | Secure, HttpOnly, host-only, SameSite=Lax; 24 hours |
| Sandbox transaction and API broker/return cookies | Secure, HttpOnly, host-only, SameSite=Lax; at most ten minutes |

Expired database rows are removed by scheduled hourly cleanup. Session secrets
are never stored in plaintext in D1. Signing out of Sandboxes revokes only its
session, not the independent API or preview sessions. Successful sign-in may
create the normal account identity record for a new user, without provisioning
an inference-provider key. It also makes one best-effort wake/activity refresh
of existing sandbox compute, counted by the existing sandbox inactivity policy.
Reloads and status requests do not renew activity.

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

## Operational telemetry (rolling out)

On 2026-10-20 the operator approved deployment and live collection of four
classes in a separate private Cloudflare Worker/D1 collector: public-page
arrivals, native OWUI aggregate metrics, aggregate deletion-job summaries and
existing synthetic probe-run summaries. This approval is not a claim that the
collector or every source is live. Current source activation is recorded in the
[rollout record](../telemetry/qualification/rollout.md)
and [privacy notice](../PRIVACY.md).

Public-page observations contain destination service, collector time and
referring hostname or unknown, not paths/query strings or unique-visitor IDs.
They count nonunique observations, not people. No tracking cookies or per-client
deduplication are used. Native OWUI metrics are aggregate HTTP counts/duration
histograms and user gauges, not a new API request stream. Deletion summaries
contain run IDs/times, job/mode, fixed outcomes, durations and approved aggregate
counts/configuration; probe summaries contain synthetic run IDs/times, layer,
fixed results, outcomes, duration/phase/event timings and cleanup status. No
prompts, completions, identities, IP/UA, private URLs, raw logs/errors, credentials
or model strings are collected. The operator can read the telemetry.

**Sealed boundary unchanged:** no per-request Sealed inference metadata is added
to this collector. Only fixed summaries of the existing synthetic Sealed probe
are included. The Sealed-traffic section above continues to describe user
inference, not synthetic monitoring or the separate existing account/quota state.

All four classes expire at most **90 days after observation** (each metric point
uses its own observation time); receipt/retry never restarts retention. Expired
rows are excluded from private reads at expiry. Scheduled physical purge runs
each minute in bounded batches of at most 500 rows per table; backlog/outages can
delay removal. Cloudflare D1 paid-plan Time Travel may retain deleted rows for
**up to 30 additional days after physical deletion**, in addition to purge delay.
This is not full erasure at day 90. Recovery must reapply effective retention
ceilings/cutoffs and purge expired rows before reads or collection resume.

There are no automatic exports or long-term telemetry archives. Reports,
downloaded exports and derived artifacts have the same maximum lifecycle as
their source observations and must be deleted by the earliest included
observation's expiry; copying or aggregation never resets that clock. Artifact
expiry is an operator obligation, since the collector cannot revoke downloads.
Four content-free durable policy rows persist to enforce only-decreasing
per-class TTL ceilings and only-advancing retirement cutoffs. Changing a variable
cannot raise a previously recorded ceiling, including a local seven-day ceiling.
These rules do not alter the existing account, credential, sandbox, billing,
platform-log or provider retention schedules.

---

## Summary

| Data class | Location | Retention |
|---|---|---|
| Prompts and completions | Not stored, not logged (ZDR passthrough, ZOA posture) | — |
| Sealed-lane prompts and completions | Not stored, not logged, and not decryptable by BayLeaf (attested E2EE) | — |
| Plaintext model-policy verdicts | Cloudflare `MODEL_STATUS` KV | 24 hours for positive and definite-negative; unknown is not stored |
| User identity/activity and credentials (D1) | Cloudflare D1 | Daily eligibility after 18 calendar months of user inactivity, subject to known timestamps, exemptions/holds and resource dependencies; provider revocations retried |
| Sandbox content | Daytona | 90 days after last activity |
| API session state | Client cookie | 24 hours |
| Sandboxes session metadata | Cloudflare D1 and host-only client cookie | 24 hours, then scheduled cleanup; explicit logout removes the session row |
| Edge logs | Cloudflare | ~72 hours (platform default) |
| Operational telemetry (rolling out) | Separate private Cloudflare Worker/D1 | 90-day live maximum from observation; bounded purge delay; paid-plan recovery up to 30 additional days after physical deletion; reports/exports share source expiry |
## Sandbox credentials (issue #90, rollout pending)

D1 stores a random credential ID, owner email, exact sandbox ID, SHA-256 bearer
verifier, Daytona secret name/ID and placeholder, state and timestamps. It never
stores the real sandbox bearer. Active metadata lasts until access is revoked or
the sandbox is deleted/replaced. Pending setup expires after 20 minutes; revoked
metadata is a cleanup outbox retained until Daytona secret deletion succeeds.
Hourly bounded cleanup retries provider failures and reconciles externally deleted
machines. D1 backup retention also covers deleted metadata. This adds no request
content logging, content cache or enabled Workers observability.

Daytona encrypts the bearer in its organization Secrets service and processes
HTTPS headers for substitution. Its platform administrators hold credential custody;
this is not zero-operator-access. Guest files contain only its opaque placeholder
after managed-service migration. Existing ordinary-key copies and their backups
require the migration and revocation steps in [SANDBOX-CREDENTIALS.md](SANDBOX-CREDENTIALS.md).
