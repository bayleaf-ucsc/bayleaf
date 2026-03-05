# BayLeaf AI Playground

An experimental Generative AI service for the UC Santa Cruz campus community,
operated by [Adam Smith](https://adamsmith.as) (Dept. of Computational Media).

## Services

### BayLeaf Chat — [bayleaf.chat](https://bayleaf.chat)

An [Open WebUI](https://openwebui.com/) deployment offering curated AI models to
UCSC students, faculty, and staff. Features include:

- A **Basic** model backed by a rotating open-weight LLM, customized with a
  campus-aware system prompt
- **Invite-code-gated groups** for course-, department-, or role-specific models
  and toolkits
- **Web Search** and **Web Page Content** tools available to all users
- Per-turn rate limiting for fair, cost-efficient access

### BayLeaf API — [api.bayleaf.chat](https://api.bayleaf.chat)

An OpenRouter-proxying API that gives the campus community programmatic access to
LLMs:

- **Keyless access** from the campus network (169.233.x.x)
- **API key access** for off-campus use (self-issued via the service)
- Injects a light system prompt prefix to orient downstream agents

Source: [`api/`](api/) in this repo

## Privacy

All LLM inference routes through **zero-data-retention (ZDR)** providers via
[OpenRouter](https://openrouter.ai/). No message content is logged or stored by
any third-party provider.

## This Repository

- `api/` — BayLeaf API Cloudflare Worker ([api.bayleaf.chat](https://api.bayleaf.chat))
- `docs/` — Static GitHub Pages site published at [about.bayleaf.chat](https://about.bayleaf.chat)
- `chat/` — OWUI deployment backup: workspace models, custom tools, filters, and [design doc](chat/DESIGN.md)

This repo is **publicly visible**. It never contains API keys, credentials, or
other sensitive configuration.

## Contact

[Adam Smith](mailto:amsmith@ucsc.edu) · [UCSC Directory](https://campusdirectory.ucsc.edu/cd_detail?uid=amsmith)
