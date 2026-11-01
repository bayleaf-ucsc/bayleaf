# Pouch play log, round 3 (QA subagent, 2026-10-30)

Setup: Playwright (openchamber-maxwell), Chromium headless, fresh persistent profile `/tmp/pouch-qa/play3-profile` (deleted at the end), target https://pouch.bayleaf.dev/. Desktop 1280x800, phone 390x844 (mobile+touch). Controller `/tmp/pouch-qa/play3-ctl/ctl.mjs` (adapted from round 2) counts POSTs to `api.bayleaf.dev/sealed/v1/chat/completions` (`count` file, `network.log`); console errors/warnings in `console.log`. This round the controller has **no auto-Stop guard** and **dismisses** (does not accept) any native dialog; none occurred. Times are controller seconds (`t`), which are also roughly the offsets into the raw video `rawvideo/page@55ae…webm` (desktop context, ~1 s lag). "s=" is Sealed POSTs so far. Budget 30, all 30 used. I did not read the build id off the trust panel this round (build per brief: c41c8b2).

Console over the whole run: only "No available adapters." (WebGPU) warning once per launch. No page errors. No native dialogs.

## 0. Arrival, key, files (s=0)

- **0.1 Open.** First-visit card as in round 2; default model GLM-5.3; Campus Pass shows "100" (`01-arrive-first-visit.png`). "Got it" dismissed it.
- **0.2 Key.** Sign in → sheet → pasted the whole `BAYLEAF_API_KEY=…` line via clipboard; field held only `sk-bayleaf-…` (43 chars, prefix stripped). Save key → badge "500 of 500 Sealed requests left today" (`02-arrive-key-pasted(-crop).png`, `03-arrive-key-saved.png`).
- **0.3 Harness slip (mine, no request):** my first attempt to upload treated the folder menu items as `menuitem`; they are plain buttons in a centered sheet ("/work: Collapse, New file here, New folder here, Upload files here, Upload a folder here, New file from clipboard, Download as .zip, Download as .tar, Mention in chat, Cancel") (`04-desk-work-actions.png`). Confusion: "Download as .zip" is shown pre-highlighted in solid green, which reads like the default/primary action of a folder menu. My controller crashed and restarted here (profile kept the key).
- **0.4** Uploaded `/work/sales.csv` (48 rows: date, region, product, units, price) via Upload files here; status "Added 1 file in /work." New file here → in-app sheet → `essay.md`; typed 4 paragraphs (para 3 deliberately weak "Everyone knows… My friend… So it is obvious") and Cmd+S (`05-desk-essay-created.png`, `06-desk-essay-saved.png`).

## 1. Detach: typing to main while it is blocked on a foreground subagent (s=0 → 10)

- **1.1 Send (t=46.5).** "Use a foreground subagent and wait for it: have it analyze /work/sales.csv step by step with the run tool (row count and columns, then revenue per region, then per month), and report back. Then summarize its findings for me in three bullets." (`10-detach-prompt.png`)
- **1.2 Blocked (t=52.5, ~6 s, s=3).** Main ran `bash: head -3 … && wc -l`, said "Spawning a foreground subagent… I'll wait for its report." Card "sales-analyst · running · s2 · 3s · 0 requests · Open / Message / Stop". Tray: "Running 1 · 3 requests this turn · Stop all", row "sales-analyst: Analyze … main waits on s2 · 3s · Background · Stop" (`11-detach-main-blocked(-crop).png`).
- **1.3 Typing while blocked.** Clicked main's composer and typed "Meanwhile: what is the title of my essay in /work/essay.md? One line." The send button changed to a split "Steer | ⌃" next to the round Stop (`12-detach-typed-while-blocked.png`).
- **1.4 Enter (t=55.3).** Expected: blocking call detaches, main answers me, subagent continues. Outcome, all three:
  - +0.5 s: composer empty, s=4 (a request went out immediately).
  - +1.5–3 s (`13-detach-after-enter-1500/3000.png`): my message appears as a right bubble labeled **"You, while it worked"** under the subagent card; main does `read: /work/essay.md` and replies with the title "Should first-year students use AI tutors?" plus "(The sales-analyst subagent is still working on sales.csv in the background — I'll post its three-bullet summary when its report arrives.)" Footer "GLM-5.3 · 5:11 PM". The tray row changed from "main waits on s2 · Background" to "subagent s2, /task/1 · Stop" (no Background button any more): this is the fold into the tray.
  - Main's reply landed ~3 s after Enter.
- **1.5 Report (idle at t=82.6, s=10).** Subagent card turned "finished"; a dashed-border bubble (the subagent's message to main) showed "Observations: Biggest region is east (~30.2%)…"; main then posted "Done — here's the analysis of sales.csv in three bullets" (shape: 48 rows, 6 months × 4 regions × 2 products; revenue by region, total 13,245.00, east 3,994.50; revenue by month with Feb weakest 1,806.00, Apr best 2,521.50) and "Full notes are in sales-analyst.md". Final card "finished · Subagent sales-analyst finished · Sent its findings to main (s1): "sales.csv analysis complete (3 steps via run tool; full notes in /work/.subagents/sales-analyst.md)…"" (`14-detach-final.png`). Whole journey ~36 s, 10 requests (main 5, subagent 5).
- Video: `50-detach-blocked-to-report.webm` (42 s: send → blocked tray → typing → Enter → fold → report).
- Confusion: the usage badge read 492 when I had counted 5 requests (explained later by the Usage "Other" row, see 6.1). I did not try the tray's **Background** button on a second blocking subagent: no budget.

## 2. Subagent `run` proof (s=10, no requests)

- Card → Open → subagent view. Three run pills: "run: js: // Step 1: parse the CSV (handles quoted fields…", "// Step 2: total revenue (units * price) per region + grand total", "// Step 3: … per month, chronological order" (`15-subrun-subagent-view.png`).
- Expanded Step 2: the JS source, `{"files": ["/work/sales.csv"]}`, then **"status: ok, exit code 0, 9 ms"**, stdout "east: 3994.50 / west: 3852.00 / north: 3117.00 / south: 2281.50 / Grand total: 13245.00" (`16-subrun-run-pill-expanded(-crop).png`). Unlike round 2, `run` succeeded inside the subagent every time (no "!" pills).

## 3. Split menu: Queue, Steer now, Edit, Cancel (s=10 → 26)

- **3.1 First attempt (new session, t≈128–190, s=10 → 23, 13 requests).** "Do this one tool call at a time, never batching: write /work/notes/a.txt … e.txt, then ls -l, then read each back." Typed Q1 into the composer, opened "More ways to send": menu "Steer now: read after current step (Enter) / Queue for after this turn / Stop and send / Change what Enter does" (`20-split-menu-open.png`, from this first attempt; overwritten by 3.2's identical state, see below). My script then looked for the items as buttons; they are `menuitemradio` (Steer now aria-checked=true, Queue aria-checked=false) and "Stop and send" is `menuitem`. My click timed out, the menu closed, the turn ran to completion (13 requests; session auto-named "Sequential Note File Operations") and Q1 stayed unsent in the composer (`27-split-state-after-fail.png`). Harness error, but also a raw confusion: Queue being a *radio* made me wonder whether picking it changes Enter's mode permanently or sends just this message.
- **3.2 Retry with a cheap long step (same session, sent t=235.9).** "With a single run tool call (js), busy-wait for 25 seconds…". The "More ways to send" chevron did not appear for the first 8 s after sending (it appeared only after I typed into the composer; I think it is shown only when there is a draft). Then within ~3 s:
  - Typed Q1, chevron → menu open (`20-split-menu-open(-crop).png`), clicked **Queue for after this turn**: composer emptied; tray buttons "Edit queued message (Alt+Up) / Steer now: send the queued message into the current turn / Cancel queued message" (`21-split-queued-in-tray.png`).
  - **Steer now** on the queued item: tray now "Cancel steering message" (`22-split-steer-now.png`).
  - After choosing Queue once, the send button still said "Steer" and Queue's aria-checked stayed false: so Queue in the menu is one-shot, not a mode change.
  - Typed Q2, menu → Queue (`23-split-q2-queued.png`); **Edit**: Q2's text back in the composer (`24-split-q2-edit.png`); appended " (edited)", menu → Queue again (`25-split-q2-requeued.png`); **Cancel**: composer holds "Q2: then also write /work/notes/f.txt with zeta. (edited)" (`26-split-q2-cancelled.png`).
- **3.3 Outcome (idle t≈272, s=26, 3 requests).** Q1 appeared in the transcript as a steer; main's reply: "The 25s busy-wait was killed at the run tool's 5-second limit (exit 124, "waited" never printed); /w…" (then answered the file count). So `run` has a 5 s limit, and the "long step" lasted ~5 s, not 25 (`28-split-turn-done.png`). The cancelled Q2 was not sent.
- Video: `51-split-queue-steer-edit-cancel.webm` (40 s).

## 4. Panel + watch re-run: NOT DONE

Skipped for budget: `$panel` costs ~9–12 requests and I had 7 left after 3.1's 13-request miss. The watch/re-run offer therefore was not exercised either.

## 5. Conflict path (new session, s=26 → 30)

- **5.1 Send (t=287.1).** "Rewrite only paragraph 3 of /work/essay.md … Use a single edit … Reply in one line." 2 s later I clicked the end of the open editor and typed "\nP.S. Written by me while Pouch was editing." without saving (`30-conflict-typing-during-edit.png`).
- **5.2 Conflict bar (t=309.2, ~22 s after send).** Bar appeared (`31-conflict-bar(-crop).png`).
- **5.3 Cmd+S while the bar is up.** No native dialog (controller logged none). Instead the status line under the composer: "Not saved: Pouch changed this file meanwhile. Show diff, Keep mine or Take theirs, then Save." Buttons: Save / Show diff / Keep mine / Take theirs (`32-conflict-save-pressed.png`).
- **5.4 Show diff** (`33-conflict-diff(-crop).png`): blue bar "Struck lines are Pouch's version, the rest is yours. Keep or take each change, then Done (or Save)." + Done; orange bar "Pouch changed this file while you were editing. Show diff / Keep mine / Take theirs"; editor header "/work/essay.md (unsaved)". Two hunks, each with its own row of "Keep mine | Take theirs" above the hunk (not overlapping text this time). Hunk 1: Pouch's new paragraph 3 in red, my old paragraph 3 in green. Hunk 2: Pouch's side empty (red), my P.S. (green). Confusion: the banner says "Struck lines", but Pouch's lines are red-highlighted, not visibly struck through; I had to infer red = Pouch from the content.
- **5.5 Resolve.** Hunk 1 **Take theirs** (`34-conflict-hunk1-take-theirs(-crop).png`), hunk 2 **Keep mine** (`35-conflict-hunk2-keep-mine(-crop).png`), then **Save**: no dialog; header back to "/work/essay.md", save icon greyed; file contains Pouch's evidence paragraph ("…a randomized trial in math classrooms…") and my P.S., and not the old anecdote (`36-conflict-saved.png`). No edit lost.
- Confusion: after the successful Save, the status line under the composer still said "Not saved: Pouch changed this file meanwhile…" (`36`).
- Main's reply "Rewrote paragraph 3 of essay.md in a single edit…", footer "GLM-5.3 · 23s"; 4 requests (read, edit, reply, + title). Session auto-named "Rewriting Paragraph with Evidence".
- Video: `52-conflict-type-diff-save.webm` (55 s).

## 6. Quick checks

- **6.1 Usage Total row (no request).** `40-usage(-crop).png`: "Rewriting Paragraph with Evidence 4 · 613 · 2,939 · $0.0180", "Sequential Note File Operations 16 · 5,712 · 4,860 · $0.0382", "Use a foreground subagent and wait for it: have it analyze / 10 · 18,676 · 5,359 · $0.0644", "**Other (not sent by Pouch in this browser) 33**", "**Total (allowance down 63)** 63". Session rows sum to 30 = my POST count exactly (subagent requests included in the 10). Allowance 500 → 437. The "Other" footnote explains: same key on another device/tool. I assume the 33 is other concurrent use of the same key (not by me in this browser). The first session's name is the raw prompt, cut off mid-word ("…have it analyze /"), unlike the other two auto-named sessions.
- **6.2 Enter right after Stop: NOT DONE** (needs a running turn = requests; budget exhausted).
- **6.3 Phone 390x844, subagent view (no request).** Sessions drawer lists the three sessions without nested subagents (`60-phone-sessions-drawer.png`); tapping the session and then the card's Open opened the subagent view **at the top** (scrollTop 0): sticky header "← main · ● sales-anal… · done · 24s · 5 req · Details", then "s2 · subagent of main", the task (3 lines), "Messages ● to main (s1) 1", "Sees: /pouch ro indexeddb (narrowed) /tmp rw scratch /work rw opfs" (`62-phone-subagent-open.png`; `61-phone-main-card.png` is the card in main). Scrolled 500 px: the header collapses to the one-line row and transcript text slides under it cleanly, no partial lines clipped visibly (`63-phone-subagent-scrolled-mid.png`). Bottom: `64-phone-subagent-bottom.png`. Confusions: the badge says "done" while the disabled composer says "sales-analyst has finished. Go back to main …"; the subagent name truncates to "sales-anal…" while "24s · 5 req" gets full width.

## Could not do / caveats

- Panel + watch re-run (4): skipped for budget.
- Tray **Background** button on a second blocking subagent (part of 1): skipped for budget.
- Enter right after Stop (6.2): skipped for budget.
- 3.1 wasted 13 requests because my selector expected buttons in the split menu; the menu itself opened fine.
- Raw videos kept in `rawvideo/` (desktop ~6 min `page@55ae…`; phone `page@4c3e…`); cuts are `50-`, `51-`, `52-*.webm`. Profile deleted. Requests: 30/30.
