# Pouch play log (QA subagent, 2026-10-30)

Setup: Playwright 1.64.1 Chromium 156 (headless), from `/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright` because the worktree's `pouch/node_modules` has no playwright package (the repo's own walkthrough.mjs uses the same path). Fresh persistent profile `/tmp/pouch-qa/play-profile`. Viewport 1280x800. Console errors/warnings go to `console.log`, non-local network requests to `network.log` (both in this folder). Times are UTC.

Screenshots: `NN-journey-moment.png` is the full viewport; `-crop.png` is the element in focus.

## Journey 1: first visit, trust, key, session

**1.1 Open http://127.0.0.1:8742/**. Expected the app. Got a bare Python "Directory listing for /" (icons/, manifest.webmanifest, models/, pouch.html, SHA256SUMS, sw.js). I had to guess that pouch.html is the app. (No screenshot kept; the 01 file was overwritten by the app view.)

**1.2 Open /pouch.html.** Loaded in ~2.7 s (incl. a 2.5 s fixed wait). First-visit green card: what Pouch is, where files live, "On a borrowed computer: Download all, then Erase all", buttons Upload files / Mount a folder / Got it. Files panel open on the right with work / pouch / tmp. Composer: "Ask Pouch. @ for files, $ for skills, / for commands". Default model GLM-5.3. Local lane listed but disabled ("WebGPU found no usable graphics adapter", expected in headless). Status line: "Not signed in: using Campus Pass, which works only on the UCSC network." Usage badge already said "about 100 of 100 Sealed requests left today" even though I'm off campus: confused me, it implies I have 100 requests when the status line says Campus Pass won't work here. Screens: `01-arrive-first-visit.png`, `-crop`.
Console: one warning "No available adapters." (WebGPU).

**1.3 Header shield ("Sealed: enclave verified").** Expected a small popover; instead it opened the full right-side panel "What can BayLeaf see?" replacing the Files panel. Prose is clear and honest (BayLeaf sees key/IP, time, bytes, model; cannot read prompts). Then a long column of hex: release digest, published code, running enclave, five "Step: ... success" rows, mounts table ("/  rw memory, /pouch rw indexeddb, /task rw tasks, /work rw opfs"), build id "2b9eead+dirty", sha256 recipe, "This copy" table (Running from: the offline copy in this browser; Storage: best effort...), Check for updates / Uninstall offline copy. Raw: the hex walls are long and narrow (wrapping mid-hash at panel width); I scrolled a lot to reach "This copy". "Running from the offline copy" surprised me on a first visit. Screens: `02-arrive-shield-popover.png`, `02-arrive-trust-panel(-crop).png`, `03-arrive-trust-panel-bottom(-crop).png`.

**1.4 Composer shield ("Lane and permissions for this session").** Clicked; screenshot `04-arrive-composer-shield.png`.

**1.5 Sign in (key icon in header).** A modal "Sign in to BayLeaf": "Approve on a device where you are signed in (recommended)", "Paste a key you already have", Cancel. Heading is in a monospace font unlike the rest. Screen: `05-arrive-signin-sheet.png`.
"Paste a key" opens a **native browser prompt()** ("Your sk-bayleaf- key (stored only in this browser)"), not an in-app field. My first paste was the whole line from my token file (`BAYLEAF_API_KEY=sk-bayleaf-...`); the app rejected it with a native alert() ("That does not look like an sk-bayleaf- key."), which my harness auto-dismissed, so on screen nothing happened and the status still said "Not signed in". Frustration: silent from my point of view; a forgiving parser (strip `NAME=`) or inline error would have saved a retry. Second paste (bare `sk-bayleaf-...`) worked in ~0.5 s: key icon became "Forget key", status line cleared, usage became "450 of 500 Sealed requests left today" (GET /usage). Screen: `07-arrive-signed-in.png`.
Sealed requests used so far: 0 (baseline 450 left).

## Journey 2: Desk, panel review

**2.1 Create /work/essay.md.** Files panel, "Actions for work" (the "..." on the work row) opens a bottom-sheet dialog: Collapse, New file here, New folder here, Upload files here, Upload a folder here, New file from clipboard, Download as .zip/.tar, Mention in chat, Cancel (`08-desk-work-actions(-crop).png`). "New file here" asks for the name with a **native prompt()** ("New file name"). After naming, the editor opened /work/essay.md immediately (Editor panel replaced Files). I typed a 4-paragraph op-ed (paragraph 3 is deliberately weak: "everyone knows", "my friend in Oakland", "basically always works"). Cmd+S saved (Save button went disabled). `10-desk-essay-in-editor-crop.png`.

**2.2 Completion.** `$pan` showed one option "panel: Review a draft with a panel of subagents (a chair and four judges...)" (`11-desk-dollar-completion*.png`). `/` lists /new, /seed, /help, /usage, /files, /erase, /rename, /revert (`12-desk-slash-completion.png`). Tab on `$pan` replaced my text with "Use the panel skill. " (not `$panel`): mildly surprising that my token turned into an English sentence, but it reads fine. Sent "Use the panel skill. Review this draft." (`13-desk-panel-prompt.png`).

**2.3 Watching subagents (sidebar opened with "Show sessions").** Timeline from send: 8 s, nothing nested yet (`14-desk-panel-8s.png`). 22 s: four judges "working" and chair "done" nested under the session; tray "Running: 4 / Stop all" with one row per judge (task text, "subagent s3, /task/2", elapsed, Stop). 32 s: chair back to "working", "main waits on s2" with a Background button. 42 s: three judges done, judge-clarity working (`15-desk-panel-subagents-working-crop.png`). The chair flipping done -> working confused me for a moment (it had replied "Ready" and stopped, as its task says, but the sidebar just says "done").

**2.4 Open a judge and steer it.** At ~45 s I clicked judge-clarity: it had already finished (25 s, 5 requests). The composer was disabled with placeholder "judge-clarity has finished. Go back to Use the panel skill. Review this draft. to continue." (`16-desk-judge-view.png`). Frustration: judges live ~15–25 s; a human cannot realistically open one and type a steer before it ends. I read its transcript instead: it tried `write /work/.subagents/judge-clarity.md` and `write /work/judge-clarity.md`, both failed ("!" pills: read-only), then wrote /tmp/judge-clarity.md. Mounts header: "/tmp rw scratch, /work/essay.md ro opfs (narrowed)".

**2.5 Steer the chair instead** (still working at 81 s, "1m 04s, 2 requests"). Placeholder: "Steer chair: it reads this after its current step". Sent "It is a draft, ignore citation format." at 85 s. Status line: "Steering chair: it reads this after its current step." then "Steering delivered to chair." (`18-desk-chair-view.png`, `19-desk-chair-steered-crop.png`). The chair's final review later opened with "Treated as a draft: suggestions ask for real examples and figures, not citation formatting", so the steer visibly landed. The chair card later said "Transcript (26 items), steered by you once" (`24-desk-chair-card-expanded*.png`, `25-desk-chair-steer-in-transcript.png`).
Note: the status line "Steering chair: it reads this after its current step." was still showing under the main session's composer minutes later, after everything had finished (visible in `24`).

**2.6 Budget hit.** By 138 s the usage badge read 413 (37 used) and network.log showed 38 POSTs to /sealed/v1/chat/completions, all from this single panel request. Judge request counts from the cards: argument 7, evidence 4, clarity 5, audience 11, chair 7 (+ main). Judges argument and audience exchanged messages directly (audience "7 msgs", argument "6 msgs"). I armed an auto-stop at 40 POSTs; it pressed "Stop all" at 235 s, but main's final request was already in flight and completed: **41 Sealed requests total** (usage 409 of 500). One request over my 40 cap.

**2.7 Final review in main** (`22-desk-final-review*.png`), 3m 00s turn. Main's transcript shows: ls /work, read SKILL.md, read essay, chair card, four judge cards, "subagent: message s2", then **seven "subagent: join ... finished / Subagent X finished / No report." rows** (judge-audience three times, judge-argument twice) (`23-desk-join-no-report.png`). Confusing: it looks like failures ("No report.") although the judges did report, to the chair. Then "from chair (s2)" with the 5-point review, then main restated the same 5 points almost verbatim and ended "Tell me which to apply — e.g. "apply 1 and 3"". Paragraph 3 (my weak evidence) was the top item, and the Oakland anecdote dispute between argument and audience was reported as resolved by direct exchange.
Layout note: with sidebar + Editor open at 1280 px, the chat column is ~360 px wide (`24-...png`).

**2.8 Not done (budget):** asking main to apply suggestions, the editor conflict bar, and the watch / re-run offer. Main did not set up a watch in this turn (no watch row in the tray).

## Journey 3: sending modes

**Not done.** Every part needs main to be working, which needs Sealed requests, and the budget was spent in journey 2. What I could see without sending: Settings has "While Pouch is working, Enter: Steer | Queue" with an explanation of Alt+Enter and "the arrow next to Stop" (`28-settings-panel-crop.png`). The split-button menu exists hidden in the DOM ("Steer now: read after current step / Queue for after this turn / Stop and send / Change what Enter does") but I never saw it on screen. Steering itself was exercised once on the chair (2.5).

## Journey 4: files waiting

**Partly done (UI only, no model).** Did not ask main about missing CSVs (budget), so whether it would watch /work/data is unobserved. Created folder /work/data via "Actions for work" > New folder here (native prompt again), then "Actions for data" > Upload files here, picked 2026-07/08/09.csv (3 rows each, one quoted field with a comma). Took ~1.3 s; status line "Added 3 files in /work/data."; tree shows them (`26-files-csv-uploaded-crop.png`). Clicking 2026-08.csv opened it in the editor (`27-files-csv-in-editor-crop.png`).

## Journey 5: run script, background subagent, join

**Not done** (budget). No `run` call happened in this session, so no run row in the tray.

## Journey 6: settings, usage, trust, install/offline

**6.1 Settings** (`28-settings-panel*.png`): Appearance (System/Light/Dark), expand reasoning / tool calls by default, Enter behavior while working, "See this copy and check for updates", model-selection note, Local model (unavailable here, "Load from folder / Load from files", ~1.1 GB). I did not load or download the Local model.

**6.2 Usage panel** (`29-usage-panel*.png`): "409 of 500 left today ... Resets at 5:00 PM (your time)". Explains one request per model step. "Standard lane (OpenRouter): $5.00 of $5.00 left. Not used by Pouch". "Tokens by session: Use the panel skill. Review this draft. 12,245 in / 3,468 out / $0.0420". Confusion: 41 requests for that session but only ~12k input tokens; I suspect subagent tokens are not counted in this table, but the panel does not say.

**6.3 Trust panel mounts** (`30-trust-mounts*.png`): now lists Agent plus /task/1–5 (chair, four judges), each "/tmp rw scratch, /work/essay.md ro opfs (narrowed)". The README-noted wide-label layout issue did not show here because labels are short. The section also offers "Remove the seed layer" although I never seeded anything (puzzled me).

**6.4 Offline toggle** (Playwright context offline for ~6 s): header shield became "Offline: the model is unreachable"; status line "Offline: the model is unreachable. Files, the editor, review, archives and run keep working; sending comes back when the network does."; Send disabled with my draft kept (`31-offline-composer*.png`). Back online: status cleared within 3 s (`32-back-online.png`).

**6.5 Install / update** (`33-install-update-check*.png`): "Check for updates" -> "This copy is the published build." (published sha256 d45f581368bb matches). "Installed: no: in a browser tab". No Install button anywhere in the UI that I found (headless Chromium offers no install prompt, so I cannot tell whether one would appear); the only match for /install/i was "Uninstall offline copy", a red button sitting right beside "Check for updates".

## Phone pass (390x844)

`34-phone-main.png` (+ `-crop` composer): bottom tab bar Chat / Files / Editor / 409 left / More. The composer placeholder is cut off mid-line ("Ask Pouch. @ for files, $ for skills, / for" then clipped). The tray could not be shown (nothing running). `35-phone-sessions.png`: sessions drawer. `36-phone-subagent-view.png`: judge-audience view. The subagent header card is sticky and the previous message's dashed card shows through/behind it at the top. Tool pills render raw JSON: `agents: {"action":"message","ids":[],"text...` (ids shown as empty array). The end line reads "...report went to Use the panel skill. Review this draft.." (double period, from the session title ending in a period). Disabled composer placeholder also clipped.

## Console and network

Console: only `warning: No available adapters.` (WebGPU, at load). No errors.
Network (non-local): 41 POST /sealed/v1/chat/completions, 12 GET /usage, 3 GET /sealed/attestation, 2 GET /sealed/models, 1 GET /campus-pass. Nothing else left the page.

## Sealed requests used

**41** (cap was 40; the 41st was main's final reply already in flight when the auto-stop fired). All 41 came from the single `$panel` request in journey 2.
