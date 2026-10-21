# Inboxes agent discovery: local revision, 2026-10-21

## Scope and delivery

Adam approved focused discovery for managed desktop OpenChamber and hosted
OpenChamber/Nanobot. Chat remains deferred. No new tools, credentials, polling,
deployment or campus enablement are authorized by this revision.

- Desktop Standard and Sealed keep their existing public HTTP catalog URL.
  When enabled, it adds `bayleaf-inboxes`; `bayleaf-platform` points to it.
  Skill versions distinguish disabled, enabled and operator-pilot text so cached
  availability prose can refresh. Disabled deployments omit the skill and return
  404 from its direct URL, including when a pilot-owner binding is still set.
- Both hosted adapters keep their existing skill/tool registration and feature
  flags. Their descriptions use the same receiving-intent vocabulary as desktop.
  Each preserves its own invocation and permission boundaries.
- `/docs/inboxes.md` is the shared, deployment-aware workflow reference. Exact
  API contracts stay generated; the existing `llms.txt` walkthrough stays the
  HTTP example. The skill catalog and hosted skills link to the focused guide.
- All three distinguish reception from sending, existing Gmail access and
  automatic execution. A generic custom workflow is not enough: identify an
  external delivery requirement first.

## Local evidence

`npm --prefix api run test:docs` exercises public catalog/file delivery in
workerd, Standard/Sealed config references, enabled/disabled/pilot variants,
shared description vocabulary and guide links. API TypeScript checking, the
28 OpenChamber plugin tests, the Nanobot adapter suite, 28 browser-installer tests
and eight Nanobot-installer tests pass.

These checks establish delivery contracts and wording, not intent-recognition
success. No representative-client behavioral runs have been performed for this
revision. Source descriptions being identical is not behavioral parity.

## Behavioral qualification still to run

Use `discovery-evals.json` in fresh, isolated representative sessions for desktop
Standard, desktop Sealed, hosted OpenChamber and hosted Nanobot. Give only each
task prompt, not the skill name, reference URL or expected output. Supply no real
mail or credentials during discovery-only trials; stop before mutation. Record:

1. Harness/model, installed adapter/catalog version and advertised skills/tools.
2. Whether the agent loads the inbox skill from the ordinary task, then follows
   its focused guide. Record actual tool calls and response, not just self-report.
3. Whether it distinguishes reception from execution/sending/Gmail, explains
   pilot availability, asks before setup and avoids unsolicited polling.
4. Negative prompts should not cause inbox creation or inappropriate proposals.
   The instant-execution and verification-challenge cases should consult the
   skill but explain the capability boundary.
5. If a mutation test is separately approved, use synthetic resources, check
   permission denial and cleanup, and test received prompt injection separately.

Run both fresh setup and existing-client refresh paths. After approved publication,
hosted OpenChamber needs a new clean plugin pin; Nanobot needs new adapter assets
and deliberate managed setup. Sleeping machines must stay asleep until the owner
launches them. Previously loaded skill text can remain in conversation history.
Do not claim success for those paths from local source tests.

## Publication gate

All changes remain local. Both adapter submodules need separately approved
commit/push, followed by clean parent asset builds and an approved API deployment.
Do not change `INBOXES_ENABLED` or remove the operator-owner gate for discovery.
No user session was restarted or sandbox awakened to qualify this revision.
