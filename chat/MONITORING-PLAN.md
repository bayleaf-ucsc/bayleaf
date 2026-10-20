# Chat monitoring direction

Status: local telemetry implementation in progress, 2026-10-20. No production
exporter enablement is implied by this plan.

[Issue #112](https://github.com/bayleaf-ucsc/bayleaf/issues/112) supersedes
[#111](https://github.com/bayleaf-ucsc/bayleaf/issues/111)'s narrower Chat receiver
proposal. The latter retains the October 18 reconnect/auth amplification incident
evidence. The issue referenced this file before it existed in this checkout;
this file establishes the repository-side direction rather than claiming an
earlier local recorder was implemented.

## Ownership

- `telemetry/` owns the proposed first-party collector, bounded D1 history,
  versioned ingestion policies and private query surface.
- Native OWUI metrics remain aggregated at the source. Initial coverage is HTTP
  counters/duration histograms and total/active/active-today user gauges.
- `probe/` continues to execute existing synthetic transactions. It supplies
  approved summaries without extra inference, not a second warehouse.
- UptimeRobot retains availability history, public status and alerts.

## Evidence semantics

Qualify tagged OWUI v0.12.3's real OTLP/HTTP export before deployment. Custom JSON
is not OTLP. Keep metric temporality, start/end times, reset semantics and
histogram buckets. Never sum duplicated global gauges from different workers.
User gauges reflect account activity timestamps, not concurrent generations.
HTTP response timing does not establish full SSE completion. Traces and OTel
logs remain off.

Source-side policy must remove or normalize literal unmatched paths before
export. Receiver rejection alone cannot prevent disclosure during transport.
Do not send identities, tokens, private URLs, SQL, raw errors, conversation
content or arbitrary resource attributes.

The initial implementation favors approved detail with report-time aggregation.
Changing accepted dimensions and sanitization is a versioned policy change;
retaining previously excluded fields still requires deliberate instrumentation.

## Failure independence and fallback

Export must have bounded payloads, deadlines, buffering and retry behavior. Drop
measurements rather than blocking Chat. Missing/stale data must be distinguished
from measured zero. Collection overhead includes three synchronous database
queries for user gauges and must be measured before choosing a production interval.

An independent bounded local flight recorder could preserve recent process/event
evidence during collector outages. It is a fallback proposal, not an installed
capability. Container-local files disappear on replacement; DO stdout retention
and accessibility still require qualification. Neither is a substitute for
external incident evidence that survives replacement. A future recorder must use
the same approved content-free vocabulary, not generic log forwarding.

CPU/RSS, event-loop lag, socket turnover, authentication amplification, pool waits
and generation lifecycle need additional instrumentation. Native OTel does not
establish these measurements. A healthy `/health` remains insufficient evidence
of authenticated usability.

## Before rollout

Use the local qualification evidence under `../telemetry/qualification/` to
review protocol behavior, source minimization, overhead, storage costs and
failure handling. Agree active retention and account for D1 recovery history,
exports and derived artifacts. Update privacy/retention disclosures before
collection, then explicitly approve production source integration and deployment.
