---
source-skill: bayleaf-ops-router
description: Edit an OWUI model prompt, tool/function, or skill, iterate in production, playtest, then record in git.
status: rough
last-reviewed: 2026-09-16
---

# Prompt / Tool / Skill Edit

## When to use

Changing an agent's knowledge or capabilities through a model system prompt,
a tool/function's docstring or implementation, or an OWUI skill. "Knowledge"
here is conceptual; OWUI Knowledge bases are a separate resource. Not for
whole-model swaps (`model-swap.md`) or OWUI bumps.

## The three edit loops

**System prompts** iterate in the OWUI admin UI (Workspace → Models): that is
their native surface, quick iteration is the point, and the OWUI UI is where
the user can playtest in the same breath. Changes land in prod immediately.

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
   is the only way the change reaches git). Diff, triage, confirm the change
   is what was intended.
4. Record: `update: <what> for <model|tool|skill>`.

## Verification

- Playtest (manual, above).
- Backup pull shows the intended diff and nothing else.

## Rollback

For repo-deployed tools or skills, restore the prior repo content and redeploy;
for a skill metadata rollback, also synchronize the prior description through
the update endpoint. For UI-edited prompts, paste the previous prompt back in
the UI (recover it from git: `git show HEAD:chat/models/<id>/model.json`), or
`uvx owui-cli models update` the checked-out file.

## Refinement log

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
