---
source-skill: bayleaf-ops-router
description: Add a new service or API facet (new lane, connection, subdomain, or capability). Rough checklist.
status: rough
last-reviewed: 2026-08-25
---

# New Service / API Facet

## When to use

Adding something like the Bedrock connection, the Sealed lane, a new OWUI
connection, or any new user-facing capability that has its own data flow.

Not for client adapters, onboarding variants, or discovery URLs that reuse an
existing lane's data flow, disclosure, limits and kill switch.

This is a rough checklist built from repo conventions: adapt it to the facet.

## Steps (checklist skeleton)

1. **Data posture first.** Where does the new facet send prompts and
   completions? A ZDR provider is the floor; adding any provider that
   retains content is a material posture change requiring the full
   `privacy-notice-change.md` workflow. Reference cases: Vertex Pipe disabled
   for lacking a ZDR path (`chat/AGENTS.md`); Bedrock paused pending
   open-weight listing enforcement (`api/AGENTS.md`). State separately what
   transits and what persists. Ephemeral grant or transaction tables also need a
   retention disclosure: D1 Time Travel outlasts row expiry.
2. **Private-by-default exposure.** New models/tools surface to nobody until
   granted (workspace model + group grants). The standard BayLeaf pattern.
3. **Documentation set:** an `AGENTS.md` for the new component if it has a
   directory; `chat/DESIGN.md` section if it's a Chat facet;
   `PRIVACY.md` subprocessor disclosure; root `AGENTS.md` structure
   tree.
4. **Rate limits / funding frame.** Every facet is sufficiency-capped and
   centrally funded; state its cap and its abuse bounds at birth
   (cf. `CAMPUS_RPD_LIMIT`, `SEALED_RPD_LIMIT`, spend-limits tooling). Consume
   caps with one atomic conditional update: read/check/update overshoots under
   concurrent calls.
5. **[HUMAN GATE]** The user decides scope, naming, and whether it ships at
   all; new public surface is a strategic call, not an operational one.
6. **Agent capability exposure.** Run `bayleaf-powered-agent-capabilities.md`
   before calling the facet complete: decide discovery and invocation across
   hosted OpenChamber, Chat, desktop agents and `llms.txt`. Record
   deliberate omissions/deferrals; updating HTTP docs alone is not exposure.
7. **Roll out in dependency order, once approved:** storage migrations, then the new
   Worker, then the API and its binding.
   - Before the API deploy, compare every live variable and the version actually
     serving traffic with source. From a worktree, carry over code committed on
     `main`: deploying a stale tree silently reverts it.
   - A new zone needs a Workers Custom Domain (Wrangler OAuth lacks DNS write).
     Expect brief errors while it propagates; locally cached negative DNS can hide it.
   - The telemetry collector's `WRITE_KEYS_JSON` is replaced whole: deploy the new
     source's policy first, put back every existing writer, then verify that each
     still authenticates.
8. Record: the coordinated commit set, linked to the driving issue.

## Verification

Depends on the facet. For authenticated synthetic probes, verify anonymous
denial without detailed metrics, completed-work GET/HEAD parity, bounded rate
and deadline configuration, and independent exact-record cleanup. Record the
deployed version and credential expiry, not merely a local test result.

Exercise forms, sign-in redirects, CSP and arrival records in a real browser. HTTP
fixtures miss a `Referrer-Policy` that suppresses `Origin`, blocked form-action
redirect chains, and the difference between a synthetic POST and a real arrival.

## Rollback

New facets should ship behind a kill-switch (cf. every `<BACKEND>_ENABLED`
flag failing closed). For Workers with configuration-bound variables, changing
that flag still requires a deployment; pausing the external monitor stops its
traffic without changing the Worker. A kill switch must not disable scheduled
expiry, cleanup or account retirement.
