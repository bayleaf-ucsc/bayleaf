# Minimal diagnostic web surfaces (#113, #97)

**Deployed, arrival collection enabled.** Scope agreed 2026-10-20: public entry and
recovery pages plus passive owner-only metadata, no management application or
message-content viewer. Deployment, telemetry activation, commit and push were
explicitly approved. Inboxes now serves authenticated campus owners (2026-10-21),
with the pilot-owner setting empty and account-generation isolation retained.
Real UCSC sign-in returned
directly to diagnostics and both owner views were inspected with isolated fixtures.
The operator approved publishing diagnostics only while leaving #113 open for an
unresolved private-preview application navigation check; do not call that journey
qualified or attribute its cause to the browser without evidence.
See [production evidence](../telemetry/qualification/diagnostics.md).

## Architecture and limits

Public Proxies/Inboxes apex pages share the small static renderer in
`src/templates/diagnostics.ts`, using the Sandboxes palette and responsive layout.
Presentation is script-free CSS: status pills, relative times with exact UTC
`datetime`/hover values, human-readable sizes, decorative usage bars backed by
text, and `<details>` disclosures for boundaries. Times are relative to the
page-load snapshot; nothing refreshes itself.
Owner snapshots are at API `/diagnostics/proxies` and `/diagnostics/inboxes`.
The API is the existing identity origin: no new OAuth client, cookie sharing,
cross-domain session broker, public RPC, owner credential input or key display.
An allowlisted host-only return cookie, refreshed when OAuth starts, takes API sign-in straight back
to diagnostics, bypassing the main dashboard's provider-key inspection/healing.
Existing API session activity accounting still applies. No compute is created,
woken or probed. GETs never visit a receipt URL or contact an application/provider.

Proxies shows up to 64 retained registration rows, exact owner-scoped, including
expiry and managed credential-binding validity. It does not decrypt upstream
destinations or claim applications are reachable. No new historical ledger.
Chat-only owners need no API-key row: preview ownership is the verified session
email, while Inboxes independently requires its existing account-generation row.
Inboxes reuses existing account-generation-scoped read RPCs, preserving deployment
and pilot gates. It shows at most ten inboxes and five recent unexpired receipt
times, sizes and expiries each. All rendered owner/sender-derived text is escaped;
subjects, sender fields, paths, headers, bodies and credentials are excluded.
Addresses remain text so inspection cannot accidentally deliver a GET receipt.

Unknown/expired/revoked preview browser navigations all redirect with no-referrer
to the same apex `/unavailable`, with no tenant material in the destination.
The recovery page returns 404. Non-navigation failures retain machine-readable
behavior. Neither service reserves application/receipt `/llms.txt` paths.

## Deliberate agent exposure

These are human browser views of existing capabilities, not new agent operations.

| Surface | Decision | Reason and delivery |
| --- | --- | --- |
| Hosted OpenChamber/OpenCode | No new tool | Existing preview/inbox tools retain lifecycle and read authority; no plugin/pin change. |
| Hosted Nanobot | No new tool | Same existing API contracts; no adapter or installation change. |
| BayLeaf Chat | No new tool/grant | Existing preview/inbox integration remains authoritative; no model configuration change. |
| Desktop agents | No new package | No new agent verb or credential scope. |
| Main guide | Expose human handoff | Inbox prose links to browser diagnostics and explicitly distinguishes management authority. |
| OpenAPI | Omit browser routes | Plain Hono browser routes, no new public data API. |

## Local evidence and rollout gates

- TypeScript and generated documentation checks.
- `npm run test:diagnostics`: presentation boundary tests plus API/receiver E2E.
  Same-second receipts read as "just now" without changing their exact timestamp;
  expiry is not labelled as physical deletion; binary storage units use KiB/MiB.
  Private and uninstrumented pages deny scripts and network connections in CSP;
  only explicitly instrumented apex pages allow the arrival client and collector.
- Real API + receiver workerd/D1/R2 E2E: owner isolation, OIDC callback return,
  inert receipt URL presentation, escaped labels, excluded payloads/subjects,
  public HTML/HEAD and plaintext discovery, no inference provisioning.
- Stub-RPC facade: browser pilot/disabled/unbound gates deny before any RPC call.
- Gateway harness: public/private authorization, unknown/expired/revoked recovery,
  machine 404s, tenant paths, cookie isolation and WebSocket revocation/expiry.
- Receiver suite: existing mail/HTTP capture, quotas, auth and cleanup unchanged.
- Collector + client: fixed apex origin/destination, capability-host exclusion,
  exact HTML path inventory, no private/discovery client, generated bundle equality.
- Synthetic browser fixtures: `cd api` then
  `node scripts/test-inboxes-e2e.mjs --preview`. Fixtures contain no real users,
  credentials or enabled telemetry. Serve the printed directory locally.

Rollout used collector policy 4 first, then API/receiver with new arrival switches
false, then explicitly approved activation and actual-browser readback. Public,
private-anonymous, expired/revoked recovery and no-content collection checks passed
without disturbing live applications. Owner/non-owner isolation is covered by local
workerd tests; real owner login and both metadata views passed. A private-preview
application navigation received gateway denial after handoff in this browser panel,
and a real second-account journey has not been exercised. Do not close those gaps by fabricating
a production session or reading someone else's resources.
No D1 migration, new binding or provider credential is required. Rollback is the
previous Worker versions; disable new arrival switches independently. The private
operator dashboard's service breakdown now includes both new destinations.
