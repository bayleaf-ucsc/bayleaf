---
source-skill: bayleaf-ops-router
description: Maintain BayLeaf Sandbox tools, skills, application pins, and hosted browser workspace releases.
last-reviewed: 2026-10-05
---

# Maintain BayLeaf Sandbox

## Vocabulary and ownership

**BayLeaf Sandbox** is the persistent, isolated user workspace. **Browser
workspace** names its interactive browser surface. Chat/Lathe and the API access
the same sandbox files and processes. OpenCode Web, OpenCode, and Daytona are
implementation names. Use them where operational precision matters, not as
service branding. This playbook is for operators, never ship it to sandbox agents.

Read `api/AGENTS.md` and `api/SANDBOX-BROWSER.md` for the canonical contracts.
OpenChamber is the primary graphical agent surface on desktop. Hosted OpenCode
Web is the sole managed agent interface in the sandbox: a deliberately lighter
cloud workspace, not a second desktop. Favor transferable project instructions
and skills without assuming shared app state between desktop and sandbox.
Retired apps (hosted OpenChamber, Nanobot, CollabMD) are out of scope: do not rebuild, publish,
install or restart their adapters, and leave users' existing files untouched.
`api/sandbox-plugin` is a submodule of `bayleaf-ucsc/opencode-sandbox`, owning
tools and the environment skill. The parent owns API routes, launcher, remote
config, and deployment. There is no npm publication workflow for the plugin.

## Change and qualify

1. Inspect status in both repositories. Initialize a missing submodule with
   `git submodule update --init api/sandbox-plugin`; do not reset existing work.
2. Tight authenticated operations belong in plugin tools with typed arguments.
    Keep environment and scheduling-lifecycle explanations in its packaged skills. API primitives remain available
   to other clients; do not duplicate Python wrappers for agent discoverability.
   The plugin loads every `skills/` folder: gate feature-dependent skills in
   `index.mjs`, and decide whether the shared MCP replaces or keeps each one. After
   renaming a skill, remove the empty old directory, which discovery still scans.
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
   With a dirty plugin checkout, npm pretests refuse to run: use
   `node api/scripts/harness-previews.mjs` directly against the existing pin. That
   qualifies neither plugin publication nor real Git loading.
   HTTP readiness does not qualify an app. Exercise its WebSocket or terminal
   through the gateway, and register the preview before launch when the app needs
   its exact public origin.
4. Test with `npm --prefix api/sandbox-plugin test`. Use the parent runtime harness
   against the pinned V2 binary for registration, API bootstrap and permission
   behavior. The internal plugin event stream has no HTTP connection-marker event:
   waiting for one hangs. Subscribe before requesting permission to avoid reply races.
5. OpenCode Web owns its own pinned, verified OpenCode binary, state and private
   preview; bump its release label, version and integrity together in
   `api/scripts/browser-setup.py`.
   Test in an isolated HOME/XDG root, not the operator's service.
   For application releases without an API digest, pin the publisher's checksum;
   never relax verification. Each service declares its own memory floor; shrinking
   sandboxes is a separate, measured change.

## Publish and deploy

**Human gate:** get approval for plugin commit/push and production deployment.
Show the change summary. Main-repository commit/push is a separate decision.

For parent-only changes (gateway, installer, dashboard), skip step 1. Still run the
strict pin build in step 2.

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
5. Wait for propagation before any setup or retry, which can otherwise install the
   old installer source; compare installed content, not a substring. Operator Python
   requests need a named User-Agent (urllib's default gets 403): do not change
   service policy. Verify discovery and authenticated config. Running V2
   locations refresh in ten minutes. New plugin pins are installed automatically; sleeping machines
   get current configuration at their next deliberate launch. Application binary
   changes require a managed restart. Feature flags in the app's launch environment
   also change only at its next launch, not on a remote pin refresh. Do not restart or destroy a
   user's sandbox merely to test a plugin update.

## Production checks and rollback

Use the owner's authenticated browser workspace. Check tool discovery, search's
BayLeaf provider tag, public-page fetch, usage, private preview
creation, denial from an anonymous browser, and revocation. Public exposure needs
explicit scope; use only synthetic content. Test non-owner denial with a synthetic
other-owner fixture, never another person's resources. Clean up test servers
and previews.
Check subsequent turns in an existing session after update. Previously loaded
skill text remains in conversation history even after its definition changes.

Remote failure does not promise last-known-good retention. Native direct fetch
stays locally disabled. For rollback, check out a known published plugin commit,
rebuild the derived pin and redeploy the Worker. Application rollback is a separate,
explicit operation on the user-owned installation. Preserve user files and histories.
