# Bounded storage qualification, 2026-10-20

**Recommend 300-second native collection with the approved 90-day retention.**
At the 99-point source envelope, 60 seconds projects to 5.58 GB before browser,
jobs, probes or safety margin. Five minutes projects to 1.12 GB and fits native
purge capacity with much more margin. This is advice only: this qualification
changes no runtime or policy.
Workers Paid activation and 90-day approval are operator-supplied facts, not
independent account/billing verification.

## Local measurements

Run `node telemetry/qualification/storage-sizing.mjs`. It prints JSON, including
per-object `dbstat` bytes and local D1 metadata. No network calls, persisted row
datasets, commits or deployment. Miniflare outbound calls are explicitly denied.
Node v26.12.0, SQLite 3.54.0, 4,096-byte pages. Actual migrations and `ingest()` SQL,
in-memory databases, 90-day configuration, full 36-character random UUIDs,
64-character content hashes, exact nanosecond strings, six-byte epoch millisecond
timestamps, real JSON histograms, and one receipt per export. Random UUID B-tree
insertion order causes small run-to-run differences.

The safe native `fixture.pb` passes through the actual `otlpHook`: 11 accepted
points (four counters, four histograms, three global gauges). The synthetic
99-point envelope expands those normalized templates to 48 approved dimension
combinations for each HTTP metric and the three global gauges, then passes core
validation. Thus **11 is observed fixture shape; 99 is synthetic cardinality,
not a newly captured native export**. Later samples advance observation times
while preserving cumulative reset metadata. This is a fixture-shape estimate,
not a worst case for every permitted numeric value or histogram representation.

| Shape | Rows | Allocated SQLite bytes | Incremental bytes/row |
|---|---:|---:|---:|
| Native fixture, 11/export | 19,998 | 7,999,488 | 394.07 |
| Native fixture, 11/export | 49,995 | 19,943,424 | 396.53 |
| Native fixture, 11/export | 99,990 | 39,931,904 | 398.17 |
| Synthetic envelope, 99/export | 19,998 | 8,765,440 | 432.38 |
| Synthetic envelope, 99/export | 49,995 | 21,753,856 | 432.74 |
| Synthetic envelope, 99/export | 99,990 | 43,589,632 | 434.75 |
| Browser mixed null/ordinary hostnames | 20,000 | 1,806,336 | 84.38 |
| Browser mixed null/ordinary hostnames | 50,000 | 4,427,776 | 86.18 |
| Browser mixed null/ordinary hostnames | 100,000 | 8,855,552 | 87.37 |
| Browser maximum-length, 253-byte hostname | 20,000 | 7,147,520 | 351.44 |

Incremental bytes subtract the empty migrated database, 118,784 bytes. Metric
figures include all three metric indexes (including the unique autoindex),
receipt table and both receipt indexes, and the bounded source-status/retention
state. Browser figures include both browser indexes and retention state.
Ingress budgets are excluded from the large sizing runs: their population is
short-lived minute buckets, not proportional to 90-day retained observations.
Actual budget SQL is included in the independent D1 write sample below.

Deleting the oldest half and inserting the same number of newer metric batches
raised equal-row allocation to 40,165,376 bytes (11/export) and 43,839,488 bytes
(99/export): approximately 0.6% above the initial population. Freed pages were
reused. This is **one bounded churn test**, not evidence that long-lived index
fragmentation stays below 0.6%. Page allocation does not shrink merely because
rows expire. Multi-million-row rowid widths, random-ID index fill, numeric growth,
larger bucket counts, larger histograms, and purge backlog can all increase size.
Use at least 25% planning headroom and monitor actual D1 size; this is not a
guaranteed upper bound. Time Travel and account storage billing are not measured
by local SQLite page counts.

## Linear 90-day projections, decimal GB

These extrapolate the 99,990-row slopes, including per-batch receipts. They are
**estimates**, not a retained 90-day benchmark, and exclude other classes.

| Points/export | Interval | Retained metric rows | GB | With 25% headroom |
|---|---:|---:|---:|---:|
| 11, smaller fixture | 60 s | 1,425,600 | 0.568 | 0.710 |
| 11, smaller fixture | 300 s | 285,120 | 0.114 | 0.142 |
| 99, cardinality envelope | 60 s | 12,830,400 | 5.578 | 6.973 |
| 99, cardinality envelope | 300 s | 2,566,080 | 1.116 | 1.395 |

Paid D1's **10 GB per-database hard maximum** is separate from the **5 GB
included account-wide storage allowance**. Paying storage overage does not raise
the per-database limit. At browser's sustained 120/minute admission cap, 90 days
adds 15,552,000 rows: approximately **1.36 GB** for the mixed-hostname shape or
**5.47 GB** for maximum-length hostnames. These are saturation bounds, not campus
traffic forecasts. Native 99/60 s plus long-hostname browser saturation already
exceeds 10 GB (11.04 GB), before headroom or other classes. Native 99/300 s plus
that browser bound is 6.58 GB (8.23 GB with 25% headroom). A more realistic
1,000 browser arrivals/day adds only about 7.9 MB over 90 days at the mixed slope.
Admission caps are not guarantees of storage sufficiency.

### Purge throughput is a separate gate

Current limit is 500 expired rows/table/run. The concurrently prepared
`wrangler.production.jsonc` now specifies a **one-minute** cron: nominally
**720,000 rows/table/day**, assuming every run succeeds and finds its full quota.
Native 99/60 s produces 142,560 rows/day; 99/300 s produces 28,512/day;
11/60 s produces 15,840/day. Browser cap saturation produces 172,800/day. Each
fits the new nominal per-table throughput; cron CPU limits and actual successful
purge duration remain deployment checks, not established by this sizing run.

The older 15-minute schedule supports only 48,000 rows/table/day. It cannot
sustain 99/60 s or browser saturation. Do not accidentally deploy that schedule:
a backlog breaks the physical-deletion assumption and makes storage grow beyond
these projections even though expired rows are hidden from reads. No purge
configuration was changed by this qualification.

## Index write amplification and local D1 metadata

Each new metric creates one table row plus **three index entries**; each receipt
creates one table row plus **two index entries**. Browser creates one row plus
**two index entries**. The receipt and metric uniqueness constraints are real
indexes, not free metadata. Retention, source status and budget mutations add
further writes, including on duplicate/rejected attempts where applicable.

Independent Miniflare/workerd D1 sample, actual store/budget SQL, no remote D1:

| Operation | D1 rows_read | D1 rows_written |
|---|---:|---:|
| First 11-point export, both minute budgets | 42 | 58 |
| Subsequent new-minute 99-point export, both budgets | 308 | 408 |
| First browser admission, minute budget | 3 | 8 |
| Bounded expiry delete: 110 metrics | 440 | 110 |
| Bounded expiry delete: 2 receipts | 8 | 2 |
| Bounded expiry delete: 1 browser row | 4 | 1 |

The local engine reports only one written row per deleted base row, despite
index removal. **Do not silently equate physical index entry operations with
the local `rows_written` counter.** No production billing test was performed.
Budget for both interpretations rather than using the lower local deletion
count as a promise. Recurring native admission is approximately `4*n + 12`
local writes/export, plus expiry of points, receipt and two minute-budget rows.
Steady-state planning range is `5*n + 15` (local deletion accounting) through
`8*n + 21` (conservative index-entry deletion accounting). The upper bound
assumes both budget rows are unique to that export's minute. Small cron/state
overhead, reads, retries/rejections, jobs and probes are additional.

## Monthly marginal cost under the existing Paid base

Use the pricing already checked in `qualification/storage.md` on 2026-10-20:
50 million included writes/month, 25 billion reads/month, 5 GB storage included;
overage $1/million writes, $0.001/million reads and $0.75/GB-month. No new remote
pricing/account calls were made for this qualification. No additional base-plan
subscription is attributed to telemetry. **Remaining shared allowances and total
account consumption are unknown.**

| Native shape | Steady-state writes/month, lower–conservative | Write cost if all marginal writes are over allowance |
|---|---:|---:|
| 11/60 s | 3.02–4.71 million | $3.02–4.71 |
| 11/300 s | 0.60–0.94 million | $0.60–0.94 |
| 99/60 s | 22.03–35.12 million | $22.03–35.12 |
| 99/300 s | 4.41–7.02 million | $4.41–7.02 |

At 99/300 s, native steady-state storage costs up to about **$0.84/month** if
every byte is over the shared allowance, or about $1.05 with planning headroom.
At 99/60 s, native's 5.58 GB costs $0.43/month beyond an otherwise unused 5 GB
allowance, or $4.18/month if the allowance is already exhausted. These costs do
not make an overloaded purge or database safe.

Browser saturation adds 5.184 million arrivals/month. A deliberately conservative
10-write budget/arrival (including expiry and budget cleanup) is **51.84 million
writes/month**, potentially $51.84 of marginal writes, plus up to $4.10/month
for its 5.47 GB storage if all storage is over allowance. Actual recurrent
admission costs less than the first-admission sample because the minute budget
and retention rows already exist. This conservative envelope is not an observed
monthly bill. At 1,000 arrivals/day, the same envelope is only 0.30 million writes.

For an actual marginal bill use the difference in account totals, for example
`$1 * (max(0, existingWrites + addedWrites - 50m) - max(0, existingWrites - 50m)) / 1m`,
and the analogous storage/read calculation. New database storage ramps up during
the first 90 days; the table uses steady-state occupancy and a 30-day month.
Workers request/CPU overage, retry traffic, private reads and other telemetry
sources remain extra. The one-minute purge cron adds 43,200 scheduled executions
per 30 days, plus its SQL state maintenance. Their account-level total cannot be
inferred here.
No claim that the marginal bill is $0 is supported without account consumption.

**Decision:** 300 seconds is the bounded, storage-conscious native default for
90 days, with real cardinality and allocated-size monitoring. Browser traffic
must also be monitored, and the new one-minute purge schedule must be retained
and operationally qualified. No source, retention or purge changes are made by
this qualification.
