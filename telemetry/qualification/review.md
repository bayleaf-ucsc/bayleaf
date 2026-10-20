# Independent read-only review, 2026-10-20

Scope: assembled core, migration, tests, OTLP decoder/bridge and source adapters.
No implementation edits, remote writes, deployment or commits. This review does
not authorize production collection. Findings below are reproducible locally.

## Findings, highest priority first

### P1: receiver can store an IP despite the hostname-only policy

`src/validate.js:31–40` checks IPv4 before removing a trailing dot and accepts
alternative numeric address forms. The actual `createWorker` browser route
returned **202** for `referring_hostname: "192.0.2.123."`; SQLite stored
`192.0.2.123`. Direct validation also accepts `127.1` and
`0x7f.0x0.0x0.0x1`. The source browser adapter correctly normalizes URLs and
rejects these, but browser ingress is untrusted and cannot rely on that adapter.

Fix: normalize the hostname first, reject canonical and URL-recognized IPv4/IPv6
representations, then apply DNS policy. Add actual ingress tests for trailing-dot,
short, octal and hexadecimal IPv4 spellings. This violates an explicit data
exclusion, not merely the documented inability to authenticate browser arrivals.

### P1: increased retention permits resurrection of already-expired runs

`src/validate.js:90–101`, `src/store.js:35–38,96–107` recompute expiry from the
*current* TTL, while purge deletes the only receipt of earlier acceptance.
Reproduction with real SQLite and the normal validator/store:

1. Accept a deletion run observed at T under `RETENTION_DAYS=1`.
2. At T + 2 days, purge under the same configuration: rows and receipts are gone.
3. Change to `RETENTION_DAYS=7` and replay the identical UUID/payload.
4. Ingest returns `{duplicate:false}`; the deleted observation is visible again,
   now expiring at T + 7 days.

This is retrospective recollection, not simply a prospective TTL extension.
Documenting that existing row expiry is never updated does not prevent it.
Fix: make retention transitions prospective with a durable, content-free admission
watermark/policy epoch that rejects observations retired by previous policy, and
test both replay after physical purge and shorten-then-increase visibility before
purge. Alternatively prohibit increases until a reviewed migration establishes
that boundary. Do not solve this by retaining identifying receipts forever.

### P2: write/read secret collision fails closed only on writes

`src/worker.js:19–27` rejects write/read token reuse, but the read route at
`src/worker.js:66–78` does not run that configuration check. With
`WRITE_KEYS_JSON={"chat-retention":S}` and `READ_SECRET=S`, GET using the source
token returned **200 and stored deletion rows**. This requires configuration
error, not token forgery; current documentation explicitly describes only the
write-side rejection. Nevertheless the advertised authority separation should
fail closed for private reads too.

Fix: validate the credential map and distinct read capability before either
privileged route; return a content-free configuration failure on collision.
Add a read-route test using a deliberately colliding source token.

### P2: internal JSON accepts impossible empty histograms

`src/validate.js:76–86` accepts `count:0`, `bucket_counts:[0,0,0]`,
`bounds:[100,500]`, `sum:600`, `min:10`, `max:400`. This was reproduced through
`validate('metrics', ...)`. `otlp/normalize.mjs:128–129` correctly rejects the
same empty-distribution statistics, so `/v1/metrics` bypasses that invariant.

Fix: share the empty-histogram invariants across both ingress protocols: zero
count requires absent min/max and absent or zero sum. Add adversarial normalized
JSON tests. This is a measurement-integrity issue, not a privacy leak.

## What is sound

- Explicit policy allowlists and typed storage avoid a universal log envelope;
  source-side projections exclude raw reports before transport.
- Receipt insertion, guarded points/run insertion and status update are one D1
  transaction. The workerd test proves concurrent identical retries create one
  batch and conflicting retries produce 202/409 without mixed content.
- Rate-budget UPSERT increments are atomic and weighted. Rollover and expiry
  unit tests pass. No race was found by inspection. A separate ad hoc 200-request
  Miniflare budget harness timed out, so it provides no additional concurrency
  qualification evidence.
- Actual Worker OTLP routing, empty protobuf success, exact nanosecond storage,
  cumulative histogram temporality and dimensionless global gauges pass the
  workerd/D1 test. No summing or reset inference is implemented in storage.
- Read routes require explicit bounded windows/limits, reject repeated/unknown
  query fields, exclude expiry before purge and have no read CORS or SQL input.
- JSON and protobuf byte budgets exist; compression is rejected rather than
  decompressed without a budget. OTLP additionally bounds fields/chunks/points
  and tests stalled input. JSON's chunk-array count is not independently capped:
  adding the OTLP-style chunk cap is useful memory hardening, not an established
  network-reachable exploit from this review.
- Content-free error responses, disabled default configuration, separate source
  senders, redirect refusal and bounded delivery are consistent with the design.

## Test evidence and limits

Final rerun: **45/45 Node tests and 8/8 Python tests passed** via `npm test` and
`npm run test:python`. Earlier adapter failures disappeared after its announced
auth work landed; they are not final findings. Service bearer transport now has
local end-to-end collector tests, including Python's default httpx path.

The seven-day local TTL, unverified billing, absent production source hooks,
dense timestamp pagination limits and D1 recovery-history caveat are deliberate
gates, not implementation bugs. Qualification prose in `sources.md` was still
being updated during review; reconcile test counts/auth descriptions with the
final tree rather than treating those transient statements as final evidence.

## Targeted resolution re-review, 2026-10-20

Reviewed `REVIEW-RESOLUTION.md`, changed core and migration
`0002_retention_state.sql`. Ran
`node --test test/review.test.js test/workerd.test.js`: **7/7 passed**, including
the shared retention scenarios on real SQLite and actual workerd/D1. Parent owns
the final full-suite run. No implementation edits or production actions.

### Closed

- **Disguised-IP exclusion:** fixed in `src/validate.js:31–45`; actual ingress
  regressions reject trailing-dot, short, octal, hex and IPv6 representations and
  leave no browser rows. Ordinary trailing-dot DNS normalization still works.
- **Credential collision:** fixed by shared credential validation before private
  reads and service writes (`src/worker.js:19–28,72–74,103–107`). Regression
  requests return content-free 503 for collisions/malformed maps.
- **Impossible empty histograms:** fixed in `src/validate.js:89`; actual JSON
  ingestion rejects nonzero sum or any min/max with count zero, while accepting
  absent/zero sum. The optional JSON chunk cap is also implemented and tested.

### Retention: original transition race fixed, one concrete blocker remains

The durable per-class minimum TTL and maximum cutoff UPSERTs execute in the same
transaction as admission/read/purge (`src/store.js:11–18,39,90–95,99–126`). Stale
configurations cannot increase the ceiling or decrease the cutoff. The tests
cover first-shortening races, replay after purge with changed UUIDs, clock
rollback, fresh-event effective expiry and an older point in a newer envelope.
These resolve the originally reproduced configuration-increase resurrection.

**P1 remaining: a newer point in an older envelope can still resurrect after its
stored expiry.** `src/validate.js:113–115` allows this ordering;
`src/store.js:66–69` gives the point the earlier envelope expiry, but the durable
cutoff retires only observation timestamps (`src/store.js:14,37–38,119–120`).
Independent reproduction with real SQLite, normal validation and constant
`RETENTION_DAYS=7`:

1. At T + 1 day, accept envelope observed at T containing a gauge observed at
   T + 1 day. Stored point expiry is T + 7 days, not T + 8 days.
2. Purge at T + 7 days: the metric point and receipt are deleted; cutoff is T.
3. Replay the identical gauge with a fresh UUID and envelope observed at
   T + 1 day. Admission returns `{duplicate:false}`, stores expiry T + 8 days,
   and private reads return the previously expired point again.

Fix: reject an envelope whose timestamp predates any contained point, consistent
with the OTLP bridge's existing maximum-point envelope timestamp. Add this
reverse-order regression to the shared SQLite/D1 scenarios. This is within the
prior expiry/replay finding, not a request for broader collection changes.

### Read-purity implications

Private GET is now intentionally a **database write** to bounded, content-free
policy metadata, including reads returning no observations. It can initialize or
irreversibly lower a class ceiling and advance its cutoff; a status read touches
all four class rows. It does not mutate observation payloads or let query
parameters choose a TTL/cutoff. This is consistent with the documented transition
model (`README.md:205–228`), but readers must not assume read-only D1 execution
or zero write billing. No separate security blocker was found in this tradeoff.

## Parent integration resolution

The remaining reverse-order envelope finding was fixed after the re-review:
`validate('metrics', ...)` now rejects any point observed after its envelope.
The shared SQLite/workerd retention scenario includes the reproduced ordering.
The parent ran the final complete suite: **52 Node tests and 8 Python tests
passed**. This final small fix was parent-verified, not a third independent
review. No production actions followed.
