# Inbox quota and effective-limit discovery, 2026-10-21

Adam approved **100 inboxes per owner** as the product default and requested
limits that agents can read from the deployed enforcement configuration.

## Deployment

Receiver `bayleaf-inboxes` version `1440f257-6d6f-4096-8f0c-a353a55c6354`
deployed with authentic Wrangler build hooks and `--keep-vars`. Readback at
2026-10-21 17:30 UTC confirmed 100% deployment, bundled default 100, and
`getLimits(owner)` in the deployed source. No `MAX_INBOXES_PER_OWNER` live override
exists. Every receiver binding matched the pre-deploy snapshot, including D1/R2,
rate bindings, telemetry secret binding and plain-text settings. Restricted-email
creation remains false; receiver, browser arrivals and telemetry remain true.
API pilot generation/gate readback matched the pre-deploy snapshot. Apex HTTP 200.
Bundle: 1606.09 KiB raw / 494.01 KiB gzip; startup 67 ms.

**API deployed:** the coordinated adapter/limits release is live as
`dc01c6ea-35e1-4df9-a160-c39b5bb5f213` (100% traffic). Authenticated
`GET /inboxes/limits` returned max 100, own retained count 6 and remaining 94 at
readback, with `Cache-Control: no-store`; anonymous access returned 401. Public
OpenAPI includes `getInboxLimits`. Exact uploaded modules and unchanged API and
receiver bindings/settings were verified. See `hosted-client-release.md` for pins
and native tool qualification. The receiver change is backward compatible.
No live mass-capacity test or 100-inbox creation was performed. Runtime HTTP
limits readback is a point-in-time snapshot, not a reservation.

## Enforcement and bounds

- Creation still counts every owner row atomically, active plus destroying,
  including expired endpoints awaiting cleanup. The 101st inbox is denied.
- Owner storage stays 500 MiB, per-inbox storage 200 MiB, messages 5000 per inbox,
  receipts 1000 per UTC day. There is no separate owner message-count cap.
  At 100 inboxes the theoretical tiny-message count is 500,000, still bounded by
  the shared byte cap. This is increased potential backlog, not increased sweep
  throughput or a deletion SLA.
- Retirement remains one five-statement, set-based D1 transaction. Owner predicates
  do not expand 100 ids into bind parameters; no R2 I/O occurs in that RPC.
- Cleanup still handles at most five destroying inboxes per invocation, four
  50-row rounds each. Existing row-removal and destruction cursors rotate before
  attempted I/O; prefix reconciliation rotates 50 prefixes. TTL admission remains
  five transitions. No work cap or fairness mechanism changed.
- Discovery reads the same `limits(env)` used by enforcement and owner-scoped D1
  aggregates. No raw env dump, secrets, identifiers, content or other-owner usage.
  Current capacity is a snapshot, not a reservation. Units/counting semantics are
  in the generated contract and focused guide. Approximate per-data-center burst
  bindings are not introspectable, so no duplicate numeric promises are returned.
- API TTL validation now defers the upper bound to receiver enforcement instead
  of hardcoding 30 days while reporting a potentially different runtime maximum.
  Integer/minimum validation and receiver maximum checks remain in force.
- Privacy, retention, auth/pilot gates and inference provisioning are unchanged.

## Verification

- Receiver `npm test`: **140 passed, 2 optional importer checks skipped**, zero
  failures. Added real-D1 99-row fixture + concurrent creates: exactly one 100th
  creation, the other rejected; destroying row counts, other owner unaffected;
  retirement fences all 100 and preserves all cleanup prefixes. No R2 payloads.
- Limits test checks default 100 before first inbox, override 3, pending/cleanup
  bytes/messages, owner isolation, payload/TTL overrides and restricted-create
  gate. Presets above the configured maximum are omitted.
- API real-binding end-to-end: **99 checks passed**, including limits before
  creation and owner-isolated usage. Facade test covers route precedence, ordinary
  and sandbox credentials, missing auth, pilot/disabled/unbound denial, Campus
  Pass/grant denial, no-store and no inference provisioning/provider traffic.
- API `test:docs`, `test:inboxes`, and `npx tsc --noEmit` pass.

## Exposure and historical references

HTTP/OpenAPI/desktop guidance expose discovery through existing owner authority.
Hosted OpenChamber/Nanobot delivery belongs to the adapter release agent, who was
notified of the new route and current default. Chat remains omitted because it
has no new inbox-owner credential path. Diagnostic cards retain their intentional
ten-inbox view cap, while new owner meters cover all inboxes, even before the first.

Historical ten-inbox benchmark fixtures/results remain historical evidence;
their old-default wording is marked as such. Adapter source and release-patch
updates belong to the adapter owner. The coordinating release performed the API
deployment and scoped parent commit. `DESIGN.md`'s separate recovery-documentation
hunk remains outside that commit.
