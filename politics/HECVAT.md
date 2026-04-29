# HECVAT 4.1.5 — BayLeaf AI Playground

**Solution Provider:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz
**Solution Name:** BayLeaf AI Playground
**Date:** 2026-04-29

---

## Framing memo for the reviewer

HECVAT is written for a third-party commercial vendor selling a product to
a higher-ed institution. BayLeaf does not fit that shape. It is a
**faculty-operated service** offered to the UCSC campus community at no
cost, built and run by Adam Smith (Associate Professor, Computational
Media) in his institutional capacity as a UCSC school official under 34
CFR § 99.31(a)(1)(i)(A). There is no vendor counterparty, no
procurement event, no sales cycle, and no corporate structure. The
operator is already bound by UC policy (IS-3, the UC Electronic
Communications Policy, UCSC Administrative Procedures Applying to
Disclosure of Information from Student Records, etc.) as a condition of
employment.

Several HECVAT questions (e.g. SOC 2 audit, DRP testing, 24×7 SOC,
enterprise IR team, formal BCP, SDLC documents, "parent and subsidiary
relationships") presume an enterprise vendor posture. Those answers are
"no" here, and the *Additional Information* field on each explains the
honest substitute — typically either (a) the posture of the upstream
platform provider (DigitalOcean, Cloudflare, CILogon/InCommon,
OpenRouter) whose SOC 2s and controls BayLeaf rides on, or (b) the UCSC
institutional controls that already apply to the operator.

**Supporting documents (in-repo):**

- `../chat/DESIGN.md` — full architectural backup (OIDC config, group sync,
  model access control, tool/function architecture, recovery procedure).
- `SECURITY.md` (this directory) — security exhibit (architecture, data flows,
  subprocessor inventory, credential management, honest disclosures).
- `FERPA.md` — full FERPA analysis, contract-stack comparison
  against UC's Google agreements, and draft designation memo (§ 8) for
  the proposed approval pathway.
- `DEPENDENCIES.md` — dependency audit with exit paths.
- `ACCOUNTS.md` — account/credential handover plan.
- `../SECURITY.md` (repo root, <https://github.com/bayleaf-ucsc/bayleaf/blob/main/SECURITY.md>) — vulnerability-reporting policy.

**Scope of this HECVAT:** Both user surfaces as a single solution —
BayLeaf Chat (`chat.bayleaf.dev`, Open WebUI on DigitalOcean App
Platform) and BayLeaf API (`api.bayleaf.dev`, Cloudflare Worker).

**Current approval posture:** BayLeaf is **not** on the UCSC
AI-Council-published list of tools approved for Protection Level 3
(FERPA-protected) data as of this writing. Users handling P3 content
should use Workspace-Gemini or NotebookLM per existing campus guidance.
This HECVAT is part of the process of changing that posture. `FERPA.md §8`
contains a draft designation memo (§ 99.31(a)(1)(i)(B)) that, combined
with the architectural choices described below, would support adding
BayLeaf to the P3-approved list.

---

## START HERE

### — General Information —

### GNRL-01

**Q:** Solution Provider Name

**Answer:** Adam Smith (in institutional capacity as UCSC faculty).

**Additional Information:** There is no commercial entity. BayLeaf is a faculty-operated service under the operator's existing UCSC appointment. See framing memo above.

---

### GNRL-02

**Q:** Solution Name

**Answer:** BayLeaf AI Playground.

**Additional Information:** Two user surfaces under the same name: BayLeaf Chat (`chat.bayleaf.dev`) and BayLeaf API (`api.bayleaf.dev`). Landing page at `bayleaf.dev`.

---

### GNRL-03

**Q:** Solution Description

**Answer:** BayLeaf is a curated, campus-scoped generative-AI service for the UCSC community. Chat is an Open WebUI deployment offering chat access to frontier and open-weight LLMs via OpenRouter (zero-data-retention routing only), with curated workspace models, invite-code-gated groups, per-user sandbox VMs for agentic coding, and rate limiting. API is an OpenRouter-compatible endpoint providing keyless on-campus access and key-based off-campus access, with spending caps and revocation at the proxy layer.

**Additional Information:** Purpose: give UCSC faculty, staff, and students access to current AI tools with meaningful contractual protections (ZDR), SSO, and group-based access, as an alternative to consumer AI tools that carry weaker commitments. See `../chat/DESIGN.md` for architectural detail and `SECURITY.md` for the security exhibit.

---

### GNRL-04

**Q:** Solution Provider Contact Name

**Answer:** Adam Smith

**Additional Information:** Sole operator. Reversibility noted: if the operator leaves UCSC, retires, or discontinues the service, BayLeaf will be wound down per `SECURITY.md §2.4` (databases and object storage destroyed, not transferred).

---

### GNRL-05

**Q:** Solution Provider Contact Title

**Answer:** Associate Professor, Department of Computational Media, UC Santa Cruz.

**Additional Information:**

---

### GNRL-06

**Q:** Solution Provider Contact Email

**Answer:** amsmith@ucsc.edu

**Additional Information:** Security vulnerability reports can also be filed via GitHub Private Vulnerability Reporting at <https://github.com/bayleaf-ucsc/bayleaf/security/advisories/new>. See repo-root `SECURITY.md` for the reporting policy.

---

### GNRL-07

**Q:** Solution Provider Contact Phone Number

**Answer:** (831) 295-2624

**Additional Information:** Email (`amsmith@ucsc.edu`) is the preferred channel for routine contact; phone is available for time-sensitive UCSC ITS/ISO matters.

---

### GNRL-08

**Q:** Country of Company Headquarters

**Answer:** United States (UC Santa Cruz, California).

**Additional Information:** Not a headquartered company. Service operations run from Santa Cruz, CA, under the operator's UCSC appointment.

---

### GNRL-09

**Q:** Employee Work Locations (all)

**Answer:** Santa Cruz, CA, USA. Single operator.

**Additional Information:** No other employees, contractors, or collaborators have administrative access to the BayLeaf infrastructure.

---

### — Company Information —

### COMP-01

**Q:** Do you have a dedicated software and system development team(s) (e.g., customer support, implementation, product management, etc.)?*

**Answer:** No.

**Additional Information:** Single faculty operator. Development, operations, and support are all performed by Adam Smith. User support is handled via email to `amsmith@ucsc.edu` and via a self-service "Help" model within Chat that can list groups, show model access, and redeem invite codes.

---

### COMP-02

**Q:** Describe your organization’s business background and ownership structure, including all parent and subsidiary relationships.

**Answer:** Not applicable: BayLeaf is not a business. It is a service operated by a UCSC faculty member in his institutional capacity. There is no parent entity, no subsidiary, no equity structure. The operator's employer is the Regents of the University of California, and campus-level governance flows from UCSC.

**Additional Information:** No offshoring. No multinational relationships. All subprocessors are documented in `SECURITY.md §4` and `DEPENDENCIES.md`.

---

### COMP-03

**Q:** Have you operated without unplanned disruptions to this solution in the past 12 months?

**Answer:** Substantially yes, with minor exceptions.

**Additional Information:** The service runs on DigitalOcean App Platform and Cloudflare Workers; disruptions that have occurred in the past 12 months have been correlated with upstream provider incidents (DigitalOcean regional events, Cloudflare edge incidents) rather than BayLeaf-originated failures. There is no formal SLA; the operator addresses issues on a best-effort basis. No formal uptime monitoring is published.

---

### COMP-04

**Q:** Do you have a dedicated information security staff or office?

**Answer:** No at the BayLeaf layer; yes at the institutional layer.

**Additional Information:** Single operator. BayLeaf relies on (a) UCSC's Information Security Office (ISO) and Privacy Office for institutional-level security governance that already applies to the operator as a UCSC employee; (b) the security programs of upstream providers (DigitalOcean, Cloudflare — both SOC 2 Type 2 attested) for platform-layer controls; and (c) GitHub Advanced Security and Dependabot for continuous dependency scanning on the source repositories.

---

### COMP-05

**Q:** Use this area to share information about your environment that will assist those who are assessing your company's data security program.

**Answer:** Key points for the reviewer:

1. **Operator status.** Adam Smith is a tenured UCSC faculty member and an existing school official under 34 CFR § 99.31(a)(1)(i)(A). He is bound by UC Electronic Communications Policy, UC IS-3, UCSC Administrative Procedures Applying to Disclosure of Information from Student Records (§IX.C written-form requirement), and other UC policies as a condition of employment.
2. **Inference posture.** All LLM inference goes through OpenRouter restricted to zero-data-retention (ZDR) provider endpoints. No prompt or completion text is retained by any model provider. A NRP/SDSC institutional path is configured but currently disabled because NRP's policy is to log prompts.
3. **Data retained.** User accounts (email, name, OAuth tokens), conversation histories, group memberships, and uploaded files are stored in DigitalOcean Managed PostgreSQL 17 and DO Spaces (AES-256 at rest). API key mappings are stored in Cloudflare D1 (encrypted at rest). Conversation data and sandbox content are automatically deleted after 90 days of inactivity per a published, automated retention policy (`../chat/RETENTION.md`, `../api/RETENTION.md`). See `SECURITY.md §2.2`.
4. **Authentication.** SSO-only via CILogon/InCommon (OIDC); no password login. Direct signup disabled. MFA inherited from the UCSC IdP.
5. **Documentation.** Full security exhibit at `SECURITY.md`. Full FERPA analysis with draft designation memo at `FERPA.md`. Dependency audit at `DEPENDENCIES.md`. Vulnerability reporting policy at repo-root `SECURITY.md`.
6. **Approval posture.** BayLeaf is not currently on the UCSC AI Council's P3-approved list. This HECVAT is part of the process to change that.

**Additional Information:**

---

### REQU-01

**Q:** Are you offering a cloud-based product?

**Answer:** Yes.

**Additional Information:** BayLeaf Chat runs on DigitalOcean App Platform (SFO region). BayLeaf API runs on Cloudflare Workers. Storage: DigitalOcean Managed PostgreSQL 17 and DO Spaces (S3-compatible, SFO2). API key mappings in Cloudflare D1.

---

### REQU-02

**Q:** Does your product or service have an interface?

**Answer:** Yes.

**Additional Information:** Chat has a web UI (Open WebUI) at `chat.bayleaf.dev` for end users. Admin functions (model/tool/function/user/group management) are exercised via the Open WebUI admin UI or the `owui-cli` tool. API exposes an OpenRouter-compatible HTTPS interface at `api.bayleaf.dev` with a small web console for self-service key provisioning.

---

### REQU-03

**Q:** Are you providing consulting services?

**Answer:** No.

**Additional Information:**

---

### REQU-04

**Q:** Does your solution have AI features, or are there plans to implement AI features in the next 12 months?

**Answer:** Yes — BayLeaf is primarily an AI service.

**Additional Information:** See the AI section below for detail.

---

### REQU-05

**Q:** Does your solution process protected health information (PHI) or any data covered by the Health Insurance Portability and Accountability Act (HIPAA)?

**Answer:** No — not designed for PHI. No BAA is in place with any subprocessor.

**Additional Information:** Users are directed (via campus guidance and the Help model) not to enter PHI into BayLeaf. PHI use cases at UCSC should be served by campus-approved HIPAA-covered tools, not BayLeaf.

---

### REQU-06

**Q:** Is the solution designed to process, store, or transmit credit card information?

**Answer:** No.

**Additional Information:** BayLeaf is offered at no cost to users; there is no payment processing. Operator-side cloud bills to DigitalOcean, Cloudflare, OpenRouter, etc. are paid via UCSC procurement channels and do not involve user-facing PCI data.

---

### REQU-07

**Q:** Does operating your solution require the institution to operate a physical or virtual appliance in their own environment or to provide inbound firewall exceptions to allow your employees to remotely administer systems in the institution's environment?

**Answer:** No.

**Additional Information:** BayLeaf runs entirely on cloud infrastructure (DigitalOcean, Cloudflare). UCSC operates nothing on-premises for BayLeaf and is not asked to open any inbound firewall rules. Users access BayLeaf over standard outbound HTTPS.

---

### REQU-08

**Q:** Does your solution have access to personal or institutional data?

**Answer:** Yes, with scope-limiting architectural choices; see below.

**Additional Information:** BayLeaf does **not** automatically ingest institutional data from campus systems (no direct SIS/Canvas/HR feeds). Two ways institutional data can enter the system: (a) users pasting content into prompts, which is processed by a ZDR model provider and returned, with conversation history stored in the OWUI database; (b) course-specific provisioning workflows (documented in `../chat/DESIGN.md §1b`) that pull Canvas rosters (student email + name) to create placeholder OWUI accounts before students log in. The latter handles FERPA-adjacent directory-level data. BayLeaf is not currently on the UCSC AI Council's P3-approved list; the proposed path to approval is in `FERPA.md §8`.

---

## Organization

<!-- The HECVAT template repeats several General Information questions at the start of each workbook tab. For brevity we answer each unique question once in the START HERE section and cross-reference below. -->

### GNRL-01..08 (repeat)

See START HERE section above.

### — Documentation —

### DOCU-01

**Q:** Do you have a well-documented business continuity plan (BCP), with a clear owner, that is tested annually?*

**Answer:** No formal annually-tested BCP at the BayLeaf layer.

**Additional Information:** The operator-level BCP is implicit: because BayLeaf is operated by a single faculty member, continuity of the service depends on the operator. `SECURITY.md §2.4` and `ACCOUNTS.md` (in repo) document the wind-down and handover plan. Platform-layer continuity is provided by DigitalOcean and Cloudflare, both of which maintain tested BCPs as part of their SOC 2 programs.

---

### DOCU-02

**Q:** Do you have a well-documented disaster recovery plan (DRP), with a clear owner, that is tested annually?*

**Answer:** No formal annually-tested DRP, but a documented recovery procedure exists.

**Additional Information:** `../chat/DESIGN.md §6` ("Recovery Procedure") describes how to reconstruct BayLeaf Chat from the repository backup (app spec, model/tool/function JSON, PostgreSQL restore from DO managed backups). This has not been exercised as a full annual drill. DigitalOcean's managed PostgreSQL backups run on DO's schedule; the operator does not perform manual backup drills.

---

### DOCU-03

**Q:** Have you undergone a SSAE 18/SOC 2 audit?

**Answer:** No at the BayLeaf layer; yes at the upstream provider layer.

**Additional Information:** BayLeaf itself has not undergone a SOC 2 audit. The upstream hosting platforms — DigitalOcean (SOC 2 Type 2) and Cloudflare (SOC 2 Type 2, ISO 27001) — have recent audit reports available through their trust portals and are the basis for the datacenter and platform-level control assertions below.

---

### DOCU-04

**Q:** Do you conform with a specific industry standard security framework (e.g., NIST Cybersecurity Framework, CIS Controls, ISO 27001, etc.)?

**Answer:** Informally aligned with NIST CSF at the architectural level and with NIST AI RMF concepts for AI-specific controls; no formal attestation.

**Additional Information:** The operator is also bound to UC IS-3 as a UCSC employee, which is UC's institutional implementation of a security framework (aligned with NIST SP 800-53). `SECURITY.md` documents the substantive controls.

---

### DOCU-05

**Q:** Can you provide overall system and/or application architecture diagrams, including a full description of the data flow for all components of the system?

**Answer:** Yes.

**Additional Information:** `SECURITY.md §1` (architecture table) and §2 (data handling) document the component inventory and data flows. `FERPA.md §5` contains ASCII data-flow diagrams for both inference paths (current OpenRouter-ZDR and proposed direct Google Cloud). `../chat/DESIGN.md` documents the full OWUI deployment including model, tool, filter, and skill architecture. Formal boxed diagrams can be produced on request.

---

### DOCU-06

**Q:** Does your organization have a data privacy policy?

**Answer:** BayLeaf's privacy posture is documented in `SECURITY.md §2` and `FERPA.md`, and operates within UCSC's published privacy policies and UC's Statement of Privacy Values and Privacy Principles.

**Additional Information:** There is no standalone bayleaf.dev privacy page as of this HECVAT. A published privacy notice is a reasonable item to produce as part of the approval process and is under consideration.

---

### DOCU-07

**Q:** Do you have a documented, and currently implemented, employee onboarding and offboarding policy?

**Answer:** Not applicable at the BayLeaf layer (sole operator); yes at the institutional layer.

**Additional Information:** The operator's UCSC onboarding/offboarding follows standard UCSC HR processes. If the operator offboards from UCSC, the service is wound down per `SECURITY.md §2.4` and `ACCOUNTS.md`.

---

### — Assessment of Third Parties —

### THRD-01

**Q:** Do you perform security assessments of third-party companies with which you share data?*

**Answer:** Informal: selected on the basis of published security posture; not a formal repeating assessment program.

**Additional Information:** Each subprocessor was selected in part based on published security documentation (SOC 2 reports, DPAs, contractual commitments). `DEPENDENCIES.md` records the selection rationale, political profile, and exit path for each dependency. There is no formal annual vendor re-assessment cycle.

---

### THRD-02

**Q:** Do you have contractual language in place with third parties governing access to institutional data?*

**Answer:** Yes — under each subprocessor's standard commercial terms and DPA.

**Additional Information:** Complete subprocessor list with data exposure per party is at `SECURITY.md §4`. Summary:

- **DigitalOcean** — App Platform, Managed PostgreSQL 17, Spaces. Holds user accounts, conversation histories, file uploads. Under DO's published DPA.
- **Cloudflare** — Workers, D1, KV, DNS, TLS. Holds API key mappings; all traffic transits Cloudflare's edge. Under Cloudflare's published DPA.
- **OpenRouter** — LLM gateway. Prompts/completions in transit. ZDR providers only (enforced by OpenRouter configuration).
- **CILogon / InCommon** — OIDC federation (email, name, eduPerson affiliation claim). Under InCommon federation terms that UCSC is already party to.
- **Daytona** — Per-user code-sandbox VMs (for the Lathe toolkit). Sandbox file contents only.
- **Tavily** — Search queries from tool-use.
- **Jina AI** — URLs submitted for parsing (Germany-hosted; only subprocessor not US-based).
- **DeepInfra** — Inference endpoint via OpenRouter routing; also directly used by the DeepInfra-key-generator toolkit to mint time-limited scoped keys.
- **GitHub (Microsoft)** — Code hosting and issue tracking. Public repo only; no user data. One container-build-time dependency fetches a script from GitHub (documented and reviewed).
- **Google** — Only invoked when an end user voluntarily authorizes the optional `gws_toolkit` for their own Workspace data within a single chat. Tokens are ephemeral, in-process, keyed by `(user_id, chat_id)`, and never persisted.

No custom DPAs or FERPA addenda are in place with these parties beyond their standard commercial terms. `FERPA.md §5` analyzes the contract stack in detail, including the UC-signed agreements already in force with Google that would govern a proposed direct Google Cloud integration.

---

### THRD-03

**Q:** Do the contracts in place with these third parties address liability in the event of a data breach?*

**Answer:** Yes — per each provider's standard commercial terms.

**Additional Information:** BayLeaf has not negotiated custom liability terms with any subprocessor. Each provider's standard DPA and breach-notification clauses apply. `FERPA.md §5.2` notes that a proposed direct Google Cloud integration would, by inheriting UCSC's 2024 Customer Affiliate Agreement and the 2025 Google Cloud Enterprise Addendum, provide institutionally-negotiated enhanced liability caps ($20M data-breach cap, $10M cyber/privacy insurance) that are not available on BayLeaf's current OpenRouter-routed path.

---

### THRD-04

**Q:** Do you have an implemented third-party management strategy?*

**Answer:** Yes, documented.

**Additional Information:** `DEPENDENCIES.md` catalogs every external dependency in the stack, with the following per-dependency fields: provider, owner, political profile, exit path, and switch cost. This is the operational third-party management artifact. It is re-reviewed and updated as the service evolves; the audit explicitly tracks ownership changes (e.g. GitHub's August 2025 loss of operational independence, KKR's 2024 acquisition of Canvas/Instructure, Tavily's 2026 acquisition by Nebius Group).

---

### THRD-05

**Q:** Do you have a process and implemented procedures for managing your hardware supply chain (e.g., telecommunications equipment, export licensing, computing devices)?

**Answer:** Not applicable — no operator-managed hardware.

**Additional Information:** BayLeaf operates no physical hardware. All compute, storage, and networking are provided by upstream cloud providers. Hardware supply chain risk sits within those providers (DigitalOcean, Cloudflare) and is covered by their SOC 2 programs.

---

### — Change Management —

### CHNG-01

**Q:** Will the institution be notified of major changes to your environment that could impact the institution's security posture?*

**Answer:** Yes.

**Additional Information:** UCSC ITS/ISO will be notified directly of material security-relevant changes (e.g. a change of identity provider, a new subprocessor with data access, a change in ZDR policy, a security incident). Routine changes (model catalog updates, tool additions, new curated workspace models) are visible in the public GitHub repository.

---

### CHNG-02

**Q:** Does the system support client customizations from one release to another?*

**Answer:** Not applicable — single-tenant campus service with no per-customer customization.

**Additional Information:** There is one BayLeaf deployment for the UCSC campus. Per-group access controls (invite-code groups, course groups) are operational customizations, not software customizations.

---

### CHNG-03

**Q:** Do you have an implemented system configuration management process (e.g., secure "gold" images, etc.)?*

**Answer:** Yes, at the platform level.

**Additional Information:** OWUI runs from the pinned upstream image `ghcr.io/open-webui/open-webui` (version pinned in `doctl apps spec`). The app spec, model/tool/function configurations, and OWUI secrets are backed up in the GitHub repository (see `../chat/DESIGN.md §6`). Workers code and configuration for the API are similarly under Git.

---

### CHNG-04

**Q:** Do you have a documented change management process?

**Answer:** Yes.

**Additional Information:** `AGENTS.md` files in the repo document the git workflow ("deploy first, commit later"); `../chat/AGENTS.md` documents the OWUI change process (edit via admin UI or `owui-cli`, reconcile to repo, `git diff`). All changes are tracked in the public `bayleaf-ucsc/bayleaf` GitHub repository.

---

### CHNG-05

**Q:** Does your change management process minimally include authorization, impact analysis, testing, and validation before moving changes to production?

**Answer:** Partially, informally.

**Additional Information:** Breaking or risky changes are tested in the operator's personal OWUI instance (`chat.adamsmith.as`) before promotion to `chat.bayleaf.dev` when practical. For low-risk changes, "deploy first, commit later" is the documented workflow. There is no separate change-approval authority because the operator is sole administrator.

---

### CHNG-06

**Q:** Does your change management process verify that all required third-party libraries and dependencies are still supported with each major change?

**Answer:** Yes.

**Additional Information:** GitHub Advanced Security with Dependabot is enabled on both source repositories (`bayleaf-ucsc/bayleaf` and `rndmcnlly/bayleaf`). Flagged vulnerabilities are resolved by upstream bumps or fixes, not silenced. OWUI version pins are reviewed before upgrade per `../chat/AGENTS.md` ("Don't deploy OWUI version upgrades without checking the changelog for breaking changes").

---

### CHNG-07

**Q:** Do you have policy and procedure, currently implemented, managing how critical patches are applied to all systems and applications?

**Answer:** Yes — tracked via Dependabot and manual upstream monitoring; patches applied on a best-effort basis.

**Additional Information:** OWUI upstream releases are monitored. DigitalOcean and Cloudflare handle underlying infrastructure patching.

---

### CHNG-08

**Q:** Have you implemented policies and procedures that guide how security risks are mitigated until patches can be applied?

**Answer:** Yes, ad hoc.

**Additional Information:** Mitigations used historically include: disabling the affected feature, tightening rate limits (`rate_limit_filter`), deactivating affected workspace models, and temporary `OAUTH_BLOCKED_GROUPS` patterns to protect sensitive groups during transitions.

---

### CHNG-09

**Q:** Do clients have the option to not participate in or postpone an upgrade to a new release?

**Answer:** Not applicable — no client-specific versioning.

**Additional Information:** One shared deployment.

---

### CHNG-10

**Q:** Do you have a fully implemented solution support strategy that defines how many concurrent versions you support?

**Answer:** One version supported at a time.

**Additional Information:** 100% of users are on the current pinned OWUI version at any given time.

---

### CHNG-11

**Q:** Do you have a release schedule for product updates?

**Answer:** No fixed schedule; updates pushed as needed.

**Additional Information:** OWUI upstream is updated when there is a compelling reason (security fix, desired feature, deprecation). Tool and model changes can ship more frequently.

---

### CHNG-12

**Q:** Do you have a technology roadmap, for at least the next two years, for enhancements and bug fixes for the solution being assessed?

**Answer:** Partial — no formal multi-year roadmap document.

**Additional Information:** Near-term direction is visible in the repository's open issues and in `FERPA.md §5.2` (proposed direct Google Cloud integration). Longer-term direction is shaped by the UCSC AI Council's evolving positions on campus AI tools.

---

### CHNG-13

**Q:** Can solution updates be completed without institutional involvement (i.e., technically or organizationally)?

**Answer:** Yes.

**Additional Information:** The operator deploys updates without requiring action from UCSC ITS or campus users.

---

### CHNG-14

**Q:** Are upgrades or system changes installed during off-peak hours or in a manner that does not impact the customer?

**Answer:** Yes, best-effort.

**Additional Information:** DigitalOcean App Platform rolling deploys minimize downtime. Disruptive changes are timed outside peak usage when practical.

---

### CHNG-15

**Q:** Do procedures exist to provide that emergency changes are documented and authorized (including after-the-fact approval)?

**Answer:** Yes — via the public git history.

**Additional Information:** "Deploy first, commit later" means emergency changes are made to the live service immediately and reconciled to the repository after. The git log serves as the audit trail.

---

### CHNG-16

**Q:** Do you have a systems management and configuration strategy that encompasses servers, appliances, cloud services, applications, and mobile devices (company and employee owned)?

**Answer:** Yes (solo-operator scope).

**Additional Information:** Cloud services managed via `doctl` (DigitalOcean) and `wrangler` (Cloudflare). OWUI configuration via `owui-cli`. No servers, appliances, or corporate mobile devices to manage. The operator's own devices sit within UCSC's employee-device policy framework.

---

### — Policies, Processes, and Procedures —

### PPPR-01

**Q:** Do you have a documented patch management process?*

**Answer:** Yes — see CHNG-06/07. Continuous dependency scanning via Dependabot; upstream monitoring for OWUI and Workers runtime; platform-level patching delegated to DigitalOcean and Cloudflare.

**Additional Information:**

---

### PPPR-02

**Q:** Can your organization comply with institutional policies on privacy and data protection with regard to users of institutional systems, if required?*

**Answer:** Yes.

**Additional Information:** The operator is already bound by UCSC privacy policy and UC IS-3 as a condition of employment. BayLeaf's architectural choices (ZDR-only inference, no PHI/PCI, no data sale, no training on user input) align with those obligations.

---

### PPPR-03

**Q:** Is your company subject to the institution's geographic region's laws and regulations?*

**Answer:** Yes. Jurisdiction: State of California, United States.

**Additional Information:** As a UC Santa Cruz faculty member operating a service for UCSC, the operator is within California and US federal jurisdiction.

---

### PPPR-04

**Q:** Can you accommodate encryption requirements using open standards?

**Answer:** Yes.

**Additional Information:** TLS 1.2+ for all transport (Cloudflare-terminated for `chat.bayleaf.dev` and `api.bayleaf.dev`). At-rest encryption uses AES-256 via DigitalOcean Managed PostgreSQL, DO Spaces, and Cloudflare D1 — all industry-standard open algorithms.

---

### PPPR-05

**Q:** Do you have a documented systems development life cycle (SDLC)?

**Answer:** Informal.

**Additional Information:** The repository's `AGENTS.md` files document development conventions (deploy-first-commit-later, security-first dependency policy, no secrets in repo). No formal SDLC document at the scale of a mature enterprise vendor.

---

### PPPR-06

**Q:** Do you perform background screenings or multi-state background checks on all employees prior to their first day of work?

**Answer:** Not applicable at the BayLeaf layer. The sole operator has been vetted through UCSC's academic hiring processes.

**Additional Information:**

---

### PPPR-07

**Q:** Do you require new employees to fill out agreements and review policies?

**Answer:** Not applicable (sole operator, already bound by UCSC employment agreements).

**Additional Information:**

---

### PPPR-08

**Q:** Do you have a documented information security policy?

**Answer:** Yes — `SECURITY.md` is the security exhibit. Plus repo-root `SECURITY.md` covers vulnerability reporting.

**Additional Information:**

---

### PPPR-09

**Q:** Are information security principles designed into the product lifecycle?

**Answer:** Yes.

**Additional Information:** Design principles from `SECURITY.md §7`: proxy indirection (users never hold raw provider keys), multi-backend inference capability, system prompt enforcement, provider-agnostic OIDC, screen-sharing safety (API keys never displayed in plaintext), single-administrator model. Secrets never committed; TLS and at-rest encryption by default; SSO-only with no password login; stealth-toolkit pattern to limit which tools are exposed on which models.

---

### PPPR-10

**Q:** Will you comply with applicable breach notification laws?

**Answer:** Yes.

**Additional Information:** California breach notification requirements apply. Breaches affecting UCSC users would additionally be reported to UCSC ISO per standard campus incident procedures.

---

### PPPR-11

**Q:** Do you have an information security awareness program?

**Answer:** Not applicable (sole operator).

**Additional Information:** Operator-level security awareness is maintained through UCSC's mandatory Cybersecurity Awareness Training (UC-wide, annual) and active participation in campus AI governance (UCSC AI Council).

---

### PPPR-12

**Q:** Is security awareness training mandatory for all employees?

**Answer:** Yes — for the sole operator, via UCSC's annual mandatory training.

**Additional Information:**

---

### PPPR-13

**Q:** Do you have process and procedure(s) documented, and currently followed, that require a review and update of the access list(s) for privileged accounts?

**Answer:** Yes at the platform level — single privileged account is the operator. No other privileged accounts exist.

**Additional Information:** See `ACCOUNTS.md` for the credential inventory and handover plan.

---

### PPPR-14

**Q:** Do you have documented, and currently implemented, internal audit processes and procedures?

**Answer:** No formal internal audit at the BayLeaf layer.

**Additional Information:** The service is publicly auditable via its public repositories. Subprocessor SOC 2 reports provide external audit coverage at the platform layer.

---

### PPPR-15

**Q:** Does your organization have physical security controls and policies in place?

**Answer:** Delegated to cloud providers. BayLeaf has no physical presence.

**Additional Information:** DigitalOcean and Cloudflare datacenter physical security is covered by their SOC 2 Type 2 reports. The operator's own workstation is UCSC-managed or operates within UCSC's remote-work policy.

---

## Product

### GNRL / REQU (repeat)

See START HERE section.

### — Authentication, Authorization, and Account Management —

### AAAI-01

**Q:** Does your solution support single sign-on (SSO) protocols for user and administrator authentication?*

**Answer:** Yes — required, not optional.

**Additional Information:** Chat uses OIDC via CILogon (InCommon Federation), with UCSC's IdP preselected (`urn:mace:incommon:ucsc.edu`). `ENABLE_LOGIN_FORM=false` — there is no password login for anyone, including the administrator. Administrator access uses the same OIDC flow.

---

### AAAI-02

**Q:** For customers not using SSO, does your solution support local authentication protocols for user and administrator authentication?*

**Answer:** Not applicable — local authentication is disabled.

**Additional Information:** See AAAI-01. No bypass exists.

---

### AAAI-03..05

**Q:** Password complexity enforcement / limitations / reset procedures for non-SSO users.

**Answer:** Not applicable — no non-SSO users exist.

**Additional Information:** Any local passwords that might exist in the OWUI user table (e.g. for placeholder student accounts used in pre-provisioning, set to the literal string `placeholder-no-login`) cannot be used to log in because `ENABLE_LOGIN_FORM=false`. See `../chat/DESIGN.md §1b` for the placeholder-account workflow.

---

### AAAI-06

**Q:** Does your organization participate in InCommon or another eduGAIN-affiliated trust federation?*

**Answer:** Yes.

**Additional Information:** Authentication is performed via CILogon, which is operated by Internet2 and federated with InCommon (the US R&E federation, eduGAIN-affiliated). UCSC is the asserting IdP for BayLeaf users.

---

### AAAI-07

**Q:** Are there any passwords/passphrases hard-coded into your systems or solutions?*

**Answer:** No.

**Additional Information:** All secrets (OAuth client secret, `WEBUI_SECRET_KEY`, S3 keys, API provider keys, OpenRouter keys, Canvas tokens, etc.) live in DigitalOcean encrypted environment variables, Cloudflare Worker secrets, or OWUI admin "valves" — never in committed source. The one pseudo-password that does exist is the literal string `placeholder-no-login` written into placeholder student accounts (see AAAI-03..05); it is not a credential because local login is disabled and it is documented as non-secret.

---

### AAAI-08

**Q:** Are you storing any passwords in plaintext?*

**Answer:** No.

**Additional Information:** OWUI uses bcrypt for any stored password hashes. The only "plaintext" value in the user table is the `placeholder-no-login` marker on pre-provisioned accounts, which is explicitly not a credential; see AAAI-07.

---

### AAAI-09

**Q:** Are audit logs available that include AT LEAST all of the following: login, logout, actions performed, and source IP address?*

**Answer:** Yes, with caveats.

**Additional Information:** OWUI's internal event log captures logins, logouts, and major user actions. DigitalOcean App Platform captures application and access logs including source IP. Cloudflare captures request-level logs for the API. Log retention is the platform default (~7 days for DO App Platform logs). Database-layer audit is available via DO Managed PostgreSQL.

---

### AAAI-10

**Q:** Describe or provide a reference to the (a) system capability to log security/authorization changes, as well as user and administrator security events; and (b) all requirements necessary to implement logging and monitoring on the system; and (c) information about SIEM/log collector usage.

**Answer:**

(a) OWUI logs authentication events (OIDC login success/failure via CILogon), authorization changes (group membership changes, access-grant changes on models/tools/functions) via admin-panel events, and user actions (conversation creation/deletion, tool invocations, model selection).

(b) No special configuration required; logging is default-on across the OWUI, DigitalOcean App Platform, and Cloudflare layers.

(c) No SIEM or external log collector is integrated. Logs are retained at their respective platform defaults. If UCSC ITS requires forwarding to a campus SIEM, this is feasible via DO App Platform's log-forwarding integrations.

**Additional Information:**

---

### AAAI-11

**Q:** Can you provide the institution documentation regarding the retention period for those logs, how logs are protected, and whether they are accessible to the customer (and if so, how)?*

**Answer:**

- **Retention:** Default platform retention — approximately 7 days for DO App Platform live application logs; longer for Cloudflare Workers analytics; DO Managed PostgreSQL backups per DO's managed-backup schedule.
- **Protection:** Logs are accessible only to the operator via authenticated DO and Cloudflare admin interfaces. DO and Cloudflare encrypt logs at rest as part of their SOC 2 program.
- **Institution access:** UCSC ITS/ISO can be granted visibility on request. There is no general customer log portal today because there is only one institutional customer (UCSC) and one administrator (the operator).

**Additional Information:**

---

### AAAI-12

**Q:** For customers not using SSO, does your application support integration with other authentication and authorization systems?

**Answer:** N/A — SSO is required.

**Additional Information:**

---

### AAAI-13

**Q:** Do you allow the customer to specify attribute mappings for any needed information beyond a user identifier?

**Answer:** Yes — configured via the OWUI app spec environment variables (`OAUTH_SCOPES`, `OAUTH_GROUPS_CLAIM`, `OAUTH_GROUPS_SEPARATOR`).

**Additional Information:** Current mapping: `openid`, `email`, `profile`, `org.cilogon.userinfo` scopes are requested; `affiliation` (eduPerson-equivalent, semicolon-separated) is the group claim. See `../chat/DESIGN.md §1` and §1a.

---

### AAAI-14

**Q:** For customers not using SSO, does your application support directory integration for user accounts?

**Answer:** N/A.

**Additional Information:**

---

### AAAI-15

**Q:** Does your solution support any of the following web SSO standards: SAML2 (with redirect flow), OIDC, CAS, or other?

**Answer:** Yes — OIDC via CILogon.

**Additional Information:** CILogon itself federates to UCSC's SAML IdP. OWUI's implementation is provider-agnostic (`OPENID_PROVIDER_URL` points at any `.well-known/openid-configuration`).

---

### AAAI-16

**Q:** Do you support differentiation between email address and user identifier?

**Answer:** Yes. OWUI distinguishes the OIDC `sub` (persistent subject identifier from CILogon) from the `email` claim.

**Additional Information:** `OAUTH_MERGE_ACCOUNTS_BY_EMAIL=true` is used to support the placeholder-account merge flow (see `../chat/DESIGN.md §1b`); `OAUTH_UPDATE_EMAIL_ON_LOGIN` is intentionally unset so a stored email is not clobbered by a later CILogon claim.

---

### AAAI-17

**Q:** For customers not using SSO, does your application and/or user frontend/portal support multifactor authentication?

**Answer:** N/A — MFA is provided by UCSC's IdP upstream of CILogon (Duo).

**Additional Information:** Because all authentication flows through the UCSC IdP via CILogon, MFA posture matches whatever UCSC requires of the user's campus account. BayLeaf does not hold MFA enrollment itself.

---

### AAAI-18

**Q:** Does your application automatically lock the session or log out an account after a period of inactivity?

**Answer:** Yes — OWUI enforces JWT session timeouts per `WEBUI_SECRET_KEY`-signed tokens.

**Additional Information:** Session tokens expire per OWUI's default lifetime and must be re-issued via OIDC. API tokens (`sk-bayleaf-*`) do not expire on inactivity but are revocable at any time via the D1 `revoked` flag (see `SECURITY.md §3.2`).

---

### — Data —

### DATA-01

**Q:** Will the institution's data be stored on any devices configured with non-RFC 1918 (i.e., publicly routable) IP addresses?*

**Answer:** Data is stored in managed cloud services (DigitalOcean Managed PostgreSQL, DO Spaces, Cloudflare D1), not on devices with directly-routable public IPs. All database access is TLS-protected and authenticated; public ingress to application-layer components is terminated at TLS with authentication required.

**Additional Information:**

---

### DATA-02

**Q:** Is the transport of sensitive data encrypted using security protocols/algorithms (e.g., system-to-client)?*

**Answer:** Yes — TLS 1.2+ everywhere.

**Additional Information:** User → Cloudflare: TLS terminated at Cloudflare edge (TLS 1.2+/1.3). Cloudflare → DO: TLS. OWUI → OpenRouter: TLS. OWUI → DO managed PostgreSQL: TLS. Worker → D1: platform-internal, Cloudflare-managed. No plaintext data transport.

---

### DATA-03

**Q:** Is the storage of sensitive data encrypted using security protocols/algorithms (e.g., disk encryption, at-rest, files, and within a running database)?*

**Answer:** Yes.

**Additional Information:**

- DigitalOcean Managed PostgreSQL: encrypted at rest per DO's [managed-database security model](https://www.digitalocean.com/security/shared-responsibility-model-managed-databases).
- DigitalOcean Spaces: AES-256 at rest per DO's [Spaces security model](https://www.digitalocean.com/security/shared-responsibility-model-spaces).
- Cloudflare D1: encrypted at rest per [Cloudflare's D1 data-security documentation](https://developers.cloudflare.com/d1/reference/data-security/).
- Daytona sandbox volumes: encrypted at rest per Daytona's security documentation.

---

### DATA-04

**Q:** Do all cryptographic modules in use in your solution conform to the Federal Information Processing Standards (FIPS PUB 140-2 or 140-3)?*

**Answer:** Not validated at the BayLeaf layer.

**Additional Information:** BayLeaf relies on standard cloud-provider cryptography (OpenSSL/BoringSSL on DigitalOcean, Cloudflare's edge TLS stack, AES-256 at-rest via provider-managed keys). Some upstream providers maintain FIPS-validated modules for subsets of their services (DigitalOcean, Cloudflare); BayLeaf does not assert FIPS 140-2/140-3 conformance as an independent compliance claim.

---

### DATA-05

**Q:** Will the institution's data be available within the system for a period of time at the completion of this contract?*

**Answer:** Per-user data is exportable by the user at any time via OWUI's built-in chat-export feature. Retention is governed by a published 90-day rolling policy (`../chat/RETENTION.md`; `../api/RETENTION.md`) with an announced sunrise grace period (announced 2026-04-28, expires 2026-07-27) that gives every user a full 90-day window to export data after the policy's introduction. On service decommission, data is destroyed per `SECURITY.md §2.4`.

**Additional Information:** There is no "contract" in the vendor sense. If the service ends, there is no intermediate transfer period; the operator destroys databases and object storage.

---

### DATA-06

**Q:** Are ownership rights to all data, inputs, outputs, and metadata retained even through a provider acquisition or bankruptcy event?*

**Answer:** Yes — users retain ownership of their inputs and outputs.

**Additional Information:** BayLeaf does not claim ownership of user data. The operator has no saleable interest in user data to transfer in an acquisition/bankruptcy scenario. The service itself is not saleable — it is a faculty-operated artifact, not a business.

---

### DATA-07

**Q:** Do backups containing the institution's data ever leave the institution's data zone either physically or via network routing?*

**Answer:** No.

**Additional Information:** DigitalOcean managed backups stay within DigitalOcean's infrastructure (SFO region). The operator does not take copies of backups off-platform.

---

### DATA-08

**Q:** Is media used for long-term retention of business data and archival purposes stored in a secure, environmentally protected area?*

**Answer:** Yes — delegated to DigitalOcean. No operator-held media.

**Additional Information:** All long-term retention is on DO-managed storage (covered by DO's SOC 2 physical security controls).

---

### DATA-09

**Q:** At the completion of this contract, will data be returned to the institution and/or deleted from all your systems and archives?

**Answer:** Data is deleted on a published schedule during normal operations (90-day rolling retention on conversations and sandboxes; see `../chat/RETENTION.md` and `../api/RETENTION.md`). On service wind-down, remaining data is destroyed rather than returned or transferred. Per-user export is available at any time via OWUI's chat-export UI.

**Additional Information:**

---

### DATA-10

**Q:** Can the institution extract a full or partial backup of data?

**Answer:** Partial: individual users can export their conversations via the OWUI UI. No tenant-wide export tool is built in, but the operator can produce a full database export to UCSC ITS on request.

**Additional Information:**

---

### DATA-11

**Q:** Do current backups include all operating system software, utilities, security software, application software, and data files necessary for recovery?

**Answer:** Yes. The combination of the pinned OWUI Docker image, the DO app spec (backed up in the repo), the model/tool/function JSON (backed up in `../chat/`), and DO's PostgreSQL backups is sufficient for a complete rebuild per the recovery procedure in `../chat/DESIGN.md §6`.

**Additional Information:**

---

### DATA-12

**Q:** Are you performing off-site backups (i.e., digitally moved off site)?

**Answer:** Not performed by the operator; DigitalOcean's managed-backup service handles off-host replication within its SOC 2 boundary.

**Additional Information:**

---

### DATA-13

**Q:** Are physical backups taken off-site?

**Answer:** Not applicable.

**Additional Information:**

---

### DATA-14

**Q:** Are data backups encrypted?

**Answer:** Yes — encrypted at rest by DigitalOcean per their managed-database security model.

**Additional Information:**

---

### DATA-15

**Q:** Do you have a media handling process that is documented and currently implemented that meets established business needs and regulatory requirements, including end-of-life, repurposing, and data-sanitization procedures?

**Answer:** Delegated to cloud providers. BayLeaf handles no physical media.

**Additional Information:** DO and Cloudflare media-sanitization practices are covered by their respective SOC 2 attestations.

---

### DATA-16

**Q:** Does the process described in DATA-15 adhere to DoD 5220.22-M and/or NIST SP 800-88 standards?

**Answer:** Per the upstream provider's SOC 2 controls. Not independently asserted by BayLeaf.

**Additional Information:**

---

### DATA-17

**Q:** Does your staff (or third party) have access to institutional data (e.g., financial, PHI, or other sensitive information) through any means?

**Answer:** The sole operator has administrative access to the OWUI database (conversation histories, user accounts, access grants) and to Cloudflare D1 (API key mappings) for operational reasons — troubleshooting, abuse response, and incident handling.

**Additional Information:** Access is used only for operational purposes and only when needed. The operator does not routinely browse user content. See `SECURITY.md §7` (design principle 6: single-administrator model).

---

### DATA-18

**Q:** Do you have a documented and currently implemented strategy for securing employee workstations when they work remotely?

**Answer:** The sole operator works from UCSC-managed or policy-compliant devices with FileVault at-rest encryption, auto-lock, and campus-mandated security controls.

**Additional Information:**

---

### DATA-19

**Q:** Does the environment provide for dedicated single-tenant capabilities? If not, describe how your solution or environment separates data from different customers.

**Answer:** Effectively single-tenant: BayLeaf has one institutional customer (UCSC). The service is not multi-tenant; per-user isolation within UCSC is enforced by OWUI's authorization model (user/group/access-grant checks on every request).

**Additional Information:**

---

### DATA-20

**Q:** Are ownership rights to all data, inputs, outputs, and metadata retained by the institution?

**Answer:** Yes — see DATA-06.

**Additional Information:**

---

### DATA-21

**Q:** In the event of imminent bankruptcy, closing of business, or retirement of service, will you provide 90 days for customers to get their data out of the system and migrate applications?

**Answer:** Yes — the operator commits to providing at least 90 days' notice to UCSC before final wind-down, during which users can export their data via OWUI's chat-export UI.

**Additional Information:**

---

### DATA-22

**Q:** Are involatile backup copies made according to predefined schedules and securely stored and protected?

**Answer:** Yes, via DigitalOcean managed-database backups.

**Additional Information:** DO managed-PostgreSQL backup cadence applies (daily full + continuous WAL, with point-in-time recovery available per DO's default retention window). User-deleted records and records expired under the 90-day rolling retention policy (`../chat/RETENTION.md`) age out of these backups on DO's schedule. The operator does not perform manual backup scrubs. Retention periods end-to-end: conversations — 90 days from last activity; sandbox content — 90 days from last activity; revoked API keys — persist indefinitely for reject-on-use behavior (with a pending improvement to scrub `or_key_secret` after a grace period, see `../api/RETENTION.md`); session cookies — 24 hours; Cloudflare edge logs — ~72 hours.

---

### DATA-23

**Q:** Do you have a cryptographic key management process that is documented and currently implemented, for all system components?

**Answer:** Yes, in the form of platform-native secret management at each layer.

**Additional Information:** See `SECURITY.md §6` for the full credential inventory:

- **DigitalOcean encrypted environment variables** for: `WEBUI_SECRET_KEY` (session signing), `OAUTH_CLIENT_SECRET`, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, `DATABASE_URL`.
- **Cloudflare Worker secrets** for: OpenRouter provisioning key, CILogon client secret, Daytona API key, campus-pool OpenRouter key.
- **OWUI admin valves** for tool-layer keys (Tavily, Jina, Daytona, Canvas, GitHub, Google OAuth client).
- **Rotation:** Keys are rotated on suspected compromise, on provider key-lifecycle events, or on operator-initiated schedules. No automated rotation in place for provider-issued keys.

---

## Infrastructure

### — Application/Service Security —

### APPL-01

**Q:** Are access controls for institutional accounts based on structured rules, such as RBAC, ABAC, or PBAC?*

**Answer:** Yes — RBAC + ABAC.

**Additional Information:** OWUI enforces role-based access (admin/user) plus attribute/group-based access via `access_grants` on models, tools, and skills. Groups are populated by (a) OAuth-sync from the CILogon `affiliation` claim (e.g. `Faculty@ucsc.edu`, `Student@ucsc.edu`) and (b) manually-managed namespaced groups (`legacy:*`, `course:*`, `access:*`, `admin:*`) protected from OAuth-sync clobbering via `OAUTH_BLOCKED_GROUPS`. See `../chat/DESIGN.md §1a`.

---

### APPL-02

**Q:** Are you using a web application firewall (WAF)?*

**Answer:** Yes — Cloudflare WAF fronts both `chat.bayleaf.dev` and `api.bayleaf.dev`.

**Additional Information:** Cloudflare's managed WAF ruleset is enabled, including the OWASP core ruleset equivalent. `CORS_ALLOW_ORIGIN` is explicitly set to `https://chat.bayleaf.dev` (no wildcard).

---

### APPL-03

**Q:** Are only currently supported operating system(s), software, and libraries leveraged by the system(s)/application(s) that will have access to institution's data?*

**Answer:** Yes.

**Additional Information:** OWUI runs from the pinned upstream Docker image on a currently-supported version. DigitalOcean App Platform base runtimes are provider-maintained. Worker runtime is the currently-supported Cloudflare Workers runtime. Dependencies are tracked by Dependabot and updated regularly.

---

### APPL-04

**Q:** Does your application require access to location or GPS data?*

**Answer:** No.

**Additional Information:** BayLeaf does not request geolocation. IP-level source is visible for logging (and used for the Campus Pass IP-range check in the API — Cloudflare `CF-Connecting-IP` compared against UCSC's published CIDR ranges).

---

### APPL-05

**Q:** Does your application provide separation of duties between security administration, system administration, and standard user functions?*

**Answer:** Partial. OWUI distinguishes the admin role from standard users. Within the admin role, however, all security-administrative and system-administrative functions are held by the sole operator; no further separation is possible in a single-operator service.

**Additional Information:**

---

### APPL-06

**Q:** Do you subject your code to static code analysis and/or static application security testing prior to release?*

**Answer:** Yes — GitHub Advanced Security (code scanning + secret scanning) and Dependabot are enabled on both source repositories, with findings resolved by fix rather than silenced.

**Additional Information:** See `DEPENDENCIES.md` for the dependency audit rationale.

---

### APPL-07

**Q:** Do you have software testing processes (dynamic or static) that are established and followed?*

**Answer:** Yes, at a scale appropriate to a solo-operator service. Static: as in APPL-06. Dynamic: behavioral testing via the operator's personal OWUI (`chat.adamsmith.as`) before promotion to production when feasible.

**Additional Information:**

---

### APPL-08

**Q:** Are access controls for staff within your organization based on structured rules, such as RBAC, ABAC, or PBAC?

**Answer:** Yes — there is one staff member (the operator), who holds admin on all systems via OIDC. Third-party personnel with access: none.

**Additional Information:**

---

### APPL-09

**Q:** Does the system provide data input validation and error messages?

**Answer:** Yes, at OWUI and Worker layers.

**Additional Information:** OWUI validates JSON schemas on admin API endpoints and model/tool specifications. The API validates OpenAI-compatible chat request schemas before forwarding to OpenRouter. For AI-specific input handling, see AISC-04 in the AI section.

---

### APPL-10

**Q:** Do you have a process and implemented procedures for managing your software supply chain (e.g., libraries, repositories, frameworks, etc.)?

**Answer:** Yes.

**Additional Information:** GitHub Advanced Security + Dependabot monitor the declared dependency set. OWUI upstream image pin is reviewed before bumps. `DEPENDENCIES.md` is the running ledger of supply-chain decisions with per-dependency exit paths. One supply-chain note: the OWUI container build fetches a data-retention cleanup script from GitHub at build time; this is reviewed and pinned to the expected path in the BayLeaf-controlled repository.

---

### APPL-11

**Q:** Have your developers been trained in secure coding techniques?

**Answer:** Yes — sole developer has formal training through doctoral research and academic experience in software systems; annual UCSC cybersecurity awareness training; active participation in campus security governance via the UCSC AI Council.

**Additional Information:**

---

### APPL-12

**Q:** Was your application developed using secure coding techniques?

**Answer:** Yes, for BayLeaf-authored code. BayLeaf is substantially built on upstream software (OWUI, Workers-runtime primitives); that software is out of BayLeaf's direct development scope but is monitored for security releases.

**Additional Information:**

---

### APPL-13

**Q:** If mobile, is the application available from a trusted source (e.g., App Store, Google Play Store)?

**Answer:** N/A — no dedicated mobile app. The web interface is responsive and usable from mobile browsers.

**Additional Information:**

---

### APPL-14

**Q:** Do you have a fully implemented policy or procedure that details how your employees obtain administrator access to institutional instance of the application?

**Answer:** Sole-operator: administrator access is held by the operator by default via OIDC. No other persons are granted admin access.

**Additional Information:**

---

### — Datacenter —

### DCTR-01

**Q:** Select your hosting option.

**Answer:** Public cloud (IaaS/PaaS) — DigitalOcean App Platform (SFO region) for Chat; Cloudflare Workers (US edge) for API; DO Spaces (SFO2) for object storage; DO Managed PostgreSQL for relational storage; Cloudflare D1 for API key mappings.

**Additional Information:** BayLeaf operates no datacenters. All DCTR answers rely on the SOC 2 Type 2 audits of the upstream providers.

---

### DCTR-02

**Q:** Is a SOC 2 Type 2 report available for the hosting environment?

**Answer:** Yes. DigitalOcean maintains a SOC 2 Type 2 report; Cloudflare maintains SOC 2 Type 2 and ISO 27001. Reports are available through each provider's trust portal.

**Additional Information:**

---

### DCTR-03

**Q:** Are you generally able to accommodate storing each institution's data within its geographic region?

**Answer:** Yes — all storage is in US regions (SFO/SFO2) today. BayLeaf is a single-institution service; all data stays in the US.

**Additional Information:**

---

### DCTR-04

**Q:** Are the data centers staffed 24 hours a day, seven days a week?

**Answer:** Yes, at the upstream provider. DO and Cloudflare datacenters are 24×7 staffed per their SOC 2 controls.

**Additional Information:**

---

### DCTR-05

**Q:** Are your servers separated from other companies via a physical barrier, such as a cage or hard walls?

**Answer:** Per upstream-provider data-center controls. BayLeaf uses shared cloud infrastructure; physical-cage isolation is not contracted.

**Additional Information:**

---

### DCTR-06

**Q:** Does a physical barrier fully enclose the physical space, preventing unauthorized physical contact with any of your devices?*

**Answer:** Per upstream provider physical security controls (documented in DO and Cloudflare SOC 2 reports).

**Additional Information:**

---

### DCTR-07

**Q:** Are your primary and secondary data centers geographically diverse?

**Answer:** DO Managed PostgreSQL provides primary + standby within the SFO region. Cross-region redundancy is not currently configured (single-region deployment); DO's managed-service SLAs provide the recovery posture within region.

**Additional Information:**

---

### DCTR-08

**Q:** Is the service hosted in a high-availability environment?

**Answer:** Yes — DO App Platform runs managed with automatic restart; Cloudflare Workers is globally redundant by design; DO Managed PostgreSQL runs with standby.

**Additional Information:**

---

### DCTR-09

**Q:** Is redundant power available for all data centers where institutional data will reside?

**Answer:** Yes, per upstream provider SOC 2 controls.

**Additional Information:**

---

### DCTR-10

**Q:** Are redundant power strategies tested?*

**Answer:** Per upstream provider SOC 2 controls.

**Additional Information:**

---

### DCTR-11

**Q:** Does the center where the data will reside have cooling and fire-suppression systems that are active and regularly tested?

**Answer:** Yes, per upstream provider SOC 2 controls.

**Additional Information:**

---

### DCTR-12

**Q:** Do you have Internet Service Provider (ISP) redundancy?

**Answer:** Yes, via Cloudflare's multi-homed edge and DO's datacenter network. Not separately provisioned by BayLeaf.

**Additional Information:**

---

### DCTR-13

**Q:** Does every data center where the institution's data will reside have multiple telephone company or network provider entrances to the facility?

**Answer:** Per upstream provider SOC 2 controls.

**Additional Information:**

---

### DCTR-14

**Q:** Do you require multifactor authentication for all administrative accounts in your environment?

**Answer:** Yes.

**Additional Information:** OWUI admin access: OIDC-only via CILogon → UCSC IdP (Duo MFA). DigitalOcean console: MFA enforced on operator's account. Cloudflare console: MFA enforced. GitHub: MFA enforced. No non-MFA admin paths exist.

---

### DCTR-15

**Q:** Are you using your cloud provider's available hardening tools or pre-hardened images?

**Answer:** Yes — OWUI runs from the upstream maintained image; DO App Platform provides platform-hardened runtimes; Cloudflare Workers runs on Cloudflare's hardened V8 isolate runtime.

**Additional Information:**

---

### DCTR-16

**Q:** Does your cloud solution provider have access to your encryption keys?

**Answer:** Yes — at-rest encryption keys are managed by the cloud providers (DO for Postgres/Spaces, Cloudflare for D1). This is the default managed-service model.

**Additional Information:** Application-layer secrets (OAuth client secret, session signing key, API provider keys) are encrypted by DO's env-var encryption / Cloudflare's Worker secrets store. Customer-managed keys (CMK) are not in use.

---

### — Firewalls, IDS, IPS, and Networking —

### FIDP-01

**Q:** Are you utilizing a stateful packet inspection (SPI) firewall?*

**Answer:** Delegated to upstream providers.

**Additional Information:** Cloudflare provides its managed WAF and its network-level filtering at the edge. DO App Platform operates behind DO's managed network perimeter. BayLeaf does not operate its own SPI firewall.

---

### FIDP-02

**Q:** Do you have a documented policy for firewall change requests?*

**Answer:** No separate policy — firewall/WAF rule changes are made by the operator via Cloudflare console and recorded in the public GitHub repository when code-driven.

**Additional Information:**

---

### FIDP-03

**Q:** Have you implemented an intrusion detection system (network-based)?*

**Answer:** Delegated to upstream providers (Cloudflare's managed detection; DO's platform controls).

**Additional Information:**

---

### FIDP-04

**Q:** Do you employ host-based intrusion detection?*

**Answer:** Not at the BayLeaf layer (no hosts under operator management); upstream providers run their own host IDS on the underlying infrastructure per SOC 2.

**Additional Information:**

---

### FIDP-05

**Q:** Are audit logs available for all changes to the network, firewall, IDS, and IPS systems?*

**Answer:** Yes — Cloudflare console audit logs record WAF/DNS/Workers configuration changes; DO App Platform surfaces spec changes in deployment history and app update audit logs.

**Additional Information:**

---

### FIDP-06

**Q:** Is authority for firewall change approval documented?

**Answer:** Sole operator (Adam Smith) is the sole approver.

**Additional Information:**

---

### FIDP-07

**Q:** Have you implemented an intrusion prevention system (network-based)?

**Answer:** Delegated to Cloudflare's managed IPS/WAF rules.

**Additional Information:**

---

### FIDP-08

**Q:** Do you employ host-based intrusion prevention?

**Answer:** Not at the BayLeaf layer; upstream provider-managed.

**Additional Information:**

---

### FIDP-09

**Q:** Are you employing any next-generation persistent threat (NGPT) monitoring?

**Answer:** Not at the BayLeaf layer.

**Additional Information:**

---

### FIDP-10

**Q:** Is intrusion monitoring performed internally or by a third-party service?

**Answer:** By third parties — Cloudflare's managed detection, DO's managed platform detection, GitHub Advanced Security for code-level threats.

**Additional Information:**

---

### FIDP-11

**Q:** Do you monitor for intrusions on a 24 x 7 x 365 basis?

**Answer:** Yes, per upstream providers. Human response at the BayLeaf operator layer is best-effort during operator's waking hours; critical escalations flow to UCSC ISO.

**Additional Information:**

---

### — Incident Handling —

### HFIH-01

**Q:** Do you have a formal incident response plan?

**Answer:** Partial — vulnerability reporting is formalized in the repo-root `SECURITY.md` (<https://github.com/bayleaf-ucsc/bayleaf/blob/main/SECURITY.md>), with published acknowledgment and response SLAs (3 business days for acknowledgment, 10 business days for substantive response). A broader formal IR plan does not exist at the BayLeaf layer; incidents are handled by the operator with escalation to UCSC ISO as appropriate.

**Additional Information:** `SECURITY.md §8` discloses this limitation explicitly.

---

### HFIH-02

**Q:** Do you either have an internal incident response team or retain an external team?

**Answer:** No dedicated team at the BayLeaf layer. Operator + UCSC ISO escalation path.

**Additional Information:**

---

### HFIH-03

**Q:** Do you have the capability to respond to incidents on a 24 x 7 x 365 basis?

**Answer:** No — best-effort by the solo operator. Automated mitigations (rate limits, revocation of API keys via D1 `revoked` flag, Cloudflare WAF rules) can be triggered quickly but the operator is not 24×7 on-call. UCSC ISO provides the institutional 24×7 backstop.

**Additional Information:**

---

### HFIH-04

**Q:** Do you carry cyber-risk insurance to protect against unforeseen service outages, data that is lost or stolen, and security incidents?

**Answer:** No BayLeaf-specific cyber-risk insurance. The operator is covered by UC's institutional insurance posture as a UC employee. `FERPA.md §5.2` notes that a proposed direct Google Cloud integration would inherit the UC-Google contracted cyber insurance ($10M) and data-breach enhanced cap ($20M) for Gemini-routed traffic.

**Additional Information:**

---

### — Vulnerability Management —

### VULN-01

**Q:** Are your systems and applications scanned with an authenticated user account for vulnerabilities (that are remediated) prior to new releases?*

**Answer:** Partial.

**Additional Information:** Static analysis (GitHub Advanced Security, Dependabot) runs continuously. Authenticated dynamic scanning is not performed on a pre-release cadence at the BayLeaf layer; UCSC ISO may perform such scanning on mutually agreed schedules (see VULN-03).

---

### VULN-02

**Q:** Will you provide results of application and system vulnerability scans to the institution?*

**Answer:** Yes.

**Additional Information:** GitHub Advanced Security findings are visible on the public repo; Dependabot alerts can be shared on request.

---

### VULN-03

**Q:** Will you allow the institution to perform its own vulnerability testing and/or scanning of your systems and/or application, provided that testing is performed at a mutually agreed upon time and date?*

**Answer:** Yes.

**Additional Information:** The operator welcomes coordinated scanning/pen-testing by UCSC ISO or its delegate. Coordination is needed primarily to pre-notify upstream providers (DO, Cloudflare have abuse policies on scanning) and to avoid triggering automated rate-limiting.

---

### VULN-04

**Q:** Have your systems and applications had a third-party security assessment completed in the last year?

**Answer:** No independent assessment at the BayLeaf layer. Upstream providers (DO, Cloudflare) have current third-party SOC 2 Type 2 audits.

**Additional Information:**

---

### VULN-05

**Q:** Do you regularly scan for common web application security vulnerabilities (e.g., SQL injection, XSS, XSRF, etc.)?

**Answer:** Yes — via GitHub Advanced Security code scanning on both repositories. Cloudflare WAF provides runtime protection against common web attack patterns.

**Additional Information:** Originally-flagged findings have been resolved by fix (not silenced). Prompt-injection attacks against the LLM layer are a separate concern addressed in AISC-04.

---

### VULN-06

**Q:** Are your systems and applications regularly scanned externally for vulnerabilities?

**Answer:** Via Cloudflare-managed external posture. Explicit externally-initiated scans are permitted per VULN-03.

**Additional Information:**

---

## IT Accessibility

### ITAC-01

**Q:** Solution Provider Accessibility Contact Name

**Answer:** Adam Smith

**Additional Information:**

---

### ITAC-02

**Q:** Solution Provider Accessibility Contact Title

**Answer:** Associate Professor, Department of Computational Media, UC Santa Cruz (sole operator).

**Additional Information:**

---

### ITAC-03

**Q:** Solution Provider Accessibility Contact Email

**Answer:** amsmith@ucsc.edu

**Additional Information:**

---

### ITAC-04

**Q:** Solution Provider Accessibility Contact Phone Number

**Answer:** (831) 295-2624

**Additional Information:**

---

### ITAC-05

**Q:** Web Link to Accessibility Statement or VPAT

**Answer:** No dedicated BayLeaf VPAT/ACR exists. The primary web UI is Open WebUI upstream (<https://openwebui.com>); accessibility conformance at that layer is determined by OWUI's maintainers.

**Additional Information:**

---

### ITAC-06

**Q:** Has a VPAT or ACR been created or updated for the solution and version under consideration within the past 12 months?*

**Answer:** No.

**Additional Information:**

---

### ITAC-07

**Q:** Will your company agree to meet your stated accessibility standard or WCAG 2.1 AA as part of your contractual agreement for the solution?*

**Answer:** The operator commits to prioritizing accessibility issues reported against the BayLeaf-specific layer (landing page, custom model configurations, tool-output rendering patterns). Upstream UI accessibility is outside the operator's direct control; the operator's escalation path is to file issues upstream to the Open WebUI project.

**Additional Information:**

---

### ITAC-08

**Q:** Does the solution substantially conform to WCAG 2.1 AA?*

**Answer:** Not independently attested. Open WebUI's own accessibility posture determines the answer for the primary UI.

**Additional Information:**

---

### ITAC-09

**Q:** Do you have a documented and implemented process for reporting and tracking accessibility issues?*

**Answer:** Accessibility issues can be reported to `amsmith@ucsc.edu` or via the GitHub issue tracker at <https://github.com/bayleaf-ucsc/bayleaf/issues>. There is no separate accessibility tracker.

**Additional Information:**

---

### ITAC-10

**Q:** Do you have documentation to support the accessibility features of your solution?

**Answer:** Upstream-dependent; no BayLeaf-specific accessibility documentation beyond what OWUI publishes.

**Additional Information:**

---

### ITAC-11

**Q:** Has a third-party expert conducted an audit of the most recent version of your solution?

**Answer:** No.

**Additional Information:**

---

### ITAC-12

**Q:** Do you have a documented and implemented process for verifying accessibility conformance?

**Answer:** No formal process at the BayLeaf layer.

**Additional Information:**

---

### ITAC-13

**Q:** Have you adopted a technical or legal standard of conformance for the solution?

**Answer:** WCAG 2.1 AA is the target (aspirational, tracking Open WebUI upstream).

**Additional Information:**

---

### ITAC-14

**Q:** Can you provide a current, detailed accessibility roadmap with delivery timelines?

**Answer:** No formal roadmap at the BayLeaf layer.

**Additional Information:**

---

### ITAC-15

**Q:** Do you expect your staff to maintain a current skill set in IT accessibility?

**Answer:** Yes, for the sole operator — through UCSC professional development resources and through the operator's role as a faculty member engaging with accessibility as a pedagogical concern.

**Additional Information:**

---

### ITAC-16

**Q:** Do you have documented processes and procedures for implementing accessibility into your development lifecycle?

**Answer:** Informal.

**Additional Information:**

---

### ITAC-17

**Q:** Can all functions of the application or service be performed using only the keyboard?

**Answer:** Dependent on Open WebUI upstream. OWUI's text-entry interface is substantially keyboard-operable.

**Additional Information:**

---

### ITAC-18

**Q:** Does your product rely on activating a special "accessibility mode," a "lite version," or using an alternate interface for accessibility purposes?

**Answer:** No.

**Additional Information:**

---

## AI

### — AI Qualifying Questions —

### AIQU-01

**Q:** Does your solution leverage machine learning (ML) or do you plan to do so in the next 12 months?

**Answer:** Yes, via third-party LLMs. BayLeaf does not train or fine-tune its own ML models.

**Additional Information:**

---

### AIQU-02

**Q:** Does your solution leverage a large language model (LLM) or do you plan to do so in the next 12 months?

**Answer:** Yes. BayLeaf's primary function is to provide access to LLMs.

**Additional Information:** Models reached via OpenRouter, restricted to endpoints contracted for zero-data-retention (ZDR). Providers include Anthropic (Claude), Google (Gemini), OpenAI (GPT), Meta (Llama), Z-AI (GLM-5.1), and others, each via their ZDR-flagged endpoints. An NRP/SDSC institutional path is configured but currently disabled because NRP's policy is to log prompts.

---

### — General AI Questions —

### AIGN-01

**Q:** Does your solution have an AI risk model when developing or implementing your solution's AI model?*

**Answer:** Informally, yes — aligned with NIST AI RMF concepts and with UCSC AI Council guidance.

**Additional Information:** `SECURITY.md` and `FERPA.md` capture the substantive risk analysis (data flows, contractual protections, ZDR boundary, subprocessor political profile). Specific risk categories addressed: model-provider data retention (mitigated by ZDR-only routing); prompt-injection via tool-using models (mitigated by stealth-toolkit pattern limiting which tools are exposed on which models and by user-in-the-loop confirmation for OAuth-scoped capabilities like GWS); environmental cost (disclosed in `DEPENDENCIES.md`); vendor lock-in (dependency audit with documented exit paths); over-reliance on upstream model providers with divergent political profiles (documented in `DEPENDENCIES.md`).

---

### AIGN-02

**Q:** Can your solution's AI features be disabled by tenant and/or user?*

**Answer:** Partially. BayLeaf's AI features *are* the service; disabling them means not using BayLeaf. What can be controlled: (a) users can pick any model they are granted access to, including lower-capability models; (b) per-model tool bindings are controlled by the operator (admin); (c) the operator can deactivate any model or tool globally with a configuration change.

**Additional Information:**

---

### AIGN-03

**Q:** Have your staff completed responsible AI training?*

**Answer:** Yes. The sole operator is a UCSC faculty member whose academic work centers on AI (Computational Media department), an active member of the UCSC AI Council, and completes UCSC's mandatory annual cybersecurity and responsible-use training.

**Additional Information:**

---

### AIGN-04

**Q:** Please describe the capabilities of your solution's AI features.

**Answer:**

- **Text generation:** conversational and instruction-following LLM responses.
- **Code generation and agentic coding:** via the Code Sandbox (Lathe) toolkit, which backs LLM-issued `bash`, `read`, `write`, `edit`, etc. calls with per-user Daytona sandbox VMs.
- **Vision / visual interpretation:** select models accept images (uploaded via OWUI).
- **Structured tool calling:** curated toolkits (web search, web reader, Google Workspace per-user OAuth, Canvas for course-specific models, DeepInfra key minting, YouTube stub, campus directory, date conversion, random choice, Lathe code sandbox).
- **Not capabilities:** no image generation, no audio/video generation, no speech recognition at the BayLeaf layer, no predictive analytics.

**Additional Information:** See `../chat/DESIGN.md §2` (workspace models) and §3 (tools) for the full catalog.

---

### AIGN-05

**Q:** Does your solution support business rules to protect sensitive data from being ingested by the AI model?

**Answer:** Partial.

**Additional Information:** BayLeaf does not perform automated DLP-style input inspection. Protections: (a) ZDR at the provider level ensures data sent to the inference layer is not retained beyond response generation; (b) user guidance (in the Help model and in campus-facing documentation) directs users not to enter P3/PHI/PCI content; (c) model-level system prompts instruct the model on campus-appropriate behavior. True DLP filtering of user inputs is not implemented.

---

### — AI Policy —

### AIPL-01

**Q:** Are your AI developer's policies, processes, procedures, and practices across the organization related to the mapping, measuring, and managing of AI risks conspicuously posted, unambiguous, and implemented effectively?*

**Answer:** Public and documented in this repository.

**Additional Information:** `SECURITY.md`, `FERPA.md`, `DEPENDENCIES.md`, and `POSITION.md` together form BayLeaf's operational AI-risk posture. Effective implementation is the responsibility of the sole operator, subject to UC/UCSC institutional oversight.

---

### AIPL-02

**Q:** Have you identified and measured AI risks?*

**Answer:** Yes, qualitatively. See AIGN-01.

**Additional Information:**

---

### AIPL-03

**Q:** In the event of an incident, can your solution's AI features be disabled in a timely manner?*

**Answer:** Yes.

**Additional Information:** Any model, tool, or filter can be deactivated via the OWUI admin UI or `owui-cli` within minutes. Cloudflare Worker routes can be disabled from the dashboard. Rate-limiting can be tightened globally via the `rate_limit_filter`.

---

### AIPL-04

**Q:** If disabled because of an incident, can your solution's AI features be re-enabled in a timely manner?*

**Answer:** Yes — reactivation is the reverse of the deactivation procedure, performed by the operator.

**Additional Information:**

---

### AIPL-05

**Q:** Do you have documented technical and procedural processes to address potential negative impacts of AI as described by the AI Risk Management Framework (RMF)?

**Answer:** Partial — `SECURITY.md` and `POSITION.md` document the operator's posture.

**Additional Information:**

---

### — AI Data Security —

### AISC-01

**Q:** If sensitive data is introduced to your solution's AI model, can the data be removed from the AI model by request?*

**Answer:** Not applicable in the usual sense — BayLeaf does not train or fine-tune any model on user data. The ZDR contract at the inference layer means data is not retained in the model or its serving infrastructure after the response. Conversation history in the OWUI database can be deleted by the user or by the administrator on request; see DATA-09.

**Additional Information:**

---

### AISC-02

**Q:** Is user input data used to influence your solution's AI model?*

**Answer:** No. User inputs are not used for training, fine-tuning, embedding into a vector store shared across users, or any cross-user memory.

**Additional Information:** OWUI has a per-user "memory" feature that is scoped to the individual user and stored in the OWUI database; it is not shared with the model provider as training data. Per-user chats are likewise isolated.

---

### AISC-03

**Q:** Do you provide logging for your solution's AI feature(s) that includes user, date, and action taken?*

**Answer:** Yes. OWUI logs user identity (OIDC `sub` / email), timestamp, and action (model invocation, tool call). DigitalOcean App Platform retains application logs at platform defaults (~7 days). Cloudflare Worker logs are retained per Cloudflare platform defaults. Logs are administrator-accessible; see AAAI-09..11.

**Additional Information:**

---

### AISC-04

**Q:** Please describe how you validate user inputs.

**Answer:**

- **Transport-layer validation:** Cloudflare WAF applies managed rules including OWASP core patterns.
- **Request-schema validation:** the API validates OpenAI-compatible chat request schemas before forwarding.
- **Prompt-injection resistance:** tools that would take privileged actions (e.g. Google Workspace write operations via `gws_toolkit`, Canvas submissions via `brace_submit_action`) require explicit user consent or user-in-the-loop confirmation via OWUI's event-emitter modals, not model-alone decisions.
- **Tool-exposure minimization:** the "stealth toolkit" pattern (see `../chat/DESIGN.md §3a`) restricts which tools any given model can call. Tools that expose internal state (groups, access grants) are never exposed on general-purpose models.
- **Rate limiting:** the `rate_limit_filter` caps requests per user (10/min, 50/hr, 100/3hr) and applies globally.
- **Not implemented:** automated DLP scanning of user prompts for sensitive content.

**Additional Information:**

---

### AISC-05

**Q:** Do you plan for and mitigate supply-chain risk related to your AI features?

**Answer:** Yes. See `DEPENDENCIES.md` (the dependency audit) and AIGN-01.

**Additional Information:** The dependency audit explicitly tracks model-provider and gateway ownership changes (e.g. a16z / Menlo Ventures funding of OpenRouter and the political profile thereof, Nebius's 2026 acquisition of Tavily, GitHub's August 2025 loss of operational independence within Microsoft). Documented exit paths for every subprocessor.

---

### — AI Machine Learning —

### AIML-01

**Q:** Do you separate ML training data from your ML solution data?*

**Answer:** Not applicable. BayLeaf does no training or fine-tuning. Upstream model providers are contracted under ZDR terms that prohibit the use of BayLeaf's prompts/completions for training.

**Additional Information:**

---

### AIML-02..08

**Answer:** Not applicable — BayLeaf does not train, validate, or watermark its own ML models; it consumes third-party LLMs via API. See AIML-01.

**Additional Information:**

---

### — AI Large Language Model (LLM) —

### AILM-01

**Q:** Do you limit your solution's LLM privileges by default?*

**Answer:** Yes. Default "Basic" model on Chat has no tool bindings beyond a curated skill set and cannot take actions in external systems without the user enabling Code Sandbox or GWS. Tools that take external-state-changing actions require OAuth consent or explicit user confirmation (see AISC-04).

**Additional Information:**

---

### AILM-02

**Q:** Is your LLM training data vetted, validated, and verified before training the solution's AI model?*

**Answer:** N/A — BayLeaf does not train LLMs.

**Additional Information:**

---

### AILM-03

**Q:** Do any actions taken by your solution's LLM features or plugins require human intervention?*

**Answer:** Yes for consequential actions.

**Additional Information:** Google Workspace actions (drafting emails, creating/editing calendar events, writing to Sheets) require per-chat OAuth consent via an in-chat modal and are scoped to the capabilities the user grants; capabilities are also capped by the operator's `enabled_capabilities` admin valve. Canvas write-back actions (the Brace v2 `brace_submit_action`) require an explicit user button press. Read-only tool calls (web search, web reader, read a Canvas page, campus directory, date conversion) do not require per-call confirmation but are bounded by the user's own permissions in the target system.

---

### AILM-04

**Q:** Do you limit multiple LLM model plugins being called as part of a single input?*

**Answer:** Informally.

**Additional Information:** OWUI permits a model to call multiple tools across a single turn; tool-loop iteration is bounded implicitly by model output-token limits and by the `rate_limit_filter`. No explicit "tool-calls-per-turn" hard limit is configured at the BayLeaf layer.

---

### AILM-05

**Q:** Do you limit your solution's LLM resource use per request, per step, and per action?

**Answer:** Yes. Per-user rate limits apply globally (see HFIH). Per-API-key spending caps apply on the API side. Sandbox VM resource use is bounded by Daytona's plan. Lathe `bash` invocations are bounded by a 2-minute default timeout and output truncation (2000 lines / 50 KB).

**Additional Information:**

---

### AILM-06

**Q:** Do you leverage LLM model tuning or other model validation mechanisms?

**Answer:** No fine-tuning. Validation takes the form of (a) curated system prompts per workspace model, (b) `help_filter` / `brace*_filter` stealth-injection of curated tool surfaces, (c) operator-driven behavioral testing of new model/tool combinations before they are exposed to campus users.

**Additional Information:**

---

## Privacy

### — General Privacy —

### PRGN-01

**Q:** Does your solution process FERPA-related data?

**Answer:** Not by design, but possibly via user-pasted content or the course-roster pre-provisioning workflow.

**Additional Information:** See `FERPA.md` for the full FERPA analysis. Current posture: BayLeaf is **not** on the UCSC AI Council's P3-approved list, and users handling FERPA-protected content are directed to UCSC-approved Workspace-Gemini or NotebookLM instead. Proposed path: `FERPA.md §8` contains a draft § 99.31(a)(1)(i)(B) designation memo; approval via that path would make BayLeaf a designated school official and permit FERPA-covered use.

---

### PRGN-02

**Q:** Does your solution process GDPR-related or PIPL-related data?

**Answer:** Not by design. The service is scoped to UCSC campus community users. EEA- or China-located users may access the service if they authenticate through UCSC IdP; no specialized GDPR/PIPL compliance posture is offered.

**Additional Information:**

---

### PRGN-03

**Q:** Does your solution process personal data regulated by state law(s) (e.g., CCPA)?

**Answer:** Yes — CCPA applies because the service is operated in California with California users.

**Additional Information:** UC Regents is the data controller at the institutional layer; BayLeaf operates within that frame.

---

### PRGN-04

**Q:** Does your solution process user-provided data that may contain regulated information?

**Answer:** Yes — users can paste arbitrary content into prompts.

**Additional Information:** See AISC-04 and REQU-08. No input DLP. Contract and design controls (ZDR, SSO-only, per-user isolation) are the mitigations.

---

### PRGN-05

**Q:** Web Link to Product/Service Privacy Notice

**Answer:** No standalone privacy notice exists at `bayleaf.dev` today. The service's privacy posture is documented in `SECURITY.md §2` and `FERPA.md`. A published privacy notice at `bayleaf.dev/privacy` is a reasonable artifact to produce as part of the approval process and is under consideration.

**Additional Information:**

---

### — Privacy-Specific Company Details —

### PCOM-01

**Q:** Have you had a personal data breach in the past three years that involved reporting to a governmental agency, notice to individuals, or notice to another organization or institution?*

**Answer:** No.

**Additional Information:**

---

### PCOM-02

**Q:** Use this area to share information about your privacy practices that will assist those who are assessing your company data privacy program.*

**Answer:** Key points:

1. All LLM inference is routed to ZDR-contracted provider endpoints via OpenRouter. Prompts and completions are not retained by model providers.
2. BayLeaf itself retains conversation histories, user profiles, and uploaded files in encrypted databases, accessible only to the sole administrator, who uses that access only for operational purposes.
3. No data is sold, shared with advertisers, used for training, or exposed to data brokers.
4. No cross-user content sharing, no cross-institution sharing, no analytics pixels, no third-party trackers embedded in the UI.
5. Deletion initiated by the user is honest — records are removed from the database, not soft-deleted; they age out of DO managed backups on DO's schedule. Conversation and sandbox data is additionally subject to automatic 90-day inactivity-based deletion under the published retention policy (`../chat/RETENTION.md`, `../api/RETENTION.md`), with records-hold exemption via `hold:*` groups for litigation/audit/CPRA scenarios.

**Additional Information:**

---

### PCOM-03

**Q:** Have you had any violations of your internal privacy policies or violations of applicable privacy law in the past 36 months?

**Answer:** No.

**Additional Information:**

---

### PCOM-04

**Q:** Do you have a dedicated data privacy staff or office?

**Answer:** No at the BayLeaf layer; yes at the institutional layer (UCSC Privacy Office, UCSC Chief Privacy Officer, UC systemwide Privacy Board).

**Additional Information:**

---

### — Privacy-Specific Documentation —

### PDOC-01

**Q:** If you have completed a SOC 2 audit, does it include the Privacy Trust Service Principle?

**Answer:** N/A — BayLeaf has not completed a SOC 2 audit (see DOCU-03).

**Additional Information:**

---

### PDOC-02

**Q:** Do you conform with a specific industry-standard privacy framework?

**Answer:** Aligned with UC's privacy framework (UC Statement of Privacy Values and Privacy Principles, IS-3 data classification), which reflects NIST Privacy Framework concepts.

**Additional Information:**

---

### PDOC-03

**Q:** Does your employee onboarding and offboarding policy include training of employees on information security and data privacy?

**Answer:** Yes — operator's UCSC annual mandatory training covers both.

**Additional Information:**

---

### — Privacy of Third Parties —

### PTHP-01

**Q:** Do you have contractual agreements with third parties that require them to maintain standards and to comply with all regulatory requirements?*

**Answer:** Yes — per each provider's standard DPA and terms. See THRD-02.

**Additional Information:**

---

### PTHP-02

**Q:** Do you perform privacy impact assessments of third parties that collect, process, or have access to personal data?

**Answer:** Informally — see `DEPENDENCIES.md`.

**Additional Information:**

---

### — Privacy Change Management —

### PCHG-01

**Q:** Does your change management process include privacy review and approval?

**Answer:** Operator-executed; no separate privacy-review authority at the BayLeaf layer. Privacy-material changes (new subprocessor with access to user content, new data-retention behavior) would be reviewed against `SECURITY.md` and `FERPA.md` and communicated to UCSC ITS/Privacy.

**Additional Information:**

---

### PCHG-02

**Q:** Do you have policy and procedure, currently implemented, guiding how privacy risks are mitigated until they can be resolved?

**Answer:** Informally — mitigations include deactivating affected tools/models, tightening rate limits, and communicating with affected users. No formal documented procedure.

**Additional Information:**

---

### — Privacy of Sensitive Data —

### PDAT-01

**Q:** Do you collect, process, or store demographic information?*

**Answer:** Minimal. From the CILogon `affiliation` claim, BayLeaf obtains eduPerson-equivalent role (Faculty/Student/Employee/etc.) and organizational affiliation (ucsc.edu). Email and display name are also collected. No age, gender, ethnicity, religion, or similar demographic attributes.

**Additional Information:**

---

### PDAT-02

**Q:** Do you capture or create genetic, biometric, or behaviometric information?*

**Answer:** No.

**Additional Information:**

---

### PDAT-03

**Q:** Do you combine institutional data with personal data from any other sources?*

**Answer:** No.

**Additional Information:**

---

### PDAT-04

**Q:** Is institutional data coming into or going out of the United States at any point during collection, processing, storage, or archiving?

**Answer:** Primarily US-resident. One subprocessor (Jina AI, Germany) is used only for the Web Reader tool when the user invokes it; URLs submitted to that tool transit to/from Germany. All other subprocessors are US-based.

**Additional Information:**

---

### PDAT-05

**Q:** Do you capture device information (e.g., IP address, MAC address)?

**Answer:** IP address is captured for logging and for the Campus Pass IP-range check on the API. No MAC address.

**Additional Information:**

---

### PDAT-06

**Q:** Does any part of this service/project involve a web/app tracking component?

**Answer:** No. No third-party analytics pixels, no tracking cookies, no ad-network tags. OWUI uses session cookies for authentication and to persist UI state; these are first-party.

**Additional Information:**

---

### PDAT-07

**Q:** Does your staff (or a third party) have access to institutional data (e.g., financial, PHI, or other sensitive information) through any means?

**Answer:** See DATA-17. Sole operator has administrative access for operational purposes.

**Additional Information:**

---

### PDAT-08

**Q:** Will you handle personal data in a manner compliant with all relevant laws, regulations, and applicable institution policies?

**Answer:** Yes.

**Additional Information:**

---

### — Privacy Policies and Procedures —

### PRPO-01

**Q:** Do you have a documented privacy management process?

**Answer:** Documented in `SECURITY.md §2` and `FERPA.md`.

**Additional Information:**

---

### PRPO-02

**Q:** Are privacy principles designed into the product lifecycle (i.e., privacy-by-design)?

**Answer:** Yes. Key privacy-by-design choices:

- SSO-only with no password login.
- ZDR-only inference routing.
- No cross-user data sharing by architecture.
- Ephemeral OAuth tokens for optional Workspace integration (in-process memory, keyed by `(user, chat)`, lost on restart).
- API key masking in the UI (never displayed in plaintext) to protect users during screen-share.
- Stealth-toolkit pattern to limit tool exposure on general models.

**Additional Information:**

---

### PRPO-03

**Q:** Will you comply with applicable breach notification laws?

**Answer:** Yes — see PPPR-10.

**Additional Information:**

---

### PRPO-04

**Q:** Will you comply with the institution's policies regarding user privacy and data protection?

**Answer:** Yes — operator is already bound as a UCSC employee; BayLeaf's architecture is designed to be consistent with those obligations.

**Additional Information:**

---

### PRPO-05

**Q:** Is your company subject to the laws and regulations of the institution's geographic region?

**Answer:** Yes — California and US federal jurisdiction.

**Additional Information:**

---

### PRPO-06

**Q:** Do you have a privacy awareness/training program?*

**Answer:** Sole operator completes UCSC's mandatory annual cybersecurity and privacy training.

**Additional Information:**

---

### PRPO-07

**Q:** Is privacy awareness training mandatory for all employees?

**Answer:** Yes (sole operator). Annual UCSC-mandated.

**Additional Information:**

---

### PRPO-08

**Q:** Is AI privacy and ethics awareness/training required for all employees who work with AI?

**Answer:** Yes. The operator's faculty work is in AI; active participation in UCSC AI Council governance; active participation in campus discussions of AI ethics.

**Additional Information:**

---

### PRPO-09

**Q:** Do you have any decision-making processes that are completely automated (i.e., there is no human involvement)?

**Answer:** No decisions of consequence are automated. The `rate_limit_filter` automatically denies requests beyond the configured thresholds, but this is a throttling mechanism, not a consequential decision about users. LLM outputs are advisory; any action taken as a result of an LLM output depends on the user's own judgment and actions.

**Additional Information:**

---

### PRPO-10

**Q:** Do you have a documented process for managing automated processing, including validations, monitoring, and data subject requests?

**Answer:** Rate-limiter parameters are recorded in the `rate_limit_filter` source (committed). Data-subject requests (access, correction, deletion) are handled by the operator on request; most users can self-serve deletion via OWUI's UI.

**Additional Information:**

---

### PRPO-11

**Q:** Do you have a documented policy for sharing information with law enforcement?

**Answer:** No BayLeaf-specific policy. Law-enforcement requests are routed through UCSC Campus Counsel per UC policy.

**Additional Information:**

---

### PRPO-12

**Q:** Do you share any institutional data with law enforcement without a valid warrant or subpoena?*

**Answer:** No.

**Additional Information:**

---

### PRPO-13

**Q:** Does your incident response team include a privacy analyst/officer?

**Answer:** No BayLeaf-layer privacy analyst. Escalation to UCSC Privacy Office for privacy-material incidents.

**Additional Information:**

---

### — International Privacy —

### INTL-01

**Q:** Will data be collected from or processed in or stored in the European Economic Area (EEA)?

**Answer:** Only incidentally. Data is stored in US regions; if a user is located in the EEA when they access BayLeaf, their request traverses Cloudflare's edge (which may be in the EEA) before reaching US storage. The Jina AI reader tool, when invoked, sends URLs to servers in Germany.

**Additional Information:**

---

### INTL-02

**Q:** Do you have a data protection officer (DPO)?

**Answer:** No BayLeaf-specific DPO. UCSC Chief Privacy Officer provides the institutional function.

**Additional Information:**

---

### INTL-03

**Q:** Will you sign appropriate GDPR Standard Contractual Clauses (SCCs) with the institution?

**Answer:** BayLeaf is not the GDPR data controller; UC Regents is, for UCSC community members. SCCs between UCSC and its subprocessors (DigitalOcean, Cloudflare, etc.) are those providers' standard terms.

**Additional Information:**

---

### INTL-04

**Q:** Will data be collected from or processed in or stored in China?

**Answer:** No.

**Additional Information:**

---

### INTL-05

**Q:** Do you comply with PIPL security, privacy, and data localization requirements?

**Answer:** N/A — no PRC processing.

**Additional Information:**

---

### — Data Privacy —

### DRPV-01

**Q:** Have you performed a Data Privacy Impact Assessment for the solution/project?

**Answer:** Yes — documented across `SECURITY.md`, `FERPA.md`, and `DEPENDENCIES.md`. These are substantive, not checkbox, DPIA-equivalent analyses.

**Additional Information:**

---

### DRPV-02

**Q:** Do you provide an end-user privacy notice about privacy policies and procedures that identify the purpose(s) for which personal information is collected, used, retained, and disclosed?

**Answer:** Documented in `SECURITY.md §2`; not yet published as a user-facing privacy page at `bayleaf.dev/privacy`. This is a reasonable artifact to produce as part of approval.

**Additional Information:**

---

### DRPV-03

**Q:** Do you describe the choices available to the individual and obtain implicit or explicit consent with respect to the collection, use, and disclosure of personal information?

**Answer:** Implicit consent via OIDC login flow (CILogon's consent screen discloses attribute release); explicit consent for optional capabilities (GWS OAuth per-chat).

**Additional Information:**

---

### DRPV-04

**Q:** Do you collect personal information only for the purpose(s) identified in the agreement with an institution or, if there is none, the purpose(s) identified in the privacy notice?

**Answer:** Yes. No marketing, no advertising, no quality-assurance resale of data.

**Additional Information:**

---

### DRPV-05

**Q:** Do you have a documented list of personal data your service maintains?

**Answer:** Yes — `SECURITY.md §2.2`:

- User accounts: email, display name, OIDC `sub`, OAuth tokens.
- Conversation histories: user's prompts, LLM completions, tool-call results.
- Group memberships and access grants.
- Uploaded files.
- API key mappings (email ↔ `sk-bayleaf-*` ↔ OpenRouter sub-key).
- Sandbox file contents (per-user Daytona VM state).

**Additional Information:**

---

### DRPV-06

**Q:** Do you retain personal information for only as long as necessary to fulfill the stated purpose(s) or as required by law or regulation and thereafter appropriately dispose of such information?

**Answer:** Yes.

**Additional Information:** Retention is documented and automated at both service layers:

- **Chat** (`../chat/RETENTION.md`): 90-day rolling retention on conversations (active and archived) keyed on `updated_at`. Enforced by a daily scheduled cleanup job (DO App Platform Job, `chat/retention_cleanup.py`) that calls the OWUI admin API. Uploaded files cascade with their owning conversations. User-initiated deletion is immediate and permanent. A published sunrise grace period (announced 2026-04-28, expires 2026-07-27) gives every user a full 90-day window from policy announcement to export. Records-hold via `hold:*` group membership exempts users under litigation/audit/CPRA hold (protected from OAuth clobbering via `OAUTH_BLOCKED_GROUPS`). Uniform basis: UCSC Records Retention guidance classifying chat/IM as non-records to be deleted "promptly, or as soon as no longer immediately useful."
- **API** (`../api/RETENTION.md`): LLM proxy traffic not stored (ZDR passthrough). D1 account records persist while active. Revoked key rows retained for reject-on-use behavior (future scrub of `or_key_secret` on revoked rows under consideration). Session cookies expire in 24 hours. Cloudflare edge logs retained ~72 hours per platform default.
- **Code Sandbox (Lathe)**: per-user Daytona VMs auto-stop at 15 min idle, auto-archive 60 min after stop, and auto-delete 90 days after archive (`DAYTONA_AUTO_DELETE_MINUTES=129600`). No persistent volume. Aligns with the 90-day conversation retention window.

---

### DRPV-07

**Q:** Do you provide individuals with access to their personal information for review and update (i.e., data subject rights)?

**Answer:** Yes. Users can view and export their own chats, profile, and memory via the OWUI UI. Access/correction/deletion requests are honored by the operator.

**Additional Information:**

---

### DRPV-08

**Q:** Do you disclose personal information to third parties only for the purpose(s) identified in the privacy notice or with the implicit or explicit consent of the individual?

**Answer:** Yes.

**Additional Information:**

---

### DRPV-09

**Q:** Do you protect personal information against unauthorized access (both physical and logical)?

**Answer:** Yes. Logical: SSO-only authentication, role-based authorization, encrypted at rest and in transit. Physical: delegated to DO and Cloudflare (SOC 2 Type 2).

**Additional Information:**

---

### DRPV-10

**Q:** Do you maintain accurate, complete, and relevant personal information for the purposes identified in the privacy notice?

**Answer:** Yes. `OAUTH_UPDATE_NAME_ON_LOGIN=true` refreshes display names from CILogon on every login; email is a stable merge key; user memories are user-controlled.

**Additional Information:**

---

### DRPV-11

**Q:** Do you have procedures to address privacy-related noncompliance complaints and disputes?

**Answer:** Yes — `amsmith@ucsc.edu`, GitHub issues, GitHub Private Vulnerability Reporting, or escalation to UCSC Privacy Office.

**Additional Information:**

---

### DRPV-12

**Q:** Do you "anonymize," "de-identify," or otherwise mask personal data?

**Answer:** Not routinely. Data in the OWUI database is identifiable.

**Additional Information:**

---

### DRPV-13

**Q:** Do you or your subprocessors use or disclose "anonymized," "de-identified," or otherwise masked data for any purpose other than those identified in the agreement with an institution?

**Answer:** No.

**Additional Information:**

---

### DRPV-14

**Q:** Do you certify stop-processing requests, including any data that is processed by a third party on your behalf?

**Answer:** Yes — the operator will certify stop-processing on request. Because the ZDR inference contract means provider-side stop-processing is the default (no retention), the primary surface is the OWUI database and uploads, both of which the operator controls.

**Additional Information:**

---

### DRPV-15

**Q:** Do you have a process to review code for ethical considerations?

**Answer:** Yes, informally. The operator's academic role includes AI ethics. `POSITION.md` documents the operator's position on AI in higher education, which informs feature and tool selection. `DEPENDENCIES.md` surfaces the political profile of each dependency.

**Additional Information:**

---

### — Privacy and AI —

### DPAI-01

**Q:** Does your service use AI for the processing of institutional data?

**Answer:** Yes — the primary function. See REQU-04, AIQU-02.

**Additional Information:**

---

### DPAI-02

**Q:** Is any institutional data retained in AI processing?*

**Answer:** At the inference layer, no — ZDR terms at OpenRouter-routed provider endpoints prohibit retention of prompts and completions beyond response generation. At the application layer, conversation histories are stored in OWUI's encrypted PostgreSQL database and automatically deleted after 90 days of inactivity per the published retention policy (`../chat/RETENTION.md`), with records-hold exemption via `hold:*` group membership for litigation/audit/CPRA scenarios. User-initiated deletion is immediate and permanent.

**Additional Information:** The "ZDR is narrow" disclosure in `SECURITY.md §8` is preserved: ZDR covers inference only. Beyond the inference layer, the protections are (a) the 90-day rolling deletion policy enforced by an automated daily job calling the OWUI admin API, (b) at-rest AES-256 encryption, (c) single-administrator access, and (d) honest user-initiated deletion that removes records from the application database rather than soft-deleting.

---

### DPAI-03

**Q:** Do you have agreements in place with third parties or subprocessors regarding the protection of customer data and use of AI?*

**Answer:** Yes — under each provider's standard DPA and terms, with ZDR as the specific commitment at OpenRouter and its downstream providers. See THRD-02.

**Additional Information:** `FERPA.md §5.2` analyzes the proposed direct Google Cloud integration, which would inherit UCSC's 2024 Customer Affiliate Agreement (Google Customer Affiliate ID 7947-1465-9142) and the UC-wide GCP License Agreement and 2025 Enterprise Addendum — explicit contractual no-AI/ML-training commitment (§15.1(d)), P4 data classification, UC-negotiated breach/insurance caps.

---

### DPAI-04

**Q:** Will institutional data be processed through a third party or subprocessor that also uses AI?

**Answer:** Yes — the model providers themselves. ZDR terms prohibit their use of BayLeaf's traffic for their own AI development.

**Additional Information:**

---

### DPAI-05

**Q:** Is AI processing limited to fully licensed commercial enterprise AI services?

**Answer:** Yes — all inference is via licensed commercial providers (Anthropic, Google, OpenAI, Meta via DeepInfra, Z-AI, etc., all under OpenRouter's ZDR contracts).

**Additional Information:**

---

### DPAI-06

**Q:** Will institutional data be used or processed by any shared AI services?

**Answer:** Yes, in the sense that the underlying model weights are the same weights used by other customers of those model providers. ZDR means institutional data is not used to update those weights. No cross-customer sharing of data.

**Additional Information:**

---

### DPAI-07

**Q:** Do you have safeguards in place to protect institutional data and data privacy from unintended AI queries or processing?

**Answer:** Yes. ZDR contract, SSO-only access, per-user isolation, rate limiting, stealth-toolkit pattern, no cross-user memory, explicit user consent for external-action tools (GWS, Canvas submission).

**Additional Information:**

---

### DPAI-08

**Q:** Do you provide choice to the user to opt out of AI use?

**Answer:** The service is AI-native; the opt-out is not using BayLeaf. Within BayLeaf, users can choose among models with different capabilities and decline to enable tools that take external actions. Users can also use the Help model, which is scoped to account/group/model questions and does not expose general LLM capabilities.

**Additional Information:**

---

## End of HECVAT

This document is the honest answer to each HECVAT prompt given BayLeaf's current
posture (faculty-operated service, OpenRouter-ZDR inference, DigitalOcean +
Cloudflare platform, CILogon/InCommon SSO, documented subprocessor inventory)
and the proposed path to UCSC P3 approval (`FERPA.md §8` draft
designation memo, potential direct Google Cloud integration for Gemini traffic).

Further questions should be directed to `amsmith@ucsc.edu` or via the
GitHub-based reporting channels in the repo-root `SECURITY.md`.
