# VPAT and BayLeaf

<!-- SEC:HEADER -->
**Service:** BayLeaf AI Playground
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz
**Status:** Working draft. Not a signed ACR. Evaluation mostly pending — see [§ 5](#5-surface-inventory) and [§ 7](#7-draft-conformance-table) for the honest state of each surface.
**Template:** [VPAT® 2.5 INT](https://www.itic.org/policy/accessibility/vpat), covering [WCAG 2.1](https://www.w3.org/TR/WCAG21/) Level A and AA, [Revised Section 508](https://www.access-board.gov/ict/), and [EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/).

<!-- SEC:INTRO -->

This document is BayLeaf's working-draft Accessibility Conformance Report
(ACR). It uses the [VPAT 2.5 INT template](https://www.itic.org/policy/accessibility/vpat)
published by the [Information Technology Industry Council (ITI)](https://www.itic.org/),
which covers [WCAG 2.1](https://www.w3.org/TR/WCAG21/) Level A and AA,
the [Revised Section 508 standards](https://www.access-board.gov/ict/),
and [EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/)
in a single report.

It is a sibling to [HECVAT.md](HECVAT.md) (security), [FERPA.md](FERPA.md)
(student privacy), and [SECURITY.md](SECURITY.md) (platform data handling).
Like those documents, it is written in the form the institution expects
while being honest about the places the template does not fit a
faculty-operated service. Like FERPA.md, it is structured so that future
evaluation passes are lookups against the references collected here,
not rediscovery from scratch.

This draft is not a signed ACR. It is the framing, scope, inheritance
map, and evaluation scaffold that a real ACR would fill in. See
[§ 7](#7-draft-conformance-table) for what is and isn't evaluated.

---

## 1. What a VPAT is, and why this one looks different

<!-- SEC:WHAT_IS_VPAT -->

A **VPAT (Voluntary Product Accessibility Template)** is a standardized
reporting form maintained by ITI. A filled-in VPAT is called an
**Accessibility Conformance Report (ACR)**. The terms are often used
interchangeably. The current version is
[VPAT 2.5](https://www.itic.org/policy/accessibility/vpat), published in
four editions:

- **[WCAG 2.x Edition](https://www.itic.org/dotAsset/1c95f5c1-4c8a-4fa1-90a1-67a7f0d45de4.doc)** — web content only.
- **[Revised Section 508 Edition](https://www.itic.org/dotAsset/ba601692-c81d-4f83-84a4-c9d83c3bd3fa.doc)** — US federal procurement.
- **[EU EN 301 549 Edition](https://www.itic.org/dotAsset/9f02f58e-a0e3-42f5-8cea-80b0e0b6f83a.doc)** — European procurement.
- **[INT (International) Edition](https://www.itic.org/dotAsset/dc611114-0d38-474b-bd72-f606832c2407.doc)** — all three combined; the common choice for US higher-ed vendors.

For each success criterion, the reporter selects one conformance level:

- **Supports** — the functionality has been evaluated and meets the criterion without known defects.
- **Partially Supports** — some functionality does not meet the criterion.
- **Does Not Support** — the majority of functionality does not meet the criterion.
- **Not Applicable** — the criterion is not relevant to the product.
- **Not Evaluated** — permitted only for WCAG 2.x Level AAA criteria in the standard template; extended here by honest disclosure to other criteria the evaluation has not yet reached.

The canonical reference for the vocabulary is the
[VPAT 2.5 instructions](https://www.itic.org/policy/accessibility/vpat)
and the accompanying
[ITI guidance on accurately completing a VPAT](https://www.itic.org/policy/accessibility/accessibility-resources).

This draft uses **Not Evaluated** for most criteria on most surfaces.
That is the honest state: BayLeaf has not yet run a full evaluation
pass. The entries are structured so that future passes can upgrade
them row-by-row without rewriting the frame.

---

## 2. Framing memo for the reviewer

<!-- SEC:FRAMING_MEMO -->

VPAT is written for a third-party commercial vendor shipping a product
with a single UI under their own control. BayLeaf does not fit that
shape. It is a **faculty-operated service** that composes surfaces from
multiple sources:

- **BayLeaf Chat** (`chat.bayleaf.dev`) uses [Open WebUI](https://openwebui.com/)
  upstream; the UI is Open WebUI's, the configuration and deployment are
  BayLeaf's.
- **BayLeaf API** (`api.bayleaf.dev`) serves a small set of
  BayLeaf-authored [Hono](https://hono.dev/) / JSX templates (a landing
  page and a dashboard) plus a JSON API that is not itself a UI.
- **bayleaf.dev** serves a single static HTML landing page from the
  repository's [`docs/`](https://github.com/bayleaf-ucsc/bayleaf/tree/main/docs)
  directory via [GitHub Pages](https://pages.github.com/).

Several VPAT questions (evaluation methodology from the vendor's
internal accessibility team, designated accessibility product manager,
quarterly conformance updates, accessibility-trained QA) presume an
enterprise vendor posture. Those answers are "no" here, and the
*Remarks* fields throughout this document explain the honest substitute
— typically either (a) the accessibility posture of the upstream
project (Open WebUI) whose conformance BayLeaf inherits, or (b) direct
source-level evaluation of the small BayLeaf-authored surfaces.

The external driver is real. The 2024
[ADA Title II final rule](https://www.federalregister.gov/documents/2024/04/24/2024-07758/nondiscrimination-on-the-basis-of-disability-accessibility-of-web-information-and-services-of-state)
obligates state and local government entities — including UC — to make
web content and mobile apps conform to WCAG 2.1 Level AA. The
compliance deadline is
[April 24, 2026](https://www.ada.gov/resources/2024-03-08-web-rule/)
for public entities with populations ≥ 50,000 (UCSC is covered). The
[Department of Justice fact sheet](https://www.ada.gov/notices/2024/04/08/fact-sheet-web-rule/)
summarizes what the rule requires. Any tool UCSC directs students,
faculty, or staff toward falls within UCSC's Title II obligations;
BayLeaf's VPAT exists so that posture is defensible.

**Supporting documents (in-repo):**

- [HECVAT.md](HECVAT.md) — security questionnaire with framing memo.
- [FERPA.md](FERPA.md) — student-privacy analysis and draft designation memo.
- [SECURITY.md](SECURITY.md) — platform data-handling exhibit.
- [../chat/DESIGN.md](../chat/DESIGN.md) — full BayLeaf Chat architecture.
- [DEPENDENCIES.md](DEPENDENCIES.md) — dependency audit (the upstream inheritance map for code; this VPAT is the accessibility analogue).

---

## 3. Why accessibility matters for a faculty-operated service

<!-- SEC:WHY_ACCESSIBILITY -->

Accessibility is an obligation that attaches to UCSC, not to the
operator personally. Three policy layers are in force:

**Federal: ADA Title II.** The 2024
[DOJ final rule on web and mobile accessibility](https://www.federalregister.gov/documents/2024/04/24/2024-07758/nondiscrimination-on-the-basis-of-disability-accessibility-of-web-information-and-services-of-state)
requires WCAG 2.1 Level AA conformance for web content and mobile apps
provided by state and local government entities. UC is covered. The
[DOJ small entity compliance guide](https://www.ada.gov/resources/small-entity-compliance-guide/)
and [technical assistance resources](https://www.ada.gov/resources/2024-03-08-web-rule/)
walk through the requirements. UCSC's compliance deadline is
**April 24, 2026**.

**Federal (procurement): Section 508.**
[Revised Section 508](https://www.access-board.gov/ict/) applies to
federal procurement, not directly to UC, but VPATs including the
Section 508 edition are frequently requested in higher-ed procurement
alongside HECVATs. Section 508 incorporates WCAG 2.0 Level AA by
reference and adds functional performance criteria and some hardware
considerations.

**UC system: IMG-2150.** UC Policy
[IMG-2150, Electronic Information Communication and Technology Accessibility](https://policy.ucop.edu/doc/7000611/IMT-2150)
requires UC locations to develop and implement an "Electronic
Accessibility Plan" covering websites, digital content, software, and
procured ICT. UCSC's implementation is coordinated by the
[UCSC IT Accessibility](https://its.ucsc.edu/accessibility/) program
under ITS. The campus's
[accessibility policy landing page](https://accessibility.ucsc.edu/)
consolidates IMG-2150 with ADA Title II obligations.

**UCSC: Disability Resource Center and IT Accessibility.** The
[Disability Resource Center (DRC)](https://drc.ucsc.edu/) handles
student accommodations; [UCSC IT Accessibility](https://its.ucsc.edu/accessibility/)
handles technology conformance. These are the offices whose
relationship to BayLeaf is the accessibility analogue of the Privacy
Office / ISO relationship described in [FERPA.md § 7.1](FERPA.md#71-which-ucsc-offices-are-involved).

The structural observation from [FERPA.md § 4.3](FERPA.md#43-why-faculty-operated-complicates-the-vendor-frame)
applies here too: Adam operates BayLeaf in his institutional capacity
as UCSC faculty. The accessibility obligation runs to UCSC, and UCSC's
Title II posture covers anything the campus directs users toward. A
faculty-operated service inherits that obligation by being made
available to the campus community. This VPAT is the operator's attempt
to make that inherited obligation legible and reviewable.

---

## 4. Scope

<!-- SEC:SCOPE -->

**In scope:**

- [`chat.bayleaf.dev`](https://chat.bayleaf.dev) — BayLeaf Chat, Open
  WebUI deployment (see [§ 5.1](#51-bayleaf-chat-chatbayleafdev)).
- [`api.bayleaf.dev`](https://api.bayleaf.dev) landing page —
  BayLeaf-authored Hono/JSX template (see [§ 5.2](#52-bayleaf-api-landing-apibayleafdev)).
- [`api.bayleaf.dev/dashboard`](https://api.bayleaf.dev/dashboard) —
  BayLeaf-authored Hono/JSX template with auth and key management (see
  [§ 5.3](#53-bayleaf-api-dashboard-apibayleafdevdashboard)).
- [`bayleaf.dev`](https://bayleaf.dev) — single static landing page at
  [`docs/index.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/index.html),
  served via GitHub Pages (see [§ 5.4](#54-bayleafdev-landing-docsindexhtml)).

**Out of scope:**

- [`bayleaf.dev/support`](https://bayleaf.dev/support) and any future
  supporting pages in [`docs/`](https://github.com/bayleaf-ucsc/bayleaf/tree/main/docs).
  These are BayLeaf-authored HTML but the scope boundary here is
  pragmatic — they are small pages that will be folded into
  [§ 5.4](#54-bayleafdev-landing-docsindexhtml)-style direct evaluation when capacity allows, and
  they do not gate any BayLeaf service access.
- [GitHub Pages](https://pages.github.com/) as a platform. The platform
  itself is GitHub's, not BayLeaf's; GitHub publishes its own
  [Accessibility Conformance Reports](https://accessibility.github.com/)
  covering its products. BayLeaf links to github.com-hosted source,
  issues, and policy documents from within its UIs; those outbound
  destinations are covered by GitHub's own ACRs as a **courtesy
  disclosure**, not a claim that GitHub's ACRs cover BayLeaf-authored
  content.
- The [BayLeaf API's JSON endpoints](https://api.bayleaf.dev/v1). A
  JSON-over-HTTP API surface is not a UI and is not directly subject
  to WCAG. API *documentation*, where it exists as a rendered page, is
  in scope through [§ 5.2](#52-bayleaf-api-landing-apibayleafdev).
- BayLeaf's [GitHub repository](https://github.com/bayleaf-ucsc/bayleaf)
  as a browsing surface. Covered by
  [GitHub's product ACRs](https://accessibility.github.com/).

**Surface-like but treated separately: AI-generated output.**
Model output rendered inside BayLeaf Chat (streamed markdown, code
blocks, tables, generated images) is not a traditional UI surface but
is subject to user-facing accessibility concerns. This is handled in
[§ 6](#6-ai-generated-output-as-an-accessibility-surface) as its own
topic because no off-the-shelf VPAT template currently covers it well.

---

## 5. Surface inventory

<!-- SEC:SURFACE_INVENTORY -->

| Surface | URL | UI origin | Owns accessibility | Evaluation status | Detail |
|---|---|---|---|---|---|
| BayLeaf Chat | [chat.bayleaf.dev](https://chat.bayleaf.dev) | [Open WebUI](https://openwebui.com/) (OSS, upstream) | Shared: upstream owns the UI; BayLeaf owns deployment, theme config, and model output shaping | Not Evaluated; blocked on upstream ACR question | [§ 5.1](#51-bayleaf-chat-chatbayleafdev) |
| API landing | [api.bayleaf.dev](https://api.bayleaf.dev) | BayLeaf [Hono/JSX](https://hono.dev/) templates | BayLeaf | Not Evaluated; candidate for direct source-inspection pass | [§ 5.2](#52-bayleaf-api-landing-apibayleafdev) |
| API dashboard | [api.bayleaf.dev/dashboard](https://api.bayleaf.dev/dashboard) | BayLeaf Hono/JSX templates | BayLeaf | Not Evaluated; interactive elements want a live keyboard/SR pass | [§ 5.3](#53-bayleaf-api-dashboard-apibayleafdevdashboard) |
| bayleaf.dev landing | [bayleaf.dev](https://bayleaf.dev) | Static HTML ([`docs/index.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/index.html)) | BayLeaf | **Partially Evaluated via source inspection**; see [§ 7](#7-draft-conformance-table) | [§ 5.4](#54-bayleafdev-landing-docsindexhtml) |

Each subsection below documents what the surface is, who owns its
conformance, what the operator knows about its current state, and what
links a future evaluation pass will need.

### 5.1 BayLeaf Chat (`chat.bayleaf.dev`)

**UI origin.** [Open WebUI](https://openwebui.com/) is an
open-source chat frontend developed at
[github.com/open-webui/open-webui](https://github.com/open-webui/open-webui).
BayLeaf Chat is an Open WebUI deployment on DigitalOcean App Platform,
configured as documented in [../chat/DESIGN.md](../chat/DESIGN.md).

**What BayLeaf controls.** Everything that is not the upstream UI
itself:

- Model selection and system prompts for curated workspace models
  (see [../chat/models/](https://github.com/bayleaf-ucsc/bayleaf/tree/main/chat/models)).
  System prompts can nudge model output toward more accessible
  formatting (e.g., asking for alt text on generated images, preferring
  lists and headings over dense paragraphs) — see [§ 6](#6-ai-generated-output-as-an-accessibility-surface).
- Tool/function definitions
  ([chat/tools/](https://github.com/bayleaf-ucsc/bayleaf/tree/main/chat/tools)).
- Theme, logo, and copy customizations applied via Open WebUI's
  [admin settings](https://docs.openwebui.com/features/).
- Choice of Open WebUI version (pinned in deployment config).

**What BayLeaf does not control.** The HTML, CSS, ARIA attributes,
focus management, keyboard handlers, and screen-reader semantics of
the Open WebUI UI itself. Changes to any of those require upstream
contribution or a fork.

**The open question: does Open WebUI publish an ACR?**
*As of this writing, the operator has not located a published ACR or
accessibility statement from the Open WebUI project.* Relevant places
to check and cite when the question is re-opened:

- Open WebUI [documentation site](https://docs.openwebui.com/) —
  search for "accessibility", "a11y", "VPAT", "WCAG".
- Open WebUI [repository README](https://github.com/open-webui/open-webui/blob/main/README.md)
  and [SECURITY.md](https://github.com/open-webui/open-webui/blob/main/SECURITY.md).
- Issues labeled accessibility:
  [`is:issue label:accessibility`](https://github.com/open-webui/open-webui/issues?q=is%3Aissue+label%3Aaccessibility)
  or full-text search for
  [`a11y`](https://github.com/open-webui/open-webui/issues?q=a11y)
  and [`accessibility`](https://github.com/open-webui/open-webui/issues?q=accessibility).
- Pull requests touching ARIA:
  [`aria-`](https://github.com/open-webui/open-webui/pulls?q=aria-).
- The project's [Discord](https://discord.gg/5rJgQTnV4s) and
  [discussions](https://github.com/open-webui/open-webui/discussions)
  for community accessibility conversations.

If no upstream ACR exists, BayLeaf's honest posture is that Chat's
conformance is **Not Evaluated, with inherited dependency on an
upstream project that has not published its own conformance report.**
This is a weaker posture than the comparable inheritance argument in
[FERPA.md § 5](FERPA.md#5-the-contract-stack-beneath-bayleaf), where
the subprocessor DPAs are published artifacts. A reasonable next step
is to open an upstream issue asking whether an ACR is planned.

**Operator-known gaps (informal, not an evaluation).** These are
things the operator has noticed in day-to-day use, not an audit:

- *To be filled in.* Candidate items to document when the operator
  does a walk-through: focus visibility on theme-customized buttons,
  color contrast of the custom accent colors in the selected theme,
  keyboard reachability of the model selector, ARIA live-region
  behavior during streamed responses.

**Links for the future evaluation pass.**

- [Open WebUI repo](https://github.com/open-webui/open-webui)
- [Open WebUI docs](https://docs.openwebui.com/)
- Open WebUI uses [Svelte](https://svelte.dev/) and
  [SvelteKit](https://kit.svelte.dev/); frontend source under
  [`src/lib/`](https://github.com/open-webui/open-webui/tree/main/src/lib).
- BayLeaf Chat deployment notes: [../chat/DESIGN.md](../chat/DESIGN.md).

### 5.2 BayLeaf API landing (`api.bayleaf.dev`)

**UI origin.** BayLeaf-authored JSX rendered server-side by
[Hono](https://hono.dev/) on Cloudflare Workers. The relevant files
are small and source-inspectable:

- [`api/src/templates/layout.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/templates/layout.tsx) — shared `BaseLayout`, `cardStyle`, `btnStyle`, `RecommendedModelHint`.
- [`api/src/templates/landing.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/templates/landing.tsx) — the public landing page.
- [`api/src/routes/dashboard.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/routes/dashboard.tsx) — route handler that renders `LandingPage` when unauthenticated.

**What this surface contains.** A heading, a paragraph of copy, a
"sign in" link styled as a button, and a conditional card announcing
whether the visitor is on-campus (eligible for keyless access). No
forms, no interactive widgets beyond the link-styled button.

**Why this surface is tractable for direct evaluation.** The entire
rendered DOM is produced from ~50 lines of JSX with inline styles.
A source-inspection pass covering WCAG 2.1 AA can be completed in a
single sitting and verified with a browser view. A live audit with
[axe DevTools](https://www.deque.com/axe/devtools/) and a keyboard
pass completes the picture.

**Known concerns to check in evaluation.**

- The "sign in" link uses `<a>` styled as a button via `btnStyle`.
  [WCAG 4.1.2 (Name, Role, Value)](https://www.w3.org/WAI/WCAG21/Understanding/name-role-value)
  is satisfied as long as the role remains "link" and the text is
  descriptive; the visual styling alone does not create a conformance
  issue.
- Inline style colors need
  [1.4.3 (Contrast Minimum)](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum)
  verification against their backgrounds. The same accent colors
  (`#2a5298`, `#2d8659`, etc.) appear on the static landing at
  [`docs/index.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/index.html);
  a single contrast check covers both.
- Conditional copy ("You're on the UCSC network") is content that
  changes based on request IP. Make sure the copy itself is a static
  string and not dependent on dynamic styling that would fail
  [1.4.1 (Use of Color)](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color).

**Links for the future evaluation pass.**

- Live page: [api.bayleaf.dev](https://api.bayleaf.dev).
- Source: [api/src/templates/](https://github.com/bayleaf-ucsc/bayleaf/tree/main/api/src/templates).
- Rendering: Hono JSX runtime,
  [hono/jsx docs](https://hono.dev/docs/guides/jsx).

### 5.3 BayLeaf API dashboard (`api.bayleaf.dev/dashboard`)

**UI origin.** BayLeaf-authored Hono/JSX, same stack as [§ 5.2](#52-bayleaf-api-landing-apibayleafdev).
Relevant files:

- [`api/src/templates/dashboard.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/templates/dashboard.tsx) — the rendered dashboard.
- [`api/src/routes/dashboard.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/routes/dashboard.tsx) — the route handler, including the auth gate and key-provisioning flow.
- [`api/src/templates/layout.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/templates/layout.tsx) — shared layout.

**What this surface contains.** Reachable only after OIDC sign-in
(CILogon → UCSC CruzID). Displays the user's API key (or a provisioning
button), sandbox status, tool-integration credentials, and
copy-to-clipboard controls. This is the richest BayLeaf-owned surface
in terms of interactive elements.

**Why direct evaluation is harder than the landing page.** Interactive
widgets (copy-to-clipboard buttons, collapsible sections, key-rotation
forms) want a live keyboard-only pass and a screen-reader pass. Source
inspection alone can verify semantic structure and static labels but
cannot verify focus management, live-region announcements, or the
keyboard-reachability of dynamically-inserted content.

**Criteria that want explicit attention.**

- [2.1.1 Keyboard](https://www.w3.org/WAI/WCAG21/Understanding/keyboard) — every action must be keyboard-reachable.
- [2.4.3 Focus Order](https://www.w3.org/WAI/WCAG21/Understanding/focus-order) — logical tab order through the key management sections.
- [2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible) — custom-styled buttons must retain a visible focus ring.
- [3.3.1 Error Identification](https://www.w3.org/WAI/WCAG21/Understanding/error-identification) and [3.3.3 Error Suggestion](https://www.w3.org/WAI/WCAG21/Understanding/error-suggestion) — error messaging on key provisioning.
- [4.1.3 Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages) — success/failure announcements after key operations should use ARIA live regions.

**Links for the future evaluation pass.**

- Live page (requires sign-in): [api.bayleaf.dev/dashboard](https://api.bayleaf.dev/dashboard).
- Source: [api/src/templates/dashboard.tsx](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/templates/dashboard.tsx), [api/src/routes/dashboard.tsx](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/routes/dashboard.tsx).

### 5.4 bayleaf.dev landing (`docs/index.html`)

**UI origin.** Single static HTML file at
[`docs/index.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/index.html)
(304 lines, ~15KB), served via [GitHub Pages](https://pages.github.com/)
with custom domain per [`docs/CNAME`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/CNAME).
Inline CSS, no JavaScript, no build step.

**Why this is the pilot surface.** The smallest surface, entirely
self-contained in one file, no framework or library involved. Source
inspection can meaningfully cover most WCAG 2.1 AA criteria; the
handful that require a rendered browser (actual color rendering,
zoom/reflow behavior, focus visibility in practice) are cheap live
follow-ups.

**Structure observed in source.** Valid HTML5; `<html lang="en">`;
single `<h1>`; eight `<h2>` section headings; three `<h3>`
subsections under the API Service h2; a flat row of links styled as
buttons (the top navigation); multiple prose sections with `<ul>`
lists; a `<details>/<summary>` collapsible subprocessor list; a final
contact block in a `<div class="contact">`. Inline styles for
typography, colors, and layout; no external stylesheets, no
JavaScript.

**Structural observations that inform [§ 7](#7-draft-conformance-table).**

- [1.3.1 Info and Relationships](https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships):
  headings are in order (h1 → h2; one h3 under h2); lists use `<ul>`
  not presentational `<div>`s; the subprocessor disclosure uses native
  `<details>/<summary>` which is keyboard-accessible and
  screen-reader-friendly.
- [2.4.4 Link Purpose (In Context)](https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context):
  link text is descriptive (e.g., "UCSC's Newly Established AI
  Council Is at a Crossroads" rather than "click here").
- [3.1.1 Language of Page](https://www.w3.org/WAI/WCAG21/Understanding/language-of-page):
  `lang="en"` is set on `<html>`.
- [1.4.3 Contrast Minimum](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum):
  the inline CSS uses `#333` on white (ratio ≈ 12.6:1, passes AA),
  `#2a5298` on white (≈ 6.4:1, passes AA normal), white on `#2a5298`
  (same 6.4:1, passes AA), white on `#2d8659` (~4.5:1, borderline —
  wants verification with the
  [WebAIM contrast checker](https://webaim.org/resources/contrastchecker/)),
  white on `#888` (~3.5:1, **fails 1.4.3 AA for normal text**, passes
  only for large text), white on `#555` (~7.5:1, passes AA),
  `#666` on white (the `.tagline`, ~5.7:1, passes AA normal). The
  `#888` buttons ("Source", "Status") are candidates to darken in a
  future edit.
- [4.1.2 Name, Role, Value](https://www.w3.org/WAI/WCAG21/Understanding/name-role-value):
  navigation links are `<a>` elements styled as buttons via
  `.service-link`; role remains "link" which is accurate for
  navigation.

**Things source inspection cannot verify and that want a browser
pass.**

- Actual rendered contrast (browsers may apply font-smoothing that
  shifts perceived contrast).
- Focus visibility on the link-styled buttons (the current CSS does
  not include a `:focus` style; browsers provide a default outline,
  which typically satisfies
  [2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible)
  but should be confirmed).
- Zoom/reflow behavior at 400%
  ([1.4.10 Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow)).
- Screen reader traversal of the `<details>/<summary>` element in
  NVDA, JAWS, and VoiceOver.

**Links for the future evaluation pass.**

- Live page: [bayleaf.dev](https://bayleaf.dev).
- Source: [docs/index.html](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/index.html).
- Contrast check tool:
  [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/).

### 5.5 Out of scope: docs/support.html and other GitHub-Pages-hosted content

BayLeaf's UIs link outbound to a number of GitHub-hosted
destinations: source browsing at
[github.com/bayleaf-ucsc/bayleaf](https://github.com/bayleaf-ucsc/bayleaf),
the vulnerability-reporting policy at
[SECURITY.md](https://github.com/bayleaf-ucsc/bayleaf/blob/main/SECURITY.md),
issue reporting, and the politics/ directory containing HECVAT, FERPA,
and this document.

Those destinations are GitHub product surfaces (repository views, file
rendering, issue forms) whose accessibility is GitHub's responsibility.
GitHub publishes current ACRs at
[accessibility.github.com](https://accessibility.github.com/) covering
github.com and related products. This VPAT notes those ACRs as a
**courtesy disclosure** — a reader following a BayLeaf outbound link
into a GitHub-rendered page is landing on a surface covered by
GitHub's own conformance report, not by BayLeaf's.

This is not a claim that GitHub's ACRs cover BayLeaf-authored content
hosted on GitHub Pages. BayLeaf's [`docs/index.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/index.html)
is BayLeaf's responsibility regardless of the hosting platform
(see [§ 5.4](#54-bayleafdev-landing-docsindexhtml)). Likewise, the
rendered view of [`docs/support.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/support.html)
and future pages in `docs/` is BayLeaf-authored content that will be
brought into scope for direct evaluation when capacity allows.

**Practical implication for the ACR table in [§ 7](#7-draft-conformance-table):**
outbound GitHub links need no special annotation; they are out of
scope by virtue of not being BayLeaf surfaces. A reviewer concerned
about the accessibility of the destination should consult
[GitHub's ACRs](https://accessibility.github.com/) directly.

---

## 6. AI-generated output as an accessibility surface

<!-- SEC:AI_OUTPUT -->

The standard VPAT applies to the product's UI. For a chat service, most
of what a user perceives is *model output* rendered inside that UI.
Model output is neither purely UI (the chat frontend doesn't author it)
nor purely user content (the user didn't type it); it is a third
category that existing accessibility templates do not cleanly address.
This section names the category and enumerates the relevant success
criteria, so that future evaluations can reason about it without
re-inventing the frame.

**Why the standard VPAT misses this.** Vendor VPATs are written from
the perspective of a product team that ships a UI. The UI's
accessibility is their responsibility; the content users paste in is
not. LLM output sits between those categories: the product generated
it in response to user prompts, but it is not curated or QA'd the way
first-party content would be. Consumer AI vendors (OpenAI, Anthropic,
Google) handle this by declining to cover model output in their ACRs,
which is honest but leaves the accessibility question unanswered for
anyone relying on those tools in an institutional context.

**Relevant WCAG 2.1 success criteria applied to model output:**

- [1.1.1 Non-text Content](https://www.w3.org/WAI/WCAG21/Understanding/non-text-content) —
  generated images (DALL·E, Imagen, etc.) rendered in the chat UI need
  alt text. The model can be prompted to provide a description
  alongside any generated image; the UI must render it as an `alt`
  attribute or equivalent. This is a joint UI/prompt responsibility.
- [1.3.1 Info and Relationships](https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships) —
  when a model emits markdown tables, lists, or headings, the UI's
  markdown renderer must preserve those semantics in the DOM.
  Malformed markdown (which LLMs sometimes produce) can produce
  inaccessible output even when the renderer is correct.
- [1.4.5 Images of Text](https://www.w3.org/WAI/WCAG21/Understanding/images-of-text) —
  models occasionally return ASCII art, rendered diagrams, or
  screenshots when text would serve. The system prompt is a lever for
  steering away from this.
- [2.4.6 Headings and Labels](https://www.w3.org/WAI/WCAG21/Understanding/headings-and-labels) —
  long model responses benefit from heading structure; the system
  prompt can encourage this for long answers.
- [4.1.3 Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages) —
  this is the biggest one for streamed chat. As tokens stream in,
  screen readers need to know content is arriving without being
  flooded by every token. The standard pattern is an ARIA live
  region with appropriate politeness; the UI owns this, but BayLeaf
  can verify upstream behavior and file issues when it is wrong.

**The system-prompt-as-lever observation.** A faculty-operated service
can embed accessibility-aware conventions in system prompts in ways a
fixed-product vendor cannot. Examples of what BayLeaf *could* add to
system prompts if accessibility review recommended it:

- "When describing an image you generate, write an alt-text-quality
  description in a sentence above the image."
- "For responses longer than ~300 words, use level-2 markdown
  headings to structure the answer."
- "Do not render information as ASCII art when prose would serve.
  Prefer structured lists over formatted diagrams."
- "When emitting tables, include a brief sentence describing what the
  table shows before the table itself."

None of these is committed BayLeaf policy today. They are on the table
as design choices the service can make, and the fact that they are on
the table at all is one of the structural advantages of
faculty-operated tools enumerated in [POSITION.md](POSITION.md) and
[HECVAT.md](HECVAT.md). A vendor ACR cannot make this move; BayLeaf's
can, and the AI Council may want to weigh in on whether it should.

**Research and guidance to consult.** This is an active area without
settled best practices. Relevant entry points:

- W3C [Accessibility of Remote Meetings](https://www.w3.org/TR/remote-meetings/)
  (has some applicable live-region pattern discussion).
- [W3C APG — Live Region patterns](https://www.w3.org/WAI/ARIA/apg/patterns/alert/)
  and [status](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/) documentation.
- Deque [screen reader announcements in streaming UIs](https://www.deque.com/blog/)
  (search for streaming / live region content).
- The [WebAIM Screen Reader User Survey](https://webaim.org/projects/screenreadersurvey10/)
  for context on how real users consume streamed content.
- [ARIA Authoring Practices Guide (APG)](https://www.w3.org/WAI/ARIA/apg/)
  for the general live-region patterns the UI should implement.

**Where this lives in the conformance table.** [§ 7](#7-draft-conformance-table)
marks AI-output criteria as Not Evaluated with remarks pointing here.
A future evaluation pass would need to decide whether to fold AI output
into Chat's conformance entries (arguing it is part of the Chat
surface) or to report it in a separate addendum. The operator's
current view: keep it as a separate section until the AI Council has
a position on whether system-prompt interventions are in scope for
this VPAT.

---

## 7. Draft conformance table

<!-- SEC:CONFORMANCE_TABLE -->

The tables below follow the
[VPAT 2.5 INT template structure](https://www.itic.org/policy/accessibility/vpat).
Each criterion row gives a conformance level and remarks. The
conformance vocabulary is defined in [§ 1](#1-what-a-vpat-is-and-why-this-one-looks-different).

The **surface** column uses these abbreviations:

- **Chat** — [chat.bayleaf.dev](https://chat.bayleaf.dev) ([§ 5.1](#51-bayleaf-chat-chatbayleafdev))
- **API-L** — [api.bayleaf.dev](https://api.bayleaf.dev) landing ([§ 5.2](#52-bayleaf-api-landing-apibayleafdev))
- **API-D** — [api.bayleaf.dev/dashboard](https://api.bayleaf.dev/dashboard) ([§ 5.3](#53-bayleaf-api-dashboard-apibayleafdevdashboard))
- **Landing** — [bayleaf.dev](https://bayleaf.dev) / [`docs/index.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/index.html) ([§ 5.4](#54-bayleafdev-landing-docsindexhtml))

Each criterion name links to the official WCAG 2.1 *Understanding*
document so future evaluators can look up the intent, the Success
Criteria text, and the test procedures without leaving this doc.

Remarks marked **N/E** ("Not Evaluated") indicate the honest current
state. They are not claims of non-conformance; they indicate the
criterion has not yet been assessed. Where useful, remarks point to
the specific artifact (file path, URL, upstream issue) a future
evaluator would need.

### 7.1 WCAG 2.1 Level A

The full Level A criterion set is defined by the
[W3C WCAG 2.1 Recommendation](https://www.w3.org/TR/WCAG21/#conformance-reqs).
Each row below links to the *Understanding* document for the
criterion.

| # | Criterion | Chat | API-L | API-D | Landing | Remarks |
|---|---|---|---|---|---|---|
| 1.1.1 | [Non-text Content](https://www.w3.org/WAI/WCAG21/Understanding/non-text-content) | N/E | Supports | N/E | Supports | Landing: no non-text content that conveys meaning; all images are absent (text-only page). API-L: same (no images). Chat: see [§ 6](#6-ai-generated-output-as-an-accessibility-surface) for AI-generated images. |
| 1.2.1 | [Audio-only and Video-only (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-only-and-video-only-prerecorded) | N/A | N/A | N/A | N/A | No prerecorded media on any BayLeaf surface. |
| 1.2.2 | [Captions (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/captions-prerecorded) | N/A | N/A | N/A | N/A | No prerecorded media. |
| 1.2.3 | [Audio Description or Media Alternative (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-description-or-media-alternative-prerecorded) | N/A | N/A | N/A | N/A | No prerecorded media. |
| 1.3.1 | [Info and Relationships](https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships) | N/E | N/E | N/E | Supports | Landing: headings in hierarchical order (h1 → h2 → h3), lists marked up as `<ul>`, subprocessor disclosure uses native `<details>/<summary>`. |
| 1.3.2 | [Meaningful Sequence](https://www.w3.org/WAI/WCAG21/Understanding/meaningful-sequence) | N/E | N/E | N/E | Supports | Landing: DOM order matches visual order; no CSS-driven reordering. |
| 1.3.3 | [Sensory Characteristics](https://www.w3.org/WAI/WCAG21/Understanding/sensory-characteristics) | N/E | N/E | N/E | Supports | Landing: no instructions rely on shape, size, or location. |
| 1.4.1 | [Use of Color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color) | N/E | N/E | N/E | Supports | Landing: color is not the sole means of conveying information; link text is descriptive independent of color. |
| 1.4.2 | [Audio Control](https://www.w3.org/WAI/WCAG21/Understanding/audio-control) | N/A | N/A | N/A | N/A | No auto-playing audio. |
| 2.1.1 | [Keyboard](https://www.w3.org/WAI/WCAG21/Understanding/keyboard) | N/E | N/E | N/E | Supports | Landing: all interactive elements are native `<a>` and `<details>` — keyboard-operable by default. API-D wants explicit live-audit confirmation. |
| 2.1.2 | [No Keyboard Trap](https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap) | N/E | N/E | N/E | Supports | Landing: no modal, no custom focus traps. |
| 2.1.4 | [Character Key Shortcuts](https://www.w3.org/WAI/WCAG21/Understanding/character-key-shortcuts) | N/E | N/A | N/A | N/A | Open WebUI may bind character shortcuts; verify in Chat evaluation. |
| 2.2.1 | [Timing Adjustable](https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable) | N/E | N/A | N/E | N/A | Sessions on API-D expire; verify whether session timeouts can be extended or warned about. |
| 2.2.2 | [Pause, Stop, Hide](https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide) | N/E | N/A | N/A | N/A | Streamed chat responses are arguably "moving" content — examine in Chat evaluation with [§ 6](#6-ai-generated-output-as-an-accessibility-surface) in mind. |
| 2.3.1 | [Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold) | N/E | Supports | Supports | Supports | No flashing content on any BayLeaf-authored surface. |
| 2.4.1 | [Bypass Blocks](https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks) | N/E | N/E | N/E | Partially Supports | Landing: no skip-link, but the page is short and has only one navigation block; adding a skip-link is a minor future improvement. A single `<main>` landmark would also help. |
| 2.4.2 | [Page Titled](https://www.w3.org/WAI/WCAG21/Understanding/page-titled) | N/E | N/E | N/E | Supports | Landing: `<title>BayLeaf AI Playground</title>`. API templates need source check for `<title>`. |
| 2.4.3 | [Focus Order](https://www.w3.org/WAI/WCAG21/Understanding/focus-order) | N/E | N/E | N/E | Supports | Landing: DOM order is reading order; no `tabindex` manipulation. |
| 2.4.4 | [Link Purpose (In Context)](https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context) | N/E | N/E | N/E | Supports | Landing: link text is descriptive (e.g., "UCSC's Newly Established AI Council Is at a Crossroads", "OpenRouter's model directory"); no "click here". |
| 2.5.1 | [Pointer Gestures](https://www.w3.org/WAI/WCAG21/Understanding/pointer-gestures) | N/E | Supports | N/E | Supports | Landing and API-L: no multi-point or path-based gestures. |
| 2.5.2 | [Pointer Cancellation](https://www.w3.org/WAI/WCAG21/Understanding/pointer-cancellation) | N/E | Supports | N/E | Supports | Landing and API-L: uses default `<a>` activation behavior. |
| 2.5.3 | [Label in Name](https://www.w3.org/WAI/WCAG21/Understanding/label-in-name) | N/E | N/E | N/E | Supports | Landing: no aria-label overrides; visible text matches accessible name. |
| 2.5.4 | [Motion Actuation](https://www.w3.org/WAI/WCAG21/Understanding/motion-actuation) | N/A | N/A | N/A | N/A | No motion-based functionality. |
| 3.1.1 | [Language of Page](https://www.w3.org/WAI/WCAG21/Understanding/language-of-page) | N/E | N/E | N/E | Supports | Landing: `<html lang="en">` present. |
| 3.2.1 | [On Focus](https://www.w3.org/WAI/WCAG21/Understanding/on-focus) | N/E | N/E | N/E | Supports | Landing: no focus-triggered context changes. |
| 3.2.2 | [On Input](https://www.w3.org/WAI/WCAG21/Understanding/on-input) | N/E | N/E | N/E | Supports | Landing: no form inputs. |
| 3.3.1 | [Error Identification](https://www.w3.org/WAI/WCAG21/Understanding/error-identification) | N/E | N/A | N/E | N/A | Landing and API-L have no forms. API-D forms need live evaluation per [§ 5.3](#53-bayleaf-api-dashboard-apibayleafdevdashboard). |
| 3.3.2 | [Labels or Instructions](https://www.w3.org/WAI/WCAG21/Understanding/labels-or-instructions) | N/E | N/A | N/E | N/A | Landing and API-L have no forms. |
| 4.1.1 | [Parsing](https://www.w3.org/WAI/WCAG21/Understanding/parsing) | N/E | N/E | N/E | Supports | Landing: validates as HTML5 (per source inspection); no duplicate `id` attributes. Note: [WCAG 2.2 removed this criterion](https://www.w3.org/TR/WCAG22/#parsing) as obsolete, but VPAT 2.5 retains it under WCAG 2.1. |
| 4.1.2 | [Name, Role, Value](https://www.w3.org/WAI/WCAG21/Understanding/name-role-value) | N/E | N/E | N/E | Supports | Landing: uses native elements (`<a>`, `<details>`, `<summary>`) with correct roles; no custom ARIA. |

### 7.2 WCAG 2.1 Level AA

Level AA is the target set for [ADA Title II](https://www.ada.gov/resources/2024-03-08-web-rule/),
[Section 508](https://www.access-board.gov/ict/),
[EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/),
and [UC IMG-2150](https://policy.ucop.edu/doc/7000611/IMT-2150). Level
AA subsumes Level A; this table covers the criteria added at AA.

| # | Criterion | Chat | API-L | API-D | Landing | Remarks |
|---|---|---|---|---|---|---|
| 1.2.4 | [Captions (Live)](https://www.w3.org/WAI/WCAG21/Understanding/captions-live) | N/A | N/A | N/A | N/A | No live media. |
| 1.2.5 | [Audio Description (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-description-prerecorded) | N/A | N/A | N/A | N/A | No prerecorded video. |
| 1.3.4 | [Orientation](https://www.w3.org/WAI/WCAG21/Understanding/orientation) | N/E | Supports | N/E | Supports | Landing and API-L: responsive, no orientation lock. |
| 1.3.5 | [Identify Input Purpose](https://www.w3.org/WAI/WCAG21/Understanding/identify-input-purpose) | N/E | N/A | N/E | N/A | Landing and API-L have no inputs. API-D may have username/email fields that should carry `autocomplete` attributes. |
| 1.4.3 | [Contrast (Minimum)](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum) | N/E | N/E | N/E | **Partially Supports** | Landing: most color pairs pass AA (see [§ 5.4](#54-bayleafdev-landing-docsindexhtml) for detail); the `#888` "Source" and "Status" buttons (white-on-`#888` ≈ 3.5:1) fail AA for normal text. **Known defect.** Candidate fix: darken to `#666` or below. |
| 1.4.4 | [Resize Text](https://www.w3.org/WAI/WCAG21/Understanding/resize-text) | N/E | N/E | N/E | Supports | Landing: uses `rem` and relative units; zooms cleanly to 200% in browsers. |
| 1.4.5 | [Images of Text](https://www.w3.org/WAI/WCAG21/Understanding/images-of-text) | N/E | N/A | N/A | N/A | No images of text on BayLeaf-authored surfaces. See [§ 6](#6-ai-generated-output-as-an-accessibility-surface) for AI-generated output. |
| 1.4.10 | [Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow) | N/E | N/E | N/E | N/E | Landing: `max-width: 800px` with relative padding should reflow cleanly at 400% zoom / 320 CSS px; wants browser verification. |
| 1.4.11 | [Non-text Contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast) | N/E | N/E | N/E | Partially Supports | Landing: the `#888` button background on white (~3.5:1) meets the 3:1 UI component threshold here (non-text contrast is a lower bar than text contrast), but the white text on those buttons is the [1.4.3](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum) failure above. |
| 1.4.12 | [Text Spacing](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing) | N/E | N/E | N/E | Supports | Landing: no fixed `height` on text containers; content would adapt to user-overridden spacing. |
| 1.4.13 | [Content on Hover or Focus](https://www.w3.org/WAI/WCAG21/Understanding/content-on-hover-or-focus) | N/E | N/A | N/E | N/A | Landing and API-L: no hover tooltips or popovers. |
| 2.4.5 | [Multiple Ways](https://www.w3.org/WAI/WCAG21/Understanding/multiple-ways) | N/A | N/A | N/A | N/A | Single-page surfaces (landing, API-L); no "set of pages" to offer multiple navigation to. |
| 2.4.6 | [Headings and Labels](https://www.w3.org/WAI/WCAG21/Understanding/headings-and-labels) | N/E | N/E | N/E | Supports | Landing: headings describe their sections clearly. |
| 2.4.7 | [Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible) | N/E | N/E | N/E | N/E | Landing: no explicit `:focus` styles in CSS; relies on browser default focus ring. Defaults typically satisfy 2.4.7, but adding an explicit style on `.service-link:focus` is a cheap improvement. Needs live browser check. |
| 3.1.2 | [Language of Parts](https://www.w3.org/WAI/WCAG21/Understanding/language-of-parts) | N/A | N/A | N/A | N/A | No foreign-language passages on BayLeaf-authored surfaces. |
| 3.2.3 | [Consistent Navigation](https://www.w3.org/WAI/WCAG21/Understanding/consistent-navigation) | N/A | N/A | N/A | N/A | Single-page surfaces. |
| 3.2.4 | [Consistent Identification](https://www.w3.org/WAI/WCAG21/Understanding/consistent-identification) | N/E | N/E | N/E | Supports | Landing: recurring elements (the subprocessor list, the contact block) are identified consistently. |
| 3.3.3 | [Error Suggestion](https://www.w3.org/WAI/WCAG21/Understanding/error-suggestion) | N/E | N/A | N/E | N/A | No forms on Landing or API-L. |
| 3.3.4 | [Error Prevention (Legal, Financial, Data)](https://www.w3.org/WAI/WCAG21/Understanding/error-prevention-legal-financial-data) | N/E | N/A | N/E | N/A | Key provisioning on API-D is reversible (keys can be rotated/revoked); not a "legal, financial, data" transaction in the WCAG sense. |
| 4.1.3 | [Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages) | N/E | N/A | N/E | N/A | No dynamic status on Landing or API-L. Critical for Chat (streamed responses) and API-D (key-provisioning feedback); see [§§ 5.1](#51-bayleaf-chat-chatbayleafdev), [5.3](#53-bayleaf-api-dashboard-apibayleafdevdashboard), [6](#6-ai-generated-output-as-an-accessibility-surface). |

**Level AAA criteria** are not included in this table. VPAT 2.5 treats
Level AAA as optional; conformance claims at AA do not include AAA.
BayLeaf has not targeted AAA and does not claim it. The
[full AAA criterion list](https://www.w3.org/TR/WCAG21/#conformance-reqs)
is available from W3C for readers interested in the next tier.

### 7.3 Revised Section 508 — Chapters 3, 4, 5, 6

[Revised Section 508](https://www.access-board.gov/ict/) incorporates
WCAG 2.0 Level A and AA by reference for web content (Chapter 5:
Software, and Chapter 6: Support Documentation). The chapters below
cover the 508-specific requirements that extend beyond WCAG.

**Chapter 3: Functional Performance Criteria (FPC).** FPC apply when
[§ E205.2](https://www.access-board.gov/ict/#E205.2) (web/software
conformance requirements) cannot be fully met, or as an alternative
path. For a web-only service, WCAG 2.0 AA conformance generally
discharges the FPC obligation. BayLeaf claims conformance via the
WCAG path; see [§ 7.2](#72-wcag-21-level-aa).

| § | Criterion | Applies? | Remarks |
|---|---|---|---|
| [302.1](https://www.access-board.gov/ict/#302.1) | Without Vision | Via WCAG | Chat relies on upstream Open WebUI; others per [§ 7.2](#72-wcag-21-level-aa). |
| [302.2](https://www.access-board.gov/ict/#302.2) | With Limited Vision | Via WCAG | Covered by 1.4.3, 1.4.4, 1.4.10. |
| [302.3](https://www.access-board.gov/ict/#302.3) | Without Perception of Color | Via WCAG | Covered by 1.4.1. |
| [302.4](https://www.access-board.gov/ict/#302.4) | Without Hearing | N/A | No audio content. |
| [302.5](https://www.access-board.gov/ict/#302.5) | With Limited Hearing | N/A | No audio content. |
| [302.6](https://www.access-board.gov/ict/#302.6) | Without Speech | N/A | No speech-input required. |
| [302.7](https://www.access-board.gov/ict/#302.7) | With Limited Manipulation | Via WCAG | Covered by 2.1.1, 2.5.1. |
| [302.8](https://www.access-board.gov/ict/#302.8) | With Limited Reach and Strength | Via WCAG | Covered by 2.5.1, 2.5.2. |
| [302.9](https://www.access-board.gov/ict/#302.9) | Minimize Photosensitive Seizure Triggers | Via WCAG | Covered by 2.3.1. |
| [302.10](https://www.access-board.gov/ict/#302.10) | With Limited Cognition, Language, and Learning | Via WCAG | Broadly covered by readable-content criteria (3.1.*, 2.4.*). |

**Chapter 4: Hardware.** Not applicable. BayLeaf is not hardware.

**Chapter 5: Software.**

| § | Criterion | Applies? | Remarks |
|---|---|---|---|
| [502](https://www.access-board.gov/ict/#502) | Interoperability with Assistive Technology | Via WCAG 4.1.2 | Applies to platform-software-like behavior; for web content largely discharged by WCAG 4.1.2 (Name, Role, Value). |
| [503](https://www.access-board.gov/ict/#503) | Applications | Via WCAG | Web applications covered by WCAG incorporation. |
| [504](https://www.access-board.gov/ict/#504) | Authoring Tools | N/A | BayLeaf is not an authoring tool in the 508 sense; users generate content via prompts but BayLeaf does not author persistent web content on the user's behalf. |

**Chapter 6: Support Documentation and Services.**

| § | Criterion | Applies? | Remarks |
|---|---|---|---|
| [602.2](https://www.access-board.gov/ict/#602.2) | Accessibility and Compatibility Features | Supports | This document plus [HECVAT.md](HECVAT.md), [FERPA.md](FERPA.md), and [SECURITY.md](SECURITY.md) are provided as accessible web content. |
| [602.3](https://www.access-board.gov/ict/#602.3) | Electronic Support Documentation | N/E | Support page at [`docs/support.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/support.html) is out of scope per [§ 4](#4-scope) but will be brought in when capacity allows. |
| [602.4](https://www.access-board.gov/ict/#602.4) | Alternate Formats for Non-Electronic Support Documentation | N/A | No non-electronic documentation. |
| [603](https://www.access-board.gov/ict/#603) | Support Services | Supports | Support is via email to the operator ([amsmith@ucsc.edu](mailto:amsmith@ucsc.edu)); email is an accessible medium. |

### 7.4 EN 301 549 — chapters not covered above

[EN 301 549 v3.2.1](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf)
is the European harmonized standard for ICT accessibility. It
incorporates WCAG 2.1 Level A and AA by reference (Chapter 9: Web)
and adds requirements beyond WCAG in Chapters 5, 6, 7, 8, 10, 11, and
12. For a web-only service with no hardware, no two-way voice
communication, no video, and no closed functionality, most of these
chapters are Not Applicable.

| Chapter | Title | Applies? | Remarks |
|---|---|---|---|
| [4](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Functional Performance Statements | Via WCAG | Parallels Section 508 Chapter 3; discharged via WCAG conformance. |
| [5](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Generic Requirements | Partially Applies | 5.1 (closed functionality), 5.2 (biometrics), 5.3 (privacy of AT), 5.4 (preservation of info through conversion), 5.5 (operable parts), 5.6 (locking/toggle), 5.7 (key repeat), 5.8 (double-strike), 5.9 (simultaneous user actions) — all N/A for a web-only service without biometrics or hardware controls. |
| [6](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | ICT with Two-Way Voice Communication | N/A | No voice communication. |
| [7](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | ICT with Video Capabilities | N/A | No video playback or capture. |
| [8](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Hardware | N/A | Not hardware. |
| [9](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Web | Via WCAG | Web content covered by [§§ 7.1](#71-wcag-21-level-a)–[7.2](#72-wcag-21-level-aa). |
| [10](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Non-Web Documents | N/A | BayLeaf does not distribute non-web documents (no PDFs, no Word files) as primary content. |
| [11](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Software | Via WCAG 4.1.2 | The API dashboard is "software" in the EN sense; covered by WCAG. |
| [12](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Documentation and Support Services | Supports | Parallels 508 Chapter 6; BayLeaf documentation is web content. |
| [13](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | ICT Providing Relay or Emergency Service Access | N/A | Not a relay or emergency service. |

---

## 8. Evaluation methodology (for future passes)

<!-- SEC:METHODOLOGY -->

A real evaluation pass combines automated tooling (cheap, repeatable,
catches a minority of real issues) with manual testing (expensive, not
automatable, catches the rest). [Deque](https://www.deque.com/) has
published that automated tools with `axe-core` catch roughly
[57% of accessibility issues](https://www.deque.com/blog/automated-testing-obligations-of-the-ada/)
on average; older estimates commonly cited are closer to 30%. The
remainder requires keyboard and screen-reader evaluation.

**Automated tooling** to run against each live surface:

- **[axe DevTools](https://www.deque.com/axe/devtools/)** (browser
  extension, free tier) — the industry baseline. Runs `axe-core`
  which is also available as a [CLI](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/cli)
  and [CI-friendly library](https://github.com/dequelabs/axe-core).
- **[Lighthouse](https://developer.chrome.com/docs/lighthouse/accessibility/)**
  (built into Chrome DevTools) — runs a subset of `axe-core` rules;
  useful as a second opinion and for performance/SEO at the same time.
- **[WAVE](https://wave.webaim.org/)** (WebAIM) — a different ruleset
  from axe, good at catching things axe misses (and vice versa).
  Available as a [browser extension](https://wave.webaim.org/extension/).
- **[pa11y](https://github.com/pa11y/pa11y)** — command-line tool,
  suitable for CI. Uses HTML_CodeSniffer or axe as its engine.
- **[Accessibility Insights for Web](https://accessibilityinsights.io/docs/web/overview/)**
  (Microsoft) — adds structured manual tests (the "Assessment" mode)
  on top of automated checks.

**Manual testing**, per surface:

- **Keyboard-only pass.** Disconnect the mouse / trackpad. Navigate
  every interactive element with Tab, Shift-Tab, Enter, Space, and
  arrow keys. Note focus-visibility, focus order, any keyboard traps.
  Covers WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.7.
- **Screen reader pass.** At least one of:
  - [NVDA](https://www.nvaccess.org/) on Windows (free; the most-used
    screen reader per
    [WebAIM Screen Reader User Survey #10](https://webaim.org/projects/screenreadersurvey10/)).
  - [VoiceOver](https://www.apple.com/accessibility/vision/) on macOS
    or iOS (built in; common on iOS).
  - [JAWS](https://www.freedomscientific.com/products/software/jaws/)
    on Windows (commercial; common in enterprise).
  - [Orca](https://help.gnome.org/users/orca/stable/) on Linux.
- **Zoom / reflow.** Set browser zoom to 200% and 400%; verify no
  horizontal scroll at 320 CSS px viewport width. Covers 1.4.4, 1.4.10.
- **Contrast.** Use the [WebAIM contrast checker](https://webaim.org/resources/contrastchecker/)
  or axe's built-in contrast rule to verify foreground/background
  pairs meet 4.5:1 (normal text) or 3:1 (large text and UI components).
- **Text spacing.** Apply the
  [text-spacing bookmarklet](https://www.html5accessibility.com/tests/tsbookmarklet.html)
  or a user stylesheet to increase letter/word/line spacing; verify no
  content is clipped or overlaps. Covers 1.4.12.

**AI-output scenarios specific to Chat**, from [§ 6](#6-ai-generated-output-as-an-accessibility-surface):

- Generate a response with a markdown table; verify the DOM is a real
  `<table>` and a screen reader announces row/column structure.
- Generate an image; verify `alt` attribute (or equivalent) is present
  and meaningful, not just "image" or the filename.
- Request a long response; verify heading structure and that a screen
  reader can navigate between sections.
- During a streamed response, verify the ARIA live-region politeness
  is appropriate (not flooding the user with every token, but not
  silent either).

**Documentation.** Each evaluation pass should record: the date, the
version / commit of the surface evaluated, the tools and versions
used, the screen reader and browser combinations tested, and the raw
findings. That record is the evidence a future reviewer (or a future
ACR reader) will look for when asking whether the claims in [§ 7](#7-draft-conformance-table)
are current.

See [§ 10](#10-future-work) for notes on packaging this as repeatable
tooling.

---

## 9. Open questions for the AI Council and accessibility stakeholders

<!-- SEC:OPEN_QUESTIONS -->

These are the questions this analysis cannot resolve on its own,
parallel to [FERPA.md § 10](FERPA.md#10-open-questions-for-the-ai-council).
They are best addressed jointly by the
[UCSC IT Accessibility](https://its.ucsc.edu/accessibility/) program,
the [UCSC AI Council](https://its.ucsc.edu/about/it-governance/artificial-intelligence),
the [Disability Resource Center](https://drc.ucsc.edu/), and (for
Title II interpretation) [Campus Counsel](https://campuscounsel.ucsc.edu/).

1. **Does Open WebUI publish an ACR?** This is the top blocker for
   Chat's evaluation status. Search leads are enumerated in
   [§ 5.1](#51-bayleaf-chat-chatbayleafdev). If no upstream ACR
   exists, the follow-up question is whether BayLeaf should file an
   upstream issue requesting one, and whether UCSC's accessibility
   review considers upstream-OSS-with-no-ACR categorically different
   from a vendor who declines to publish one.

2. **Who at UCSC plays the accessibility role that ISO plays for
   security?** [FERPA.md § 7.1](FERPA.md#71-which-ucsc-offices-are-involved)
   maps the offices involved in security/privacy review (Counsel,
   Privacy Office, ISO, AI Council, Procurement). The accessibility
   equivalent of that map is less clear from outside. Candidates:
   the IT Accessibility program in ITS, the DRC (which focuses on
   individual accommodations rather than product conformance), or
   a yet-to-be-defined reviewer role.

3. **How does UCSC's ADA Title II posture extend to faculty-operated
   services?** The 2024 DOJ rule imposes Title II on UCSC; anything
   UCSC directs users toward falls within that posture. Does the
   designation framework proposed in
   [FERPA.md § 8](FERPA.md#8-a-draft-designation-memo) extend to
   accessibility obligations, or does accessibility need its own
   parallel instrument?

4. **What is the minimum viable accessibility review package for a
   faculty-operated service?** This document plus the supporting
   scans it enables would be the operator's proposal; UCSC's
   accessibility review function would need to weigh in.

5. **How should AI-generated output be characterized in accessibility
   reviews?** [§ 6](#6-ai-generated-output-as-an-accessibility-surface)
   names this as a frontier question without settled practice. Three
   framings are in play: (a) service responsibility (the service
   emits the output and must ensure it is accessible), (b) user
   responsibility (the user prompted the output and must adapt it
   for their audience), (c) shared responsibility with the service
   providing sensible defaults and levers. The AI Council may have a
   policy preference here.

6. **System-prompt interventions.** If the Council takes the "service
   responsibility" or "shared responsibility" reading in question 5,
   should BayLeaf commit to the accessibility-oriented system-prompt
   conventions sketched in [§ 6](#6-ai-generated-output-as-an-accessibility-surface)?
   This is a pedagogical choice as much as an accessibility one and
   deserves Council input.

7. **Precedent.** If BayLeaf's VPAT process establishes a pattern,
   what does that pattern look like for the next faculty-operated
   service the campus considers? Is there a reusable template, a
   standing reviewer role, a lightweight CI harness the campus would
   want to see adopted?

---

## 10. Future work

<!-- SEC:FUTURE_WORK -->

This section notes possibilities, not commitments.

**Per-surface reports as a subdirectory.** If BayLeaf expands the set
of surfaces it operates (new Cloudflare Worker apps, new GitHub Pages
content, embedded widgets), this single `VPAT.md` may become
unwieldy. At that point the natural shape is a `politics/VPAT/`
directory:

```
politics/VPAT/
  README.md       # the framing memo and inheritance map
  chat.md         # chat.bayleaf.dev ACR
  api.md          # api.bayleaf.dev ACR (landing + dashboard)
  landing.md      # bayleaf.dev ACR
```

The current single-file shape matches the shape of `HECVAT.md` and
`FERPA.md`, which is the right starting point for consistency.

**Automated scanning harness.** A candidate repo addition, parallel
to how the project already treats
[DEPENDENCIES.md](DEPENDENCIES.md) as a living document:

```
tools/a11y/
  scan.sh         # runs axe-core CLI and/or pa11y against the three live surfaces
  reports/        # dated output, checked in as evidence
  README.md       # how to run, how to interpret
```

Candidate tools for the harness:

- [`@axe-core/cli`](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/cli) — headless axe runs from the command line.
- [`pa11y`](https://github.com/pa11y/pa11y) and [`pa11y-ci`](https://github.com/pa11y/pa11y-ci) — CI-oriented runner.
- [`lighthouse-ci`](https://github.com/GoogleChrome/lighthouse-ci) — if the project also wants performance/SEO reporting in the same harness.
- [`playwright`](https://playwright.dev/docs/accessibility-testing) with [`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright) — for authenticated surfaces like the dashboard.

**What automation cannot do.** Automated scans do not substitute for
manual screen-reader and keyboard passes; per [§ 8](#8-evaluation-methodology-for-future-passes)
they catch at best around half of real issues. The harness's value is
(a) regression detection — surfacing newly-introduced violations on
every commit, and (b) producing durable evidence a reviewer can point
to. The honest accessibility story still depends on periodic manual
passes.

**Upstream contribution.** If the Open WebUI evaluation surfaces
specific defects ([§ 5.1](#51-bayleaf-chat-chatbayleafdev)), the
operator-level response is to file them upstream at
[github.com/open-webui/open-webui/issues](https://github.com/open-webui/open-webui/issues)
with specific repro steps and WCAG criterion references. This is the
[§ 99.33(b)](https://www.ecfr.gov/current/title-34/subtitle-A/part-99/subpart-D/section-99.33)-analogue
move in the accessibility setting: BayLeaf does not own the upstream
code but does own the responsibility to push the chain to improve.

**Re-evaluation cadence.** A signed ACR is a point-in-time artifact.
Reasonable cadences:

- On every non-trivial change to BayLeaf-authored templates (the
  API landing, dashboard, and `docs/` pages). Automated scans on
  pull request.
- On Open WebUI version bumps. Smoke-test the changed areas.
- Annually, a full manual pass. This matches the cadence of the UC
  IMG-2150 annual reporting cycle.

---

## 11. References

<!-- SEC:REFERENCES -->

### VPAT template and guidance

- [ITI VPAT 2.5](https://www.itic.org/policy/accessibility/vpat) — current template and editions.
- [ITI Accessibility Resources](https://www.itic.org/policy/accessibility/accessibility-resources) — guidance on completing a VPAT.
- [VPAT 2.5 INT (International) Edition](https://www.itic.org/dotAsset/dc611114-0d38-474b-bd72-f606832c2407.doc) — the edition this document follows.
- [VPAT 2.5 WCAG Edition](https://www.itic.org/dotAsset/1c95f5c1-4c8a-4fa1-90a1-67a7f0d45de4.doc).
- [VPAT 2.5 Section 508 Edition](https://www.itic.org/dotAsset/ba601692-c81d-4f83-84a4-c9d83c3bd3fa.doc).
- [VPAT 2.5 EN 301 549 Edition](https://www.itic.org/dotAsset/9f02f58e-a0e3-42f5-8cea-80b0e0b6f83a.doc).

### Standards

- [WCAG 2.1](https://www.w3.org/TR/WCAG21/) — W3C Recommendation, the success-criterion set this document targets.
- [WCAG 2.1 Understanding](https://www.w3.org/WAI/WCAG21/Understanding/) — normative explanations per criterion (linked row-by-row in [§ 7](#7-draft-conformance-table)).
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) — next version; noted for context, not targeted by this ACR.
- [Revised Section 508 Standards](https://www.access-board.gov/ict/) — US Access Board.
- [Section 508 ICT Testing Baseline](https://section508coordinators.github.io/ICTTestingBaseline/) — community-maintained test procedures.
- [EN 301 549 v3.2.1](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) — ETSI harmonized European standard.
- [ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/) — W3C patterns for common widgets.
- [ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/) — W3C Recommendation.

### Law and regulation

- [ADA Title II Final Rule (2024)](https://www.federalregister.gov/documents/2024/04/24/2024-07758/nondiscrimination-on-the-basis-of-disability-accessibility-of-web-information-and-services-of-state) — Federal Register entry.
- [DOJ Web Rule Resources](https://www.ada.gov/resources/2024-03-08-web-rule/) — plain-language summary.
- [DOJ Fact Sheet on the Web Rule](https://www.ada.gov/notices/2024/04/08/fact-sheet-web-rule/).
- [DOJ Small Entity Compliance Guide](https://www.ada.gov/resources/small-entity-compliance-guide/).
- [Section 504 of the Rehabilitation Act](https://www.hhs.gov/civil-rights/for-individuals/disability/section-504-rehabilitation-act-of-1973/index.html) — applies to recipients of federal funding, including UC.

### UC / UCSC policy

- [UC IMG-2150, Electronic Information Communication and Technology Accessibility](https://policy.ucop.edu/doc/7000611/IMT-2150) — UC systemwide accessibility policy.
- [UCSC IT Accessibility](https://its.ucsc.edu/accessibility/) — ITS program page.
- [UCSC Accessibility landing](https://accessibility.ucsc.edu/) — campus accessibility policy hub.
- [UCSC Disability Resource Center](https://drc.ucsc.edu/) — student accommodations.
- [UCSC AI Council](https://its.ucsc.edu/about/it-governance/artificial-intelligence) — the campus body reviewing AI tools.
- [UC Electronic Information Security Policy, IS-3](https://security.ucop.edu/policies/institutional-information-and-it-resource-classification.html) — security classification referenced in other politics docs.

### Evaluation tools

- [axe-core](https://github.com/dequelabs/axe-core) — the reference open-source rules engine.
- [axe DevTools](https://www.deque.com/axe/devtools/) — browser extension.
- [WAVE](https://wave.webaim.org/) — WebAIM evaluation tool.
- [Lighthouse accessibility](https://developer.chrome.com/docs/lighthouse/accessibility/) — built into Chrome DevTools.
- [pa11y](https://github.com/pa11y/pa11y) — CLI runner.
- [pa11y-ci](https://github.com/pa11y/pa11y-ci) — CI runner.
- [Accessibility Insights for Web](https://accessibilityinsights.io/docs/web/overview/) — Microsoft tool with structured manual tests.
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/).
- [WebAIM Screen Reader User Survey #10](https://webaim.org/projects/screenreadersurvey10/).
- [NVDA](https://www.nvaccess.org/) — free Windows screen reader.
- [Apple VoiceOver](https://www.apple.com/accessibility/vision/).
- [JAWS](https://www.freedomscientific.com/products/software/jaws/).
- [Orca](https://help.gnome.org/users/orca/stable/) — Linux screen reader.

### Upstream projects

- [Open WebUI](https://openwebui.com/) — BayLeaf Chat's UI (see [§ 5.1](#51-bayleaf-chat-chatbayleafdev)).
  - [Repository](https://github.com/open-webui/open-webui).
  - [Documentation](https://docs.openwebui.com/).
  - [Issues labeled accessibility](https://github.com/open-webui/open-webui/issues?q=is%3Aissue+label%3Aaccessibility).
  - [Full-text search: a11y](https://github.com/open-webui/open-webui/issues?q=a11y).
  - [Full-text search: accessibility](https://github.com/open-webui/open-webui/issues?q=accessibility).
- [Hono](https://hono.dev/) — framework for BayLeaf API.
- [Hono JSX](https://hono.dev/docs/guides/jsx).
- [Svelte](https://svelte.dev/) and [SvelteKit](https://kit.svelte.dev/) — Open WebUI's frontend stack.

### Platform ACRs (courtesy disclosures for outbound links)

- [GitHub Accessibility](https://accessibility.github.com/) — ACRs for github.com and related products.
- [Cloudflare Accessibility Statement](https://www.cloudflare.com/trust-hub/accessibility/) — platform hosting BayLeaf API.
- [DigitalOcean Accessibility](https://www.digitalocean.com/legal/accessibility) — platform hosting BayLeaf Chat.

### Related BayLeaf documents

- [HECVAT.md](HECVAT.md) — security questionnaire with framing memo.
- [FERPA.md](FERPA.md) — student-privacy analysis and draft designation memo.
- [SECURITY.md](SECURITY.md) — platform data handling.
- [DEPENDENCIES.md](DEPENDENCIES.md) — dependency audit.
- [ACCOUNTS.md](ACCOUNTS.md) — account / credential handover plan.
- [../SECURITY.md](../SECURITY.md) — repo-root vulnerability-reporting policy.
- [../chat/DESIGN.md](../chat/DESIGN.md) — BayLeaf Chat architecture.
- [POSITION.md](POSITION.md) — pedagogical position on institutional AI.
