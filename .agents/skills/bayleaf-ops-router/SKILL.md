---
name: bayleaf-ops-router
description: Operations playbooks for BayLeaf Chat, API, and Sandbox. Use for desktop OpenChamber onboarding incident response; maintaining the hosted Sandbox plugin, tools, skills, browser workspace or application pins; coordinating BayLeaf-powered agent capabilities and API exposure across hosted OpenCode Web, Chat, desktop skills and llms.txt; API dependency bumps; Open WebUI upgrades; model swaps; Pouch in-browser model qualification; production prompts/tools; Chat request-rate analytics and rate-limit tuning; monitoring failures, probe extensions or browser-token renewal; accessibility evidence; privacy notices; spin-off modules; new service facets; or prod-to-repo backup/reconcile.
---

# BayLeaf Operations Playbooks

Dispatches to one playbook per recurring operational workflow. Playbooks live
in `playbooks/` as ordinary markdown; read only the one that matches, not the
whole clump. `evidence/` holds the record of past runs, one file per playbook:
skip it during normal work.

## Trigger table

| Situation | Playbook |
|---|---|
| Launching or maintaining the local operator telemetry dashboard | `../bayleaf-operator-dashboard/SKILL.md` (dedicated skill) |
| Reproducing desktop OpenChamber onboarding failures or qualifying installation/login across platforms | `playbooks/desktop-onboarding-smoke.md` |
| Maintaining BayLeaf Sandbox, its hosted plugin/tools/skills, browser workspace, or application pins | `playbooks/maintain-sandbox.md` |
| Changing preview-gateway forwarding/responses, a new Lathe preview-wrapper contract revision, an app that works on localhost but not through a preview, or Daytona preview-proxy behaviour | `playbooks/qualify-preview-gateway.md` |
| Dependabot issue on `api/`, dependency version bump | `playbooks/api-dependency-bump.md` |
| New Open WebUI version for Chat | `playbooks/owui-version-bump.md` |
| Changing the LLM behind Basic or Help, or the BayLeaf API recommended model | `playbooks/model-swap.md` |
| Evaluating a candidate LLM (canary run, no production swap) | `playbooks/model-swap.md` |
| Qualifying a model, revision, dtype, runtime bump or recipe edit for Pouch's in-browser (Transformers.js) provider; reusing its tasks for Localhost model families | `playbooks/qualify-in-browser-model.md` |
| Editing a system prompt, tool/function, or OWUI skill | `playbooks/prompt-tool-skill-edit.md` |
| Measuring retained Chat request rates or evaluating submission-limit changes | `playbooks/chat-rate-analysis.md` |
| Privacy notice / subprocessor / retention change | `playbooks/privacy-notice-change.md` |
| New service or API facet (new lane, subdomain, connection) | `playbooks/new-service-facet.md` |
| Adding, changing, enabling, retiring, or auditing API capability exposure and discovery across BayLeaf-powered agents | `playbooks/bayleaf-powered-agent-capabilities.md` |
| Monitoring failure, browser-probe credential renewal, new synthetic route, probe contract, or UptimeRobot monitor | `playbooks/probe-extension.md` |
| Accessibility evidence, keyboard-flow recording, or Chat VPAT update | `playbooks/accessibility-evidence.md` |
| Bumping a spin-off module (Lathe, gws-toolkit, other toolkits) | `playbooks/spinoff-module-bump.md` |
| Pulling prod state back into the repo (backup, drift reconcile) | `playbooks/backup-reconcile.md` |
| Provisioning Brace3 access for a course roster, TAs, and instructor | `playbooks/brace3-course-access.md` |

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
2. If reality contradicted a step, or a run taught something the next run
   needs, change the playbook step now, not later. A wrong playbook is worse
   than none. Write it as a present-tense instruction, without dates,
   deployment or commit ids, or the story of how it was learned.
3. After completing a run, add a dated entry at the top of
   `evidence/<playbook>.md` (create the file on the first run): what differed,
   what surprised you, ids, results and what went untested. One or two lines is
   enough. A lesson recorded only there is lost: apply rule 2 first.
4. Read evidence only to diagnose a failure, check whether a step was ever
   exercised, or find the reason behind a rule.
5. A playbook with no evidence file, or one without a real run, is a guess. Say
   so when loading it.

## Private snapshots

Playbooks that say "snapshot privately" mean exported valves, configs, app
specs, before/after pulls, deploy logs and qualification state. These often
hold credentials, so they never go in the repository, a worktree or a public
backup. Put them on the operator's machine under:

```
~/.local/state/bayleaf-ops/<YYYY-MM-DD>-<change>/   (folder 700, files 600)
```

Not in `~/.tokens`: that folder is for credentials only, and in 2026-10 it
filled up with about 1,460 rollout files. Retention: once a change is verified
and recorded, keep its rollback bundle (what you would redeploy to undo it)
and delete the rest of the snapshot. When the next change to the same service
on the same instance is verified, delete the older rollback bundle.

## Recording convention

All services here deploy without committing ("deploy first, commit later").
Every playbook ends with a recording step: what to commit, under the repo's
`add:` / `update:` / `fix:` / `docs:` / `chore:` prefixes, squash-merged into
one coherent commit per workflow. Never commit without the user's go-ahead;
never push unless explicitly asked.
