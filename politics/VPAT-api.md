# VPAT and BayLeaf API

**Service:** BayLeaf API ([`api.bayleaf.dev`](https://api.bayleaf.dev)),
covering both the public landing at [api.bayleaf.dev](https://api.bayleaf.dev)
and the authenticated dashboard at [api.bayleaf.dev/dashboard](https://api.bayleaf.dev/dashboard).
Both surfaces share a single hono/jsx component stack served as a
Cloudflare Worker.  
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz  
**Status:** Working draft, upgraded to empirical verification for
contrast, reflow, focus visibility, text zoom, text spacing, HTML
parsing, heading hierarchy, keyboard traversal, and color-vision-deficiency
simulation, using headless Chromium via direct
[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
All previously flagged defects have been fixed and re-verified:
[4.1.1 Parsing](#3-wcag-21-level-a-conformance) now emits `<!DOCTYPE html>`
on every rendered page, [1.4.11 Non-text Contrast](#4-wcag-21-level-aa-conformance)
passes on every card border, [1.4.3 Contrast](#4-wcag-21-level-aa-conformance)
passes AA on every text/background pair, [2.4.7 Focus Visible](#4-wcag-21-level-aa-conformance)
has an explicit double-ring indicator, [2.1.1 Keyboard](#3-wcag-21-level-a-conformance)
no longer has a div-as-button, and [1.3.1 Info and Relationships](#3-wcag-21-level-a-conformance)
now has a clean H1 → H2 hierarchy on the dashboard.  
**Template:** [VPAT® 2.5 INT](https://www.itic.org/policy/accessibility/vpat), covering [WCAG 2.1](https://www.w3.org/TR/WCAG21/) Level A and AA, [Revised Section 508](https://www.access-board.gov/ict/), and [EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/).

> This is a per-surface ACR. Framing, inheritance map, evaluation methodology, open questions, and references live in [VPAT-overview.md](VPAT-overview.md). Read that document first for the posture; read this one for surface-specific findings and the conformance table.

---

## 1. Surface description

**UI origin.** BayLeaf-authored JSX rendered server-side by [Hono](https://hono.dev/)
on Cloudflare Workers, with styling via [hono/css](https://hono.dev/docs/helpers/css).
The `api.bayleaf.dev` domain hosts two views that share the same template stack:

- **Public landing** at [`api.bayleaf.dev`](https://api.bayleaf.dev):
  a heading, a paragraph of copy, a "sign in" link styled as a button, and a
  conditional card announcing whether the visitor is on-campus (eligible for
  keyless access). No forms, no interactive widgets beyond the link-styled button.
- **Authenticated dashboard** at [`api.bayleaf.dev/dashboard`](https://api.bayleaf.dev/dashboard):
  reachable only after OIDC sign-in (CILogon via UCSC CruzID). Displays the user's
  API key (masked, as `<input type="password">`), sandbox status with resource
  counters, tool-integration instructions (LLM inference, code sandbox, web
  search, Google Workspace CLI, Canvas LMS), and copy-to-clipboard controls.
  This is the richest BayLeaf-owned surface in terms of interactive elements.

When an unauthenticated visitor requests `/dashboard`, the same route handler
renders the landing page, so the two views are interleaved in the source rather
than living in separate code paths.

**Source files (small, directly inspectable).**

- [`api/src/templates/layout.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/templates/layout.tsx):
  shared `BaseLayout`, button and card styles, `CodingAgentCard`, `ErrorPage`,
  and the `renderPage` helper that prepends `<!DOCTYPE html>` to every response.
- [`api/src/templates/landing.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/templates/landing.tsx):
  the public landing page.
- [`api/src/templates/dashboard.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/templates/dashboard.tsx):
  the authenticated dashboard, broken into `KeyCard`, `LlmCard`, `SandboxCard`,
  `WebCard`, `GwsCard`, `CanvasCard`, and the inline `DashboardScripts` block.
- [`api/src/routes/dashboard.tsx`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/api/src/routes/dashboard.tsx):
  route handler with the auth gate and key-provisioning flow.

**Why both surfaces are tractable for direct evaluation.** The rendered DOM
is produced from a few hundred lines of JSX with inline styles and one shared
stylesheet block. Source inspection covers structure and ARIA at reading
speed; a live audit under headless Chromium covers the rendered-only criteria
(actual contrast ratios, focus visibility, reflow, text spacing, text zoom).
Both surfaces were evaluated in the same pass.

### Evaluation methodology

All empirical claims in this ACR are reproducible. The landing and dashboard
were both evaluated against the local working tree served from
`wrangler dev` on `http://localhost:8787`, and the dashboard was additionally
evaluated against production ([api.bayleaf.dev](https://api.bayleaf.dev))
using a real OIDC-minted session cookie. Verification ran under headless
Chromium 147 controlled via direct CDP WebSocket calls. Date of evaluation:
2026-04-29.

- **Contrast ratios** computed from the DOM's effective foreground and
  background colors (walking up the DOM to find the first non-transparent
  ancestor background), using the WCAG 2.1
  [relative-luminance formula](https://www.w3.org/TR/WCAG21/#dfn-relative-luminance).
- **Reflow** tested at 320 and 1280 CSS px viewport widths via
  [`Emulation.setDeviceMetricsOverride`](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride);
  overflow detected by comparing `document.documentElement.scrollWidth` to
  `window.innerWidth`.
- **Text zoom** simulated at 200% via
  `document.documentElement.style.fontSize = "200%"`; overflow re-measured.
- **Text spacing** tested by injecting a `<style>` element setting the WCAG
  1.4.12 user-override thresholds (`line-height: 1.5`, `letter-spacing: 0.12em`,
  `word-spacing: 0.16em`, paragraph margin 2em) as `!important` rules;
  overflow re-measured.
- **Focus visibility** verified by dispatching real `Tab` key events via
  [`Input.dispatchKeyEvent`](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent)
  and inspecting computed `outline*` and `boxShadow` styles plus the
  `:focus-visible` pseudo-class match on the active element. Programmatic
  `.focus()` alone does not trigger `:focus-visible` per spec (keyboard-initiated
  heuristic), so real key-event simulation was required.
- **Keyboard reachability and traversal** enumerated by walking the full
  tab order one `Tab` press at a time and logging the active element after
  each press.
- **HTML validity** checked via the
  [W3C Nu HTML Checker](https://validator.w3.org/nu/) public API
  (`POST https://validator.w3.org/nu/?out=json`). Note: Nu's CSS parser does
  not yet support the CSS Nesting specification; a single "CSS: Parse Error"
  is emitted for hono/css's `&:hover` nested rule on both pages. CSS parse
  errors fall outside WCAG 4.1.1 (which concerns HTML markup parsing); the
  nested syntax is valid in all browsers (Chrome 120+, Safari 16.5+,
  Firefox 117+) and renders correctly in production.
- **Color-vision-deficiency simulation** applied by injecting SVG
  `feColorMatrix` filters with
  [Machado, Oliveira, and Fernandes (2009)](https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html)
  severity-1.0 matrices for protanopia, deuteranopia, tritanopia, and
  achromatopsia; screenshots evaluated by a vision-capable subagent for
  information-loss judgment.

### Things the pass cannot cover (deferred)

- Screen-reader traversal of the dashboard's key-management flow and the
  `aria-live` announcement on successful key creation in NVDA, JAWS, and
  VoiceOver. Chromium's accessibility tree exposes the correct structure
  but AT behavior under streamed DOM mutations wants a human pass.
- A human keyboard-only operator pass confirming the full key-create,
  copy, revoke, delete-sandbox flow with keyboard only, including the
  `alert()` and `confirm()` dialogs in the key-provisioning JS.
- Browser-level font-smoothing variation in perceived contrast across
  operating systems (macOS subpixel AA vs. Windows ClearType vs. Linux).

### Structure observed

Both surfaces use valid HTML5 with `<html lang="en">` and now emit
`<!DOCTYPE html>` via a shared `renderPage` helper introduced during this
pass. The `<head>` carries `<meta charset>` and `<meta viewport>`, and the
rendered body uses `<header>`, `<nav aria-label="Documentation">`, `<main>`,
and `<footer>` landmarks.

**Landing.** One `<h1>` ("BayLeaf API"), one `<h2>` ("API Access for UCSC"),
and one conditional `<h3>` ("Campus Pass Available" or "On Campus?") nested
inside a card. One `<pre><code>` block when the Campus Pass card renders.
No forms, no scripted interactivity.

**Dashboard.** One `<h1>` ("BayLeaf API"), then a greeting paragraph, then a
stack of `<h2>`-headed cards: "Your API Key" (or "Get Your API Key"),
"LLM Inference" (with inline `<details>/<summary>` for a curl example),
"Code Sandbox" (with inline details), "Web Search & Fetch" (with inline
details), "Use the BayLeaf API in a coding agent", "Google Workspace CLI"
(with inline details), and "Canvas LMS" (with inline details). Interactive
elements: one `<input type="password" aria-label="...">` displaying the
masked API key, three `<button type="button">` controls (Copy, Show,
Revoke Key), a `<button type="button">` wrapping the copy-to-clipboard
endpoint target, and a `<button type="button">` Delete Sandbox when a
sandbox exists. Five `<details>` disclosures. No forms with `<form>`; the
three-button key flow uses inline `onclick` handlers that call `fetch()`
against `/key`.

### Structural observations that inform [the conformance tables below](#3-wcag-21-level-a-conformance)

- [1.3.1 Info and Relationships](https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships):
  headings are in hierarchical order on both surfaces. Landing: h1 → h2 → h3.
  Dashboard: h1 → h2 (no h3 after the fix documented below). Lists use `<ul>`;
  the endpoint copy target uses a native `<button>` (previously a
  `<div onclick>`, which was replaced during this pass, see [2.1.1
  below](#3-wcag-21-level-a-conformance)). The masked-key input carries
  `aria-label="Your BayLeaf API key (hidden)"` so it has a programmatic name.
- [1.4.1 Use of Color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color):
  on the dashboard, five cards use accent border colors (purple, orange, green,
  blue, gray) as visual differentiation. Empirically verified under
  [Machado et al. 2009](https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html)
  simulations for protanopia, deuteranopia, tritanopia, and achromatopsia:
  each card is still identifiable by its distinct `<h2>` heading and content.
  Sandbox state ("Started", "Stopped", "Archived", "Error", "None") is
  indicated by both a color-coded state word and the word itself; a
  colorblind user reads the word.
- [2.4.1 Bypass Blocks](https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks):
  both pages wrap primary content in `<main>` and the post-content block
  in `<footer>`, with the header links additionally nested in
  `<nav aria-label="Documentation">`. Four landmarks available to AT.
- [2.4.4 Link Purpose (In Context)](https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context):
  link text is descriptive on both surfaces (e.g., "Sign in with UCSC",
  "BayLeaf AI Playground", "Source on GitHub", "Sign out"). The
  dashboard's two appearances of `https://api.bayleaf.dev/docs/SKILL.md`
  as visible link text is acceptable: visible URL as link text is a
  recognized pattern and the URL itself describes the destination.
- [3.1.1 Language of Page](https://www.w3.org/WAI/WCAG21/Understanding/language-of-page):
  `lang="en"` set on `<html>` on both surfaces.
- [1.4.3 Contrast Minimum](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum):
  all rendered text/background pairs measured empirically. Results on the
  landing: `#333` on `#fafafa` (12.10:1), `#003c6c` on `#fafafa` (10.80:1
  for h1 large-text), white on `#003c6c` (11.27:1, the sign-in button),
  `#006aad` on `#fafafa` (5.49:1, links), `#555` on `#fafafa` (7.46:1,
  footer text). Results on the dashboard: same body/h1/h2/footer/link
  ratios, plus `#555` on white (7.46:1, card-internal sub-text and
  sandbox stats), `#003c6c` on white (11.27:1 for stat values, large
  bold 24px), `#c41e3a` on white (5.84:1 for Error state, large), and
  `#7a5a00` on white (6.38:1 for Stopped state, large). Lowest rendered
  text ratio on either surface is 5.49:1 (`#006aad` inline links),
  above the 4.5:1 AA threshold.
- [1.4.4 Resize Text](https://www.w3.org/WAI/WCAG21/Understanding/resize-text):
  simulated at 200% root font size on both surfaces; document scroll width
  remained within the viewport and no element clipped.
- [1.4.12 Text Spacing](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing):
  injected the WCAG user-override thresholds as `!important` rules on both
  surfaces; layout adapted without horizontal overflow or clipping.
- [2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible):
  an explicit `a:focus-visible, button:focus-visible, summary:focus-visible,
  input:focus-visible { outline: 3px solid #fff; box-shadow: 0 0 0 5px #2a5298; }`
  rule in the shared stylesheet renders a white inner ring with a blue outer
  ring. Verified against real `Tab` key events on every focusable element
  (including the navy-backed primary buttons and the red-backed danger
  buttons), where the double-ring is clearly visible. Chromium's
  platform-default 1px blue outline is near-invisible against the same
  button backgrounds and was insufficient prior to this pass.
- [4.1.1 Parsing](https://www.w3.org/WAI/WCAG21/Understanding/parsing):
  both pages emit `<!DOCTYPE html>` via the `renderPage` helper and
  validate with zero HTML errors from the W3C Nu HTML Checker. The only
  emitted Nu messages are two "trailing slash on void elements" advisories
  (informational, not errors) and one "CSS: Parse Error" false positive on
  hono/css's `&:hover` nested-rule syntax, which is valid CSS Nesting spec
  and renders correctly in all target browsers. ID-uniqueness verified via
  DOM enumeration on both pages.
- [4.1.2 Name, Role, Value](https://www.w3.org/WAI/WCAG21/Understanding/name-role-value):
  uses native elements (`<a>`, `<button type="button">`, `<input>`, `<details>`,
  `<summary>`, `<main>`, `<nav>`, `<footer>`) with correct default roles. All
  three dashboard buttons carry explicit `type="button"` (not the default
  `type="submit"`, which was a hygiene defect prior to this pass). The
  masked API-key input carries `aria-label`. The new-key success banner
  carries `role="status" aria-live="polite"` so that screen readers
  announce the "Your new API key is ready" message.

---

## 2. Out-of-scope neighbors and platform ACRs

The BayLeaf API authenticates via [CILogon](https://www.cilogon.org/)
acting as an OIDC provider federated through UCSC's Shibboleth IdP. The
CILogon redirect and UCSC password prompt are **CILogon and UCSC IAM
surfaces**, not BayLeaf surfaces. Their accessibility is the
responsibility of CILogon and UCSC ITS respectively.

The BayLeaf API proxies inference requests to
[OpenRouter](https://openrouter.ai/), and the `/docs` endpoint renders
the OpenAPI specification via [Scalar](https://scalar.com/). Those are
third-party web applications whose accessibility is their vendors'
responsibility. BayLeaf's conformance claim does not cover them.

This VPAT notes those destinations as a **courtesy disclosure**: a
reader following a BayLeaf outbound link into a CILogon, UCSC, or
OpenRouter page is landing on a surface covered by that vendor's own
conformance report, not by BayLeaf's.

---

## 3. WCAG 2.1 Level A conformance

The full Level A criterion set is defined by the [W3C WCAG 2.1 Recommendation](https://www.w3.org/TR/WCAG21/#conformance-reqs). Each row below links to the *Understanding* document for the criterion.

This table covers both views at `api.bayleaf.dev` (the public landing
and the authenticated dashboard) in a single column. Where the two
views differ materially, the remark calls it out by surface. Per-pair
contrast ratios, empirical verification methodology, and deferred
checks are in [§ 1](#1-surface-description).

| # | Criterion | api.bayleaf.dev | Remarks |
|---|---|---|---|
| 1.1.1 | [Non-text Content](https://www.w3.org/WAI/WCAG21/Understanding/non-text-content) | Supports | No non-text content that conveys meaning on either view; all images are absent. |
| 1.2.1 | [Audio-only and Video-only (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-only-and-video-only-prerecorded) | N/A | No prerecorded media on any BayLeaf surface. |
| 1.2.2 | [Captions (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/captions-prerecorded) | N/A | No prerecorded media. |
| 1.2.3 | [Audio Description or Media Alternative (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-description-or-media-alternative-prerecorded) | N/A | No prerecorded media. |
| 1.3.1 | [Info and Relationships](https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships) | Supports | Headings in hierarchical order (landing: h1 → h2 → h3; dashboard: h1 → h2 only, with no skipped levels). Lists marked up as `<ul>`. `<main>`, `<nav>`, `<footer>` landmarks present. Dashboard's masked API-key input has `aria-label="Your BayLeaf API key (hidden)"`. The endpoint copy-to-clipboard control is a native `<button>` (replaced from a `<div onclick>` during the 2026-04 evaluation). |
| 1.3.2 | [Meaningful Sequence](https://www.w3.org/WAI/WCAG21/Understanding/meaningful-sequence) | Supports | DOM order matches visual order on both views; no CSS-driven reordering. |
| 1.3.3 | [Sensory Characteristics](https://www.w3.org/WAI/WCAG21/Understanding/sensory-characteristics) | Supports | No instructions rely on shape, size, or location. |
| 1.4.1 | [Use of Color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color) | Supports | Color is not the sole means of conveying information. On the dashboard, sandbox state is communicated by word ("Started", "Stopped", etc.) in addition to color. Card borders use distinct accent colors but each card has a unique `<h2>` heading. Empirically verified under [Machado et al. 2009](https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html) simulations for protanopia, deuteranopia, tritanopia, and achromatopsia: no information is lost under any CVD. |
| 1.4.2 | [Audio Control](https://www.w3.org/WAI/WCAG21/Understanding/audio-control) | N/A | No auto-playing audio. |
| 2.1.1 | [Keyboard](https://www.w3.org/WAI/WCAG21/Understanding/keyboard) | Supports | All interactive elements are native `<a>`, `<button type="button">`, `<input>`, `<details>`, and `<summary>`: keyboard-operable by default. The endpoint copy target on the dashboard was previously a `<div onclick>` (not keyboard-reachable); replaced with `<button type="button">` during this pass. Full tab traversal verified by dispatching real `Tab` key events via CDP `Input.dispatchKeyEvent`. |
| 2.1.2 | [No Keyboard Trap](https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap) | Supports | No modal, no custom focus traps. The dashboard's three `<details>` disclosures do not trap focus. |
| 2.1.4 | [Character Key Shortcuts](https://www.w3.org/WAI/WCAG21/Understanding/character-key-shortcuts) | N/A | No single-key shortcuts. |
| 2.2.1 | [Timing Adjustable](https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable) | Partially Supports | The authenticated session is a 7-day JWT; on expiry the user is redirected to `/login`. No in-page warning precedes the redirect. Sessions can be extended only by re-authenticating (OIDC round-trip). For the scope of this surface, the 7-day duration is well beyond any plausible reading-and-action time. |
| 2.2.2 | [Pause, Stop, Hide](https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide) | N/A | No auto-updating, moving, blinking, or scrolling content. |
| 2.3.1 | [Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold) | Supports | No flashing content on any BayLeaf-authored surface. |
| 2.4.1 | [Bypass Blocks](https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks) | Supports | Both views wrap primary content in `<main>`, header links in `<nav aria-label="Documentation">`, and the post-content block in `<footer>`. Four landmarks exposed in Chromium's accessibility tree on each page. |
| 2.4.2 | [Page Titled](https://www.w3.org/WAI/WCAG21/Understanding/page-titled) | Supports | Landing: `<title>Welcome - BayLeaf API</title>`. Dashboard: `<title>Dashboard - BayLeaf API</title>`. Both titles are descriptive and distinct. |
| 2.4.3 | [Focus Order](https://www.w3.org/WAI/WCAG21/Understanding/focus-order) | Supports | DOM order matches reading order on both views; no `tabindex` manipulation. Verified by walking the full tab traversal one `Tab` press at a time. |
| 2.4.4 | [Link Purpose (In Context)](https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context) | Supports | Link text is descriptive on both views (e.g., "Sign in with UCSC", "API Reference", "Agent Skill", "Sign out", "BayLeaf AI Playground", "Source on GitHub", "available upon request", "BayLeaf Chat"); no "click here". The visible URL `https://api.bayleaf.dev/docs/SKILL.md` used as link text on the dashboard is acceptable: the URL itself describes the destination. |
| 2.5.1 | [Pointer Gestures](https://www.w3.org/WAI/WCAG21/Understanding/pointer-gestures) | Supports | No multi-point or path-based gestures. |
| 2.5.2 | [Pointer Cancellation](https://www.w3.org/WAI/WCAG21/Understanding/pointer-cancellation) | Supports | Uses default `<a>` and `<button>` activation behavior; no custom pointer handlers that act on `mousedown`. |
| 2.5.3 | [Label in Name](https://www.w3.org/WAI/WCAG21/Understanding/label-in-name) | Supports | Button and link visible text matches accessible name on both views. The masked key input uses `aria-label` (no conflicting visible label text). |
| 2.5.4 | [Motion Actuation](https://www.w3.org/WAI/WCAG21/Understanding/motion-actuation) | N/A | No motion-based functionality. |
| 3.1.1 | [Language of Page](https://www.w3.org/WAI/WCAG21/Understanding/language-of-page) | Supports | `<html lang="en">` present on both views. |
| 3.2.1 | [On Focus](https://www.w3.org/WAI/WCAG21/Understanding/on-focus) | Supports | No focus-triggered context changes. |
| 3.2.2 | [On Input](https://www.w3.org/WAI/WCAG21/Understanding/on-input) | Supports | The landing has no inputs. The dashboard's masked key input is `readonly`; no `onchange` handlers. |
| 3.3.1 | [Error Identification](https://www.w3.org/WAI/WCAG21/Understanding/error-identification) | Partially Supports | The landing has no forms. On the dashboard, the key-create and key-revoke flows use `fetch()` against `/key`; a failure path surfaces the error via browser `alert()`. `alert()` announces via screen readers (it blocks the main thread and shifts focus), but the presentation is modal and not in-DOM. Sandbox-delete similarly uses `alert()` on failure. This is functional but not best practice; consider replacing with in-DOM error regions with `aria-live`. |
| 3.3.2 | [Labels or Instructions](https://www.w3.org/WAI/WCAG21/Understanding/labels-or-instructions) | Supports | The landing has no form inputs. The dashboard's one input (`#apiKey`, the masked key) has `aria-label`; its purpose is explained by the surrounding `<h2>Your API Key</h2>` and the subsequent Copy/Show buttons. |
| 4.1.1 | [Parsing](https://www.w3.org/WAI/WCAG21/Understanding/parsing) | Supports | Both pages emit `<!DOCTYPE html>` via the `renderPage` helper (introduced during this pass). W3C Nu HTML Checker returns zero HTML errors; the only emitted messages are two void-element-trailing-slash advisories (informational) and one "CSS: Parse Error" false positive on hono/css's `&:hover` nested rule, which is valid CSS Nesting spec and renders correctly in all target browsers. ID-uniqueness verified via DOM enumeration. Note: [WCAG 2.2 removed this criterion](https://www.w3.org/TR/WCAG22/#parsing) as obsolete, but VPAT 2.5 retains it under WCAG 2.1. |
| 4.1.2 | [Name, Role, Value](https://www.w3.org/WAI/WCAG21/Understanding/name-role-value) | Supports | Uses native elements (`<a>`, `<button type="button">`, `<input>`, `<details>`, `<summary>`, `<main>`, `<nav>`, `<footer>`) with correct default roles. All dashboard `<button>` elements carry explicit `type="button"` (changed from implicit `type="submit"` during this pass). The masked key input has `aria-label`. The new-key success banner carries `role="status" aria-live="polite"` so screen readers announce its content when the DOM is mutated by the key-provisioning JS. |

---

## 4. WCAG 2.1 Level AA conformance

Level AA is the target set for [ADA Title II](https://www.ada.gov/resources/2024-03-08-web-rule/), [Section 508](https://www.access-board.gov/ict/), [EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/), and [UC IMG-2150](https://policy.ucop.edu/doc/7000611/IMT-2150). Level AA subsumes Level A; this table covers the criteria added at AA.

| # | Criterion | api.bayleaf.dev | Remarks |
|---|---|---|---|
| 1.2.4 | [Captions (Live)](https://www.w3.org/WAI/WCAG21/Understanding/captions-live) | N/A | No live media. |
| 1.2.5 | [Audio Description (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-description-prerecorded) | N/A | No prerecorded video. |
| 1.3.4 | [Orientation](https://www.w3.org/WAI/WCAG21/Understanding/orientation) | Supports | Both views are responsive with no orientation lock; verified at 320 px and 1280 px viewport widths. |
| 1.3.5 | [Identify Input Purpose](https://www.w3.org/WAI/WCAG21/Understanding/identify-input-purpose) | Supports | The landing has no inputs. The dashboard's only input is the masked API-key display (`<input type="password" readonly>`), which is not one of the 53 input purposes defined in WCAG 1.3.5 (username, email, tel, etc.) and therefore does not require an `autocomplete` attribute. |
| 1.4.3 | [Contrast (Minimum)](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum) | Supports | Every rendered text/background pair passes AA empirically on both views. Lowest ratios (still passing): `#006aad` inline link on `#fafafa` body = 5.49:1 (needs 4.5:1); `#555` sub-text on white = 7.46:1; `#555` footer text on `#fafafa` = 7.28:1; `#c41e3a` Error state on white = 5.84:1 (large text, needs 3.0:1); `#7a5a00` Stopped state on white = 6.38:1 (large text). A previous defect in the dashboard (`.copy-hint` at `#888` on `#f4f4f4`, 3.22:1) was fixed by changing to `#555` (7.46:1). See [§ 1](#1-surface-description) for full per-pair results. |
| 1.4.4 | [Resize Text](https://www.w3.org/WAI/WCAG21/Understanding/resize-text) | Supports | Verified empirically on both views by setting `document.documentElement.style.fontSize = "200%"`; no horizontal overflow, no element clipping, layout reflows cleanly. |
| 1.4.5 | [Images of Text](https://www.w3.org/WAI/WCAG21/Understanding/images-of-text) | N/A | No images of text on BayLeaf-authored surfaces. |
| 1.4.10 | [Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow) | Supports | Verified empirically via CDP `Emulation.setDeviceMetricsOverride` at 320 CSS px viewport width (the WCAG threshold). Both views: `scrollWidth === window.innerWidth` (322:322), zero horizontally overflowing elements. The dashboard's `statsStyle` uses `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))` which wraps cleanly at narrow widths; `<pre><code>` blocks with long curl examples use `overflow-x: auto`. Also verified at 1280 px. |
| 1.4.11 | [Non-text Contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast) | Supports | Card border `#767676` on `#fafafa` body = 4.35:1 (previously `#ddd` = 1.30:1, fixed during this pass). Colored dashboard card accents all pass: coding-agent purple `#7c3aed` (5.46:1), Canvas orange `#c45a20` (4.17:1), GWS green `#2d7d46` (4.87:1), Web blue `#4a4aad` (7.00:1), Campus Pass green card `#28a745` (3.00:1, at threshold). Primary button backgrounds: navy `#003c6c` on white = 11.27:1; red `#c41e3a` on white = 5.84:1. Focus-ring box-shadow color `#2a5298` on white = 7.29:1. |
| 1.4.12 | [Text Spacing](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing) | Supports | Verified empirically on both views by injecting a `<style>` element with `line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; p { margin-bottom: 2em !important; }`; no horizontal overflow, no element clipping. |
| 1.4.13 | [Content on Hover or Focus](https://www.w3.org/WAI/WCAG21/Understanding/content-on-hover-or-focus) | Supports | No hover tooltips or popovers on either view. `<details>` disclosures on the dashboard use click, not hover. |
| 2.4.5 | [Multiple Ways](https://www.w3.org/WAI/WCAG21/Understanding/multiple-ways) | N/A | `api.bayleaf.dev` is not a "set of pages" in the WCAG sense: the landing and the dashboard are the same URL path `/` with different rendering based on session state, and `/dashboard` is the authenticated canonical. There is no sitemap, search, or alternative navigation required. |
| 2.4.6 | [Headings and Labels](https://www.w3.org/WAI/WCAG21/Understanding/headings-and-labels) | Supports | Headings describe their sections clearly on both views (landing: "API Access for UCSC", "Campus Pass Available" / "On Campus?"; dashboard: "Your API Key", "LLM Inference", "Code Sandbox", "Web Search & Fetch", "Use the BayLeaf API in a coding agent", "Google Workspace CLI", "Canvas LMS"). The `aria-label` on the masked key input ("Your BayLeaf API key (hidden)") is descriptive. |
| 2.4.7 | [Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible) | Supports | Explicit `a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible { outline: 3px solid #fff; box-shadow: 0 0 0 5px #2a5298; border-radius: 4px; }` in the shared stylesheet renders a white inner ring with a blue outer ring. Double-ring indicator is visible against every background in use (navy primary buttons, red danger buttons, white/gray card backgrounds, transparent link backgrounds). Verified by dispatching real `Tab` key events and inspecting the focused element after each press: every focusable element passes the `:focus-visible` match and has the expected outline + box-shadow. Chromium's platform-default 1px blue outline is near-invisible against the navy primary button background; the explicit rule is necessary, not cosmetic. |
| 3.1.2 | [Language of Parts](https://www.w3.org/WAI/WCAG21/Understanding/language-of-parts) | N/A | No foreign-language passages. |
| 3.2.3 | [Consistent Navigation](https://www.w3.org/WAI/WCAG21/Understanding/consistent-navigation) | Supports | The header nav ("API Reference", "Agent Skill") renders identically on both views. The footer link block is identical across both views. |
| 3.2.4 | [Consistent Identification](https://www.w3.org/WAI/WCAG21/Understanding/consistent-identification) | Supports | Recurring elements (primary button, danger button, card layout, stat row, disclosure summary) use the same shared style tokens from `layout.tsx` across both views and across repeated uses within the dashboard. |
| 3.3.3 | [Error Suggestion](https://www.w3.org/WAI/WCAG21/Understanding/error-suggestion) | Partially Supports | The landing has no forms. On the dashboard, key-provisioning failures surface as `alert(data.error \|\| 'Failed to create key')`: the upstream error string is included when present. Sandbox-delete failures surface as `alert('Failed to delete sandbox')` with no suggestion. Consider replacing the `alert()` paths with in-DOM `aria-live` error regions and actionable suggestions. |
| 3.3.4 | [Error Prevention (Legal, Financial, Data)](https://www.w3.org/WAI/WCAG21/Understanding/error-prevention-legal-financial-data) | Supports | Key provisioning is reversible (revoke and re-create). Both destructive actions (Revoke Key, Delete Sandbox) use `window.confirm()` requiring explicit acknowledgment. Not a "legal, financial, data" transaction in the WCAG sense, but the confirmation dialog exceeds the baseline. |
| 4.1.3 | [Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages) | Supports | The new-key success banner, injected into `#keyDisplaySlot` by the client-side `DashboardScripts` JS after a full-page reload, carries `role="status" aria-live="polite"`. Screen readers will announce "Your new API key is ready" when the DOM mutation completes. Key-provisioning and sandbox-delete failure paths use `alert()` (blocking, announces via the browser's alert mechanism, not via `aria-live`). See 3.3.3 above. |

**Level AAA criteria** are not included in this table. VPAT 2.5 treats Level AAA as optional; conformance claims at AA do not include AAA. BayLeaf has not targeted AAA and does not claim it.

---

## 5. Revised Section 508: Chapters 3, 4, 5, 6

[Revised Section 508](https://www.access-board.gov/ict/) incorporates
WCAG 2.0 Level A and AA by reference for web content (Chapter 5:
Software, and Chapter 6: Support Documentation). The chapters below
cover the 508-specific requirements that extend beyond WCAG.

**Chapter 3: Functional Performance Criteria (FPC).** FPC apply when
[§ E205.2](https://www.access-board.gov/ict/#E205.2) (web/software
conformance requirements) cannot be fully met, or as an alternative
path. For a web-only service, WCAG 2.0 AA conformance generally
discharges the FPC obligation. BayLeaf claims conformance via the
WCAG path; see [§ 4](#4-wcag-21-level-aa-conformance).

| § | Criterion | Applies? | Remarks |
|---|---|---|---|
| [302.1](https://www.access-board.gov/ict/#302.1) | Without Vision | Via WCAG | Chat relies on upstream Open WebUI; others per [§ 4](#4-wcag-21-level-aa-conformance). |
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
| [602.3](https://www.access-board.gov/ict/#602.3) | Electronic Support Documentation | Supports | Support is documented via the [support page](https://bayleaf.dev/support.html) (covered by [VPAT-pages.md](VPAT-pages.md)) and the [SKILL.md at /docs/SKILL.md](https://api.bayleaf.dev/docs/SKILL.md) (BayLeaf-authored Markdown served as `text/markdown`). |
| [602.4](https://www.access-board.gov/ict/#602.4) | Alternate Formats for Non-Electronic Support Documentation | N/A | No non-electronic documentation. |
| [603](https://www.access-board.gov/ict/#603) | Support Services | Supports | Support is via email to the operator ([amsmith@ucsc.edu](mailto:amsmith@ucsc.edu)); email is an accessible medium. |

---

## 6. EN 301 549: chapters not covered above

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
| [5](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Generic Requirements | Partially Applies | 5.1 (closed functionality), 5.2 (biometrics), 5.3 (privacy of AT), 5.4 (preservation of info through conversion), 5.5 (operable parts), 5.6 (locking/toggle), 5.7 (key repeat), 5.8 (double-strike), 5.9 (simultaneous user actions): all N/A for a web-only service without biometrics or hardware controls. |
| [6](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | ICT with Two-Way Voice Communication | N/A | No voice communication. |
| [7](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | ICT with Video Capabilities | N/A | No video playback or capture. |
| [8](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Hardware | N/A | Not hardware. |
| [9](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Web | Via WCAG | Web content covered by [§§ 3](#3-wcag-21-level-a-conformance)–[4](#4-wcag-21-level-aa-conformance). |
| [10](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Non-Web Documents | N/A | BayLeaf does not distribute non-web documents (no PDFs, no Word files) as primary content. |
| [11](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Software | Via WCAG 4.1.2 | The API dashboard is "software" in the EN sense; covered by WCAG. |
| [12](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | Documentation and Support Services | Supports | Parallels 508 Chapter 6; BayLeaf documentation is web content. |
| [13](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf) | ICT Providing Relay or Emergency Service Access | N/A | Not a relay or emergency service. |
