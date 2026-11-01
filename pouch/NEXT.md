# Pouch: next steps (handoff, 2026-10-29)

Working state: worktree `~/Desktop/bayleaf-pouch`, branch `pouch`, checkpoint commit
`727983c` (local only, not pushed). Everything after that checkpoint is uncommitted:
`run` tool, offline handling, composer card, Transformers.js provider with weights built into `dist/`.
Read `README.md`, `JOURNEYS.md` (story map; the source of truth for scope) and
`DEPLOYMENT.md` first. Journey test scripts and the AX/UX/joint/speech reports were moved out of `/tmp` into
`test/journeys/` (committed after a scan for secrets and private data). They are an
archive, not a suite: they use `/tmp/pouch-qa/...` profile dirs, need `playwright` (and
`md-unit.mjs` needs `linkedom`), which `package.json` does not declare, and some steps
predate the current UI (t7's per-file Undo). The Playwright Test rework below replaces them.

## Next: TypeScript migration (after #142, 2026-11-01)

#142 split `src/main.js` into Interface regions (`src/interface/`) and made the trust
boundaries build checks (`arch.mjs`, README "Architecture"). Next, convert to TypeScript
(#143's step 2), boundaries first:
- Type the trust boundaries: `src/sealed.js` (client handle, `sealedFetch`),
  `src/bayleaf-api.js`, the egress modules in `NETWORK`, and `src/egress.js` consent.
- Give each region's returned object an interface (`EditingRegion`, ...) and `app` a type
  composed of them; the getters and setters show which state crosses regions, a list to
  shrink (`state.js` cells such as `agent`, `client`, `view` written from several regions).
- Keep `arch.mjs` on TypeScript's parser (`.ts` sources too), and keep `node build.mjs`
  the one command: esbuild strips types; `tsc --noEmit` as a separate check.
- Then retire the `app` service locator where a region needs only two or three
  functions: pass them in explicitly.

## Decided, not yet built

Items 1 and 2 were built in Batch B (2026-10-30, uncommitted); see JOURNEYS (D12, R2, R3, R5).

1. **Drop change review.** (built) Remove the "Changed N files" blocks, the diff view and
   per-chunk revert, tree change dots, file rows on subagent cards, and the machinery
   behind them (`src/review.js`, the recording proxy in `src/tools.js`, the IndexedDB
   `changes` store, saved before-copies, "user undid your change" notes). Keep the
   editor's conflict bar (it prevents the lost-update bug and does not use the change
   store). Journeys: mark R2, R3, R5 "dropped by decision 2026-10-29" with the reason
   (visual clutter, not wanted); keep R4.
2. **Revert is conversation-only.** (built) "Revert to here" forks the conversation so later
   messages see only earlier context; files are never touched. Undo switches back to
   the original conversation. Remove the "also undo N file changes" checkbox; the sheet
   says files stay as they are. Rewrite D12.
3. **Qualification rework** (journeys are getting slow with local inference):
   - Tiers: T0 node units (seconds, every change); T1 browser journeys on scripted or
     replayed model output (minutes, parallel, default gate, no quota, no GPU);
     T2 live Sealed smoke (before deploy, <= 10 requests); T3 Transformers.js agent tasks
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

## Namespaces (built 2026-10-30, uncommitted)

Plan 9 ideas in our own code (`src/ns/`): bind/union mount table, seed layers with
whiteouts, `/task` files, 9P2000 at the `run` and subagent boundaries. See README
"Namespaces"; stories I10, D19-D21. Tests: `test/ns-node.mjs`, `test/9p-node.mjs`,
`test/ns-browser.mjs` (fake model). Follow-ups:

- **Sandbox over 9P** (not built): a small 9P server in the sandbox VM (or u9fs/diod
  behind the API) exported on a WebSocket relayed by api.bayleaf.dev, mounted with
  `Client` + `NinepFs` at `/mnt/sandbox`. Needs: a WebSocket transport (one 9P
  message per frame; the codec already frames with size[4]), Tauth or a per-session
  token in `aname` (the port is no longer the capability), an egress grant per mount
  (it leaves the pouch, so CSP plus `src/egress.js` decide, not the namespace),
  reconnect with fid re-walks, and latency-aware reads (bigger msize, read-ahead).
- **Other tabs**: a BroadcastChannel cannot transfer ports; a SharedWorker or
  `navigator.locks` handshake handing out a MessagePort would.
- **Archive as 9P**: `SeedFs` already serves an archive; exporting one over 9P is
  `serve(port, seedFs)`.
- Drop-change-review (item 1 above) would remove the recording proxy; the 9P
  commit hook still gives per-path serialization.
- Transformers.js and /task: probe once with LFM3 before naming /task in its prompt.
- Bundled seed archives (course starter code) are the same `vfs.stack(name, bytes)`
  call; none ship today.

## Waiting on Adam

- **Deploy** the current build to pouch.bayleaf.dev (first upload ~1.1 GB):
  `node build.mjs && node deploy.mjs --check && node deploy.mjs` (weights come from the HF gateway since batch H).
- **Commit/push** policy for the post-checkpoint work.
- **API issues to file** (public repo): a capped `/web/http` relay for `bayleaf web http`;
  read-only `/sandbox/files` requests create or wake the VM.
- **Test key**: a separate key at `~/.tokens/bayleaf-api-test` so tests stop spending
  the personal Sealed allowance.

## Might go faster with cross-origin isolation (COOP/COEP; not built)

Cross-origin isolation would allow SharedArrayBuffer and threads. Pouch does not set
COOP/COEP today; these would gain from it:

- ONNX Runtime Web's CPU (WASM) fallback with threads, for OCR (PP-OCRv6) and ASR
  (Parakeet int8) when WebGPU is missing or lacks shader-f16.
- DuckDB-Wasm's `coi` bundle (threads and SIMD) instead of the `eh` bundle.
- libav.js threaded builds for video decode and transcode.

Costs to weigh first: every subresource and frame must be same-origin or CORP/CORS
(the report viewer frame, the gateway already sends CORS), and the offline copy and
service worker must serve the headers too.

## Later (lower priority)

- A9: boot capability check for unusual devices (simulate by deleting APIs in
  `addInitScript`); Cast receiver display mode is a gap note only. Partly done: the
  Transformers.js provider checks the WebGPU adapter (shader-f16, at least 10 storage
  buffers per shader) before it is offered or downloaded (`gpuSupport`, batchH tests).
  Still open: other APIs (OPFS, Cache Storage, workers) and real Firefox/Safari runs.
- Phones and tablets for Transformers.js: refused outright since 2026-11-01 (`deviceSupport`;
  a Pixel 10 Pro froze for about a minute on the first ~4K-token one-shot prefill). Revisit
  after chunked prefill, which splits the prompt's GPU work into short submissions the
  compositor can interleave; a tiny timed probe (a short prefill, measured) could then
  qualify individual devices instead of refusing by class.
- Large-file steering: prompt the agent to use `run` rather than `read` on big data.
- Known gaps: t10a not rerun after the Transformers.js provider; Firefox/Safari untested; storage
  persistence not requested for model cache; subagents not aborted on network loss.
- Speech I/O: abandoned for now. Survey in `test/journeys/reports/speech-cactus-survey.md`:
  Whistle (17 MB, WASM CPU, closed engine source) or Moonshine (MIT) for STT; device
  voices for TTS; Kokoro/Kitten depend on GPL-3.0 eSpeak NG. No Google/Chrome-only paths.
