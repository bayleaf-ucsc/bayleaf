---
source-skill: bayleaf-ops-router
description: Edit an OWUI model prompt, tool/function, or skill, iterate in production, playtest, then record in git.
status: rough
last-reviewed: 2026-09-28
---

# Prompt / Tool / Skill Edit

## When to use

Changing an agent's knowledge or capabilities through a model system prompt,
a tool/function's docstring or implementation, or an OWUI skill. "Knowledge"
here is conceptual; OWUI Knowledge bases are a separate resource. Not for
whole-model swaps (`model-swap.md`) or OWUI bumps.

## The three edit loops

**System prompts** have two loops. For human-led iteration, use the OWUI admin
UI (Workspace → Models): it is the native surface, and the user can playtest
there in the same breath. Changes land in prod immediately. For agent-driven,
reviewable edits to a repo-backed prompt, use the repo-first loop below, then
`owui-cli models update` and live readback. Do not treat readback as a playtest.

### Agent-driven system prompt edits (repo-first)

1. Read the model JSON in `chat/models/<id>/model.json` and the live model with
   `owui-cli --json models show <id>`. Confirm `params.system` matches, and check
   other substantive fields for drift before pushing the whole model. If there
   is drift, stop and reconcile or ask which version to preserve; do not let a
   prompt edit overwrite unrelated production changes. Ignore rotating grant
   IDs and timestamps, and account for the sibling image convention in
   `chat/AGENTS.md`.
2. Extract `params.system` to a **temporary plain-text file**. Edit that file
   with a narrow patch, not by copying or retyping the entire JSON string line.
   Keep a snapshot or digest of the original model JSON so a concurrent edit can
   be detected before reinsertion. For a prompt version header, bump it deliberately.
3. Reinsert with a JSON-aware script: re-read the model JSON, assert it still
   equals that snapshot, replace only `params.system` with the edited text, and
   serialize in the repo's existing format (two-space indent, UTF-8,
   `ensure_ascii=False`, trailing newline). Do not include inline
   `data:image` content or copy live timestamps/grants into the repo. Validate
   the JSON and compare parsed before/after objects with `params.system` removed:
   they must be identical. Review a **line-level diff of the decoded prompts**,
   not just git's one-line JSON-string diff, before deployment.
4. Push with `owui-cli models update chat/models/<id>/model.json`, then read
   back the live model. Confirm the live `params.system` equals the reviewed
   repo prompt and verify the avatar is retained. Continue with the human
   playtest and reconciliation steps below.

**Tool/function source** follows the `chat/AGENTS.md` Don't: never edit
source in the OWUI admin UI. Edit `chat/tools/<id>/tool.py` or
`chat/functions/<id>/function.py` in the repo and push with `owui-cli tools
deploy <file> <id>` (or `functions deploy`). The repo loop is nearly as fast
and the repo stays the source of truth. Docstrings especially: they are the
model's tool documentation; edit them like prompts, but in the repo.

**Skills** also use the repo loop. Edit both `chat/skills/<id>/skill.md` and
`meta.json` when discovery metadata changes, then push with `owui-cli skills
deploy <skill.md> <id>`. The current CLI preserves an existing skill's live
description during deployment, so read back the skill and synchronize changed
metadata through the skill update endpoint without replacing grants or other
live fields. Always verify with `owui-cli skills pull <id>`.

## Prerequisites

- `owui-cli` env: `set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a`
- For tools/functions: read the existing source first; note the version field
  in the docstring header and bump it on any change.
- For skills: read both `skill.md` and `meta.json`; keep their descriptions in
  sync.

## Steps

1. Make the change using the appropriate loop above.
2. **[HUMAN GATE]** Manual playtest in prod: the user runs a real conversation
   that exercises the changed behavior. Prompts especially: what reads well
   and what the model actually does are different things; only playtesting
   reveals the difference.
3. Pull the result back per `backup-reconcile.md` (for UI-edited prompts this
   is the only way the change reaches git). For repo-first prompts, compare the
   live readback and pulled backup with the reviewed repo file. Diff, triage,
   and confirm the change is what was intended.
4. Record: `update: <what> for <model|tool|skill>`.

## Verification

- Playtest (manual, above).
- For repo-first prompts: only the intended decoded-prompt lines changed;
  other parsed model fields are untouched, and live readback matches.
- Backup pull shows the intended diff and nothing else. A live readback alone
  does not complete the backup-reconcile step.

## Rollback

For repo-deployed prompts, tools, or skills, restore the prior repo content and
redeploy; for a skill metadata rollback, also synchronize the prior description
through the update endpoint. For UI-edited prompts, paste the previous prompt back in
the UI (recover it from git: `git show HEAD:chat/models/<id>/model.json`), or
`uvx owui-cli models update` the checked-out file.

## Refinement log

- 2026-09-28: Follow-up on the Basic Canvas-link edit: retyping the entire
  JSON-encoded prompt line to add one sentence was error-prone and unreadable
  in review. Agent-driven prompt edits should extract text, patch the text,
  reinsert with a checked JSON transform, and review the decoded prompt diff.
  Live readback in that run did not replace the pending human playtest or full
  backup pull; this playbook now makes those boundaries explicit.
- 2026-09-28: Basic's live prompt matched the repo before a narrow Canvas-link
  handoff edit, so a reviewed `models update` avoided browser UI friction. Live
  readback confirmed the new prompt and retained avatar; human conversation
  playtest is still pending. Basic Canary's prompt now lags Basic, so DESIGN.md
  no longer claims an exact clone between evaluation cycles.
- 2026-08-25: drafted from issue #65 + chat/AGENTS.md; reconciles the AGENTS.md
  "don't edit in admin UI" rule (tools/functions) with the issue's "edit
  directly on OWUI for quick iteration" (prompts).
- 2026-09-03: the in-app browser timed out opening Workspace, so a narrow
  three-model prompt edit used `owui-cli models update` from reviewed repo JSON.
  Live readback matched, and a Basic identity probe exercised the new wording;
  the human playtest gate remains distinct from this automated check.
- 2026-09-16: a skill edit followed the repo-and-deploy loop used for tools.
  `owui-cli skills deploy` updated content but deliberately preserved the live
  description, so changed discovery metadata required a direct read-modify-write
  to the skill update endpoint. Live `skills pull` verified both fields.
- 2026-09-16: renamed and expanded this playbook to cover skills explicitly.
  The Code Sandbox run's post-rollback repeat playtest was waived by Adam after
  close review of the plain-language skill diff.
- 2026-09-24: deployed mechanical quality fixes to 11 Chat tools/functions after
  comparing every live source to repo HEAD; all 11 pulled back byte-identical.
  Lathe was excluded: its 0.29.6 frontmatter identifies an upstream release,
  so a local lint-only change would break the byte-identical upstream pin.
  Manual conversation playtest is still pending.
- 2026-09-24: while playtesting, Adam retired five legacy toolkits rather than
  testing them. Snapshot each live tool's source and metadata first, check for
  model bindings, then delete in OWUI and remove repo source and DESIGN entries.
  Issue #76 tracks a future BayLeaf-scoped-key replacement for DeepInfra.
- 2026-09-24: Adam's live Basic reply exercised the global rate-limit filter,
  and his Campus Directory tool call succeeded. The changed API auth/key route
  returned 200 with the expected budget fields. No Brace3 course model appeared
  in the live model list, so its stealth Canvas toolkit could not be exercised
  through a normal conversation in this run.
- 2026-09-24: Brace3 toolkit/filter refactor: deployed repo source, copied the
  existing Canvas token from the filter valve to the new toolkit valve without
  exposing it, bound the toolkit on the newly provisioned course model, then
  removed runtime injection. Pulled the new model to a sibling-image-backed
  repo file. `tools deploy` / `functions deploy` preserved the old live
  descriptions even though their manifests updated: synchronized descriptions
  separately through the update endpoints without changing grants or valves.
  An end-to-end non-admin Canvas tool playtest remains a human gate.
- 2026-09-25: Renamed the Brace3 prompt filter by creating a new OWUI function
  ID, copying the configured Canvas token in memory, rebinding the course model,
  and retiring the old function only after confirming no models referenced it.
  Renaming a live function is a migration, not merely an edit to its display name.
  `functions deploy` cannot create this ID because the missing-function GET
  returns HTTP 401; a direct create POST worked, then the valve was copied and
  the new filter activated before binding the model.
- 2026-09-25: Repaired Help's model-inspection tools after a real chat exposed
  a missing OWUI model-table method, already absent in v0.11.3. Read access
  checks still precede prompt disclosure: BayLeaf deliberately makes system
  prompts visible to model readers. Local authorization tests, live source
  readback, and an authenticated model-list call passed; Adam confirmed the
  browser replay works correctly.
- 2026-09-25: A student-shared Brace3 chat revealed that model-bound tools
  without tool-level grants are silently skipped for non-admin users in OWUI
  0.11.4. Course-scoped the Canvas tool (including pagination), deployed the
  new source, synchronized its live description separately, and added a course
  group tool grant without disturbing its valve. A non-admin chat playtest is
  still needed; model binding alone is not proof of tool availability.
