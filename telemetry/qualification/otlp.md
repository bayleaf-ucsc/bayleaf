# OWUI v0.12.3 OTLP/HTTP qualification

Status: **local compatibility/privacy proof passes; not production qualification**. Work is confined to `telemetry/otlp/` and this report. No deploy, provisioning, production calls, credentials, commits or pushes.

## Provenance and reproduction

Inspected issues using:

```sh
gh issue view 112 --repo bayleaf-ucsc/bayleaf --json title,body,comments
gh issue view 111 --repo bayleaf-ucsc/bayleaf --json title,body,comments
gh api repos/open-webui/open-webui/git/ref/tags/v0.12.3
```

Read `chat/AGENTS.md` and `chat/DESIGN.md`. Tag resolves to commit `91ea4e3421d1d8069f13d4a463fcb5986d94ea60`. Reference files under `../otlp/upstream/` are exact downloads from `https://raw.githubusercontent.com/open-webui/open-webui/v0.12.3/`: `backend/open_webui/utils/telemetry/{metrics,setup,instrumentors}.py`, `backend/open_webui/env.py`, `backend/requirements.txt`, `pyproject.toml`, and `LICENSE`. `SOURCE.json` records hashes. They are reference material, not an OWUI installation.

Exact local commands from repository root:

```sh
uv lock --script telemetry/otlp/generate_fixture.py
uv run --locked --script telemetry/otlp/generate_fixture.py
node --test telemetry/otlp/*.test.mjs
```

Environment: macOS arm64, uv 0.13.0, Python 3.13 (uv environment), Node v26.12.0. No JavaScript dependencies. Script inline pins match tagged requirements: `opentelemetry-api==1.42.1`, `opentelemetry-sdk==1.42.1`, `opentelemetry-exporter-otlp==1.42.1`, `fastapi==0.136.3`, `sqlalchemy==2.0.50`, `httpx==0.28.1`. The adjacent script lock pins transitive packages. Re-run with `--locked`; no root/shared package edits are needed. FastAPI emits a TestClient/httpx deprecation warning, not a failed test.

## What actually ran

- Tagged `metrics.py`, including native instrument definitions, callbacks, views, middleware and `_build_meter_provider`, ran against a minimal synthetic SQLAlchemy User model and temporary SQLite database. Only two fake account rows, no identities or production schema/data.
- The unmodified native middleware/exporter ran in an isolated child process with a fake unmatched path, fake method, fake resource, fake dynamic ID and fake query secret. In-memory serialized protobuf confirmed raw unmatched path, method and resource leakage. Template IDs and query strings were absent. **No unsafe bytes were written to disk.** Only boolean findings are saved.
- Source-minimized tagged middleware then handled synthetic requests to `/health`, `/api/v1/chats/{id}`, and an unmatched path. An unknown method was mapped to `OTHER`. The provider used `Resource(attributes={})`.
- After an actual 10.05-second wait, native collection ran the three real callback SQL queries and the real pinned Python exporter posted protobuf to a loopback HTTP sink. The sink invoked the JavaScript decoder on the received bytes **before** sending HTTP 200 and an empty protobuf response. This is actual exporter transport, not hand-written JSON or a hand-written compatibility payload.
- Safe artifacts: `fixture.pb`, `fixture.normalized.json`, `fixture-proof.json`. The binary is 2,444 bytes, 11 points, all five native metric names. Exact capture hash is in the proof. Timestamps and measured durations naturally change on regeneration.
- The source adapter for tagged `setup.py` is checked to replace resource merging. Fixture calls native `setup_metrics` directly with the minimized resource; it does **not** import the full OWUI application, production DB, unrelated tools or trace instrumentors.

## Findings

| Requirement | Observed result |
|---|---|
| Actual wire | OTLP/HTTP protobuf `ExportMetricsServiceRequest`, `application/x-protobuf` |
| Endpoint | Explicit endpoint is used verbatim; `/v1/metrics` in standalone fixture, `/v1/otlp/metrics` for core hook |
| Native request count | Monotonic integer sum, unit `1`, default cumulative temporality 2 |
| Native duration | Explicit histogram, unit `ms`, default cumulative temporality 2 |
| Native user counts | Integer gauges, unit **`users`**, no point dimensions, zero start time |
| Native dimensions | Exactly `http.method`, `http.route`, `http.status_code` |
| Native histogram bounds | 0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000 ms, plus final overflow bucket |
| Collection | Exactly 3 synchronous SELECTs per gauge collection in synthetic SQLite |
| Compression | Exporter default identity; gzip/deflate explicitly rejected by decoder contract |
| Native auth | Fake Basic credentials observed over loopback; never stored in artifacts |
| Core auth compatibility | Standard exporter header env override with Basic unset emitted the expected synthetic Bearer capability |
| Retry | 503 then 200 produced byte-identical posts; real exporter reported success |
| Nonretryable responses | 400, 401, 413, 415 and **429** each produced exactly one attempted export |
| Persistent outage | Real retry loop with 3-second timeout failed within 4 seconds, at most 3 attempts; jitter-dependent exact result in proof |
| Privacy | Safe serialized protobuf and normalized points contain no fake secret markers |
| Reset/precision | Exact ns and int64 tests exceed JS safe integer; no truncation/rounding |
| Duplicates/global gauges | Identical points collapse, conflicts reject; global gauge value stays unchanged, never doubled |

Decoder tests also cover delta/cumulative distinction, changed start timestamps, disjoint histogram buckets and huge counts, bad bucket totals/bounds/nonfinite statistics, negative int64 counts, unsupported metric/field/exemplar/flag/scope/resource, fake unexpected attributes/routes/methods, every truncation of a valid adversarial message, malformed protobuf and length/point/metric limits. Request tests cover media type, compression, oversized declared/actual bodies and a stalled stream deadline. Worker bridge tests cover stable receipt IDs across receipt times, native units, exact ns/MS mapping, fixed instance vocabulary, global gauge attrs, rejection instead of lossy count conversion, and startup/new-series suppression.

Latest run: **13/13 Node tests passed**. The native hook test also passes its 11-point envelope through the coordinated core `validate('metrics', ...)` and checks that every point, including exact ns fields, survives unchanged. Full core Worker/D1 durability tests remain the core owner's responsibility.

`normalize.test.mjs` uses small handcrafted protobuf messages **only for adversarial/unit boundary cases**. The compatibility fixture is generated by the actual SDK/exporter and tagged code. These are intentionally different sources of evidence.

## Remaining gates and limitations

1. Core integration requires unit `users`, optional exact ns/reset strings persisted alongside ms, optional histogram sum, additive fixed route policy, `OtlpError` response mapping and empty HTTP-200 protobuf success after durable ingest. These changes were coordinated with the core owner, and the core validator round trip passes. Verify the final shared Worker/storage artifact and its tests before claiming end-to-end durability. No shared files were edited by this slice.
2. This proves tagged instrumentation in a synthetic harness, not a running full OWUI container or deployment artifact. The local source patch and empty-resource setup must become an explicitly reviewed artifact before export is enabled. Source minimization cannot be replaced with receiver rejection.
3. Source failure collection overhead was not measured against PostgreSQL or a real OWUI request loop. Three synchronous DB queries are proven; production query latency, pool contention and hard DB timeouts remain unqualified. The callback deadline does not interrupt a blocked synchronous SQL query. A 60-second interval and short export deadline are candidate policy, not a capacity claim.
4. The native code exports precise first-series timestamps. Preserving reset semantics is not itself privacy approval. The bridge omits intervals younger than 10 seconds but cannot prove that older sparse series are anonymous. Review granularity, route categories and aggregate reporting before collection. No per-user activity history, identities or stable pseudonyms are added.
5. The standalone HTTP sink is Python plus a Node decoder subprocess, not a network-exposed Worker. Decoder is Worker-compatible, and core owns local Worker/D1 integration qualification. TLS/control-plane permissions, production receiver logging posture, storage expiry, exports, read authority and costs are not qualified here.
6. Byte-identical whole-batch retries are proven and deterministic bridge IDs support receipts. Overlapping distinct batches still require report-time point dedup. Multiple workers require trusted fixed producer slots for HTTP counters and authoritative/latest global gauge selection, never gauge summation.
7. Gzip/deflate and JSON are intentionally unsupported, not silently misread. OTLP/gRPC, trace/log export, float counts, metadata extensions and alternate SDK versions need separate qualification.
8. SDK logs can include endpoint/error text on failure. Qualification used only loopback/fake credentials. A rollout must avoid credential-bearing endpoint URLs and suppress/redact telemetry exporter error details; never enable raw request logging in the Worker or sender.

See `../otlp/README.md` for the full exported interfaces, source configuration proposal, exact output fields and report-time counter/reset/histogram/gauge rules. This proof authorizes no collection.
