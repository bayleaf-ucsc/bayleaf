# Diagnostic web release: #113 and Inboxes #97

Operator approval: deploy pages with arrivals off, inspect, then enable telemetry,
deploy, commit and push. This is not campus-wide Inboxes enablement or authorization
to redesign the other first-party sites (#114).

## Deployed versions

| Worker | Pages with new arrivals off | Active version |
| --- | --- | --- |
| API / Proxies | `fb8210cd-4fe1-4544-ae6c-d3862d0848e6` | `8cfdc34a-071b-4039-ae1e-ab8033510984` |
| Inboxes | `a35033cc-91ce-49ff-b5ba-467d529ed769` | `d2e5315c-d881-4242-a061-e572cba5bffa` |
| Collector | policy 4 shipped before activation | `5138f433-0f88-4af6-a895-0d7923a1831a` |

Rollback versions: API `a69d6729-d02d-484a-9f25-c033b797fb78`, receiver
`a6062055-474e-4a10-a2b6-af8eaff40c78`, collector
`3194981a-83b3-4d0b-aa34-e2c7888f3f73`. Turn off new arrivals independently with
API `PREVIEW_BROWSER_ARRIVALS_ENABLED=false` and receiver
`BROWSER_ARRIVALS_ENABLED=false`; preserve existing collection and pilot settings.

The API deployed through an isolated stage using the existing pilot staging
helper. Readback compared every pre-existing production variable before/after:
all were preserved, including the account-generation pilot gate. The only added
variables are the two new arrival switches. Published plugin and Nanobot pins
were preserved; no fixture assets, secret changes or migrations were deployed.
Observability remains disabled. No existing application was restarted or probed.

## Live evidence

- `api/scripts/qualify-diagnostics-live.py --live` passed 36 read-only checks with
  collection off, then `--live --arrivals-on` passed the same checks after activation.
  The final script passes 38 checks, adding live OAuth return-marker freshness for
  both diagnostic destinations, without following the identity-provider redirect.
  Covers GET/HEAD parity, plaintext discovery, anonymous diagnostic interstitials,
  CSP/private collection exclusions, unknown-host recovery, API health/spec.
- Desktop/mobile public pages and actual expired-link recovery were inspected in
  the browser. Recovery landed at apex `/unavailable` without the tenant hostname,
  path or query in the destination. Third-party Cloudflare analytics injection is
  blocked by CSP, on both private pages and instrumented public pages; its existing
  console error is not evidence that a beacon executed. The CSP was not loosened.
- Actual browser visits produced at least two `proxies` observations (entry and
  expired-link recovery) and one `inboxes` entry observation. Private operator
  readback verified stored policy 4, exact 90-day expiry, null referring hostnames,
  the fixed coarse network vocabulary, and no tenant host/path/query, credential
  or content fields. These qualification observations are synthetic traffic, not
  unique-person or campus-usage evidence.
- Three isolated leases reused an existing installation identity: public, private
  and expired. Destinations were synthetic, not real running applications; no
  compute was created or woken. Public forwarding preserved a sanitized provider
  401, distinct from gateway denial. Private anonymous access was denied at the
  gateway. Expired/revoked machine reads were 404; browser navigations used the
  identical generic no-referrer recovery destination. This tests gateway behavior,
  not successful application reachability or a new provider integration.
- A separate synthetic HTTP inbox received two synthetic messages, with a bounded
  sender credential and credential-required mode, for human owner-view inspection.
  Exact fixture handles are kept only in private temporary cleanup ledgers, not
  committed here. Cleanup was independently checked as described below.

## Owner qualification, remaining private-preview gap and cleanup

- The operator completed real UCSC sign-in in the browser. It returned directly
  to `/diagnostics/proxies`, not the key-management dashboard. Fresh synthetic
  registrations rendered two valid links (public/private) and an expired link.
  The owner Inboxes page rendered credential-required reception, quota/size/expiry
  readings, two synthetic receipt metadata rows and a deleting fixture, without
  rendering bodies or creating a delivery by opening a receipt URL. No institutional
  credentials were read, supplied or requested in chat. The return marker starts
  with OAuth, so an old interstitial cannot misdirect a delayed sign-in.
- Owner/non-owner isolation, Chat-only owners without API-key rows, pilot gates,
  escaped labels, expiry wording and private CSP are covered in workerd tests.
  A real second-account browser journey has not been exercised. Do not fabricate
  a production session to replace that ordinary-user evidence.
- **Unresolved:** opening the synthetic private preview in the browser panel,
  including an explicit `/__preview/start` handoff, ended at the preview root with
  generic gateway denial rather than the expected sanitized upstream failure.
  The tenant authorization/forwarding path is unchanged by this release. A separate
  isolated receipt probe confirmed that direct panel navigations carry
  `navigate` / `none` / `document` Fetch Metadata and no Origin, disproving the
  initial missing-metadata hypothesis. The cause of the private navigation denial
  is not established. No cookie scope or authorization check was relaxed. The
  operator explicitly chose **publish diagnostics only and leave #113 open**.
- All three exact fixture leases were revoked, returned 404 and were independently
  confirmed absent in API D1, including the fresh owner-inspection batch. All exact
  synthetic inbox messages and browser-metadata probe receipts were deleted;
  independent receiver D1 counts verified zero messages and credentials. Fixture
  inboxes reject reception with 404 and are in durable destruction. Quiescence/scheduled
  finalization and opaque cleanup records are distinct from immediate access
  revocation; final inbox-row removal remains pending and physical erasure is not
  claimed. No existing user inbox or application was modified.

Local checks: diagnostic presentation contracts, API/receiver E2E, facade/pilot
checks, gateway security harness, receiver suite, collector/client/dashboard suites,
TypeScript, generated docs and diff checks. No new management controls, message
viewer, cookie domain, OAuth client, agent tools or inference provisioning path.
