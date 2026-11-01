# BayLeaf Pouch: joint UX + AX study (2026-10-28)

The study drove Pouch through its UI only, in headless Chromium against `http://127.0.0.1:8742/pouch.html`, which serves the `dist/pouch.html` built at 10:40. It covers upload via row menu, chat, editor, the tree and downloads, with real Sealed model calls (about 47 requests in total). The harness is in `h.mjs` and `s1.mjs`–`s4.mjs`; `r4.mjs` and `layout.mjs` run without the model. Transcripts are in `transcripts/`, screenshots in `shots/`, and exported files in `out/`. To check results independently: `verify1.mjs` compares the cleaned CSV with ground truth from `fixtures/truth.json`, and `verify-todo.mjs` loads each exported todo app in Chromium (add, toggle, clear completed, reload persistence).

Disciplines in play: HCI and usability (review loops, tap economy), agent/tool design (AX: affordances, recovery, round trips), and data-quality practice (what counts as "clean").

---

## Scenario 1: Lab, glm-5-3, CSV cleaning plus essay feedback (D1, D5, R1–R3, O1, O2)

**What the human wanted.** Upload `grades.csv` (57 rows: case and whitespace noise, 6 duplicates, 1 conflicting duplicate, M/D/YYYY and ISO dates, blanks) and a 391-word essay. Get a clean CSV, an account of what changed, and three suggestions on the essay without a rewrite.

**What the model did.** 13 tool calls in 127 s, with 1 error. It listed files, read both, and read `pouch-environment/SKILL.md` before scripting, as the skill asks. It wrote `/tmp/clean.awk` and hit `awk: invalid option -- 'f'`. It recovered by probing awk features three times (split, toupper, string building), then ran an inline awk program, sorted the output, and ran its own validation pass: duplicate keys, ISO regex, whitespace, name shape. Its report gave 19 slash dates converted, 36 already ISO, and 9 names with doubled spaces. **All three counts are correct** (I checked them with grep). It flagged the conflicting Bruno Diaz HW2 rows (82 and 92) and **kept both rather than guessing**, which is the epistemically right call. It left the blank score and blank date as they were ("I won't invent data"). The essay suggestions were specific and quoted the text, and it did not rewrite the essay.

**Verified.** 50 data rows. Every row matches ground truth. The only remaining duplicate key is the flagged conflict, which was deliberate.

**Human review.** The new file did appear in the tree, but with no marker saying it was new or changed. The original and cleaned files can only be viewed one at a time, with no diff or side-by-side view. The only way to judge correctness in the UI is to trust the agent's own validation output in the tool details. Downloading one file and the folder `.tar` both worked: `tar tvf` was clean and the archive held the ustar dir entry plus files.

**Layout bug in the served build.** Before any file is opened, the chat pane at 1400 px is **0 px wide** (`shots/s1-02-after-turn1.png`; `layout.mjs` gives `cols: "288px 0px 1112px"`, `chat: 0`). The composer squeezes into a sliver, so a first-time desktop user cannot read the chat. `dist/pouch.html` (10:40) lacks the `#files/#editor-pane/#chat { grid-column }` rules that `pouch.html` source gained at 11:20, so it looks fixed in source but has not been rebuilt.

**Where they misunderstood each other.** Nowhere substantive. The friction was environmental: the bash description lists awk, and nothing says `-f` is unsupported.

## Scenario 2: Desk, glm-5-3, cross-file feature, R4 collision, AGENTS.md steering (D1, D4, R2–R4, O2)

**Setup through the UI.** `/work/AGENTS.md` says "2-space indentation, never `var`". The fixture is deliberately 4-space and `var`-heavy. With `app.js` open, the human typed an unsaved note on line 1, then asked for "clear completed" plus localStorage.

**What the model did.** 6 calls in 30 s, 0 errors. It started with `cat *` (efficient discovery). It **rewrote** `store.js` and `app.js` with `write`, made targeted `edit`s to `index.html` and `style.css`, and then checked itself with `grep 'var '` and an indentation count. It also tried `node -e 1 2>/dev/null || true` despite the prompt's "no node". That was harmless, but it shows the model probing instead of trusting the prompt. Its reply said why the whole files were rewritten ("Since I was rewriting both JS files anyway, I also converted them to const/let and 2-space indent per the project conventions").

**Verified.** The app works: clear completed removes done items, reload persists, ids stay unique, and there are no page errors. There is no `var` and the indentation is 2-space. The persistence code is good: it tolerates corrupt storage and recomputes `nextId`.

**R4: silent lost update (high).** After the turn, the editor still showed the stale `var` text with "(unsaved)" while the chat beside it said that file had been converted (`shots/s2-02-after-turn.png`). Nothing flagged that the file had changed underneath. I reproduced the mechanism without the model (`r4.mjs`: an external overwrite while the buffer is dirty, then the human presses Save): `agent changes survive? false | reverted to var? true | note present? true`. **Clicking Save quietly reverts the agent's work.** `syncEditor` returns early when the buffer is dirty, and `saveFile` writes blindly.

**Review (R2/R3).** No list of the files changed in the turn and no tree markers. Because the model used `write`, the tool details show the entire new file as a JSON string with `\n` escapes, so there is no diff. With whole-file reformatting the feature change is buried even in a real diff (`diff -u` of `app.js` is about 80 lines for about 10 lines of feature). The `.tar` export was valid.

**Misunderstanding.** The human asked for a feature. The model, following AGENTS.md, also reformatted existing code. It said so, but the reformat makes review much harder. Whether a convention covers new code only or existing code too is unstated, and that ambiguity belongs in the AGENTS.md seed text.

## Scenario 3: same Desk task, smaller models (D5, D6)

**gpt-oss-120b.** 16 calls in 226 s, **stopped at the 15-call cap, task incomplete**. It read the three files separately and edited `store.js` well. In `app.js` it then made one round trip per `var` (`var li =`, then `var box =`, then `var label =`, each with `replaceAll`). One edit failed with an `oldText` that mixed old and new text (`"var form = ...\nconst form = ..."`). The error message ("Read the file and copy the text exactly") worked: it re-read and recovered. The last `! edit: {}` is the call my Stop interrupted, which the UI shows as an error with empty args. **Verified:** the button is present but its handler was never wired up, so clicking it does nothing. Persistence works. One `var` remains and the file is 4-space.

**gemma4-31b.** 7 calls in 27 s, 0 errors. It did `ls -R` and three reads, rewrote `store.js` and `app.js` with `write`, and edited `index.html`. It never looked at `style.css`, so the button has no styling (acceptable). **Verified working**, with 2-space indentation and no `var`. Its summary was accurate but generic ("Updated function expressions to arrow functions for conciseness").

**AX takeaway.** The `edit` contract (one exact match per call) is clear, and every model obeyed uniqueness. But it charges small models one request per change. A multi-edit tool (an array of `{oldText,newText}`) would have cut about 8 of gpt-oss's round trips.

## Scenario 4: Phone, glm-5-3, 390x844, touch (I1, R1, R6)

**Taps (cumulative):** 4 to upload (Files tab, `...`, Upload, OS picker), 6 to ask, 8 to get the file open (Files tab, then the row; the editor tab opens automatically), 1 swipe to find the line, then line tap, typing and Save, for 11 total, and 13 to return to chat and confirm. The answer said "**line 7**", and the editor's line gutter made that findable, but nothing in the answer is tappable (`clickable elements in the answer: 0`). Every tap target was at least 44 px tall.

**Model.** The first turn took 96 s for 2 calls, mostly visible thinking. It gave the line number and a well-argued choice of sentence. **Wrap trap:** the paragraph is one 400-character line, so on the phone `End` jumps to the end of the visual row and the inserted marker landed mid-sentence ("not easy [TODO…]for students to find"). The agent noticed this when it re-read the file and reported the doubled space and the split. That is good AX, but it shows that "line N" is a poor address for prose on a phone.

## Scenario 5: steering via `/work/AGENTS.md` (D4)

The steering ran inside scenarios 2 and 3. glm-5-3 and gemma4-31b both fully complied, removing `var` and using 2-space indentation, which was checked in the exported files. gpt-oss-120b partly complied: it removed `var` one occurrence at a time, ran out of calls, and never reindented. Only glm said explicitly that it was applying the convention to existing code.

---

## Quality per model

| Model | Scenario | Turns | Tool calls | Tool errors | Wall time | Result (verified) |
|---|---|---|---|---|---|---|
| glm-5-3 | 1 Lab CSV + essay | 2 | 14 | 1 (awk -f) | 127 s + 6 s | Correct; conflict flagged, counts accurate |
| glm-5-3 | 2 Desk todo | 1 | 6 | 0 | 30 s | Works; full AGENTS.md compliance; reformatted whole files |
| glm-5-3 | 4 Phone | 2 | 4 | 0 | 96 s + 8 s | Correct answer and self-check of human edit |
| gpt-oss-120b | 3 Desk todo | 1 | 16 (capped) | 1 real + 1 Stop artifact | 226 s | **Broken**: button unwired, one `var`, 4-space |
| gemma4-31b | 3 Desk todo | 1 | 7 | 0 | 27 s | Works; compliant; no CSS |

## Findings

| ID | Story | Severity | Evidence | Proposed change |
|---|---|---|---|---|
| F1 | R4, R5 | High | `r4.mjs`: "agent changes survive? false … reverted to var? true"; screenshot s2-02 shows a stale "(unsaved)" buffer next to "No `var` remains" | Track the disk version when a file is loaded. When an external change hits a dirty buffer, show a banner: "Pouch changed this file: Show theirs / Keep mine (overwrite) / Diff". Make Save compare-and-swap and confirm on conflict. Optionally the agent's write/edit result could say "the user has unsaved edits open in the editor". |
| F2 | A1, D1 | High (served build) | `layout.mjs`: `"cols":"288px 0px 1112px","chat":0`, shot s1-02 | Rebuild dist (the source fix exists) and add a layout check to the test suite at 1400 px with no file open. |
| F3 | R2 | High | The tree shows no change markers; the agent's prose is the only list of changes (s2, s3) | Add a "Changed in this turn" row of file chips under each assistant reply, built from write/edit/bash-touched paths, with a dot in the tree until the file is opened. Tapping a chip opens the file (also F6). |
| F4 | R3, R5 | High | `write` details show the whole file as a JSON string; reformatting buried a 10-line feature in an 80-line diff | Store the pre-image for each mutating tool call and render a unified diff in the tool's details. The same pre-image enables an "Undo this change" action (R5). |
| F5 | D5 | Medium | `awk: invalid option -- 'f'` led to 3 probe calls (about 30 s and 4 requests) | Add "awk/sed programs must be inline (no -f)" to the bash tool description and the pouch-environment skill, or support `-f` in the wrapper. |
| F6 | R6, R2 | Medium | Phone: answer cites "line 7" with 0 tappable elements; 4 taps to reach the line | Linkify `/work/...` paths and `path:line` in replies using DOM nodes built safely (still no HTML parsing). Tapping one opens the editor at that line and switches tab. |
| F7 | D5, D6 | Medium | gpt-oss: one round trip per `var` and incomplete at 16 calls; glm/gemma rewrote whole files with `write` against "Prefer edit" | Accept `edits: [{oldText,newText,replaceAll}]` applied atomically in one call. Say in the description "batch related replacements in one call". |
| F8 | D4 | Medium | glm: "I also converted them to const/let and 2-space indent"; diff blow-up (F4) | In the seeded `/pouch/AGENTS.md` or the system prompt, say "apply style conventions to code you write; ask before reformatting untouched code". That is Adam's policy call. |
| F9 | R6 | Low | Soft-wrapped prose line: `End` went to the visual row end and the marker landed mid-sentence | Phone editor: offer a wrap toggle or a "go to line" field. Prompt: for prose, cite a short quote alongside the line number. |
| F10 | D2 | Low | A Stopped run leaves `! edit: {}` styled as an error | Render interrupted calls as "stopped" (grey), not as errors. |
| F11 | D1 | Low | glm probed `node -e 1` despite "no python/node" | Put the prohibited list once, verbatim, at the top of the bash description (it is there, so this is model noise; the tool is already good). |
| F12 | D1 | Low | glm phone turn 96 s for 2 calls; thinking blocks dominate | Show elapsed time and a "thinking…" indicator so long silences read as work, and suggest a faster model for quick questions. |

What worked well (keep): edit-uniqueness errors that say how to recover; tool details that show exact args; `pouch-environment` being read proactively; `.tar` export; 44 px tap targets; tab auto-switch on opening a file; the agent kept a data conflict for the human to resolve instead of inventing an answer.

## Top 5 recommendations (value/cost)

1. **Rebuild dist and add a no-editor desktop layout test** (F2). Trivial cost; it unblocks first use on desktop.
2. **Make dirty-buffer conflicts visible, and make Save compare-and-swap** (F1). Small change in `syncEditor`/`saveFile`; stops silent data loss.
3. **Add "Changed in this turn" chips plus tree dots** (F3). Moderate cost; turns R2 from a gap into a working story and is the backbone for F6.
4. **Keep pre-images per tool call: diff view plus undo** (F4). Moderate cost; delivers R3 and R5 together, and makes reformatting visible.
5. **Tool wording plus a multi-edit tool** (F5, F7, F8). The awk `-f` note and the convention-scope sentence cost minutes. `edits[]` is a small tool change that most helps the smaller models.
