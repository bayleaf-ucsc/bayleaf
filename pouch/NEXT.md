# Pouch: next steps (handoff, 2026-10-29)

Working state: worktree `~/Desktop/bayleaf-pouch`, branch `pouch`, checkpoint commit
`727983c` (local only, not pushed). Everything after that checkpoint is uncommitted:
`run` tool, offline handling, composer card, Local lane with weights built into `dist/`.
Read `README.md`, `JOURNEYS.md` (story map; the source of truth for scope) and
`DEPLOYMENT.md` first. Journey test scripts and the AX/UX/joint/speech reports were moved out of `/tmp` into
`test/journeys/` (uncommitted; scripts still use `/tmp/pouch-qa/...` profile dirs, and the
reports quote transcripts, so scrub before committing).

## Decided, not yet built

1. **Drop change review.** Remove the "Changed N files" blocks, the diff view and
   per-chunk revert, tree change dots, file rows on subagent cards, and the machinery
   behind them (`src/review.js`, the recording proxy in `src/tools.js`, the IndexedDB
   `changes` store, saved before-copies, "user undid your change" notes). Keep the
   editor's conflict bar (it prevents the lost-update bug and does not use the change
   store). Journeys: mark R2, R3, R5 "dropped by decision 2026-10-29" with the reason
   (visual clutter, not wanted); keep R4.
2. **Revert is conversation-only.** "Revert to here" forks the conversation so later
   messages see only earlier context; files are never touched. Undo switches back to
   the original conversation. Remove the "also undo N file changes" checkbox; the sheet
   says files stay as they are. Rewrite D12.
3. **Qualification rework** (journeys are getting slow with local inference):
   - Tiers: T0 node units (seconds, every change); T1 browser journeys on scripted or
     replayed model output (minutes, parallel, default gate, no quota, no GPU);
     T2 live Sealed smoke (before deploy, <= 10 requests); T3 Local-model agent tasks
     (serial on one GPU worker, only when model/runtime/prompt/tools change).
   - Record/replay: T2/T3 record model turns as cassettes keyed by prompt + tool-schema
     hash; T1 replays them; hash mismatch fails loudly.
   - Convert `test/journeys/*.mjs` to Playwright Test:
     one server, per-worker browser contexts, local weights pre-seeded or served from
     disk (never downloaded per test), model loaded once per GPU worker.
   - Fail early: preflight (server, enclave, WebGPU, quota), per-step deadlines
     (first token, tool call, step cap), `--max-failures`.
   - Sequential stopping for model pass rates (stop at 3/3 pass, fail at 0/2).
   - Tag tests with story IDs and source modules; `npm run qualify -- --changed`;
     write `qualification.json` and refresh JOURNEYS statuses from it.

## Waiting on Adam

- **Deploy** the current build to pouch.bayleaf.dev (first upload ~1.1 GB):
  `node fetch-models.mjs && node build.mjs --with-models && node deploy.mjs --check && node deploy.mjs`.
- **Commit/push** policy for the post-checkpoint work.
- **API issues to file** (public repo): a capped `/web/http` relay for `bayleaf web http`;
  read-only `/sandbox/files` requests create or wake the VM.
- **Test key**: a separate key at `~/.tokens/bayleaf-api-test` so tests stop spending
  the personal Sealed allowance.

## Queued (lower priority)

- A9: boot capability check for unusual devices (simulate by deleting APIs in
  `addInitScript`); Cast receiver display mode is a gap note only.
- Large-file steering: prompt the agent to use `run` rather than `read` on big data.
- Known gaps: t10a not rerun after the Local lane; Firefox/Safari untested; storage
  persistence not requested for model cache; subagents not aborted on network loss.
- Speech I/O: abandoned for now. Survey in `test/journeys/reports/speech-cactus-survey.md`:
  Whistle (17 MB, WASM CPU, closed engine source) or Moonshine (MIT) for STT; device
  voices for TTS; Kokoro/Kitten depend on GPL-3.0 eSpeak NG. No Google/Chrome-only paths.
