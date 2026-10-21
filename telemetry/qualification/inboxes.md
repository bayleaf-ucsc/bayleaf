# Inboxes aggregate contract and operator-pilot rollout

Source `inboxes` uses the existing authenticated `POST /v1/metrics` protocol,
schema 1, policy 4. Give it a separate entry in collector `WRITE_KEYS_JSON`.
No new collector table, public read, cloud resource or per-request event store.

All points are monotonic delta sums, unit `1`, integer counts, aligned UTC
15-minute windows (`start_at`, exclusive `observed_at = start_at + 900000`).
Envelope observation equals window end; batch UUID identifies only that export
window and is durable and unchanged on retry. Missing points/windows are unknown,
not zero. Counters reset each window, never at process restart. Counting is best
effort and independent of reception, not billing or exactly-once receipt accounting.

| Metric | Required attributes and fixed vocabulary |
|---|---|
| `inbox.receipts` | `transport`: `http`, `email`; `outcome`: `accepted`, `auth`, `rate`, `quota`, `size`, `unknown_address`, `failure` |
| `inbox.lifecycle` | `transport`: `http`, `email`; `outcome`: `created`, `destroy_requested`, `destroyed` |
| `inbox.cleanup` | `outcome`: `expired`, `stale`, `retried`, `destroyed_messages`, `reconciled`, `success`, `failure` |

Receipt outcomes count terminal handler results (HTTP OPTIONS/apex/disabled routes
excluded). `rate` includes the failed-auth guard bucket; daily quota is `quota`.
Email `accepted` means stored, not proof of SMTP sender acknowledgement; rejections
count `setReject` decisions, not independently verified delivery of bounces.
Lifecycle counts successful transitions, not repeated destruction requests.
Cleanup measures scheduled sweep work only, not inline owner deletion/destruction
cleanup. Message/object counts are confirmed removals; success/failure count sweep
completion/exception, not proof every pending deletion is complete. Per-item retries
that do not throw need not make the sweep fail. `destroyed` counts scheduled
finalization, separately from message cleanup.

Only these fixed dimensions, counts and coarse bounds enter telemetry. Never
addresses, IDs, account pseudonyms, hostnames, paths, headers, subjects, bodies,
credentials, sender/network IP or raw errors. Unknown recipients share one counter.

Inbox migration `0002_telemetry.sql` adds bounded aggregate counters and a window
outbox in existing D1. At most 96 windows and 27 series/window (2592 counter rows).
Local export eligibility expires 24 hours after window start, including unsent or
acknowledged data; each cron prunes expired rows before export. Physical deletion
can lag during cron outages, but the 96-window capacity still bounds storage.
Closed windows seal before export; later increments cannot mutate retries. Up to
two windows export per cron, five-second deadline each, redirects forbidden. Only
HTTP 202 acknowledges export. Lost acknowledgements resend the same UUID/content;
collector deduplication prevents double-counting. Acknowledged windows stay marked
until local expiry. Full queues/drop races/telemetry errors lose counts silently,
never turn an accepted message into a reception failure. Cron prunes telemetry even
when collection is off and always attempts ordinary inbox content expiry.

Inbox var `INBOX_TELEMETRY_ENABLED` defaults false; explicit `true` plus secret
`INBOX_TELEMETRY_WRITE_SECRET` (dedicated `inboxes` writer, at least 24 non-space
characters) enables counting/export. Destination is fixed:
`https://telemetry.bayleaf.dev/v1/metrics`. Collector `INBOXES_METRICS_ENABLED`
defaults false and must also be explicitly true, alongside `TELEMETRY_ENABLED`.
Collector retention remains its durable metrics-class ceiling, maximum 90 days,
anchored to original window end; retry never extends expiry. Local 24-hour expiry
does not erase provider recovery history. Derived copies retain original expiry.

## Rollout evidence and remaining gates

Local evidence: `npm test` in `inbox/`: 53 passing (all 47 original contracts,
one real workerd/D1 export test and five SQLite/privacy/failure tests).
`npm test` in `telemetry/`: 96 passing after reconciliation with Daytona on main. Tests cover fixed vocabularies,
source-scoped authorization, private reads, duplicate/lost-ack retries, redirects,
queue capacity/export bounds, telemetry failure isolation, and off-switch expiry.

Policy/source changes were reconciled with Daytona, disclosures explicitly approved,
migration applied and a dedicated writer provisioned while preserving existing
writer/read credentials. Both Workers were first deployed with inbox switches off,
then receiver/exporter were explicitly enabled. Observability remains off.

Live scheduled export verified the aligned **2026-10-21 04:45–05:00 UTC** window:
`inbox.lifecycle` HTTP `created=1`, `destroy_requested=1`, and `inbox.receipts` HTTP
`accepted=1`, `auth=1`, `unknown_address=1`. These came from a real synthetic API/
receiving-URL workflow, not injected counter rows. Source-writer reads returned
401 and operator reads returned 200. The test message was deleted and its inbox
entered durable destruction; finalization cannot begin before 05:11:26 UTC.

**Pending live evidence:** email counters (the earlier operator email preceded
collection), scheduled cleanup outcomes/finalization, lost-ack retry injection and
off-switch expiry. Local tests cover these cases; local tests are not live proof.
Metrics remain operational counts, not SMTP acknowledgement or billing accounting.
