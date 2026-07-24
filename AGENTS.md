# AGENTS.md

Guidelines for agentic coding agents working in this repository.

---

## Project Overview

Public repo for the **BayLeaf AI Playground** — an experimental Generative AI service
for the UC Santa Cruz campus community, operated by Adam Smith (Dept. of Computational
Media). **Publicly visible; never commit secrets, API keys, or credentials.**

- **BayLeaf Chat** — `https://chat.bayleaf.dev` — Open WebUI with curated models,
  invite-code-gated groups, web search/browsing tools, and rate limiting.
- **BayLeaf API** — `https://api.bayleaf.dev` — OpenRouter-proxying API with keyless
  on-campus access and key-based off-campus access, plus web search/fetch and sandboxed
  code execution. Source: `api/` in this repo.

A self-service course-AI service (BayLeaf Courses) was prototyped and then retired
(GitHub issues #4 and #5); the Spring 2026 course need was met instead by the Brace3
OWUI configuration under `chat/`. It may be rebuilt with richer context in the future.

All LLM inference uses **zero-data-retention (ZDR)** providers via OpenRouter.

## Project Frame

BayLeaf describes itself as a **situated counterplatform for Generative AI at
UC Santa Cruz**. A counterplatform is not a rival seeking scale or a claim that
building infrastructure supersedes critique, organizing, policy, or refusal.
It is one situated mode of response: operating a platform makes alternative
technical and institutional terms concrete, usable, scrutinizable, and
revisable.

Treat AI as consequential but normal technology, neither autonomous nor
inevitable. Discuss risk at the level of situated use cases and sociotechnical
relations, not models or safeguards alone. Technical controls are interventions,
not proof that BayLeaf is safe by definition.

## Data posture: ZDR everywhere, ZOA where possible

Two distinct properties, often conflated:

- **ZDR (zero data retention)** is a *retention* property: data is processed
  transiently and not persisted. It is the floor for the whole platform. Every
  inference path routes only to provider endpoints that contract not to retain
  prompts or completions (and never train on them); they keep only request
  metadata. BayLeaf applies ZDR to *itself* as well: the API proxy stores no
  prompt or completion content.
- **ZOA (zero operator access)**, as articulated in the
  [AWS Mantle design](https://aws.amazon.com/blogs/machine-learning/exploring-the-zero-operator-access-design-of-mantle/),
  is a stronger *access* property: there is no technical means for an operator
  to read user content even while it transits, enforced architecturally (no
  interactive shells, signed/attested code, encrypted-in-use). ZOA implies ZDR,
  but ZDR does **not** imply ZOA: a ZDR system can still let an operator tail a
  log or deploy a logging build.

**Stance:** pursue ZOA *where practical*, ZDR everywhere as the baseline.

- **BayLeaf API** is the ZOA target. It already retains no content, disables
  Workers observability, and does no caching, so an operator has **no standing
  access** to prompts or completions: only request metadata (model, token
  counts, timestamps) is observable. This is a strong ZOA *posture*, not a
  hardware-attested ZOA *guarantee* like Mantle, because an operator with deploy
  rights could ship a revision that logs request bodies; there is no
  attestation/signed-deploy barrier preventing it. Claim the posture honestly;
  do not overclaim full ZOA. Any change that begins storing or logging request
  content breaks this posture and must be treated as a material change.
- **BayLeaf Chat** cannot be ZOA: it deliberately stores chat history so users
  can carry conversations across devices. The administrator can read that
  database. Chat is ZDR *at the inference layer only*; be explicit that the ZDR
  boundary does not cover stored conversation history.

---

## Repository Structure

```
bayleaf/
├── api/                # BayLeaf API — Cloudflare Worker (has its own AGENTS.md)
│   ├── src/
│   ├── migrations/
│   ├── wrangler.jsonc
│   └── package.json
├── chat/               # BayLeaf Chat — Open WebUI config & backup (has its own AGENTS.md)
│   ├── DESIGN.md       # Full architecture, env vars, recovery procedure
│   ├── models/         # Workspace model definitions (JSON + avatars)
│   ├── tools/          # Custom toolkit source code
│   └── functions/      # Filter & action source code
├── docs/               # GitHub Pages site → https://bayleaf.dev
│   ├── CNAME
│   ├── index.html      # Landing page
│   ├── use-cases.html  # Role-keyed task recipes
│   ├── support.html    # How to get help
│   ├── privacy.html    # Privacy notice, subprocessor list
│   ├── style.css       # Shared stylesheet (carries a WCAG contrast invariant)
│   └── images/         # og-card.png + the script that generates it
├── politics/           # Dependency audit, VPATs, position papers
├── training/           # Work-in-progress React site for training users in effective GenAI usage
├── README.md
└── AGENTS.md           # This file
```

`docs/` is published via GitHub Pages at `https://bayleaf.dev`.

`api/` is a Cloudflare Worker deployed at `https://api.bayleaf.dev`.
**Read `api/AGENTS.md` before working on API code or infrastructure.**

`chat/` is an Open WebUI instance on DigitalOcean App Platform at
`https://chat.bayleaf.dev`. **Read `chat/AGENTS.md` before working on Chat
configuration, models, tools, functions, or user/group management.**

---

## Build / Lint / Test

The about site (`docs/`) has no build step or test suite: it is four hand-written
static HTML pages sharing one stylesheet. For the API (`api/`), see
`api/AGENTS.md` for build and deploy commands.

Two things in `docs/` are generated rather than hand-written, and both need
regenerating when their inputs change:

- `docs/images/og-card.png`, the Open Graph share card referenced by every
  page's `<meta>` block. Regenerate with `./docs/images/make-og-card.py` after
  changing the tagline or the palette. Its source art is
  `chat/models/basic/profile.png`, the BayLeaf logo.
- The empirical claims in `politics/VPAT-pages.md`. Any change to `docs/*.html`
  or `docs/style.css` can invalidate a measured contrast ratio, a reflow result,
  or a structural claim. **Adding a page to `docs/` requires folding it into
  that ACR**, which has slipped before.

**Local preview:** Use the VS Code **Live Server** extension (right-click
`docs/index.html` → *Open with Live Server*), which serves on `http://localhost:5500`
by default. Alternatively:

```bash
python3 -m http.server 8000 --directory docs
```

---

## Security & Privacy

- **No secrets in the repo.** No API keys, tokens, passwords, or `.env` files.
- Any code calling LLM APIs must use ZDR providers via OpenRouter; note this in comments.
- Invite codes, filter names, and internal operational details must not appear in
  committed files.

---

## Agent Conduct

This repo backs a live service used by the entire UC Santa Cruz campus community.
**Do not perform destructive or publishing actions unless explicitly asked.** This
includes — but is not limited to — committing, pushing, force-pushing, deleting
branches, or modifying GitHub settings. Always show the user a diff or summary and
wait for approval before touching git history or remote state.

---

## Git Workflow

**Deploy first, commit later.** All services in this repo can be deployed to
production without committing. Use this to let the developer feel out changes in
prod before recording them in git. For `docs/` (GitHub Pages), deployment is
coupled to pushes — so use a local dev server (`python3 -m http.server 8000
--directory docs`) to preview changes before committing.

**Do not commit or push unless explicitly asked.** Deploying to a live service
is non-destructive and reversible; pushing to `main` is immediate and public.
These are different levels of commitment.

**Clean commit story over chronological accuracy.** When a session produces
multiple small, related changes (e.g. a feature + copy tweaks + style fixes),
prefer squashing them into a single coherent commit rather than recording each
micro-step. The git log should read like an intentional changelog, not a
transcript of the development session.

---

## Commit Style

```
add:    new content or feature
update: change to existing content or feature
fix:    bug fix
docs:   documentation only
chore:  tooling, deps, CI
```

Concise, imperative mood: `add screenshot gallery to about page` ✓

---

*BayLeaf is a convivial, sufficiency-capped degrowth artifact funded by a gift
economy and animated, in places, by an innovation-accelerationist pulse it
hasn't fully reconciled.*
