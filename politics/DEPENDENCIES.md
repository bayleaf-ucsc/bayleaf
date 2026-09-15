# Dependency Audit

BayLeaf claims to be an alternative to vendor lock-in. This document audits every
external dependency in the stack: who owns it, what the political profile is, what
breaks if they change terms, and how fast we can switch. The framework is drawn from
Audre Lorde's question (are these the master's tools?), applied as dependency
analysis rather than rhetorical flourish.

Honest answer up front: BayLeaf's answer to the
[dependency ratchet](README.md#what-we-are-playing-against) is not "no dependencies"
but *legible* dependencies with explicit exit paths. That is not liberation, but it
is better than a procurement contract with a 5-year renewal and no exit clause.

## Full stack

| Layer | Provider | Owner | Political profile | Exit path | Switch cost |
|---|---|---|---|---|---|
| Code hosting | GitHub | Microsoft (CoreAI subdivision) | GitHub lost operational independence Aug 2025. ICE contract unresolved. Copilot trained on public repos without consent (lawsuit survived dismissal). | Codeberg mirror, flip canonical. | Low |
| DNS / CDN / Workers | Cloudflare | Public (NYSE: NET) | Content moderation controversies. Traffic-level visibility into all requests. | Move Workers to any edge platform. | Moderate |
| Chat hosting + DB | DigitalOcean | Public (NYSE: DOCN) | US cloud provider. Holds the OWUI PostgreSQL database: user accounts, conversation histories, access grants. | Migrate Docker + Postgres to any host. | Moderate |
| Identity | CILogon (InCommon Federation) | Internet2 / UCSC IdP | Authentication via institutional SAML/OIDC through CILogon. Users authenticate against UCSC's own IdP, not Google directly. Exposes `affiliation` claim (student/staff/faculty). Could extend to any InCommon institution. | Switch OIDC_ISSUER to any compliant provider. Google config documented as fallback. | Low |
| LLM gateway | OpenRouter | a16z, Menlo Ventures ($40M) | a16z founders donated $25M+ to Trump-aligned political committees in 2024. Every API call generates revenue flowing to a16z portfolio returns. | [Agent Router](https://theagentrouter.ai/) (formerly Envoy AI Gateway; open source and used by NRP), [LiteLLM](https://www.litellm.ai/) (self-hostable), or direct API calls to providers. These replace routing software, not OpenRouter's provider marketplace, contracts, catalog, or billing. | Moderate |
| LLM inference (institutional) | [NRP / SDSC](https://nrp.ai/documentation/userdocs/ai/llm-managed/) | NSF-funded, operated by SDSC (UC San Diego) | Public research infrastructure. Open-weight models served via what NRP documents as Envoy AI Gateway (now Agent Router) on NRP Nautilus with CILogon auth. Configured but disabled because NRP's documented prompt-logging policy does not meet BayLeaf's ZDR floor. | Technically integrated, but not a current exit until the retention policy changes or a non-logging endpoint is established. | Low |
| LLM inference (institutional commercial path) | Google Vertex AI | Alphabet (NASDAQ: GOOGL) | UC/UCSC has negotiated Google Cloud data-protection agreements, but coverage of BayLeaf's operator-controlled project is not confirmed. Disabled because Google did not grant or confirm the Abuse Monitoring opt-out required for ZDR parity. | Bedrock for overlapping models, OpenRouter ZDR endpoints, or an ITS-managed GCP project with confirmed coverage and retention settings. | Moderate |
| LLM inference (institutional commercial path) | Amazon Bedrock (mantle) | Amazon (NASDAQ: AMZN) | UC has institutional AWS/BAA arrangements, but BayLeaf's POC credential is from the operator's personal account and is uncovered. The account was tested in retention mode `none`; the lane remains disabled pending an institutional credential and an enforceable open-weight listing policy. | Vertex for overlapping models, OpenRouter ZDR endpoints, or a UCSC enterprise AWS account satisfying the enablement checklist. | Moderate |
| LLM inference (confidential) | [Tinfoil](https://tinfoil.sh/) | Private, venture-funded startup (Y Combinator S25) | Open-weight models inside hardware-isolated enclaves. A correctly verifying client encrypts content to the attested workload, architecturally excluding BayLeaf, Tinfoil, and infrastructure operators from plaintext access. Tinfoil still receives identity-linked key metadata, timing, model, token counts, and billing data. Security depends on TEE hardware and firmware, attestation roots, reproducible builds, an approved-measurement policy, and correct client verification. | [NEAR AI Cloud](https://near.ai/) offers a close architectural alternative using TDX + NVIDIA confidential computing, open verification tooling, and direct per-model endpoints. Its contractual ZDR language and independent evidence remain less settled; run the same conformance suite before switching. | Moderate |
| Web search and page extraction tool | Tavily | Nebius Group (ex-Yandex, $275M acquisition 2026) | Yandex successor entity. Microsoft $17B infrastructure deal. Now serving both web search (`/search`) and page-content extraction (`/extract`) endpoints. | Swap to SearXNG + Trafilatura, Brave Search + Reader, Exa, or similar. | Low |
| Code sandboxes | Daytona | VC-funded ($31M, FirstMark et al.) | Standard dev infra startup. | Any container orchestration platform. | Moderate |
| LMS integration | Canvas (Instructure) | KKR ($4.8B acquisition 2024) | PE-owned edtech. PE optimizes for extraction on 5–7 year cycles. Deeply embedded in claim flow and course configuration. This is the institution's dependency, not BayLeaf's: UCSC chose Canvas; BayLeaf inherited it. | Hard to replace. | High |
| Application layer | Open WebUI | Open WebUI, Inc. (private company) | No formal governance, no foundation, no community steering committee. Active community debate about governance model. | Can fork. Maintaining fork solo is a different commitment than tracking upstream. | Moderate |

## Structural observations

**The inference stack now has two layers of indirection.** ✨ The dependency table above
separates *gateway* (OpenRouter, Agent Router) from *provider* (DeepInfra,
SDSC/NRP, etc.). These are different kinds of dependency with different political
profiles and different exit paths. OpenRouter is a commercial gateway that multiplexes
across commercial providers. NRP runs what its documentation calls Envoy AI Gateway
(the project is now [Agent Router](https://theagentrouter.ai/)) in front of
[vLLM](https://vllm.ai/) on NSF-funded GPUs: open-source software on public
infrastructure, serving open-weight models. That path demonstrates technical portability,
but NRP is disabled because its prompt-logging policy does not meet BayLeaf's ZDR floor.
It is an implemented exit path, not a currently usable one.

**Agent Router can replace OpenRouter's routing layer, not OpenRouter as a service.**
[Agent Router](https://theagentrouter.ai/blog/envoy-ai-gateway-is-now-agent-router/),
formerly Envoy AI Gateway, is Apache-2.0 software under the Linux Foundation's Agentic
AI Foundation. It normalizes provider APIs and supplies routing, credentials, failover,
token quotas, observability, and MCP policy. OpenRouter additionally sells access to a
provider marketplace and supplies provider selection, catalog metadata, ZDR routing,
per-user key provisioning, spend accounting, and consolidated billing. Replacing it
with Agent Router would require BayLeaf to obtain direct provider accounts and contracts,
verify retention and model eligibility, operate Kubernetes and Redis for the production
feature set, and preserve its own identity and policy layer. Gateway portability does
not erase the retention policy of the service operating the gateway or of its downstream
providers.

**SDSC/NRP is a provider-layer alternative, not a gateway-layer one.** The right
analogy: NRP is to DeepInfra as Agent Router is to OpenRouter's routing layer. NRP
replaces a specific commercial inference provider with institutional GPU capacity.
Agent Router replaces gateway software, but not OpenRouter's provider relationships and
commercial aggregation. Both substitutions are architecturally available; the current
NRP service is not policy-compatible while prompt logging remains enabled.

**The ZDR boundary is narrower than it sounds.** "No message content is stored by
any third-party provider" is true for the LLM inference path. The OWUI database on
DigitalOcean stores user accounts, conversation histories, and access grants.
Active inference is ZDR. The application layer is not. The framing should not imply
otherwise. NRP would keep prompts on NSF-funded infrastructure operated by a UC
campus, but public ownership does not substitute for retention discipline: its
documented prompt logging is why the configured lane is disabled.

**Confidential inference changes which trust is necessary; it does not eliminate
dependency.** Tinfoil is lower-risk for prompt confidentiality than the ordinary
OpenRouter lane because Sealed clients verify the enclave before encrypting content,
and BayLeaf's relay never possesses the decryption key. That is a technical barrier,
not only a contractual promise. The remaining dependency is unusually concentrated:
BayLeaf relies on a small startup plus AMD, Intel, or NVIDIA hardware and firmware,
cloud infrastructure, attestation services, the published build chain, and clients
that actually enforce verification. Tinfoil also remains an ordinary processor of
identity and usage metadata. [Issue #55](https://github.com/bayleaf-ucsc/bayleaf/issues/55)
tracks the evidence and the deliberately fail-closed route design.

**NEAR AI Cloud is the closest current exit path, but not yet an interchangeable
one.** Its direct TEE endpoints, response signatures, client-side verification, and
field-level encryption are close enough to exercise with the same conformance rubric.
That architecture may expose model and output-budget fields to a relay while keeping
content encrypted, which would improve cost control. However, NEAR mixes confidential
endpoints with conventional third-party model routes, its public contractual ZDR
language is less specific than Tinfoil's, and the available independent evidence has
gaps. A switch therefore requires explicit endpoint allowlisting, fresh evidence
review, and the same downgrade and tamper tests rather than a base-URL change.

**Google is no longer the identity layer.** ✨ As of March 2026, authentication flows
through CILogon (InCommon Federation) rather than Google Workspace directly. Users
authenticate against UCSC's institutional IdP. Google Workspace is still upstream of
that IdP in practice, but the dependency is now mediated by InCommon, a federation
BayLeaf can address without Google's involvement. The OIDC integration is
provider-agnostic; switching issuers is a configuration change, not a code change.
Notably, NRP uses the same CILogon/InCommon federation for its own auth: the identity
infrastructure is shared, not duplicated.

**The "any faculty member could build this" claim has a credential problem.** The
architecture is open and replicable. The operation depends on one person's Canvas
token, Cloudflare account, and CILogon client registration. No second person at a second institution
has independently deployed it. Until that happens, the claim is architectural, not
empirical.

**Environmental cost is unaccounted.** The multi-model architecture diffuses GPU
usage across providers behind an abstraction layer. This makes environmental impact
harder to measure, not easier. For a project whose user research identified
environmental cost as a top student concern, this is a notable gap. NRP's inference
runs on shared research infrastructure that would be powered regardless (the marginal
environmental cost of BayLeaf's queries against NRP is near zero), but this framing
deserves scrutiny rather than comfort.
