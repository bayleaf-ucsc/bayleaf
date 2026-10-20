# Native OWUI OTLP/HTTP local proof

Local, synthetic qualification for [#112](https://github.com/bayleaf-ucsc/bayleaf/issues/112), carrying forward [#111](https://github.com/bayleaf-ucsc/bayleaf/issues/111). No production exporter, deployment, resource provisioning or credentials are needed. This is a narrow metrics receiver, not a general OTel Collector.

The separately reviewed **startup deployment artifact** is `Dockerfile` plus
`startup_patch.py`/`runtime.py`, reusing `source_policy.py`. Its synthetic artifact
qualification, source export paging, exact environment, PG overhead controls and
remaining real-container gates are in
[`../qualification/otlp-rollout.md`](../qualification/otlp-rollout.md).
It is not deployed. Local standard-image arm64 OWUI/PostgreSQL tests and amd64
emulated build/boot/inference checks pass; DO deployment verification, production
overhead and collector/storage gates remain separate.

## Interfaces

```js
import { normalizeOtlp, OtlpError } from './normalize.mjs';
const { points, duplicates } = await normalizeOtlp(requestOrBytes, {
  // Optional, trusted policy configuration, not supplied by the client:
  routes: ['/health', '/api/version', '/api/chat/completions',
    '/api/v1/chats/{id}', '/_other'],
});
```

Input is a `Request`, `Uint8Array` or `ArrayBuffer`. Request input requires POST and `application/x-protobuf`, with no compression (`Content-Encoding` absent or `identity`). Byte input is already-uncompressed protobuf. Returns a promise; errors are `OtlpError` with content-free `.code` and `.status`. It never logs input. Endpoint routing, authentication, source admission, durable receipts, expiry and read authority belong to the caller.

All normalized points have `metric`, `kind`, `unit`, `temporality`, `global`, `startTimeUnixNano`, `timeUnixNano`, and `dimensions`. Timestamps and integer counts are **decimal strings**, not unsafe JavaScript numbers. Sum/gauge points add `value`. Histogram points add `count`, `bucketCounts`, `explicitBounds`, and optional `sum`, `min`, `max`. Buckets are disjoint OTLP bucket counts, not Prometheus cumulative buckets. `dimensions` is either `{method, route, status}` or `{}` for global gauges. Output has no resource strings, scope strings, descriptions, exemplars, identities, headers or unknown fields.

```js
import { otlpHook, createOtlpHook } from './worker-adapter.mjs';
// Core's trusted hook, called AFTER source authentication and write budget:
const envelope = await otlpHook(request, { source: 'owui', now: Date.now() });
// Or a fixed deployment configuration, never untrusted request data:
const configuredHook = createOtlpHook({ instance: 'single', minimumWindowMs: 10000 });
```

The hook returns schema version 1, source `owui`, `batch_id`, `observed_at`, and `points`. Point names map as follows:

| Decoder | Core envelope |
|---|---|
| `metric` | `name` |
| `timeUnixNano` | exact `time_unix_nano` plus derived epoch-ms `observed_at` |
| `startTimeUnixNano` | exact `start_time_unix_nano` plus derived epoch-ms `start_at`, nongauges only |
| `dimensions.status` | `attributes.status_code` |
| `bucketCounts`, `explicitBounds` | `bucket_counts`, `bounds` |
| monotonic sum | `monotonic: true` |

Other values retain their semantics and names. Integer counts convert to numbers only after an exact BigInt range check against core's current 10^12 policy. Larger otherwise-valid OTLP counts reject, never round. Gauges retain the **native `users` unit**, have attributes `{}`, and never gain an instance dimension. HTTP points receive only the trusted, fixed-vocabulary instance (`single` or `worker-1`–`worker-4`). Core must preserve and validate exact ns strings alongside ms; otherwise integration is intentionally incompatible rather than silently lossy.

Receipt IDs are deterministic content-derived, UUIDv4-shaped tokens, not random visitor/worker identifiers. Only approved normalized points enter the hash. Point ordering is canonicalized. Same semantic payload yields the same envelope across retries, independent of receipt time. Envelope `observed_at` is the latest point observation, not `now`. Core is responsible for transactional durable dedup. Separate batches can overlap: deduplicate point identities in report queries too, not only envelope receipts.

HTTP series with an actual interval shorter than 10 seconds are omitted by the hook. Their starts are **not stretched or rounded** to manufacture an interval. If all points disappear, it rejects with 422; native gauge snapshots normally remain. This is an explicit startup/new-series gap, not zero traffic. A 10-second age check does **not** establish that a native cumulative snapshot is a 10-second delta or prove that first-activity timing is harmless. Policy remains revisable before collection.

## Accepted and unsupported protocol

- Actual OTLP/HTTP protobuf `ExportMetricsServiceRequest`. Only the five named native instruments, integer nonnegative counters/gauges, explicit-bound duration histograms, and delta/cumulative sums/histograms.
- Request body: 256 KiB maximum, 2-second total body-read deadline, at most 2,048 stream chunks. At most 24,000 decoded fields, 64 metric messages, 512 points and 64 bucket counts per histogram. Hook further caps accepted points at 100. No recursive generic AnyValue traversal.
- Exact route allowlist, finite method vocabulary, integer status 100–599. All three HTTP dimensions required. Gauge dimensions forbidden. Unknown fields/metrics/units/types, malformed UTF-8/wire lengths/varints, negative counts, nonfinite/negative duration statistics, nonzero flags and inconsistent histograms reject the entire batch.
- Resource attributes forbidden, including SDK metadata and arbitrary `service.name`; source must use an empty `Resource`. Scope may be absent or the exact native module name. Native descriptions, if supplied, must exactly match the tagged descriptions. They are not retained.
- No gRPC, OTLP/JSON, gzip/deflate, traces, logs, exemplars, exponential histograms, summaries, floating-point counts, metric metadata extensions, schema URLs or arbitrary resource/scope attributes. Do not advertise those capabilities.
- Duplicate point identities inside a batch collapse only if values agree; conflicting duplicates reject. Integer/ns boundaries remain exact before any storage mapping.
- After durable ingest use HTTP 200 with `Content-Type: application/x-protobuf` and an empty body (valid empty `ExportMetricsServiceResponse`). No partial acceptance response is implemented. Invalid payloads use nonretryable 4xx. The pinned exporter retries 408/5xx but **not 429**; use 503 for retryable service-budget/storage exhaustion. Do not issue redirects, echo input, or return raw parsing/database errors.

## Source minimization is mandatory

Native `metrics.py` falls back from a route template to `request.url.path`. It also exports arbitrary method strings. Views retain allowed **keys**, not safe values. Receiver rejection occurs too late to prevent disclosure to Cloudflare.

`source_policy.py` demonstrates a local-only, fail-closed patch of the tagged middleware **before SDK aggregation**. Approved templates survive; everything else becomes `/_other`. Unknown methods become `OTHER`. This keeps cardinality bounded before series creation. Dynamic IDs in approved templates are not exported. Query strings are not exported by the native path expression.

The second adapter replaces `Resource.create(...)` in tagged `setup.py` with `Resource(attributes={})`. `Resource.create` merges environment/detected resources, so emptying only its explicit attribute dict is insufficient. No resource identifiers are needed for the current single-instance service. If deployment lineage is later needed, review a separate fixed-vocabulary field rather than admitting environment/host/process strings.

These helpers are **not installed in OWUI**. The fixture executes the inspected tagged source with this minimal local patch and synthetic module/configuration inputs. A rollout needs an explicit, pinned build/startup patch and qualification of that actual artifact. Keep traces and OTel logs disabled; they can expose URLs, SQL, exceptions and identifiers. Source minimization of metrics does not sanitize those channels.

Candidate environment, **not deployed**:

```text
ENABLE_OTEL_METRICS=true
ENABLE_OTEL_TRACES=false
ENABLE_OTEL_LOGS=false
OTEL_METRICS_OTLP_SPAN_EXPORTER=http
OTEL_METRICS_EXPORTER_OTLP_ENDPOINT=https://telemetry.bayleaf.dev/v1/otlp/metrics
OTEL_METRICS_EXPORT_INTERVAL_MILLIS=60000
OTEL_EXPORTER_OTLP_METRICS_TIMEOUT=2
OTEL_METRIC_EXPORT_TIMEOUT=3000
OTEL_EXPORTER_OTLP_METRICS_COMPRESSION=none
OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer <separate-write-capability>
```

Unset both metrics-specific **and fallback** native Basic auth username/password variables. Native `_build_meter_provider` then passes `headers=[]`, and the pinned exporter falls back to its standard header environment variable: this is verified against loopback HTTP. No receiver Basic-auth exception is needed. Endpoint is explicit and used **verbatim**, so include the whole path. `OTEL_METRICS_EXPORTER_OTLP_INSECURE` configures the gRPC branch, not HTTP TLS. HTTP TLS verification must remain enabled.

The native SDK uses a background periodic reader, no telemetry work in the HTTP middleware beyond counter/histogram updates. Source caps and short exporter timeouts limit loss/failure. Nonetheless its three synchronous DB callbacks are not preempted by a reader deadline, so DB statement/pool waits and production overhead remain rollout gates. Avoid request-thread export, unbounded queues, debug telemetry payload logs and SDK internal extra metrics. Export failure must not affect Chat admission.

## Reporting semantics

1. Cumulative counters: compare only the same trusted producer slot, metric, dimensions, **exact start** and increasing timestamp. Start is first series observation, not necessarily process start. A changed start is a reset/new stream. Never interpret a negative subtraction as traffic. No baseline means unknown, not zero.
2. Delta counters/histograms: retain exact `(start,end]` boundaries; do not sum retries or overlapping intervals. Gaps remain gaps. Cumulative histogram deltas require identical bounds and nondecreasing counts/buckets. Validate differences before merging.
3. Histogram buckets count observations in disjoint intervals, with the final bucket above the last finite bound. Sum compatible buckets and counts, then derive approximate quantiles. Never average p95 values. Cumulative min/max cannot be subtracted into window min/max. Optional sum/min/max absence is not zero.
4. Account gauges are global database snapshots. Choose one authoritative/latest sample for a metric and time window, never sum worker snapshots or repeated timestamps. Flag conflicting observations, sparse data and staleness. Active means `last_active_at >= now-180s`; active-today means strictly after midnight UTC. These are not concurrent connections or active generations. Placeholders, background traffic and synthetic activity affect interpretation.
5. Native HTTP duration stops around `call_next` returning its response, not full SSE completion. Do not relabel it inference latency. Report-time aggregation is separate from the ingestion schema; no permanent per-request timeline or dashboard is required.

The safe serialized sample, normalized detail, source hashes, fixture proof and qualification report are intentionally inspectable. No real user data, unsafe export bytes, cookies, source credentials or rejected bodies are saved.
