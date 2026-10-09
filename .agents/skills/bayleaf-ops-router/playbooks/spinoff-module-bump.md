---
source-skill: bayleaf-ops-router
description: Bump a spin-off module (Lathe, gws-toolkit, and other toolkits) from Adam's personal instance to BayLeaf Chat.
status: rough
last-reviewed: 2026-08-25
---

# Spin-off Module Bump

## When to use

A newer version of a toolkit with an independent upstream exists (Lathe,
gws-toolkit) or a toolkit was improved on Adam's personal instance
(`chat.adamsmith.as`) and BayLeaf Chat should catch up.

## Upgrade paths (they differ; identify which one applies)

**Repo-homed tools.** Some modules have their own git repos:
- `lathe` → https://github.com/rndmcnlly/lathe
- `gws_toolkit` → https://github.com/rndmcnlly/gws-toolkit

The personal instance runs newer builds first. The authoritative source for
a bump is **the soaked personal instance**, not the git repo tag: pull the
tool source from `chat.adamsmith.as` (it is the thing actually proven in
use), and cross-check against the repo if they should agree.

**Lathe is a read-only upstream dependency, not a BayLeaf fork.** Never modify
Lathe source just for BayLeaf, including the vendored `chat/tools/lathe/tool.py`.
When BayLeaf needs behavior that Lathe does not support, push Adam to formulate
the requirement generally and implement it in the upstream Lathe project, then
test it, soak it on the personal instance, and consume it here byte-for-byte.
BayLeaf-specific policy belongs in supported admin valves, BayLeaf's own gateway
and infrastructure, or separate user/agent guidance, not patches to Lathe.

**Manually ported tools.** Everything else under `chat/tools/` (web_context,
campus_directory, youtube, etc.) is ported by hand when improved. The pull
diff between instances is the change record.

## Prerequisites

- **[HUMAN GATE]** The new version has been running on the personal instance
  for a while (same soak rule as OWUI bumps). No direct-to-BayLeaf first
  contact.
- `owui-cli` env for **both** instances:
  `~/.tokens/owui/chat-adamsmith-as` and `~/.tokens/owui/chat-bayleaf-dev`.

## Steps

1. Pull the current source from both instances:
   `uvx owui-cli tools pull <id>` under each env; diff them. The diff is the
   candidate change set. Watch version fields in the docstring headers.
2. Review the diff for new admin valves (they will need values set in the
   OWUI admin panel before the tool functions), new requirements lines
   (OWUI installs them on deploy), and new tool specs (the model's surface
   changes).
3. Deploy to BayLeaf:
   `uvx owui-cli tools deploy <source.py> <id>` — pass the existing id
   explicitly (deploy ID mismatch is the classic silent-duplicate bug).
4. Preserve existing BayLeaf valves; never copy personal-instance credentials or
   lifecycle defaults. Set any new valves in the BayLeaf admin panel; note non-secret valve
   defaults in `chat/DESIGN.md` if they're worth recording.
5. **[HUMAN GATE]** Exercise the tool in prod through its model (Code Sandbox
   via Basic; Google Workspace via its consent flow).
6. Run `backup-reconcile.md` to capture meta + source into the repo.
7. Record: `update: <tool> to v<version>` (or `chore:` for pure ports).

## Verification

- `uvx owui-cli tools list` shows the new version on BayLeaf.
- User's prod exercise passes.
- Backup pull diff is the expected change set only.

## Rollback

Deploy the privately saved pre-upgrade source to the existing tool ID, then
restore its saved valves if they changed. Do not use `git checkout` to discard
the working copy: it may contain unrelated user work, and the committed source
may not match the actual pre-upgrade deployment.

## Refinement log

- 2026-10-08: Deployed upstream 0.31.0 after refreshing an expired admin token,
  exact-matched against personal live source and commit 4cd5663. All 347 offline
  tests and six isolated OWUI core checks passed; Basic skipped the overview in
  the extra first-time-agent scenario. Source/schema, unchanged valves/grants,
  skill readback and health passed. Full private before/after reconciliation
  found only the expected Lathe/skill changes. Header-bearing calls require exact
  boolean wrapper acknowledgement; API support was deployed separately.
  Production fixture setup found no owner sandbox with automatic creation off;
  coordinate provisioning with concurrent API tests rather than creating a
  second owner-labeled sandbox. No fixture or preview was created by that attempt.
  A coordinated existing test sandbox then passed actual production model-mediated
  public injection/spoof replacement and private denial. Check 401 as well as
  redirects for unauthenticated private requests; BayLeaf filters unconfigured
  browser headers, so headerless regressions must not assume arbitrary passthrough.
  Focused headerless regression passed; six exact leases across three runs were
  revoked with 404 verification, and fixture directories/listener were absent.
  Preserved the shared temporary sandbox because unrelated work had appeared;
  owned-fixture cleanup does not establish permission for whole-sandbox deletion.

- 2026-09-30 (resize investigation): Public Daytona OpenAPI advertises
  `POST /sandbox/{sandboxIdOrName}/resize`, but the hosted API returned HTTP 404
  `Cannot POST /api/sandbox/.../resize` for a verified archived disposable
  1-GiB sandbox. This is a missing deployed route, not an archived-state refusal;
  do not claim hosted in-place resize is supported from documentation alone.
  The test sandbox's deletion was verified; no user sandbox was modified.
- 2026-09-30 (rollout): Promoted unchanged upstream 0.30.7 and set a supported
  creation override for 1 CPU / 2 GiB / 3 GiB using `buildInfo` with the same
  base image as `daytona-small`. Real allocation and cgroup checks passed.
  Direct private/public site previews and public IDE refusal passed after fixing
  a test fixture's missing trusted OWUI user ID. Cleanup, source/valve/grant/name
  readbacks, and health passed. Existing sandboxes were left untouched.
- 2026-09-30 (ownership): Adam made the upstream-only rule explicit: BayLeaf
  consumes Lathe as a read-only follower. Generalize missing capabilities
  upstream rather than creating BayLeaf-only source changes.
- 2026-09-30 (qualification): Lathe 0.30.7 matched the personal deployment and
  upstream, with unchanged valves/dependencies and 276 offline tests passing.
  BayLeaf staging passed five checks, then delegation timed out before exposure.
  The deployment harness nevertheless attempted preview revocation without a
  registration. Run core dispatch and preview qualification separately when
  diagnosing this failure; do not mistake that cleanup message for a leaked URL.
  Core dispatch passed 6/6 on retry. Subsequent preview attempts failed at model
  selection/budget, not an observed service error. Adam requested 2-GiB RAM for
  future BayLeaf sandboxes only; existing environments must not be resized or
  destroyed as part of this rollout.
- 2026-09-24: Lathe 0.30.5 on the personal instance matched upstream `main`
  exactly but had only same-day soak; Adam explicitly waived the gate. The
  release list's `latest` entry was a demo-video artifact, so version was
  established from source frontmatter and both live deployments. Upstream
  CI passed except a nondeterministic model-choice view scenario in the
  isolated monitor. BayLeaf readback and preserved grants/valves passed;
  Adam's Basic + Code Sandbox playtest returned the expected `bash` output.
- 2026-09-20: Lathe 0.29.6 required a coordinated API contract migration before
  the toolkit bump. Back-to-back isolated deployment runs exposed Daytona's
  eventually consistent list returning an already-deleted sandbox; upstream's
  cleanup harness treats the authoritative DELETE 404 as fatal, so wait before
  retrying. Cloudflare bot policy also blocks Python's default user agent on
  preview hosts; browser-shaped smoke requests distinguish that edge policy
  from gateway authorization.
- 2026-09-18: Lathe 0.28.0 removed its unwrapped bearer-token SSH path. Adam
  explicitly approved rollout despite the short soak. The existing production
  smoke was extended to verify both protected HTTP exposure and SSH refusal;
  no restart was needed because dependencies and valves were unchanged.
- 2026-09-17: Lathe preview wrapping was developed upstream and tested in an
  isolated OWUI copy. BayLeaf's 0.24.1 still requires Pydantic AI 1.x; upstream
  0.27.0 requires 2.x. The preview-only staging copy omitted dependency-install
  frontmatter to avoid changing the live process. That is a narrow expose-path
  check, not qualification of the complete upgrade. Adam deferred personal
  proxy dogfooding; do not silently treat staging as satisfying that human gate.
- 2026-09-17 (rollout): Adam explicitly approved adopting the newer upstream
  Lathe in passing. Full regression passed 7/7 and a separate production-tool
  exposure smoke passed. Original source/valves/grants were privately snapshotted.
  OWUI auto-installs requirements on source changes; a restart was used as a
  precaution against cached old-major imports, not demonstrated as necessary.

- 2026-08-25: drafted from issue #65 + chat/AGENTS.md; never yet run as a
  playbook.
- 2026-09-01: `opencode-tinfoil` showed that independently published client
  plugins consumed by the API do not fit this Chat-only deployment playbook;
  treat their BayLeaf integration as ordinary API work unless a package bump is
  the task itself.
- 2026-09-03: `opencode-tinfoil` 0.2.0 validated the release order: publish and
  verify the client package first, then deploy its exact-pinned API consumer.
  Local well-known config probes caught npm-plugin deduplication behavior before
  the production update.
- 2026-09-16: BayLeaf-specific preview-sharing guidance briefly leaked into the
  vendored Lathe source. Reverted it: general `expose()` semantics must change in
  the upstream Lathe project, soak on the personal instance, then flow downstream.
