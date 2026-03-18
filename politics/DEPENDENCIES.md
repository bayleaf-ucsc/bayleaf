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
| Identity | Google Workspace (UCSC) | Google / UCSC admin | Sole authentication path. No fallback. Users do not exist to BayLeaf unless Google says they do. | Add secondary IdP (SAML). Requires institutional cooperation. | Hard |
| LLM routing | OpenRouter | a16z, Menlo Ventures ($40M) | a16z founders donated $25M+ to Trump-aligned political committees in 2024. Every API call generates revenue flowing to a16z portfolio returns. | [LiteLLM](https://www.litellm.ai/) (self-hostable multi-provider router), direct API calls to providers, [NRP](https://nrp.ai) pooled capacity, or [vLLM](https://vllm.ai/) for on-campus inference. | Moderate |
| Web search tool | Tavily | Nebius Group (ex-Yandex, $275M acquisition 2026) | Yandex successor entity. Microsoft $17B infrastructure deal. | Swap to SearXNG (self-hosted), Brave Search API, or similar. | Low |
| Web reader tool | Jina AI | Berlin VC startup ($30M raised) | Low risk profile. | Swap reader API. | Trivial |
| Code sandboxes | Daytona | VC-funded ($31M, FirstMark et al.) | Standard dev infra startup. | Any container orchestration platform. | Moderate |
| LMS integration | Canvas (Instructure) | KKR ($4.8B acquisition 2024) | PE-owned edtech. PE optimizes for extraction on 5–7 year cycles. Deeply embedded in claim flow and course configuration. This is the institution's dependency, not BayLeaf's — UCSC chose Canvas; BayLeaf inherited it. | Hard to replace. | High |
| Application layer | Open WebUI | Open WebUI, Inc. (private company) | No formal governance, no foundation, no community steering committee. Active community debate about governance model. | Can fork. Maintaining fork solo is a different commitment than tracking upstream. | Moderate |

## Structural observations

**The ZDR boundary is narrower than it sounds.** "No message content is stored by
any third-party provider" is true for the LLM inference path. The OWUI database on
DigitalOcean stores user accounts, conversation histories, and access grants.
Inference is ZDR. The application layer is not. The framing should not imply
otherwise.

**Google is ontological, not just operational.** Google is not one dependency among
many. It is the identity layer. BayLeaf inherits the institution's Google dependency
without alternative. There is no way to authenticate to BayLeaf without Google. This
is the hardest dependency to exit and the one most subject to unilateral change by
either Google or the institutional Workspace admin.

**The "any faculty member could build this" claim has a credential problem.** The
architecture is open and replicable. The operation depends on one person's Canvas
token, Cloudflare account, and GCP project. No second person at a second institution
has independently deployed it. Until that happens, the claim is architectural, not
empirical.

**Environmental cost is unaccounted.** The multi-model architecture diffuses GPU
usage across providers behind an abstraction layer. This makes environmental impact
harder to measure, not easier. For a project whose user research identified
environmental cost as a top student concern, this is a notable gap.
