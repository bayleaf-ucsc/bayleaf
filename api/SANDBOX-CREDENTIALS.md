# Sandbox-specific API credentials

Issue [#90](https://github.com/bayleaf-ucsc/bayleaf/issues/90). **Local implementation;
not deployed or Daytona-qualified.** Migration `0015` is required. ✨

## Authority and custody

An ordinary API key, a temporary inference token, a management session, and a
sandbox credential are separate authorities. `user_keys.revoked` describes only
the ordinary key. There is currently no account-suspension control. Sandboxes
sessions bind to `account_generation`, not the ordinary-key fingerprint; existing
sessions need a fresh login at rollout. Temporary inference tokens keep their
existing model/path/expiry and ordinary-key-revocation rules.

The owner controller issues a random 256-bit `sk-bayleaf-sandbox-…` bearer for one
owner email and exact sandbox ID. It has no automatic expiry. D1 stores only its
SHA-256 verifier and lifecycle metadata. Daytona Secrets holds the bearer, always
with `hosts: ["api.bayleaf.dev"]`. The guest receives `dtn_secret_…`, transmitted
literally in HTTPS Authorization headers. No provider key is minted at issuance.

Authentication checks the active verifier, current owner-to-machine binding and
a passive Daytona control-plane lookup. Missing, deleted, replaced or differently
owned machines fail closed. A Daytona control-plane outage therefore also makes
sandbox credential requests fail. This never wakes compute or refreshes activity.

Standard inference/models, Sealed, web tools, usage, sandbox operations and remote
configuration use the ordinary keyed routes and their existing policies. All
credentials share the owner's provider keys and account counters. Backend mint/heal
compare-and-swap and counter writes recheck the caller's specific authority.
They can work while the ordinary key is revoked without reviving it. Ordinary
provider-healing policy remains in force, including its documented budget reset
tradeoff after an actual upstream key loss.

These credentials do not grant operator authority or access to session-only key
or account controls. Creating a temporary inference token requires an active ordinary key and produces an
ordinary-key-bound grant, not a sandbox-bound grant; it cannot survive ordinary-key
revocation. Managed browser links bind to sandbox credential IDs in the historical
`owner_key_hash` column. Legacy managed links fail closed and are replaced at setup.
Independent user/Lathe preview leases retain their existing explicit-revoke/expiry
policy; changing API credentials does not cancel those separate leases.

Daytona can access the real credential and HTTPS traffic processed by its proxy.
Response scrubbing only promises literal-value replacement. It is not protection
against a malicious allowed service transforming and returning a credential.
Sealed remains application-layer ciphertext with client-side attestation. Neither
TLS verification nor Sealed attestation is disabled for this integration.

## Lifecycle and failure recovery

App setup, rotation and access revocation serialize in the owner Durable Object.
Setup writes a pending D1 row before secret creation; only successful attachment
and a matching current machine binding activate it. Ambiguous creation or failed
attachment leaves an invalid credential and a durable cleanup record. Secrets
have unique, non-identifying names, discoverable by exact name after a lost response.

Rotation changes the verifier and Daytona secret value, preserving its placeholder
and browser authorization ID. Old requests fail immediately; new substitution can
take 15 seconds. A failed/ambiguous rotation revokes access and requires deliberate
setup recovery. Rotation neither issues nor resets upstream provider keys/counters.

Revoke sandbox access immediately invalidates the credential and retires managed
browser links. It does not delete files, stop applications, revoke the ordinary key,
or affect other machines' credentials. Deliberate setup can authorize access again.
Deletion and the inactivity reaper revoke authority before attempting deletion.
Hourly cleanup reconciles external deletion/replacement and retries deletion of
owned Daytona secrets; pending setup older than 20 minutes is invalidated. Cleanup
retains failed work in D1 and processes up to 100 records per run with fair retry.
An ambiguous create with no visible secret retains its exact-name tombstone for
at least a day, allowing later provider visibility to be reconciled.
D1 backups remain subject to the platform's backup-retention policy.

## Existing machines and rollout

Adam reports existing machines are stopped/archived and can remain quiet for rollout.
Attach before their next wake. First attachment to an existing running machine is
refused; its owner must save work and allow the machine to stop. A new, empty managed
machine gets one stop/start for first attachment. A previously mounted placeholder
allows reauthorization without an extra whole-machine restart. Unknown additional
secret mounts stop setup rather than replacing unrelated mounts.

Managed installers replace their `credentials/incoming` / `credentials/owner-key`
with a placeholder. OpenCode bootstrap removes only older credential entries labeled
`BayLeaf managed sandbox` for the exact managed integration. Nanobot configuration
continues to reference its environment. User-authored credentials, config and agent
histories are not searched or erased. Each installed agent service must complete
setup to remove its own managed ordinary-key copy; mounting alone does not sanitize
an existing disk or process environment. Do not describe an existing machine as
fully migrated until those owned copies have been checked. Backups/history may
retain previously copied keys; revoking the ordinary key invalidates such copies.

Before production enablement:

1. Review and publish both edited client packages, then rebuild their verified pins.
   Test fixtures deliberately do not qualify Git publication or package loading.
2. Apply migration `0015`, deploy API and Sandboxes frontend together with approval.
   Do not roll API code back past `0015` while relying on independent sandbox access.
3. Use an isolated test account/machine and non-production credentials to qualify
   genuine authenticated BayLeaf success through Daytona, denied direct-placeholder
   use, and an independently controlled non-allowlisted destination. Echo responses
   cannot prove substitution. Verify HTTPS/TLS trust for curl, Python, Node/OpenCode,
   Nanobot, and the attested Sealed transport without disabling verification.
4. Exercise first attachment, restart, new-process environments, unchanged placeholder
   rotation propagation, failed attachment/retry, concurrent setup, independent
   revoke, ordinary revoke/reissue, and verified machine/secret cleanup. Do not wake
   unrelated users' machines for qualification.
5. Verify each installed agent's old managed ordinary-key copies are replaced at
   its deliberate setup. Keep issue #90 open until live qualification is recorded.

## Local evidence

`npm run test:sandbox-credentials` uses actual workerd/D1 with synthetic providers
for credential authentication, hash-only storage, host restriction in provisioning,
shared accounting, provider mint/heal races, revocation, rotation, external deletion
and failed/ambiguous setup cleanup. It does not emulate or establish Daytona's
HTTPS substitution, response scrubbing, TLS trust or propagation guarantees.
The browser, preview, grant, session, installer and client-package suites cover
their corresponding local integration boundaries.
