---
source-skill: bayleaf-ops-router
description: Add a new service or API facet (new lane, connection, subdomain, or capability). Rough stub; the source issue (#65) itself trails off mid-thought.
status: rough
last-reviewed: 2026-08-25
---

# New Service / API Facet

## When to use

Adding something like the Bedrock connection, the Sealed lane, a new OWUI
connection, or any new user-facing capability that has its own data flow.

**Honesty note:** issue #65 lists this workflow as "Adding a new service or
API facet. ..." with the sentence unfinished. This playbook is a stub built
from repo conventions; the refinement log should record what the real
workflow turns out to be.

## Steps (checklist skeleton)

1. **Data posture first.** Where does the new facet send prompts and
   completions? A ZDR provider is the floor; adding any provider that
   retains content is a material posture change requiring the full
   `privacy-notice-change.md` workflow. Reference cases: Vertex Pipe disabled
   for lacking a ZDR path (`chat/AGENTS.md`); Bedrock paused pending
   open-weight listing enforcement (`api/AGENTS.md`).
2. **Private-by-default exposure.** New models/tools surface to nobody until
   granted (workspace model + group grants). The standard BayLeaf pattern.
3. **Documentation set:** an `AGENTS.md` for the new component if it has a
   directory; `chat/DESIGN.md` section if it's a Chat facet;
   `docs/privacy.html` subprocessor disclosure; root `AGENTS.md` structure
   tree.
4. **Rate limits / funding frame.** Every facet is sufficiency-capped and
   centrally funded; state its cap and its abuse bounds at birth
   (cf. `CAMPUS_RPD_LIMIT`, `SEALED_RPD_LIMIT`, spend-limits tooling).
5. **[HUMAN GATE]** The user decides scope, naming, and whether it ships at
   all; new public surface is a strategic call, not an operational one.
6. Record: the coordinated commit set, linked to the driving issue.

## Verification

Depends entirely on the facet; write it into this section when first run.

## Rollback

New facets should ship behind a kill-switch (cf. every `<BACKEND>_ENABLED`
flag failing closed) so rollback is an env flip, not a redeploy.

## Refinement log

- 2026-08-25: stub drafted; issue #65's own description is unfinished. First
  real run should rewrite this file.
- 2026-09-01: A generic local client proxy for the existing Sealed lane did not
  constitute a new service facet: it reused the lane's data flow, disclosure,
  limits, and kill switch. Reserve this playbook for new server-side surfaces
  or materially new data flows, not client adapters.
- 2026-09-03: Splitting OpenCode onboarding into Standard and Sealed login URLs
  likewise reused existing data flows and controls. A new discovery URL alone
  is not a new service facet; only the human ship gate and route verification
  applied.
