# Account retirement and recovery qualification, 2026-10-21

**Gap confirmed locally; proposal only, no production change.**

Historical baseline: the later [local hardening revision](hardening.md) implements
the normal retirement handoff and replayable fences. The executable harness now
tests that revision, including the initially unfenced handoff window. The recovery
limitations below remain material; no deployed change is claimed.

## Current behavior

The API's `src/userRetention.ts` (introduced by `d826e84`) claims inactivity and
deletes users/keys in one API D1 transaction. It detaches provider keys into
`user_retention_outbox`, but neither captures `account_generation` there nor calls
the inbox binding. Inboxes are not an eligibility dependency. An eligible account
therefore retires while its inboxes remain **active**, with credentials and
reception unchanged. Existing messages eventually expire, but continued receipt
can keep stored content present indefinitely, bounded by inbox quotas.
Inbound receipts do not refresh the API account's owner-activity clock. Passive
receiving is therefore not evidence against 18-month owner inactivity; changing
that policy would require an explicit decision, not a sender-controlled renewal.

`api/src/routes/inboxes.ts` scopes every owner RPC to the authenticated
`user_keys.account_generation`. `api/src/provision.ts:provisionToken` behaves
differently in two cases:

- Ordinary revoke/reissue reuses the row and generation, intentionally preserving
  inbox ownership. This is credential rotation, **not account retirement**.
- After retirement removes the row, provisioning inserts a fresh UUID generation.
  A normal new login/key at the same email cannot read the old inboxes. It also
  cannot discover or destroy them. That prevents ordinary re-registration from
  inheriting content but does not remove orphaned reception endpoints.

Restoring an older API database can reintroduce the old generation, credentials
and identity association. There is no inbox-side retirement fence to deny that
generation. Restoring inbox D1 can independently revive `active` rows and metadata;
R2 may or may not still contain referenced payloads. Backup recovery is not
equivalent to issuing a fresh account. No deployed restore was performed.

## Local reproduction

```sh
cd inbox
node qualification/retirement-check.mjs
```

PASS on 2026-10-21, workerd/Miniflare, separate real API and inbox D1 databases,
real inbox R2 and RPC, outbound network denied:

1. Create a synthetic inactive API user with a generation, an HTTP inbox and a
   sender credential. No inference keys or compute dependencies are present.
2. Invoke the actual `retireInactiveUser` transaction. It returns true and the
   API key row is gone.
3. The old generation's inbox is still active. Delivering with its pre-retirement
   sender credential succeeds and creates a readable receipt.
4. Insert a fresh generation for the same email, modeling the relevant fresh
   provisioning INSERT. Its inbox lookup is `not_found`.
5. Restore the old generation value in API D1. A service-binding call using that
   restored value reads the old receipt again.

Step 5 demonstrates the missing ownership fence, not a tested Time Travel/OIDC
restore procedure. The harness calls RPC with the database generation directly;
it does not claim to test browser session recovery or old-key HTTP authentication.
It verifies the data/authority relationship responsible for resurrection.

## Proposed protocol: transactional outbox plus durable generation fence

This is **not small enough for a safe incidental fix**. A pre-delete
`listInboxes` check or best-effort `destroyInbox` loop is insufficient: the two
databases cannot commit atomically, a caller can already be in flight, and a
crash can lose the old generation after API deletion.

1. Add a dedicated API retirement outbox containing opaque old
   `account_generation`, retirement timestamp and acknowledgement state. Insert
   it in the **same eligibility-rechecking transaction** that removes the API
   identity. Preserve the provider outbox's existing identity-free semantics.
   Accounts without a key/generation have no inbox authority to enqueue; malformed
   or empty generations on existing key rows must block retirement and be reported
   as aggregate pending/error counts, not silently skipped.
2. A trusted service-binding-only `retireOwner(generation)` RPC, unavailable to
   ordinary owner HTTP routes, executes one inbox D1 transaction: persist a
   non-expiring retired-generation fence, insert cleanup prefixes for every inbox
   of that generation, mark them destroying while preserving first request time,
   and delete every sender credential. Do not enumerate objects or physically
   delete payloads inside that acknowledgement transaction.
3. The fence must be checked atomically by `createInbox` and receipt reservation.
   An already-authorized API request cannot recreate an inbox for a retired
   generation. Reads/mutations must also deny fenced generations, including after
   partial recovery. Concurrent credentials cannot be reissued for destroying
   inboxes. In-flight puts continue through existing pending/late-write cleanup.
4. Acknowledge **fence and destruction requested**, not physical erasure. Persist
   acknowledgement API-side only after the RPC succeeds. Retry errors, binding
   absence and lost acknowledgements idempotently, even when new inbox creation
   or receipt feature flags are off. Do not gate retirement cleanup on
   `INBOXES_PILOT_OWNER`; that is a user exposure gate, not deletion authority.
   Keep bounded outbox progress independent of fresh candidate discovery and of
   provider deletion outages. Report pending cleanup honestly.
5. Decide the acceptable interval between API retirement and inbox fencing. An
   outbox gives eventual cleanup, not atomic immediate cessation across services.
   If policy requires no post-retirement reception window, a larger two-phase
   design must fence/revoke creation authority before API identity removal. That
   also needs an explicit policy for a concurrent returning user or new hold.
6. Specify retention/disclosure for generation fences and acknowledged retirement
   records. Opaque generations are still linkable metadata, unlike the current
   owner-free cleanup prefixes. New accounts get new generations; fences never
   transfer ownership to an email and never reactivate retired addresses.

### Recovery is part of the protocol

A fence stored only in the restored database can itself be rolled back. Before
reopening either service after recovery: keep receipt/owner access disabled,
reconcile retired generations from a deletion ledger **outside the restored
snapshot's rollback domain**, replay fences/destruction and verify them. If no
such ledger survives, invalidate pre-recovery generations and endpoints rather
than trusting restored `active` state. Restoring indexed text in D1 is itself a
content recovery even if raw R2 payloads are gone. Operator recovery documentation,
privacy disclosures and backup windows must name these residuals explicitly.

This ledger/recovery decision is unresolved; do not claim "without resurrection"
from an inbox fence alone. Provider backups cannot be promised immediately erased.

### Acceptance tests for implementation

- Atomic outbox capture/rollback with eligibility, holds and activity races;
  generation absence, keyless user and provider failure cases.
- Real two-Worker lost-ack/retry test, binding outage, service disabled and pilot
  restriction changes; no cross-owner effects and no identity/content logs.
- Concurrent create, credential mint, receipt reservation and delayed R2 put
  spanning retirement: permanent fence wins, cleanup remains discoverable.
- Maximum owner's ten inboxes enter destruction without doing unbounded physical
  work in the retirement RPC. Sweeps obey the global budget discussed in
  [cleanup qualification](cleanup-bench.md).
- New account at the same email never inherits old content; ordinary key rotation
  still preserves non-retired ownership.
- Independently restore API D1, inbox D1 and both together. Replay the surviving
  ledger before enablement and prove old generations/addresses remain denied.

**Operator decisions needed:** eventual vs. immediate reception cutoff, durable
fence/ledger retention and recovery authority, and implementation approval. Until
then account-retirement integration remains a campus rollout blocker.
