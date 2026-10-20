# Source adapters: local qualification and future integration

Nothing here is enabled, imported by a live service, or deployed. No production
requests, real credentials, source log scraping, git history or source-service edits
were used. Fixtures are synthetic copies of checked-in report shapes.

## Delivery and privacy boundary

`telemetry/adapters/` contains inert ES modules and a Python module. Browser
`createArrivalClient(config)` is disabled unless `enabled === true`, requires an
explicit endpoint, returns a synchronous fire-and-forget function and attempts
once per client. Invoke once per initial document, never per SPA route, message,
login, user or resource. It reads `document.referrer`, never `location`, cookies,
storage, IPs, user agents or identity. A caller supplies a fixed destination.

Policy v1 projects a parsed HTTP(S) referrer into a lowercase DNS hostname only:
no credentials, port, path, query or fragment survives. IP literals, local names,
opaque identifier labels and individualized BayLeaf subdomains are excluded.
Absent/rejected referrers become null. This is a light, revisable filter, not a
proof every external hostname lacks personal information. Known personalized or
private referring domains must be excluded through a policy revision before
enabling their collection. Do not hash identity into a pseudonymous hostname.

All senders impose a 16-KiB UTF-8 limit and a 1-second default, at most 2-second,
caller deadline. They make one attempt, never retry, log errors or read response
bodies. Explicit HTTPS endpoints only, except loopback HTTP for local tests.
Endpoint credentials, query strings, fragments and incorrect endpoint paths are
rejected. JavaScript requests use `credentials: omit`, `referrerPolicy:
no-referrer`, empty `referrer`, `redirect: manual`, `cache: no-store` and bounded
`keepalive` payloads. No beacon fallback (beacons cannot omit cookies explicitly).
Failures, including synchronous throws and ignored abort signals, are swallowed.
An HTTP success is receipt, not a claim of durable storage.

### Service write authentication and bounded concurrency

Browser `deliver(payload, '/v1/browser', config)` and `createArrivalClient(config)`
never add Authorization, even if a caller accidentally provides `service_token`
or arbitrary `headers`. The browser helper rejects service endpoint routes.
Never supply any real credential to browser code, HTML, asset configuration or
browser storage. Only destination/collector endpoint belong in browser config.

Services use the distinct `createServiceSender(config)` export from
`adapters/common.mjs`. Required configuration is `{enabled:true, source,
endpoint, service_token}` with optional `deadline_ms` and a trusted test/binding
`fetcher`. `service_token` is an explicit in-memory **collector-specific write
token**, 24–512 printable non-whitespace ASCII characters. No environment/file
lookup is performed. No arbitrary caller headers are accepted. The transport
constructs only Content-Type and `Authorization: Bearer <service_token>`.
Tokens never become URL/query/body fields and are not copied from source
requests, OWUI clients, httpx clients, upstream credentials or read credentials.

This matches core `src/worker.js`: `WRITE_KEYS_JSON` maps each source to a
distinct secret; the writer authenticates the Bearer token for its class, then
requires the payload's `source` to match that key. Write keys cannot read;
`READ_SECRET` cannot write. This adapter implements `chat-retention`,
`api-retention`, `sandbox-reaper` on `/v1/deletions`, and `probe` on `/v1/probes`.
The sender checks source/endpoint binding locally before network work; the
collector independently checks authenticated source and payload class.

Create **one long-lived sender per source per runner/Worker isolate**, not one
per invocation. A sender snapshots approved configuration into its closure and
allows one outstanding underlying fetch. Concurrent sends drop immediately,
with no queue. If a fetch ignores abort after the caller deadline, it retains
the slot until that fetch settles. Ignored response-body cancellation retains
the same slot too; cleanup cannot accumulate behind completed response headers.
A permanently stuck transport disables that
instance's later sends rather than accumulating background operations. Separate
instances/processes/isolates have independent limits; this is not a deployment-
wide rate limit. Constructing a new sender every run defeats the instance bound.

```js
import { createServiceSender } from './common.mjs';
import { apiUserDeletion, emitDeletion } from './deletions.mjs';
// Endpoint/token are explicitly supplied by the future host integration.
// This example neither loads secrets nor enables a real source.
const sender = createServiceSender({ enabled: true, source: 'api-retention',
  endpoint: collectorEndpoint, service_token: collectorWriteToken });
await emitDeletion(() => apiUserDeletion(aggregateReport, run), sender);
```

Python `submit_summary(build, enabled=False, endpoint=None, service_token=None, sender=None,
deadline_ms=1000)` does not reuse the cleanup job's authenticated OWUI client.
Its fresh httpx client disables environment proxies, redirects and inherited
credentials/cookies. It streams and closes replies without reading them. A
single daemon delivery slot bounds caller latency even if DNS ignores I/O
timeouts. If a transport hangs, that slot remains occupied and later submissions
are dropped, not queued. Its slot is module-wide for the Chat retention process,
not deployment-wide. The explicit `service_token` argument is required and has
the same format bounds as JS. It authorizes only the `chat-retention` source
summary and is never read from the job's OWUI token. No promise of delivery at
process exit. No infinite
retry or background loop. Keep `build` a bounded aggregate-only operation.

Browser traffic is untrusted counting, not evidence of people or unique users.
Omitting cookies/referrer does not prevent the receiving network operator from
seeing transport metadata such as IP and user agent. Collector ingress must not
retain those headers, expose them as query fields, or enable request logging.

## Exported contracts

Wire contracts align with the collector's proposed `POST /v1/browser`,
`POST /v1/deletions` and `POST /v1/probes`. Browser body:

```json
{"schema_version":1,"destination":"chat","referring_hostname":"example.org"}
```

Destination vocabulary is `landing | chat | api | sandbox`. Browser records carry
no client timestamp, ID, source pathname or session identifier. The collector
assigns receipt time and policy version.

Service common fields: `schema_version:1`, fixed `source`, `batch_id` (fresh UUIDv4
for the source run only, retained solely for deduplication), `observed_at` (end
UTC epoch milliseconds), `duration_ms`, and `outcome: success | partial | failure
| skipped`. Local builders take `run = {run_id, started_at, ended_at, outcome}`
with ISO milliseconds UTC timestamps and `ok | partial | failed | disabled`, then
map to that wire vocabulary. No identifier may be derived from a person,
resource, credential, synthetic chat marker or upstream request ID. Retry logic
is absent; if a caller ever replays a run, reuse the same UUID and exact record.

Service extensions carry `started_at` and `ended_at` as UTC epoch milliseconds.
Deletion duration is their span. Probe duration is metrics-v2's monotonic total,
not subtraction of wall-clock times. Collector policy version is assigned at
acceptance; adapter allowlists are policy v1.

### Deletions

Exports: `apiUserDeletion(report, run)`, `apiSandboxDeletion(report, run, mode)`,
`emitDeletion(() => payload, sender)`. Python exports typed `ChatRetentionCounts`,
`Run`, `RetentionPolicy`, `chat_retention_summary(counts, run, mode, policy)` and
`submit_summary(...)`. Builders return null/None on invalid known data. Safe
emitters additionally swallow unexpected source/builder exceptions.

| Source / job | Actual source report | Top-level `deleted` |
|---|---|---|
| `chat-retention` / `chat-retention` | Explicit typed counters to add to `run_cleanup` and `cleanup_accounts` | Confirmed chat + file + account DELETE operations, not cascade objects |
| `api-retention` / `user-retention` | `cleanupInactiveUsers()` return value | `retired`: local atomic account retirements, not upstream revocations |
| `sandbox-reaper` / `sandbox-reaper` | `reapInactiveSandboxes()` return value | `deleted`: provider-confirmed removals followed by cache cleanup |

Extensions are fixed `mode: delete | dry-run | disabled` and `counts` containing
only the exact source counters. Unknown report fields are dropped, not spread.
Missing Chat counters are absent (phase not reached/unknown), never fabricated
zeroes. Partial counts do not imply a successful run. API reports require every
known counter, since their current returned objects always initialize them.

Chat counters: `users_total`, `users_held`, `chats_scanned`, `chats_expired`,
`chats_deleted`, `chats_would_delete`, `users_impacted`, `files_total`,
`knowledge_bases`, `chats_scanned_for_refs`, `files_referenced`, `files_in_grace`,
`files_orphan`, `files_deleted`, `files_would_delete`, `users_invalid_activity`,
`users_expired`, `users_recheck_skipped`, `users_deleted`, `users_would_delete`.
Chat policy extensions: `retention_days` (positive integer),
`orphan_grace_seconds` (nonnegative integer), `user_retention_months` (positive
integer), optional `file_sweep: skipped_no_eligible_files`.

API account counters preserve checked-in camelCase names: `candidates`, `retired`,
`recheckSkipped`, `providerPending`, `outboxCompleted`. `providerPending` is the
entire outbox backlog, not this run's failures. `outboxCompleted` can exceed
`retired` because old entries are processed too. Never export outbox rows or IDs.

Sandbox counters: `scanned`, `candidates`, `deleted`, `pending`, `skipped`,
`failed`. Caller supplies configured mode explicitly: the source sets
`dryRun:true` for both disabled and dry-run. A pending asynchronous provider
deletion is not confirmed deletion. No owner, sandbox name, labels or ID survives.

### Probes

Exports: `probeSummary(report, run)`, `emitProbe(report, run, sender)`, `PHASES`,
`EVENTS`, `LAYERS`, `resultCode`. Input is the assembled object in
`chat/probe/index.mjs`'s `finish()`: `{version:2,layer,result,metrics,...report}`.
No authenticated fetching of existing probe endpoints is required or provided.
The summary's collector submission uses the dedicated service sender. This is a source-side
push seam, not another probe runner or a change to UptimeRobot's contract.

Layer vocabulary: `owui | browser | openrouter | api | sealed | catalog`.
Top-level `phases_ms` contains additive nonoverlapping phase durations and
`events_ms` contains cumulative offsets from Worker start. Preserve the actual
source keys from the exported allowlists; do not rename offsets into phases or
sum phases and offsets. Unknown keys are dropped. Invalid known values,
offsets outside total or contradictory timing sums are rejected.

Probe extensions: `result` and optional `work_result` (fixed code vocabulary,
including bounded HTTP-status codes), `accounted_ms`, `unaccounted_ms`, optional
`failed_phase`, `cleanup: not_needed | confirmed | failed`, and
`close: not_started | unconfirmed | confirmed | failed`. A completed work result
with failed cleanup remains failed. Stage strings, model lists (including
catalog missing/deprecated lists), diagnostic messages, synthetic chat IDs,
markers, bodies and identity are deliberately excluded.

## Exact future source changes, not performed

1. **Browser:** bundle `browser.mjs` and `common.mjs` into a reviewed standalone
   asset. Do not remotely load a tracker from a collector origin: fetching its
   script could itself disclose a referrer. Landing currently promises no runtime
   JavaScript, so enabling requires an explicit product/accessibility/privacy
   decision. Use a fixed `destination:'landing'` in `landing/index.html` only if
   approved. API: insert a fixed `api` initial-document hook into the public page
   render in `api/src/templates/layout.tsx`, not arbitrary URL-derived values.
   Sandbox: place a fixed `sandbox` hook in `sandbox/page.tsx`'s generated page,
   not login callbacks, auth interstitials or owner service frames. Chat: use a
   reviewed frontend injection seam, initially landing/auth UI only, rather than
   observing saved-chat routes or SPA navigation. No assumption that an OWUI
   filter receives initial browser arrivals. No application hook exists yet.
   Approve explicit endpoint, CSP/connect-src and credential-free CORS separately.
2. **Chat:** copy the Python adapter into the retention image with an explicit
   `chat/Dockerfile.retention` COPY. In `run_cleanup`, create one run UUID and UTC
   start time before health/discovery, own a `ChatRetentionCounts` instance, and
   pass it into `cleanup_accounts`. Assign count fields beside their existing
   variables, increment confirmed deletion fields only after `delete_chat`,
   `delete_file`, or `delete_user` succeeds. Record account candidate vs fresh
   eligible counts separately. Update fields in the existing `finally` blocks
   so partial progress survives. In the early no-eligible-files branch, set only
   that `file_sweep` extension, not zero orphan/reference counts. Add one outer
   `finally` that constructs the end timestamp/outcome and calls the safe sender.
   Preserve the original exception/exit status and deletion semantics. Copy
   primitive counts only, never hand adapters users, IDs, chats, files, groups,
   HTTP clients, exceptions or log strings. Defer account-cascade counts because
   source does not measure them. No stdout parser or synthetic counters.
3. **API:** `api/src/index.ts`'s scheduled handler can wrap the existing
   `cleanupInactiveUsers` and `reapInactiveSandboxes` calls: generate independent
   run UUIDs/start times, use actual returned aggregate reports, then put bounded
   emitter promises into `ctx.waitUntil` without changing job success/failure.
   The current scheduled signature has no `ctx`: add its `ExecutionContext`
   parameter explicitly. Preserve current ordering: sandbox failed/pending
   results throw before account retention runs. Summarize the reaper before
   that existing throw, and never claim an account run when it was skipped.
   Use actual configured mode for sandbox reaper; infer partial only from known
   returned failure/pending counters, not exception messages. Account retirement
   with a provider backlog should not be mislabeled a failed local retirement.
   If a source throws before returning a report, do not invent zero counters:
   either emit no summary or explicitly instrument a partial accumulator first.
4. **Probe:** inside authenticated `finish()` after `timing.snapshot()`, assemble
   one object matching existing GET JSON (including for HEAD), build the summary,
   and schedule its bounded emitter with `ctx.waitUntil`. Generate a fresh run
   UUID/start wall time at invocation start, but do not reuse the browser marker.
   Only known/authenticated routes reach this seam. Preserve all existing status
   codes, response headers, deadlines, cleanup and UptimeRobot ownership. Run the
   emitter after the monotonic snapshot, so telemetry is not counted as probe
   latency. Never forward the request/response, authorization or raw report.

All deployment flags remain unset, no public collector address is baked in,
and no source imports were added. Collector-specific Bearer write authentication
is implemented and qualified locally. Provisioning/installing real collector
write keys, selecting the production collector endpoint and integrating source
hooks remain explicit future rollout gates; do not reuse upstream authorization.
Source enablement requires privacy disclosures
and a real failure/isolation qualification, not just these synthetic tests.

## Reproduce offline

```sh
node --test telemetry/adapters/*.test.mjs
node --test telemetry/qualification/sources.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s telemetry/adapters -p 'test_*.py'
```

The Python HTTP sender depends on `httpx`, already used by the future retention
image. End-to-end qualification uses `uv run --offline --with httpx` against the
existing local package cache: missing cached dependencies fail, never download.
Node tests require the same Node version with `node:sqlite` as core tests.

Tests assert actual checked-in phase/event/counter names, offset semantics,
failure/cleanup distinction, outbox-vs-retirement units, once-only browser sends,
credential/referrer exclusion, disabled behavior, malformed inputs, deadlines,
oversized payloads, transport throws and no retries. Unit tests use synthetic
fetchers/senders. Cross-contract tests additionally exercise the real collector
Worker and real in-memory SQLite behind its D1-shaped test adapter, including
Python's default httpx sender through a loopback-only HTTP bridge. Two loopback
origins prove redirects are not followed and never receive tokens at the second
origin. No production or provider network requests, source-service imports or
external listeners are involved. These tests establish SQLite behavior, not
workerd conformance. They verify source/class separation, write/read separation,
browser's absent Authorization, real network deadlines and no later retries.

Qualification on 2026-10-20 after service authentication: 20 Node tests (12 adapter,
8 collector cross-contract/end-to-end)
and 8 Python tests passed. Native OTLP qualification is separately owned and is
not established by these source-adapter results. This proves local contracts
and failure isolation under synthetic and loopback transport, not production delivery.
