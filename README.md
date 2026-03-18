# BayLeaf AI Playground

An experimental Generative AI service for the UC Santa Cruz campus community,
operated by [Adam Smith](https://adamsmith.as) (Dept. of Computational Media).

## Services

### BayLeaf Chat — [chat.bayleaf.dev](https://chat.bayleaf.dev)

An [Open WebUI](https://openwebui.com/) deployment offering curated AI models to
UCSC students, faculty, and staff. Features include:

- A **Basic** model backed by a rotating open-weight LLM, customized with a
  campus-aware system prompt
- **Invite-code-gated groups** for course-, department-, or role-specific models
  and toolkits
- **Web Search** and **Web Page Content** tools available to all users
- Per-turn rate limiting for fair, cost-efficient access

### BayLeaf API — [api.bayleaf.dev](https://api.bayleaf.dev)

An OpenRouter-proxying API that gives the campus community programmatic access to
LLMs and sandboxed code execution:

- **Keyless access** from the campus network (169.233.x.x)
- **API key access** for off-campus use (self-issued via the service)
- **Code sandbox** — persistent Linux environments (backed by
  [Daytona](https://www.daytona.io/)) for running code, uploading/downloading
  files, all authenticated with the same API key; campus-pass users get
  ephemeral one-shot sandboxes
- Injects a light system prompt prefix to orient downstream agents

## Support

Questions, problems, or feature requests?
**[Open an issue](https://github.com/rndmcnlly/bayleaf/issues)** on this repo.

This is a small, faculty-operated project. Response times are best-effort, but
every issue is read.

## Privacy

All LLM inference routes through **zero-data-retention (ZDR)** providers via
[OpenRouter](https://openrouter.ai/). No message content is logged or stored by
any third-party provider.

## This Repository

- `api/` — BayLeaf API Cloudflare Worker ([api.bayleaf.dev](https://api.bayleaf.dev))
- `docs/` — Static GitHub Pages site published at [bayleaf.dev](https://bayleaf.dev)
- `chat/` — BayLeaf Chat DigitalOcean App ([chat.bayleaf.dev](https://chat.bayleaf.dev)): workspace models, custom tools, filters, and [design doc](chat/DESIGN.md)
- `politics/` — The case for universities owning their own AI infrastructure (manifesto)

This repo is **publicly visible**. It never contains API keys, credentials, or
other sensitive configuration.

## GenAI Disclosure

Nearly 100% of the code, documentation, and other project data in this
repository was created using generative AI in agentic coding tools. This is an
intentional choice: it demonstrates that sufficient technical capacity exists
within the university to build and operate a service like this, without ceding
control or responsibility to external parties. Critics, allies, and other humans
seeking a direct human connection should contact
[Adam Smith](mailto:amsmith@ucsc.edu) directly.

## Contact

[Adam Smith](mailto:amsmith@ucsc.edu) · [UCSC Directory](https://campusdirectory.ucsc.edu/cd_detail?uid=amsmith)
