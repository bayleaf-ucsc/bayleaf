# Run evidence: bayleaf-powered-agent-capabilities

Dated record of past runs of [`bayleaf-powered-agent-capabilities.md`](../playbooks/bayleaf-powered-agent-capabilities.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-11 (Rooms #159): Skills only, no MCP tools, by decision. A skill-only capability
  must still be gated in the sandbox plugin (it loads every `skills/` folder); unlike
  Inboxes it stays under shared MCP. Matrix in `rooms/QUALIFICATION.md`. Desktop discovery
  verified live: the catalog skill surfaced in a harness immediately after the API deploy.

- 2026-11-11 (multimodal decisions, deployed): OpenRouter's documented
  media-in-state transport and live ZDR endpoint evidence clear the earlier
  upstream blocker, not the rollout gate. Actual local Worker + capped live
  upstream checks exposed still-image/video identity confusion, now explicitly
  denied; HTTP/llms exposure remains API-first, with client adapters deferred.
  Production ordinary-key and scoped-token checks passed after deployment;
  off-campus keyless denial does not establish positive Campus Pass media.

- 2026-11-04 (CollabMD retirement, local only): Removed managed-room discovery,
  installer and owner password delivery. Generic public/private previews remain
  available; all remaining managed apps are private. Registration crash recovery
  is retained and tested against Jupyter rather than the retired room adapter.
  Existing documents/sidecars remain untouched; deployment is separate.

- 2026-11-04 (Nanobot retirement): Removed the retired hosted surface from the
  active inventory and documentation exposure matrices. OpenChamber is the primary
  graphical surface across desktop and sandbox, not a claim of capability parity.
  Earlier Nanobot qualification and delivery entries remain historical; do not
  treat their build or release instructions as current maintenance requirements.

- 2026-11-01 (HF artifact gateway, #121): Exposure matrix recorded in
  api/HF-GATEWAY.md: llms.txt and OpenAPI (Artifacts tag) expose; hosted
  OpenChamber/Nanobot deferred until a restricted-egress sandbox profile exists;
  Chat not applicable; desktop omitted (documentation suffices). No telemetry added.

- 2026-10-30 (provider pinning, documentation only): Existing JSON passthrough was live-qualified with the operator's BayLeaf key: pinned text and vision returned DeepInfra, while a nonexistent provider failed with 404 instead of falling back. Expose guidance in llms.txt and generated Chat Completions docs; hosted OpenChamber/Nanobot, Chat and desktop adapters are not changed because no new capability, credential or default is introduced. Local docs tests cover both surfaces; publication remains pending approval.

- 2026-10-24 (approved hosted shared-MCP delivery): Source, published plugin, actual
  generated config, active MCP connection and installed Nanobot registry are
  distinct evidence. Retained usage/shared limit reads pass, while inactive Desktop
  correctly gates screenshots. Public orientation now distinguishes shipped hosted
  setup from desktop/laptop inference onboarding and historical recipe skills.

- 2026-10-24 (shared hosted MCP candidate): Discovery and invocation now move
  together at deliberate setup, with duplicate native registrations/recipes
  suppressed only for configured clients. Shared tools need explicit per-harness
  prefixes, Nanobot private-only schema/dispatch, retained save/destruction tools
  and an honest native-permission UX delta. Local candidate, not delivered parity.

- 2026-10-24 (approved sandbox CLI trial): Installer deployment and owner-only
  executable qualification need no adapter publication or UI migration. Existing
  Terminal PATH, managed placeholder substitution, real stdio listing and one
  already-active Desktop screenshot passed, not agent discovery/consent parity.
  No OpenChamber/Nanobot process was available for direct PATH qualification.

- 2026-10-24 (sandbox CLI/MCP, local): Reuse HTTP Zod validators for curated MCP
  schemas and CLI validation rather than creating another field catalog. Native
  images and SDK stdio tests qualify protocol behavior, not managed-agent delivery.
  Exposure matrix and deferred duplicate-free migration/approval policy gates are
  in `api/sandbox-cli/README.md`; no Chat, desktop or live adapter migration claimed.

- 2026-10-24 (computer-use, API-only release): Exposure matrix and adapter owners
  recorded in `api/COMPUTER-USE.md`, with native image delivery and consent gates
  explicitly deferred. Read-only Toolbox status lacked generation identity, so
  the approved fixed `/proc` probe replaces PID-only checks without waking compute.
  Approved deployment does not establish functional live API qualification;
  CLI/MCP and other adapter delivery remain deferred, as does floor control.

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

## Moved from the playbook body

When to use:

> This is an operator playbook, not a skill to install in end users' agents. It is
> a first draft motivated by [issue #97](https://github.com/bayleaf-ucsc/bayleaf/issues/97),
> not an exercised release procedure or authorization to implement Inboxes.

Surface inventory:

> credential boundaries. Nanobot was retired on 2026-11-04 and is excluded from
> current exposure decisions. Earlier refinement entries remain historical evidence.

Motivating case section:

> ## Motivating case: Inboxes (#97), proposal only
>
> If approved and implemented, an ordinary task such as “I need an address where
> this service can send a report while my computer is off” should let an agent
> offer a BayLeaf inbox. “Help me find the report that arrived yesterday” should
> suggest authorized retrieval, not ask the user to explain the API.
>
> Decide creation, list/search/read, attachment download, archive, deletion and
> inbox destruction separately for every surface. Do not infer exposure decisions
> from this example. Mail reception alone must never activate an agent, inference,
> reply, forwarding or tool execution. Incoming mail and attachments are untrusted
> data. Stored inbox content has a different retention/operator-access boundary
> from content-free inference, and copying it into Chat introduces stored history.
> Exact paths, credentials and deletion semantics await an implemented contract.

Step 7:

> Append deviations to the refinement
>    log.
