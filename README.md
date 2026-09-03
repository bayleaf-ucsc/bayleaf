# BayLeaf

BayLeaf is a situated counterplatform for Generative AI at UC Santa Cruz: an
experimental service operated by [Adam Smith](https://adamsmith.as) (Dept. of
Computational Media). It offers a working platform on different terms: local,
bounded, revisable, and answerable to the contexts in which it is used.

BayLeaf has undergone a security review by UC Santa Cruz ITS: the campus Chief
Information Security Officer (CISO) and his team deemed it **ready to launch**,
safe for use by the UCSC campus community. This attests to its security posture
and is **not** an adoption of BayLeaf as an ITS-operated or ITS-supported
service; it remains faculty-operated. See [`SECURITY.md`](SECURITY.md) and
[`politics/SECURITY.md`](politics/SECURITY.md).

## Services

### BayLeaf Chat — [chat.bayleaf.dev](https://chat.bayleaf.dev)

An [Open WebUI](https://openwebui.com/) deployment offering curated AI models to
UCSC students, faculty, and staff. Features include:

- A **Basic** model backed by a rotating LLM and customized with a campus-aware
  system prompt
- Curated proprietary and open-weight models, all routed through OpenRouter ZDR
- **Invite-code-gated groups** for course-, department-, or role-specific models
  and toolkits
- **Web Search** and **Web Page Content** tools available to all users
- Per-turn rate limiting for fair, cost-efficient access

### BayLeaf API — [api.bayleaf.dev](https://api.bayleaf.dev)

An API that gives the campus community programmatic access to LLMs, web search
and page fetching, and sandboxed code execution:

- **Keyless inference and web-tool access** from the campus network (169.233.x.x)
- **API key access** for off-campus use (self-issued via the service)
- **Web search & fetch** — search the web and extract clean page content from
  one or many URLs at a time, both backed by Tavily, available to all
  authenticated users
- **Code sandbox** — persistent Linux environments (backed by
  [Daytona](https://www.daytona.io/)) for running code, uploading/downloading
  files, all authenticated with the same personal API key, including on campus
- Leaves system and developer instructions under the API caller's control
- **Plaintext inference via OpenRouter**, limited to models with a nonempty
  `hugging_face_id` and a resolving Hugging Face repository. Missing, negative,
  or unavailable evidence fails closed with HTTP 403
- **Sealed confidential inference via Tinfoil**, whose current catalog lists
  only open-weight models. The requested model and body are encrypted from
  BayLeaf, though non-streaming usage metadata can report the executed model

### Status — [uptime dashboard](https://stats.uptimerobot.com/tJ1Qkm7L0R)

Public uptime dashboard for all BayLeaf services.

## Support

Questions, problems, or feature requests?
**[Open an issue](https://github.com/bayleaf-ucsc/bayleaf/issues)** on this repo.

This is a small, faculty-operated project. Response times are best-effort, but
every issue is read.

## Privacy

All active LLM inference uses **zero-data-retention (ZDR)** providers. Chat and
the API's plaintext lane use [OpenRouter](https://openrouter.ai/); API Sealed
uses Tinfoil, with the requested model and body encrypted from BayLeaf. No LLM
provider stores prompts or completions. Vertex AI, AWS Bedrock, and NRP are
disabled and carry no traffic. Non-AI features that require persistent storage,
such as the Daytona-backed Code Sandbox, store user files by necessity.

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
