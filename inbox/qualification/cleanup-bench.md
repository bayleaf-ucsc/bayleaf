# Physical-cleanup qualification, 2026-10-21

Historical baseline measurements. See [local hardening](hardening.md) for the
implemented set-based/fairness fix and new budget results. The harness now tests
current source, enables synthetic telemetry and enforces budget assertions; the
tables below preserve the original unmodified-Worker evidence.

**Local throughput evidence, not a production deletion SLA.** Unmodified Worker
at main `12fe757`, tooling/host as in [MIME qualification](mime-bench.md).
No production access. Reproduce from `inbox/`:

```sh
node qualification/cleanup-bench.mjs --json /path/to/private-results.json
```

The real `scheduled()` implementation runs in workerd, via a test HTTP wrapper
that counts actual D1 calls/statements and R2 operations without replacing storage.
Fixtures seed consistent rows, counters and three-byte objects directly, bypassing
receipt rate/quota limits. Seed counts and final reservation counters are asserted.
Every sweep completed without error. This isolates object/row count, not the
production cost of deleting hundreds of MiB or remote replication.

The wrapper enforces **100 parameters per statement**, which local SQLite does
not enforce itself. Largest removal batch: 100 statements, 50 bound parameters
in any one statement. Seed batches contain up to 200 statements, well over 100
parameters in aggregate, without violating the per-statement rule. There is no
single 101-parameter cleanup query. This distinction is important.

## Results

Wall time covers only the sweep call and response, excluding seeding and separate
post-run count/list checks. CPU and per-isolate memory are not available here;
local SQLite/disk wall time must not be relabeled CPU. All numbers are a single
run of each seeded scenario, not percentiles. Prefixes remain intentionally.

| Scenario | Initial rows / R2 objects / prefixes | Invocations | Max rows removed/run | Max objects removed/run | Peak D1 calls / SQL statements | Peak R2 operations | Peak wall ms |
|---|---|---:|---:|---:|---|---:|---:|
| Expiry, 1k | 1,000 / 1,000 / 0 | 5 | 200 | 200 | 21 / 422 | 4 | 43 |
| Expiry, 10k | 10,000 / 10,000 / 0 | 50 | 200 | 200 | 21 / 422 | 4 | 60 |
| 500 stale pending + 500 deleting | 1,000 / 1,000 / 0 | 3 | 400 | 400 | 40 / 841 | 12 | 60 |
| 10 destroying inboxes × 1,000 rows | 10,000 / 10,000 / 10 | 5 | 2,000 | 2,000 | 196 / 4,687 | 60 | 314 |
| 60 destroying inboxes × 250 rows | 15,000 / 15,000 / 60 | 4 | 10,000 | 10,000 | 956 / 23,407 | 250 | 1,331 |
| Mixed backlog, below | 15,900 / 16,000 / 1,060 | 22 | 10,600 | 10,600 | **1,001 / 24,652** | 262 | 1,660 |
| 1k prefixes, 100 scattered orphans | 0 / 100 / 1,000 | 20 | 0 | 5 | 61 / 62 | 55 | 37 |
| 10k prefixes, 100 scattered orphans | 0 / 100 / 10,000 | 6 sampled | 0 | 1 | 57 / 58 | 51 | 23 |
| One prefix, 5k orphans | 0 / 5,000 / 1 | 6 sampled | 0 | 50 | 8 / 58 | 2 | 18 |

Mixed backlog: 300 expired, 300 stale pending, 300 deleting, 60 destroying inboxes
with 250 rows each, plus 1,000 older cleanup prefixes (every tenth has an orphan).
For the last two sampled scenarios, 97 and 4,700 objects respectively remain:
these are deliberately truncated runs, **not completed cleanup**.

## Throughput at the configured 15-minute cadence

- Ordinary expiry is **200 messages/run globally**, or **19,200/day**. 1k takes
  five invocations, 10k takes fifty. From an arbitrary arrival of due work, that
  is up to 75 minutes / 12.5 hours respectively, excluding failures/backlog.
- Destruction is up to **200 rows per selected inbox per run**, at most 50 inboxes.
  Ten inboxes × 1k clear in five invocations once quiescence has elapsed. The
  explicit destroy RPC can remove another 50 inline; this benchmark starts from
  destroying state and does not claim to measure that RPC.
- At this historical default, an owner could have **50,000 tiny messages** across ten inboxes.
  Explicit destruction needs at most 25 successful row-cleanup invocations for
  each of those inboxes if selected every time (6.25 hours worst alignment), plus
  quiescence, orphan reconciliation, competing backlog and failures. Owner-wide
  ordinary expiry alone needs 250 runs, up to 62.5 hours.
- One owner's maximum receipts are **10,000/day**, below the ordinary expiry
  capacity of 19,200/day, assuming continuous successful sweeps and exclusive use
  of cleanup capacity. Two owners can create **20,000/day due bursts**, above it,
  but cannot sustain that indefinitely: the 50k-message owner cap and 90-day
  retention also matter. With no early deletion, a full owner averages at most
  about **556 expiries/day** over a retention cycle. A campus population of 35–36
  fully occupied owners can exceed 19,200/day in aggregate with staggered receipt
  cohorts. Thus **one fixed owner cannot sustainably outrun expiry by quota alone,
  but campus-wide traffic can**. Simultaneous expiry still creates finite backlog.
  Owner-driven create/destroy churn and outage recovery need separate bounds.
- Reconciliation visits only **50 prefixes/run**, one page of 50 objects per
  prefix. A single 5k-orphan prefix needs 100 visits (up to 25 hours with no
  competing prefixes). 1k prefixes require 20 runs per rotation (5 hours);
  10k require 200 runs (50 hours). Empty prefixes consume visits forever.
  With N stable prefixes, one prefix's 100-page drain can take roughly
  `100 × ceil(N/50)` invocations. There is no constant global physical-deletion
  deadline. Continuing prefix creation can increase that delay.

## Limit risks, not a production pass

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
currently say Paid defaults to **10,000 subrequests**, 128 MB memory and, for this
15-minute cron, **30 s CPU / 15 min wall time**.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) separately list
**1,000 queries/invocation** and a 30-second request/batch duration. Both pages
were checked 2026-10-21. Miniflare does not enforce those production budgets.

The mixed run makes **1,001 D1 binding calls**, even counting each `DB.batch()` as
one call, before R2's 262 operations. It therefore exceeds D1's published 1,000
budget on even that permissive interpretation. If D1 counts individual statements,
the 4,687-statement ten-inbox destruction case also exceeds it. Workers' newer
10k general subrequest default does not resolve the discrepancy in D1's published
limit; verify actual plan/runtime accounting before asserting a safe envelope.
Telemetry is disabled in this benchmark; enabling counts/export adds calls and
cannot improve the margin. No remote limit experiment was attempted.

**Concrete design bug:** bounds are per stage and per inbox, not a shared
invocation budget. They compose to an invocation larger than a documented service
limit. Failure near the end can repeatedly postpone reconciliation. This is not
fixed here: a safe change needs a global budget with reserved reconciliation and
telemetry headroom, persisted fair continuation, and tests of partial failure.
Reducing per-message SQL churn (currently two statements per removed row) is also
worth testing. Simply enlarging batch sizes risks both parameter limits and
provider request duration. The existing round-robin prefix pattern is sound for
fairness at a fixed backlog, but indefinite metadata accumulation makes its
latency an operational cost, not just a disclosure footnote.

Campus rollout should remain blocked until cleanup capacity/budgets are revised
or explicitly accepted with a service population cap and honest physical-cleanup
delays. Logical expiry already hides content immediately; that is not physical
deletion, and it does not release quota until the removal path completes.
