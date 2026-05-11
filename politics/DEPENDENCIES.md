# Dependency Audit

BayLeaf claims to be an alternative to vendor lock-in. This document audits every
external dependency in the stack: who owns it, what the political profile is, what
breaks if they change terms, and how fast we can switch. The framework is drawn from
Audre Lorde's question — are these the master's tools? — applied as dependency
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
| LLM gateway | OpenRouter | a16z, Menlo Ventures ($40M) | a16z founders donated $25M+ to Trump-aligned political committees in 2024. Every API call generates revenue flowing to a16z portfolio returns. | [Envoy AI Gateway](https://aigateway.envoyproxy.io/) (open source, used by NRP), [LiteLLM](https://www.litellm.ai/) (self-hostable), or direct API calls to providers. | Moderate |
| LLM inference (institutional) | [NRP / SDSC](https://nrp.ai/documentation/userdocs/ai/llm-managed/) | NSF-funded, operated by SDSC (UC San Diego) | Public research infrastructure. Open-weight models only (Qwen, GPT-OSS, Gemma, etc.) served via [Envoy AI Gateway](https://aigateway.envoyproxy.io/) on NRP Nautilus cluster. CILogon auth — same federation BayLeaf already uses. No commercial entanglement. | Already a peer of OpenRouter in the stack; traffic can shift between them. | Low |
| Web search and page extraction tool | Tavily | Nebius Group (ex-Yandex, $275M acquisition 2026) | Yandex successor entity. Microsoft $17B infrastructure deal. Now serving both web search (`/search`) and page-content extraction (`/extract`) endpoints. | Swap to SearXNG + Trafilatura, Brave Search + Reader, Exa, or similar. | Low |
| Code sandboxes | Daytona | VC-funded ($31M, FirstMark et al.) | Standard dev infra startup. | Any container orchestration platform. | Moderate |
| LMS integration | Canvas (Instructure) | KKR ($4.8B acquisition 2024) | PE-owned edtech. PE optimizes for extraction on 5–7 year cycles. Deeply embedded in claim flow and course configuration. This is the institution's dependency, not BayLeaf's — UCSC chose Canvas; BayLeaf inherited it. | Hard to replace. | High |
| Application layer | Open WebUI | Open WebUI, Inc. (private company) | No formal governance, no foundation, no community steering committee. Active community debate about governance model. | Can fork. Maintaining fork solo is a different commitment than tracking upstream. | Moderate |

## Structural observations

**The inference stack now has two layers of indirection.** ✨ The dependency table above
separates *gateway* (OpenRouter, Envoy AI Gateway) from *provider* (DeepInfra,
SDSC/NRP, etc.). These are different kinds of dependency with different political
profiles and different exit paths. OpenRouter is a commercial gateway that multiplexes
across commercial providers. NRP runs its own [Envoy AI Gateway](https://aigateway.envoyproxy.io/)
in front of [vLLM](https://vllm.ai/) on NSF-funded GPUs — open-source software on
public infrastructure, serving open-weight models. The two backends are configured in
parallel; OpenRouter handles traffic by default, but NRP is a live alternative, not a
theoretical one. This is the architectural equivalent of dual-sourcing: the exit path
from OpenRouter is not a migration plan, it is a configuration change.

**Envoy AI Gateway is the open-source counterpart to OpenRouter.** NRP adopted it;
Bloomberg, Nutanix, and Tencent Cloud are listed adopters. It routes to the same
provider APIs (OpenAI-compatible) and supports the same protocol surface. Where
OpenRouter is a commercial SaaS gateway with VC funding, Envoy AI Gateway is an
open-source project under the Envoy/CNCF umbrella. The relationship between them is
the same as between a managed service and a self-hosted alternative — functionally
equivalent, politically different.

**SDSC/NRP is a provider-layer alternative, not a gateway-layer one.** The right
analogy: NRP is to DeepInfra as Envoy AI Gateway is to OpenRouter. NRP replaces a
specific commercial inference provider with institutional GPU capacity. Envoy AI
Gateway replaces a specific commercial routing service with open-source gateway
software. Both substitutions are available; neither requires the other.

**The ZDR boundary is narrower than it sounds.** "No message content is stored by
any third-party provider" is true for the LLM inference path. The OWUI database on
DigitalOcean stores user accounts, conversation histories, and access grants.
Inference is ZDR. The application layer is not. The framing should not imply
otherwise. NRP's inference is arguably stronger here — prompts stay on NSF-funded
infrastructure operated by a UC campus, never transiting a commercial provider at all.

**Google is no longer the identity layer.** ✨ As of March 2026, authentication flows
through CILogon (InCommon Federation) rather than Google Workspace directly. Users
authenticate against UCSC's institutional IdP. Google Workspace is still upstream of
that IdP in practice, but the dependency is now mediated by InCommon — a federation
BayLeaf can address without Google's involvement. The OIDC integration is
provider-agnostic; switching issuers is a configuration change, not a code change.
Notably, NRP uses the same CILogon/InCommon federation for its own auth — the identity
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
runs on shared research infrastructure that would be powered regardless — the marginal
environmental cost of BayLeaf's queries against NRP is near zero — but this framing
deserves scrutiny rather than comfort.
