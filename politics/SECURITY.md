# Security Exhibit

**Service:** BayLeaf AI Playground  
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz  
**Date:** 2026-04-24  
**Review conducted by:** AI agent (Claude Opus 4.7 via OpenCode), supervised by Adam Smith

This document describes the security and data handling posture of BayLeaf. It is
written for the audience that asks for a "security exhibit" — an ITS reviewer, an
IRB protocol, a risk assessment form. It is honest about what the service does and
does not guarantee.

---

## 1. Architecture

| Component | Platform | Function |
|---|---|---|
| BayLeaf Chat (`chat.bayleaf.dev`) | DigitalOcean App Platform | Open WebUI — curated LLM access with tools, groups, rate limiting |
| BayLeaf API (`api.bayleaf.dev`) | Cloudflare Workers | OpenRouter-proxying API with key provisioning and sandbox execution |
| About site (`bayleaf.dev`) | GitHub Pages | Static informational page |

LLM inference routes through two configured backends: **OpenRouter** (commercial
gateway, restricted to **zero-data-retention (ZDR)** provider endpoints) and
**NRP/SDSC** (NSF-funded institutional inference via [Envoy AI Gateway](https://aigateway.envoyproxy.io/)
on the [National Research Platform](https://nrp.ai/documentation/userdocs/ai/llm-managed/)).
OpenRouter handles traffic by default; NRP is a configured alternative serving
open-weight models on public research infrastructure. No model provider on either
path retains prompt or completion content.

---

## 2. Data handling

### 2.1 What is not retained

- **No message content at the inference layer.** ZDR providers receive prompts,
  generate responses, and discard both. Enforced at the OpenRouter configuration level.
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
| API key mappings (email, token, OR key hash) | Cloudflare D1 | [Encrypted at rest](https://developers.cloudflare.com/d1/reference/data-security/) | System administrator only |
| Sandbox file contents | Daytona VMs with persistent volume | [Encrypted at rest](https://mintlify.wiki/daytonaio/daytona/concepts/security#data-at-rest) | Per-user isolation |

### 2.3 ZDR boundary disclosure

The ZDR guarantee covers **inference only**. The application layer (Open WebUI
database) retains conversation histories in an encrypted database accessible only
to the system administrator. The database is backed up by DigitalOcean's managed
service; backups stay within the DigitalOcean trust boundary and are not
replicated to third parties.

The [dependency audit](DEPENDENCIES.md) makes this point directly: "The ZDR boundary
is narrower than it sounds."

### 2.4 Retention and deletion

- **User-initiated deletion is honest.** When a user deletes a conversation
  through the Chat interface, the record is removed from the application
  database. It is not soft-deleted or retained in a recoverable tombstone.
- **Otherwise, retention is indefinite.** There is no scheduled deletion policy
  for conversation histories, user accounts, uploaded files, or API key
  mappings. Data a user has not deleted persists for as long as BayLeaf
  operates.
- **Backups.** DigitalOcean's managed-database backup schedule applies.
  User-deleted records age out of backups according to that schedule; BayLeaf
  does not perform manual backup scrubs.
- **Service wind-down.** If BayLeaf is decommissioned, the operator will
  destroy the databases and object storage rather than transfer them.

---

## 3. Authentication and access control

### 3.1 Chat

- **Identity provider:** CILogon (InCommon Federation), OIDC protocol
- **IdP hint:** UCSC (`urn:mace:incommon:ucsc.edu`)
- **No password login** — OAuth only; direct signup disabled
- **Group sync:** CILogon `affiliation` claim (e.g. `Faculty@ucsc.edu`) synced to
  Open WebUI groups on each login; full reconcile (adds and removes)
- **Invite codes:** JWT-encoded, reference group UUID, processed server-side
- **Session:** JWT-based, signed with a persistent secret key stored in DigitalOcean
  encrypted environment variables

### 3.2 API (three tiers)

| Tier | Mechanism | Persistence |
|---|---|---|
| Campus Pass | IP-range detection (UCSC CIDRs via Cloudflare `CF-Connecting-IP`) | Ephemeral — no account, no persistent sandbox |
| BayLeaf Token (`sk-bayleaf-*`) | Self-service key provisioned after OIDC auth; maps to OpenRouter sub-key with spending limits | Persistent sandbox, revocable |
| Raw OpenRouter Key (`sk-or-*`) | Direct passthrough (legacy/compat) | N/A |

BayLeaf tokens provide **proxy indirection**: users never see the underlying
OpenRouter key. This enables revocation and spending control without touching the
upstream provider.

### 3.3 Model access control

- Public models available to all authenticated users
- Group-restricted models gated by group UUID in access grants
- User-level grants available independently of group membership

---

## 4. Subprocessors

| Provider | Role | Jurisdiction | Data exposure |
|---|---|---|---|
| DigitalOcean | Chat hosting, PostgreSQL, S3 | US | User accounts, conversation histories, file uploads |
| Cloudflare | DNS, CDN, Workers, D1 | US (edge) | All traffic transits Cloudflare; D1 holds API key mappings |
| OpenRouter | LLM gateway (default) | US | Prompts and completions in transit (ZDR — not retained) |
| NRP / SDSC | LLM inference (institutional) | US (UC San Diego / NSF) | Prompts and completions in transit on research infrastructure; open-weight models via Envoy AI Gateway |
| CILogon / InCommon | Identity (OIDC) | US (Internet2) | Email, name, affiliation claim |
| Daytona | Code sandboxes | US | Per-user sandbox file contents |
| Tavily | Web search tool | US | Search queries from tool-use |
| Jina AI | Web page reader | Germany | URLs submitted for parsing |
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
  served by alternative backends (e.g. NRP/SDSC) are not metered against this
  cap.
- **Campus pool:** Shared key for keyless campus users with aggregate spending
  limit (OpenRouter-routed requests only, same caveat as above).
- **Key revocation:** Immediate via D1 `revoked` flag, checked on every request.
- **No request-rate limits on the API.** BayLeaf does not enforce per-key
  requests-per-minute or requests-per-hour caps. Abuse prevention on the API
  side is achieved through spending caps and revocation, not throttling.

### Sandboxes

- Campus-pass users: ephemeral (created and destroyed per request)
- Keyed users: persistent, idle-stop after 15 minutes, auto-archive after 60 minutes
- File upload/download restricted to keyed users only

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
| Tool API keys (Tavily, Jina, etc.) | Open WebUI admin valves |
| Database URL | DigitalOcean runtime env var |
| OpenRouter provisioning key | Cloudflare Worker secret |
| Campus pool key | Cloudflare Worker secret |

---

## 7. Design principles

1. **Proxy indirection.** Users never hold raw provider keys. BayLeaf tokens are
   an opaque layer enabling revocation and spending control.
2. **Multi-backend inference.** Two inference backends are configured: OpenRouter
   (commercial, ZDR) and NRP/SDSC (institutional, NSF-funded). Traffic can shift
   between them without user-facing changes. This is dual-sourcing, not redundancy
   — the backends have different political profiles and cost structures.
3. **System prompt enforcement.** A BayLeaf system prompt prefix is prepended to all
   API-proxied requests. Users cannot suppress it.
4. **Provider-agnostic OIDC.** Authentication discovers endpoints from
   `.well-known/openid-configuration`. Identity provider switches are configuration
   changes, not code changes.
5. **Screen-sharing safety.** API keys are never displayed in plaintext.
6. **Single-administrator model.** One operator has administrative access to all
   components. No shared admin accounts.

---

## 8. Limitations and honest disclosures

- **Single operator.** No formal change management process, no SOC 2 certification,
  no penetration testing cadence. This is a faculty-operated experimental service,
  not an enterprise product.
- **ZDR is narrow.** It covers inference only. Conversation histories exist in the
  application database.
- **No formal incident response plan.** Issues are handled ad hoc by the operator.
- **FERPA.** BayLeaf in its current OpenRouter-routed form is not among the
  campus-approved tools for FERPA-protected (P3) content; users handling such
  content should instead use the Workspace-based Gemini and NotebookLM tools
  UCSC has already approved for that purpose. See [FERPA.md](FERPA.md) for the
  full analysis, including the contract-stack comparison and the open question
  (on the AI Council's summer 2026 agenda) of whether a proposed direct Google
  Cloud integration would extend the existing P3 approval to BayLeaf's Google
  lane.
- **HIPAA.** The service is not designed for protected health information and no
  BAA is in place with any provider.
- **Dependency on commercial providers.** OpenRouter, DigitalOcean, and Cloudflare
  are commercially funded companies with their own data access capabilities. NRP/SDSC
  is NSF-funded public infrastructure but is not under BayLeaf's operational control.
  See the [dependency audit](DEPENDENCIES.md) for a full analysis.
- **No second deployment.** The claim that "any faculty member could build this" is
  architectural, not empirically verified. No independent replication exists.

---

## 9. Contact

**System administrator:** Adam Smith — `amsmith@ucsc.edu`
**Source code:** https://github.com/rndmcnlly/bayleaf (public)
