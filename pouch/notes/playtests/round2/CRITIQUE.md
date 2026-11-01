# Independent Design Critique: BayLeaf Pouch (Play-Test Round 2)

**Evidence reviewed:** `LOG.md`, `console.log`, `network.log`, and all 105 PNG screenshots (`01`–`78`, full viewports and `-crop.png`) in `/tmp/pouch-qa/play2/`.
**Video note:** Direct `.webm` playback is unavailable in this review environment; motion and state transitions were judged from consecutive screenshot sequences (`22`–`26`, `35`–`39`, `48`–`55`, `73`–`78`) alongside `LOG.md` and `network.log`.

---

## Category Scores (1–5)

### 1. Visual Hierarchy and Density: **3.5 / 5**
- **Strengths:** The two-column desktop split (chat on the left, Files/Editor/Trust/Usage/Settings on the right, plus a narrow icon rail) keeps primary workspaces clean (`01-arrive-first-visit.png`, `10-desk-essay-in-editor.png`). Collapsible tool pills (`read`, `write`, `bash`, `watch`) and `Reasoning` disclosures keep multi-step turns compact (`13-desk-panel-6s.png`, `47-files-merged.png`).
- **Failures:**
  - **Diff hunk controls collide with document text (Design bug):** In `20-desk-conflict-diff.png`, the floating `Keep mine | Take theirs` chip bar sits directly on top of line 3 (`"...libraries and research"` is obscured at `"librar[Keep mine][Take theirs]"`).
  - **Usage table truncates session names to a single letter (`61-usage-crop.png`, `61-usage.png`):** Under `Tokens by session`, the `Session` column header is crushed to `S.` and the three session titles render as `M.`, `D.`, and `P..` while numeric columns get generous whitespace.
  - **Sessions drawer overlaps chat without a scrim or push layout (`12-desk-panel-prompt.png`, `16-desk-sidebar-after-panel.png`):** Opening the sessions drawer on desktop covers the left half of the active transcript and composer (`"...s in /work or a mounted folder"`, `":/essay.md."`) with flat white-on-white contrast, so the tester did not even realize the drawer had opened (`LOG 2.2, 2.3`).
  - **Subagent sticky header clips transcript line on phone (`76-phone-subagent-top.png`):** The sticky top bar (`← Merging Monthl... · stopped · 13s · 6 req · Details`) slices horizontally across `"exactly in integer cents with the run tool and write"`, leaving half-letters visible.

### 2. Legibility of Agent Activity: **4.0 / 5**
- **Strengths:** Multi-agent orchestration during the 4-judge panel is remarkably clear (`13-desk-panel-6s.png` through `14-desk-panel-done.png`). The activity tray shows `Running 4 · 6 requests this turn`, distinct color-coded subagents (`judge-argument` indigo, `judge-evidence` amber/brown, `judge-clarity` teal, `judge-audience` purple, `chair` olive), dependency state (`main waits on s2..s5`), per-row `Background` and `Stop`, and inline finished cards (`13-desk-panel-15s.png`). Expanding a judge card (`15-desk-judge-card-expanded-crop.png`) clearly shows the exact prompt and attached `<file path="/work/essay.md">` block.
- **Failures:**
  - **Last pre-stop thought masquerades as a subagent report (`49-sub-bg-joined.png`, `59-state-check.png`, `LOG 5.2`):** When `totals` was stopped after four internal `run` tool failures, the summary card in main displayed `"Subagent totals was stopped: Let me test whether the run tool works at all with a trivial script."` Nothing on the main card indicated that `totals` had suffered four tool errors (`! run: ...` in `76-phone-subagent-top.png`).
  - **Silent 30-second gap before background subagent card appears (`48-sub-bg-6s.png` to `48-sub-bg-27s.png`, `LOG 5.2`):** For 27+ seconds while main formulated the background subagent spawn call, the UI showed only `▸ Reasoning (in progress)` and three dots, with no tray activity.
  - **Steered turn drops original bash output (`32-sending-q3-queued-before-stop.png`, `LOG 3.3`):** After `bash: sleep 40; echo slept` was interrupted or followed by steered `Q1`, the command pill lost its `...` spinner without showing output or a cancelled badge, and the model answered only `Q1`.

### 3. State and Feedback: **2.5 / 5**
- **Strengths:** Offline detection (`63-offline.png`, `63b-offline-composer-crop.png`) is exemplary: the composer border becomes dashed, the placeholder changes to `"Offline: keep typing; Send comes back with the network"`, the header shield drops its checkmark, and an amber footer explains exactly what still works locally (`Files, the editor, archives and run keep working`). Stopping with a queued item (`36-sending-after-stop-1s.png`, `38-sending-paused-tray-crop.png`) cleanly transitions the queued message to `Paused after Stop` with explicit `Send` and `Cancel` actions.
- **Failures:**
  - **Folder watch on `/work/data` never fired after uploading three CSVs (`42-files-after-ask.png` to `45-files-merge-done.png`, `LOG 4.1–4.2`):** Pouch set `watch: /work/data` (`w1 · changes by you · /task/watch/w1`) and promised `"as soon as you drop the three CSVs there... I'll pick it up automatically."` Uploading `jan.csv`, `feb.csv`, and `mar.csv` via the UI (`Added 3 files in /work/data.`) left `Watching: 1` idle for 4 minutes with zero network requests (`network.log` 21:56:25 to 22:00:25).
  - **Subagent `run` tool failed 4 times with a harness error while main's `run` succeeded (`76-phone-subagent-top.png`, `LOG 5.1–5.2`):** Inside `totals`, both inline `run: js: ...` and file-based `run: /work/.subagents/totals.js` and `run: js: print("hello");` failed with red `!` pills.
  - **Typing in composer while a foreground subagent blocks, then pressing Enter after Stop, wiped the user's input (`52-sub-fg-typing-while-blocked.png`, `53-sub-fg-after-enter.png`, `LOG 5.3`):** The user's typed text (`"Mean..."` / `"Meanwhile: is the essay title OK?"`) vanished on Enter without sending or queuing.
  - **Contradictory `stopped` vs `finished` copy in subagent view (`76-phone-subagent-top.png`, `LOG 7.3`):** Header badge and end-of-transcript note say `stopped` (`"totals has stopped; its report went to..."`), while the disabled composer right below says `"totals has finished. Go back to Merging Mon..."`.

### 4. Control and Trust: **3.5 / 5**
- **Strengths:** The Trust panel (`02-arrive-trust-panel.png`, `03-arrive-verified-details-crop.png`, `04b-arrive-build-section-crop.png`, `62-trust-mounts-crop.png`) is a model of honest security communication: it verifies Tinfoil enclave attestation step-by-step, explains that the page itself is the weakest link, provides visual SHA-256 swatches for `Offline copy` vs `Published`, and lists per-task 9P namespace mounts (`/pouch ro indexeddb (narrowed)` for subagents). Skill autocomplete (`11-desk-dollar-completion-crop.png`) previews request cost before execution (`about 9–12 requests`), and the activity tray tracks `N requests this turn` live (`13-desk-panel-6s.png`).
- **Failures:**
  - **Confusing conflict-diff banner + surprise native `confirm()` destroys agent edits on Cmd+S (`20-desk-conflict-diff.png`, `21-desk-save-during-conflict.png`, `console.log` line 11, `LOG 2.5`):** The blue diff banner instructs: *"Keep or take each change, then Done (or Save)."* Pressing Cmd+S while inspecting the diff triggers a browser-native `confirm("Pouch changed this file while you were editing. Overwrite its version with yours?")` (the only native dialog left in the app) and overwrites Pouch's changes with the user's unmerged buffer.
  - **Usage table request counts do not reconcile with allowance spent (`61-usage.png`, `LOG 6.3`):** The gauge dropped from `399` to `357` (42 requests used), and the tester counted 43 `POST /sealed/v1/chat/completions` calls, but `Tokens by session` sums to only 29 (`9 + 9 + 11`). Either reverted branches or stopped subagents are silently omitted from the session table even though they consumed daily allowance.
  - **Misleading Campus Pass network claim (`01-arrive-first-visit.png`, `LOG 1.1`):** Footer states `"using Campus Pass on this campus network (about 100 of 100 shared requests left today)"` whenever `/campus-pass` returns a quota, without clarifying whether the client IP actually matched UCSC or why.

### 5. Onboarding and First Run: **4.5 / 5**
- **Strengths:** Immediate arrival into a working workspace with a concise green orientation card (`01-arrive-first-visit.png`) that explains `/work`, `/pouch`, and `/tmp`, highlights borrowed-computer hygiene (`Download all, then Erase all`), and offers one-click `Upload files` / `Mount a folder` / `Got it`. Key sign-in (`06-arrive-signin-sheet-crop.png`, `07-arrive-key-pasted-crop.png`) smartly strips `BAYLEAF_API_KEY=` when pasting an `.env` line.
- **Minor friction:** In the Trust panel (`02-arrive-trust-panel.png`, `LOG 1.2–1.3`), `Enclave ▶ Verified · v0.0.168 · Details` looks like two separate text links rather than a single `<summary>` row, and `Build 91b1b01` vs `sha256 440ca991e0b7` requires careful reading to distinguish git commit from HTML file digest.

### 6. Consistency and Polish: **3.5 / 5**
- **Strengths:** Native `prompt()` / `alert()` dialogs have been replaced with crisp in-app sheets for Sign In (`06`), New File (`09`), and Revert (`56`). Inline file chips (`all.csv`, `merge_spending.js`, `essay.md` with green tint and dotted underline in `47-files-merged.png`) and tool pills are visually cohesive.
- **Failures:**
  - **One native `confirm()` remains (`21-desk-save-during-conflict.png`, `console.log` line 11).**
  - **Stop button accessible name varies across states (`LOG 7.2`, `console.log`):** Tray has `Stop all` and per-row `Stop`, while the main composer button is `Stop Pouch (Esc)` with a square icon (`73-phone-running-1.png`), causing the tester's budget guard (looking for `Stop`/`Stop all`) to miss it on phone.
  - **Duplicate status text in DOM (`LOG 3.5, 5.3`):** Status lines (`"Stopped. Your unsent message is paused..."`) appear twice in page text extraction because of duplicate live-region/footer rendering.
  - **Split-menu does not close or commit gracefully when a turn finishes (`31-sending-split-menu.png`, `32-sending-q3-queued-before-stop.png`, `LOG 3.4`):** Clicking `Queue for after this turn` just as the turn ended did nothing and left the text sitting in the composer with stale footer text (`"Queued message cancelled and put back in the box."`).

### 7. Phone Ergonomics: **3.5 / 5**
- **Strengths:** Clean bottom navigation bar (`Chat`, `Files`, `Editor`, `357 left`, `More` in `70-phone-main.png`), `$pan` skill completion fits comfortably above the composer (`71-phone-composer-completion-crop.png`), and the subagent view collapses its task header on scroll (`76-phone-subagent-top.png` vs `78-phone-subagent-scrolled-back.png`) with a prominent full-width `Back to Merging Monthly Spending CSVs` button.
- **Failures:**
  - **Sticky header clips transcript text (`76-phone-subagent-top.png`).**
  - **Composer placeholder truncates mid-word (`Ask Pouch. @ for files, $ for skills, / for com...` in `70-phone-main.png`).**
  - **Subagent view opens pre-scrolled to the bottom (`76-phone-subagent-top.png`, `77-phone-subagent-scrolled.png`, `LOG 7.3`),** hiding the subagent's task and early failures unless the user scrolls up (`78`).

### 8. Continuity Across Panels and Time: **4.0 / 5**
- **Strengths:** Subagent identity is preserved via consistent color coding across the running tray (`13-desk-panel-6s.png`), finished transcript cards (`13-desk-panel-15s.png`), expanded transcript border (`15-desk-judge-card-expanded-crop.png`), sessions drawer tree (`16-desk-sidebar-after-panel.png`, `75-phone-sessions-drawer.png`), and subagent detail header dot (`76-phone-subagent-top.png`). Steered messages animate from the tray (`22-sending-steer-in-tray.png`) into the transcript with a distinct `"You, while it worked"` badge (`32-sending-q3-queued-before-stop.png`). File conflict (`18-desk-conflict-bar.png`), offline state (`63-offline.png`), and revert branches (`57-revert-done.png`) all look unmistakably like structural breaks.
- **Failures:**
  - **Chat does not indicate new replies below the fold when scrolled up (`19-desk-apply-done.png`, `LOG 2.5`):** While inspecting an expanded judge card higher in the thread, Pouch finished editing `/work/essay.md` and posted its reply at the bottom, with no `"New reply ↓"` pill in the chat pane.
  - **Revert "to here" on a user message keeps the user message visible but folds away its reply (`56-revert-sheet.png`, `57-revert-done.png`, `LOG 6.1`):** Leaving `"They're uploaded now."` dangling above `"Reverted to 3:00 PM... Other branch: 9 messages Pouch no longer sees"` makes the conversation look mid-turn rather than cleanly rewound.

---

## Top 10 Problems Ranked by User Impact

### 1. [BUG] File watch on `/work/data` fails to wake the agent when files are uploaded (`42`–`45`, `LOG 4.1–4.2`)
- **Evidence:** Pouch called `watch: /work/data`, displaying `Watching: 1 | Watching data: merge the spending CSVs... | w1 · changes by you · /task/watch/w1` (`42-files-after-ask.png`). Uploading `jan.csv`, `feb.csv`, and `mar.csv` into `/work/data` (`43-files-uploaded.png`) produced zero requests over 4 minutes (`44-files-continuing-6s/12s/27s.png`, `network.log`).
- **Why it matters:** Watching a folder for user uploads is a signature workflow. Promising automatic pickup and silently doing nothing breaks trust and leaves the user waiting indefinitely.
- **Fix:** Ensure the OPFS/virtual-FS watch dispatcher resolves paths normalized against newly created directories (when `/work/data` is created after `watch: /work/data` is registered) and emits watch events on multi-file UI upload completions (`Upload files here`). Also append a visible transcript event (`"Watch w1 triggered by 3 files in /work/data"`) when waking the agent.

### 2. [BUG] Subagent `run` tool repeatedly fails with a harness error while main's `run` succeeds (`76-phone-subagent-top.png`, `49-sub-bg-joined.png`, `LOG 5.2`)
- **Evidence:** Main executed `run: /work/merge_spending.js` cleanly (`47-files-merged.png`, `74b-phone-after-run.png`), but inside subagent `totals` (`s2`), `run` failed four times in a row (`! run: js: const text = fs.readFile...`, `! run: /work/.subagents/totals.js`, `! run: js: print("hello");` in `76-phone-subagent-top.png`), burning 6 requests before being stopped.
- **Why it matters:** Subagents are unusable for computation if their narrowed 9P namespace or worker harness breaks QuickJS execution, and they silently burn the user's daily request quota retrying.
- **Fix:** Bind the required runtime mounts (or fix the 9P task namespace path resolution for subagent IDs) in the subagent `run` worker so `run` works identically in main and subagents; surface any tool error badge on the parent's subagent card (`"totals · 4 tool errors"`).

### 3. [BUG + DESIGN] Saving during a diff conflict triggers a native `confirm()` that silently clobbers Pouch's edit (`20-desk-conflict-diff.png`, `21-desk-save-during-conflict.png`, `LOG 2.5`)
- **Evidence:** The diff banner (`20-desk-conflict-diff.png`) says `"Keep or take each change, then Done (or Save)."` Pressing Cmd+S while the diff is open pops a native `confirm("Pouch changed this file while you were editing. Overwrite its version with yours?")` (`console.log` line 11) and saves only the user's pre-diff text (`21-desk-save-during-conflict.png`), discarding all of Pouch's changes.
- **Why it matters:** The banner explicitly invites the user to press `Save` to commit their hunk resolution, yet Cmd+S bypasses the diff state and destroys the agent's work via a reflexive native dialog.
- **Fix:** Remove the native `confirm()`. When the diff view is open, make `Cmd+S` / `Save` commit the resolved merge state (identical to clicking `Done`), or if unresolved hunks remain, show an in-app sheet asking whether to accept remaining hunks as `Mine` or `Theirs`.

### 4. [BUG] Typing in composer while blocked on a foreground subagent, then pressing Enter after Stop, deletes the user's draft (`52-sub-fg-typing-while-blocked.png`, `53-sub-fg-after-enter.png`, `LOG 5.3`)
- **Evidence:** While blocked on `summary` (`51`), the tester typed `"Mean..."` (`52`); when `Stop all` fired and the tester pressed Enter (`53`), the text disappeared from `#input` without sending a request (`network.log`) or creating a message bubble.
- **Why it matters:** Never lose user-typed text in a composer; clearing `#input` when a send is aborted or rejected mid-transition is direct data loss.
- **Fix:** In the composer submit handler, only clear `#input.value` after the message is committed to the transcript, steer slot, or queue; if submission is blocked because a stop just landed, keep the text in `#input`.

### 5. [BUG + DESIGN] Usage panel session table (`29` requests) does not add up to actual allowance spent (`42` requests) and truncates session names to 1 character (`61-usage-crop.png`, `61-usage.png`, `LOG 6.3`)
- **Evidence:** Daily allowance dropped from `399` to `357` (`42` requests), but `Tokens by session` lists `9 + 9 + 11 = 29` requests (`61-usage.png`), and the `Session` column is crushed to `M.`, `D.`, `P..` (`61-usage-crop.png`).
- **Why it matters:** Users rationing a strict daily allowance cannot tell where 13 of their 42 requests went, nor which row is which session.
- **Fix:** Give the `Session` column `min-width: 140px` (or wrap the title above the numbers on a two-line row), and include requests from reverted branches and stopped subagents in the session total (or add a `"Reverted / stopped work: 13 requests"` footer row so the sum matches the daily counter drop).

### 6. [DESIGN] Diff hunk action buttons overlap and obscure editor text (`20-desk-conflict-diff.png`, `LOG 2.5`)
- **Evidence:** In `20-desk-conflict-diff.png`, the `Keep mine | Take theirs` buttons are positioned `absolute` at the top-right of the first red deletion block, covering `"libraries and research"` on line 1 and bleeding into line 2.
- **Why it matters:** Users cannot read the exact words they are choosing to keep or discard.
- **Fix:** Render a dedicated hunk header bar above each diff block (or in the gutter/margin outside the text flow) so `Keep mine | Take theirs` never overlaps document characters.

### 7. [DESIGN] Stopped subagent card displays its last internal retry thought as if it were the final report (`49-sub-bg-joined.png`, `59-state-check.png`, `76-phone-subagent-top.png`, `LOG 5.2, 7.3`)
- **Evidence:** In `49-sub-bg-joined.png`, the card in main reads `stopped | Subagent totals was stopped | Let me test whether the run tool works at all with a trivial script.` And in `76-phone-subagent-top.png`, the header says `stopped` while the disabled composer says `"totals has finished."`
- **Why it matters:** Presenting an incomplete internal thought as a report misleads both the user and the parent agent, and calling a stopped subagent `"finished"` in the composer is contradictory.
- **Fix:** Prefix last-message excerpts on stopped cards with `"Last output before stop:"` (or `"No final report (stopped after 4 tool errors)"`), and change the disabled composer placeholder for stopped subagents to `"totals was stopped. Go back to <session> to continue."`

### 8. [DESIGN] Desktop sessions drawer overlays half the chat and steals keyboard focus without a backdrop (`12-desk-panel-prompt.png`, `16-desk-sidebar-after-panel.png`, `LOG 2.2, 2.3`)
- **Evidence:** In `12-desk-panel-prompt.png` and `16-desk-sidebar-after-panel.png`, the sessions drawer floats over the left half of the chat column with no backdrop dimming; in `2.2`, pressing Enter in the composer failed silently because focus was trapped outside `#input`.
- **Why it matters:** The drawer looks visually detached and ambiguous, and users typing after checking sessions lose their Enter keystroke.
- **Fix:** Add a semi-transparent backdrop scrim (`rgba(0,0,0,0.18)`) behind the overlay drawer when the right workspace pane is open, close the drawer on `Esc` or outside click, and return focus to `#input` when the drawer closes.

### 9. [DESIGN] Phone subagent sticky header clips scrolling transcript text and opens at the bottom (`76-phone-subagent-top.png`, `78-phone-subagent-scrolled-back.png`, `LOG 7.3`)
- **Evidence:** In `76-phone-subagent-top.png`, text under the sticky header (`← Merging Monthl...`) is cut in half horizontally (`"exactly in integer cents..."`), and opening the subagent jumps straight to the bottom rather than the task description (`78`).
- **Why it matters:** Clipped text looks broken, and landing at the bottom of a subagent run forces the user to scroll backward to understand what the subagent was asked to do and why it failed.
- **Fix:** Give the sticky header an opaque background with `overflow: hidden` and proper top scroll-padding on the transcript container, and open subagent transcripts at the top (or with the task summary visible) when entered from the sessions drawer or `Open` button.

### 10. [BUG + DESIGN] Steered turn with a running `bash` command drops command output and leaves the bash pill without a terminal state (`29-sending-steer-now.png`, `32-sending-q3-queued-before-stop.png`, `LOG 3.3`)
- **Evidence:** In `29-sending-steer-now.png`, `▸ ... bash: sleep 40; echo slept` is running while `Q1` is steered in. In `32-sending-q3-queued-before-stop.png`, `sleep 40` finished early (under 40 s), the pill reads `▸ bash: sleep 40; echo slept` with no output or interrupted marker, and the model replied only `OK` to `Q1`.
- **Why it matters:** Steering is meant to guide an in-progress turn, not silently swallow the result of the running tool call.
- **Fix:** If `sleep` is capped or simulated in the browser shell, show the actual exit status/duration on the pill (`bash: sleep 40; echo slept · 2s`), and ensure the tool output is still delivered to the model context alongside the injected steer message.

---

## 5 Things That Work Well and Must Be Protected

1. **Multi-agent panel orchestration and color-coded identity (`13-desk-panel-6s.png`, `14-desk-panel-done.png`, `15-desk-judge-card-expanded-crop.png`, `16-desk-sidebar-after-panel.png`):** The four parallel judges + chair workflow is a triumph of legibility. Each subagent gets a distinct color that carries across its tray row, inline card, expanded transcript border, and session-tree dot, and the chair's synthesized numbered recommendations (`"Pick numbers to apply"`) make multi-agent critique immediately actionable.
2. **Pre-spend cost estimates and live per-turn request counters (`11-desk-dollar-completion-crop.png`, `13-desk-panel-6s.png`):** Showing `"about 9–12 requests"` inside the `$panel` autocomplete menu before the user commits, and `"Running 4 · 6 requests this turn"` live in the tray, makes request-budgeted agent use predictable and fair.
3. **Steer vs. Queue controls and `Paused after Stop` safety (`22-sending-steer-in-tray.png`, `23-sending-queued-item.png`, `38-sending-paused-tray-crop.png`):** Rendering steered messages in the transcript as `"You, while it worked"`, offering one-click `Edit / Steer now / Cancel` on queued messages, and pausing queued messages after `Stop` instead of auto-firing or discarding them are all exceptionally thoughtful interaction patterns.
4. **Honest, inspectable security & attestation UI (`02-arrive-trust-panel.png`, `03-arrive-verified-details-crop.png`, `04b-arrive-build-section-crop.png`, `62-trust-mounts-crop.png`):** Plain-language threat modeling (`"The weakest link is this page itself"`), live Tinfoil enclave measurement verification, visual SHA-256 color swatches comparing the offline and published copies, and explicit 9P mount tables set a high bar for verifiable web apps.
5. **Graceful offline mode and `.env`-smart key paste (`07-arrive-key-pasted-crop.png`, `63-offline.png`, `63b-offline-composer-crop.png`):** Automatically stripping `BAYLEAF_API_KEY=` on paste removes a classic developer paper-cut, and the offline composer state clearly communicates what still works locally while preserving the user's ability to draft.

---

## Places Where `LOG.md` and the Screenshots Disagree

1. **Desktop sessions sidebar visibility (`LOG 2.3` vs. `12-desk-panel-prompt.png`, `16-desk-sidebar-after-panel.png`, `16b-desk-sidebar-check.png`):**
   - *Log claim:* In `2.3`, the tester wrote: *"Sidebar: I clicked Show sessions but in this layout (Editor panel open) I never saw a sidebar in the screenshots (`13-desk-panel-15s/27s/42s.png`, `16-desk-sidebar-after-panel.png`, `16b-...`); I am not sure whether it opened and was hidden, or toggled closed."*
   - *Screenshot reality:* Both `16-desk-sidebar-after-panel.png` and `16b-desk-sidebar-check.png` (as well as `12-desk-panel-prompt.png`) clearly show the `BayLeaf Pouch` sessions drawer open on the left side of the viewport! In `16` and `16b`, it lists `Panel Review of Essay` and all five finished subagents (`chair`, `judge-audience`, `judge-clarity`, `judge-evidence`, `judge-argument`). The tester missed it because it overlays the left half of the chat without a dark backdrop scrim.
2. **Mid-turn usage badge updates (`LOG 2.3` vs. `13-desk-panel-6s.png`, `13-desk-panel-15s.png`, `13-desk-panel-27s.png`, `13-desk-panel-42s.png`, `14-desk-panel-done.png`):**
   - *Log claim:* In `2.3`, the tester wrote: *"Usage badge stayed at 399 throughout the run and only updated (389) after the turn."*
   - *Screenshot reality:* While `13-desk-panel-6s.png` shows `399`, `13-desk-panel-15s.png`, `13-desk-panel-27s.png`, and `13-desk-panel-42s.png` all show the badge updated to **`393`** (in both the composer and the right rail) while the turn is still running, before dropping to `389` in `14-desk-panel-done.png`. `network.log` (lines 13–23) confirms `GET /usage` polled and updated mid-turn as the judge subagents completed.
3. **Foreground subagent tray buttons (`LOG 5.3` vs. `51-sub-fg-blocking-crop.png`):**
   - *Log claim:* In `5.3`, the tester wrote: *"tray showed 'summary: Read /work/essay.md... / Send / Stop' (a per-row Send, i.e. message the subagent) and 'main waits on' (`51-sub-fg-blocking-crop.png`)."*
   - *Screenshot reality:* `51-sub-fg-blocking-crop.png` shows `summary: Read /work/essay.md (do not modify it). ... main waits on s3 | 0s | Background | Stop`. The button is **`Background`**, not `Send` (`Send` only appears on paused queued items in `38-sending-paused-tray-crop.png`, and `Message` appears on stopped subagent cards in `49-sub-bg-joined.png`).
4. **Revert message count expectation vs. actual sheet (`LOG 6.1` vs. `56-revert-sheet.png`, `57-revert-done.png`):**
   - *Log claim:* The tester noted surprise that reverting "to" their own message (`"They're uploaded now."`) kept that message visible while folding away Pouch's reply.
   - *Screenshot reality:* In `56a-revert-hover.png`, the revert arrow (`↶`) sits in the action bar directly under the user bubble `"They're uploaded now."` at `3:00 PM`, so `"Revert to 3:00 PM"` literally means reverting the conversation state to the moment right after that user message was posted (though without a "Re-run from here" button, leaving the unanswered user bubble looks visually stranded in `57-revert-done.png`).
