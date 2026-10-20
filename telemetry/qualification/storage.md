# Storage qualification: local implementation stage

Issue [#112](https://github.com/bayleaf-ucsc/bayleaf/issues/112), 2026-10-20.

## Working choice

Use D1 for the local proof: indexed, bounded time-window retrieval matches the
intended private agent-led investigations. Keep original approved metric samples,
histogram buckets and job/probe summaries; perform analytical aggregation on read.
This is a development choice, not approval to provision a production database.

R2 remains a plausible alternative for downloadable batches, especially if volume
outgrows D1's write/storage budget. It would require object/window organization,
expiry and a download/filter workflow instead of direct SQL. One object per browser
arrival is not the proposed alternative; batching would introduce another lifecycle
to operate. Do not introduce both stores without measured need.

## Retention includes recovery history

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
is always on: seven days on Workers Free, thirty on Workers Paid. SQL deletion
removes rows from the active database, not immediately from recoverable history.
An active row lifetime of R days can therefore leave recoverable copies for up to
approximately R plus the recovery window (and cleanup delay). Do not describe
active-row expiry as complete provider erasure.

After restoring a database, keep reads and collection disabled until expiry and
any later scrubbing/deletion decisions have been reapplied. Policy-version stamps
help identify affected rows but are not an erasure mechanism. Report exports,
downloaded files and derived artifacts need their own expiry; none are automatically
covered by database deletion. Do not add automatic archives.

The seven-day local default is a placeholder. Thirty days was proposed for
exploration but has not been explicitly selected for production.

## Cost model, not a free-service claim

Public pricing checked 2026-10-20:

- [D1](https://developers.cloudflare.com/d1/platform/pricing/): Free includes
  5 million reads/day, 100,000 writes/day and 5 GB total. Paid includes
  25 billion reads/month, 50 million writes/month and 5 GB total; excess is
  $0.001/million reads, $1/million writes and $0.75/GB-month.
- Index maintenance and deletion count as writes. Shared account consumption
  matters. Query LIMIT bounds returned rows, not necessarily scanned rows.
- [R2 Standard](https://developers.cloudflare.com/r2/pricing/): 10 GB-month,
  1 million Class A and 10 million Class B operations included monthly; excess
  $0.015/GB-month, $4.50/million A and $0.36/million B, with billing-unit rounding.
- Workers invocation/CPU charges are separate from either storage choice.

Illustrative volume: one export/minute is 43,200 exports per 30 days. At 100
points/export it becomes 4.32 million metric rows/month, before browser arrivals,
jobs, probes, source-status writes, retry handling, indexes and deletion. With
roughly 1 KB per point, thirty days already means 4.32 GB of row payload before
SQLite and index overhead. These are assumptions, not observed campus traffic.
Small export requests do not imply a small database.

Before rollout, measure point cardinality and serialized sizes using the real
exporter fixture, then inspect local D1 `meta.rows_read`, `meta.rows_written` and
database growth under a bounded representative workload. Evaluate both expected
traffic and configured admission caps. Enforce loss-tolerant admission rather
than allowing storage pressure to impair sources.

## Account verification result

Read-only `cf` checks used the BayLeaf account and `ucsc` profile. Identity/account
selection succeeded. `accounts subscriptions get` returned zone subscriptions,
which do not establish Workers plan status. `billing usage get-v1` returned
HTTP 403 authentication/permission error. No permissions were broadened.

Workers plan, shared current consumption, actual remaining allowances and marginal
cost therefore remain unverified. Verify through an authorized billing surface
before production provisioning; do not infer a paid or free Workers plan from
zone plans or from this local proof.
