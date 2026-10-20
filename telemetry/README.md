# BayLeaf telemetry: local Worker / D1 proof of concept

For [issue #112](https://github.com/bayleaf-ucsc/bayleaf/issues/112).
**Not deployed, provisioned or enabled.** This is a bounded first-party
warehouse, not a dashboard, public query service or general event/log collector.
On 2026-10-20 the operator explicitly approved deployment and live collection of
all four classes with **90-day** retention: browser arrivals, native OWUI aggregate
metrics, deletion-job runs and existing synthetic probe-run summaries. Approval
is not evidence of deployment or source activation. No per-request Sealed
inference metadata is authorized. `otlp/`, `adapters/` and `qualification/`
document their separate source and protocol qualifications.

## Local checks

Run `npm test` here with Node 22.13+ (`node:sqlite`). Tests use real in-memory
SQLite and actual local workerd/D1, with synthetic data and outbound requests
blocked. Dev-tool dependencies are pinned in `package.json`; tests can reuse the
already installed `../api/node_modules` tools. No installation, account access,
provider call or real credential is needed in the checked-out development setup.
`npm test` also includes OTLP, source adapter and cross-contract Node tests;
`npm run test:python` runs the typed Python Chat-retention adapter checks.

`npm run migrate:local` and `npm run dev` are **local-only** Wrangler commands.
The database UUID is deliberately all zeroes. There is no deploy script, live
route, custom domain, account ID or production secret in this configuration.
Do not replace the placeholder or run remote commands without approval.

## Data flow and ownership

`src/worker.js` exports default Worker handlers and
`createWorker({ otlp, clock } = {})`, allowing a trusted protocol decoder and
deterministic test clock. The default uses `otlpHook` from
`otlp/worker-adapter.mjs`; a factory without a hook has no OTLP route.
The hook signature is `otlp(request, { source, now })`: return the normalized
metric envelope below. Authentication and budgets run before the decoder;
core policy validation runs after it. `src/validate.js` exports
`validate(class, input, env, now)`, `Invalid` and canonical JSON serialization.
`src/store.js` exports `ingest`, `readRows`, `takeBudget`, `purge` and `TABLES`.
Storage signature: `ingest(db, class, validatedData, now, env = {})`. Pass the
same retention configuration used for validation; storage also enforces durable
policy independently of that caller-side validation.

Physical tables: `browser_observations`, `metric_points`, `deletion_runs`,
`probe_runs`, `source_status`, plus retry `receipts` and fixed minute
`ingress_budgets`, and four content-free durable `retention_state` rows. Common typed columns carry schema/policy versions, observed,
received and expiry times. Approved nested measurements are validated JSON,
not arbitrary payload blobs. Browser referring hostnames are normalized lowercase;
IP literals (including URL-recognized short/octal/hex/trailing-dot forms), URLs,
paths, query/fragment and local hostname suffixes are rejected.
Unknown referrer is `null`, not a claim of direct arrival.

`src/policies.js` owns policy version 2, schema version 1, names/dimensions,
allowlists and safety bounds. Policy is deliberately **not baked into SQL**:
reviewed scope can change without rebuilding storage. Unknown fields and
arbitrary string dimensions fail closed. There is no raw request archive.

## Write contract

All ingestion is off unless `TELEMETRY_ENABLED="true"`.
Browser additionally requires `BROWSER_ENABLED="true"`.

| POST route | Input / authority |
| --- | --- |
| `/v1/browser` | JSON below; approved exact Origin and matching destination |
| `/v1/deletions` | Aggregate job-run JSON; source-scoped bearer |
| `/v1/probes` | Existing synthetic-run JSON; source-scoped bearer |
| `/v1/metrics` | **Normalized internal JSON**, not OTLP; source-scoped bearer |
| `/v1/otlp/metrics` | Actual OTLP/HTTP protobuf via separate decoder; source-scoped bearer |

Normalized JSON routes return HTTP 202 `{accepted:true,duplicate:boolean}` after
durable insertion. OTLP returns HTTP 200 and an empty protobuf response after
durable insertion. Invalid input is content-free 400; protocol errors can be
408/413/415/422. Unauthorized is 401, conflicting batch reuse 409, unavailable 503.
Rate bounds return 429 for internal JSON, 503 for OTLP because the qualified
Python exporter retries 503 but not 429. Source retries must themselves be bounded.

Browser JSON is exactly:

```json
{"schema_version":1,"destination":"landing","referring_hostname":"example.org"}
```

Destinations `landing`, `sandbox`, `chat`, `api` correspond respectively to
`https://bayleaf.dev`, `https://sandbox.bayleaf.dev`, `https://chat.bayleaf.dev`,
`https://api.bayleaf.dev`. Observation time is assigned by the collector.
No caller ID, cookie, client timestamp, IP, UA, pathname, query or fragment is
stored. Origin is a browser gate, **not authentication or bot protection**.
Server ingress cannot prove whether a forged observation describes a public
arrival. Only approved source code may instrument public entry pages, never
private chat/dashboard routes. The source must strip referrer path/query/fragment
before sending. The transport/platform necessarily sees more than the stored
schema; production logging review remains required.

Service envelopes share:

```js
{
  schema_version: 1, source: 'chat-retention',
  batch_id: '<fresh job-run UUIDv4, stable on retry>', observed_at: 1790000000000,
  // deletion:
  job: 'chat-retention', outcome: 'success', duration_ms: 500, deleted: 3,
  extensions: { mode: 'delete', counts: { chats_deleted: 3 } }
}
```

Times are UTC epoch milliseconds, durations milliseconds. Service outcomes are
`success|partial|failure|skipped`. Sources are `owui`, `chat-retention`,
`api-retention`, `sandbox-reaper`, `probe`, each restricted to its signal class
and job allowlist. Explicit extension vocabularies include run start/end,
job modes, per-source aggregate counters and retention configuration. See
`src/policies.js` and adapters for exact allowed counters, jobs and probe codes.
Unknown counters and exception text are rejected, not retained for later review.

Probes require `layer`, `outcome`, `duration_ms`, `phases_ms`, `events_ms`,
`extensions`. Layers include `catalog`. Additive phase totals cannot exceed
duration (1ms rounding tolerance); event offsets are separate and each bounded
by duration. No new probes/inference are triggered. UptimeRobot still owns
availability history/public status/alerts. Cleanup and browser-close outcomes,
fixed result codes, failed phases and accounted/unaccounted durations are
preserved when supplied. Run bounds are independent of monotonic probe duration.

Metrics envelopes have `points` (1–100). A point has metric `name`, `kind`,
`unit`, `observed_at`, `attributes` and the following kind-specific fields:

- Gauge: integer `value`. Native user gauges use unit `users`. These are global
  database-derived readings, not per-worker increments or concurrent generators.
- Monotonic sum: integer `value`, `monotonic:true`, `temporality:delta|cumulative`,
  `start_at`. HTTP request count uses unit `1`.
- Histogram: integer `count`, optional numeric `sum`, optional `min`/`max`,
  increasing finite explicit `bounds`, disjoint `bucket_counts` including final
  overflow bucket, `temporality`, `start_at`. Bucket counts must sum to count.
  Zero count requires absent min/max and absent or zero sum, on both protocols.
  Native HTTP duration is in `ms`, not completed-SSE latency.

Optional `time_unix_nano` and nongauge `start_time_unix_nano` are exact decimal
strings whose floored milliseconds must match the corresponding typed times.
They preserve reset identity and retry semantics without lossy Number conversion.
Reset starts may predate warehouse retention. HTTP aggregate windows must be
at least ten seconds, including new cumulative series; source adapters omit
startup points rather than inventing windows. Metric dimensions are only fixed
method, sanitized route, status and finite instance slots. No raw matched or
unmatched private routes, exemplars, resource IDs or arbitrary labels survive.

Retries are deduplicated by `(source,class,batch_id)` and SHA-256 of canonical
validated content. Same ID with changed content is 409. Receipt, points/run and
status update share a D1 transaction. Concurrent identical retries produce one
batch; conflicting concurrent retries cannot mix points. Receipt expiry is
anchored to observation time and never renewed on retry. Browser submissions
have no dedup identifier and count attempts/observations, not unique people.

## Auth and operating bounds

Local environment bindings are `TELEMETRY_DB`, `WRITE_KEYS_JSON` and
`READ_SECRET`. `WRITE_KEYS_JSON` is a secret JSON mapping each approved source
to a distinct bearer token of at least 24 characters. `READ_SECRET` must be
different. Malformed maps, duplicate write secrets or write/read reuse fail
closed for **both writes and private reads**, with content-free HTTP 503
`configuration`. All configured token strings must have at least 24 characters
and no whitespace; source names must be approved.
No shared admin JWT, upstream credential or control-plane token belongs here.
Use OWUI exporter header override for a dedicated bearer, not its Chat admin
credentials; see OTLP qualification for native Basic-auth variable caveats.

Internal JSON is limited to 64KiB and 2048 chunks, with a two-second body-read deadline and no
compression. OTLP has separate bounded decoding/compression rules. Browser has
a global 120-attempt/minute D1 budget, service sources 60 batches/minute, OWUI
additionally 120 points/minute. Counters contain only fixed source/class/minute,
never an identity. Invalid attempts and retries consume budgets. These are
storage admission caps, not a protection against edge requests or D1 billing
abuse: rejected browser traffic still consumes Worker and budget-query work.
Production needs platform/account abuse controls and actual allowance review.

## Private reads and investigation

`GET /v1/read/{browser|metrics|deletions|probes|status}` requires the separate
read bearer and explicit `from`, `to`, `limit` decimal integers. Time is
`[from,to)`, maximum window seven days, maximum 500 rows, deterministic oldest
first. Unknown/repeated parameters and future-ended windows are rejected.
No arbitrary SQL, public aggregate endpoint, cookies, read CORS or shared cache.
An authenticated read advances content-free retention policy state atomically
with its query; it does not insert observations or manufacture source status.
Response includes `as_of`, schema/policy versions and conservative `truncated`
(true when row limit is reached). Split time windows for fuller investigation;
this is not an exhaustive export/pagination protocol for dense same-ms points.

Aggregate at report time from preserved measurements. Do not sum cumulative
counters/histograms across readings: use same-series start metadata to detect
resets and compute valid deltas. Do not sum duplicate global gauges across
instances. Distinct export batches can overlap: deduplicate exact metric points
by source, metric, kind, unit, attributes, exact observation/reset timestamps
and values before deriving totals. Batch receipts alone do not deduplicate those
overlapping exports; conflicting values for one point identity require explicit
investigation, not arbitrary summation. Do not add event offsets to phase durations. Missing/stale status,
unknown referrers and omitted counts remain unknown, never zero. Source status
means latest *accepted observation*, not proof of source liveness or successful
telemetry delivery. No fresh status row is manufactured by retries.

## Retention and rollout gates

`RETENTION_DAYS=7` remains a conservative **local placeholder**. Approved
production retention is **90 days for each of the four classes**; production
configuration must set this before first database use. Per-class overrides are
`BROWSER_RETENTION_DAYS`, `METRICS_RETENTION_DAYS`, `DELETIONS_RETENTION_DAYS`,
`PROBES_RETENTION_DAYS` (integer 1–90). Expiry is anchored to observed time,
including the bounded 60-second source clock-skew allowance; receipt time does
not re-anchor it. Metric points cannot inherit a newer envelope's expiry.
An envelope cannot predate any contained point: early envelope expiry must not
permit later recollection of that point in a newer envelope.

Migration `0002_retention_state.sql` adds **one durable row per signal class**,
not per-event tombstones. First database use establishes that class's TTL.
Subsequent admission, reads and purge can only lower its `ttl_ms`; increasing
environment configuration is clamped to this recorded ceiling for existing
**and new** observations. An actual TTL increase requires a separately reviewed
explicit policy migration. Ninety days cannot be enabled merely by changing
the variable after a database first recorded seven days.

Each row also has a monotonically increasing `cutoff_ms`: the maximum retired
observation boundary ever seen, including `operation_time - effective_ttl`.
It survives every purge and cannot move backwards with a stale concurrent
configuration or clock rollback. Admission rejects an entire metric batch if
**any point or its envelope** is at/before that floor. Receipt retries are checked
against the same floor even before physical deletion. Read visibility and
bounded purge use it too, including receipts and source status. Thus shortening
then increasing before purge cannot restore visibility, and replay after purge
cannot recollect retired observations, even with a fresh batch UUID. Original
stored expiry remains an additional independent upper bound.

Policy UPSERT plus operation execute in one D1 batch transaction, so concurrent
old configurations cannot override a shortening. A read or ingestion of that
class, status read, or scheduled purge observes configuration changes; an env
change never presented to the database is not a recorded policy transition.
The four class rows are the only intentionally nonexpiring policy metadata.
For a disposable database created before migration 0002, start fresh or seed
reviewed historical ceilings/cutoffs explicitly: absent erased history cannot
be reconstructed by this migration. No production database exists for this PoC.

Scheduled purge runs each minute, deleting at most 500 rows per table per run,
including expired receipts/status/budgets. This exceeds each table's configured
admission rate while the scheduler runs; outages can still accumulate backlog.
Expired rows are excluded from private reads immediately at expiry even before
physical purge. Purge backlog and scheduler outages can delay physical removal.
On Cloudflare D1's paid plan, Time Travel recovery can retain deleted rows for up
to **30 additional days after physical deletion**. Thus 90 days is the live-row
maximum, not a promise of provider erasure at day 90; purge delay also counts.
See [Cloudflare's recovery documentation](https://developers.cloudflare.com/d1/reference/time-travel/).
Restores must reapply the effective retention ceiling/cutoff and purge expired
rows before reads or collection resume; recovery must not resurrect retired data.
There is no automatic export, R2 archive or separate long-term telemetry store.
Downloaded exports, reports and derived artifacts have the **same maximum
lifecycle as their underlying observations**: delete them by the earliest
included observation's expiry (at most observation time plus 90 days, earlier
after policy shortening). Copying, aggregation or download never restarts that
clock. Set artifact expiry when creating it; do not retain indefinite copies.
The API cannot revoke files after download, so this is an operator obligation,
not an automated guarantee. Local persisted development databases need cleanup too.

Kill switch: turn collection switches off and stop source exporters. Scheduled
expiry continues against the bound database even while collection is disabled.
Rotate source secrets independently; never put read
authority on a source. Deployment and live collection have operator approval;
actual deployment/source activation and verification remain separate work.
**Publication gate:** show the exact `PRIVACY.md`, `api/RETENTION.md` and
`chat/RETENTION.md` diff and obtain publication approval before commit/push.
The privacy playbook's affected-user notice text/notification decision also needs
operator approval. Do not describe planned collection as already live. Verify
actual Cloudflare plan/shared allowance and costs, recovery settings, edge logging
and browser abuse protection before activation. There is no claim of free
operation or full erasure/ZOA guarantee. No user-request Sealed metadata is added;
only fixed summaries of the existing synthetic Sealed probe are included.

Capability exposure to Chat, OpenChamber, Nanobot and public `llms.txt` is
deliberately deferred. This PoC grants no new agent or public read authority.

### Local playbook refinement, 2026-10-20

The privacy-notice playbook was read for the approved 90-day rollout. Drafts
distinguish approval from activation and live expiry from purge/recovery/artifact
lifetimes. This scoped run makes only local policy/tests/disclosure changes;
publication and notices remain separate gates. This scoped log avoids editing
shared playbooks during parallel ownership of the issue.
