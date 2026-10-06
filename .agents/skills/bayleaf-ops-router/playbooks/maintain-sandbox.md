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
   Keep environment explanations in its one skill. API primitives remain available
   to other clients; do not duplicate Python wrappers for agent discoverability.
3. Keep owner credentials internal, routes fixed, redirects disabled, errors
   sanitized, output bounded, and metadata fields allowlisted. Status reads must
   not wake compute or renew work periods. Preview mutations must request native
   V2 permissions; resources distinguish private/public access and port.
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
