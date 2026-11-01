# Media and document stories (draft, 2026-11-01)

Back-solved journeys for the two runtimes surveyed in
[surveys/media-tools-survey.md](surveys/media-tools-survey.md): pdf.js (§4) and libav.js (§1).
Draft only: merge into [JOURNEYS.md](../JOURNEYS.md) as section 13 once the concurrent
`open` and context-indicator work (which also edits JOURNEYS.md) has landed. Every story
is **gap** today. IDs: `PD` (PDF), `AV` (audio/video), `AG` (agent stories).

Three layers, read top to bottom:

1. **User journeys** (a persona wants an outcome).
2. **Agent stories** ("As an agent, I want ... so that ..."): what the model inside Pouch
   needs in order to deliver those outcomes without improvising.
3. **Capability constellation**: the runtimes, commands, tools, skills, model abilities
   and UI that each story pulls in. Build order falls out of which capabilities are shared.

## 1. User journeys

### PDF (pdf.js)
- PD1 (Lab, Analyst): drop a paper or syllabus PDF and ask for a summary, a table pulled out
  as CSV, or every deadline as a list; answers cite page numbers.
- PD2 (Desk): a scanned PDF with no text layer; the agent notices, says so, and still reads it
  (renders pages and looks at them, given an image-capable model; OCR later).
- PD3 (any): `open paper.pdf` or a tree click previews the PDF in Pouch, page by page, with
  no native viewer and no network (canvas render, same posture as HR4).
- PD4 (Desk): "put figure 3 in my report": the agent renders a page region to PNG and embeds
  it in a self-contained HTML report (HR1).
- PD5 (Commuter): after one online use, PDF reading works offline.
- PD6 (Auditor): a hostile PDF (embedded JavaScript, remote links, malformed streams) cannot
  run script or reach the network; PDF scripting stays disabled.
- Out of scope for pdf.js: merge, split, reorder, decrypt-and-save (qpdf WASM, a later slice).

### Audio and video (libav.js)
- AV1 (Lab): "what is this file?": duration, streams, codecs, size, in plain language.
- AV2 (Lab): pull the audio out of a lecture recording as a small Opus/WAV file (and, later,
  hand it to ASR).
- AV3 (Desk): trim a clip, convert MOV to WebM, shrink a file to share; the result is a new
  file, the original untouched.
- AV4 (any): a video the browser cannot play still previews (transcoded to WebM on demand,
  with progress and Stop).
- AV5 (Desk, Analyst): "what happens in this video?": a description with timestamps, backed
  by a contact sheet the user can check.
- AV6 (Phone): a big file either works within memory or is refused up front with a reason,
  never a crashed tab.
- Known gap carried from the survey: AAC/M4A decode has no published libav.js decoder; it
  depends on WebCodecs or `decodeAudioData`, so AV2 on M4A input needs that fallback.

## 2. Agent stories
- AG1: As an agent, I want to extract still frames from a video and perceive those images
  directly, so that I can tell a user what is going on in a video file. (AV5)
- AG2: As an agent, I want a cheap structured probe of any media file (ffprobe JSON), so that
  I can plan before decoding anything expensive. (AV1, all AV)
- AG3: As an agent, I want a PDF's text with page numbers and reading order, so that I can
  quote and cite instead of guessing. (PD1)
- AG4: As an agent, I want to know when a PDF page has no text layer and to render that page
  as an image I can see, so that scans and figures are not invisible to me. (PD2, PD4)
- AG5: As an agent, I want the familiar command names and flags (`pdftotext`, `pdftoppm`,
  `ffmpeg`, `ffprobe`), so that my prior knowledge works and mistakes produce errors I can
  fix. (all)
- AG6: As an agent, I want long transcodes to run as a `/task` I can watch and stop, so that I
  do not block the conversation or the user. (AV3, AV4)
- AG7: As an agent, I want to know what perceiving images costs (allowance, context tokens)
  and a recommended frame budget, so that I sample a video sensibly instead of sending 300
  frames. (AV5)
- AG8: As an agent on a text-only model (LFM3, many Localhost models), I want a clear error
  that I cannot see images, so that I tell the user to switch models instead of
  hallucinating a description. (AG1, AG4)
- AG9: As an agent, I want to put frames or page renders into an HTML report as data URLs, so
  that the user can verify what I saw. (PD4, AV5)

## 3. Capability constellation

| Capability | What it is | Exists? | Stories |
|---|---|---|---|
| C1 pdf.js runtime | lazy same-origin worker, ~5 MiB, scripting off | no (plumbing from batch H) | PD1-6, AG3-4 |
| C2 libav.js runtime | `default-cli` (audio only), ~2.6 MiB, LGPL source shipped; video stories (AV3-5, AG1) need a `webm-cli` or `webm-vp9-cli` build, MP3 input needs `obsolete`, AAC/M4A needs WebCodecs or `decodeAudioData` | no (plumbing from batch H) | AV1-2, AV6, AG2, AG6 with `default-cli`; AV3-5, AG1 with a video variant |
| C3 shell commands | `pdftotext`, `pdftoppm`, `pdfinfo`, `ffmpeg`, `ffprobe` in just-bash over the VFS | no | all |
| C4 image perception | a tool result that carries image blocks (see Q1); needs `toTool` (src/agent.js) to pass image blocks through instead of text only, the transcript to show them, and the model input to carry them | **no**: images reach a model only as user attachments | AG1, AG4, AG7-8 |
| C5 model ability | an image-capable model (Sealed models marked "images") | yes for some Sealed models; LFM3 no | AG1, AG4, AG8 |
| C6 jobs and `/task` | progress, Stop through ctl, memory guard | yes (batch H, F) | AG6, AV3-4, AV6 |
| C7 previews | PDF canvas preview, transcoded video preview, `open` routing | partial (G; `open` in progress) | PD3, AV4 |
| C8 skills | `media` and `pdf` skills: recipes, frame budgets, scan detection, pitfalls | no | AG1-9 |
| C9 offline copy | runtimes in the service worker's offline list | mechanism yes | PD5 |
| C10 containment test | hostile-PDF cases in the exfil style (hostile media waits for an AV story) | no | PD6 |

The constellation for the user's example (AG1, AV5) is C2 + C3 (`ffmpeg -ss T -frames:v 1`)
+ C4 + C5 + C6 + C8, and optionally C9/HR for the contact sheet. C4 is the load-bearing gap: it is
shared by AG1, AG4 and AG8, and it does not depend on either runtime. A user can already put
a PNG in `/work` that no agent can see unless the user attaches it.

## Proposed build order (to discuss)
1. C4 image perception plus AG8's refusal on text-only models (unblocks both runtimes; the `toTool` image-block bridge, transcript and model input are the bulk of it).
2. C1 pdf.js with C3 `pdftotext`/`pdfinfo`/`pdftoppm` and the `pdf` skill (cheapest runtime).
3. C2 libav.js with `ffprobe`/`ffmpeg`, `/task` integration and the `media` skill; AG1 end to end.
4. C7 previews for both, and C10 containment tests for PDFs (media once an AV hostile-input story exists).

## Open questions
- Q1 (decided 2026-11-01, Adam): a separate `look <paths>` tool, not image blocks from
  `read`. Sending pixels is an explicit, countable act, visible in the transcript and easy
  to budget (AG7); on a text-only model it fails plainly (AG8).
- Q2: do runtimes this small (~5 MiB, ~2.6 MiB) need the `models`-style download consent, or
  only lazy loading with a status line?
- Q3: command naming: poppler-style names (`pdftotext`) for the model's prior knowledge, or
  one `pdf` command with subcommands for discoverability?
