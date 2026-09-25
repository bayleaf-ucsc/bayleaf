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
drifted (the 2026-08-25 run found a week of accumulated drift in one pull).

## Prerequisites

- `set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a`
- Clean git tree (so the diff is purely this run's findings).
  If the tree is already dirty, pull all resources into a private temporary
  directory first and compare without overwriting in-progress work.
- **Public-backup boundary:** pull models, tools, functions, and skills only.
  Never pull groups, users, chats, or course rosters into this repository.
  Model `access_grants` contain principal UUIDs, not group membership; treat
  roster-based membership as deliberately outside this backup.

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
   | Format evolution | `has_user_valves` moved into `meta`, `content_length` dropped | accept the new shape |

3. Check for **id drift**: a repo dir whose name differs from the JSON `id`
   field, or an old dir that pull-all didn't refresh (source tracked but
   meta never was makes this invisible to cherry pulls). Renames appear as
   one untracked dir plus one stale tracked dir; resolve by `git rm -r` the
   misnamed one and letting the correct one land.
4. Reconcile `chat/DESIGN.md` against the pulled state: activation flags in
   the functions/skills tables, model capability and skillIds lists, tool
   surfaces, and the §8 directory tree. Six spots were stale in the
   2026-08-25 run; expect a similar count after any active month.
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

The 2026-08-25 run found `whole_document_retrieval_toolkit/` (repo dir,
hand-named) vs live id `whole_document_retrieval` — identical source,
mismatched id, undetectable until a full pull-all wrote meta.json for both.
This is the backup-direction twin of the deploy ID-mismatch gotcha. Full
pull-all is what makes it visible; that is why cherry pulls are not enough.

## Rollback

Nothing to roll back on the prod side; the repo commit can be reverted if
the reconcile was wrong. If the reconcile reveals prod is *wrong*, fix prod
through the appropriate playbook, don't paper over it in the backup.

## Refinement log

- 2026-09-25: Recovery pull after Brace3 course provisioning ran all four
  resources into a private temp directory because the repo had in-progress
  edits. No roster emails, student IDs, Canvas token, group exports, or chat
  exports entered the candidate backup. `models pull-all` omitted the hidden
  GLM base record even though `models show` found it active with public read;
  added a separate base-model check rather than deleting the repo record.
  Remaining differences were rotating metadata, a dropped Lathe
  `content_length`, and two optional-null schema defaults on the inactive
  Brace v2 toolkit: no substantive prod drift.
- 2026-09-18: The Lathe 0.28.0 full pull produced only the expected source/schema
  delta plus rotating model and skill timestamps/grant IDs. Removing SSH also
  required reconciling stale guidance in DESIGN.md, RETENTION.md, and the live
  Code Sandbox skill, not just vendoring the upstream tool.
- 2026-09-17: A long feature session had an intentionally dirty API tree, so full
  before/after pulls went to a private snapshot directory first. Review found only
  the intended Lathe/skill changes and old model timestamp/grant-ID noise. Full
  repo pulls followed; model noise was restored without discarding unrelated work.

- 2026-08-25: promoted from a live run (commit `05d9d85`): offramp skill
  rollout captured, lathe v0.24.1, activation flips confirmed deliberate,
  whole_document_retrieval id drift resolved, DESIGN.md six-spot stale
  claims fixed. Status set stable on the strength of one complete run.
- 2026-09-01: post-OWUI-v0.11.3 pull was limited to a new null `meta.knowledge`
  field and the Canary's live null avatar reference; rotating grant IDs and
  timestamps were stripped as noise. No resource ID drift found.
- 2026-09-16: (issue #67 root cause) the "live null avatar reference" from
  2026-09-01 turned out to be the actual bug: OWUI v0.11.x rejects bare
  filenames as `profile_image_url` and nulls them, *and* strips the field from
  all list/read responses (icons moved to `GET /model/profile/image`), so
  pulled model.json can report a null field instead of a `data:` URI — "no
  output from extract" no longer distinguishes broken from stripped. Push-side
  sibling inlining added in owui-cli ≥ 0.5.2; prod icons re-pushed and verified
  bytewise via the image endpoint.
