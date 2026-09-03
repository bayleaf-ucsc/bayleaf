# Security Exhibit

**Service:** BayLeaf<br>
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz<br>
**Date:** 2026-07-29<br>
**Review conducted by:** AI agents via OpenCode, supervised by Adam Smith

This document describes the security and data handling posture of BayLeaf. It is
written for the audience that asks for a "security exhibit": an ITS reviewer, an
IRB protocol, a risk assessment form. It is honest about what the service does and
does not guarantee.

**ITS review status.** BayLeaf has undergone a security review by UC Santa Cruz
Information Technology Services (ITS). The campus Chief Information Security
Officer (CISO) and his team reviewed the service and deemed it **ready to
launch**: safe for use by the UCSC campus community. This is a review of the
service's security posture, **not** an adoption of BayLeaf as an ITS-operated or
ITS-supported service. BayLeaf remains faculty-operated.

---

## 1. Architecture

| Component | Platform | Function |
|---|---|---|
| BayLeaf Chat (`chat.bayleaf.dev`) | DigitalOcean App Platform | Open WebUI: curated LLM access with tools, groups, rate limiting |
| BayLeaf API (`api.bayleaf.dev`) | Cloudflare Workers | Multi-backend inference API with key provisioning, confidential inference, sandbox execution, and web tools |
| About site (`bayleaf.dev`) | GitHub Pages | Static informational and privacy pages |

The codebase contains several inference lanes, but only lanes whose current
retention and account posture meet BayLeaf's requirements are enabled:

| Lane | Status | Security and contractual posture |
|---|---|---|
| **OpenRouter (Chat)** | Active | Commercial gateway restricted to **zero-data-retention (ZDR)** provider endpoints. Chat exposes a curated catalog that may include both frontier proprietary and open-weight models. This is a commercial agreement, not a UC-negotiated provider contract. |
| **OpenRouter (API plaintext)** | Active | Commercial gateway restricted to ZDR provider endpoints and to verifiable open-weight models. A model is allowed only when OpenRouter reports a nonempty `hugging_face_id` and the corresponding Hugging Face repository resolves; unknown or unverifiable models are denied with HTTP 403. |
| **NRP/SDSC** | Configured, disabled | NSF-funded institutional inference via Envoy AI Gateway on the National Research Platform. Disabled because NRP's documented policy permits prompt logging, which does not meet BayLeaf's ZDR floor. |
| **Google Vertex AI** | Implemented, disabled | UC/UCSC has institutional Google Cloud agreements, including data-protection terms applicable to covered institutional use. BayLeaf's current operator-controlled GCP project is not treated as proven covered by those terms, and Google did not grant or confirm the Abuse Monitoring opt-out needed for ZDR parity. |
| **Amazon Bedrock (mantle)** | Implemented, disabled | UC has institutional AWS/BAA arrangements, but the proof-of-concept credential is from the operator's personal AWS account and has **no UCSC BAA coverage**. The lane is also paused pending an enforceable open-weight listing policy; account retention mode is set to `none` on the POC account. |
| **BayLeaf API Sealed / Tinfoil** | Active (opt-in route) | Client-verifiable confidential inference over Tinfoil's current open-weight catalog. A compatible client verifies enclave attestation and encrypts the requested model and body before they reach BayLeaf. Non-streaming usage metadata may reveal the executed model. BayLeaf does not independently enforce catalog composition. Enabled 2026-07-29 with a per-user daily request guardrail; dollar-denominated spend reconciliation remains outstanding. BayLeaf publishes no accepted-measurement policy of its own, deliberately: the guarantee is carried by the client's verifier, not by an operator-served artifact. |

The institutional Google and AWS agreements establish credible migration paths,
not present coverage BayLeaf claims for its operator-controlled accounts. Moving
either lane into production requires credentials from an account or project whose
institutional contractual scope has been confirmed in writing, in addition to the
technical enablement checklist for that lane.

---

## 2. Data handling

### 2.1 What is not retained

- **No message content retained by active inference providers.** OpenRouter-routed
  providers receive prompts, generate responses, and discard both under ZDR.
  Disabled lanes do not receive production traffic. Sealed request and response
  bodies, including the requested model, are encrypted to the enclave and remain
  opaque to BayLeaf; Tinfoil's attested workload processes them transiently when
  the client verifies attestation.
- **No API keys displayed in plaintext.** Masked inputs with clipboard-copy buttons
  only, because users may screen-share while using the system.
- **No secrets in the public repository.** Enforced by contributor policy and review.

### 2.2 What is retained

| Data | Storage | Encryption | Access |
|---|---|---|---|
| User accounts (email, name, OAuth tokens) | DigitalOcean Managed PostgreSQL | [Encrypted at rest](https://www.digitalocean.com/security/shared-responsibility-model-managed-databases) | System administrator only |
| Conversation histories | DigitalOcean Managed PostgreSQL | [Encrypted at rest](https://www.digitalocean.com/security/shared-responsibility-model-managed-databases) | System administrator only |
| Group memberships and access grants | DigitalOcean Managed PostgreSQL | [Encrypted at rest](https://www.digitalocean.com/security/shared-responsibility-model-managed-databases) | System administrator only |
| Uploaded files | DigitalOcean Spaces (S3-compatible) | [Encrypted at rest (AES-256)](https://www.digitalocean.com/security/shared-responsibility-model-spaces) | System administrator only |
| API account and credential mappings (email, BayLeaf token, cached OpenRouter/Tinfoil credentials, quota counters, sandbox ID) | Cloudflare D1 | [Encrypted at rest](https://developers.cloudflare.com/d1/reference/data-security/) | System administrator only |
| API model-eligibility verdicts (model identifier and provenance result; no request content) | Cloudflare KV | [Encrypted at rest](https://developers.cloudflare.com/kv/reference/data-security/) | System administrator only; definite verdicts cached for 24 hours, unknown verdicts not cached |
| Sandbox file contents | Daytona sandbox VM filesystem (no separate persistent volume) | Daytona-managed storage | Per-user isolation; destroyed with sandbox |

### 2.3 ZDR boundary disclosure

The ZDR guarantee covers **inference only**. The application layer (Open WebUI
database) retains conversation histories in an encrypted database accessible only
to the system administrator. The database is backed up by DigitalOcean's managed
service; backups stay within the DigitalOcean trust boundary and are not
replicated to third parties.

The [dependency audit](DEPENDENCIES.md) makes this point directly: "The ZDR boundary
is narrower than it sounds."

### 2.3a Zero-operator-access posture (API)

Two distinct properties are at play and should not be conflated:

- **ZDR (zero data retention)** is a *retention* property: data is processed
  transiently and not persisted. It is the platform baseline.
- **ZOA (zero operator access)**, as articulated in the
  [AWS Mantle design](https://aws.amazon.com/blogs/machine-learning/exploring-the-zero-operator-access-design-of-mantle/),
  is a stronger *access* property: there is no technical means for an operator
  to read user content even while it transits. ZOA implies ZDR; ZDR does not
  imply ZOA.

BayLeaf applies ZDR everywhere and pursues ZOA where practical.

- **BayLeaf API** is the ZOA target. It retains no prompt or completion content,
  disables Workers Observability, performs no content caching, and exposes no
  request-body logging or interactive shell into the runtime. An operator
  therefore has **no standing access** to prompts or completions: only request
  metadata (model, token counts, timestamps) is observable. The plaintext
  open-weight control caches only definite model-eligibility verdicts, never
  request content, for 24 hours; unknown verdicts are not cached. This is a strong ZOA
  *posture*, not a hardware-attested ZOA *guarantee* like Mantle: there is no
  NitroTPM-style attestation or signed-deploy barrier, so an operator with
  deploy rights could in principle ship a content-logging revision. BayLeaf
  commits not to, and treats any such change as material. The claim made
  publicly is the posture ("no content retained, no standing operator access to
  content in flight"), not full attested ZOA.
- **BayLeaf Chat** cannot be ZOA: it deliberately stores conversation history so
  users can carry chats across devices, and the system administrator can read
  that database (§2.2, §2.3). Chat is ZDR at the inference layer only.
- **BayLeaf Sealed** is the stronger, structural ZOA path. A compatible client
  verifies Tinfoil's enclave attestation and encrypts the request body to the
  enclave's HPKE key before the bytes reach BayLeaf. The Worker relays ciphertext
  but does not possess the decryption key; plaintext requests and readable
  responses fail closed rather than falling back to the ordinary proxy. This
  excludes the BayLeaf operator from content access even if a logging revision
  were deployed. The full provider-side claim remains conditional on correct
  client verification and on the client pinning an approved workload
  measurement. BayLeaf deliberately publishes no measurement policy of its own,
  because an operator-served trust policy is circular; the client's verifier
  independently checks the hardware attestation, signed source provenance,
  runtime measurement, and the enclave's encryption key. Identity, timing, byte
  sizes, executed-model metadata on non-streaming responses, and billing metadata
  remain outside ZOA; the requested model field and body remain opaque to BayLeaf.

### 2.4 Retention and deletion

- **User-initiated deletion is honest.** When a user deletes a conversation
  through the Chat interface, the record is removed from the application
  database. It is not soft-deleted or retained in a recoverable tombstone.
- **Automated 90-day retention.** Conversations (active and archived) and
  their attached uploaded files are automatically deleted after 90 days of
  inactivity (keyed on `updated_at`). Enforcement is via a daily scheduled
  job (DO App Platform Job, `chat/retention_cleanup.py`) that operates
  through the OWUI admin API rather than direct database access. Full
  policy, algorithm, and audit posture are documented in
  [`chat/RETENTION.md`](../chat/RETENTION.md). A parallel policy for the
  API and its Daytona-backed code sandboxes is in
  [`api/RETENTION.md`](../api/RETENTION.md).
- **Sunrise grace period.** The retention policy was announced on
  2026-04-28, with all pre-existing conversations treated as if their last
  activity occurred on or after that date. The grace period expires
  2026-07-27, guaranteeing every user a full 90-day export window from the
  announcement date.
- **Records hold.** Conversations belonging to users in a `hold:*` group
  (e.g. `hold:litigation-2026`, `hold:audit-q2`) are exempt from automatic
  deletion for the duration of the hold. `hold:*` is protected from OAuth
  group-sync clobbering via `OAUTH_BLOCKED_GROUPS`.
- **Accounts, configurations, and operational data** (user accounts,
  workspace models, tools, functions, knowledge bases) are retained
  indefinitely while in use; out of scope for the 90-day conversation
  retention window.
- **Backups.** DigitalOcean's managed-database backup schedule applies.
  User-deleted records and records expired under the 90-day policy age out
  of backups according to that schedule; BayLeaf does not perform manual
  backup scrubs.
- **Service wind-down.** If BayLeaf is decommissioned, the operator will
  destroy the databases and object storage rather than transfer them.

---

## 3. Authentication and access control

### 3.1 Chat

- **Identity provider:** CILogon (InCommon Federation), OIDC protocol
- **IdP hint:** UCSC (`urn:mace:incommon:ucsc.edu`)
- **No password login**: OAuth only; direct signup disabled
- **Group sync:** CILogon `affiliation` claim (e.g. `Faculty@ucsc.edu`) synced to
  Open WebUI groups on each login; full reconcile (adds and removes)
- **Invite codes:** JWT-encoded, reference group UUID, processed server-side
- **Session:** JWT-based, signed with a persistent secret key stored in DigitalOcean
  encrypted environment variables

### 3.2 API (two access modes)

| Tier | Mechanism | Persistence |
|---|---|---|
| Campus Pass | IP-range detection (UCSC CIDRs via Cloudflare `CF-Connecting-IP`) | No account; no sandbox access |
| BayLeaf Token (`sk-bayleaf-*`) | Self-service key provisioned after OIDC auth; maps on first use to backend-specific credentials | Persistent sandbox, revocable |

BayLeaf tokens provide **proxy indirection**: users never see underlying
OpenRouter or Tinfoil credentials. Backend keys are minted lazily on first use.
This enables BayLeaf-side revocation and provider-specific spending controls
without making the user manage provider credentials. Raw OpenRouter keys
(`sk-or-*`) are rejected rather than passed through.

### 3.3 Model access control

- **Chat:** a separately curated OpenRouter-ZDR catalog may expose both frontier
  proprietary and open-weight models. Public models are available to all
  authenticated users; group-restricted models are gated by group UUID in access
  grants, and user-level grants are available independently of group membership.
- **API plaintext:** OpenRouter models fail closed unless OpenRouter supplies a
  nonempty `hugging_face_id` and the named Hugging Face repository resolves.
  Unknown or unverifiable models are denied with HTTP 403. This runtime check is
  the policy control that limits plaintext API inference to open-weight models.
- **API Sealed:** Tinfoil's current catalog lists only open-weight models, but
  BayLeaf cannot inspect the encrypted request to enforce that property itself.
  The requested model is opaque; non-streaming usage metadata may reveal the
  executed model.

---

## 4. Subprocessors

| Provider | Role | Jurisdiction | Data exposure |
|---|---|---|---|
| DigitalOcean | Chat hosting, PostgreSQL, S3 | US | User accounts, conversation histories, file uploads |
| Cloudflare | DNS, CDN, Workers, D1 | US (edge) | All traffic transits Cloudflare; D1 holds API key mappings |
| OpenRouter | LLM gateway (Chat and API plaintext) | US | Prompts and completions in transit (ZDR, not retained); Chat catalog is curated, while API plaintext additionally enforces verifiable open-weight provenance |
| Tinfoil | Confidential LLM inference (API Sealed, active) | US | Requested model and request/response bodies encrypted from BayLeaf; identity-linked key metadata, timing, byte counts, non-streaming executed-model and token metadata, and billing data remain visible outside the encrypted body |
| NRP / SDSC | LLM inference (configured, disabled) | US (UC San Diego / NSF) | Would receive prompts and completions on research infrastructure; disabled because its logging policy does not meet BayLeaf's ZDR floor |
| Google Cloud / Vertex AI | LLM inference (implemented, disabled) | US / global | Would receive prompts and completions plus request metadata; current project coverage and ZDR Abuse Monitoring opt-out are unresolved |
| Amazon Web Services / Bedrock | LLM inference (implemented, disabled) | US | Would receive prompts and completions plus request metadata; POC account is personal and not covered by UCSC's BAA |
| CILogon / InCommon | Identity (OIDC) | US (Internet2) | Email, name, affiliation claim |
| Daytona | Code sandboxes | US | Per-user sandbox file contents |
| Tavily | Web search and page extraction tools | US | Search queries, URLs, and fetched page content; no BayLeaf user identity |
| GitHub (Microsoft) | Code hosting, static site | US | Public repository only; no user data |

For ownership, political profile, and exit paths for each provider, see the
[dependency audit](DEPENDENCIES.md).

---

## 5. Rate limiting and abuse prevention

### Chat

- **Global rate limit:** 10 requests/min, 50 requests/hr, 100 requests/3hr
  (sliding window, applies to all users including administrators)

### API

- **Per-key spending limits:** Configurable daily dollar cap per provisioned
  OpenRouter sub-key. Applies only to OpenRouter-routed requests; requests
  served by alternative backends are not metered against this
  cap.
- **Campus pool:** Shared key for keyless campus users with aggregate spending
  limit for OpenRouter traffic. Campus API traffic also has a provider-agnostic
  per-IP daily request counter across chat-completion and Responses requests.
- **Alternative backends:** Vertex and Bedrock have separate per-key daily
  request counters because their spend does not pass through OpenRouter. Their
  lanes are currently disabled. Sealed is active and carries its own per-user
  daily request counter; its spend is metered by the confidential-inference
  provider rather than OpenRouter, and dollar-denominated reconciliation plus a
  concurrency cap remain outstanding work.
- **Key revocation:** Immediate via D1 `revoked` flag, checked on every request.
- **No general per-key RPM limit.** OpenRouter-keyed traffic is controlled by
  spending caps and revocation rather than a universal requests-per-minute cap.

### Sandboxes

- Campus-pass users: ephemeral (created and destroyed per request)
- Keyed users: persistent VM filesystem; idle-stop after 15 minutes, archive
  60 minutes later, permanent deletion 90 days after archive
- File upload/download restricted to keyed users only
- No separate S3/FUSE persistent volume: deleting a sandbox permanently deletes
  its filesystem

---

## 6. Credential management

All secrets are stored in platform-native secret management. None are committed to
the repository.

| Secret | Location |
|---|---|
| OpenRouter API keys | Open WebUI admin panel; Cloudflare Worker secrets |
| OAuth client secret (CILogon) | DigitalOcean encrypted env vars; Cloudflare Worker secrets |
| Session signing key (`WEBUI_SECRET_KEY`) | DigitalOcean encrypted env var |
| S3 access keys | DigitalOcean encrypted env vars |
| Daytona API key | Open WebUI admin valves; Cloudflare Worker secrets |
| Tool API keys (Tavily, etc.) | Open WebUI admin valves |
| Database URL | DigitalOcean runtime env var |
| OpenRouter provisioning key | Cloudflare Worker secret |
| Campus pool key | Cloudflare Worker secret |
| GCP service-account credential (Vertex, disabled) | Open WebUI admin valve; Cloudflare Worker secret |
| Bedrock bearer token (disabled) | Open WebUI connection configuration; Cloudflare Worker secret |
| Tinfoil inference/admin keys (Sealed, active) | Cloudflare Worker secrets; per-user inference credentials cached in D1 |

---

## 7. Design principles

1. **Proxy indirection.** BayLeaf-token users never hold raw provider keys.
   BayLeaf tokens are an opaque layer enabling revocation and spending control;
   raw OpenRouter keys supplied by callers are rejected.
2. **Fail-closed multi-backend inference.** OpenRouter is active for separately
   curated Chat and policy-restricted API plaintext paths; Sealed is also active.
   NRP, Vertex, and Bedrock are separately implemented or configured and
   disabled. The API's Vertex, Bedrock, and Sealed kill switches fail closed
   unless their environment flags equal `"true"`; disabled API lanes reject
   requests and disappear from model listings. Provider portability does not
   imply equivalent retention, contracts, security properties, or model
   provenance.
3. **Open-weight API policy.** Plaintext API inference is allowed only when
   OpenRouter reports a nonempty `hugging_face_id` whose Hugging Face repository
   resolves; unknown models fail closed with HTTP 403. Tinfoil's current Sealed
   catalog lists only open-weight models, but BayLeaf does not independently
   enforce its composition. The plaintext restriction does not apply to Chat's
   separately curated catalog.
4. **Caller-controlled instructions.** The plaintext API proxy does not add or
   rewrite system instructions. Sealed traffic is additionally opaque: BayLeaf
   cannot inspect or modify its encrypted requested-model field or body.
5. **Provider-agnostic OIDC.** Authentication discovers endpoints from
   `.well-known/openid-configuration`. Identity provider switches are configuration
   changes, not code changes.
6. **Screen-sharing safety.** API keys are never displayed in plaintext.
7. **Single-administrator model.** One operator has administrative access to all
   components. No shared admin accounts.

---

## 8. Limitations and honest disclosures

- **Single operator.** No formal change management process, no SOC 2 certification,
  no penetration testing cadence. This is a faculty-operated experimental service,
  not an enterprise product.
- **ZDR is narrow.** It covers inference only. Conversation histories exist in the
  application database.
- **No formal incident response plan.** Issues are handled ad hoc by the operator.
- **FERPA.** BayLeaf's active Chat, API plaintext, and API Sealed inference paths
  are not among the
  campus-approved tools for FERPA-protected (P3) content; users handling such
  content should instead use the Workspace-based Gemini and NotebookLM tools
  UCSC has already approved for that purpose. See [FERPA.md](FERPA.md) for the
  full analysis, including the historical contract-stack comparison. Vertex,
  Bedrock, and NRP are disabled; no active institutional inference lane extends
  the existing P3 approval for Workspace-based Google tools to BayLeaf.
- **HIPAA and BAAs.** The service is not designed or authorized for protected
  health information. UC/UCSC has institutional arrangements with Google Cloud
  and AWS that include BAA coverage for qualifying institutional accounts, but
  BayLeaf does not rely on that coverage for any active lane. Coverage of the
  operator-controlled GCP project has not been confirmed; the Bedrock POC account
  is explicitly personal and uncovered.
- **Dependency on commercial providers.** OpenRouter, DigitalOcean, Cloudflare,
  Daytona, Tavily, and Tinfoil are commercially funded companies with distinct
  content or metadata access. Google and AWS are potential institutional lanes,
  not active ones. NRP/SDSC is NSF-funded public infrastructure but is not under
  BayLeaf's operational control and does not currently meet the ZDR requirement.
  See the [dependency audit](DEPENDENCIES.md) for a full analysis.
- **No second deployment.** The claim that "any faculty member could build this" is
  architectural, not empirically verified. No independent replication exists.

---

## 9. Contact

**System administrator:** Adam Smith, `amsmith@ucsc.edu`  
**Source code:** https://github.com/bayleaf-ucsc/bayleaf (public)
