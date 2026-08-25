---
source-skill: bayleaf-ops-router
description: Edit a system prompt or a tool/function's docstring or implementation for Basic or Help, iterate in prod, playtest, then record in git.
status: rough
last-reviewed: 2026-08-25
---

# Prompt / Tool Edit

## When to use

Changing a model's system prompt, or a tool/function's docstring or
implementation. Not for whole-model swaps (`model-swap.md`) or OWUI bumps.

## The two edit loops

**System prompts** iterate in the OWUI admin UI (Workspace → Models): that is
their native surface, quick iteration is the point, and the OWUI UI is where
the user can playtest in the same breath. Changes land in prod immediately.

**Tool/function source** follows the `chat/AGENTS.md` Don't: never edit
source in the OWUI admin UI. Edit `chat/tools/<id>/tool.py` or
`chat/functions/<id>/function.py` in the repo and push with `owui-cli tools
deploy <file> <id>` (or `functions deploy`). The repo loop is nearly as fast
and the repo stays the source of truth. Docstrings especially: they are the
model's tool documentation; edit them like prompts, but in the repo.

## Prerequisites

- `owui-cli` env: `set -a && source ~/.tokens/owui/chat-bayleaf-dev && set +a`
- For tools/functions: read the existing source first; note the version field
  in the docstring header and bump it on any change.

## Steps

1. Make the change (UI for prompts, repo + deploy for tools/functions).
2. **[HUMAN GATE]** Manual playtest in prod: the user runs a real conversation
   that exercises the changed behavior. Prompts especially: what reads well
   and what the model actually does are different things; only playtesting
   reveals the difference.
3. Pull the result back per `backup-reconcile.md` (for UI-edited prompts this
   is the only way the change reaches git). Diff, triage, confirm the change
   is what was intended.
4. Record: `update: <what> for <model|tool>`.

## Verification

- Playtest (manual, above).
- Backup pull shows the intended diff and nothing else.

## Rollback

For repo-deployed tools: `git checkout` the file and redeploy. For
UI-edited prompts: paste the previous prompt back in the UI (recover it from
git: `git show HEAD:chat/models/<id>/model.json`), or
`uvx owui-cli models update` the checked-out file.

## Refinement log

- 2026-08-25: drafted from issue #65 + chat/AGENTS.md; reconciles the AGENTS.md
  "don't edit in admin UI" rule (tools/functions) with the issue's "edit
  directly on OWUI for quick iteration" (prompts).
