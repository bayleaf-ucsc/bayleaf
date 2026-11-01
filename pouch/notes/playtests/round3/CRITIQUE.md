# BayLeaf Pouch Round 3 Design & UX Critique

**Evidence note:** Reviewed `LOG.md`, `console.log`, `network.log`, `count`, and all 39 PNG screenshots/crops in `/tmp/pouch-qa/play3/`. Direct `.webm` video playback (`50-`, `51-`, `52-*.webm`) is not supported by the image/text viewer in this environment; motion and transitions were judged from timestamped screenshot sequences (`11`–`14`, `20`–`28`, `30`–`36`, `60`–`64`).

---

## Split-Menu Judgment: App Accessibility Issue or Harness Issue?

**Verdict: Both (a harness selector assumption compounded by a real ARIA/UX bug in Pouch).**
- **Harness side:** Inside a `role="menu"`, WAI-ARIA requires items to have `role="menuitem"`, `menuitemradio`, or `menuitemcheckbox`, not `role="button"`. However, the harness's confusion is understandable because Pouch's `/work` folder menu (`04-desk-work-actions.png`, LOG 0.3) renders as a modal sheet of plain `<button>` elements.
- **App accessibility/design bug:** Marking `"Steer now: read after current step (Enter)"` and `"Queue for after this turn"` as `role="menuitemradio"` (`aria-checked="true"` / `"false"`) while `"Stop and send"` is `role="menuitem"` (LOG 3.1–3.2, `20-split-menu-open-crop.png`) is semantically broken. Selecting `"Queue for after this turn"` immediately dispatches the draft into the queue as a **one-shot action** and leaves `aria-checked="false"` (LOG 3.2), whereas a fourth item (`"Change what Enter does"`) is the actual persistent mode toggle. Screen readers announce `"Queue for after this turn, radio menu item, not checked"`, misleading assistive-technology users (and the tester) into believing it toggles a setting rather than sending the message. Visually, `20-split-menu-open-crop.png` shows no radio dots or checkmarks at all.

---

## Scores (1–5)

1. **Visual hierarchy and density: 3.5 / 5**
   - *Evidence:* Clean 50/50 split between chat and editor on desktop (`06-desk-essay-saved.png`, `14-detach-final.png`). However, the right-hand Usage drawer (`40-usage.png`, `40-usage-crop.png`, LOG 6.1) crams a 5-column table into a narrow sidebar, clipping the `Cost` column header to `C` and values to `$0.0` against the icon rail while truncating every session label (`Rewriting Paragraph wit...`). In `04-desk-work-actions.png` (LOG 0.3), `"Download as .zip"` is styled in solid primary green inside a 10-button folder action sheet, hijacking visual hierarchy.

2. **Legibility of agent activity: 4.5 / 5**
   - *Evidence:* Blocking vs detached subagent state is immediately legible across both the inline card and composer tray (`11-detach-main-blocked.png` vs `13-detach-after-enter-3000.png`, LOG 1.2–1.5). Subagent `run` tool pills expand cleanly to show JS source, input files, exit code/timing (`status: ok, exit code 0, 9 ms`), and stdout (`15-subrun-subagent-view.png`, `16-subrun-run-pill-expanded-crop.png`, LOG 2). Subagent report handoff (`Observations: ...`) and final summary card (`14-detach-final.png`) clearly show who did what.

3. **State and feedback: 3.0 / 5**
   - *Evidence:* Strong live tray states for queued and steering messages (`21-split-queued-in-tray.png` through `26-split-q2-cancelled.png`, LOG 3.2). Dragged down by three state bugs: (a) after resolving and saving a file conflict, the error line under the composer still reads `"Not saved: Pouch changed this file meanwhile..."` (`36-conflict-saved.png`, `40-usage.png`, LOG 5.4–5.5); (b) the diff banner claims `"Struck lines are Pouch's version"`, but Pouch's lines are red-highlighted without strikethrough (`33-conflict-diff-crop.png`, LOG 5.4); (c) Session 1 never auto-titled (`40-usage.png`, `60-phone-sessions-drawer.png`, LOG 6.1).

4. **Control and trust (steer, stop, costs against daily allowance, privacy): 4.0 / 5**
   - *Evidence:* Typing while main is blocked on `s2` and pressing Enter detaches main in ~0.5s, answers the side question in ~6s, and folds `s2` into the background tray without losing its eventual report (`12`–`14`, LOG 1.3–1.5). Queue -> Edit -> Re-queue -> Cancel -> Steer now works without losing user text (`21`–`28`, LOG 3.2). Usage (`40-usage.png`, LOG 6.1) reconciles session requests (30) against shared-key external traffic (`Other: 33`, total allowance down 63), resolving the tester's earlier badge confusion (`492` in `13-detach-after-enter-3000.png`, LOG 1.5). *Insufficient evidence this round* for the Trust/attestation panel (`LOG.md` line 3 notes build ID was not inspected) and `Enter right after Stop` (skipped for budget, LOG 6.2).

5. **Onboarding and first run: 4.5 / 5**
   - *Evidence:* First-visit card clearly explains `/work` (browser), `/pouch` (shared), `/tmp` (memory), and Sealed encryption (`01-arrive-first-visit.png`, LOG 0.1). Pasting `BAYLEAF_API_KEY=sk-bayleaf-...` automatically strips the env-var prefix (`02-arrive-key-pasted-crop.png`, LOG 0.2) and updates the allowance badge from `100` (Campus Pass) to `500` (`03-arrive-key-saved.png`).

6. **Consistency and polish: 3.0 / 5**
   - *Evidence:* Status terminology drifts between `finished` (main card badge and disabled composer text) and `done` (subagent view badge) (`14-detach-final.png`, `15-subrun-subagent-view.png`, `62-phone-subagent-open.png`, LOG 6.3). Menu widgets alternate between modal button sheets (`04-desk-work-actions.png`) and ARIA `menuitemradio` popovers (`20-split-menu-open-crop.png`). In diff mode (`33-conflict-diff.png`), the orange bar keeps showing a redundant `Show diff` button while the diff is already open.

7. **Phone ergonomics: 3.5 / 5**
   - *Evidence:* Opening the subagent view on 390x844 lands cleanly at `scrollTop 0` (`62-phone-subagent-open.png`), and scrolling 500px collapses the detail block into a single sticky header line without clipping transcript text (`63-phone-subagent-scrolled-mid.png`, LOG 6.3). However, the sticky header truncates the agent name to `"sales-anal…"` while giving full width to `"24s · 5 req"` and `"Details"` (`62`–`64`), and the disabled composer (`"sales-analyst has finished..."`) plus bottom tab bar consume ~165px of vertical space even when a redundant green `"Back to main"` button appears above it (`64-phone-subagent-bottom.png`).

8. **Continuity: 4.0 / 5**
   - *Evidence:* Strong indigo accent (`● sales-analyst`, left border on subagent card, tray row, and subagent header in `11`, `15`, `61`, `62`) and green dotted file chips (`sales.csv`, `essay.md` in `13-detach-after-enter-3000.png`, `32-conflict-save-pressed.png`) tie entities across panels. Break in continuity: at +500ms after detaching (`13-detach-after-enter-500.png`), the `"You, while it worked"` bubble flashes inside a full-width outer green box that disappears by +1500ms (`13-detach-after-enter-1500.png`), and conflict save errors appear beneath the left-pane chat composer instead of the right-pane editor (`32-conflict-save-pressed.png`). *Too little evidence* to judge build-ID continuity across the trust panel or `$panel` / watch re-run (skipped for budget, LOG 4).

---

## 10 Most Important Problems (Ranked by User Impact)

1. **[BUG] Usage table overflows and clips the Cost column on desktop**
   - *Evidence:* `40-usage.png`, `40-usage-crop.png` (LOG 6.1).
   - *Why it matters:* Users checking their daily spend cannot read the `Cost` column (clipped to `C` and `$0.0`) or distinguish truncated session names.
   - *Fix:* Widen the Usage drawer (or stack `In / Out` tokens into a secondary muted subtitle under each session name) so `Session`, `Requests`, and `Cost` fit within the sidebar with `tabular-nums` and no horizontal overflow.

2. **[BUG] Stale "Not saved" conflict warning remains under composer after resolving and saving**
   - *Evidence:* `32-conflict-save-pressed.png` -> `36-conflict-saved.png` -> `40-usage.png` (LOG 5.3–5.5).
   - *Why it matters:* Telling a user their file is `"Not saved"` after they resolved all hunks and saved erodes trust in the editor and causes panic.
   - *Fix:* Clear the conflict status message whenever the file conflict state resolves (on `Save`, `Done`, `Keep mine`, or `Take theirs`), and display editor save/conflict feedback inside the editor pane rather than under the chat composer.

3. **[DESIGN] Diff view claims "Struck lines are Pouch's version" without strikethrough, and inverts red/green diff conventions without inline labels**
   - *Evidence:* `33-conflict-diff.png`, `33-conflict-diff-crop.png`, `34-conflict-hunk1-take-theirs-crop.png` (LOG 5.4).
   - *Why it matters:* Users must read the prose to deduce that red = Pouch (`Take theirs`) and green = user (`Keep mine`), because nothing is struck through and standard Git diffs use red for old/deleted lines and green for incoming lines.
   - *Fix:* Add explicit inline pill labels (`Pouch's version (theirs)` and `Your version (mine)`) on each hunk block, apply actual `text-decoration: line-through` if keeping that copy (or rewrite the banner to `"Pouch's changes and yours are shown side by side"`), and hide the orange conflict bar's `Show diff` button while the diff view is active.

4. **[BUG] Split-button menu uses `menuitemradio` for one-shot send actions**
   - *Evidence:* `20-split-menu-open-crop.png`, `20-split-menu-open.png` (LOG 3.1–3.2).
   - *Why it matters:* `"Queue for after this turn"` immediately submits the draft and leaves `aria-checked="false"`, confusing screen-reader users, keyboard users, and automation harnesses about whether clicking it sends the message now or changes a persistent mode.
   - *Fix:* Change `"Steer now"`, `"Queue for after this turn"`, and `"Stop and send"` to `role="menuitem"`, visually separate `"Change what Enter does"` with a divider, and show the current Enter default explicitly on that footer item.

5. **[DESIGN] Split send menu chevron is hidden during a running turn until the user types**
   - *Evidence:* `11-detach-main-blocked.png` vs `12-detach-typed-while-blocked.png` (LOG 1.2–1.3, 3.2).
   - *Why it matters:* While Pouch is working, users see only the Stop button (`11`) and cannot discover Steer/Queue or change what Enter does until after they type into the composer.
   - *Fix:* Keep the `Steer | ^` (or mode-config) split control visible in a disabled-send / active-menu state whenever a turn is running, or expose the Enter-behavior toggle before typing.

6. **[BUG] First session never auto-titled after detach/subagent workflow**
   - *Evidence:* `14-detach-final.png`, `40-usage.png`, `60-phone-sessions-drawer.png` (LOG 6.1).
   - *Why it matters:* The session title stays `"Use a foreground subagent and wait for it: have it analyze /"` (truncated mid-word across the top bar, Usage table, and phone drawer), making sessions hard to tell apart.
   - *Fix:* Ensure the automatic title generator runs after the first turn's user prompt regardless of whether main detaches from a foreground subagent, and trim trailing slashes/punctuation when falling back to a prompt prefix.

7. **[DESIGN] Phone subagent header truncates agent name (`"sales-anal…"`) while keeping low-priority stats**
   - *Evidence:* `62-phone-subagent-open.png`, `63-phone-subagent-scrolled-mid.png`, `64-phone-subagent-bottom.png` (LOG 6.3).
   - *Why it matters:* On a 390px screen, the identity of the subagent is cut off in an awkward place while `"24s · 5 req"` and `"Details"` take up prime horizontal space, and `done` contradicts `finished` in the composer below.
   - *Fix:* On narrow viewports, move `"24s · 5 req"` into the collapsible `Details` block so the subagent slug gets full width, unify status wording to `finished` (or `done`) everywhere, and collapse the disabled composer into a compact `"sales-analyst finished — Back to main"` bar.

8. **[DESIGN] Folder action sheet styles "Download as .zip" as the primary green CTA**
   - *Evidence:* `04-desk-work-actions.png` (LOG 0.3).
   - *Why it matters:* Pre-highlighting the 7th item in solid green makes `"Download as .zip"` look like the default/recommended action whenever a user opens `/work` actions to create or upload a file.
   - *Fix:* Render all non-destructive folder actions in neutral button style (or anchor a compact popover menu directly to the folder's `...` button with `role="menu"` and `role="menuitem"`).

9. **[BUG] Double-bordered green container flashes around detached user message at +500ms**
   - *Evidence:* `13-detach-after-enter-500.png` vs `13-detach-after-enter-1500.png` (LOG 1.4).
   - *Why it matters:* Right after pressing Enter to detach, the `"You, while it worked"` bubble is wrapped in a full-width shaded green box that disappears 1 second later, creating a jarring layout jump during a high-attention transition.
   - *Fix:* Render the detached user message directly in its final right-aligned bubble state (`13-detach-after-enter-1500.png`) without the transient outer wrapper.

10. **[DESIGN] No indicator in editor when Pouch is actively reading/editing the open file, nor on the allowance badge when external requests drain quota**
    - *Evidence:* `30-conflict-typing-during-edit.png` (LOG 5.1); `13-detach-after-enter-3000.png` vs `40-usage.png` (LOG 1.5, 6.1).
    - *Why it matters:* Users typing in an open file are surprised by a conflict bar 22s later, and users watching the allowance badge drop by 8 after 5 requests (`500` -> `492`) think Pouch is double-counting.
    - *Fix:* Show a subtle `"Pouch is editing this file…"` pill in the editor header when an `edit`/`write` tool call targets the open path, and add a tooltip on the composer allowance badge showing `"X in this browser · Y other"` when external usage is detected.

---

## 5 Things That Work Well and Must Be Protected

1. **Type-to-detach from a blocking subagent (`11`–`14`, LOG 1.2–1.5):** Typing while main waits on `s2` and hitting Enter detaches main in ~0.5s, answers the side question in ~6s with a clear `"You, while it worked"` marker, folds `s2` into the tray, and still delivers `s2`'s final report and main's synthesis at the end.
2. **Tray controls for queued and steering messages (`21`–`26`, LOG 3.2):** Queuing a draft, pulling it back with `Edit`, re-queuing, promoting to `Steer now`, and cancelling back to the composer (`26-split-q2-cancelled.png`) is fast, reversible, and never loses user text.
3. **Hunk-by-hunk conflict resolution without native dialogs (`31`–`36`, LOG 5.2–5.5):** Intercepting `Cmd+S` during a conflict without a blocking browser alert and letting the user mix `Take theirs` (hunk 1) with `Keep mine` (hunk 2) preserved both Pouch's rewrite and the user's `P.S.`
4. **Honest usage accounting across shared keys (`40-usage.png`, LOG 6.1):** Separating per-session requests (sum = 30, matching network POSTs) from `"Other (not sent by Pouch in this browser): 33"` turns a confusing quota drop into transparent accounting.
5. **Phone subagent scroll-collapse behavior (`62`–`63`, LOG 6.3) & pasted-key sanitization (`02`, LOG 0.2):** Opening a subagent on mobile starts cleanly at the top and collapses metadata on scroll without clipping transcript lines; pasting `BAYLEAF_API_KEY=…` strips the prefix automatically.

---

## Disagreements Between `LOG.md` and Screenshots

1. **Elapsed time in `11-detach-main-blocked.png` (LOG 1.2):** `LOG.md` states both the subagent card and tray row read `3s` in `11-detach-main-blocked.png`; the screenshot shows `2s` in both places (it reaches `3s` in `12-detach-typed-while-blocked.png`).
2. **Completion state at +1.5s and +3.0s after detach (LOG 1.4 vs `13-detach-after-enter-1500.png` & `3000.png`):** `LOG.md` 1.4 says at `+1.5–3 s (13-detach-after-enter-1500/3000.png)` main completes `read: /work/essay.md`, replies with the full background note, and shows footer `"GLM-5.3 · 5:11 PM"`. In `1500.png`, main has not called `read` yet (`Reasoning (in progress)`); in `3000.png`, the reply is still streaming mid-sentence (`"...still working on"`) with no footer and the Stop button still active. The completed reply and `5:11 PM` footer first appear in `13-detach-after-enter-6000.png`.
3. **Buttons listed in `32-conflict-save-pressed.png` (LOG 5.3):** `LOG.md` lists `"Buttons: Save / Show diff / Keep mine / Take theirs"`. In `32-conflict-save-pressed.png`, the orange conflict bar contains only three text buttons (`Show diff`, `Keep mine`, `Take theirs`); there is no `Save` text button (only the header floppy-disk icon).
4. **Truncated and clipped text in `40-usage.png` (LOG 6.1):** `LOG.md` quotes full strings (`"$0.0180"`, `"$0.0382"`, `"$0.0644"`, `"Total (allowance down 63)"`) from the DOM, whereas visually in `40-usage.png` and `40-usage-crop.png` those strings are truncated with ellipses (`"Total (allowance..."`) and the dollar amounts are clipped off the right edge (`"$0.0"`).
