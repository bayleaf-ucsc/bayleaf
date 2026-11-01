# Batch C progress
- started; harness = test/batchC-browser.mjs (copy of batchB open())
## Bug 2 run in subagent: FIXED
- Repro: batchC-browser `subrun` failed "[error] parent.layers is not a function".
- Root cause: tools.js gave `run` the subagent's view, a NinepFs 9P client proxy; run.js `subset(fs,...)` and `rootOf(vfs.ns)` need a Namespace (layers). Main got vfs.as() (a Namespace proxy) so main worked.
- Fix: tools.js viewOf() keeps the subagent's served Namespace; run gets nsFor(caller) (the Namespace, attributed to the subagent); rootOf uses that fs. Card meta now shows "N tool errors" (agent.normalize toolErrors, summary() toolErrors persisted on child row).
- Test passes now.
## Bug 1 folder watch: FIXED
- Repro: batchC `watchdir` (watch /work/data before it exists, New folder + 3-file filechooser upload) timed out with no wake; glob variant `watchglob` already passed.
- Root cause: watch.add only appends /** when the path is an existing folder at registration; for an absent path the pattern stayed a plain path, and matches() is exact equality, so /work/data/jan.csv never matched. Upload attribution (userFs = vfs.as('user')) and settle were fine.
- Fix: watching() also matches anything under a plain path; expand() of a plain path that is now a folder lists its files (rescan on reload).
- batchC-node.mjs watch check fails on HEAD watch.js ("a file under the not-yet-folder is wanted"), passes now.
## Bug 3 diff Save: FIXED
- Root cause: saveFile() in diff mode ran the compare-and-swap first; disk (theirs) != baseline so it raised confirm('Overwrite its version with yours?') and wrote editor.text(); Done/Save left the diff with unsettled hunks silently taking mine.
- Fix: Save in diff = settleDiff() then write; unsettled hunks block both Done and Save with an inline count + "Keep mine/Take theirs for the rest"; CAS failure outside diff raises the conflict bar + status, no dialog. Hunk controls moved to a header bar (editor theme).
- All 21 alert, 12 confirm, 2 prompt replaced: fail() -> status bad, ask() sheet, askName(). batchC-node static check.
- Test `diffsave` failed on header-bar geometry (absolute/overlap) before fix; passes now.
## Bug 4 Enter after Stop: FIXED
- Repro: batchC `enterinreq` (main in a model request, Sealed-like 1.2 s abort wind-down, type, Stop all/Esc, Enter): text left the box and sat as "Steering · after current step" forever (no step left to read it). Blocked-on-subagent variants and the tester's guard click sequence did not reproduce.
- Root cause: busy() stays true while the abort winds down, so Enter took the steer path (box cleared) into a run that was ending; stopMain had already withdrawn steers, so this late one was never placed nor withdrawn.
- Fix: `stopping` set during stopMain; Enter while stopping queues the text (goes as next turn); after the abort settles a second withdrawSteers sweep turns any late steer into the queue. send(): 'Stopped.' with the text absent from the transcript is treated as refused, so dispatch restores it.
## Bug 6 steer during bash: NOT REPRODUCED (guarded)
- Tests `steerbash` (Enter, 4 s), `steerbashnow` (queue + Steer now), `steerbashplay` (tester's exact LOG 3.3 sequence with sleep 40) all pass on current code: sleep runs its course, next request carries "slept" and the steer.
- Screenshots 29/32: the bash pill finished (not "..."), timestamps 2:53 -> 2:54; the steer said "after this, reply with only OK", so the model obeyed it. Output was in the collapsed pill. pi-durable places steers at boundaries; toTool only aborts on context abort or a tray per-call stop.
## Bug 7 Stop names: FIXED
- Composer button aria-label was "Stop Pouch (Esc)" (title copied to the name). Now name = visible label: "Stop", or "Stop all" when this session's subagents run (it stops them too); Esc via aria-keyshortcuts; child view "Stop <name>". Test `stopnames`/`stopnamesphone`.
## Bug 5 Usage: FIXED
- Root cause: Requests column = pi.assistant entries in the transcript (agent.normalize steps) plus finished subagent rows' counts: reverts fold turns away, titles (TinfoilAI chat.completions, outside the harness) never appear, a Stop-cut request has no assistant entry; table-layout fixed + 4.2rem numeric cols squeezed titles to "M.".
- Fix: usage.js createLedger: per allowance day (keyed by resetsAt), counted where requests leave (countRequest in sealedFetch.onRequest; titles via sessions deps.countRequest), base = allowance before the day's first request; reconcile() -> Total row "allowance down N" and Other row; deleted sessions row. CSS: auto layout, 7rem min title, two-line clamp.
- Test `usage` passes (8 sent incl. stopped request, stopped subagent, title; other 3; total 11 = delta; title cell 112 px).
## Before/after (batchC on HEAD source, /tmp/pouch-head; log /tmp/pouch-qa/batchC-head.log)
- FAIL on HEAD: subrun, watchdir, diffsave, enterinreq, enterinreq300, enterinreqesc, stopnames, stopnamesphone, usage (5 vs 8 counted, title 85 px, no total), node: native dialogs + watch.
- pass on HEAD (as expected): watchglob, steerbash, steerbashnow (bug 6 not reproducible).
## Design done so far
- hunk header bar; stopped subagent "Last output before stop" (card + model text says work in progress), placeholder/notice "was stopped"; desktop overlay scrim + Esc/outside close -> composer focus + type-to-compose (layout.js); phone child view opens at top (pinTop until user scrolls), scroll-padding, taller bar; starting-spawn tray row + card from the streaming tool call.
- D12: Revert to here on your own message reverts to just before it and puts its text back in the box (first message: inline refusal, suggest /new). Offscreen "New reply below" pill (#below).
- build.mjs --with-models ok (build af50c58+dirty, sha256 8c16a911...); deploy.mjs --check ok (70 files, 1086 MiB, not deployed).
- test/batchC-sealed.mjs written (CAP 15).
## Final
- All node suites pass; browser: batchA 9, batchB 17, batchC 22, composer, graphs 13, ns 7, pwa 17/17, sendmode 11, subagent 10, watch 16. Updated for intended changes: composer/pwa/walkthrough click the inline Erase/Uninstall sheet; batchB D12 reverts at an assistant reply.
- Walkthrough: subagents-review flapped (hover under the pointer after summary click); scene now moves the pointer away and waits for animations; 3 runs changed 0. graph-chair/review/sidebar images updated (tool-error-free meta, header).
- Real Sealed (test/batchC-sealed.mjs, CAP 15, 15 sent + 2 refused at cap): watch on /work/data woke once on the UI upload naming jan/feb/mar; merged all.csv correct (8 rows, month col) unprompted; background subagent wrote feb-total.txt = 69.99, 0 tool errors (its tool list was not captured, so "used run" is not proven).
- Final build af50c58+dirty; deploy --check ok.
