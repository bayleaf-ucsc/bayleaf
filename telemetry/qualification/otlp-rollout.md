# OWUI v0.12.3 source rollout artifact

2026-10-20. **Synthetic artifact and local full-container/PG qualification pass;
production rollout and production overhead acceptance remain separate.** No
production HTTP requests, DO/Cloudflare control-plane calls, credentials, commits,
pushes or browser injection were used in this slice. The parent session owns
disclosure publication and any subsequent rollout. Adam authorized 90-day active
telemetry retention; this sender does not set or attest collector retention.

## Artifact and customization choice

Build context is the repository root; Dockerfile is
`chat/image/Dockerfile`. It adds only checked-in Python files and upstream
reference sources to the standard `ghcr.io/open-webui/open-webui:v0.12.3` image.
No pip install, runtime fetch, instrumentation agent or upstream fork is added.
The Dockerfile now defaults to the resolved immutable upstream index digest:

```sh
docker build -f chat/image/Dockerfile -t bayleaf-otlp-qualification:20261020 .
```

Upstream index: `sha256:a537bbe1e6b428820f52ed4a029d7fff97062e24d5cf32c365fba36fd0542def`.
Its linux/arm64 image manifest is
`sha256:bd153a1fd2ea21c991e693b485573ec104058e58781ccb3580acaa873fd60887`;
linux/amd64 is
`sha256:ef11a68f38457d831e23168486858c25b9d9c4399094c9e72c0d4d8767ac09de`.
Local tests use arm64. Build-time and every-start checks additionally verify the
exact upstream sources and dependency versions. **No upstream source or package
version drift was found in the actual standard image.** No tag mismatch was
papered over by weakening guards.

This is rung 4, deliberately: the boot patch plus runtime adapter exceed the
approximately 20-line rung-3 threshold and add files. Encoding them as one enormous
base64 DO command would conceal reviewable source and amplify quoting/argv risk.
The Dockerfile is 11 lines. The source adapter is small Python using packages
already pinned in the upstream image, not a parallel application implementation.

**DO's existing `run_command` overrides Docker CMD.** The release spec must replace
the old echo-and-start command with this single line:

```yaml
run_command: python /opt/bayleaf-otlp/startup_patch.py
```

Do not use a YAML block scalar. The Python entrypoint prints the entire prior
`[bayleaf] rung-3 harness alive (...)` sentinel unchanged, checks and patches,
then uses `os.execvp('bash', ['bash', 'start.sh'])` in `/app/backend`. The upstream
script in turn execs uvicorn. Thus the sentinel and PID-1 process handoff survive.
The Docker CMD is the same entrypoint for local/container use.

`startup_patch.py` verifies all reference bytes against `upstream/SOURCE.json`,
then checks installed `metrics.py`, `setup.py`, `instrumentors.py`, `env.py` and
`requirements.txt` against their exact tagged hashes. Only the exact original or
exact expected patched bytes are accepted. Installed adapter drift also refuses
startup. All checks and syntax compilation precede atomic file replacements.
Repeated execution is idempotent. Hash, environment or dependency mismatch exits
1 with a content-free message: **there is no fallback to an unsanitized start**.
The manifest identifies tag commit `91ea4e3421d1d8069f13d4a463fcb5986d94ea60`.

Version checks pin OTel API, SDK and HTTP exporter to 1.42.1, SQLAlchemy to 2.0.50,
FastAPI to 0.136.3 and psycopg2-binary to 2.9.12. Tool/plugin dependency installation
can mutate the environment later; do not treat boot checks as an immutable runtime
attestation. Any OWUI upgrade requires regenerating and requalifying this artifact.

## Source behavior and privacy

- Reuses `source_policy.py`: five route values, seven named methods plus `OTHER`.
  Unapproved templates and literal unmatched paths become `/_other`; arbitrary
  method strings become `OTHER` **before counter/histogram aggregation**.
- Keeps native metric names, units, histogram buckets, user-count queries and
  cumulative reset semantics. Setup uses `Resource(attributes={})`, not the
  environment/detector-merging `Resource.create()`.
- Uses pure-ASGI middleware instead of native `@app.middleware('http')`.
  Tagged `main.py` explicitly explains that it removed BaseHTTPMiddleware
  elsewhere because its task-group cancellation could cancel downstream DB calls.
  Enabling native metrics unchanged would restore that pattern. The adapter adds
  no task group and records once at response headers, or status 500 on a failure
  before headers. It is **not full SSE duration or inference latency**.
- The active startup configuration requires traces, logs, exemplars and automatic
  logging instrumentation off. Native trace instrumentors are not invoked.
- Native callback debug exception logging is removed. OTel package logs and only
  the dedicated metrics DB engine/pool loggers are suppressed. Application SQL
  and other application logger families are not globally disabled. Missing or
  stale collector observations must supply operational failure detection.

## Cardinality and steady admission

An HTTP tuple is `(route, method, exact status)`. Each tuple creates **two**
cumulative points. There are three global gauges. Therefore an unchanged native
export with 49 historical HTTP tuples has `2*49+3 = 101` points and permanently
exceeds the collector's 100-point batch cap, even after those routes go idle.
Across accepted values the finite ceiling is `5*8*500 = 20,000` tuples, or 40,003
points. A single ordinary UI session can visit many statuses/methods in `/_other`;
assuming lifetime traffic stays below 49 tuples is not a production argument.

`WindowedHttpMetricExporter` fixes the **outgoing source export budget** without
inventing status buckets, dropping counter state, changing dimensions, resetting
series or silently discarding whole full batches:

1. Retain the native cumulative SDK aggregates.
2. In each export, choose up to **48 complete HTTP tuples**, using a stable
   lexical round-robin cursor. Counter and histogram for a tuple travel together.
3. Include up to three global gauges on every export: at most **99 points**.
4. Preserve original values, timestamps, starts and histogram statistics.
   Unselected tuples are deferred, not deleted from aggregation state. Native
   retries operate on identical already-selected bytes. Cursor advances only on
   reported export success. A collection that straddles the first counter and
   histogram updates defers only the incomplete pair, not the full batch.

This is export paging, **not** a 48-series lifetime aggregation cap. Source memory
and SDK collection work still grow with historical accepted tuples. Stable `N`
tuples recur within `ceil(N/48)` successful pages. At a one-minute cadence this is
one minute at N<=48, three minutes at N=120, up to 417 minutes at the theoretical
20,000-tuple ceiling. At the recommended five-minute cadence those become five,
15 and 2,085 minutes (34 hours 45 minutes), respectively.
High cardinality therefore degrades sampling freshness, not batch admission.
Validate real cardinality and RSS during qualification. If this grows beyond the
operational freshness budget, revisit source aggregation policy explicitly.

The synthetic tagged app created all `5 routes * 8 methods * 3 statuses = 120`
tuples (200, 404, 500). Three actual HTTP protobuf exports each contained 99 points;
their union covered all 120 tuples. Every export passed the actual OTLP hook and
shared core validator, with normalized envelopes below 43 KiB, below the 64-KiB
core JSON limit. Current 100-point batches and 120 points/minute therefore fit a
**steady single-worker 60-second export**. The new source cap is independent of
the decoder's larger 512-point wire limit. No collector files were changed.

**Collector recommendation, not implemented here:** raise the authenticated
OWUI points/minute budget to **360** while retaining the 100-point batch cap, to
allow the 99-point export plus two retries/arrival jitter. Currently point budget
is consumed before durable receipt dedup: a lost success response can leave only
21 points of that minute's allowance and turn the identical retry into a 503.
This is not a steady-state sizing failure, but retry headroom is inadequate.
Alternatively move duplicate handling ahead of point charging with its own bounded
attempt budget and qualification. Multiple producers need a separate budget and
gauge-authority review; do not multiply the current deployment's workers.

At the 99-point/minute ceiling this is up to 142,560 metric rows/day and 12,830,400
rows across 90 days, before indices, receipts, other sources, purge work or
provider backups. The parent must assess D1 storage/write cost and purge capacity;
the traffic allowance alone does not establish sufficiency or affordability.

**Recommended 90-day setting: `OTEL_METRICS_EXPORT_INTERVAL_MILLIS=300000`.**
This reduces the same ceiling to 28,512 metric rows/day and 2,566,080 rows/90 days,
and steady gauge queries from 0.05 to 0.01 SELECT/s. It costs fivefold worse source
sampling freshness, and more when paging is needed. The native active-user gauge
still counts the previous **three** minutes: five-minute sampling can entirely
miss a brief active period in the two-minute gap, so do not relabel it unique users
per five minutes. Active-today remains the native UTC-midnight count. For broad
safe exploratory data, these tradeoffs are preferable to a denser individual-use
timeline, but the parent must accept them. The startup guard accepts exactly
60000 or 300000, not arbitrary fast intervals or unbounded cadence settings.
The parent selected 300000 and reports measured 90-day storage of approximately
**1.12 GB** at the maximum 99-point density, from its separate collector/storage
sizing work. That is not a measurement from this native-source container test.

Reports must compare the same tuple/producer/exact start across increasing
timestamps. Paging gives irregular intervals per series, not a complete per-minute
cross-section. Do not sum cumulative snapshots or label omitted series zero.
Existing 10-second first-series suppression still applies. First observations or
a process reset before a tuple's next page can lose a reporting baseline; no
claim of lossless traffic reconstruction across restarts is made. Preserve gaps.

## Exact active environment

Set these on the OWUI service, preserving unrelated deployment settings:

```text
ENABLE_OTEL=true
ENABLE_OTEL_METRICS=true
ENABLE_OTEL_TRACES=false
ENABLE_OTEL_LOGS=false
OTEL_METRICS_OTLP_SPAN_EXPORTER=http
OTEL_METRICS_EXPORTER_OTLP_ENDPOINT=https://telemetry.bayleaf.dev/v1/otlp/metrics
OTEL_METRICS_EXPORT_INTERVAL_MILLIS=300000
OTEL_EXPORTER_OTLP_METRICS_TIMEOUT=2
OTEL_METRIC_EXPORT_TIMEOUT=3000
OTEL_EXPORTER_OTLP_METRICS_COMPRESSION=none
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=CUMULATIVE
OTEL_METRICS_EXEMPLAR_FILTER=always_off
OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED=false
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORTER=none
OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer <dedicated-owui-write-capability>
```

The final variable is a **DO SECRET**, not a value for this public file. Use a
dedicated `owui` write-only capability, not any read token, admin JWT, other
source's token or general account credential. The guard accepts a URL-safe token
of at least 32 ASCII characters (`A-Z a-z 0-9 - . _ ~`) and no additional headers.
The exact literal space after `Bearer` is correct for the pinned exporter and was
verified over loopback. No bearer value enters protobuf or stored metric points.

Unset or set empty **all four** native Basic variables, including fallback ones:
`OTEL_BASIC_AUTH_USERNAME`, `OTEL_BASIC_AUTH_PASSWORD`,
`OTEL_METRICS_BASIC_AUTH_USERNAME`, `OTEL_METRICS_BASIC_AUTH_PASSWORD`.
Also unset `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_RESOURCE_ATTRIBUTES` and
`OTEL_PYTHON_AUTO_INSTRUMENTATION_AGENT_PATH`. With Basic absent, native
`headers=[]` selects the standard metrics-specific header override. HTTP endpoint
is used verbatim; include the whole path. Do not disable TLS verification or add
credentials to URLs. Do not inject `opentelemetry-instrument` into the command.

Timeout units differ: exporter timeout **2 seconds**, reader timeout **3,000
milliseconds**, recommended interval **300,000 milliseconds** (60,000 is also
explicitly accepted). CUMULATIVE is mandatory because page deferral would lose
deltas.

## Database overhead controls and gate

The three native callbacks still run their three SELECTs in the SDK background
collection thread, not the request/event-loop thread. The adapter constructs a
separate PostgreSQL psycopg2 engine from the application's parsed URL:

- One persistent connection maximum, no overflow, pool wait at most 100 ms.
  It never checks out from the application's 10-connection pool.
- Connection parameter `connect_timeout=2` seconds.
- Fixed connection `application_name=bayleaf-otlp` allows aggregate connection
  counting, without identifying users or exporting resource attributes.
- Connection-local `statement_timeout=200` ms, `lock_timeout=100` ms and
  `default_transaction_read_only=on`. These do not alter application transactions.
- libpq keepalives (idle 2 seconds, interval 1 second, count 2) and
  `tcp_user_timeout=3000` ms are additional best-effort network controls.
- Any callback DB failure suppresses subsequent gauge queries for 60 seconds,
  preventing three repeated connection attempts in one collection. Failed gauges
  are absent, never stale cached values relabeled current or invented zeros.

Healthy steady query count is 3/export: 3/minute (0.05 SELECT/s) at 60000, or
3/five minutes (0.01 SELECT/s) at 300000. Three statements at the 200-ms server
limit occupy the one metrics connection for at most roughly 600 ms of server
execution per export. This is a bound on server work, **not** a universal
600-ms client wall-clock guarantee. DNS, multiple hosts, socket stalls, transaction
cleanup and OS scheduling are not interrupted by OTel's reader deadline. libpq
timeouts are not a hard end-to-end callback cancellation mechanism. The source
therefore improves boundedness but does not claim that PostgreSQL/network failure
can never exhaust the reader's three-second deadline or suppress an export.

Required PG gate: in an isolated PG17/full-OWUI container environment, prove the
connection settings using only `SHOW`/aggregate diagnostics; test an exclusive
table lock, `pg_sleep`, unavailable DB and connection saturation; verify query
failure/backoff, no application-pool contention and no raw failures in logs.
Never retain raw SQL parameters or user rows in evidence. Before activation,
check cluster connection headroom (25 maximum) for the extra connection. During
an approved bounded service soak, compare 5-minute exporter-off/on windows under
similar load: CPU/RSS, app request p95, pool errors, PG connections and normalized
SELECT deltas. Proposed acceptance: at most one added connection, approximately
3 SELECTs per configured export cycle, callbacks ordinarily under 100 ms, no new pool/cancellation
errors, no sustained >5 percentage-point CPU increase or >10% request-p95
regression. Thresholds are practical gates, not measured production facts here.
If rejected, keep HTTP metrics and disable/revise gauges in an explicitly reviewed
artifact rather than increasing the application's pool or extending deadlines.

## Evidence and remaining release gates

```sh
uv run --python 3.11 --locked --script telemetry/otlp/qualify_startup.py
node --test telemetry/otlp/normalize.test.mjs
```

`rollout-proof.json` records exact installed hashes and measured synthetic
collection times. The synthetic run uses the actual installed, hash-verified
patched `setup.py` and `metrics.py`, real OTel 1.42.1 exporter and loopback HTTP,
plus fake env/User modules and SQLite. Only the bounded PG engine factory is
substituted for app execution; its pool/connect/statement configuration is checked
separately. That harness does not exercise a full OWUI installation or real PG
connection; the separate container run below does. Neither uses a production
database. The fixture also tests idempotence, source/adapter drift,
unsupported versions, unsafe environment refusal, no exec on mismatch, successful
exec handoff, all-four-flags-off mode, pure-ASGI same-task behavior, headers/early
error timing, missing gauge behavior, DB backoff, partial-pair deferral and failed
export cursor preservation. Existing decoder tests pass 13/13.

### Actual standard-image container follow-up

The initial Docker-daemon blocker was resolved when Docker Desktop finished
starting. `docker info` reported server 29.8.2. The actual pinned standard OWUI
image built successfully: all five installed source hashes and all six package
versions matched without an exception or allowlist relaxation.

Reproduction (no registry push, production request or control-plane operation):

```sh
docker buildx imagetools inspect ghcr.io/open-webui/open-webui:v0.12.3
docker build -f chat/image/Dockerfile -t bayleaf-otlp-qualification:20261020 .
docker pull postgres:17-bookworm
python3 telemetry/otlp/qualify_container.py bayleaf-otlp-qualification:20261020 postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826 300000
```

The PostgreSQL index is version 17.11-bookworm, with arm64 image manifest
`sha256:a85953d6f830fd55a12929df3b7a4fa94dc96d652de62d2d714e0867ccb3670d`.
`qualify_container.py` is a focused standard-library harness, not a deployment
framework. It creates only unique owned containers and an `--internal` Docker
network, without published ports. Requests execute inside the synthetic fixture
container. PostgreSQL uses owned tmpfs storage. A fixture-local self-signed CA is
trusted only through `OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE`; native HTTP TLS
verification stays enabled. Docker DNS maps `telemetry.bayleaf.dev` to that local
fixture. External egress is unavailable, so the production-looking endpoint
cannot accidentally become a production request. The app has only synthetic
DB/auth/model credentials and a fake OpenAI-compatible model server.

The first one-minute run passed full migrations into empty PostgreSQL, `/health`,
`/api/version`=0.12.3, synthetic signup, authenticated model discovery, JSON
inference and SSE inference through the actual OWUI route. Its actual periodic
OTLP/HTTPS export passed the unchanged Node hook and included all five native
metrics. PostgreSQL reported `200ms` statement timeout, `100ms` lock timeout and
read-only transactions. Measured one-connection pool refusal was 103.95 ms,
`pg_sleep(1)` cancellation 205.18 ms and conflicting-table-lock cancellation
105.40 ms. A refused local DB port failed in 1.23 ms, then backoff prevented a
second attempt. Count collection recovered after the test reset the backoff
clock. Automatic clock expiry is covered separately by the synthetic unit check.
An idle snapshot was 1.16% CPU and 686.4 MiB RSS (3-GiB test limit), not a production
capacity or regression comparison. Evidence is `container-proof-60000.json`.

The final artifact then passed the full run at **300000 ms**, including an actual
five-minute wait for the native periodic reader, not manual collection or a
shortened test interval. Its local output index digest is
`sha256:8a9783e0cac60a437a69d496c85e1e9c66ffb8dc1f10f25e6e029eb3d87852b8`
(arm64 image manifest
`sha256:3e524ab33b3cc5845fea69ad0c4baeb04612fed585cd7c050bc6294a5a14b642`,
config `sha256:43e7b39432e03ff58bc8e8d3e40d14299de4fdd7f872f540ae9fb3fe1cc05155`).
This local image was not pushed. Evidence is `container-proof-300000.json`, also
copied to `container-proof.json` for the latest result.

That run again passed signup/model discovery, actual OWUI JSON and SSE inference,
sentinel preservation, traces/logs-off configuration and startup refusal after
source drift in a disposable no-network container. The native TLS export had
15 points, all five metric names, four minimized route values and methods
GET/POST/OTHER. A real `PROPFIND` request exercised the OTHER mapping; a private
synthetic unmatched path and query did not survive into the protobuf. The real
Node hook accepted the entire batch with empty resources and no extra dimensions.
Exactly one `bayleaf-otlp` connection existed in `pg_stat_activity` after export.
PG pool refusal, statement cancellation and lock cancellation measured 105.24,
202.01 and 103.08 ms; an unavailable local DB port took 0.94 ms, then backed off.
An idle snapshot was 0.95% CPU and 672.9 MiB RSS. These are functional and failure
control observations, not a matched-load performance claim.

The final safe protobuf is `container-fixture.pb`, SHA-256
`0e70aba7a5bcbf42730c50228bfba0af6e22becfa2ba1555842d7f2288748d0f`.
All final owned containers and their internal network were removed; independent
`docker ps -a --filter name=bayleaf-otlp-q-` and the equivalent network listing
returned no entries. Local images/build cache are retained for reproducibility;
no existing containers or volumes were removed.

The first harness attempt failed before health because this Docker internal
network did not publish the requested host port. It was a test-harness fault,
not a source mismatch: the startup sentinel and migrations had already begun.
All three owned containers were removed. The harness was corrected to make all
requests inside the isolated network, with no host port mapping. No source hash
guard was relaxed to address the failure.

### amd64 release-architecture boot check

The remaining amd64 gate also **passes under local Docker Desktop emulation**.
The standard image was built using the exact amd64 upstream manifest, not the
arm64 image under a different label:

```sh
docker build --platform linux/amd64 --build-arg OWUI_IMAGE=ghcr.io/open-webui/open-webui:v0.12.3@sha256:ef11a68f38457d831e23168486858c25b9d9c4399094c9e72c0d4d8767ac09de -f chat/image/Dockerfile -t bayleaf-otlp-qualification:amd64-20261020 .
python3 telemetry/otlp/qualify_container.py bayleaf-otlp-qualification:amd64-20261020 postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826 300000 boot
docker build --platform linux/amd64 -f chat/image/Dockerfile -t bayleaf-otlp-qualification:amd64-default-20261020 .
```

The first two commands produced and booted local output index
`sha256:3891c15aeb94fff2a377291be2d076f97d612523e5ac2d006a42d08319073602`,
with amd64 image manifest
`sha256:b70d9a498f5e4de97b56925dce144a97a7e86452a15d1672e255abdc5e4c7ca0`
and config
`sha256:be05a54a7bb5d38a45fafc5cc6566fe7960f45ce3f553de4464f1a87b102f441`.
The output index is local build metadata, distinct from the **upstream**
multi-platform index `a537...` and its **upstream amd64** image manifest `ef11...`.
No output image was pushed.

Actual amd64 build-time and post-startup package-version/source checks passed,
including idempotent source validation after app startup. The installed four
patched/adaptor hashes exactly match the arm64/synthetic evidence. Deliberate
source drift refused startup in a separate disposable no-network amd64 container.
The full app completed migrations, health/version 0.12.3, synthetic signup/model
discovery and actual JSON/SSE inference. PID 1 was explicitly checked as
`/usr/local/bin/python3 -m uvicorn open_webui.main:app ... --workers 1 ...`.
The amd64 psycopg2 metrics engine successfully connected to synthetic PG17 and
reported the expected 200-ms/100-ms/read-only settings. No architecture-specific
source drift, missing dependency, driver error or release blocker was found.
Evidence: `container-proof-amd64-boot.json`. All three owned containers and their
network were removed.

The third command separately verified that the **unchanged Dockerfile default**,
the immutable multi-platform `a537...` index, builds successfully for linux/amd64
without a build-argument override. That local build produced output index
`sha256:8730e9e7e5693119e12c9cfa2a7266333ed20559df0ce84d7901c64238c616c2`
(amd64 image manifest
`sha256:9e051fc3e8687189ff10c3e2e5204538ee87f97a57b0d519ed29cfb762e69465`).
The default therefore supports DO's amd64 build; it does not accidentally pin an
arm64-only base. Build context must remain repository root, Dockerfile path
`chat/image/Dockerfile`, and the service startup override must be
`python /opt/bayleaf-otlp/startup_patch.py`, not the old echo-and-start wrapper.
No production settings were changed in this check.

As requested, this was a focused boot/compatibility check: the five-minute native
export was not repeated on amd64 because no difference was found. The actual
five-minute wire and PG failure-control results remain the arm64 full-container
evidence above. Emulated CPU/RSS is not a DO performance measurement.

Remaining production gates, distinct from the completed local container checks:

1. The local linux/amd64 build/boot compatibility gate is complete. The parent
   still verifies the actual DO deployment's build identity and healthy startup
   when switching to the repo Dockerfile. Do not substitute a slim image or drop
   the mandatory startup guard. No actual source-release blocker remains from
   this architecture check.
2. Parent verifies actual collector build/D1 durability, 90-day active expiry,
   purge capacity, read authority, logging posture and paid capacity. The local
   source test uses a fake TLS sink and the real decoder/hook, not production D1.
3. Retain the approved bounded production exporter-off/on overhead comparison and
   connection-headroom gate above. An isolated functional test does not measure
   campus traffic, DO network failures, every authentication mode or real model
   provider behavior. Campus OIDC, uploads, tools and browser behavior were not
   exercised. No browser injection is included.
4. Slow TLS/HTTP and lost-ack retry behavior for the final paged artifact needs
   targeted acceptance. Original pinned-exporter retry/deadline behavior has the
   separate loopback proof, but that is not a full adversarial network soak.
5. Parent publishes approved disclosure before enabling collection and accepts
   cadence/freshness, cost and retry-headroom choices. Native rollout remains the
   parent's decision. All owned qualification containers/networks are removed by
   the harness even on failure; existing containers and volumes are untouched.

Source kill switch: set **all four** `ENABLE_OTEL`, `ENABLE_OTEL_METRICS`,
`ENABLE_OTEL_TRACES`, `ENABLE_OTEL_LOGS` to literal `false`. The same entrypoint
still validates pinned sources/dependencies and boots Chat, without enabling OTel.
Never roll back to the unpatched upstream image while leaving metrics enabled.
For full rollback, atomically restore the prior image and prior one-line harness
with all four flags false; preserve unrelated secrets and configuration. Collector
admission off stops storage but is not a substitute for stopping source export.

Playbook refinement for the parent to record in its owned file: startup source
minimization required rung 4, native cumulative cardinality needed source export
paging, and enabling native metrics unchanged would have reintroduced the
BaseHTTPMiddleware cancellation pattern removed from main. No playbook edits
were made outside this slice's ownership.
