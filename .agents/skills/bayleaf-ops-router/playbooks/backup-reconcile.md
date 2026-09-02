---
source-skill: bayleaf-ops-router
description: Pull live OWUI state (models, tools, functions, skills) back into the repo backup, triage drift from noise, and reconcile DESIGN.md. The recovery-oriented backup procedure.
status: stable
last-reviewed: 2026-08-25
---

# Backup Reconcile (prod → repo)

## When to use

Scheduled drift catch-up, after any prod-side change series, or as the final
step of `owui-version-bump.md` / `prompt-tool-edit.md` /
`spinoff-module-bump.md`. Also run standalone whenever prod might have
drifted (the 2026-08-25 run found a week of accumulated drift in one pull).

## Prerequisites

- `set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a`
- Clean git tree (so the diff is purely this run's findings).

## Steps

1. Pull all four resource types (full pull-all, never cherry pulls; see the
   id-drift lesson below):

   ```bash
   uvx owui-cli tools pull-all chat/tools/
   uvx owui-cli functions pull-all chat/functions/
   uvx owui-cli skills pull-all chat/skills/
   uvx owui-cli models pull-all chat/models/
   ```

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

- 2026-08-25: promoted from a live run (commit `05d9d85`): offramp skill
  rollout captured, lathe v0.24.1, activation flips confirmed deliberate,
  whole_document_retrieval id drift resolved, DESIGN.md six-spot stale
  claims fixed. Status set stable on the strength of one complete run.
- 2026-09-01: post-OWUI-v0.11.3 pull was limited to a new null `meta.knowledge`
  field and the Canary's live null avatar reference; rotating grant IDs and
  timestamps were stripped as noise. No resource ID drift found.
