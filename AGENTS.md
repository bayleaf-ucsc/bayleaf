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
  on-campus access and key-based off-campus access. Source: `api/` in this repo.

All LLM inference uses **zero-data-retention (ZDR)** providers via OpenRouter.

---

## Repository Structure

```
bayleaf/
├── api/                # BayLeaf API — Cloudflare Worker (has its own AGENTS.md)
│   ├── src/
│   ├── migrations/
│   ├── wrangler.jsonc
│   └── package.json
├── docs/               # GitHub Pages site → https://bayleaf.dev
│   ├── CNAME
│   ├── index.html      # Single-file about/landing page
│   └── images/
├── README.md
└── AGENTS.md           # This file
```

`docs/` is published via GitHub Pages at `https://bayleaf.dev`.

`api/` is a Cloudflare Worker deployed at `https://api.bayleaf.dev`. See
`api/AGENTS.md` for API-specific guidelines, code style, and commands.

---

## Build / Lint / Test

The about site (`docs/`) has no build step or test suite — it is a single static HTML
file. For the API (`api/`), see `api/AGENTS.md` for build and deploy commands.

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
