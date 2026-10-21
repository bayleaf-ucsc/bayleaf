# Export/HAR integration qualification

2026-10-21: integrated the reviewed `inbox-export` delta onto main's deployed
TTL/events/SSE baseline. Receiver and API routes were merged selectively.
The original export contract cases register from `test/export-cases.mjs`
against main's harness, avoiding a second stale TTL/event setup.

## Local evidence

- Inbox suite: 91 passing, 2 optional external importer/validator checks skipped.
  Includes native workerd tar/digest/R2, exact bytes, cursor progress, metadata/text
  bounds, cancellation, post-await TTL, counters and migration preservation.
  Controlled race tests use SQLite/Node streams and a digest shim, not production R2.
- Collector: 97 passing, including the 31-series privacy/units matrix.
- SSE regression: 18 passing real-HTTP tests.
- API E2E: 87 passing checks, including exact hashes, HAR parity and owner isolation.
  Facade, docs and TypeScript pass.
- Nonstandard HAR profile: `bayleaf-inbox-receipt-1`. Exact payloads and manifest
  are canonical. Pinned legacy importer evidence: `../EXPORT-INTEGRATION.md`.
  Current GUI interoperability is not claimed.

## Deployment hold

No remote write was performed for export while GLM's real 15-minute SSE trial ran.
Wait for the parent's explicit trial-finished signal. Then reconcile current live
versions/settings/pins, confirm only `0005` is newly pending, apply that inbox
migration, deploy collector vocabulary support, Inboxes, then API. Preserve the
operator gate and telemetry activation. An ordinary API source-default deploy
disables the pilot and is inappropriate.

## Bounded live smoke, after deployment

Supply the existing operator key privately in `BAYLEAF_API_KEY`; from `api/`:

```sh
node scripts/qualify-inbox-export.mjs --live
```

Creates one 60-second synthetic HTTP inbox and sender token, delivers two fixed
synthetic bodies (largest 1 MiB), exports two pages via response-header-to-query
cursor, verifies tar structure, exact hashes, HAR references and standalone parity,
then waits for real expiry and checks 404. Finally destroys only that exact inbox.
Prints counts/booleans, never addresses, credentials or payloads. No existing data
or 25 MiB load. Verify content-free page/byte counters and exact cleanup afterward.
Counters are best effort, not delivery evidence. HTTP smoke does not establish
live SMTP/email export parity.

## Later GLM export trial

Use the public focused guide, `llms.txt` and OpenAPI with safe credential access.
Create a disposable synthetic inbox, export at least two pages into separate
private directories, verify manifest hashes, and explain manual `_file` body
attachment. Send the response cursor as `?cursor=`, not a request header; event
cursors differ. Report unknown responses/timings honestly. Do not infer current
GUI importer parity from structural validity. Clean only the trial's resources.
