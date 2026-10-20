# Telemetry rollout record

2026-10-20, issue [#112](https://github.com/bayleaf-ucsc/bayleaf/issues/112).

## Operator decisions

- Deploy the collector and enable qualified live sources.
- 90-day active retention for all four classes, correcting the earlier 30-day proposal.
- Commit and push the tested telemetry/source/disclosure changes, excluding
  unrelated `reports/` and `research_notes/` work.
- No separate affected-user email for this rollout.
- Workers Paid account subscription approved: $5/month minimum plus usage.

## Provisioning and verification so far

- Wrangler identity: `amsmith@ucsc.edu`, BayLeaf account
  `1a49fb69291d42e23c4ed4dcffce5bbc`.
- The first D1 creation attempt inherited a stale personal-account selection and
  failed with authentication error; no database was created there. Explicit
  account configuration/environment was then applied for subsequent operations.
- Created `bayleaf-telemetry`, ID `e99fb918-ea7e-4599-ac7f-069166a0adbd`, WNAM.
- Applied migrations `0001_telemetry.sql` and `0002_retention_state.sql` remotely.
- `wrangler.production.jsonc` pins the BayLeaf account and new database. It uses
  90 days from first use, disabled ingestion/browser switches, observability off,
  no workers.dev or preview URLs, and a 50ms CPU cap.
- Local collector checks: 54 Node tests, 8 Python tests and production-config
  Wrangler dry-run passed.
- Deployment failed with Cloudflare code 100328: CPU limits unsupported on
  Workers Free. No successful Worker deployment or collection is established.

## Account discovery caveat

`GET /workers/account-settings` returned `default_usage_model: standard`, but
the deployment API explicitly identified Workers Free. The default usage-model
field is not proof of a paid subscription. The earlier billing-usage endpoint
returned 403 and the subscriptions endpoint listed only zone plans.

The browser billing path reached UCSC sign-in. Upgrade approval exists, but the
upgrade and current account usage still require authenticated dashboard access.
Do not infer an upgrade from approval or silently remove CPU limits and enable
collection against shared Free D1 write allowances.

After the operator completed sign-in, the dashboard showed 6,795 of 100,000
requests used today; billing-period usage (October 11–November 11) was 162.43k
requests and 737.58k CPU milliseconds, zero Observability events and build minutes.
These are Workers figures, not D1 row consumption. The approved $5/month checkout
was submitted, but Cloudflare refused activation with: "To claim the Cloudflare
for Students offer, enable two-factor authentication in My Profile >
Authentication, then try again. If someone else manages billing for this account,
they need to enable it instead." No successful paid-plan activation is established.
The operator must resolve this account-authentication requirement before retry.

## Live state after plan activation

Workers plans now explicitly marks **Paid** as current. Deployment with the 50ms
CPU limit succeeded. The first disabled deployment was
`4263bd1e-1e37-40d0-bc8c-d4bbdcd3efef`; active collector version is
`aa660674-fdf8-46d1-987f-572d893b21af`. Dedicated, distinct write capabilities for
five sources and a separate read capability are installed. Anonymous and source
write tokens return 401 on private reads; the operator read capability returns 200.
Local credential material is mode 0600 in ignored `.dev.vars.*` files.

Approved source/disclosure commit `94570a0` was published; the public privacy
notice was fetched and its 90-day/Sealed boundaries verified before activation.

Deployed source versions:

- Probe: `c5251b4f-220f-467b-bf9b-61406cb40922`. Existing catalog probe invocation
  returned 200/ok and its summary was read back from telemetry; no extra inference.
- API: `acb8ad22-5d71-4d79-b2c1-a43e5e3c3afa`, browser arrivals and scheduled job
  hooks enabled. Daily deletion summaries await ordinary schedule execution.
- Sandboxes: `58096da8-7368-4d35-ab49-f1a81054f4b0`. Opening the anonymous public
  home produced an arrival row with exactly 90-day expiry.
- Chat cleanup: deployment `28a67c9e-6403-40bf-a7bc-8a918e74b2e0` reached ACTIVE
  with source `94570a08cdbf38fb1b743c142014681ecb24b649`; Chat health returned 200.
  The initial environment-only update reused old source, corrected with
  `apps update --update-sources --wait`. Ordinary scheduled outcomes remain pending.
- Landing: Pages run `39485090776` succeeded for activation commit `2903006`.
  Actual browser visits to landing, API and Sandboxes public roots each produced
  a stored arrival, with exactly 90 days between observation and expiry.

Browser ingress has a 240/minute shared edge-local rate limit before D1 work,
using the fixed key `browser`, plus the atomic global 120/minute storage budget.
This bounds accepted rows, not all billable edge attempts. Python clients initially
hit zone Browser Integrity Check 1010; the telemetry-host-only exception is recorded
in [edge-ingress.md](edge-ingress.md), leaving other host protections unchanged.

Native source storage measurement supports a 300000ms export interval for 90 days:
approximately 1.12GB at 99 points/export. See [storage-sizing.md](storage-sizing.md).
Full arm64 container/PG qualification and amd64 release boot passed. Evidence was
published in `1d56584`. Native deployment
`b36b8678-f928-4db2-81e1-a3ebcb35fc34` is ACTIVE from that source. The first build
failed unpacking the upstream image (`unexpected EOF`); one unchanged-source retry
succeeded. Runtime guards, public health and five-minute overhead gates passed;
live collector readback verified all five metrics and exact 90-day expiry.
See [native-production.md](native-production.md) for measurements and limitations.

### Still to finish

Verify ordinary scheduled deletion outcomes and complete the queued Chat browser
arrival integration. Native activation and landing publication are verified above.

### Queued for today: signed-out Chat arrivals

Adam requested this addition on 2026-10-20, following research into the existing
v0.12.3 static loader hook. Implement after the native custom-image rollout is
resolved, reusing that image rather than starting a separate frontend fork.
See [the hook research](owui-public-landing-research.md).

- Add a small first-party loader integration with resolved signed-out session
  gating; global hook availability alone does not establish anonymous-only scope.
- Qualify HTTP to HTTPS and root to `/auth` redirects, SPA transitions, signed-in
  visits and login completion, avoiding duplicate events for one arrival.
- Preserve the approved identity-free browser schema: no visitor IDs, account
  linkage, private URLs, query strings or chat content. Count arrivals, not people.
- Verify static-asset startup copying, collector destination/origin policy,
  disclosure coverage, bounded failure behavior and an independent kill switch.
- Enable only after real-browser privacy checks and live stored-event verification.

This is queued work, not an implemented or active source.
