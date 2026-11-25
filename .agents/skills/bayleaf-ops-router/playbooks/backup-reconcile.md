---
source-skill: bayleaf-ops-router
description: Pull live OWUI state (models, tools, functions, skills) back into the repo backup, triage drift from noise, and reconcile DESIGN.md. The recovery-oriented backup procedure.
status: stable
last-reviewed: 2026-08-25
---

# Backup Reconcile (prod → repo)

## When to use

Scheduled drift catch-up, after any prod-side change series, or as the final
step of `owui-version-bump.md` / `prompt-tool-skill-edit.md` /
`spinoff-module-bump.md`. Also run standalone whenever prod might have
drifted.

## Prerequisites

- `set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a`
  Refresh an expired admin token before starting.
- Clean git tree (so the diff is purely this run's findings).
  If the tree is already dirty, pull all resources into a private temporary
  directory first and compare without overwriting in-progress work.
- Around a change, take full private pulls before and after it, including hidden
  base models and valves, so the diff isolates the change. Compare the valve
  JSON itself, not log files.
- **Public-backup boundary:** pull models, tools, functions, and skills only.
  Never pull groups, users, chats, or course rosters into this repository.
  Model `access_grants` contain principal UUIDs, not group membership; treat
  roster-based membership as deliberately outside this backup.
- For global admin edits, also save `owui-cli --json configs show` and
  `owui-cli --json configs admin` to private, mode-restricted files outside the
  repository (see Private snapshots in `../SKILL.md`). These exports can contain credentials. Record only explicitly
  reviewed non-secret values in DESIGN.md; never copy the full exports into
  the public backup. Without a prior private config snapshot, report current
  values rather than claiming an exact before/after diff. Config keys are flat
  and dotted, not nested. Diff after any admin UI edit: saving a form can also
  write hidden defaults, so ask about each one.
- Resolve temporary export paths with `realpath` first. On macOS `/var` is a
  symlink to `/private/var`; owui-cli rejects export directories containing
  symlinks, including otherwise ordinary `$TMPDIR` paths. Check each command's
  exit status before treating a snapshot as complete.

## Steps

1. Pull all four resource types (full pull-all, never cherry pulls; see the
   id-drift lesson below):

   ```bash
   uvx owui-cli tools pull-all chat/tools/
   uvx owui-cli functions pull-all chat/functions/
   uvx owui-cli skills pull-all chat/skills/
    uvx owui-cli models pull-all chat/models/
    ```

   `models pull-all` can omit hidden underlying model records (e.g. the public
   read grant for `openrouter.z-ai/glm-5.3-flash`). Verify each known base
   model by ID with `models show` or `GET /api/v1/models/model?id=...` and
   retain its recovery definition. Do not delete a repo-only base model just
   because it is absent from the pull-all directory.

2. `git status --short chat/ && git diff --stat chat/`, then triage every
   changed file into exactly one bucket:

   | Bucket | Examples | Action |
   |---|---|---|
   | Expected change | the thing this run is for | verify, keep |
   | Real drift | activation flips, version bumps, copy edits, new items | **ask the user whether deliberate** before treating as canonical |
   | Rotating noise | `access_grants[].id`, `created_at`/`updated_at`, `user: null` | ignore, don't chase |
   | Instance lineage | migration-assigned `version_id` | keep in private snapshots, never in the repo |
   | Format evolution | `has_user_valves` moved into `meta`, `content_length` dropped | accept the new shape |

   For a change run, commit only its own artifacts (after the full pull). Leave
   known unrelated drift and live-only decorations in skill text alone unless
   the user decides otherwise.

3. Check for **id drift**: a repo dir whose name differs from the JSON `id`
   field, or an old dir that pull-all didn't refresh (source tracked but
   meta never was makes this invisible to cherry pulls). Renames appear as
   one untracked dir plus one stale tracked dir; resolve by `git rm -r` the
   misnamed one and letting the correct one land.
4. Reconcile `chat/DESIGN.md` against the pulled state: activation flags in
   the functions/skills tables, model capability and skillIds lists, tool
   surfaces, and the §8 directory tree. Expect several stale spots after any
   active month. When a capability was removed or renamed, also reconcile
   `chat/RETENTION.md` and companion skills.
5. Record: one `update: sync chat backup with prod drift` commit
   (squash-merged, never per-file).

## Verification

- `git diff --cached` contains no `data:image` base64 blobs (models pull-all
  extracts profile images to sibling files; any inline blob must be stripped
  per `chat/AGENTS.md`'s strip workflow).
- When a course roster was handled during the session, compare its email
  addresses and resolved user IDs against the candidate backup **in memory**;
  report only aggregate matches. Check that no credential valve value entered
  the files. Do not publish the roster, a group export, or per-user results.
- Every new/changed item is either explained or explicitly questioned.

## Known failure mode: invisible id drift

A hand-named repo dir can hold source identical to the live tool under a name
that differs from the live id, undetectable until a full pull-all writes
meta.json for both. This is the backup-direction twin of the deploy ID-mismatch gotcha. Full
pull-all is what makes it visible; that is why cherry pulls are not enough.

## Rollback

Nothing to roll back on the prod side; the repo commit can be reverted if
the reconcile was wrong. If the reconcile reveals prod is *wrong*, fix prod
through the appropriate playbook, don't paper over it in the backup.
