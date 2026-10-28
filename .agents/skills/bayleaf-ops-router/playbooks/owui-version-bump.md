---
source-skill: bayleaf-ops-router
description: Upgrade the Open WebUI version powering BayLeaf Chat, exercising Basic and Help in prod, with the no-staging tension made explicit.
status: rough
last-reviewed: 2026-10-22
---

# OWUI Version Bump

## When to use

A new Open WebUI release is out and we want it on `chat.bayleaf.dev`.

**The tension (documented, per issue #65):** there is no BayLeaf Chat staging
server, and Adam's personal instance (`chat.adamsmith.as`) doesn't fully
substitute. So the impact on specific models (Basic, Help) is only discoverable
by bumping prod. We therefore never *just* bump: every bump is paired with
immediate manual exercise of Basic and Help, a backup pull, and readiness to
revert the image tag. Prod is the staging server; treat it accordingly.

## Prerequisites

- **[HUMAN GATE]** Adam has already been running the target version on his
  personal service (`chat.adamsmith.as`) for at least a day, without issues.
  If not, wait. No exceptions; this substitutes for staging.
- Read the release notes for every version between current and target
  (current version is recorded in `chat/AGENTS.md`, "Infrastructure").
  Flag DB migrations, env var changes, plugin API changes, auth changes.
- If DB migrations are involved, consider an explicit `pg_dump` of the
  managed Postgres (DO has PITR, but belt-and-suspenders).

## Steps

1. Follow steps 4-7 of "OWUI Version Upgrades" in `chat/AGENTS.md` verbatim.
   Since 2026-10-20 the version lives in the repo, not the spec: update
   `chat/image/Dockerfile` (base digest) and requalify `chat/image/upstream/`
   hashes and the startup patch (`../telemetry/qualification/otlp-rollout.md`),
   build locally, then **commit and push to `main`**. Deploy with
   `doctl apps update ... --update-sources --wait` (run as a monitored
   background command); plain `doctl apps update` rebuilds the previously
   deployed commit and silently ignores the push. Confirm the build log's
   "Checking out commit" matches the pushed SHA, then `curl -sS -o /dev/null
   -w '%{http_code}' https://chat.bayleaf.dev/health` (expect `200`).
2. Grep deploy logs for `[bayleaf] v0.12.4 metrics source minimization verified`
    (adjust the version), printed only after the entrypoint's version,
    environment and source-hash guards pass, and confirm `Started server
    process [1]` appears after it. The earlier `[bayleaf] guarded Chat startup`
    line (v0.12.4 onward) is printed *before* the guards run, so it does not prove
    the patch succeeded. Older images used `[bayleaf] rung-3 harness alive`.
3. Run an authenticated `curl` smoke test against `/api/chat/completions` for
   Basic and Help, with a known short response. This verifies OWUI's model
   routing without depending on browser automation. It does not exercise the
   browser UI, attached tools, uploads, or skill surfacing.
   During incident recovery, an expired admin credential and unresponsive UI
   must not deadlock an otherwise approved upgrade. Verify managed database
   recovery coverage and preserve the current app spec first, then explicitly
   defer fresh resource pulls and authenticated checks until access is restored.
   Mark them pending rather than treating `/health` as equivalent acceptance.
4. **Exercise Basic and Help manually** (the user does this; the agent cannot)
   when browser acceptance is required:
   a real conversation with each, tool calls where applicable (Code Sandbox on
   Basic, help queries on Help), file upload, skill surfacing. Expect this to
   reveal model-configuration changes the bump inspires (capability flags,
   prompt tweaks). Make those via `prompt-tool-skill-edit.md` / `model-swap.md`
   while still in this workflow.
5. Run `backup-reconcile.md` to pull the post-bump state into the repo. The
   bump is the natural time for it (issue #65): model JSONs, function metas,
   and skill lists all move together.
6. Update the `Current version` line in `chat/AGENTS.md`.
7. Diff the live spec's env vars against `chat/DESIGN.md` §1 and sync drift.
8. Record: one coordinated commit, e.g. `update: OWUI v0.X.Y with model config
   sync and backup pull`.

## Verification

- `/health` returns 200 (automated).
- Basic and Help return a known response through authenticated
  `/api/chat/completions` calls (automated).
- User confirms Basic and Help behave in the browser when that acceptance is
  required; this remains the point given no staging.
- Backup pull diff shows only expected changes.

## Rollback

Before reverting the image, check migration compatibility. An older image may
refuse to start against a database whose Alembic revision it does not recognize;
additive schema changes alone do not establish rollback safety. If migrations
ran, assess database restoration or a tested downgrade with Adam before acting.
Restoration can lose writes since the recovery point. When database compatibility
is established, revert the `chat/image/` commit, push, and deploy with
`--update-sources` (or roll back to the previous deployment in the DO console,
    which reuses its already-built image). The repo backup from step 5 provides the model
configs to restore if step 4's changes misbehave: re-push with
`owui-cli models update chat/models/<id>/model.json`.

## Refinement log

- 2026-10-27 (v0.12.4 preparation): Python 3.12 / Debian 13 image transition,
  but no migration changes and unchanged telemetry dependencies/adapter sources.
  Requalified actual frontend hashes as well as native source guards. Added an
  output-directory override to preserve historical proofs. Cold Chromium runs
  exposed TLS connection resets in the synthetic proxy's five-connection backlog;
  increased its listen queue to 128 and added synthetic-only failure diagnostics.
  Adam confirmed personal soak and authorized publishing the coordinated OWUI and
  already-deployed Lathe backup after qualification passes.

- 2026-10-22: not a version bump, but it exposed stale steps. Moving the image
  from `telemetry/otlp/` to `chat/image/` changed `dockerfile_path` via plain
  `doctl apps update`; DO rebuilt the last deployed commit (2026-10-20), which
  lacked the new path, and the build failed while the old deployment kept
  serving. Steps 1 and Rollback still described editing the spec image `tag:`,
  obsolete since the rung-4 custom image. Now: push, then `--update-sources`,
  and check the checked-out SHA in the build log.

- 2026-10-18: v0.12.3 incident recovery used verified managed backup and a
  preserved spec when the expired admin JWT and unresponsive UI prevented fresh
  resource pulls. Do not make recovery depend on the broken admin UI: defer
  authenticated checks/pulls explicitly, then complete them after recovery.
  The upstream reconnect fix stopped sustained CPU/auth-query amplification in
  initial samples; no custom diagnostics or scaling was needed. Both migrations
  completed; image-only rollback remains unqualified. After token renewal,
  Basic/Help inference and all four private resource pulls passed. Unrelated
  decorative skill-text drift was left for confirmation; browser sign-in passed,
  while full browser/tool acceptance remains outstanding.

- 2026-10-12: v0.12.0 reached ACTIVE using monitored `doctl --wait`; all six
  migrations, startup harness, health/version and admin Basic/Help smokes passed.
  Full private pulls differed only by version-history IDs, kept private rather
  than adding instance-specific lineage to portable definitions. Verified today's
  managed DB backup; corrected image-only rollback guidance for Alembic revisions.
  Adam subsequently confirmed the browser experience feels good.

- 2026-08-25: drafted from issue #65 and chat/AGENTS.md; never yet run as a
  playbook.
- 2026-09-01: first live run to v0.11.3. Perk polling reached ACTIVE precisely;
  health, migration, harness, and authenticated Basic/Help/Canary curl checks
  passed. Browser automation was explored but not relied on; add it only after
  a dedicated cultivation run.
- 2026-09-25: v0.11.4 upgrade passed the personal-instance soak gate, reached
  ACTIVE, and passed health, startup-harness, and authenticated Basic/Help API
  smokes. Backup pull contained only v0.11.4 schema defaults and pre-existing
  metadata drift, not changed prompts or grants. Corrected rollback step references;
  Adam reported the skill system seems okay in the browser. The inactive
  role-scoped skills were not exercised.
