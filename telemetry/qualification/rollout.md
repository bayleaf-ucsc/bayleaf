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

## Remaining rollout work

Complete the approved plan upgrade, inspect shared usage, measure plausible
90-day storage/write volume, publish approved disclosures, qualify native source
artifact and source hooks, then deploy/enable and verify stored measurements,
credential separation, expiry state and failure independence. Record actual
versions and per-source enablement here. Chat browser arrivals currently lack a
qualified public-only upstream frontend artifact and remain deferred.
