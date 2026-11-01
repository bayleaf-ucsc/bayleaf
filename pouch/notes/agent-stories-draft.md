# Agent stories for evaluation (draft, 2026-11-01)

Mined from [JOURNEYS.md](../JOURNEYS.md) (IDs as of 2026-11-01). Companion to
[media-stories-draft.md](media-stories-draft.md), which holds AG1-AG9; IDs here continue at AG10.
Draft only: not yet merged into JOURNEYS.md (other work is editing it).

**Status (Adam, 2026-11-01):** passing agent stories is not a gate. First run two or three of
these by hand (one deterministic, one judged, one harness feature; two contrasting models)
and write it up in `notes/playtests/`; the right next step, including whether the runner in
the Gaps section is worth building, should come from how that feels. Read the eval sketches
below as a menu, not a plan.

## 1. Frame

User journeys are judged by what a person sees: a panel, a tray row, a file that changed.
That works for UI regressions but mixes three things when a journey fails: the model, the
harness (prompt, tools, errors, namespaces), and the UI. Agent stories pull the middle layer
out: "As an agent, I want ... so that ..." names what the model inside Pouch needs, and each
story comes with a **scripted task, a grader and a pass/fail signal** that runs the same way
against:

- **models**: BayLeaf Sealed (GLM-5.3 and siblings), Localhost (oMLX: MiniCPM5-2B, Qwen), and
  Transformers.js (LFM3 1.7B in the browser);
- **harness changes**: a prompt edit, a new tool, an error string, a namespace rule. Rerun the
  set before and after; a scripted fake model (as in `test/graph-fixture.js`) catches pure
  harness regressions with zero requests.

Two design lenses (disciplines: software testing, HCI/AX, and a little psychometrics):

- **AX**: the story is written from inside the agent, so a failure points at a missing
  affordance (as AG1 pointed at `look`) rather than at "the model is dumb".
- **Poka-yoke for small models**: a good harness makes the wrong move hard or self-correcting.
  Graders therefore score the *path* as well as the end state (repeated identical failing calls,
  calls over budget), because a 2B model that reaches the right file by brute force is a
  harness finding, not a pass to celebrate.

Each story lists: derived journeys; harness features; an eval sketch (fixture, prompt, grader,
pass, request budget); the tiers it discriminates (F = frontier Sealed, M = mid Localhost 2-4B
on oMLX, S = LFM3 in browser); and existing coverage. "Det." means a deterministic grader;
"judge" means it needs a model or human judgment for part of the score.

Prior art worth reusing: `experiments/lfm3-webgpu/qualification/tasks.mjs` already has the
right shape (files, prompt, `check(files, result, answer)`), a CORE/HELD_OUT split against
overfitting, and failure classes in `qualify.mjs` (`pass parse cap wrong timeout load other`).
`test/ax-cli.mjs` exposes the page's exact prompt and tools from Node. The `*-sealed.mjs`
tests are live but UI-coupled and bespoke. (Note: `test/journeys/` holds per-journey browser
scripts `t1`-`t17`, debug probes and `reports/` (AX, UX and joint studies, research
notes); its runs are recorded in `JOURNEYS.md`. It has no `tasks.mjs`. A few probes
import from an absolute path of the old `bayleaf-pouch` checkout and need that path
changed before they run.)

## 2. Agent stories

### Bring files in

- **AG10** As an agent, I want to orient in an unfamiliar tree in a handful of calls, so that I
  spend the user's allowance on the task, not on wandering. (D6, I4, I10)
  Features: bash (`tree`, `rg`, `find`), read, prompt filesystem gloss.
  Eval: a 40-file imported repo (nested src/test/docs, one decoy README in a vendored folder);
  "What does this project do and where is the entry point?" Grader: answer names the entry file
  (regex), no writes, tool calls <= 8, no `read` of a file > 50 KB. Budget 8. Det.
  Tiers: S vs M (S over-reads or loops on `ls`). Coverage: `tasks.mjs` `tree` (no call cap, tiny tree).

- **AG11** As an agent, I want the paths of what the user just attached in my context, so that
  "summarize the file I attached" never starts with a search. (I8, I6, I9)
  Features: `/work/.attachments/` unique paths, transcript references.
  Eval: two attachments with collision-renamed names (`data.csv`, `data-1.csv`); "compare the
  two files I attached". Grader: first tool call reads one of the exact attachment paths; both
  read; no `find`. Budget 4. Det. Tiers: S. Coverage: none (I8 is UI-only, `composer-browser.mjs`).

- **AG12** As an agent on a seeded workspace, I want to know which files come from the seed and
  that removing one only hides it, so that I do not think I destroyed the original. (I10)
  Features: `/seed` overlay, prompt seed line, whiteouts.
  Eval: seed `starter.tar`; "delete the example tests and tell me if I can get them back".
  Grader: files gone from /work view, answer says the seed still holds them (regex
  "seed|layer"). Budget 4. Det. Tiers: M/S. Coverage: `ns-browser.mjs` (fake model only).

### Direct the agent

- **AG13** As an agent, I want edits that change exactly what was asked, so that the user can
  trust a summary instead of a diff. (D1, R4; matters more since R2/R3/R5 were dropped)
  Features: read, edit (single-match rule), write.
  Eval: reuse CORE + HELD_OUT from `tasks.mjs` (edit, feature, rename, config, jsonlist, yaml,
  delete-line, replace-all). Grader: byte-exact end state. Budget 8 each. Det.
  Tiers: all; replace-all and yaml separate S from M. Coverage: `tasks.mjs`, LH12 on oMLX.

- **AG14** As an agent, I want tool errors that tell me the next move, so that I recover in one
  step instead of repeating the call. (D5, round 1 #9)
  Features: error strings for missing file, ambiguous `edit`, unsupported command (`python`,
  `curl`, `awk -f`), `sed -i` vs edit, the pouch-environment skill.
  Eval: four micro-tasks, each designed to hit one error first ("run script.py", "fix the typo
  in utils.js" where utils.js is under lib/, an edit whose oldText occurs twice, "count lines
  with awk -f count.awk"). Grader: end state correct, and **no identical failing call twice**;
  record calls-to-recovery. Budget 6 each. Det. Tiers: S vs M sharply; also the best harness
  regression detector (an error string edit shows up here first). Coverage: none (D5 is "?").

- **AG15** As an agent, I want a real parser for messy data, so that quoted CSV and nested JSON
  come out right instead of plausibly wrong. (D18, D19, Analyst persona)
  Features: `run` (QuickJS), `files`, prompt "prefer run to awk".
  Eval: the t14 fixture (quoted commas, doubled quotes, line breaks, `$85,000`); "total salary
  per department, as out.csv". Grader: compare with Python `csv` (as t14 does). Budget 10. Det.
  Tiers: F vs M (M tends to awk). Coverage: `test/journeys/t14-analyst.mjs` (live, browser),
  `batchC-sealed.mjs` (one subagent `run`).

- **AG16** As an agent, I want AGENTS.md and skills to be found and obeyed, so that a project's
  conventions hold without the user repeating them. (D4, G1)
  Features: `<instructions>` injection, `<skills>` list, "read SKILL.md before acting".
  Eval: `/work/AGENTS.md` says "indent with tabs; append a line to CHANGELOG.md for every
  change"; a project skill `release` with a checklist; "add a --verbose flag, then prepare a
  release". Grader: tabs in new code, CHANGELOG line, `read` of the skill before the first
  release-related write. Budget 10. Det. Tiers: S (prompt length pushes instructions out).
  Coverage: partial (`graphs-sealed.mjs` uses `$panel`; `prompt-node.mjs` checks assembly only).

- **AG17** As a subagent, I want to know what my namespace lets me write, so that I put notes
  where they land instead of hammering a read-only mount. (D20, D21, round 1 #9)
  Features: spawn `ns`, `:ro` binds, `/work/.subagents`, EROFS error text.
  Eval: spawn a child with `ns: ["/work/essay.md:ro"]`, task "review and save your notes".
  Grader: zero repeated EROFS writes, notes either in an allowed path or in the report.
  Budget 6 (child). Det. Tiers: M/S; F mostly passes. Coverage: `batchC-sealed.mjs` partly.

- **AG18** As main, I want to delegate within a request budget, so that one `$panel` does not
  cost 41 requests. (D15, D16, G1-G7, Batch A)
  Features: subagent (`oneshot`, `files`, `to`), join, message caps, panel skill.
  Eval: the essay fixture, `$panel` with a stated cap of 12. Grader: total requests <= 12 (det.),
  review covers four dimensions (regex), quality of suggestions (judge). Budget 14 hard stop.
  Tiers: F only (M/S: expect N/A or refusal). Coverage: `graphs-sealed.mjs`, `batchA-sealed.mjs`.

- **AG19** As an agent, I want to wait for files instead of polling, so that "they are not here
  yet" ends my turn and the drop wakes me. (G13-G17, TM6)
  Features: watch (glob, `once`, note), wake lines, unwatch.
  Eval: "clean my CSV exports, they are not here yet"; harness drops three CSVs after the turn
  ends. Grader: `watch` called with a glob and once, turn ends with no `ls` loop, the wake
  produces merged output of all three. Then "stop watching" variant: `unwatch` called (G15).
  Budget 6. Det. Tiers: F vs M; S has no watch (N/A by design). Coverage: `watch-sealed.mjs`,
  `batchC-sealed.mjs`, `batchD-sealed.mjs`.

- **AG20** As an agent, I want a steer to reach me at a step boundary and be obeyed, so that the
  user can redirect me without Stop. (D25, S3, CP2)
  Features: pi-durable steer placement, `/session/current/agents/a1/in`.
  Eval: "write a Python-style tokenizer in tok.js"; after the first tool round inject "use tabs,
  and name it lex.js". Grader: lex.js exists with tabs, tok.js absent or removed. Budget 6. Det.
  Tiers: S vs M (does a small model weight a late user turn). Coverage: `sendmode-browser.mjs`
  (fake only); never with a real model.

- **AG21** As an agent, I want a denied outbound request to read as final, so that I stop asking
  and offer what I can do locally. (D10, D13, TM7)
  Features: `bayleaf` CLI, egress approvals, deny text "denied by the user (nothing was sent)".
  Eval: `ax-cli` default deny; "find the latest Node LTS version and put it in versions.md".
  Grader: at most one retry of a denied request, versions.md not invented as fact (contains
  "unknown" or a stated assumption), reply says nothing was sent (regex). Budget 4. Det. with a
  light judge for honesty. Tiers: all; hallucination under denial is a frontier failure too.
  Coverage: `t10b-egress.mjs` tests the UI path, not model behavior.

### Review

- **AG22** As an agent, I want to account exactly for what I changed, so that my reply is a
  reliable review surface now that change badges and diffs are gone. (R2/R3/R5 dropped, R4, D1)
  Features: final answer, file links.
  Eval: piggyback on AG13/AG16 runs. Grader: set of files linked or named in the answer equals
  the set changed (fixture diff), no claimed change that did not happen. Det. Tiers: all.
  Coverage: none. Cheap: zero extra requests.

- **AG23** As an agent, I want my file links to land on the right line, so that the user jumps
  to the change. (R7)
  Eval: "where is the offset bug?" in a 200-line file. Grader: `[x:N](/work/x:N)` with N within
  +-1 of the bug line. Budget 3. Det. Tiers: S/M. Coverage: `t8-markdown.mjs` checks rendering only.

- **AG24** As an agent, I want a failed edit after the user changed the file to tell me to
  re-read, so that I never overwrite their work. (G8, R4)
  Features: edit oldText mismatch, editor save, `[from files]` note.
  Eval: harness modifies the file between the agent's read and edit. Grader: both the user's and
  the agent's change present; no `write` of the whole file. Budget 5. Det. Tiers: M/S.
  Coverage: `graphs-browser.mjs` G8 (fake).

### Take files out

- **AG25** As an agent, I want packaging commands that behave like the real ones, so that "zip
  the site for me" yields what the user can open. (O2, O3)
  Eval: "package site/ as site.zip without the drafts folder". Grader: `unzip -l` lists exactly
  the expected entries. Budget 4. Det. Tiers: S. Coverage: none for agents (t7 is UI export).

- **AG26** As an agent, I want a clear contract for HTML reports, so that what I write renders
  in the sandboxed viewer with nothing remote. (HR1, HR8, AG9)
  Eval: `/work/sales.csv`; "make a small report". Grader: no `http(s)://` in src/href/url(),
  < 100 KB, figures match the CSV (parse the table), reply links it. Visual quality: judge.
  Budget 6. Tiers: F vs M. Coverage: `batchG-sealed.mjs` (HR8).

- **AG27** As an agent, I want user-only actions refused with what to do instead, so that I link
  rather than retry. (TM11)
  Eval: "open the report for me". Grader: if `open` is tried, the next move is a link, not a
  second `open`. Budget 3. Det. Tiers: S. Coverage: `open-browser.mjs` (refusal text, fake).

### Offline, Localhost and Transformers.js

- **AG28** As an agent with no network, I want to know which of my abilities need it, so that I
  finish the local part and name the rest. (F1, F4, LH7)
  Eval: offline flag in the runner; "fetch the CSV spec and validate data.csv against it".
  Grader: validation done locally via `run`, `bayleaf` tried at most once, reply names what was
  skipped. Budget 5. Det. Tiers: M/S (the only tiers that run offline). Coverage: none.

- **AG29** As an agent on a 4k-8k context, I want to read big files in slices, so that one `cat`
  does not evict the task. (F4, LH12, D7, small-models survey section 5)
  Eval: a 3,000-line log; "which error occurs most after 14:00?" Grader: correct answer, no tool
  result over a byte cap (e.g. 8 KB), answer produced before the step cap. Budget 8. Det.
  Tiers: S vs M decisively; F as control. Coverage: `qualify.mjs` perf phase measures speed, not this.

- **AG30** As an agent, I want my tool calls parsed the same on every transport, so that a
  provider change is not a capability change. (LH5, LH12)
  Eval: AG13 CORE over Chat Completions and Responses, and the in-browser recipe. Grader: the
  `parse` failure class stays 0. Det. Tiers: M/S; a harness regression signal for parsers.
  Coverage: `localhost-omlx.mjs`, `batchE-omlx.mjs`, `qualify.mjs`.

### Terminal and control plane

- **AG31** As an agent, I want to inspect and stop my own long `run` through files I already know
  (`cat`, `echo`), so that I do not need a new tool schema. (D19, TM5, CP3)
  Eval: a `run` that loops (fixture script with a bug); "run sim.js; if it takes more than a
  few seconds, stop it and tell me why". Grader: `cat /task/<id>/status`, `echo kill` to ctl,
  reply names the loop. Budget 6. Det. Tiers: S vs M (the D19 AX hunch: files help small
  models; the transformersjs prompt omits /task). Coverage: none with a real model.

- **AG32** As main, I want to read my session's state as files, so that "is anything still
  running?" has a true answer. (CP3, CP4, S1)
  Eval: two background children, one finished. Grader: answer matches
  `/session/current/status`. Budget 3. Det. Tiers: M. Coverage: `batchF-sealed.mjs` (partly).

- **AG33** As an agent, I want a failed control write not to silently skip the rest of my script,
  so that I know what ran. (CP6)
  Eval: "stop a2 and a9, then list the agents" in one bash call where a9 does not exist. Grader:
  the agent notices the list did not print and reruns it. Det. Today expected to fail for
  harness reasons: a story that is red until CP6 is fixed. Coverage: none.

### Context and reports on itself

- **AG34** As an agent, I want a constraint from turn 1 to survive compaction, so that `/compact`
  does not quietly change the task. (D7, D8b)
  Eval: turn 1 "never touch legacy/"; pad; `/compact`; "clean up unused files". Grader: legacy/
  untouched. Budget 6 incl. the compaction request. Det. Tiers: all, and the compaction prompt
  itself (harness). Coverage: `batchE-sealed.mjs` checks the request happens, not retention.

- **AG35** As an agent, I want to see my own remaining allowance, context fill and requests this
  turn, so that I can plan delegation and reading the way a person plans `/compact`. (A6,
  context.js, AG7, AG18, AG29)
  Eval: "you have about 10 requests left today: review these 6 files". Grader: requests used
  <= 10 and the agent states its plan. Det. Today partly **unbuildable**: the numbers exist for
  the person (Usage panel, context indicator) but not as an agent-readable file. Coverage: none.

## 3. Core eval set (cheap, discriminating, catches harness regressions)

Eight, chosen to run headless in Node (no browser), mostly deterministic, about 60 requests per
model for the whole set:

| # | Story | Grader | Why it is core |
|---|---|---|---|
| 1 | AG13 exact edits (CORE+HELD_OUT) | det., byte-exact | continuity with every LFM3/oMLX number so far |
| 2 | AG14 error recovery | det., end state + no repeated failure | first place an error-string or prompt change shows |
| 3 | AG10 orientation under a call cap | det. + regex | S vs M; cost discipline |
| 4 | AG29 big file, small context | det. | separates the in-browser tier from oMLX |
| 5 | AG15 messy CSV via `run` | det. vs Python csv | tool choice, the Analyst promise |
| 6 | AG19 watch and wake (+ unwatch) | det. | a harness feature with real past bugs (round 2 #1) |
| 7 | AG21 egress denial | det. + light judge | honesty under refusal, every tier |
| 8 | AG22 accurate change account | det., zero extra requests | the only review surface left |

Judge-dependent (keep out of the core, run before releases): AG18 review quality, AG26 report
quality, the honesty half of AG21. Scored per run with the `qualify.mjs` classes plus two new
path metrics: **repeats** (identical failing calls) and **overshoot** (calls over budget).

## 4. Gaps

Harness features with no agent story or eval at all today:
- **No model-agnostic runner.** `tasks.mjs` graders are bound to the LFM3 browser worker
  (`qualify.mjs`) and were adapted ad hoc for LH12; Sealed checks are UI-driven browser scripts.
  Needed: one `test/evals/` runner driving `src/agent.js` over a Node VFS (as `ax-cli.mjs`
  does), with adapters `sealed | localhost | transformersjs | fake`, tasks as data, the fake
  replaying scripted turns for zero-request harness runs, and per-tier `N/A` for absent tools
  (S has no watch or subagent) instead of failures.
- `/seed` beyond the fake (AG12), `models get` consent from an agent's side, Revert (D12: the
  model must not see reverted turns; testable with the fake), Background/detach results (G10,
  G12: does the model handle "detached ... continues in the background"), message caps (does
  an agent stop after "Not sent"), naming quality (D8, judge), sandbox VM `files get/put` (I7,
  O6), inboxes "since last check" (D14).

Stories that reveal missing affordances (the way AG1 revealed `look`):
- **Self-budget (AG35)**: allowance, context fill and requests-this-turn are computed for the
  person only. Proposal: `/session/current/usage` (read-only), which also serves AG7 and AG18.
- **Turn changes (AG22)**: with R2/R3/R5 gone, neither the user nor the agent has a "what changed
  this turn" record. A read-only `/session/current/changes` (paths and line counts, from the
  existing editor-save and watch diff machinery) would let the agent check its own summary.
- **CP6 (AG33)**: just-bash aborts the whole script on a failed redirection to a control file,
  silently skipping later commands; small models will not notice. Fix in the shell or return an
  explicit "N commands not run" line.
- **/task in the Transformers.js prompt (AG31)**: the smallest tier cannot discover the
  control plane except by `ls /`; decide via AG31 whether a one-line mention earns its tokens.
