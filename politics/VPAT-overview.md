# VPAT and BayLeaf: Overview

**Service:** BayLeaf AI Playground  
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz  
**Status:** Working draft. Not a signed ACR. Per-surface ACRs are published as sibling documents; see [§ 4](#4-per-surface-acrs).  
**Template:** [VPAT® 2.5 INT](https://www.itic.org/policy/accessibility/vpat), covering [WCAG 2.1](https://www.w3.org/TR/WCAG21/) Level A and AA, [Revised Section 508](https://www.access-board.gov/ict/), and [EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/).

This document is the framing, scope, inheritance map, and evaluation scaffold for BayLeaf's working-draft Accessibility Conformance Report (ACR). It uses the [VPAT 2.5 INT template](https://www.itic.org/policy/accessibility/vpat) published by the [Information Technology Industry Council (ITI)](https://www.itic.org/), which covers [WCAG 2.1](https://www.w3.org/TR/WCAG21/) Level A and AA, the [Revised Section 508 standards](https://www.access-board.gov/ict/), and [EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/) in a single report.

It is a sibling to [HECVAT.md](HECVAT.md) (security), [FERPA.md](FERPA.md) (student privacy), and [SECURITY.md](SECURITY.md) (platform data handling). Like those documents, it is written in the form the institution expects while being honest about the places the template does not fit a faculty-operated service. Like FERPA.md, it is structured so that future evaluation passes are lookups against the references collected here, not rediscovery from scratch.

Because BayLeaf composes surfaces from multiple sources (see [§ 2](#2-framing-memo-for-the-reviewer)), the per-surface ACR content lives in three sibling documents:

- [VPAT-chat.md](VPAT-chat.md): [`chat.bayleaf.dev`](https://chat.bayleaf.dev), Open WebUI deployment.
- [VPAT-api.md](VPAT-api.md): [`api.bayleaf.dev`](https://api.bayleaf.dev), BayLeaf-authored Hono/JSX templates (public landing and authenticated dashboard).
- [VPAT-pages.md](VPAT-pages.md): the four static pages on [`bayleaf.dev`](https://bayleaf.dev) (landing, [support](https://bayleaf.dev/support.html), [privacy](https://bayleaf.dev/privacy.html), [use cases](https://bayleaf.dev/use-cases.html)) sharing one stylesheet at [`docs/style.css`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/style.css).

This overview document holds everything common across those surfaces: the template explainer, framing memo, policy drivers, evaluation methodology, open questions for campus stakeholders, future work, and references. See [§ 4](#4-per-surface-acrs) for the surface inventory and [§ 5](#5-evaluation-methodology-for-future-passes) for methodology.

---
## 1. What a VPAT is, and why this one looks different

A **VPAT (Voluntary Product Accessibility Template)** is a standardized
reporting form maintained by ITI. A filled-in VPAT is called an
**Accessibility Conformance Report (ACR)**. The terms are often used
interchangeably. The current version is
[VPAT 2.5](https://www.itic.org/policy/accessibility/vpat), published in
four editions:

- **[WCAG 2.x Edition](https://www.itic.org/dotAsset/1c95f5c1-4c8a-4fa1-90a1-67a7f0d45de4.doc):** web content only.
- **[Revised Section 508 Edition](https://www.itic.org/dotAsset/ba601692-c81d-4f83-84a4-c9d83c3bd3fa.doc):** US federal procurement.
- **[EU EN 301 549 Edition](https://www.itic.org/dotAsset/9f02f58e-a0e3-42f5-8cea-80b0e0b6f83a.doc):** European procurement.
- **[INT (International) Edition](https://www.itic.org/dotAsset/dc611114-0d38-474b-bd72-f606832c2407.doc):** all three combined; the common choice for US higher-ed vendors.

For each success criterion, the reporter selects one conformance level:

- **Supports:** the functionality has been evaluated and meets the criterion without known defects.
- **Partially Supports:** some functionality does not meet the criterion.
- **Does Not Support:** the majority of functionality does not meet the criterion.
- **Not Applicable:** the criterion is not relevant to the product.
- **Not Evaluated:** permitted only for WCAG 2.x Level AAA criteria in the standard template; extended here by honest disclosure to other criteria the evaluation has not yet reached.

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
*Remarks* fields throughout this document explain the honest substitute:
typically either (a) the accessibility posture of the upstream
project (Open WebUI) whose conformance BayLeaf inherits, or (b) direct
source-level evaluation of the small BayLeaf-authored surfaces.

The external driver is real. The 2024
[ADA Title II final rule](https://www.federalregister.gov/documents/2024/04/24/2024-07758/nondiscrimination-on-the-basis-of-disability-accessibility-of-web-information-and-services-of-state)
obligates state and local government entities (including UC) to make
web content and mobile apps conform to WCAG 2.1 Level AA. The
compliance deadline is
[April 24, 2026](https://www.ada.gov/resources/2024-03-08-web-rule/)
for public entities with populations ≥ 50,000 (UCSC is covered). The
[Department of Justice fact sheet](https://www.ada.gov/notices/2024/04/08/fact-sheet-web-rule/)
summarizes what the rule requires. Any tool UCSC directs students,
faculty, or staff toward falls within UCSC's Title II obligations;
BayLeaf's VPAT exists so that posture is defensible.

**Supporting documents (in-repo):**

- [HECVAT.md](HECVAT.md): security questionnaire with framing memo.
- [FERPA.md](FERPA.md): student-privacy analysis and draft designation memo.
- [SECURITY.md](SECURITY.md): platform data-handling exhibit.
- [../chat/DESIGN.md](../chat/DESIGN.md): full BayLeaf Chat architecture.
- [DEPENDENCIES.md](DEPENDENCIES.md): dependency audit (the upstream inheritance map for code; this VPAT is the accessibility analogue).

---

## 3. Why accessibility matters for a faculty-operated service

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

## 4. Per-surface ACRs

BayLeaf operates three assessed web surfaces. The accessibility posture of each is assessed in its own document because the surfaces have different UI origins, different owners of conformance, and different evaluation states. Two BayLeaf-authored pages and one third-party widget on those same hosts fall outside the three ACRs; they are named explicitly in [Out of scope](#4-per-surface-acrs) below rather than left implicit.

| Surface | URL | UI origin | Owns accessibility | Evaluation status | ACR |
|---|---|---|---|---|---|
| BayLeaf Chat | [chat.bayleaf.dev](https://chat.bayleaf.dev) | [Open WebUI](https://openwebui.com/) (OSS, upstream) | Shared: upstream owns the UI; BayLeaf owns deployment, theme config, and model output shaping | Not Evaluated; blocked on upstream ACR question | [VPAT-chat.md](VPAT-chat.md) |
| BayLeaf API | [api.bayleaf.dev](https://api.bayleaf.dev) | BayLeaf [Hono/JSX](https://hono.dev/) templates (public landing + authenticated dashboard) | BayLeaf | **Evaluated empirically via headless Chromium** (both views) | [VPAT-api.md](VPAT-api.md) |
| bayleaf.dev pages | [bayleaf.dev](https://bayleaf.dev), [bayleaf.dev/support.html](https://bayleaf.dev/support.html), [bayleaf.dev/privacy.html](https://bayleaf.dev/privacy.html), [bayleaf.dev/use-cases.html](https://bayleaf.dev/use-cases.html) | Static HTML ([`docs/index.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/index.html), [`docs/support.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/support.html), [`docs/privacy.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/privacy.html), [`docs/use-cases.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/use-cases.html)) sharing [`docs/style.css`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/style.css) | BayLeaf | **Evaluated empirically via headless Chromium**; one open Level A defect (no text alternative or audio description for the embedded lecture series; captions verified present) | [VPAT-pages.md](VPAT-pages.md) |

Each per-surface document carries its own header (with the service's current status line), a surface description, a full WCAG 2.1 A/AA conformance table targeting that surface, and (where applicable) surface-specific considerations. The Section 508 Chapter 3/5/6 and EN 301 549 Chapter 4-13 tables appear in each per-surface ACR because they apply to the service as a whole; the entries are identical across documents and are maintained by hand rather than generated.

**Out of scope (for all surfaces):**

- Any static pages added to [`docs/`](https://github.com/bayleaf-ucsc/bayleaf/tree/main/docs) beyond the four covered by [VPAT-pages.md](VPAT-pages.md). New pages are folded into that ACR at the time they ship. This has slipped once: `privacy.html` and `use-cases.html` shipped and ran unaudited until the 2026-07-24 pass brought them in. Treat "a new page in `docs/`" as a trigger for an ACR update, not an optional follow-up.
- **[`api.bayleaf.dev/docs`](https://api.bayleaf.dev/docs)**, the interactive API reference. BayLeaf authors only the HTML shell (`<html lang="en">`, title, viewport); the rendered UI is the [Scalar](https://scalar.com/) API reference viewer loaded from a CDN, a third-party component with its own visual language and its own conformance responsibility. BayLeaf's OpenAPI *content* (endpoint summaries, descriptions) is BayLeaf's; the widget rendering it is not. Not covered by [VPAT-api.md](VPAT-api.md), whose scope is the landing and the dashboard.
- **[`api.bayleaf.dev/auth/claim`](https://api.bayleaf.dev/auth/claim)**, the one-shot terminal-authorization approval page. BayLeaf-authored, deliberately built with inline styles outside the shared `BaseLayout`, and therefore not covered by the empirical pass behind [VPAT-api.md](VPAT-api.md). It is a genuine gap rather than a third-party exclusion, and should be folded into that ACR.
- **[`lti.bayleaf.dev`](https://lti.bayleaf.dev)**, the LTI 1.1/1.3 connector spike. Publicly reachable but not an advertised user surface: it renders unstyled debug pages, is linked from nothing, and is not offered to the campus community. Not evaluated. If the connector becomes a supported service, it needs its own ACR before launch.
- [GitHub Pages](https://pages.github.com/) as a platform. The platform itself is GitHub's, not BayLeaf's; GitHub publishes its own [Accessibility Conformance Reports](https://accessibility.github.com/) covering its products. BayLeaf links to github.com-hosted source, issues, and policy documents from within its UIs; those outbound destinations are covered by GitHub's own ACRs as a **courtesy disclosure**, not a claim that GitHub's ACRs cover BayLeaf-authored content.
- The [BayLeaf API's JSON endpoints](https://api.bayleaf.dev/v1). A JSON-over-HTTP API surface is not a UI and is not directly subject to WCAG. API *documentation*, where it exists as a rendered page, is in scope through [VPAT-api.md](VPAT-api.md).
- BayLeaf's [GitHub repository](https://github.com/bayleaf-ucsc/bayleaf) as a browsing surface. Covered by [GitHub's product ACRs](https://accessibility.github.com/).

**Surface-like but treated separately: AI-generated output.** Model output rendered inside BayLeaf Chat (streamed markdown, code blocks, tables, generated images) is not a traditional UI surface but is subject to user-facing accessibility concerns. It is handled in [VPAT-chat.md § AI-generated output](VPAT-chat.md#ai-generated-output-as-an-accessibility-surface) because no off-the-shelf VPAT template currently covers it well, and because its mitigations are Chat-specific (system-prompt conventions, live-region behavior in the Open WebUI frontend).

---

## 5. Evaluation methodology (for future passes)

A real evaluation pass combines automated tooling (cheap, repeatable,
catches a minority of real issues) with manual testing (expensive, not
automatable, catches the rest). [Deque](https://www.deque.com/) has
published that automated tools with `axe-core` catch roughly
[57% of accessibility issues](https://www.deque.com/blog/automated-testing-obligations-of-the-ada/)
on average; older estimates commonly cited are closer to 30%. The
remainder requires keyboard and screen-reader evaluation.

**Automated tooling** to run against each live surface:

- **[axe DevTools](https://www.deque.com/axe/devtools/)** (browser
  extension, free tier): the industry baseline. Runs `axe-core`
  which is also available as a [CLI](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/cli)
  and [CI-friendly library](https://github.com/dequelabs/axe-core).
- **[Lighthouse](https://developer.chrome.com/docs/lighthouse/accessibility/)**
  (built into Chrome DevTools): runs a subset of `axe-core` rules;
  useful as a second opinion and for performance/SEO at the same time.
- **[WAVE](https://wave.webaim.org/)** (WebAIM): a different ruleset
  from axe, good at catching things axe misses (and vice versa).
  Available as a [browser extension](https://wave.webaim.org/extension/).
- **[pa11y](https://github.com/pa11y/pa11y):** command-line tool,
  suitable for CI. Uses HTML_CodeSniffer or axe as its engine.
- **[Accessibility Insights for Web](https://accessibilityinsights.io/docs/web/overview/)**
  (Microsoft): adds structured manual tests (the "Assessment" mode)
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

**AI-output scenarios specific to Chat**, from [VPAT-chat.md § AI-generated output](VPAT-chat.md#ai-generated-output-as-an-accessibility-surface):

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
ACR reader) will look for when asking whether the claims in [the per-surface ACRs](#4-per-surface-acrs)
are current.

See [§ 7](#7-future-work) for notes on packaging this as repeatable
tooling.

---

## 6. Open questions for the AI Council and accessibility stakeholders

These are the questions this analysis cannot resolve on its own,
parallel to [FERPA.md § 10](FERPA.md#10-open-questions-for-the-ai-council).
They are best addressed jointly by the
[UCSC IT Accessibility](https://its.ucsc.edu/accessibility/) program,
the [UCSC AI Council](https://its.ucsc.edu/about/it-governance/artificial-intelligence),
the [Disability Resource Center](https://drc.ucsc.edu/), and (for
Title II interpretation) [Campus Counsel](https://campuscounsel.ucsc.edu/).

1. **Does Open WebUI publish an ACR?** This is the top blocker for
   Chat's evaluation status. Search leads are enumerated in
   [VPAT-chat.md](VPAT-chat.md). If no upstream ACR
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
   reviews?** [VPAT-chat.md § AI-generated output](VPAT-chat.md#ai-generated-output-as-an-accessibility-surface)
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
   conventions sketched in [VPAT-chat.md § AI-generated output](VPAT-chat.md#ai-generated-output-as-an-accessibility-surface)?
   This is a pedagogical choice as much as an accessibility one and
   deserves Council input.

7. **Precedent.** If BayLeaf's VPAT process establishes a pattern,
   what does that pattern look like for the next faculty-operated
   service the campus considers? Is there a reusable template, a
   standing reviewer role, a lightweight CI harness the campus would
   want to see adopted?

---

## 7. Future work

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

- [`@axe-core/cli`](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/cli): headless axe runs from the command line.
- [`pa11y`](https://github.com/pa11y/pa11y) and [`pa11y-ci`](https://github.com/pa11y/pa11y-ci): CI-oriented runner.
- [`lighthouse-ci`](https://github.com/GoogleChrome/lighthouse-ci): if the project also wants performance/SEO reporting in the same harness.
- [`playwright`](https://playwright.dev/docs/accessibility-testing) with [`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright): for authenticated surfaces like the dashboard.

**What automation cannot do.** Automated scans do not substitute for
manual screen-reader and keyboard passes; per [§ 5](#5-evaluation-methodology-for-future-passes)
they catch at best around half of real issues. The harness's value is
(a) regression detection (surfacing newly-introduced violations on
every commit), and (b) producing durable evidence a reviewer can point
to. The honest accessibility story still depends on periodic manual
passes.

**Upstream contribution.** If the Open WebUI evaluation surfaces
specific defects ([VPAT-chat.md](VPAT-chat.md)), the
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

## 8. References

### VPAT template and guidance

- [ITI VPAT 2.5](https://www.itic.org/policy/accessibility/vpat): current template and editions.
- [ITI Accessibility Resources](https://www.itic.org/policy/accessibility/accessibility-resources): guidance on completing a VPAT.
- [VPAT 2.5 INT (International) Edition](https://www.itic.org/dotAsset/dc611114-0d38-474b-bd72-f606832c2407.doc): the edition this document follows.
- [VPAT 2.5 WCAG Edition](https://www.itic.org/dotAsset/1c95f5c1-4c8a-4fa1-90a1-67a7f0d45de4.doc).
- [VPAT 2.5 Section 508 Edition](https://www.itic.org/dotAsset/ba601692-c81d-4f83-84a4-c9d83c3bd3fa.doc).
- [VPAT 2.5 EN 301 549 Edition](https://www.itic.org/dotAsset/9f02f58e-a0e3-42f5-8cea-80b0e0b6f83a.doc).

### Standards

- [WCAG 2.1](https://www.w3.org/TR/WCAG21/): W3C Recommendation, the success-criterion set this document targets.
- [WCAG 2.1 Understanding](https://www.w3.org/WAI/WCAG21/Understanding/): normative explanations per criterion (linked row-by-row in [the per-surface ACRs](#4-per-surface-acrs)).
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): next version; noted for context, not targeted by this ACR.
- [Revised Section 508 Standards](https://www.access-board.gov/ict/): US Access Board.
- [Section 508 ICT Testing Baseline](https://section508coordinators.github.io/ICTTestingBaseline/): community-maintained test procedures.
- [EN 301 549 v3.2.1](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf): ETSI harmonized European standard.
- [ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/): W3C patterns for common widgets.
- [ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/): W3C Recommendation.

### Law and regulation

- [ADA Title II Final Rule (2024)](https://www.federalregister.gov/documents/2024/04/24/2024-07758/nondiscrimination-on-the-basis-of-disability-accessibility-of-web-information-and-services-of-state): Federal Register entry.
- [DOJ Web Rule Resources](https://www.ada.gov/resources/2024-03-08-web-rule/): plain-language summary.
- [DOJ Fact Sheet on the Web Rule](https://www.ada.gov/notices/2024/04/08/fact-sheet-web-rule/).
- [DOJ Small Entity Compliance Guide](https://www.ada.gov/resources/small-entity-compliance-guide/).
- [Section 504 of the Rehabilitation Act](https://www.hhs.gov/civil-rights/for-individuals/disability/section-504-rehabilitation-act-of-1973/index.html): applies to recipients of federal funding, including UC.

### UC / UCSC policy

- [UC IMG-2150, Electronic Information Communication and Technology Accessibility](https://policy.ucop.edu/doc/7000611/IMT-2150): UC systemwide accessibility policy.
- [UCSC IT Accessibility](https://its.ucsc.edu/accessibility/): ITS program page.
- [UCSC Accessibility landing](https://accessibility.ucsc.edu/): campus accessibility policy hub.
- [UCSC Disability Resource Center](https://drc.ucsc.edu/): student accommodations.
- [UCSC AI Council](https://its.ucsc.edu/about/it-governance/artificial-intelligence): the campus body reviewing AI tools.
- [UC Electronic Information Security Policy, IS-3](https://security.ucop.edu/policies/institutional-information-and-it-resource-classification.html): security classification referenced in other politics docs.

### Evaluation tools

- [axe-core](https://github.com/dequelabs/axe-core): the reference open-source rules engine.
- [axe DevTools](https://www.deque.com/axe/devtools/): browser extension.
- [WAVE](https://wave.webaim.org/): WebAIM evaluation tool.
- [Lighthouse accessibility](https://developer.chrome.com/docs/lighthouse/accessibility/): built into Chrome DevTools.
- [pa11y](https://github.com/pa11y/pa11y): CLI runner.
- [pa11y-ci](https://github.com/pa11y/pa11y-ci): CI runner.
- [Accessibility Insights for Web](https://accessibilityinsights.io/docs/web/overview/): Microsoft tool with structured manual tests.
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/).
- [WebAIM Screen Reader User Survey #10](https://webaim.org/projects/screenreadersurvey10/).
- [NVDA](https://www.nvaccess.org/): free Windows screen reader.
- [Apple VoiceOver](https://www.apple.com/accessibility/vision/).
- [JAWS](https://www.freedomscientific.com/products/software/jaws/).
- [Orca](https://help.gnome.org/users/orca/stable/): Linux screen reader.

### Upstream projects

- [Open WebUI](https://openwebui.com/): BayLeaf Chat's UI (see [VPAT-chat.md](VPAT-chat.md)).
  - [Repository](https://github.com/open-webui/open-webui).
  - [Documentation](https://docs.openwebui.com/).
  - [Issues labeled accessibility](https://github.com/open-webui/open-webui/issues?q=is%3Aissue+label%3Aaccessibility).
  - [Full-text search: a11y](https://github.com/open-webui/open-webui/issues?q=a11y).
  - [Full-text search: accessibility](https://github.com/open-webui/open-webui/issues?q=accessibility).
- [Hono](https://hono.dev/): framework for BayLeaf API.
- [Hono JSX](https://hono.dev/docs/guides/jsx).
- [Svelte](https://svelte.dev/) and [SvelteKit](https://kit.svelte.dev/): Open WebUI's frontend stack.

### Platform ACRs (courtesy disclosures for outbound links)

- [GitHub Accessibility](https://accessibility.github.com/): ACRs for github.com and related products.
- [Cloudflare Accessibility Statement](https://www.cloudflare.com/trust-hub/accessibility/): platform hosting BayLeaf API.
- [DigitalOcean Accessibility](https://www.digitalocean.com/legal/accessibility): platform hosting BayLeaf Chat.

### Related BayLeaf documents

- [HECVAT.md](HECVAT.md): security questionnaire with framing memo.
- [FERPA.md](FERPA.md): student-privacy analysis and draft designation memo.
- [SECURITY.md](SECURITY.md): platform data handling.
- [DEPENDENCIES.md](DEPENDENCIES.md): dependency audit.
- [ACCOUNTS.md](ACCOUNTS.md): account / credential handover plan.
- [../SECURITY.md](../SECURITY.md): repo-root vulnerability-reporting policy.
- [../chat/DESIGN.md](../chat/DESIGN.md): BayLeaf Chat architecture.
- [POSITION.md](POSITION.md): pedagogical position on institutional AI.
