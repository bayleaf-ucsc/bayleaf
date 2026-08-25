---
source-skill: bayleaf-ops-router
description: Upgrade the Open WebUI version powering BayLeaf Chat, exercising Basic and Help in prod, with the no-staging tension made explicit.
status: rough
last-reviewed: 2026-08-25
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

1. Follow steps 4-7 of "OWUI Version Upgrades" in `chat/AGENTS.md` verbatim:
   pull the live spec, edit the image `tag:`, deploy with `doctl apps update`,
   wait for ACTIVE, then `curl -sS -o /dev/null -w '%{http_code}'
   https://chat.bayleaf.dev/health` (expect `200`).
2. If the spec carries the rung-3 `run_command` harness, grep deploy logs for
   the `[bayleaf] rung-3 harness alive` sentinel and confirm
   `Started server process [1]` appears after it.
3. **Exercise Basic and Help manually** (the user does this; the agent cannot):
   a real conversation with each, tool calls where applicable (Code Sandbox on
   Basic, help queries on Help), file upload, skill surfacing. Expect this to
   reveal model-configuration changes the bump inspires (capability flags,
   prompt tweaks). Make those via `prompt-tool-edit.md` / `model-swap.md`
   while still in this workflow.
4. Run `backup-reconcile.md` to pull the post-bump state into the repo. The
   bump is the natural time for it (issue #65): model JSONs, function metas,
   and skill lists all move together.
5. Update the `Current version` line in `chat/AGENTS.md`.
6. Diff the live spec's env vars against `chat/DESIGN.md` §1 and sync drift.
7. Record: one coordinated commit, e.g. `update: OWUI v0.X.Y with model config
   sync and backup pull`.

## Verification

- `/health` returns 200 (automated).
- User confirms Basic and Help behave (manual; this is the whole point given
  no staging).
- Backup pull diff shows only expected changes.

## Rollback

Re-edit the image `tag:` in the spec back to the previous version and
`doctl apps update` again. The repo backup from step 4 provides the model
configs to restore if step 3's changes misbehave: re-push with
`owui-cli models update chat/models/<id>/model.json`.

## Refinement log

- 2026-08-25: drafted from issue #65 and chat/AGENTS.md; never yet run as a
  playbook.
