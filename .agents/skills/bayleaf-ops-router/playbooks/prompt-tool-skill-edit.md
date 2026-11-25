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

- Compare live source with the repo before deploying. `tools show` omits source;
  use `tools pull`. Deploys keep the live name and description, so synchronize a
  changed description through the update endpoint without touching grants or
  valves.
- Afterward confirm exact source and schemas, and unchanged valves, grants and
  model bindings.
- Valve-only changes need no source deployment. Commit only reviewed non-secret
  overrides (`valves.public.json`) and merge them into the live valves. Full
  valve exports contain credentials and stay private.
- Renaming an ID is a migration: create the new ID, copy valves in memory, rebind
  models, and retire the old ID only after confirming nothing references it.
- To retire a tool or function, privately snapshot source, metadata and valves,
  then check bindings through `/api/v1/models/export` (the CLI model list mixes in
  provider models with no stored row). Then delete it and remove its repo source
  and DESIGN entries.

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
   reveals the difference. A bare completion call that returns a tool call has not
   executed it. Where non-admins are the audience, playtest as one: a model-bound
   tool without a tool-level grant is silently skipped.
3. Pull the result back per `backup-reconcile.md` (for UI-edited prompts this
   is the only way the change reaches git). For repo-first prompts, compare the
   live readback and pulled backup with the reviewed repo file. Diff, triage,
   and confirm the change is what was intended.
4. Record: `update: <what> for <model|tool|skill>`.

## Verification

- Playtest (manual, above).
- For repo-first prompts: only the intended decoded-prompt lines changed;
  other parsed model fields are untouched, and live readback matches. Omitted
  capabilities read back as null; check effective inheritance in `/api/models`.
- Backup pull shows the intended diff and nothing else. A live readback alone
  does not complete the backup-reconcile step.

## Rollback

For repo-deployed prompts, tools, or skills, restore the prior repo content and
redeploy; for a skill metadata rollback, also synchronize the prior description
through the update endpoint. For UI-edited prompts, paste the previous prompt back in
the UI (recover it from git: `git show HEAD:chat/models/<id>/model.json`), or
`uvx owui-cli models update` the checked-out file.
