---
name: bayleaf-ops-router
description: Operations playbooks for the BayLeaf platform (Chat at chat.bayleaf.dev, API at api.bayleaf.dev). Use when the user mentions Dependabot or dependency bumps for the API, upgrading Open WebUI, changing the LLM behind Basic or Help, editing system prompts or tools in prod, privacy notice changes, bumping spin-off modules like Lathe, adding a new service facet, or running the prod-to-repo backup/reconcile procedure.
---

# BayLeaf Operations Playbooks

Dispatches to one playbook per recurring operational workflow. Playbooks live
in `playbooks/` as ordinary markdown; read only the one that matches, not the
whole clump.

## Trigger table

| Situation | Playbook |
|---|---|
| Dependabot issue on `api/`, dependency version bump | `playbooks/api-dependency-bump.md` |
| New Open WebUI version for Chat | `playbooks/owui-version-bump.md` |
| Changing the LLM behind Basic or Help (incl. vision toggles) | `playbooks/model-swap.md` |
| Evaluating a candidate LLM (canary run, no production swap) | `playbooks/model-swap.md` |
| Editing a system prompt, or a tool's docstring/implementation | `playbooks/prompt-tool-edit.md` |
| Privacy notice / subprocessor / retention change | `playbooks/privacy-notice-change.md` |
| New service or API facet (new lane, subdomain, connection) | `playbooks/new-service-facet.md` |
| Bumping a spin-off module (Lathe, gws-toolkit, other toolkits) | `playbooks/spinoff-module-bump.md` |
| Pulling prod state back into the repo (backup, drift reconcile) | `playbooks/backup-reconcile.md` |

When two apply (an OWUI bump usually triggers `backup-reconcile` and often
`model-swap` afterward), run them in that order and say so.

## Canonical ownership

The repo's `AGENTS.md` files (root, `api/`, `chat/`) and `chat/DESIGN.md` are
the canonical infrastructure references. Playbooks are workflow wrappers:
trigger, gates, steps, verification, rollback, recording. They link to
AGENTS.md sections rather than copying them. If a playbook and an AGENTS.md
disagree, the AGENTS.md wins for infra facts and the playbook gets fixed in
the same session.

## Human gates

Steps marked **[HUMAN GATE]** require judgment the agent does not have (e.g.
"Adam has personally used this version for at least a day"). Do not convert
them into thresholds; stop and ask. Escalating is a success outcome.

## Refinement discipline (the point of this router)

Playbooks are living artifacts; rough drafts are expected (issue #65). Rules:

1. On loading a playbook, check its `last-reviewed` date. If older than six
   months, tell the user and offer to refresh it before relying on it.
2. After completing a run, append a dated entry to the playbook's
   **Refinement log**: what differed from the written steps, what surprised
   you, what to fix. One or two lines is enough.
3. If reality contradicted a step, fix the step now, not later. A wrong
   playbook is worse than none.
4. A playbook that has never been run is a guess. Say so when loading one
   with an empty refinement log.

## Recording convention

All services here deploy without committing ("deploy first, commit later").
Every playbook ends with a recording step: what to commit, under the repo's
`add:` / `update:` / `fix:` / `docs:` / `chore:` prefixes, squash-merged into
one coherent commit per workflow. Never commit without the user's go-ahead;
never push unless explicitly asked.
