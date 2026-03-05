# BayLeaf Web Presence — Information Architecture Plan

## Context

BayLeaf is a university-managed generative AI platform for UC Santa Cruz, operated by
a faculty member in Computational Media. It currently comprises two services (Chat and
API), with more expected. The entire web presence is a single static HTML page at
`bayleaf.dev`, served from `docs/` via GitHub Pages.

The platform works. It's open-source, multi-model, privacy-respecting, and extensible.
But the web presence frames it as "an experimental Generative AI Playground" — language
that was useful for getting started and is now actively harmful for institutional
adoption. Administrators don't sunset infrastructure; they sunset experiments.

### The strategic problem

The risk is that a procurement office signs a vendor site license (Gemini, Copilot,
etc.), calls it done, and the platform becomes irrelevant — not because it's worse, but
because a vendor contract is legible to administrators in a way that a
faculty-operated system is not.

The web presence needs to serve three concentric audiences:

1. **End users** (students, faculty, staff) — need onboarding and a reason to invest
2. **Champions** (colleagues, department chairs, IT leadership) — need to see
   architecture, not a hobby project
3. **Decision-makers** (deans, VCs, CIO) — need to see infrastructure worth
   preserving, not an experiment worth sunsetting

### What the current site gets wrong

The current page is structured like a tool's README:

```
About (what it is, who runs it)
Privacy (two bullets)
Chat Service (feature description)
API Service (feature description)
Contact
Screenshots
```

It answers "what does this do?" It does not answer:

- Why does the university need this instead of a vendor product?
- What can I do here that I can't do with a site license?
- What are the principles behind how it's built?
- Who is already using it and for what?
- How does this serve my role specifically?
- What would be lost if this went away?

It buries the most important facts (open-source, ZDR by architecture, no vendor
lock-in, first-party tool-building) inside feature descriptions. It calls itself
"experimental." It hides the most radical capability — anyone on campus can build and
share specialized AI tools with an invite code — in a subordinate clause.

---

## Deployment Architecture

Split the web presence across two domains:

### `bayleaf.dev` — the front door

Stays in this repo (`docs/`), stays on GitHub Pages. Single page. Its job is
**routing and framing** — a lobby, not a brochure.

Content:
- **Name + positioning.** Drop "experimental" from the descriptor. Keep "Playground"
  as the brand name (it's warm, it's established), but the subtitle should sound
  institutional: something like "University-managed AI for UC Santa Cruz."
- **2-3 sentences** on what BayLeaf is, who operates it, why it exists.
- **Service links:** Chat, API, Docs (and room for more as the platform grows).
- **Privacy/ZDR credential** — one or two lines, presented as a core property of the
  system, not a feature section.
- **Contact.**

That's it. No feature descriptions, no screenshots, no per-service technical detail.
Those move to docs. The apex page should load in under a second and make sense in
under ten.

### `docs.bayleaf.dev` — the substance

Separate deployment (second GitHub Pages repo, Cloudflare Pages, or similar). This is
where the information architecture proposal lives. Static site generator TBD — could be
as simple as a handful of HTML files, could use something lightweight if the page count
justifies it.

---

## Information Architecture for `docs.bayleaf.dev`

The docs site is organized around three jobs: **orient** new visitors, **mobilize** by
role, and **arm** champions with the institutional argument.

```
docs.bayleaf.dev/
  /                      Overview — what BayLeaf is, how to get started
  /principles            The institutional argument
  /chat                  Chat service: features, screenshots, tips
  /api                   API service: Campus Pass, keys, OpenCode, curl examples
  /tools                 Building & sharing first-party tools
  /for/students          Role page: survey context + platform pitch + get started
  /for/faculty           Role page: survey context + platform pitch + get started
  /for/staff             Role page: survey context + platform pitch + get started
  /community             Adoption evidence, who's building what
```

### Page descriptions

#### `/` — Overview

Brief welcome. What BayLeaf is (platform, not product), who operates it, the service
portfolio (Chat, API, more to come). Links into the rest of the docs. This is the page
the apex site's "Docs" button points to.

#### `/principles` — The institutional argument

The most important page for audiences 2 and 3. Makes the case without naming a
competitor. Six principles:

- **University-managed, not vendor-managed.** Governance decisions — what models are
  available, what data flows where, what policies apply — are made on campus.
- **Infrastructure, not product.** An OpenAI-compatible API that any campus tool,
  course, or workflow can build on. When you adopt a product, you get what the vendor
  ships. When you adopt infrastructure, you build what you need.
- **Multi-model, no lock-in.** The model portfolio rotates based on what's best
  available. The university is never contractually dependent on a single provider's
  quality, pricing, ethics, or continued existence.
- **Zero data retention by architecture.** Privacy isn't a policy toggle in an admin
  console. No third-party provider stores any message content, ever.
- **Open source.** The entire platform is public on GitHub. It can be audited, forked,
  replicated, or handed off.
- **First-party tool-building.** Any member of the campus community can build, deploy,
  and share AI-powered tools using the API and the invite-code system without a vendor,
  a ticket, or a procurement cycle.

This page is the one a CIO reads. It's the one a faculty senate committee links to.

The multi-model principle has a quietly powerful subtext: when major providers take
positions that conflict with university values (military contracts, policy reversals,
data-handling changes), a multi-provider architecture lets the institution respond
without breaking anything. A single-vendor site license does not.

#### `/chat` — Chat service

Absorbs the current page's Chat section: Basic model, invite codes, Help model, web
search/browsing toolkits, rate limits, length tip. Screenshots go here.

#### `/api` — API service

Absorbs the current page's API section: Campus Pass (keyless on-network access), key
provisioning via UCSC Google sign-in, daily spending limits, model list via
OpenRouter. Add: OpenCode integration instructions, curl examples, link to GitHub
source.

#### `/tools` — Building custom tools

This is the page that turns passive users into builders and builders into advocates.
Currently the invite-code system and its implications are buried in a single clause.
This page makes it the climax:

- What the invite-code system is
- How to create a course-specific or department-specific model configuration
- What "first-party agentic tools" looks like in practice
- Examples (real or illustrative) of tools campus members have built or could build

#### `/for/students`, `/for/faculty`, `/for/staff` — Role pages

Each page has two sections:

1. **Where your role stands** — survey-informed summary of that role's relationship
   with generative AI. Concise, factual, respectful. Uses second person. Acknowledges
   concerns without dismissing them. Key findings from the campus survey:

   - *Staff:* Least familiar but most positive about increasing use (though nearly
     balanced). Far more optimistic about creativity/admin tasks. Least worried about
     skill loss. Most concerned about ethics and responsible use.
   - *Students:* Most familiar overall. Graduate students use it weekly, learn via
     experimentation, have taken structured courses. Undergraduate students use it
     rarely, two-thirds negative about increasing use, almost half see no learning
     benefit, most concerned about job displacement and environmental impact.
   - *Faculty:* Least optimistic about AI for complex topics (reasonably so). Least
     likely to see learning or work-life balance benefits. Most concerned about academic
     integrity and IP/copyright. Learn via professional literature.

2. **Why this platform, for your concerns** — makes the case that the role's own stated
   concerns and values imply a preference for BayLeaf's architecture over a vendor
   default. The rhetorical move: validate existing concerns, then show those concerns
   have architectural consequences. Nobody is told they're wrong; they're told they're
   already right, and being right means wanting infrastructure over product.

   Role-specific hooks:

   | Role | Lead | Supporting |
   |------|------|------------|
   | Staff | Your creative/admin ambitions need model diversity | Your ethical instincts deserve matching privacy architecture |
   | Students (grad) | Your experimentation deserves a lab bench, not a product demo | You can build and share tools without asking permission |
   | Students (ugrad) | Your skepticism is valid — demand transparency | Open-weight models and ZDR let you inspect rather than trust |
   | Faculty | Your complexity-skepticism proves monoculture is wrong | Your integrity/IP concerns need privacy by design, not by contract |

   Each page ends with a concrete get-started action (sign in to Chat, get an API key,
   try a prompt).

#### `/community` — Adoption evidence

Starts minimal. Even just the survey findings framed as "here's what the campus told
us" plus any known adoption (courses, departments, tools built on the API). Grows over
time.

This page exists to make the user base visible to administrators. A vendor pitch says
"10,000 universities use our product." This page says "here are the specific people at
this university who built specific things on this platform and would lose them if you
replaced it with a site license."

Even before it has rich content, the existence of the nav item signals a living
community, not a solo project.

### What not to build yet

**Blog.** Don't commit to a publishing cadence until there's something to sustain it.
The `/community` page can absorb news-like content (survey results, milestones, tool
announcements) without the overhead. If a blog becomes necessary later,
`docs.bayleaf.dev/blog/` or `blog.bayleaf.dev` are both fine.

---

## Phasing

### Phase 1: Reframe the apex page (this repo)

Slim `docs/index.html` from a README-shaped page to a landing page. Remove detailed
service descriptions and screenshots. Rewrite the tagline and description. Add a Docs
link (can initially point to an anchor or a placeholder). This is a small change with
high leverage — it shifts the first impression from "experiment" to "institution."

### Phase 2: Stand up `docs.bayleaf.dev`

Create the docs site with at minimum: overview, principles, chat, api. These pages
absorb and improve the content currently on the apex page. Deployment method TBD.

### Phase 3: Role pages and tools

Add `/for/students`, `/for/faculty`, `/for/staff`, and `/tools`. These require the
survey summary content and the per-role pitches to be finalized. The tools page
requires at least a few concrete examples.

### Phase 4: Community

Add `/community` with whatever adoption evidence exists. This page is designed to grow
organically.

---

## Key language decisions

- **"Playground" survives as brand, not descriptor.** "BayLeaf AI Playground" is fine
  as a name. "An experimental Generative AI Playground" is not fine as a subtitle.
- **"Infrastructure" over "tool" or "service."** Administrators don't sunset
  infrastructure.
- **"University-managed" over "faculty-operated."** Frames the system as institutional
  even if it currently has one operator.
- **"Experimental" is retired.** It gave cover to build. Now it gives others cover to
  not take this seriously.
- **Never say "open AI."** The casing is a namespace collision. Use "open-source,"
  "university-managed," "multi-model," or "open infrastructure."
