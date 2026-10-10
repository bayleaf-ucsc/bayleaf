# Managed Nanobot investigation ✨

Issue [#87](https://github.com/bayleaf-ucsc/bayleaf/issues/87), 2026-10-09.
This POC was deployed on 2026-10-09 for owner evaluation; it is not a
qualification of parity with OpenChamber. The parent approved the finalization
hook, app-secret header, ordinary owner-key storage and private-only tools.

## Implemented behavior

### Production evaluation, 2026-10-09

- Published public `bayleaf-ucsc/nanobot-sandbox`, release `v0.1.0`, commit
  `e6efb58f32af83f84ff761c9109569c07b27a068`. Audited seven source/package files;
  only synthetic test credentials, no generated assets. Strict build passed.
- API Worker: `00bdf215-9c45-4b77-a21f-2345595ab78d`. Dashboard after the shared
  spinner/current-step UI update: `43f1e772-ea58-47a4-bf50-000b7bb8a88a`.
  Main-repo changes remain uncommitted; only the approved new package was committed.
- Active Worker source and installed package metadata verified the published SHA.
  Linux install, supervision, finalization and ready link succeeded. The default
  urllib User-Agent received 403 during model discovery; explicit
  `BayLeaf-managed-services` fixes it. Deployment propagation briefly supplied the
  old installer; verified the actual installed discovery function before success.
- Real Nanobot WebSocket conversation made two model requests, called
  `mcp_bayleaf_usage` once successfully and completed a short greeting. The
  temporary probe waited past `turn_end` and timed out after completion; the
  captured final event confirmed success. Its uniquely named test conversation
  was then deleted through Nanobot's authenticated WebSocket mutation API.
- Direct loopback bootstrap without app auth and with a wrong secret returned
  401. Browser-facing settings and managed logs contained neither owner key nor
  app secret. Jupyter authenticated Lab HTML/status passed; unauthenticated API
  failed and the native token was absent from HTML.
- Owner app links reached the CILogon/UCSC login boundary in the browser panel.
  Full authenticated application-page interaction still requires Adam's fresh
  login. Other-owner production denial, sleep/archive/resume, renewal, resource
  soak and desktop/mobile app UI qualification remain unverified. Synthetic
  gateway/lifecycle evidence above remains distinct from these live gates.

### Design

- `serviceDefs.ts` registers Nanobot on 8792, with its own managed root and slot.
  `sandboxBrowser.ts` adds `finalize`/`inspect_final`: one registration is
  persisted/reconciled, withheld from status until validation, and revoked on
  failure, key rotation or expiry. Other services retain their lifecycle.
- The application-only secret is a purpose-separated HMAC of the operation and
  owner-key fingerprint using the existing preview secret. It is reconstructible
  after controller eviction without DO secret storage. It goes only to the
  protected sandbox file and existing encrypted registration through the fixed
  `X-Nanobot-Auth` option. Existing header validation still applies. A fresh setup
  rotates it; retries of the same operation do not.
- The installer pins `nanobot-ai==0.3.5` in a separate venv, discovers the live
  recommendation/catalog, configures custom-provider standard ZDR inference, and
  verifies authenticated bootstrap `ws_url` against the registered origin.
  Python 3.11+ and Node 22+ are required. Transitive Python dependencies are not
  locked. Upgrades require a deliberate package/layout revision.
- `api/nanobot-sandbox` owns the independent stdio adapter, fixed-origin transport,
  validation, short Nanobot skill and tests. The intended repository is
  **bayleaf-ucsc/nanobot-sandbox**. It is now a published, pinned Git submodule
  (the parent gitlink remains uncommitted). It has no OpenCode imports.
  The five tools exclude public exposure and injected headers. The adapter reads
  the adjacent protected owner-key file instead of serializing it into settings.
- `build-nanobot-assets.py` independently pins and embeds that package. The guide
  links to canonical API/lifecycle/privacy contracts rather than parsing or
  copying another harness's markdown. Generated files update only when their previous hash
  matches; owner edits fail visibly and survive. Memory/history is untouched.
  Dream, heartbeat and idle-compaction defaults are seeded, not forced every run.
- Nanobot has a compact card in the shared dashboard. The subsequent Jupyter
  integration makes five cards: two desktop columns and a full-width final Files
  card, with a mobile stack. See [JUPYTER-POC.md](JUPYTER-POC.md).

## Capability comparison

| Capability | Managed OpenChamber | Nanobot POC |
| --- | --- | --- |
| Standard inference/shared allowance | Yes | Live recommendation/catalog on setup |
| Search / public-page extraction | Native plugin integration | Stdio MCP tools |
| Budget inspection | Native tool | MCP usage |
| Preview / revoke | Private or public, approval integration | Private only; no injected headers or equivalent approvals |
| Shared server project files | Yes | Select `/home/daytona/workspace` in the app |
| Saved conversations and memory | OpenCode/OpenChamber state | Separate Nanobot state, operator-accessible |
| BayLeaf environment knowledge | OpenCode packaged skills | Independently maintained short Nanobot skill, linked to platform contracts |
| Background work | OpenChamber scheduler | Native cron capability; no seeded jobs; Dream/heartbeat/idle compaction initially off |
| Skills/tool updates | Remote OpenCode configuration | Next deliberate setup, with owner-edit conflict checks |
| Browser / Git-worktree workbench | Integrated | No equivalent integration promised |
| Persistent inference credential | Ordinary owner key | Same broad owner key; temporary grants lack refresh/tools |

## Local qualification

Five installer/configuration regressions and MCP protocol/transport checks cover
private-only exposure, reserved ports, unknown arguments and sanitized failures.
The real released Nanobot 0.3.5 fixture exercises bootstrap, wrong-secret/loopback
denial, token-gated WebSocket greeting, settings secret containment, an actual MCP
usage invocation and a reply through mock inference. It uses synthetic
credentials, ephemeral local ports, isolated HOME/state and mocked tool HTTP.
It found and fixed a symlinked-entrypoint bug that unit calls missed.

Controller tests use real workerd/D1/DO with synthetic Daytona: finalization,
renewal, registration-commit recovery, key rotation, preview loss, app-header
override, failure revocation, withheld URLs and coexistence. The existing plugin,
installer, service-session and dashboard checks remain relevant.

Run from `api/`:

```sh
npm run test:nanobot
python3 scripts/test-browser-setup.py
node scripts/harness-sandbox-browser.mjs
node scripts/harness-service-sessions.mjs
node scripts/test-sandbox-policy.mjs
npx tsc --noEmit
# In an isolated venv containing nanobot-ai==0.3.5:
python scripts/harness-nanobot-local.py
```

`npm run test:nanobot` explicitly builds **fixture** assets from unpublished local
source, tests the standalone package and installer, and exercises publication
gates with mocked Git responses. Other Worker npm pretests also explicitly build
fixture Nanobot assets. No test initializes Git or creates commits. Real-runtime
testing consumes that marked bundle; no real BayLeaf/provider credential is needed.

## Independent source pin and embedded transport

The main Worker consumes **source assets embedded at build time**, not a Git or
npm install inside the user's sandbox. The bundle contains only
`nanobot-mcp.mjs`, the short skill, and `_source` metadata: repository, full commit,
published branch/tag references, mode and asset hashes. The installer records
this metadata in `state/nanobot-package.json` and preserves managed-file hashes.
The runtime paths and proven stdio invocation remain unchanged.

Production `build-nanobot-assets.py` requires:

1. The package directory is its own Git root, not an uninitialized directory
   falling through to the parent repo.
2. A clean checkout, including untracked source, with a full SHA and the exact
   intended GitHub origin.
3. That SHA is advertised by a remote branch/tag (peeled annotated tags count).
   Keep release tags so older pins remain rebuildable after main advances.
4. Assets are read from the verified commit with `git show`, not the working tree.

Checks fail closed on uninitialized, dirty, wrong-origin, unpublished or offline
source. This is publication provenance, not cryptographic author attestation.
`--fixture` is an explicit local-test-only mode; it prints UNPUBLISHED and labels
the bundle accordingly. A failed production check does not silently fall back to
that bundle. Wrangler runs the strict build before deployment.

The Worker build runs two independent commands: the unchanged OpenCode plugin
pin builder, then the strict Nanobot asset builder. OpenCode requires no new
commit or publication for this separation; its known Nanobot-only edits were
reverted after inspecting its diff.

## Approval-required repository setup

Completed with explicit approval on 2026-10-09: public repository creation,
initial commit/tag push, submodule registration and coordinated deployment.
The sequence below records the publication procedure, not outstanding approval.

Publication procedure for **bayleaf-ucsc/nanobot-sandbox**:

1. Initialize `api/nanobot-sandbox` on `main`, review its package/skill/tests, run
   `npm test` there, then commit and tag the initial release (such as `v0.1.0`).
2. Create the GitHub repository, configure its origin, and push the commit/tag.
3. From the parent, add the now-existing checkout as submodule
   `api/nanobot-sandbox` with URL
   `https://github.com/bayleaf-ucsc/nanobot-sandbox.git`; absorb its Git directory
   into the parent's submodule storage. Do not commit its ordinary files into
   the parent first. Review `.gitmodules` and the staged gitlink separately.
4. Run `python3 scripts/build-nanobot-assets.py` from `api/` without `--fixture`;
   verify `_source.mode` is `published` and the revision is the intended release.
5. Perform coordinated API then dashboard deployment only after deployment
   approval. Parent Git history remains a separate reviewed action.

## Deployment and remaining gates

No deployment, publication or production runtime mutation was performed.
Publish the independent Nanobot package only with permission, then regenerate
its verified bundle through the standard build. Deploy the API before the
updated dashboard. No D1 migration or new infrastructure secret is needed.

Still unqualified: Linux installation/supervision, live owner/non-owner and
direct-Daytona routes, real inference/tool use, harmless project editing,
sleep/archive resume, expired-link renewal, resource-pressure recovery and
cold/warm/browser memory measurements. Mac fixture results do not establish
Linux resource use or production auth containment. No comparative “lighter” claim.

## Initial source investigation (before implementation)

The following records the rationale and alternatives considered before the
parent approved implementation. Current implementation/evidence is above.

## Inspected version

Nanobot v0.3.5 resolves to commit
`1bb712d3488915ca4ed9ccc1a93067ff722f5ab9`. The issue records an earlier
successful private-preview login and inference trial. This investigation made
no live mutations and did not repeat that trial.

## Lifecycle seam required before implementation

The existing controller installs/configures/starts an application, inspects its
readiness, registers its preview, and immediately reports ready.
Nanobot needs the resulting preview origin in
`channels.websocket.publicWsUrl`. Its WebSocket path must exactly match the
configured `path`. Changing the config file alone is not evidence that the
running channel has adopted it. The HTTP bootstrap uses the channel's in-memory
configuration (`nanobot/webui/ws_http.py`, `_bootstrap_ws_url`).

Proposed smallest shared hook: an optional **post-registration finalization**
step before ready. Persist the registration once, upload its origin in the
managed request, apply configuration, restart only the identity-verified managed
Nanobot process if its origin changed, and inspect both process health and the
authenticated bootstrap's advertised `ws_url`. Only then publish the link in
status. Resume retries the persisted finalization step, rather than registering
another generation on each retry. Failure must revoke the new registration.
Other services retain their existing path. Renewal uses the same hook and can
interrupt an active Nanobot connection; disclose that behavior.

Suggested reserved port: 8792. Suggested service root:
`/home/daytona/.local/share/bayleaf/nanobot`, slot `__nanobot`, dedicated venv,
config and agent workspace. Browser projects point into the existing shared
`/home/daytona/workspace`. Session storage must remain outside the agent
workspace. Do not adopt or overwrite the earlier unmanaged trial.

## Authentication decision

Keep Nanobot's application authentication enabled. Its bootstrap accepts a
secret in `X-Nanobot-Auth` (or bearer authorization) and issues short-lived
WebSocket/API credentials to its frontend. A configured bootstrap secret is
enforced even for loopback callers. A trusted-peer assertion is a different
mode and should not be used: the previous #86 investigation found that loopback
peer identity does not distinguish BayLeaf from direct Daytona access.

Recommended POC candidate: a generated application-only bootstrap secret stored
in the service credentials directory and the encrypted preview registration;
inject only the fixed `X-Nanobot-Auth` header server-side. Extend the managed
registration helper with a typed, service-owned option, not arbitrary
caller-supplied platform headers. This preserves Nanobot's secret check and
avoids exposing the long-lived bootstrap secret through the dashboard. It still
requires direct-path denial, wrong-secret, owner/non-owner, header-override and
real WebSocket qualification before deployment. Nanobot necessarily sends its
own short-lived app session credentials to the browser; BayLeaf/provider keys
must not reach it.

Alternative requiring an explicit UX decision: retain a separate Nanobot login
and an owner-only way to obtain/set its application password. The current compact
service-card API has no password handoff. Do not silently disable application
authentication to avoid this decision.

Sources: `nanobot/channels/websocket/runtime.py` (`WebSocketConfig`),
`nanobot/webui/ws_http.py` (`_handle_bootstrap`), and
`nanobot/webui/http_utils.py` (`_issue_route_secret_matches`) at the pinned commit.

## Tools, credentials, and portable knowledge

- The native stdio MCP configuration supports a command, arguments, environment,
  timeout and explicit `enabledTools`. Use one adapter for search, fetch, usage,
  private expose and unexpose. MCP tool registration is not OpenCode's per-call
  permission integration. Public exposure needs a separate, explicit policy
  decision; do not advertise approval parity.
- Initial research compared the OpenCode plugin's contracts, but Adam chose an
  independent Nanobot package. Reuse API semantics rather than cross-harness
  implementation imports. The short maintained Nanobot guide links to canonical
  platform contracts and names only actual Nanobot tools. Nanobot discovers
  workspace `skills/<name>/SKILL.md`; always-loaded metadata is supported.
- Configure the custom OpenAI-compatible provider from BayLeaf's recommendation
  and model discovery. Ordinary owner keys already support inference and tools,
  share the existing allowance, and are refreshed by deliberate managed setup.
  They are broad credentials readable by same-user sandbox programs, as in
  managed OpenChamber. No provider key is needed in the sandbox.
- Existing temporary inference tokens last at most one hour, authorize one model,
  cannot call web/management tools, and have **no renewal**. Environment references
  are resolved at startup, not refreshed per inference request. They are not a
  drop-in persistent managed-service credential. Do not invent a refresh daemon
  or claim a scoped credential boundary while also supplying the owner key to
  the same process/user.
- Native provider settings return a masked key hint (first/last four characters).
  Verify that the managed environment-reference configuration does not serialize
  the owner key into browser-facing settings or diagnostics during qualification.

## Visible defaults proposed for the POC

Disable Dream (`agents.defaults.dream.enabled=false`), heartbeat
(`gateway.heartbeat.enabled=false`), and idle compaction
(`agents.defaults.idleCompactAfterMinutes=0`). Seed no schedules. These are
different from v0.3.5's enabled defaults. Native cron remains a capability, not a
guarantee of unattended service or wake-up. Explicit user-created automation
needs lifecycle guidance; existing schedules must not be silently deleted.

Saved conversations and editable memory remain server-side and operator-accessible.
Inference uses BayLeaf's standard ZDR lane; that does not make saved histories
ZDR or Sealed. Workspace restrictions are application controls, not same-user
OS isolation. Nanobot does not reproduce OpenChamber's integrated browser,
Git/worktree workbench, or scheduling semantics.

## Proposed dashboard copy and rollout

Name: **Nanobot (preview)**. Description: “Work with an AI agent in a simpler chat
interface, with BayLeaf tools and shared sandbox files.” Notes must explain
separate conversation history, shared allowance/resources, stored owner key,
disabled background defaults, and server-side files. Avoid “lighter” until Linux
and browser measurements support it. Use an intentional two-column desktop grid
for four cards, preserving the current compact styling and mobile stack.

Backend/controller and installer qualification must precede enabling the card.
If shared plugin code changes, publish that dependency before deployment.
Required live gates: authenticated app bootstrap and reply, representative tools,
harmless file edit, expired-link renewal with matching WS hostname, stop/resume,
non-owner denial, direct-auth bypass resistance, provider failure, coexistence,
and launch/memory measurements. No deployments or runtime tests were performed
in this source-inspection pass.
