# VPAT and BayLeaf Chat

**Service:** BayLeaf Chat ([`chat.bayleaf.dev`](https://chat.bayleaf.dev)), a surface of BayLeaf<br>
**Operator:** Adam Smith, Associate Professor, Dept. of Computational Media, UC Santa Cruz<br>
**Status:** Working draft. Not a signed ACR. A first empirical pass (2026-04-29) covered the authenticated landing page and produced concrete findings for the criteria most relevant to a chat surface; the remainder are still Not Evaluated, pending (in part) a published ACR from upstream Open WebUI (see [§ 1](#1-surface-description)).<br>
**Template:** [VPAT® 2.5 INT](https://www.itic.org/policy/accessibility/vpat), covering [WCAG 2.1](https://www.w3.org/TR/WCAG21/) Level A and AA, [Revised Section 508](https://www.access-board.gov/ict/), and [EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/).

**Methodology.** The 2026-04-29 pass used headless Chromium driven by [rodney](https://github.com/simonw/rodney), authenticated to `chat.bayleaf.dev` via JWT cookie, running [axe-core](https://github.com/dequelabs/axe-core) v4.10.2 with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` tag filter, plus targeted DOM/CSS probes for focus visibility, landmarks, headings, live-region structure, and accessible-name coverage on composer and send controls. The pass did **not** include a real screen-reader run (NVDA/VoiceOver) and did **not** cover settings modals, admin views, or the model workspace builder. Findings below therefore establish Does Not Support claims where evidence is unambiguous, and leave Supports claims off the table until a screen-reader pass is done.

> This is a per-surface ACR. Framing, inheritance map, evaluation methodology, open questions, and references live in [VPAT-overview.md](VPAT-overview.md). Read that document first for the posture; read this one for surface-specific findings and the conformance table.

---

## 1. Surface description

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
  lists and headings over dense paragraphs); see [§ 2](#2-ai-generated-output-as-an-accessibility-surface).
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

- Open WebUI [documentation site](https://docs.openwebui.com/):
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

**Observed defects (2026-04-29, authenticated landing page at `/`).** The pass
surfaced concrete defects in the upstream Open WebUI UI. These are not BayLeaf
configurations; they are inherited from the upstream Svelte/SvelteKit
application and would require upstream contributions or a fork to remediate.
Each item maps to a row in [§ 3](#3-wcag-21-level-a-conformance) or
[§ 4](#4-wcag-21-level-aa-conformance).

- **No heading structure** (1.3.1, 2.4.6): the landing page has zero `<h1>` or
  `<h2>` elements. The visually prominent "Basic" model title and "Suggested"
  prompts section are styled divs, not heading elements. Screen-reader users
  cannot navigate by heading structure.
- **Single unlabeled landmark** (1.3.1, 2.4.1): the page contains one `<nav>`
  with no `aria-label`, no `<main>`, no `<header>`, no `<footer>`, and no skip
  link. Keyboard users must Tab through the full sidebar on every page load
  to reach content.
- **Missing `:focus-visible` styling on core chrome** (2.4.7): an inspection
  of loaded stylesheets found nine `:focus-visible` rules, all for third-party
  widgets (Sonner toasts, Svelte Flow). The sidebar controls, model selector,
  composer, send button, and banner close buttons have `outline: none` from
  Tailwind resets with no authored replacement style. Keyboard users receive
  no consistent visual focus indicator on Open WebUI's own UI.
- **Composer has no accessible name** (4.1.2, 3.3.2): `#chat-input` is a
  `<div contenteditable="true">` with no `role`, no `aria-label`, and no
  `aria-placeholder`. The visible "How can I help you today?" / "Send a
  Message" placeholder is a Tiptap CSS `::before` pseudo-element on a
  `data-placeholder` attribute and is not exposed to the accessibility tree.
- **Send button has no accessible name** (4.1.2): `#send-message-button` is a
  `<button>` containing only an SVG, with no `aria-label`, no `title`, and no
  `<title>` inside the SVG. The button only renders after text is entered
  in the composer, which is why axe-core did not flag it in the automated
  pass. The same structural issue likely affects the voice-input and
  stop-generation buttons visible during streaming.
- **Icon button without accessible name** (4.1.2, axe `button-name`):
  `#temporary-chat-button` in the top bar renders an SVG with no label.
- **Focusable `aria-hidden` element** (4.1.2, axe `aria-hidden-focus`):
  a button labeled "Get information on Basic in the UI" is marked
  `aria-hidden="true"` while remaining focusable, which exposes
  contradictory state to assistive technology.
- **Nested interactive element** (4.1.2, axe `nested-interactive`): an outer
  `<button class="flex flex-col flex-1 cursor-[e-resize]">` contains
  focusable descendants.
- **Viewport scaling disabled** (1.4.4, axe `meta-viewport`): the page sets
  `<meta viewport maximum-scale=1>`, which disables pinch-to-zoom on mobile.
- **Contrast shortfalls** (1.4.3, axe `color-contrast`): the yellow "WARNING"
  banner pill measures 4.32:1 (needs 4.5:1); the subtitle text
  "Available to the entire campus community" under the model title measures
  2.77:1.

**Observed supports (2026-04-29).** A handful of items on the landing page
are structurally correct:

- `<html lang="en-US">` is present (3.1.1).
- The page title "BayLeaf (Open WebUI)" is meaningful (2.4.2).
- Most icon-only controls in the sidebar and top bar carry `aria-label`
  attributes (sidebar toggle, New Chat, Search, Workspace, Add Model,
  Controls, Close Banner).
- The chat transcript is wrapped in
  `<ul role="log" aria-live="polite" aria-atomic="false" aria-relevant="additions">`,
  which is the correct ARIA pattern for streamed chat output (partial 4.1.3,
  see [§ 2](#2-ai-generated-output-as-an-accessibility-surface)). SvelteKit's
  `#svelte-announcer` live region is also present. A real screen-reader pass
  is still needed to verify token-by-token streaming announcement behavior.
- No `accesskey` attributes and no single-character shortcut bindings were
  observed, so 2.1.4 concerns are low.

**Links for the future evaluation pass.**

- [Open WebUI repo](https://github.com/open-webui/open-webui)
- [Open WebUI docs](https://docs.openwebui.com/)
- Open WebUI uses [Svelte](https://svelte.dev/) and
  [SvelteKit](https://kit.svelte.dev/); frontend source under
  [`src/lib/`](https://github.com/open-webui/open-webui/tree/main/src/lib).
- BayLeaf Chat deployment notes: [../chat/DESIGN.md](../chat/DESIGN.md).

---

## 2. AI-generated output as an accessibility surface


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

- [1.1.1 Non-text Content](https://www.w3.org/WAI/WCAG21/Understanding/non-text-content):
  generated images (DALL·E, Imagen, etc.) rendered in the chat UI need
  alt text. The model can be prompted to provide a description
  alongside any generated image; the UI must render it as an `alt`
  attribute or equivalent. This is a joint UI/prompt responsibility.
- [1.3.1 Info and Relationships](https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships):
  when a model emits markdown tables, lists, or headings, the UI's
  markdown renderer must preserve those semantics in the DOM.
  Malformed markdown (which LLMs sometimes produce) can produce
  inaccessible output even when the renderer is correct.
- [1.4.5 Images of Text](https://www.w3.org/WAI/WCAG21/Understanding/images-of-text):
  models occasionally return ASCII art, rendered diagrams, or
  screenshots when text would serve. The system prompt is a lever for
  steering away from this.
- [2.4.6 Headings and Labels](https://www.w3.org/WAI/WCAG21/Understanding/headings-and-labels):
  long model responses benefit from heading structure; the system
  prompt can encourage this for long answers.
- [4.1.3 Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages):
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
- [W3C APG: Live Region patterns](https://www.w3.org/WAI/ARIA/apg/patterns/alert/)
  and [status](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/) documentation.
- Deque [screen reader announcements in streaming UIs](https://www.deque.com/blog/)
  (search for streaming / live region content).
- The [WebAIM Screen Reader User Survey](https://webaim.org/projects/screenreadersurvey10/)
  for context on how real users consume streamed content.
- [ARIA Authoring Practices Guide (APG)](https://www.w3.org/WAI/ARIA/apg/)
  for the general live-region patterns the UI should implement.

**Where this lives in the conformance table.** [the conformance tables below](#3-wcag-21-level-a-conformance)
marks AI-output criteria as Not Evaluated with remarks pointing here.
A future evaluation pass would need to decide whether to fold AI output
into Chat's conformance entries (arguing it is part of the Chat
surface) or to report it in a separate addendum. The operator's
current view: keep it as a separate section until the AI Council has
a position on whether system-prompt interventions are in scope for
this VPAT.

---

## 3. WCAG 2.1 Level A conformance

The full Level A criterion set is defined by the [W3C WCAG 2.1 Recommendation](https://www.w3.org/TR/WCAG21/#conformance-reqs). Each row below links to the *Understanding* document for the criterion.

Remarks have been trimmed to the Chat surface. Sentences in the pre-split draft that addressed sibling surfaces (the API or the bayleaf.dev landing) have been removed; where no sentence in the original applied to Chat, the remark reads "Not yet evaluated for this surface" with pointers to the sibling ACRs.

| # | Criterion | Chat | Remarks |
|---|---|---|---|
| 1.1.1 | [Non-text Content](https://www.w3.org/WAI/WCAG21/Understanding/non-text-content) | N/E | Chat: see [§ 2](#2-ai-generated-output-as-an-accessibility-surface) for AI-generated images. |
| 1.2.1 | [Audio-only and Video-only (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-only-and-video-only-prerecorded) | N/A | No prerecorded media on any BayLeaf surface. |
| 1.2.2 | [Captions (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/captions-prerecorded) | N/A | No prerecorded media. |
| 1.2.3 | [Audio Description or Media Alternative (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-description-or-media-alternative-prerecorded) | N/A | No prerecorded media. |
| 1.3.1 | [Info and Relationships](https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships) | Does Not Support | 2026-04-29 pass: landing page has zero `<h1>` or `<h2>` elements; visually-prominent "Basic" model title and "Suggested" section header are non-heading divs. Only one landmark (`<nav>`, unlabeled) on the page; no `<main>`, `<header>`, or `<footer>`. Upstream Open WebUI defect. See [§ 1 observed defects](#1-surface-description).
| 1.3.2 | [Meaningful Sequence](https://www.w3.org/WAI/WCAG21/Understanding/meaningful-sequence) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 1.3.3 | [Sensory Characteristics](https://www.w3.org/WAI/WCAG21/Understanding/sensory-characteristics) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 1.4.1 | [Use of Color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 1.4.2 | [Audio Control](https://www.w3.org/WAI/WCAG21/Understanding/audio-control) | N/A | No auto-playing audio. |
| 2.1.1 | [Keyboard](https://www.w3.org/WAI/WCAG21/Understanding/keyboard) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.1.2 | [No Keyboard Trap](https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.1.4 | [Character Key Shortcuts](https://www.w3.org/WAI/WCAG21/Understanding/character-key-shortcuts) | Supports (provisional) | 2026-04-29 pass: no `accesskey` attributes and no single-character shortcut bindings observed on the landing page. Open WebUI's documented shortcuts use Ctrl/Cmd/Shift modifiers. Re-verify if upstream adds new shortcuts. |
| 2.2.1 | [Timing Adjustable](https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.2.2 | [Pause, Stop, Hide](https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide) | N/E | Streamed chat responses are arguably "moving" content; examine in Chat evaluation with [§ 2](#2-ai-generated-output-as-an-accessibility-surface) in mind. |
| 2.3.1 | [Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold) | N/E | No flashing content on any BayLeaf-authored surface. |
| 2.4.1 | [Bypass Blocks](https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks) | Does Not Support | 2026-04-29 pass: no skip link present; only one landmark (`<nav>`) with no label, no `<main>`. Keyboard users must traverse the sidebar on every page load. Upstream defect. |
| 2.4.2 | [Page Titled](https://www.w3.org/WAI/WCAG21/Understanding/page-titled) | Supports | 2026-04-29 pass: `<title>BayLeaf (Open WebUI)</title>`. |
| 2.4.3 | [Focus Order](https://www.w3.org/WAI/WCAG21/Understanding/focus-order) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.4.4 | [Link Purpose (In Context)](https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.5.1 | [Pointer Gestures](https://www.w3.org/WAI/WCAG21/Understanding/pointer-gestures) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.5.2 | [Pointer Cancellation](https://www.w3.org/WAI/WCAG21/Understanding/pointer-cancellation) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.5.3 | [Label in Name](https://www.w3.org/WAI/WCAG21/Understanding/label-in-name) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.5.4 | [Motion Actuation](https://www.w3.org/WAI/WCAG21/Understanding/motion-actuation) | N/A | No motion-based functionality. |
| 3.1.1 | [Language of Page](https://www.w3.org/WAI/WCAG21/Understanding/language-of-page) | Supports | 2026-04-29 pass: `<html lang="en-US">`. |
| 3.2.1 | [On Focus](https://www.w3.org/WAI/WCAG21/Understanding/on-focus) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 3.2.2 | [On Input](https://www.w3.org/WAI/WCAG21/Understanding/on-input) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 3.3.1 | [Error Identification](https://www.w3.org/WAI/WCAG21/Understanding/error-identification) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 3.3.2 | [Labels or Instructions](https://www.w3.org/WAI/WCAG21/Understanding/labels-or-instructions) | Does Not Support | 2026-04-29 pass: the chat composer (`#chat-input`, a `contenteditable` div) has no programmatic label; its visible placeholder is a CSS pseudo-element not exposed to assistive technology. Upstream Tiptap/ProseMirror integration defect. |
| 4.1.1 | [Parsing](https://www.w3.org/WAI/WCAG21/Understanding/parsing) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 4.1.2 | [Name, Role, Value](https://www.w3.org/WAI/WCAG21/Understanding/name-role-value) | Does Not Support | 2026-04-29 pass: multiple defects. (a) Chat composer is a `contenteditable` div with no `role`/`aria-label`. (b) `#send-message-button` is SVG-only with no accessible name. (c) `#temporary-chat-button` icon button has no accessible name (axe `button-name`). (d) A button with `aria-hidden="true"` remains focusable (axe `aria-hidden-focus`). (e) Nested interactive controls observed (axe `nested-interactive`). All upstream Open WebUI defects. |

---

## 4. WCAG 2.1 Level AA conformance

Level AA is the target set for [ADA Title II](https://www.ada.gov/resources/2024-03-08-web-rule/), [Section 508](https://www.access-board.gov/ict/), [EN 301 549](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/), and [UC IMG-2150](https://policy.ucop.edu/doc/7000611/IMT-2150). Level AA subsumes Level A; this table covers the criteria added at AA.

| # | Criterion | Chat | Remarks |
|---|---|---|---|
| 1.2.4 | [Captions (Live)](https://www.w3.org/WAI/WCAG21/Understanding/captions-live) | N/A | No live media. |
| 1.2.5 | [Audio Description (Prerecorded)](https://www.w3.org/WAI/WCAG21/Understanding/audio-description-prerecorded) | N/A | No prerecorded video. |
| 1.3.4 | [Orientation](https://www.w3.org/WAI/WCAG21/Understanding/orientation) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 1.3.5 | [Identify Input Purpose](https://www.w3.org/WAI/WCAG21/Understanding/identify-input-purpose) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 1.4.3 | [Contrast (Minimum)](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum) | Does Not Support | 2026-04-29 pass: axe-core flagged the "WARNING" banner pill (`#a65f00` on `#fcefcc` = 4.32:1, needs 4.5:1) and the model subtitle "Available to the entire campus community" (`#9b9b9b` on white = 2.77:1). Three additional nodes were `incomplete` (axe could not conclusively measure). Upstream defect. |
| 1.4.4 | [Resize Text](https://www.w3.org/WAI/WCAG21/Understanding/resize-text) | Does Not Support | 2026-04-29 pass: `<meta viewport maximum-scale=1>` disables pinch-to-zoom on mobile (axe `meta-viewport`, critical). Upstream defect. |
| 1.4.5 | [Images of Text](https://www.w3.org/WAI/WCAG21/Understanding/images-of-text) | N/E | No images of text on BayLeaf-authored surfaces. See [§ 2](#2-ai-generated-output-as-an-accessibility-surface) for AI-generated output. |
| 1.4.10 | [Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 1.4.11 | [Non-text Contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 1.4.12 | [Text Spacing](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 1.4.13 | [Content on Hover or Focus](https://www.w3.org/WAI/WCAG21/Understanding/content-on-hover-or-focus) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 2.4.5 | [Multiple Ways](https://www.w3.org/WAI/WCAG21/Understanding/multiple-ways) | N/A | Not applicable to this surface. |
| 2.4.6 | [Headings and Labels](https://www.w3.org/WAI/WCAG21/Understanding/headings-and-labels) | Does Not Support | 2026-04-29 pass: landing page has no heading elements at all; visually-prominent titles ("Basic", "Suggested") are styled divs. Also covers composer / send button label defects noted at 3.3.2 and 4.1.2. Upstream defect. |
| 2.4.7 | [Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible) | Does Not Support | 2026-04-29 pass: stylesheet inspection found only nine `:focus-visible` rules, all for third-party widgets (Sonner, Svelte Flow). Core Open WebUI chrome (sidebar, model selector, composer, send, banner close) has `outline: none` from Tailwind resets with no authored replacement. Keyboard users receive no consistent visual focus indicator. Upstream defect. |
| 3.1.2 | [Language of Parts](https://www.w3.org/WAI/WCAG21/Understanding/language-of-parts) | N/A | No foreign-language passages on BayLeaf-authored surfaces. |
| 3.2.3 | [Consistent Navigation](https://www.w3.org/WAI/WCAG21/Understanding/consistent-navigation) | N/A | Single-page surfaces. |
| 3.2.4 | [Consistent Identification](https://www.w3.org/WAI/WCAG21/Understanding/consistent-identification) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 3.3.3 | [Error Suggestion](https://www.w3.org/WAI/WCAG21/Understanding/error-suggestion) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 3.3.4 | [Error Prevention (Legal, Financial, Data)](https://www.w3.org/WAI/WCAG21/Understanding/error-prevention-legal-financial-data) | N/E | Not yet evaluated for this surface; see [VPAT-api.md](VPAT-api.md), [VPAT-pages.md](VPAT-pages.md) for sibling-surface observations. |
| 4.1.3 | [Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages) | Partially Supports | 2026-04-29 pass: the chat transcript is wrapped in `<ul role="log" aria-live="polite" aria-atomic="false" aria-relevant="additions">`, the correct ARIA pattern for streamed chat. SvelteKit `#svelte-announcer` live region is also present. Structural pieces are in place, but token-by-token streaming behavior with an actual screen reader (NVDA/VoiceOver) was not verified in this pass. See [§ 1](#1-surface-description), [§ 2](#2-ai-generated-output-as-an-accessibility-surface). |

**Level AAA criteria** are not included in this table. VPAT 2.5 treats Level AAA as optional; conformance claims at AA do not include AAA. BayLeaf has not targeted AAA and does not claim it. The [full AAA criterion list](https://www.w3.org/TR/WCAG21/#conformance-reqs) is available from W3C for readers interested in the next tier.

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
| [602.3](https://www.access-board.gov/ict/#602.3) | Electronic Support Documentation | N/E | Support page at [`docs/support.html`](https://github.com/bayleaf-ucsc/bayleaf/blob/main/docs/support.html) is out of scope per [VPAT-overview.md § 4](VPAT-overview.md#4-per-surface-acrs) but will be brought in when capacity allows. |
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
