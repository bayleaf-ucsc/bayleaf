---
source-skill: bayleaf-ops-router
description: Coordinate API capability discovery, safe invocation, and deliberate exposure decisions across BayLeaf-powered agents.
status: rough
last-reviewed: 2026-10-13
---

# BayLeaf-Powered Agent Capabilities

## When to use

Run this whenever an API capability is added, materially changed, enabled,
restricted, deprecated, or removed. Also run it when adding a client harness or
auditing a gap between what the API supports and what configured agents know.
Use alongside `new-service-facet.md` for new data flows, `maintain-sandbox.md`
for hosted adapters, and `prompt-tool-skill-edit.md` for Chat changes.

**Goal:** agents can recognize when a BayLeaf capability would help, proactively
offer it, and use the central API under the user's authority. Users should not
need to remember endpoint names or ask their agent to read the API docs.
Thoughtful differences between surfaces are welcome; silent omissions are not.

This is an operator playbook, not a skill to install in end users' agents. It is
a first draft motivated by [issue #97](https://github.com/bayleaf-ucsc/bayleaf/issues/97),
not an exercised release procedure or authorization to implement Inboxes.

## Separate three obligations

1. **Discovery:** a tool description, advertised skill description, or compact
   environment instruction makes the capability recognizable during an ordinary
   conversation. A docs link that nobody loads does not meet this obligation.
2. **Invocation:** a tool, MCP adapter, or skill-guided API/CLI workflow provides
   a tested way to use it. An inference-provider connection does not install
   non-inference capabilities. A discoverable skill needs to be installed and
   registered, not merely published at a URL.
3. **Authority:** the server enforces identity, scope, ownership, quotas and
   lifecycle. Descriptions and approval prompts guide use but do not enforce
   credential scope. Proactive offering is not permission for autonomous action.

Keep API policy and resource lifecycle central. Clients adapt contracts to their
own harnesses, rather than implement parallel authorization or storage services.
Prefer typed tools for tight authenticated calls and skills for multi-step
judgment. Keep detailed contracts on demand, not copied into every system prompt.

## Surface inventory

Reconfirm these source locations at each run. New clients join this inventory.

| Surface | Source / delivery to inspect | What must be decided |
|---|---|---|
| Hosted OpenChamber / OpenCode | `api/sandbox-plugin/` tools and `skills/`; `api/src/routes/wellknown.ts`; installer in `api/scripts/browser-setup.py` | Tool/skill registration in the actual workspace, native permissions, published package pin and refresh path |
| Hosted Nanobot | `api/nanobot-sandbox/` MCP adapter and `skills/`; parent installer/assets | MCP discovery, skill installation, narrower mutation scope where native approval is absent, installed-version update path |
| BayLeaf Chat | `chat/tools/`, `chat/skills/`, `chat/models/`; read `chat/AGENTS.md` and `chat/DESIGN.md` | Appropriate toolkit/model, grants versus default attachment, ordinary-user discoverability, mapping Chat identity to API authority |
| Desktop OpenChamber / OpenCode | Standard and Sealed discovery/config in `api/src/routes/wellknown.ts`; setup guidance in `GETTING-STARTED.md` and `llms.ts`; any user-facing skill/plugin distribution identified there | What onboarding actually installs, useful advertised triggers, user consent, updates for existing installations, Standard/Sealed differences |
| Main agent reference and HTTP docs | `api/src/routes/llms.ts` (`https://api.bayleaf.dev/llms.txt`), code-owned OpenAPI routes/schemas and `apiReference.ts` | Workflow orientation and accurate availability; exact contracts remain generated, not duplicated |

The desktop row is an obligation, not a claim that a complete capability package
already ships. Trace actual distribution before naming a canonical owner. Do not
mistake this repo's operations skills, or Adam's personal global skills, for the
skills available to campus users. `/docs/SKILL.md` currently redirects to
`/llms.txt`; it is not a separately installed skill package.

## Steps

1. **Characterize the change.** Read canonical service instructions and contracts.
   Record the user problem, verbs, deployment/feature-flag state, credential types,
   limits, retention/access boundary, side effects and destructive operations.
   Review changed response fields, errors and deprecations as well as new routes.
   Do not assume Campus Pass, temporary inference tokens, sandbox credentials or
   Chat credentials authorize a new owner-scoped service.
2. **Make an exposure matrix before implementation.** One row per surface above,
   splitting materially different models/access modes and read/write verbs.
   Choose `expose`, `defer`, `omit`, or `not applicable`. Every row needs a reason;
   deferred work needs a named owner and follow-up/revisit condition. Store the
   matrix with the driving change, not as a second permanent API catalog.

   | Surface / verbs | Decision and reason | Discovery + invocation | Auth / consent boundary | Delivery / follow-up owner | Verification |
   |---|---|---|---|---|---|
   | Fill one row per surface | expose / defer / omit / not applicable | Actual tool/skill and trigger | Enforced scope and approval behavior | Source, update path or explicit deferral | Evidence or pending gate |

3. **[HUMAN GATE] Agree exposure scope.** Ask Adam about consequential defaults,
   capability withholding, new persistence, destructive actions, and adapters
   without native approval. Do not silently grant broader credentials to close a
   parity gap. Symmetry is a review obligation, not a demand to expose every verb
   everywhere. Publishing/deployment and Git mutations still need approval.
4. **Implement discovery and invocation together for exposed rows.** Use words
   users actually use in tool/skill descriptions, including when to offer the
   capability and its limits. Name the central BayLeaf service rather than
   suggesting users obtain a separate upstream account. Link detailed API
   contracts from skills. Avoid putting credentials in model-visible arguments,
   examples, outputs or persistent instructions. Do not load all of `llms.txt`
   every turn as a substitute for a small discoverable capability surface.
5. **Coordinate documentation and delivery.** Update `llms.txt` workflow guidance
   and generated contracts as appropriate, plus user-facing setup instructions
   if installation changes. Identify independently published adapter packages,
   parent pins/builds, Chat grants/attachments, opt-in desktop installation,
   configuration refresh, and existing-session skill staleness. Record fresh,
   already-running and sleeping-client behavior separately. Source edits alone
   do not prove a capability reached users; don't restart users' work to test it.
6. **Verify each exposed row below.** Keep adapter unit tests, runtime discovery,
   behavioral playtests and live rollout evidence distinct. Synthetic tests come
   first. Ordinary-user checks matter: admin discovery can mask missing grants.
7. **Record the outcome.** Show the exposure matrix, diff, test evidence, deployed
   versions (if approved), and explicit gaps. Append deviations to the refinement
   log. Suggest one coherent `docs:` or `update:` commit, but do not commit, push,
   post to the issue, or close it without authorization. A capability can ship
   API-only by deliberate decision; do not call unverified adapter parity done.

## Verification: the capability is at hand

- **Unprompted discovery:** in a fresh representative user session, give a natural
  task without saying “BayLeaf,” naming the capability, or linking docs. Does the
  agent recognize and offer the appropriate capability, loading its skill if
  needed? Record the task, harness/model, available tools and actual behavior.
  A listing test alone is not behavioral evidence.
- **Authorized execution:** with synthetic resources and consent, verify the
  chosen tool/workflow reaches the central API, produces useful bounded output,
  and cleans up exact test resources. Test ownership/scope denial, disabled or
  unavailable service, expiry and quota failures, without credential leakage or
  fallback to an unapproved provider. Respect each surface's data boundary.
- **Consent and restraint:** verify that destructive or publishing verbs use the
  intended permission path or remain deliberately unavailable. For relevant
  capabilities, test that externally supplied text is data, not authority to
  execute instructions. Avoid speculative polling or background activation.
- **Delivery:** verify actual installed tool/skill descriptions and package pins,
  not just repo text. Exercise fresh setup and the documented update path for
  existing clients. Mark live checks pending when only local tests were run.
- **Negative discovery:** omitted, disabled, removed or proposal-only capabilities
  are not advertised as usable. Allowed references accurately explain status.

## Motivating case: Inboxes (#97), proposal only

If approved and implemented, an ordinary task such as “I need an address where
this service can send a report while my computer is off” should let an agent
offer a BayLeaf inbox. “Help me find the report that arrived yesterday” should
suggest authorized retrieval, not ask the user to explain the API.

Decide creation, list/search/read, attachment download, archive, deletion and
inbox destruction separately for every surface. Do not infer exposure decisions
from this example. Mail reception alone must never activate an agent, inference,
reply, forwarding or tool execution. Incoming mail and attachments are untrusted
data. Stored inbox content has a different retention/operator-access boundary
from content-free inference, and copying it into Chat introduces stored history.
Exact paths, credentials and deletion semantics await an implemented contract.

## Rollback and retirement

Use each owning playbook's rollback procedure. Remove or correct discovery text
alongside tools, skills, configs and docs; stale skills already loaded in a
conversation may persist. Keep server-side denial authoritative even when old
clients retain descriptions. Do not broaden credentials or bypass the central
API to keep a retired capability appearing functional.

## Refinement log

- 2026-10-23 (native Windows qualification): HTTP fixtures missed curl 8.8.0's
  HTTPS certificate-info/write-out failure. Explicit PowerShell discovery aliases
  passed native generated-argv tests and the deployed desktop-to-campus-login
  handoff. Ctrl+C did not terminate the service-owned helper; postapproval key/config
  qualification remains separate. Never call URL display a completed login.

- 2026-10-23 (OpenCode curl transport): Windows background-service launches need
  process stderr, not `CON`. Test the advertised argv with stdout/stderr pipes;
  retain legacy instruction routes while replacing discovery. Exposure is shared
  Standard/Sealed/Sandbox onboarding only, with no adapter or authority change.

- 2026-10-21 (desktop data boundary): Put the P3 ceiling and P4 exclusions
  in both the platform shim's advertised description and body, not only the linked
  reference. Qualify PII by UCSC classification; Sealed is not a P4 exception.
  Bump all deployment variants and test disabled-feature prose without treating
  a safety restriction as an availability advertisement. Docs tests passed; deployed
  as `29a6fb1e-3ea8-46d6-bd9a-f3f2e623e249`, with live shim text and catalog
  version `6-inboxes` verified. Existing-client refresh remains unverified.

- 2026-10-21 (optional email domains): Initial-release enablement needs no client
  compatibility layer. Keep omitted/null as the intentional open-email default;
  distinguish verified domain authority from individual senders across discovery.
  Local signed storage tests and live policy readback do not establish SMTP retries.

- 2026-10-21 (community enablement): Explicitly empty pilot-owner source/default
  config opens existing authenticated owner paths, including diagnostics and hosted
  setup. Retain auth/isolation tests and accepted qualification limitations without
  inventing another approval gate. Staging must not silently reinstate the pilot.

- 2026-10-21 (managed-client isolation preflight): Temporary inference tokens
  cannot authorize inbox reads; a synthetic owner also fails the production pilot
  gate. Preserve the broad operator key locally and build an exact-inbox relay
  before cloud qualification. Source allowlists do not prove gateway registration.

- 2026-10-21 (quota discovery): Static defaults were insufficient for deployed
  overrides. Add authenticated read-only discovery from the enforcement helper;
  keep approximate, non-introspectable burst bindings out of exact numeric claims.
  Receiver-first deployment supports coordinated API/adapter delivery.

- 2026-10-21 (approved hosted release): TTL/finite events and discovery wording
  published in both adapters, parent Nanobot allowlist deployed, exact production
  pins/assets/settings read back. Script-only live SSE/export remain deliberate.
  Production delivery does not establish existing-session or sleeping-client UX.

- 2026-10-21 (candidate hosted completion): TTL inputs/readback and finite events
  now have tested isolated adapter patches; live SSE is deliberately script/API,
  not a long-running tool. Published live downloads and actual disposable Linux
  stop/resume tests passed. Candidate live creation hit the ten-row owner quota;
  Nanobot delivery additionally requires a parent enabledTools allowlist change.

- 2026-10-21 (hosted inbox qualification): Published and current adapter executables
  omit endpoint TTL inputs/readback and event tools. Export omission is deliberate.
  A remote pin refresh cannot change an existing process's inbox feature-flag
  environment; qualify that launch boundary separately from tool registration.

- 2026-10-21 (integrated production rollout): Preserve live adapter pins in an
  isolated staging copy and run authentic build hooks: main's generated assets may
  be test fixtures. Fetched deployed modules and exact variable readback qualified
  the artifact; HTTP export/SSE smoke and collector readback remain separate from
  installed-client discovery, SMTP and production memory gates.

- 2026-10-21 (DKIM main integration): Creation remains explicitly disabled in
  owner workflow prose and deployment config. Cross-feature tests need the
  verifier build/node compatibility and trigger-aware migration splitting even
  when they exercise only SSE or export; HTTP schema support is not enablement.

- 2026-10-21 (Inboxes discovery, local): Desktop now has a dedicated catalog skill
  and all three non-Chat skills link to a focused workflow guide. Version catalog
  entries for feature/pilot text changes too, not just source edits. Workerd checks
  delivery and negative discovery; fresh-client behavioral prompts and rollout
  gates are recorded in `inbox/TODO.md`, not claimed as passed.

- 2026-10-21 (Inboxes DKIM, isolated local worktree): Exposure is creation/readback
  through the owner HTTP API plus llms orientation, with adapter delivery deferred
  in `inbox/OPERATIONS.md`. Clean-worktree API tests needed
  explicit test-only fixtures for unrelated generated adapter assets; this does
  not qualify real adapter installation or justify fixture-based deployment.

- 2026-10-20 (Inboxes #97, local only): Approved HTTP/desktop/hosted exposure
  matrix lives in `inbox/QUALIFICATION.md`; Chat and dashboard deferred. Add
  negative-discovery checks to hosted installers as well as docs. Independent
  contract tests passed while contract-level security flaws remained, so retain a
  separate adversarial lifecycle/design review. Adapter source tests are not
  installed-client or behavioral evidence; both submodule releases remain pending.

- 2026-10-16 (desktop discovery, local): Standard and Sealed managed configs now
  reference a public V2 HTTP catalog with a slim `bayleaf-platform` orientation
  skill. No new tools, plugins, credentials or hosted behavior. Synthetic HTTP
  tests cover both configs and public skill delivery; live client discovery,
  behavioral offering and disconnect refresh remain unverified. HTTP catalogs
  provide discovery without requiring an executable desktop plugin.

- 2026-10-13 (decision inference rollout): Core HTTP, dashboard and visitor consent
  qualified in production, including a shared text/decision token. Client adapters
  remain deliberately deferred, and media transport qualification remains issue #98.

- 2026-10-13 (decision inference, local): Adam approved API-first exposure, with
  hosted/desktop adapters deferred in api/DECISIONS.md. Multimodal schema discovery
  is not transport verification: media remains denied until an adapter is qualified.

- 2026-10-13: Drafted from the #97 discussion and source inventory. Found that
  `llms.txt` is onboarding-oriented and `/docs/SKILL.md` is a legacy redirect;
  neither proves installed desktop capability discovery. No cross-surface
  release or behavioral discovery test has exercised this playbook yet.
