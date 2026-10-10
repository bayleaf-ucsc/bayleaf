---
source-skill: bayleaf-ops-router
description: Maintain BayLeaf Sandbox tools, skills, application pins, and hosted browser workspace releases.
last-reviewed: 2026-10-05
---

# Maintain BayLeaf Sandbox

## Vocabulary and ownership

**BayLeaf Sandbox** is the persistent, isolated user workspace. **Browser
workspace** names its interactive browser surface. Chat/Lathe and the API access
the same sandbox files and processes. OpenChamber, OpenCode, and Daytona are
implementation names. Use them where operational precision matters, not as
service branding. This playbook is for operators, never ship it to sandbox agents.

Read `api/AGENTS.md` and `api/SANDBOX-BROWSER.md` for the canonical contracts.
`api/sandbox-plugin` is a submodule of `bayleaf-ucsc/opencode-sandbox`, owning
tools and the environment skill. The parent owns API routes, launcher, remote
config, and deployment. There is no npm publication workflow for the plugin.

## Change and qualify

1. Inspect status in both repositories. Initialize a missing submodule with
   `git submodule update --init api/sandbox-plugin`; do not reset existing work.
2. Tight authenticated operations belong in plugin tools with typed arguments.
    Keep environment and scheduling-lifecycle explanations in its packaged skills. API primitives remain available
   to other clients; do not duplicate Python wrappers for agent discoverability.
3. Keep owner credentials internal, routes fixed, redirects disabled, errors
   sanitized, output bounded, and metadata fields allowlisted. Status reads must
   not wake compute or renew work periods. Preview mutations must request native
    V2 permissions; resources distinguish private/public access and port.
   For preview-gateway compatibility changes, read `api/PREVIEWS.md` and use
   `npm --prefix api run test:previews` plus the API TypeScript check. Preserve
   the private owner gate independently of app login, sanitize upstream error
   content without erasing app HTTP statuses, and qualify real application/browser
   behavior separately from synthetic gateway tests. No plugin publication is
   needed for a parent-only gateway change.
   Run `node api/scripts/test-preview-compatibility.mjs` for focused source-helper
   regressions without workerd. Record stalled full-harness runs as incomplete,
   with the last stage reached, never as completed migrations or executed probes.
4. Test with `npm --prefix api/sandbox-plugin test`. Use the parent runtime harness
   against the pinned V2 binary for registration, API bootstrap and permission
   behavior. The internal plugin event stream has no HTTP connection-marker event:
   waiting for one hangs. Subscribe before requesting permission to avoid reply races.
5. Fresh setup installs current OpenChamber in an updater-compatible global npm
   prefix and delegates OpenCode installation to OpenChamber. `RELEASE` versions
   our layout, not application versions. Do not add an independent OpenCode pin
   or binary override. Test in an isolated HOME/XDG root, not the operator's service.
   `scripts/test-openchamber-onboarding.py --prefix <global-prefix>` verifies the
   current upstream installer, discovery, and update-prefix ownership. Read the
   upstream module before changing this bridge: 2.1.1's web install action refuses
   a completely absent OpenCode, requiring direct invocation of its installer.

## Publish and deploy

**Human gate:** get approval for plugin commit/push and production deployment.
Show the change summary. Main-repository commit/push is a separate decision.

1. Commit and push the plugin repository. This is the minimum Git publication
   needed before trying it in production. The parent submodule update stays
   uncommitted while Adam evaluates the release.
2. From `api/`, run `python3 scripts/build-sandbox-plugin.py`. It rejects a dirty
   plugin checkout and writes the ignored `.sandbox-plugin-ref.json` consumed by
   the Worker. Never hand-maintain a second revision pin.
3. Run `npm run test:sandbox-browser`, `npx tsc --noEmit`, and relevant plugin
   checks. To verify real Git loading, set `OPENCODE_TEST_GIT_PLUGIN` to
   `github:bayleaf-ucsc/opencode-sandbox#<full-sha>` and `OPENCODE_TEST_BINARY`
   to the pinned executable, then run `node scripts/harness-sandbox-plugin.mjs`.
4. Confirm the BayLeaf Cloudflare account using `cloudflare-cf-tool`; deploy via
   the existing Wrangler workflow. Record Worker version and plugin commit.
5. Verify discovery and authenticated config. Running V2 locations refresh in
   ten minutes. New plugin pins are installed automatically; sleeping machines
   get current configuration at their next deliberate launch. Application binary
   changes require a managed restart. Do not restart or destroy a user's sandbox
   merely to test a plugin update.

## Production checks and rollback

Use the owner's authenticated browser workspace. Check tool discovery, search's
BayLeaf provider tag, public-page fetch, usage, private preview
creation, denial from an anonymous browser, and revocation. Public exposure needs
explicit scope; use only synthetic content. Clean up test servers and previews.
Check subsequent turns in an existing session after update. Previously loaded
skill text remains in conversation history even after its definition changes.

Remote failure does not promise last-known-good retention. Native direct fetch
stays locally disabled. For rollback, check out a known published plugin commit,
rebuild the derived pin and redeploy the Worker. Application rollback is a separate,
explicit operation on the user-owned installation. Preserve user files and histories.

## Evidence and refinement log

- 2026-10-09 (ttyd, local only): old GitHub releases can have no API digest but
  publish SHA256SUMS; pin the exact binary checksum rather than relax verification.
  ttyd header auth only checks presence, while Basic auth checks both HTTP/WS.
  Its native origin check ignores forwarded Host, so qualify the gateway origin
  gate and direct credential behavior separately. Native macOS smoke passed;
  Linux release execution and Daytona browser checks remain rollout work.
- 2026-10-09 (ttyd rollout): `invalid_operation` persisted briefly after deployment
  despite the correct active API bundle and production service binding. Verified
  those through Cloudflare version modules before proceeding; status then converged
  without edits/redeploy. Dashboard launch reached ready in 16 seconds, anonymous
  HTTP/WS denied; browser command qualification needs Adam's fresh CruzID login.

- 2026-10-09 (approved production rollout): published independent Nanobot
  `v0.1.0`, strict embedded-source build, then API and five-card dashboard.
  Linux discovery exposed Python urllib's default User-Agent receiving 403;
  explicit `BayLeaf-managed-services` succeeded on the same authenticated
  recommendation/catalog endpoints. Verify the actual installed discovery
  function after rollout: substring checks were misleading because the client
  name already appeared elsewhere, and a retry during propagation installed old
  source. Nanobot reached ready and performed real inference plus read-only usage.
  Fresh UCSC login remains necessary for interactive app checks in this browser.

- 2026-10-09 (independent Nanobot package): Adam chose `nanobot-sandbox`, not
  cross-harness imports. Staged ordinary source without Git initialization;
  reverted only known Nanobot edits in the otherwise-clean OpenCode submodule.
  The separate asset builder requires its own clean Git root, expected origin
  and remotely advertised commit, while explicit fixture builds serve tests.
  Short Nanobot guidance references platform contracts rather than parsing
  OpenCode skill headings. Publication/init/submodule steps still need approval.

- 2026-10-09 (Nanobot #87 source investigation): The register-after-ready flow
  needs an optional post-registration configuration/readiness hook for apps with
  explicit public WS origins. App authentication and MCP permission semantics
  require decisions before presenting another service as equivalent. Findings
  are in `api/NANOBOT-POC.md`; no runtime qualification or deployment in this pass.

- 2026-10-09 (Nanobot local POC): A fixed post-registration finalization step
  qualifies the actual bootstrap WS origin before surfacing ready. Named helper
  exports reuse plugin transport without a core extraction. Real Nanobot/MCP
  testing caught a symlinked executable-path mismatch missed by unit tests.
  Code-server defaults separately seed only absent settings, preserving JSONC;
  secondary-sidebar hiding does not imply primary-sidebar hiding. No deployment.

- 2026-10-09 (Jupyter integration, local): Reused the service-owned app-secret
  helper with a fixed Authorization mapping; no origin-finalization hook is needed
  for relative WebSockets. Transfer the canonical adapter beside the installer
  rather than duplicate it. Actual workerd tests passed HTTP/WS owner/origin gates,
  encrypted app auth, no inference-key upload, renewal and coexistence. Native
  token auth skips Jupyter XSRF/origin checks, so gateway checks remain mandatory.

- 2026-10-09 (live editor readiness diagnosis): code-server v4.141.0 returns
  HTTP 200 `expired` with `lastHeartbeat: 0` before browser activity; `/healthz`
  intentionally does not refresh that heartbeat. Accept both documented activity
  states behind the configured/live-process gates. dufs's health is unconditional
  `OK`. Local regression added; deployment belongs to the parent session.

- 2026-10-09 (review fixes and dufs, local only): Alarm tests must advance a fake
  clock to the actual scheduler deadline, not force every record forward. The
  third service needed archive asset/layout callbacks, not controller branches.
  Provider create failure semantics support only narrow authorization rejection
  classification; other failures retain owner-wide ambiguity protection.

- 2026-10-09 (managed code-server, local only): Parent-only service adapters need
  no plugin publication or new D1 column. An owner DO has one alarm: service
  expiry/revocation scheduling must be centralized, and the existing managed
  owner-key gate is deployment-based, not slot-based. Live qualification deferred.

- 2026-10-08 (dashboard deployment): Migration 0014 applied; API
  `92c3b96b-aa76-4e82-a2b6-decb408c7f8b` and Sandboxes
  `b6007714-d648-4cab-b44d-57c4c2f5e893` deployed with approval. Live sign-in
  required strict-origin on form-bearing pages and a continuation document to
  avoid Chromium form-action redirect-chain blocking. A stale controller ID
  required passive rediscovery after confirmed 404. Live handoff/API controls
  and updated regressions passed; application setup remains owner evaluation.

- 2026-10-08 (dedicated managed-service dashboard, local): This parent-only move
  required no plugin release. A named API binding and two-host login broker keep
  host-only cookies and one lifecycle authority. Login wake must retire stale
  ready-app state after sleep, without creating compute or installing apps.
  Broker/adapter, installer/lifecycle, progress, preview and grant tests passed;
  synthetic browser setup reached ready. Deployment and live CILogon remain pending.

- 2026-10-08 (issue #86, local implementation): header-bearing registration tests
  run directly with `node api/scripts/harness-previews.mjs` while the plugin is
  dirty; the npm pretest deliberately rejects an unpublished plugin checkout.
  This tests the actual Worker with the existing generated config pin, not
  publication or real Git loading of the edited plugin. Keep those qualifications
  separate. Registration JSON bounds must account for escaped ASCII values.
  Follow-up: published plugin `ba62f51` after review and local tests, verified real
  V2 Git-package loading, deployed Worker `d150ca87-5fd8-4925-bb60-f35d1ee26022`,
  and confirmed live OpenAPI and authenticated config pin. No parent commit/push.
  Live Nanobot exposed initial WS greeting loss: accept upstream sockets only
  after relay listeners exist, including across awaited authorization rechecks.
  Regression reproduced the loss; 35 gateway checks passed after the fix, deployed
  as Worker `b814079b-4391-4fc0-95eb-10009c7b6b18`. Three fresh live Nanobot connections
  then received `ready` plus subsequent replies; disposable-resource cleanup verified.

- 2026-10-08 (preview compatibility production): operator-approved Worker
  `5bc31933-6d94-4390-b15e-a9c66ab2b171` deployed after focused credential/ETag
  regressions and TypeScript checks. Existing private Nanobot login and live
  BayLeaf chat passed in OpenChamber's browser; anonymous bootstrap remained 401.
  Deployment also required Nanobot's explicit `publicWsUrl`: its default advertised
  loopback behind this proxy. Preview renewal must update that URL. No plugin
  change or Git publication; broader app/body containment remains unqualified.

- 2026-10-08 (Astra review fixes, local only): JWT exclusion must use Hono's actual
  signature decoder, covering padding/alphabet/pad-bit aliases, not a spelling
  regex. Validator containment must cover hostname, first DNS label and stripped
  signed credential. Added fast actual-source tests and bounded harness stage
  diagnostics; focused suite, 30 grouped/five fixture checks, TypeScript and diff
  checks passed in the implementation rerun. Independent stalled runs remain
  incomplete evidence and their stall cause is unknown. No deploy.

- 2026-10-08 (preview HTTP compatibility, local only): Parent gateway changes
  needed no plugin update or publication. Synthetic app auth/status/304 tests
  cover the compatibility boundary, not real Nanobot browser qualification.
  Miniflare renders outbound mock exceptions as HTTP 500; transport-error tests
  must inject a fetch rejection inside workerd to distinguish the two. No deploy.

- 2026-10-06 (scheduling skill): Background source inspection of published
  OpenChamber 2.1.1 found filesystem-persisted definitions, in-process timers,
  no wake mechanism and no startup catch-up. Added packaged scheduling guidance,
  distinguishing retained state from asleep compute and eventual deletion.
  Unit, lifecycle, TypeScript and real V2 published-Git discovery tests passed.
  Published plugin `de3d90b`, deployed Worker `7eb2198e-1471-4685-b9ff-4e3655eb15c9`,
  and verified the live authenticated configuration selects that exact pin.
  No live schedules or sandbox lifecycle experiments were performed.

- 2026-10-06 (continuous progress): Recalibrated from the owner's 26-second fresh
  timeline and replaced segment fills with one frame-interpolated bar. Added
  executable timing/reduced-motion/duplicate-event/cleanup tests and a synthetic
  timeline replay. In-app browser inspection verified rendering and changing fill;
  the background tab suspends frame animation, so it does not qualify foreground
  perceived smoothness. No live sandbox restart required for dashboard changes.
  Deployed Worker `fae7e795-a991-4a47-a828-6532b54d4b43`; plugin pin unchanged.

- 2026-10-06 (plugin diagnosis): Live owner sandbox had the current plugin active
  at `/home/daytona`, but no BayLeaf integration/plugin at the seeded
  `/home/daytona/workspace` location. Installer bootstrap and readiness calls omit
  the location header, masking this mismatch. Qualify discovery at the actual
  browser project, not just the server's default directory. No repair/restart performed.
  The workspace subsequently converged without intervention: this is a readiness
  race, not permanent location-scoped installation. Setup now connects/verifies
  the seeded workspace explicitly; real V2 regression covers a pre-opened workspace,
  distinct default directory and a subsequently opened project.
  Deployed Worker `f7cce391-040f-464b-8aa7-aa9d49fb2d87`; owner will exercise
  Restart interface. Plugin pin unchanged; no managed runtime restart by the agent.

- 2026-10-06 (24-hour links): Removed extension/end-session
  API/UI controls and decoupled supervisor lifetime from link expiry; centralized
  medium-size creation with 1-hour idle stop and 24-hour stopped archive. Installer,
  lifecycle, rendering and gateway security tests passed. In-app browser initially
  failed; after Adam requested a retry, synthetic Resume/Open controls worked on
  desktop and mobile with no reported page errors. No Rodney or live sandbox
  restart was used. Published skill update `5e20fdf`, deployed Worker
  `09db2448-eb9f-4c72-98a7-6e4ac9834125`, and verified live routes/config pin,
  passive status, cron settings, Lathe valves, and Sealed health. No existing
  machine was restarted/resized. Sleeping-link resume is issue #85.

- 2026-10-06 (retention): Built a parent-Worker daily inactivity reaper, tested
  locally and read-only against production (six candidates, eight machines).
  No plugin change: plugin publication steps did not apply. Subsequently deployed
  Worker `564723be-75de-4dc3-adfa-e39bacc510cd` with deletion enabled by approval;
  verified schedules/settings, without triggering an immediate sweep. Daytona
  stopped-state auto-delete did not enforce archived retention; keep lifecycle
  policy in `api/RETENTION.md`, and gate the initial overdue deletion separately.

- 2026-10-05 (setup-only display): Worker `2208920e-1fd0-46f9-b2cb-fa7eb4de5193`
  limits the animated meter to active setup. Completion/failure hides the visual;
  diagnostic history remains available. TypeScript passed.

- 2026-10-05 (progress animation): Worker `31be04a1-0c8d-482a-82fe-fada4060b754`
  adds smooth exponential pseudo-progress and a waiting pulse, with reduced-motion
  support. TypeScript and browser preview checked; the animation adds no polling.

- 2026-10-05 (estimated progress and naming): Published plugin `6a393ed`, renaming
  the skill to `bayleaf-sandboxes`, and deployed Worker
  `f034aaac-1cd7-49ed-8f46-7901cb7439c8`. Rename tooling left an empty old skill
  directory that discovery still scanned; removed it before qualification.
  Milestone estimates use one observed run, not a learned performance model.

- 2026-10-05 (setup diagnostics): Worker `02c431f1-90d0-4d19-b7dd-d6d942677a17`
  adds bounded steps/timings and retained failure summaries. A leftover exact
  version check had rejected healthy OpenChamber 2.1.1; qualification now exercises
  the actual readiness predicate. Status-only work used installer/lifecycle tests
  and a synthetic browser preview, without restarting owner compute.

- 2026-10-05: V2 2.0.23 passed isolated bootstrap, Git-pinned package installation,
  search, fetch allow/ask/deny/reject and reload. Real ten-minute refresh installed
  changed exact npm pins in synthetic tests; the Git package installation was
  verified separately. Adam rebuilt his sandbox and confirmed production search
  with the “Searched with bayleaf” tag. Native usage/exposure tools are a follow-up;
  do not treat the earlier production search check as their qualification.
- This playbook was extracted from that release; its full sequence has not yet
  guided an independent maintenance run. Record deviations here after each run.
- 2026-10-05 (native tools): Followed the plugin commit/push, clean-pin build,
  real Git-installation test and Worker deployment sequence for `ec34220`.
  Usage/status and expose/revoke passed real V2 approval with synthetic API
  responses. Worker `2bc2d204-99a3-44ae-85c0-52446d9d2376` selects that release;
  production tool use is still a separate check. Retired Python wrappers and
  reduced the shipped skills to one environment guide.
- 2026-10-05 (scope reduction): Removed the redundant in-sandbox status tool;
  plugin `da32f3a`, Worker `7d07c1ba-4d2c-4ec5-bc9c-607c4a82d682`.
  Keep the tool surface to usage, expose/unexpose and BayLeaf web tools. File
  management already has local tools and the GUI; destruction belongs in the
  external dashboard/API. This is interface scope, not credential enforcement:
  code holding the owner key can still call the broader API.
- 2026-10-05 (upstream-owned onboarding): Fresh setup now installs latest
  OpenChamber in a private global prefix; upstream installs OpenCode. Clean-HOME
  qualification observed OpenChamber 2.1.1 and OpenCode 2.0.24, verified discovery,
  prefix ownership and reuse. Its install API rejects missing binaries, so we use
  the upstream installer function directly. Container/foreground update UI and
  restart behavior remain an upstream limitation, not an automatic-update guarantee.
