# Daytona telemetry: live lifecycle and organization metrics

Prepared 2026-10-20 at Adam's request for both lifecycle webhooks and OTLP.
Temporary qualification configuration/resources were restored or removed after testing.
`../qualification/rollout.md` describes the existing live sources, not this one.
Adam subsequently approved live qualification under the transport caveat below.
Real state-update deliveries and organization metrics are qualified; temporary
resources/configuration were cleaned up. See [`../qualification/daytona.md`](../qualification/daytona.md).
The operator subsequently approved commit/push, privacy publication and permanent
activation, and waived affected-user notification. Both sources are enabled with
real production readback and 90-day retention. See the qualification/activation
record for evidence, limitations and rollback.

## Approved collection policy

- **Lifecycle:** only `sandbox.created` and `sandbox.state.updated`. UTC 15-minute
  bucket start, event category, old/new state and deduplicated event count.
  Creation has no old state. No names, owners, IDs, labels, exact event times or
  raw payloads survive. Snapshot and volume events are deliberately excluded.
- **Capacity:** the eight documented `daytona.sandbox.used_*` / `total_*` CPU,
  RAM, storage and GPU organization gauges, with source measurement time, value,
  unit, reviewed region and sandbox-class categories. Fractional values are
  preserved. No per-sandbox metrics, arbitrary attributes, logs or traces stored.
- **Private reads only:** existing operator capability, bounded windows, no
  public counts, SQL or newly exposed agent tools. `/v1/read/lifecycle` reads
  buckets; `/v1/read/metrics` reads capacity. Dashboard integration is deferred.
- **Retention:** existing maximum 90-day policy, default seven days locally.
  Lifecycle expiry is conservatively anchored to bucket start. Event-only keyed
  delivery receipts use the same expiry; they cannot link a sandbox's history.
  Retries do not extend retention. Existing Cloudflare recovery-copy and derived
  artifact restrictions apply. Source status is latest accepted data, not health.

This follows the existing architecture's policy/validation separation, scoped
writers, atomic receipt/storage transactions, content-free errors, admission
budgets and irreversible retention ceilings. It does not turn the warehouse into
a general log archive. `../src/policies.js` is service policy version 3; browser
policy and wire schema versions are unchanged. The physical addition is migration
`0004_daytona_lifecycle.sql`; a fifth durable retention-state row is created by
ordinary policy enforcement.

## Questions this supports, and limits

Group lifecycle counts by weekday and local hour using **America/Los_Angeles**,
converting each UTC bucket with timezone-aware date handling, including daylight
saving changes. Separate creation from state-change events: creation followed by
starting/started notifications is not several new sandboxes. Treat intermediate
states separately from completed transitions and errors.
Real qualification also observed `started → started` state notifications. Exclude
old-state-equals-new-state records from transition totals, or label them explicitly
as no-op notifications. They are not new starts or proof of human activity.

Counts measure **events, not distinct sandboxes, users or sessions**. A sandbox can
transition repeatedly in one bucket. This policy intentionally gives up lifetime,
per-sandbox transition latency and longitudinal histories. Missing buckets are
not proof of zero activity: delivery gaps, stale signed messages, rejected schema
changes and pre-activation time must remain unknown. Live qualification and
delivery monitoring are prerequisites to interpreting absence.

Gauges are snapshots, not additive totals across time. Keep region/class series
separate; do not merge earth-region GPU totals with overlapping regional samples.
Used CPU/RAM are provider-defined resource-allocation measurements, not proof of
human attention or useful computational work. Units, actual resource shape,
regional overlap and source cadence require a real-export qualification.

## Receiver contracts

- `POST /v1/daytona/webhooks`: candidate Standard Webhooks/Svix HMAC-SHA256
  signature verification against exact body bytes (live Svix headers verified), five-minute signature clock
  tolerance, organization equality check, strict event/state vocabulary. The
  signature timestamp is delivery freshness; the payload timestamp determines
  the bucket and is separately retention-checked. A keyed hash of the delivery
  ID becomes a receipt UUID, never the raw ID or sandbox ID. Receipt-secret
  rotation must pause deliveries or preserve deduplication across retries.
- `POST /v1/daytona/otlp/metrics`: OTLP/HTTP protobuf, identity encoding only,
  at most 256 KiB, two-second total body deadline. The authenticated `daytona`
  writer cannot submit OWUI metrics or read data. Only organization resources
  containing exactly `organization.id` are eligible. Per-sandbox resources are
  discarded before point decoding. Unknown metric names are discarded; invalid
  approved metric types, units, dimensions, exemplars or values fail closed.
  Empty eligible sets return success **without inserting zero samples or status**.
- The exporter base URL appends `/v1/{signal}`. Beneath
  `/v1/daytona/otlp`, both `/v1/{metrics|logs|traces}` and the short
  `/{metrics|logs|traces}` explicit-endpoint aliases are accepted.
- `/v1/daytona/otlp/logs` and `/traces`: authenticate, immediately cancel the
  body without buffering/decoding, and return an empty OTLP success response to
  avoid retries. These are discard endpoints, not a log/trace collection facility.
- Both switches and the global switch fail closed. The production-config draft
  adds a shared fixed-key 120/minute edge cap; accepted lifecycle submissions
  additionally share the source/class 60/minute storage budget, and metrics the
  120-point/minute budget. These bound admission, not all billable edge work.

**Material transport caveat:** Daytona documents a single organization exporter
destination for sandbox telemetry and organization metrics. Per-sandbox data can
therefore reach Cloudflare even when our application discards it. Enabling it is
not equivalent to organization-only export at the source. Do not describe this
as never receiving logs or sandbox identifiers. Prefer a provider-side
organization-metrics-only export if Daytona can supply one; otherwise Adam must
explicitly approve the transient transport exposure before activation.

## Activation gates, in order

1. Review the proposed fields, resolution, transition-count semantics and
   transient OTLP transport caveat above. Review the exact unpublished
   `PRIVACY.md` diff. Decide affected-user notification separately.
2. Qualify Daytona's actual webhook signing scheme, header names, stable retry
   ID and retry horizon. Public docs do **not** specify these. The candidate
   Standard Webhooks verifier must not be enabled merely on that assumption.
   Use a disposable synthetic sandbox, never archive a real raw delivery.
3. Qualify an actual organization-metric export with synthetic resources: exact
   protobuf resource shape, metric types/units, region/class enums, cadence,
   payload sizes, encoding and retry behavior. Current fixtures are hand-built,
   not production or exporter compatibility evidence. No raw real export archive.
   Current reviewed regions are `us`, `eu`, `earth`; classes are `container`,
   `linux-vm`, `windows`. Do not widen them automatically. Add a reviewed fixture only
   after replacing identifiers and confirming no private data remains.
4. Confirm whether the Daytona organization contains only BayLeaf resources.
   Organization-wide webhooks/metrics otherwise include unrelated workloads.
   Do not silently join sandbox ownership or filter through user identities.
5. Obtain approval to publish the privacy notice and activate sources. With
   explicit deployment approval, apply migration `0004` before deploying code.
   Native/browser guards and existing writer secrets remain unchanged.
6. Install separate writer token `daytona` in `WRITE_KEYS_JSON`, distinct from
   all existing write/read capabilities. Set `DAYTONA_ORGANIZATION_ID`,
   `DAYTONA_WEBHOOK_SECRET` and a separate random `DAYTONA_RECEIPT_SECRET` of at
   least 32 characters. After protocol qualification, set
   `DAYTONA_WEBHOOK_PROTOCOL=standard-webhooks`. Never put secrets in git.
7. Configure Daytona subscriptions to the **two sandbox events only**, and the
   OTLP base URL `https://telemetry.bayleaf.dev/v1/daytona/otlp` with the dedicated
   bearer in its headers. Qualify how the exporter appends signal paths, rather
   than assuming it. Enable independent `DAYTONA_WEBHOOKS_ENABLED` and
   `DAYTONA_OTLP_ENABLED` only when each is qualified.
8. Verify anonymous and wrong-source denial, real signed synthetic deliveries,
   retry deduplication, concurrency, exact private readback/expiry, capacity
   readback, and non-storage of sandbox data. Check provider delivery history
   without retaining raw messages. Record deployment/config versions and real
   normal-operation observations in qualification evidence. No public integration
   registry entry may claim verification before this evidence exists.

Rollback: turn both switches off and pause the provider subscriptions/exporter.
Scheduled purge must continue. Do not drop tables, delete retention-state rows,
or restore pre-policy data. Disabling collection does not erase provider delivery
history or Cloudflare recovery copies.

## Local verification

`node --test test/daytona.test.js test/workerd.test.js` from `telemetry/`.
The full existing test command also includes the new tests without changing
`package.json`. Synthetic coverage includes signature tampering/freshness,
organization checks, privacy minimization, retries/conflicts, real workerd/D1
concurrency, fractional gauges, source isolation, mixed sandbox/org exports,
discard paths and irreversible retention. No provider calls are made by tests.

Sources inspected 2026-10-20:

- <https://www.daytona.io/docs/en/webhooks>
- <https://www.daytona.io/docs/en/observability/otel-collection>
- <https://github.com/daytonaio/clients/blob/main/api-client/src/models/sandbox-state.ts>
- <https://github.com/daytonaio/clients/blob/main/api-client/src/models/sandbox-class.ts>
- <https://www.daytona.io/docs/en/regions>
