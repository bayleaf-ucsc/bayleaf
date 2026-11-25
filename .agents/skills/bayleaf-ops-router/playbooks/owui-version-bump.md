---
source-skill: bayleaf-ops-router
description: Upgrade the Open WebUI version powering BayLeaf Chat, exercising Basic and Help in prod, with the no-staging tension made explicit.
status: rough
last-reviewed: 2026-11-25
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
- Diff `get_builtin_tools` (`backend/open_webui/utils/tools.py`) for new builtin
  categories: a missing key means on, and model lists do not inherit the global
  ones. Pre-seed unwanted categories as false before deploying.
- App Platform keeps the old instance serving while the new one migrates. When a
  migration changes the storage format, check afterward for chats updated during
  the overlap.
- If DB migrations are involved, consider an explicit `pg_dump` of the
  managed Postgres (DO has PITR, but belt-and-suspenders). Take an approved dump
  just before deploying, after pre-pushing the image (step 1), so the gap to the
  migration is short. Remove temporary database firewall access immediately
  afterward. Delete dumps only with the operator's approval.
- For a migration that changes the storage format, rehearse old image to new
  image on a synthetic PostgreSQL database before deploying, and also test
  whether the old image boots on the migrated database.
- Refresh an expired admin token before the bump. Then take full private
  pre-bump snapshots (resources, hidden base models, configs, valves, app spec)
  per `backup-reconcile.md`. Step 3 covers the incident-recovery exception.
- Take new default-on features and changed limits to Adam for a decision before
  deploying.
- If Docker runs out of disk, name the exact images and caches to remove and get
  approval before pruning. Stop Docker Desktop only when asked, with `docker
  desktop stop` (never an AppleScript quit of "Docker").

## Steps

1. Follow steps 4-7 of "OWUI Version Upgrades" in `chat/AGENTS.md` verbatim.
   The version lives in the repo, not the spec: update
   `chat/image/Dockerfile` (base digest) and requalify `chat/image/upstream/`
   hashes and the startup patch (`../telemetry/qualification/otlp-rollout.md`),
   then run `chat/release.py deploy open-webui` (monitored background command); no
   commit or push first. It builds amd64 locally, pushes to GHCR and deploys by
   tag. `--dry-run` still pushes the image but leaves the app spec alone; use it
   to pre-push. Qualification means: refreshed frontend asset hashes
   (`chat/image/browser_assets.py`), both architecture builds, amd64 boot and
   inference, the five-minute PostgreSQL/TLS export and all Chromium arrival
   cases. If guarded upstream sources changed, adapt the patch rather than only
   repinning hashes. Then `curl -sS -o /dev/null -w '%{http_code}' https://chat.bayleaf.dev/health`
   (expect `200`).
2. Grep deploy logs for `[bayleaf] <target version> metrics source minimization
   verified` (one line), printed only after the entrypoint's version,
   environment and source-hash guards pass, and confirm `Started server
   process [1]` appears after it. The earlier `[bayleaf] guarded Chat startup`
   line is printed *before* the guards run, so it does not prove the patch
   succeeded. `doctl --no-prefix` strips the `[bayleaf]` marker too: with that
   flag, match the message bodies.
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
   while still in this workflow. Record scenarios the user did not report as
   pending, not passed.
5. Run `backup-reconcile.md` to pull the post-bump state into the repo. The
   bump is the natural time for it (issue #65): model JSONs, function metas,
   and skill lists all move together.
6. Run `chat/release.py check --record` (refuses if the checkout differs from
   what runs) and update the `Current version` line in `chat/AGENTS.md`.
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
is established, restore the previous `chat/image/` files and run `chat/release.py
deploy open-webui` (earlier digests are in the git history of `chat/DEPLOYED.json`), or
roll back to the previous deployment in the DO console. The repo backup from step 5 provides the model
configs to restore if step 4's changes misbehave: re-push with
`owui-cli models update chat/models/<id>/model.json`.
