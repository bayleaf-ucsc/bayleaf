# Integrated production qualification (2026-10-21 UTC)

Authorized coordinated rollout after the completed GLM 15-minute SSE trial.
No commits, pushes, worktree removal, mail sends or existing-owner retirement.
GLM's original report remains unchanged.

## Versions and provenance

| Worker | Previous version | New version (100% traffic readback) |
|---|---|---|
| Collector | `5138f433-0f88-4af6-a895-0d7923a1831a` | `ba47b369-67c7-4110-acbd-c5521898ab34` |
| Inboxes | `590c0e92-6d3b-4fe9-9666-33c6b6ab1374` | `a5b7b69f-a236-4537-8d57-acd230723494` |
| API | `d24cbfe9-afad-4b1f-a32a-c6b9bb5ce226` | `b751f1c0-7c0a-466f-8d27-c2ef6269301d` |

Main HEAD was `7ef6409`; the integrated runtime was uncommitted. Compared live
bundles and configuration with build candidates before rollout. API changes versus
the live TTL/SSE baseline were export/HAR, gated email-policy contracts, retirement
handoff, MIME resource error mapping and matching discovery text. Collector changes
were only the export vocabulary/31-point bound. Receiver included the guarded DKIM
build and integrated cleanup/MIME/export/fence work.

API staged in an isolated copy using normal production build hooks. Published
plugin `eb40edabc1e7dd58a6e9be586115779402ccfd23` and Nanobot
`16ee3c3ba44f6ae64d6847e64a79fa7949c18c2a` match previous production pins.
Nanobot provenance explicitly reports `mode: published`, with the exact revision,
published main ref and asset hashes. Main's fixture-generated assets were not used.
All six deployed modules (including three API Python text modules) were fetched
after deployment and matched the built artifacts, ignoring trailing whitespace.

All prior plain-text variables, including the API operator-generation pilot gate,
were preserved exactly. Receiver adds only `EMAIL_AUTH_CREATION_ENABLED=false`.
Observability stays disabled; telemetry activation and 90-day collector retention
are preserved. Source API defaults remain disabled, so future deploys still need
pilot-aware staging and authentic adapter builds.

## Order and migrations

Preflight found exactly Inboxes 0005–0007 and API 0019 pending; collector had none.
Deployed collector first, applied Inboxes 0005/0006/0007 (5/3/3 commands), deployed
receiver, applied API 0019 (4 commands), then deployed API. All succeeded.
Post-deployment remote ledger reads confirm Inboxes 0001–0007, API 0001–0019 and
collector 0001–0004. Earlier Inboxes 0003/0004 were not reapplied.

## Measured production results

- `qualify-inbox-export.mjs --live`, exit 0: two tar pages, **1,064,448 archive
  bytes**, exact SHA-256 payload checks, one external file reference for the 1 MiB
  synthetic body, inline small-body check, standalone HAR parity, response-header
  cursor passed as query parameter, and 404 after the real 60-second endpoint TTL.
  Exact-resource cleanup returned an accepted status without warning.
- Minimal `qualify-inbox-stream.mjs --live`, exit 0: three receipts, catch-up,
  same-connection self-post, disconnected-arrival resume and explicit-destroy
  termination. The earlier full 15-minute GLM evidence is a separate prior-version
  run, not a fresh full-duration trial on this version.
- Restricted email creation with a synthetic policy returned the intended HTTP
  **404** (`disabled` mapping). Read-only D1 count: one existing email inbox,
  zero restricted policies. No email was sent or existing policy changed.
- Read-only checks for the disposable export/SSE labels found **zero message,
  credential and stream-lease rows**. Two synthetic inbox rows remained
  `destroying`: final inbox-row/R2-prefix physical cleanup was not yet verified.
  Immediate revocation is not physical erasure or removal from provider history.
- Export aggregate window starting `1792573200000` (2026-10-21 09:00 UTC): source
  outbox `sent=1`; collector D1 independently contains exactly **2 pages** (`1`)
  and **1,064,448 bytes** (`By`), transport `http`, outcome `emitted`. This proves
  scheduled aggregate delivery, not arbitrary client delivery.
- API retirement ledger was empty. Schema/fence implementation is deployed;
  lost-ack/replay/restored-generation behavior remains locally qualified, not a
  live account-retirement claim. No existing owner was retired for a test.

The integration audit restored finite-event regressions without runtime changes:
138 passed, two optional importer checks skipped, zero failures (140 tests,
23 suites), reported by the test agent before final readiness. Earlier integrated
SSE/E2E/collector/typecheck and stress evidence is in `INTEGRATED-HARDENING.md`;
the expensive stress was not repeated without runtime changes.

## Limits and next GLM export trial

Real restricted SMTP acceptance/rejection/retry behavior, production MIME heap
and concurrent-isolate bounds, full retirement recovery and current GUI importer
compatibility remain unqualified. Restricted creation stays disabled, and the
operator-only gate stays in force. No campus enablement is implied.

Safe local trial recipe: review the fixed launcher
`/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/inbox-export-live-client.py`,
then run it with `python3`. It retrieves only the existing operator key into
process memory through the authenticated `cf` profile, passes it through the child
environment to `api/scripts/qualify-inbox-export.mjs --live`, and prints only
counts/booleans. It never writes or prints the bearer. The client creates and
cleans only a disposable synthetic inbox; its TTL is the backstop.

For an independent AX exercise, give GLM public `/llms.txt`, `/docs/inboxes.md`
and OpenAPI plus this reviewed private-launcher pattern. Have it implement two
pages in separate private directories, verify hashes, explain manual `_file`
attachment and unknown HAR responses/timings, and remove only its trial resources.
The fixed smoke itself holds the archives in memory; it is protocol evidence,
not an independent client-discovery or GUI-import trial.

## Final export documentation follow-up (2026-10-21 09:29 UTC)

The independent GLM export trial passed, but its schema diagnosis was wrong:
the implementation emits **one manifest per page**, named
`manifests/{first_selected_id}.json` (or `manifests/empty.json`), not one per
receipt. Verified against both `exportStream` in source and the live receiver
module. The trial's measured two-payload page with one manifest supports this;
an audit annotation preserves the original report while correcting its inference.

Updated the public focused guide source, DESIGN and SELF-HOSTING with the actual
tar layout, version-1 fields, payload checksum scope, omissions, timestamp units,
cursor/header relationship and bounded HAR text-versus-file behavior. Added a
small discovery regression to the existing docs test. `npx tsc --noEmit` and
`npm run test:docs` passed. No runtime behavior change, commit, push or worktree
creation/removal.

### Documentation-only API deployment

API version **`a6dd4a5f-8a03-45d7-91f3-5b5fb14dc9cb`**, 100% traffic readback,
supersedes `b751f1c0…` above. Used the preserved production staging copy, not
main's fixture assets. Before editing staging, all four rebuilt API modules
matched the live deployment byte-for-byte after trailing-whitespace normalization;
main's API source differed from staging only in the new guide text. Production
plain-text variables matched exactly. Normal build hooks verified Nanobot's
published `16ee3c3…` provenance; plugin `eb40eda…` was independently confirmed
as an advertised upstream revision. The candidate bundle diff contained only the
guide text. After deployment, all four live modules matched the candidate and
all settings were unchanged, including pilot gate and observability. Public
`/docs/inboxes.md` returned 200 with the new layout and schema. Receiver and
collector were not redeployed.

### Read-only physical cleanup check and limits

At **09:29:46 UTC**, SELECT-only operator D1 checks were scoped to the two
deployment-smoke labels verified in their scripts and the exact GLM label in its
private trial script. They found **six inbox rows still `destroying`**: one
export smoke, one SSE smoke, and four GLM export trials. Their combined message,
credential and stream-lease row counts were each **zero**. No message metadata,
payload, address, token or unrelated inbox was queried or printed; no deletion
was issued. The fifth GLM trial was not positively identifiable from the retained
script, so its finalization is unverified.

**Physical finalization remains unverified**, including R2-prefix emptiness.
The finalizer requires quiescence and an empty prefix before removing the inbox
row, and retains opaque reconciliation tombstones for late writes. A metadata
GET returning 200 with `state: destroying` is not content access or proof of
retained accessible messages; neither a 202 destroy acknowledgement nor zero
message rows alone proves physical erasure. No provider-history erasure is claimed.

### Bounded finalizer investigation (09:31–09:33 UTC)

The 09:29:46 observation preceded eligibility for **all six** known synthetic
inboxes. Their actual creation/destruction timestamps, queried without owner,
address or message metadata, were:

| Synthetic trial | Created UTC | Destroy requested UTC | Earliest finalization UTC |
|---|---|---|---|
| Export smoke | 09:14:50 | 09:15:50 (endpoint expiry) | 09:30:50 |
| SSE smoke | 09:14:51 | 09:14:55 | 09:29:55 |
| GLM export 1 | 09:23:02 | 09:23:08 | 09:38:08 |
| GLM export 2 | 09:23:25 | 09:23:32 | 09:38:32 |
| GLM export 3 | 09:23:49 | 09:23:55 | 09:38:55 |
| GLM export 4 | 09:24:12 | 09:24:19 | 09:39:19 |

Live Cloudflare schedule readback confirms `*/15 * * * *`; receiver deployment
remains `a5b7b69f…` at 100%. No production quiescence override is present, so the
900-second source default applies. Source outbox shows successful 08:45, 09:00,
09:15 and 09:30 sweeps, with no failure counters in that interval. Independent
collector readback confirms exported cleanup successes through the 09:15 source
window (collector observation timestamps are window ends).

At 09:33, all six exact R2 prefix listings succeeded and were **empty**. Their
message, credential, event and stream-lease row counts were all zero. Durable
prefix records remain with null pagination cursors and advanced turn values.
Only the inbox metadata rows awaited finalization. The source finalizer checks
empty rows/prefix plus elapsed quiescence; no introduced condition preventing
finalization was found.

The integrated sweep selects **five** destroying inboxes per invocation, using a
durable round-robin cursor. After 09:30 that cursor was at the fourth GLM trial
in lexical traversal (`ibx_lomi…`), consistent with skipping the SSE smoke while
the other five were not yet eligible. This is bounded queue scheduling, not
evidence of an R2 deletion failure. With these six candidates and successful
sweeps, 09:45 and 10:00 provide two turns after all become eligible; this is an
expected completion window, not a service-wide deletion SLA.

One background bounded timer is set for **10:01 UTC**, followed by one SELECT-only
check of the six retained IDs, child counts, cleanup telemetry and exact R2
prefixes. No polling, manual sweep, forced deletion or deployment was performed.
Final inbox-row removal remains pending that boundary check. Private content-free
diagnostics are `final-cleanup-initial.json` and the pending
`final-cleanup-boundary.json` under the approved OpenCode temporary directory.

### Final boundary result: physical cleanup verified (10:01 UTC)

The timer's first D1 diagnostic failed before returning any resource results;
one immediate retry at **10:01:04 UTC** succeeded. This was a diagnostic retry,
not repeated waiting/polling or a cleanup mutation. The retained six exact IDs
now have **zero inbox rows**, zero message/credential/event/stream-lease rows,
and **six successful empty R2 prefix listings**. All six known synthetic trials
therefore passed live-resource physical cleanup verification. Durable opaque
prefix records remain intentionally, with reconciliation turns advanced.

The 09:45 and 10:00 source windows each record a successful sweep and no failure
counter. Aggregate destroyed counts are five and two respectively; these are
service-wide counts, not attribution to the six scoped trials. Collector readback
independently confirms the exported 09:45 window's success and five destructions;
the current 10:00 source window is not yet exported. No additional check is needed
to establish removal of the six exact resources.

The earlier delay was consistent with quiescence plus bounded round-robin
scheduling. No finalizer correction or receiver release was needed. No manual
sweep, forced deletion, content read, commit or push was performed. The fifth
unidentified GLM trial and provider recovery history are outside this six-ID
verification. Content-free evidence is saved in `final-cleanup-boundary.json`
under the approved OpenCode temporary directory.
