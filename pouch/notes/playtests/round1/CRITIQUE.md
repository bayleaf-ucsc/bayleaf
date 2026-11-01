# Independent Design Critique: BayLeaf Pouch

**Evidence reviewed:** `/tmp/pouch-qa/play/LOG.md`, `console.log`, `network.log`, and all 42 screenshots (`01`–`36`, full viewport and crops). No source code was read.

---

## Dimension Scores & Detailed Critique

### 1. Visual Hierarchy and Density — **2.5 / 5**

* **Three-column desktop squeeze crushes the primary workspace (`14`–`25`).** At `1280x800`, opening the Sessions sidebar on the left and the Editor on the right leaves the center chat column roughly `360px` wide (LOG 2.7; `15-desk-panel-subagents-working.png`, `24-desk-chair-card-expanded.png`). In that narrow strip, up to four verticalchrome layers stack at once: top session header, sticky subagent summary card (`~235px` tall in `18-desk-chair-view.png`), running-work tray (`~110px` tall in `19-desk-chair-steered.png`), composer (`~95px` tall), and bottom status line. In `18-desk-chair-view.png` and `19-desk-chair-steered.png`, the actual scrolling transcript viewport between the sticky subagent card and the running tray is reduced to **~210px of vertical height** (barely 6–7 lines of text).
* **Sticky subagent card floats over scrolling messages with bleed-through (`18`, `19`, `20`, `36`).** When viewing a subagent (`18-desk-chair-view.png`, `20-desk-chair-end.png`, `36-phone-subagent-view.png`), the oversized top card (`chair`, `judge-audience`) is sticky, but scrolling messages and dashed inter-agent message boxes pass directly behind it and peek out above its top margin (`18-desk-chair-view.png` shows `"4. The Oakland anecdote is a non"`, `19-desk-chair-steered-crop.png` shows `"Oakland says it is much easier to"`, `36-phone-subagent-view.png` shows `"argument, I agree the nearby-city idea"`). This creates severe visual noise at the top of the reading column.
* **Expanded subagent transcripts look identical to the main session (`24`–`34`).** Expanding a subagent's inline transcript inside the main chat (`24-desk-chair-card-expanded.png`, `25-desk-chair-steer-in-transcript.png`) renders only a thin green left border. Once the card header scrolls out of view (`26-files-csv-uploaded.png` through `34-phone-main.png`), there is no visual header or frame indicating you are reading inside an expanded `chair` subagent transcript rather than the main session.
* **Cryptographic hex walls dominate the Trust panel (`02`, `03`, `30`).** Clicking the header shield opens "What can BayLeaf see?" (`02-arrive-trust-panel-crop.png`). Clear prose at the top is immediately followed by a narrow two-column key-value table where 64-character SHA-256 digests (`Release`, `Published code`, `Running enclave`) wrap across 4–5 lines each at 14 chars per line, pushing actionable controls (`What each task can see`, `This copy`, `Check for updates`) below the fold (`03-arrive-trust-panel-bottom-crop.png`, LOG 1.3).
* **Duplicate shield and usage affordances (`01`, `04`, `29`).** A green shield icon and usage gauge (`100` / `450` / `409`) appear inside the composer bar *and* simultaneously in the top header and far-right icon rail (`01-arrive-first-visit.png`). Meanwhile, the composer shield opens a lightweight popover (`04-arrive-composer-shield-crop.png`), whereas the identical-looking header shield replaces the entire right-hand workspace panel (`02-arrive-trust-panel.png`).

---

### 2. Legibility of Agent Activity — **2.0 / 5**

* **Seven "Subagent X finished / No report." cards look like catastrophic failure (`23-desk-join-no-report.png`, LOG 2.7).** In the main session transcript, `subagent: join` renders seven stacked boxed cards reading `finished | Subagent judge-evidence finished | No report.` (with `judge-audience` repeated three times and `judge-argument` twice). Because the judges sent their findings to `chair` (`s2`) via `agents: message` rather than returning a direct join payload to `main` (`s1`), the UI labels each join result `"No report."` A user scanning the main session sees a wall of `"No report."` cards and concludes the subagents failed, even though they succeeded.
* **Raw JSON and internal IDs leak into tool pills and transcripts (`24`, `25`, `26`, `36`).** Instead of human-readable summaries, inter-agent tool calls render as truncated raw JSON strings:
  * `agents: {"action":"message","text":"Chair ...` (`25-desk-chair-steer-in-transcript.png`)
  * `agents: {"action":"join","ids":["s3","s4",...` (`24-desk-chair-card-expanded-crop.png`)
  * `agents: {"action":"message","ids":[],"text...` (`36-phone-subagent-view.png`, where `ids: []` looks broken because the target was passed under another field or omitted).
  * Prompts and metadata mix human names (`judge-clarity`), agent slot IDs (`s2`, `s5`), and kernel task paths (`/task/4`), forcing the user to mentally join three namespaces (`15-desk-panel-subagents-working.png`, `16-desk-judge-view.png`).
* **Chair state flips `done` -> `working` during handshake (`15`, LOG 2.3).** Because the panel skill instructs the chair to reply `"Ready"` and stop while waiting for `main` to send judge IDs, the sidebar shows `chair` as `done` at 22s before flipping back to `working` at 32s (LOG 2.3). "Done" implies terminal completion; an agent awaiting a message from `main` should show `waiting` or `idle`, not `done`.
* **Sidebar message count ("1 msg" / "11 msgs") is ambiguous (`15`–`21`, `35`).** In the sidebar (`20-desk-chair-end.png`), `judge-audience` says `7 msgs done` while `judge-clarity` says `1 msg done`. Inside `judge-audience` (`36-phone-subagent-view.png`), the header says `Messages: from chair (s2) 1 · from judge-argument (s3) 1 · to chair (s2) 3 · to judge-argument (s3) 2` (total 7 inter-agent messages, 11 LLM requests). "7 msgs" in the sidebar sounds like 7 chat turns in its transcript rather than 7 inter-agent bus messages.
* **Subagents repeatedly fail to write notes to `/work` (`20`, `26`, LOG 2.4).** Both `judge-clarity` (LOG 2.4) and `chair` (`20-desk-chair-end.png`, `26-files-csv-uploaded.png`) attempt `! write: /work/.subagents/chair.md` and `! write: /work/chair-review-notes.md`, producing red error pills and ending the chair's final answer with `"notes could not be saved as /work is read-only for me."` The harness or skill prompt tells subagents to save notes in `/work` while mounting `/work` read-only (`/work/essay.md ro opfs (narrowed)`), creating self-inflicted errors in the user-visible transcript.

---

### 3. State and Feedback — **2.5 / 5**

* **Stale status line persists indefinitely after turn completion (`19`–`25`, LOG 2.5).** When the user steered the chair at 85s, the status line below the composer read `"Steering chair: it reads this after its current step."` (`19-desk-chair-steered.png`). Minutes later, after the chair and main session had completely finished (`20-desk-chair-end.png`, `21-desk-main-after-stop.png`, `22-desk-final-review.png`, `23-desk-join-no-report.png`, `24-desk-chair-card-expanded.png`, `25-desk-chair-steer-in-transcript.png`), that exact status line remained stuck at the bottom of the screen until a file upload overwrote it in Journey 4 (`26-files-csv-uploaded.png`).
* **Off-campus first visit shows contradictory allowance vs. status (`01-arrive-first-visit.png`, LOG 1.2).** On arrival off-campus without a key, the bottom status line states `"Not signed in: using Campus Pass, which works only on the UCSC network."` Yet both the composer badge and right rail display `"100"` (`"about 100 of 100 Sealed requests left today"`, LOG 1.2). Showing 100 available requests when the user actually has **0 usable requests** from their current network is a false affordance.
* **Key rejection uses native `prompt()` / `alert()` and fails silently on `KEY=value` paste (`05`, `06`, LOG 1.5).** Clicking `"Paste a key you already have"` opens `window.prompt()`. Pasting `BAYLEAF_API_KEY=sk-bayleaf-...` triggers `window.alert("That does not look like an sk-bayleaf- key.")` and closes the flow with no inline feedback (`06-arrive-paste-key.png`). In automated or popup-blocking environments, or for any user copying from a `.env` file, this feels broken.
* **Short-lived subagents finish before a human can steer them (`16-desk-judge-view.png`, LOG 2.4).** Judges run for 15–25s. Opening `judge-clarity` from the sidebar immediately greeted the user with a disabled composer (`"judge-clarity has finished. Go back to Use the panel skill..."`) and two redundant `"Back to Use the panel skill. Review this draft."` buttons (one in the top sticky card, one green pill at the bottom of the transcript).
* **Offline transition is clear and non-destructive (`31-offline-composer.png`, `32-back-online.png`, LOG 6.4).** Going offline immediately updates the header shield, explains what still works locally (`Files, the editor, review, archives and run keep working`), preserves the unsent composer draft with a dashed border (`31-offline-composer-crop.png`), and recovers cleanly within 3s of reconnecting.

---

### 4. Control and Trust — **2.0 / 5**

* **Single `$panel` prompt silently burned 41 Sealed requests (~8% of daily key allowance, or 41% of a Campus Pass) (`22`, `29`, `network.log`, LOG 2.6).** Nothing in the `$panel` skill completion (`11-desk-dollar-completion.png`: `"Review a draft with a panel of subagents (a chair and four judges: argument, evi..."`) warns that spawning 5 subagents with cross-examination will fire **41 LLM requests** in 3 minutes. A user on Campus Pass (100 requests/day) would burn nearly half their daily quota on a single click.
* **Usage panel token table omits or misattributes subagent spend (`29-usage-panel-crop.png`, LOG 6.2).** After 41 Sealed POSTs (`network.log` lines 6–55), the Usage panel (`29-usage-panel-crop.png`) shows `409 of 500 left today` (41 requests used), but under **Tokens by session** it lists only `Use the p... | 12,245 In | 3,468 Out | $0.0420`. Twelve thousand input tokens across 41 multi-turn agent requests is impossible unless subagent tokens (`s2`–`s6`, which accounted for 34 of the 41 requests) are excluded from the session row or under-counted. Furthermore, the table shows a dollar figure (`$0.0420`) without explaining how dollars relate to the request-based daily allowance (`500 left today`).
* **"Stop all" does not abort an in-flight main-agent request (`LOG 2.6`, `network.log`).** When `Stop all` was triggered at 40 POSTs, an in-flight request completed anyway, bringing the total to 41. Stop should abort active `fetch` controllers immediately.
* **Send-mode controls (Steer vs. Queue vs. Stop-and-send) are undiscoverable during work (`14`, `18`, `28`, LOG 3).** Settings (`28-settings-panel-crop.png`) references `"the arrow next to Stop"` to switch between Steer and Queue, and the DOM has a split-button menu (LOG 3), but in `14-desk-panel-8s.png`, `15-desk-panel-subagents-working.png`, and `18-desk-chair-view.png`, the composer shows only a plain round black Stop square with **no split arrow next to it**.
* **Destructive or confusing controls in Trust panel (`03`, `30`, `33`, LOG 6.3, 6.5).**
  * `"Remove the seed layer"` appears in the Trust panel even when no seed archive has been mounted (LOG 6.3).
  * `"Uninstall offline copy"` (styled in destructive red outline) sits immediately beside `"Check for updates"` (`03-arrive-trust-panel-bottom-crop.png`, `33-install-update-check-crop.png`), and first-visit users are told `"Running from: the offline copy in this browser"` on their very first page load (LOG 1.3), making the lifecycle of the service worker cache confusing.

---

### 5. Onboarding and First-Run — **3.0 / 5**

* **Root URL `/` serves a raw directory listing (`LOG 1.1`).** Navigating to `http://127.0.0.1:8742/` exposed Python's directory listing (`icons/`, `manifest.webmanifest`, `models/`, `pouch.html`, `SHA256SUMS`, `sw.js`) instead of serving `pouch.html` via an `index.html` entry point or redirect.
* **First-visit card is concise and grounded (`01-arrive-first-visit-crop.png`).** The green onboarding card clearly explains the three storage tiers (`work`, `pouch`, `tmp`), highlights borrowed-computer hygiene (`Download all, then Erase all`), and offers direct entry points (`Upload files`, `Mount a folder`, `Got it`).
* **Composer autocomplete for `$` and `/` is fast and clear (`11`, `12`, LOG 2.2).** Typing `$pan` (`11-desk-dollar-completion.png`) and `/` (`12-desk-slash-completion.png`) brings up clean, well-aligned completion menus above the composer. Expanding `$panel` into the literal sentence `"Use the panel skill. "` (`13-desk-panel-prompt-crop.png`) is transparent and editable, though losing a visual pill/token means the user cannot see what parameters or request budget the skill entails.

---

### 6. Consistency and Polish — **2.5 / 5**

* **Composer placeholder is vertically clipped whenever the chat column narrows (`14`, `15`, `16`, `18`, `22`, `34`, `36`).** Look closely at the composer in `14-desk-panel-8s.png`, `15-desk-panel-subagents-working.png`, `16-desk-judge-view.png`, `18-desk-chair-view.png`, `34-phone-main-crop.png`, and `36-phone-subagent-view.png`: the textarea has a fixed single-line height (`~24px`), so when placeholder text wraps to a second line (`"Ask Pouch. @ for files, $ for skills, / for\ncommands"` or `"judge-clarity has finished. Go back to Use\nthe panel skill..."`), the top half of the second line is sliced off horizontally by the overflow box!
* **Trust panel mount table clips right-hand column text (`30-trust-mounts-crop.png`, `30-trust-mounts.png`).** In `"What each task can see"`, the left column label `/task/5: subagent judge-audience (done)` forces the right column out of bounds, clipping `/  rw memory` to `/  rw memor`, `/work  rw opfs` to `/work  rw o`, and `/work/essay.md` to `/work/essay`.
* **Double period in subagent completion notice (`16`, `20`, `36`, LOG 6.6).** Because the session was auto-titled `"Use the panel skill. Review this draft."` (with a trailing period), interpolating it into `"<agent> has finished; its report went to <session>."` produces `"..Review this draft.."` (`16-desk-judge-view.png`, `20-desk-chair-end.png`, `36-phone-subagent-view.png`).
* **Modal and sheet styling inconsistencies (`05`, `08`, LOG 1.5, 2.1, 4.1).**
  * `"Sign in to BayLeaf"` (`05-arrive-signin-sheet-crop.png`) and `"/work"` actions (`08-desk-work-actions-crop.png`) use a bold monospace header font (`Sign in to BayLeaf`, `/work`) while panel headers (`Files`, `Settings`, `Usage`, `What can BayLeaf see?`) use sans-serif.
  * In `08-desk-work-actions-crop.png`, `"Download as .zip"` is styled as a solid primary green button while every other folder action (`New file here`, `Upload files here`) is a plain outline button, making `.zip` download look like the default primary action for `/work`.
  * File creation (`New file here`), folder creation (`New folder here`), and API key entry (`Paste a key`) fall back to browser-native `window.prompt()` instead of in-app inputs.

---

### 7. Phone Ergonomics (390x844) — **2.5 / 5**

* **Bottom navigation bar is clean and well-proportioned (`34-phone-main.png`, `36-phone-subagent-view.png`).** The 5-tab bar (`Chat`, `Files`, `Editor`, `409 left`, `More`) gives one-tap access to the major surfaces on a 390px screen without horizontal scroll.
* **Sticky subagent card consumes 40% of the usable viewport on phone (`36-phone-subagent-view.png`).** On `390x844`, the sticky `judge-audience` card at the top is `~245px` tall, the bottom composer + nav bar is `~165px` tall, and the top bar is `~48px` tall, leaving less than half the screen for the transcript—while the previous message's dashed green box bleeds awkwardly behind the top border of the sticky card.
* **Clipped composer placeholders on every phone screen (`34-phone-main-crop.png`, `36-phone-subagent-view.png`).** Both the active placeholder (`"Ask Pouch. @ for files, $ for skills, / for"`) and disabled subagent placeholder (`"judge-audience has finished. Go back to Use"`) wrap to a second line that is sliced in half vertically.
* **Sessions drawer leaves narrow strip of background interactive-looking (`35-phone-sessions.png`).** The drawer (`35-phone-sessions.png`) is clean and readable, though the green key icon and send button remain partially visible in the dimmed 60px strip on the right.

---

## Top 10 Most Important Problems (Ranked by User Impact)

### 1. Multi-agent skills (`$panel`) silently consume ~40+ Sealed requests with no upfront cost estimate or per-turn cap
* **Evidence:** `11-desk-dollar-completion.png`, `22-desk-final-review.png`, `29-usage-panel.png`, `network.log` (lines 6–55: 41 POSTs to `/sealed/v1/chat/completions`), LOG 2.6.
* **Why it matters:** A single `$panel` prompt consumed 41 requests in 3 minutes (over 8% of a 500/day personal key and 41% of a 100/day Campus Pass). Users have no way to know before pressing Enter that a skill spawns 5 communicating agents that iterate dozens of times.
* **Concrete fix:**
  1. Add a cost badge to multi-agent skill completion items in the `$` menu (e.g., `~25–45 requests` right-aligned in muted text in `11-desk-dollar-completion.png`).
  2. In the running-work tray header (`15-desk-panel-subagents-working.png`, `19-desk-chair-steered-crop.png`), display live request spend for the current turn next to `Running: N` (e.g., `Running: 4 · 18 reqs used`).
  3. Ensure `Stop all` immediately calls `AbortController.abort()` on all in-flight `fetch` requests, including `main`.

### 2. Seven `"Subagent X finished / No report."` cards in the main transcript make successful panel runs look broken
* **Evidence:** `23-desk-join-no-report.png`, LOG 2.7.
* **Why it matters:** When `main` calls `subagent: join` on judges that already sent their findings to `chair` via messages, the UI renders a full bordered card per join event saying `"No report."` Seven stacked `"No report."` cards dominate the transcript and falsely signal that the judges produced nothing.
* **Concrete fix:**
  1. Collapse `subagent: join` events into a single compact pill (`Joined 4 subagents (s3–s6)`) by default.
  2. When a subagent's final output was delivered via `agents: message` to another agent (like `chair s2`) rather than returned directly to the caller, replace `"No report."` with `"Reported to chair (s2) · 1 message"` and deduplicate repeated joins on the same already-finished subagent ID.

### 3. Sticky subagent header card consumes ~240px of vertical height and lets scrolling transcript cards bleed behind its top edge
* **Evidence:** `16-desk-judge-view.png`, `18-desk-chair-view.png`, `19-desk-chair-steered-crop.png`, `20-desk-chair-end.png`, `36-phone-subagent-view.png`, LOG 2.4, 6.6.
* **Why it matters:** On both desktop (`18-desk-chair-view.png`) and phone (`36-phone-subagent-view.png`), the sticky subagent card takes up a third of the chat column while scrolled transcript lines peek out above its top rounded border (`top: 8px` offset without an opaque backdrop mask). In `16-desk-judge-view.png`, this sticky card also hides the top of the transcript (where the two failed `write` calls occurred).
* **Concrete fix:**
  1. Collapse the sticky subagent header on scroll (or after 1 line) into a single compact `40px` bar: `[← Main] chair [working] · s2 · 1m 04s · 2 reqs [Details ▾] [Stop]`.
  2. Give the sticky header container `top: 0`, full column width, `background: var(--bg)`, and a solid bottom border so scrolling transcript bubbles never peek out above it.

### 4. Three-column layout on desktop (`1280px`) crushes the chat column to ~360px and slices composer placeholder text in half
* **Evidence:** `14-desk-panel-8s.png`, `15-desk-panel-subagents-working.png`, `16-desk-judge-view.png`, `18-desk-chair-view.png`, `24-desk-chair-card-expanded.png`, `34-phone-main-crop.png`, `36-phone-subagent-view.png`, LOG 2.7, 6.6.
* **Why it matters:** Whenever the chat column is `<450px` wide (three columns open on desktop, or any view on phone), the composer placeholder wraps to two lines inside a single-line-height textarea container, visually slicing the second line of text in half.
* **Concrete fix:**
  1. Set the composer `<textarea>` to auto-size its height to its placeholder (`min-height: 2.75rem` when empty at `<440px` column width, or shorten the narrow-width placeholder to `"Ask Pouch (@ files, $ skills, / help)"` with `white-space: nowrap; text-overflow: ellipsis`).
  2. At viewport widths `<1400px`, auto-collapse the left Sessions sidebar into an overlay drawer when the right Editor/Files panel is open, preserving at least `480px` for the chat column.

### 5. Expanded inline subagent transcripts lack a sticky header or collapse bar, trapping the user inside a 26-item card that looks like the main chat
* **Evidence:** `24-desk-chair-card-expanded-crop.png`, `24-desk-chair-card-expanded.png`, `25-desk-chair-steer-in-transcript.png`, `26-files-csv-uploaded.png` through `34-phone-main.png`.
* **Why it matters:** Once the user clicked `▼ Transcript (26 items)` on the `chair` card in `24-desk-chair-card-expanded.png` and scrolled down, the card header scrolled off-screen. For the remainder of the session (`25`–`34`), the center column looked like the main session transcript (differentiated only by a 2px green left border), and the tester didn't even notice they were still parked inside the chair's inline card during Journeys 4, 6, and Phone!
* **Concrete fix:**
  1. Give expanded inline subagent transcripts a tinted background (`rgba(..., 0.03)`), `max-height: 360px` with internal scroll (or a sticky sub-header `chair transcript (26 items) [Collapse ▲]`), so expanding a subagent card never hijacks the entire main session scroll container.

### 6. Usage panel "Tokens by session" table omits subagent tokens, making 41 requests appear to use only 12,245 input tokens
* **Evidence:** `29-usage-panel-crop.png`, `29-usage-panel.png`, LOG 6.2.
* **Why it matters:** The top of the Usage panel reports 91 requests used (`409 of 500 left today`, 41 from this session), while the session row below reports only `12,245 In / 3,468 Out / $0.0420`. Because subagent turns (`s2`–`s6`) aren't rolled up into the parent session (or aren't labeled), users cannot audit where their requests or tokens went.
* **Concrete fix:**
  1. Roll all child subagent requests and tokens into the parent session row in `Tokens by session`, and add a `Reqs` column (`Session | Reqs | In | Out | Est. value`): e.g., `Use the panel... (incl. 5 subagents) | 41 | 84,120 | 14,910 | $0.28`.
  2. Add a one-line caption explaining that `$ Est. value` is informational and only **Requests** count against the daily 500 Sealed allowance.

### 7. Native `window.prompt()` and `window.alert()` are used for API key entry and file/folder creation, with silent failure on `BAYLEAF_API_KEY=` paste
* **Evidence:** `05-arrive-signin-sheet-crop.png`, `06-arrive-paste-key.png`, `08-desk-work-actions-crop.png`, `09-desk-new-file.png`, LOG 1.5, 2.1, 4.1.
* **Why it matters:** Native browser `prompt()`/`alert()` dialogs break visual trust, cannot validate input inline, get auto-dismissed in headless/extension environments, and reject common `.env` pastes (`BAYLEAF_API_KEY=sk-bayleaf-...`).
* **Concrete fix:**
  1. In `05-arrive-signin-sheet-crop.png`, clicking `"Paste a key you already have"` should reveal an inline `<input type="password" placeholder="sk-bayleaf-...">` inside the modal with a `[Save key]` button, inline validation message, and automatic regex extraction of `/sk-bayleaf-[A-Za-z0-9_-]+/` so pasting `BAYLEAF_API_KEY=sk-bayleaf-...` succeeds automatically.
  2. Replace `window.prompt("New file name")` and `window.prompt("New folder name")` with an inline text input row directly inside the Files tree (or inside the `/work` modal sheet).

### 8. Off-campus unsigned state displays `"100"` available requests next to `"works only on the UCSC network"`, and stale status messages never clear
* **Evidence:** `01-arrive-first-visit.png` (LOG 1.2) and `19-desk-chair-steered.png` through `25-desk-chair-steer-in-transcript.png` (LOG 2.5).
* **Why it matters:** On arrival off-campus (`01`), the gauge reads `100` while the status bar says Campus Pass won't work here. Later (`19`–`25`), `"Steering chair: it reads this after its current step."` stays stuck below the composer long after all agents have finished.Both erode confidence in the status bar and gauge.
* **Concrete fix:**
  1. When `GET /campus-pass` reports the client is off-campus and no personal key is stored, render the usage gauge as `0` (or `Sign in`) with a warning dot, and replace the Send button tooltip/state with `"Sign in with a key to send off-campus"`.
  2. Tie transient status messages (`"Steering chair..."`, `"Added 3 files..."`) to turn/event lifecycle: clear `"Steering <agent>..."` as soon as the steer is delivered or the target agent finishes, and auto-fade action confirmations after 6 seconds.

### 9. Subagents repeatedly fail with red `! write: /work/...` errors because the skill/system prompt and read-only mount conflict, and tool pills dump raw JSON
* **Evidence:** `16-desk-judge-view.png`, `20-desk-chair-end.png`, `25-desk-chair-steer-in-transcript.png`, `26-files-csv-uploaded.png`, `36-phone-subagent-view.png`, LOG 2.4, 6.6.
* **Why it matters:** Users inspecting `chair` or `judge-clarity` see red `! write: /work/.subagents/chair.md` and `! write: /work/chair-review-notes.md` errors and raw JSON pills like `agents: {"action":"message","ids":[],"text...`. It makes the agent harness look misconfigured.
* **Concrete fix:**
  1. If a subagent is spawned with `/work` read-only (`ro`), update the subagent system prompt / harness note hint to point to `/tmp/notes.md` instead of `/work/.subagents/...`.
  2. Format `agents` tool pills in human language instead of `JSON.stringify(args)`: e.g., `message -> chair (s2): "Chair's prioritized review..."`, `message -> s3, s6: "Resolve Oakland disagreement..."`, and `join -> s3, s4, s5, s6`.

### 10. Trust panel ("What can BayLeaf see?") buries actionable controls under 15 lines of wrapped hex digests and clips the namespace mount table horizontally
* **Evidence:** `02-arrive-trust-panel-crop.png`, `03-arrive-trust-panel-bottom-crop.png`, `30-trust-mounts-crop.png`, `30-trust-mounts.png`, LOG 1.3, 6.3.
* **Why it matters:** The Trust panel is a signature differentiator of BayLeaf Pouch, but 64-char hex hashes wrap across 5 lines each in a narrow right-hand column, and in `30-trust-mounts.png` the two-column task namespace table overflows horizontally so every mount path on the right (`/  rw memor`, `/work/essay`) is cut off.
* **Concrete fix:**
  1. Collapse the raw attestation hex rows (`Release`, `Published code`, `Running enclave`, and the 5 `Step: ... success` rows) behind a single summary row: `Enclave verified (v0.0.168 · e71627…94b8a7) [Show attestation details ▾]`.
  2. In `"What each task can see"` (`30-trust-mounts-crop.png`), stack each task as a vertical block (task title on line 1, indented monospace mount lines below it) instead of a side-by-side two-column grid that clips the mount paths.

---

## 5 Things That Work Well and Should Be Protected

1. **Plain-spoken, honest trust and threat-model prose (`01-arrive-first-visit-crop.png`, `02-arrive-trust-panel-crop.png`, `04-arrive-composer-shield-crop.png`).** Statements like *"BayLeaf relays ciphertext and sees who you are (your key, or your IP under Campus Pass), when you send, how many bytes, and which model ran... The weakest link is this page itself"* and *"On a borrowed computer: Download all, then Erase all before you leave"* are models of institutional candor without security theater.
2. **Live mid-turn steering of a running subagent (`18-desk-chair-view.png`, `19-desk-chair-steered-crop.png`, `25-desk-chair-steer-in-transcript.png`, LOG 2.5).** Opening the `chair` while it worked, typing `"It is a draft, ignore citation format."`, seeing `Steering: 1` with a `Cancel` action in the tray (`19-desk-chair-steered-crop.png`), seeing `"You, while it worked"` inline in the transcript (`25-desk-chair-steer-in-transcript.png`), and having the final synthesis explicitly honor the steer is a genuinely great agent interaction pattern.
3. **Graceful offline mode that preserves drafts and explains local capabilities (`31-offline-composer-crop.png`, `31-offline-composer.png`, `32-back-online.png`, LOG 6.4).** Disconnecting from the network immediately shifts the composer border to dashed, disables Send without losing the typed draft, and clearly states which local capabilities (`Files, the editor, review, archives and run`) remain operational.
4. **Fast, legible `$` skill and `/` command autocomplete (`11-desk-dollar-completion.png`, `12-desk-slash-completion.png`, LOG 2.2).** The popup menus above the composer are crisp, keyboard-navigable, and describe each command's effect and safety boundary (`"/erase: Erase all Pouch data in this browser (asks first)"`, `"/revert: Revert the last turn (asks first, can be undone)"`).
5. **Zero console errors and strict network egress discipline (`console.log`, `network.log`, LOG 70–73).** Across the entire play-test, zero runtime JS errors occurred, and `network.log` confirms that not a single third-party font, analytics beacon, or unrequested URL left the browser—only `/campus-pass`, `/sealed/models`, `/sealed/attestation`, `/usage`, and `/sealed/v1/chat/completions`.

---

## Disagreements Between Tester's `LOG.md` and the Screenshots

1. **Trust panel wide-label clipping (`LOG 6.3` vs. `30-trust-mounts-crop.png` / `30-trust-mounts.png`):**
   * *Tester's log (6.3):* `"The README-noted wide-label layout issue did not show here because labels are short."`
   * *Screenshot reality:* `30-trust-mounts-crop.png` and `30-trust-mounts.png` **do** exhibit severe horizontal clipping! Because `/task/5: subagent judge-audience (done)` is wide in the left column, the right column is pushed off the right edge of the panel, truncating the mount definitions to `/  rw memor`, `/pouch  rw`, `/task  rw t`, `/work  rw o`, `/tmp  rw sc`, and `/work/essay`. Moreover, `30-trust-mounts.png` only shows `Agent` and `/task/5` (not `/task/1–4` or `"Remove the seed layer"`, which were further down out of view).
2. **Chronology of `04-arrive-composer-shield.png` (`LOG 1.4` vs. `LOG 1.5`):**
   * *Tester's log (1.4–1.5):* Lists `04-arrive-composer-shield.png` at step 1.4, before signing in at step 1.5 (`05-arrive-signin-sheet.png`, `06-arrive-paste-key.png`, `07-arrive-signed-in.png`).
   * *Screenshot reality:* In `04-arrive-composer-shield.png`, the user is **already signed in**: the usage counter reads `450` (not `100`), the header key icon has its green active dot, and the `"Not signed in..."` status line is gone—whereas `05` and `06` show `100` and `"Not signed in..."`. `04` was captured (or overwritten) after step 1.5.
3. **Visibility of failed `write` pills in `judge-clarity` (`LOG 2.4` vs. `16-desk-judge-view.png`):**
   * *Tester's log (2.4):* `"I read its transcript instead: it tried write /work/.subagents/judge-clarity.md and write /work/judge-clarity.md, both failed ('!' pills: read-only), then wrote /tmp/judge-clarity.md."`
   * *Screenshot reality:* In `16-desk-judge-view.png`, those two failed `! write` pills are completely hidden underneath the tall sticky `judge-clarity` header card (only `► write: /tmp/judge-clarity.md` is visible below the card). Meanwhile, the red `! write: /work/.subagents/chair.md` and `! write: /work/chair-review-notes.md` pills are prominently visible in `20-desk-chair-end.png` and `26-files-csv-uploaded.png`–`33-install-update-check.png`.
4. **Main chat vs. expanded `chair` card in Journeys 4, 6, and Phone (`LOG 2.7, 4.1, 6.x, Phone` vs. `26`–`34`):**
   * *Tester's log:* Treats the chat column in `26`–`34` as the main session view.
   * *Screenshot reality:* After expanding the `chair` card in `24-desk-chair-card-expanded.png` and scrolling into it in `25-desk-chair-steer-in-transcript.png`, the viewport remained scrolled inside the expanded `chair` subagent transcript (`"Final answer: Review sent to main (s1)..."` with the green left border) through all of `26`–`34`. This visually proves Problem #5: once inside an expanded subagent card, even the QA tester couldn't tell they weren't looking at the main session transcript.
