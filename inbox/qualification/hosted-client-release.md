# Hosted inbox adapter release (2026-10-21)

## Follow-up: authoritative capacity discovery (deployed)

Final API version **`dc01c6ea-35e1-4df9-a160-c39b5bb5f213`** serves 100% traffic.
The combined release first shipped as `a9e159d4-3a37-46a2-a254-f913db8ab2c0`;
the final version adds only an SSE OpenAPI truthfulness clarification: disconnect
on server-observed backpressure, since edge buffering can hide a non-consuming
client, with every connection still bounded to 300 seconds. No stream runtime
changes or additional load tests. `test:docs` passed after this clarification.
All final deployed modules match the authentic build; API and receiver settings
and bindings match pre-rollout snapshots exactly, preserving pilot, telemetry and
restricted-email creation disabled.

Authenticated live `/inboxes/limits` returned owner maximum 100, retained count 6,
remaining 94 and no-store; unauthenticated access returned 401. Public OpenAPI
contains the limits operation and corrected SSE prose. Authenticated OpenCode
config returned `ebf705d…`; embedded Nanobot is published-source `e1a7d01…`.
The published Nanobot limits tool independently returned maximum 100.

User explicitly changed the product default to 100 inboxes per owner. The quota
agent owns receiver enforcement and API route/schema/docs changes; this adapter
release does not change backend limits. Receiver version
`1440f257-6d6f-4096-8f0c-a353a55c6354` was reported live by that agent with the
100 default, no MAX override and `getLimits(owner)` RPC. Combined API deployment
proceeded after its final evidence readiness signal.

Published adapter heads, also tagged `inboxes-limits-2026-10-21`:

- OpenCode: `ebf705d43dfb6088329149619e5a68bf5eff3c28`.
- Nanobot: `e1a7d014621f84ca0a0218c3d519bcd48d0f5f11`.

They add read-only `bayleaf_inbox_limits` / `inbox_limits`, respectively, using
fixed owner-authenticated `GET /inboxes/limits`, bounded existing transport and
allowlisted numeric/boolean output. Defaults are explicitly defaults; skills
direct agents to read current capacity before creation or planning. Destroying
inboxes count toward owner usage; remaining capacity is not a reservation.
Malformed/unavailable readings fail without substituting defaults. Neither tool
uses inference, polling, SSE or state mutation. Parent installer allowlist includes
`inbox_limits`. OpenCode 31/31 tests, Nanobot suite and parent installer 8/8 pass,
including overridden limits, malformed capacity, unavailable endpoint, output
allowlisting and existing permission/quarantine regressions.

The main submodule checkouts select these published revisions, delivered by the
final API deployment above. The rollout record below describes the prior
TTL/events production release. No managed user workspace was restarted.

The final published Nanobot MCP trial passed native limits discovery, TTL
creation/shortening and readback, finite-event cursor resume across process
shutdown, exact quarantined mode-0600 download, archive, sender/owner separation,
and actual 60-second expiry denial. The initial attempt stopped before creation
on a stale harness tool-count assertion (8 rather than 9); the corrected harness
now also invokes `inbox_limits` before creation. Exact synthetic inbox destruction
was acknowledged and local credentials/downloads/process removed. Physical
finalization remains asynchronous. This is real MCP/live API on macOS, not a
managed UI, Nanobot gateway, host-sleep or GLM AX qualification.

Adam explicitly authorized publication, parent integration, deployment and the
related parent commit/push. This release changes adapter delivery, not core inbox
code, sender policy, owner scope, persistence or bulk-export exposure.

## Published revisions

| Component | Old production pin | New published pin |
|---|---|---|
| `bayleaf-ucsc/opencode-sandbox` | `eb40edabc1e7dd58a6e9be586115779402ccfd23` | `5458a7dfcf08e1f1577b87cb014110adc3f5e747` |
| `bayleaf-ucsc/nanobot-sandbox` | `16ee3c3ba44f6ae64d6847e64a79fa7949c18c2a` | `c65266337c83bc7453844340cd343ce20e1eb7cf` |

Fetched each upstream main before applying changes in fresh release clones.
Upstream had no divergent commits; each local discovery-only commit was folded
into one coherent new release commit based on the published upstream main.
Existing local candidate clones and prior parent gitlinks preserve the old local
history. No force-push, npm publication or unrelated source edit occurred.

Each repository now has annotated source tags `inboxes-2026-10-20` for the prior
production pin and `inboxes-ttl-events-2026-10-21` for this release. The strict
Nanobot builder requires an advertised ref: advancing main otherwise made the
old production revision unrebuildable. The tags preserve baseline/rollback
buildability rather than relaxing that check.

Parent runtime changes are the two gitlinks and `api/scripts/browser-setup.py`'s
Nanobot allowlist additions: `inbox_lifetime` and `inbox_events`.
See `hosted-client-adapter-followup.md` for tool contracts, safety boundaries,
source review artifacts and the earlier disposable Linux evidence.

## API rollout and readback

- Previous API: `a6dd4a5f-8a03-45d7-91f3-5b5fb14dc9cb`.
- New API: **`dfdd41d4-7ed9-42d1-acb8-f8e0fe64479a`**, independently read back
  at **100% traffic**.
- Staged from the preserved production source, with normal Wrangler build hooks.
  Baseline rebuild matched the active modules except dependency-path comments and
  the old Nanobot provenance ref changing from main to its preserved release tag.
- Candidate bundle differences were exactly the plugin pin, published Nanobot
  asset object and changed installer-module reference. The installer adds only
  the two tool names and their lifecycle comment. Other Python modules match.
- All **four deployed modules** matched the candidate artifacts after trailing
  whitespace normalization. Nanobot provenance is `mode: published`, revision
  `c652663…`; no test fixture assets were deployed.
- Full API settings/bindings matched the pre-deployment snapshot exactly.
  Receiver settings likewise matched; it was not redeployed. Operator-only
  `INBOXES_ENABLED`/`INBOXES_PILOT_OWNER` and
  `EMAIL_AUTH_CREATION_ENABLED=false` remain intact. Observability stays off.
- Authenticated production `/sandbox/.well-known/opencode/config` independently
  returned the exact new OpenCode Git pin `5458a7d…`.

## Affected checks

- Both reconciled release adapter suites passed: OpenCode **30/30**, Nanobot's
  protocol/transport/containment and new TTL/event cases all passed.
- Real V2 Git loading of published `5458a7d…` passed: bootstrap, actual-workspace
  discovery, search/fetch, allow/deny/ask/reject, preview permission resources,
  acknowledgement failures and existing-session use after explicit reload.
- Parent staging: **28 installer tests**, sandbox policy checks, **32 synthetic
  lifecycle checks**, **8 Nanobot installer tests**, and TypeScript passed.
- Tests generated Nanobot fixture assets, then the authentic normal deployment
  build regenerated published assets. Provenance and fetched modules verified
  that the fixture did not escape into production.

## Live published TTL/event trial

After normal cleanup reduced the pilot owner to eight inbox rows, ran
`hosted-client-live.mjs --live` with the clean published Nanobot source at
**`c65266337c83bc7453844340cd343ce20e1eb7cf`**. One synthetic HTTP inbox:

- Adapter-native creation with 120-second TTL returned endpoint `expires_at`;
  native `inbox_lifetime` shortened it to 60 seconds.
- Native `inbox_events` returned an empty `after=now` checkpoint, then one arrival
  from its saved cursor. After MCP shutdown, another receipt arrived; a fresh
  MCP process resumed from the saved cursor and returned only that new reference.
- Sender bearer was denied owner access (401); owner bearer was denied closed
  sender delivery (401). Correct sender delivery succeeded.
- Untrusted read, inert download headers, exact quarantined mode-0600 body save
  and archive all passed. No mail or inference calls were made.
- At actual endpoint expiry, adapter content reads failed and sender delivery
  returned 404. TTL was set through adapter tools, not a direct-API workaround.
- Exact test-inbox destruction was acknowledged; the MCP process and private
  credential/download files were removed. Physical finalization is asynchronous,
  not claimed as immediate erasure.

This passes the previously quota-blocked **published-adapter/live-service** gate.
It was run on macOS: process shutdown is not a claim of managed-host sleep or
Nanobot gateway/UI parity. Those remain separate below.

## Remaining installed-client boundaries

This release does not silently restart the operator's stopped workspace. No real
user session was modified and no persistent test compute was left behind. The
previous independent Linux staging VM was deleted with exact-ID 404 confirmation.

Still distinct from the passing source/runtime/deployment checks: actual managed
Nanobot gateway tool registration, OpenChamber browser permission presentation,
automatic ten-minute running-client refresh, managed relink after sleep, and a
real arrival during host sleep followed by finite-cursor reconciliation. Those
require an isolated synthetic owner/controller or staging deployment: production
managed endpoints target the authenticated owner's existing machine, with no
test-machine-ID override. No broader owner provisioning or quota bypass occurred.

The parent may now launch the authorized bounded GLM AX trial using
`opencode-go/glm-5.3-flash`. No subagent tool is available in this session; no
other model or user session was substituted. Export/HAR remains direct API/scripts,
and live SSE remains an explicitly requested lifecycle-aware script workflow.
