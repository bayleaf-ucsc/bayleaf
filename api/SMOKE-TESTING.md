# Operator synthetic smoke tests

**Status: design blocked, not implemented or enabled.** No migration, production
secret, synthetic principal, machine or provider resource has been created.
This is not an executable runbook. Local architecture investigation found a
lifecycle-coordination prerequisite; do not substitute a signed dummy session
or a client-side cleanup promise for the requirements below.

## Approved first slice

- One outstanding run, including runs awaiting verified cleanup.
- One sandbox per run, one-hour authorization lifetime, fresh exact owner such
  as `<random-run-id>@smoke.bayleaf.invalid`, with no campus affiliation claim.
- Operator-only issuance. A separate purpose/audience-constrained smoke signing
  secret remains on the trusted operator Mac and Worker. Only an expiring
  session cookie reaches the test browser/VM. No public login/mint endpoint.
- Normal `/key` and claim approval provisioning, ownership and credential checks.
- No inference, web-provider, inbox or unrelated capability access. This must be
  server-enforced, including indirect dashboard minting and machine credentials.
- Revocation/expiry applies to API browser cookies, ordinary keys, Sandboxes
  dashboard sessions, sandbox credentials and preview access. Existing ordinary
  users retain their independent credential semantics.
- Additional sandbox spending up to $2 is an operational stop threshold, not a
  provider-enforced hard cap. No claim of automatic dollar enforcement.
- Issuance defaults off. Revocation and expiry cleanup remain available while off.
- No deployment, migration or live resource creation before independent review.

## Blocking lifecycle seam

The current owner identity is not a mutex or provider uniqueness constraint:

1. `src/routes/sandbox.ts:142` calls `ensureSandbox` for low-level operations.
   `src/daytona.ts:325` performs read/discover/create without owner serialization.
   Two requests can both observe absence and create distinct machines. A failed
   provider lookup can also be treated as absence (`src/daytona.ts:94`).
2. Managed setup has a different, stronger path: `src/sandboxBrowser.ts:400`
   persists ambiguous creation intent in the owner Durable Object. That queue
   does not serialize the low-level path above.
3. Authorization at request/job entry does not fence later side effects after
   provider awaits. For example `src/sandboxBrowser.ts:267` reads an account,
   awaits discovery and credential reads, then starts compute at line 282.
   `src/daytona.ts:360` similarly wakes after earlier lookup. Rechecking alone
   still needs an explicit admission/revocation ordering and in-flight policy.
4. Cleanup cannot release the one-run slot after one empty discovery: an
   admitted/ambiguous provider create may appear later. Durable intent,
   quiescence and absence verification must precede completion. Existing
   owner-scoped setup intent covers only one of the creation paths.

**Required decision:** authorize a shared lifecycle-admission/fencing change for
both existing creation/wake paths, or explicitly reduce the first slice to one
existing serialized path and deny the other paths server-side for smoke owners.
The latter would not qualify the complete low-level sandbox API. Do not silently
make that reduction while reporting full API lifecycle coverage.

## Subsequent implementation seams

After resolving that decision, use one durable registry with exact run owner,
expiry, irreversible revoked state and retryable cleanup state. Reserve the
single slot until cleanup is verified; never reuse owner IDs or revive a run.

- `src/utils/session.ts`: keep ordinary OIDC verification intact; separately
  verify smoke purpose, audience, exact registered owner, run and bounded expiry.
- `src/utils/auth.ts`, `src/serviceSessions.ts`, `src/sandboxCredentials.ts`:
  enforce active run validity independently of ordinary-key revocation.
- `src/provision.ts`, `callerAuthority` in `src/sandboxCredentials.ts`: retain
  central provisioning and include run validity in atomic writes. Block smoke
  backend mint/heal before external calls, not only after provider creation.
- `src/routes/serviceLogin.ts` and `src/routes/previews.ts`: allow the reserved
  domain only for the exact registered active owner, never through global signup.
- `src/routes/previews.ts`: include registration reads, active socket lifetime,
  and connection invalidation, not merely the API browser session.
- `src/index.ts` scheduler and the owner controller: expiry must retire pending
  setup/wakes and retry cleanup even when issuance is disabled. Expiring a cookie
  does not terminate applications or compute.
- Cleanup: revoke first, drain admitted work, freshly verify exact deployment
  label/owner and resource IDs, reconcile ambiguous creates, then verify absence.
  Preserve durable tombstones/retries on uncertainty. Never sweep by suffix.

No provider credentials should be minted in this slice. Unexpected provider-key
state must block clean completion until exact ownership is established, rather
than deleting arbitrary handles copied from a potentially poisoned account row.

## Exposure decisions

| Surface | Decision | Reason / delivery |
|---|---|---|
| Trusted operator Mac CLI | Expose after review | Explicit guarded issuance/revoke/cleanup, no root authority in VM |
| Hosted OpenChamber/OpenCode discovery and tools | Omit | Not an end-user or guest authority |
| Hosted Nanobot discovery and tools | Omit | Same operator boundary |
| BayLeaf Chat | Omit | No toolkit, model or group grants |
| Desktop agent onboarding/catalogs | Omit | Must not distribute issuance authority |
| Public `llms.txt`, OpenAPI and `/docs/SKILL.md` | Omit | No public smoke endpoint or advertised capability |

Required local evidence before rollout: real workerd/D1 concurrency, expiry and
irreversible-revocation tests; ambiguous/late create recovery; fresh ownership
checks and unrelated-resource preservation; independent credential and socket
denial; zero inference/provider minting; CLI import/argument/secret-output guards;
ordinary-user regression suites. Source inspection is not that evidence.
