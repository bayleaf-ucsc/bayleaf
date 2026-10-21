# Daytona live qualification

2026-10-20 Pacific (2026-10-21 UTC). **Real state-update deliveries and organization
OTLP metrics qualified. Temporary resources cleaned up; production collection off.**

Adam approved proceeding with live qualification after reviewing the OTLP
transport caveat: per-sandbox telemetry can reach Cloudflare even though the
application discards it. This approval does not establish activation or authorize
publishing the privacy notice, committing or pushing.

## Initial read-only findings

- The existing development Daytona credential is valid. Its current-key endpoint
  returned HTTP 200 and permits sandbox/volume operations, secrets management
  and limit reads. It has no organization/webhook administration permission.
  No credential or user identity is copied into this record.
- Complete sandbox inventory returned one organization, no next cursor, and all
  returned machines carried the existing BayLeaf deployment-label key. No owner,
  sandbox name/ID or raw inventory is retained. This establishes present inventory
  scope, not a guarantee about future organization membership/workloads.
- Organization metadata GET returned 401; organization OTLP configuration GET
  returned 403. No exporter settings or credentials were read or changed.
- The documented webhook initialization-status GET returned 404. This is not
  evidence that webhooks are unavailable: authentication, feature enablement and
  deployed API version remain to be checked through the owner dashboard.
- Daytona's published generated client explicitly describes its webhook access
  endpoint as **Svix Consumer App Portal**. This supports the candidate verifier
  choice but does not replace a real signed delivery/retry qualification.
- The OpenChamber browser opened the Daytona dashboard and was redirected to
  Daytona sign-in. The user must authenticate into the BayLeaf organization.

## Resumed after owner sign-in: verified live behavior

The dashboard initially had no webhook endpoints and no configured OTLP exporter.
Organization webhook initialization was enabled, then one temporary endpoint
subscribed only to sandbox creation and state updates. Two quick-tunnel attempts
timed out before exposing a URL; the unused localhost receiver was stopped.
Qualification used a separate `bayleaf-daytona-qualification` Worker, observability
off, 20-minute admission deadline, fixed-key 60/minute edge cap and separate
read/write capabilities. Its singleton actor used **only memory**, never its
storage API. No production D1 binding, raw payload archive or raw errors.

- Real `svix-id`, `svix-timestamp`, `svix-signature` headers passed exact-body
  HMAC verification, organization checking and state parsing. Manual provider
  replay preserved the delivery identity: retry count increased, unique-event
  count did not. Automatic retry backoff/horizon was not measured.
- The disposable sandbox generated `started → stopping → stopped`,
  `stopped → starting → started`, and `started → destroying → destroyed` events.
  A `started → started` no-op also occurred. Exclude no-ops from transition
  totals; notifications are not starts or evidence of human activity.
- **No `sandbox.created` event was observed.** Its branch has synthetic tests,
  not live qualification. Do not claim complete creation counts or infer them
  from no-op notifications.
- Real organization exports were protobuf, identity encoding, integer-valued
  gauges. All eight approved names were accepted after correcting CPU wire unit
  to `{cpu}`. RAM/storage use `GiBy`; GPU uses `{gpu}`. Stored units are
  `cores`, `GiBy`, `1`. Resource keys were exactly `organization.id`; point keys
  exactly `region.id`, `sandbox.class`. Observed reviewed categories included
  `us`, `earth`, `container`, `windows`. Shared GPU quota uses the earth series:
  do not sum it with overlapping regional series.
- Final `qualification-r3` readback: two accepted organization exports, zero
  rejections; a real per-sandbox metric export excluded without creating fake
  zeros/status; a real log export cancelled without reading its body. No real
  trace export arrived, so that live path is not claimed qualified.
- Minimized real points, never raw exports, also passed actual collector
  validation/storage in **in-memory SQLite**: eight names, sixteen dimensioned
  points, exact 90-day expiry, idempotent retry, no sandbox-identity dimensions.
  No production D1 query or migration.

## Harness correction

Idle actor eviction initially cleared results. A timer kept the actor awake, but
also kept its old receiver code resident across deployments. A fresh actor ID per
revision and revision-bearing readback were necessary to qualify the corrected
parser. Deploy success was not treated as running-code proof. Final receiver
deployment: `a3bac5b5-df29-4633-95c4-f0c674a5c66c`.

## Cleanup and unchanged production state

- Disposable sandbox deleted; exact per-ID GET confirmed **404**. No existing
  user's sandbox was started, stopped, executed in or deleted.
- Dashboard **Disable** restored the exporter to an empty endpoint and no headers.
  Cached exporter settings may take up to five minutes to stop sending.
- Temporary webhook endpoint deleted; dashboard showed no endpoints. Organization
  webhook initialization remains enabled, but sends nothing without subscriptions.
- Closed receiver applied a `deleted_classes` migration removing the temporary
  actor namespace, then Wrangler confirmed deletion of the temporary Worker.
  Cleanup deployment: `6ce37ac6-ed42-462a-96ca-ef24ef3bdeb1`. Deleting endpoint
  history/cloud resources is not proof of provider-wide erasure.
- No production collector deployment, D1 migration, privacy publication, commit
  or push. Both source switches remain false in the production-config draft.
  Temporary credentials are not in the repository.

Local checks: 92 JavaScript tests and eight Python adapter tests passed before
publication. Independent review found no rollout blockers. Bounded OTLP body-read
timeouts now return retryable 503, not permanent schema rejection. Production and qualification bundles passed
Wrangler dry-run. The pre-existing dashboard work was left alone.

## Operator rollout approval, permanent activation pending

On resumption, Adam approved committing/pushing the reviewed privacy/code changes
and explicitly waived affected-user notification, then directed returning to enable
collection. Publish first, then migrate/deploy and activate permanent sources.
Record publication and actual readback rather than treating approval as activation.
Use state-update counts, not an asserted complete creation census. Ordinary
operation, exporter cadence under load, automatic retries and real trace-discard
delivery remain observation work. Continue the
[activation checklist](../daytona/README.md#activation-gates-in-order).

Provider-client evidence:
<https://github.com/daytonaio/clients/blob/main/api-client/src/api/webhooks-api.ts>
