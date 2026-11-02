# Pouch: next steps

Open work not yet built. Read `README.md`, `JOURNEYS.md` (story map; the source of truth
for scope) and `DEPLOYMENT.md` first. Tracked in issues:

- Review bot tuning: #136.
- Tagged public releases and an independent hash log: #138.
- Storage mode for borrowed computers: #139.
- Sign-in QR code and a phishing warning on approval: #140.
- Trusted core (sans-IO Rust, formally verified protocols): #143.

`test/journeys/` is an archive, not a suite: its scripts use `/tmp/pouch-qa/...` profile
dirs, need `playwright` (and `md-unit.mjs` needs `linkedom`), which `package.json` does
not declare, and some steps predate the current UI (t7's per-file Undo). The
qualification rework below replaces them.

## Add-ons

Done (2026-11-01): the add-on realignment as decided in
`notes/addons-language-proposal.md` (adopted; LANGUAGE.md "Add-on", README "Add-ons"):
one registry from the build's pins, the `addons` command (no `models` alias), the quiet and
asked tiers, Settings > Add-ons with Make available offline, every install a `/task` of
kind `install`, jobs' engines renamed to workers. Follow-ups:
- DuckDB-Wasm and Parakeet TDT 0.6B v3 land as registry entries on their own branches
  (README "Add-ons: the recipe").
- The gateway catalog's unpinned releases are no longer listed (`models list` showed them
  as "not in this build"); `addons info` still reads the catalog for a pinned model.
- Quiet installs run without a session (`sid` unset), so an agent's own /task view does
  not list them; the command's stderr and the job's note carry the line instead.
- The update notice's add-ons line is tested in node only (`test/addons-sweep-node.mjs`);
  `test/pwa-browser.mjs`'s releases carry no add-on parts, so it sees an empty line.
- The real-model journeys (`test/batchH-real.mjs`, `test/journeys/t17-local.mjs`) were
  updated for the new selectors but not rerun (they need the real 1.1 GB model and a GPU).

## TypeScript migration (#143's step 2)

Done (2026-11-02): every source under `src/` is strict TypeScript, checked by `tsc --noEmit`
in `node build.mjs` (two projects: the page, and the worker entries on the WebWorker
library); no behavior changed, since every bundle matches the last JavaScript build apart
from module paths. The trust boundaries are typed in `src/trust.ts` (egress, Sealed
attestation and the opaque `SealedHandle`, account-plane replies, the control plane's
`Authority`/`CtlCommand`/`InMessage`, namespace binds), as plain data the trusted core can take
over one boundary at a time; `FileServer` (`src/ns/namespace.ts`) is the file server's
contract. Each region declares its interface (`EditingRegion`, ...) and `App`
(`src/interface/app.ts`) composes them. `arch.mjs` adds two rules: `exact` (no `any` in
trust-boundary modules) and `contract` (types-only modules, imported only as types). No
explicit `any` is left in `src/`.

The escape hatches are paid down (2026-11-01): from 585 `as` casts, 461 non-null
assertions and 35 `as unknown as` to 24 casts and one `as unknown as` (`src/sealed.ts`,
out of the opaque `SealedHandle`), with no `!` left. The remainder is mostly where
untyped data enters (JSON from the relay, `postMessage` payloads, a tool's untyped
arguments, pdf.js's loose types) and `$()`'s element type. Where a cast hid a real
question, a guard now answers it (the stage commits list each behavior change). A ratchet
holds the line: `arch.mjs`'s `escapes` rule counts `as`, `!` and `as unknown as` per
module against `escapes.json` and fails when a count grows, and also when one falls
without being recorded, so the file stays exact. After removing escapes, `node arch.mjs
--lower` writes the lower counts (it never raises one; a new escape means removing
another, or saying why in review).

The `app` service locator stays, narrowed. What moved:
- `install.ts` takes its three needs (`layout`, `status`, `ask`) as values; the regions
  after it still call it through `app.install`.
- Single-writer cells live with their writer, read-only elsewhere: the Sealed client and
  `verified` in `connection.ts` (`sealed()` returns the verified client or null, so
  `state.ts` no longer holds the `SealedHandle`), the Sealed model list there too, the
  key in `auth.ts`, the session's view in `transcript.ts`; `state.unwatch` and
  `subagents.lastHeight` became transcript locals.
- Setters became named methods on the owner: `transcript.filesChanged()`,
  `clearInterrupted(sid)`, `markInterrupted(sids)`, `editing.handOver()`,
  `editing.renamed(from, to)`, `tree.reveal(path)`, `auth.restoreKey()`,
  `providers.restoreLocalhost()` and `providers.checkLocalSupport()`.

What stays on `app`, deliberately: `state.agent` (read by a dozen regions; boot opens it,
Erase all drops it), `state.composer` (set once by `commands.ts`, null-checked by earlier
regions), `sessionList.focus` (read throughout; `session-list.ts` closes over it),
`sessionList.activeRun`, and every late call to a later region. The regions call each
other in real cycles (queues and send, transcript and subagents, the session list and
transcript, connection and providers), and there a locator resolved at call time is the
simplest correct design: passing late-bound functions in as deps would rebuild it piece
by piece.

Next:
- A claim API for `sessionList.activeRun`: its three writers claim it differently (a turn
  in `send.ts` takes it outright, a subagent report's `drive` in `subagents.ts` only when it
  is free and releases only its own claim, Run script in `tree.ts` refuses while anything
  runs), and each releases by writing null, so it needs its own design rather than a
  setter rename.

## Qualification rework

Journeys are slow with local inference.
- Tiers: T0 node units (seconds, every change); T1 browser journeys on scripted or
  replayed model output (minutes, parallel, default gate, no quota, no GPU);
  T2 live Sealed smoke (before deploy, <= 10 requests); T3 Transformers.js agent tasks
  (serial on one GPU worker, only when model/runtime/prompt/tools change).
- Record/replay: T2/T3 record model turns as cassettes keyed by prompt + tool-schema
  hash and the producing model revision, runtime, decoding settings and recipe; T1 replays them; hash mismatch fails loudly.
- Convert `test/journeys/*.mjs` to Playwright Test: one server, per-worker browser
  contexts, local weights pre-seeded or served from disk (never downloaded per test),
  model loaded once per GPU worker.
- Fail early: preflight (server, enclave, WebGPU, quota), per-step deadlines
  (first token, tool call, step cap), `--max-failures`.
- Sequential stopping for model pass rates (stop at 3/3 pass, fail at 0/2).
- Tag tests with story IDs and source modules; `npm run qualify -- --changed`;
  write `qualification.json` and refresh JOURNEYS statuses from it.
- A separate test key at `~/.tokens/bayleaf-api-test` so tests stop spending the
  personal Sealed allowance.

## Namespaces follow-ups

See README "Namespaces"; stories I10, D19-D21.

- **Sandbox over 9P**: a small 9P server in the sandbox VM (or u9fs/diod behind the API)
  exported on a WebSocket relayed by api.bayleaf.dev, mounted with `Client` + `NinepFs`
  at `/mnt/sandbox`. Needs: a WebSocket transport (one 9P message per frame; the codec
  already frames with size[4]), Tauth or a per-session token in `aname` (the port is no
  longer the capability), an egress grant per mount (it leaves the pouch, so CSP plus
  `src/egress.ts` decide, not the namespace), reconnect with fid re-walks, and
  latency-aware reads (bigger msize, read-ahead).
- **Other tabs**: a BroadcastChannel cannot transfer ports; a SharedWorker or
  `navigator.locks` handshake handing out a MessagePort would.
- **Archive as 9P**: `SeedFs` already serves an archive; exporting one over 9P is
  `serve(port, seedFs)`.
- Transformers.js and /task: probe once with LFM3 before naming /task in its prompt.
- Bundled seed archives (course starter code) are the same `vfs.stack(name, bytes)`
  call; none ship today.

## API issues to file

- A capped `/web/http` relay for `bayleaf web http`.
- Read-only `/sandbox/files` requests create or wake the VM.

## DuckDB follow-ups

- Database files: DuckDB-Wasm 1.32.0 keeps an attached file locked after DETACH and
  `reset()`. Retry with a newer release, or OPFS-backed files; until then Parquet is the
  way to keep a table.
- Excel and SQLite inputs: `excel` (0.6 MiB) and `sqlite_scanner` (1.6 MiB) for v1.4.3
  `wasm_eh` exist and would load the same way; the Analyst persona would use both.
- A preview of `.parquet` and `.csv` in the file browser through this runtime (survey section 7).
- The live Sealed run of DB1 and DB2 (`test/duckdb-sealed.mjs`).

## Might go faster with cross-origin isolation (COOP/COEP)

Cross-origin isolation would allow SharedArrayBuffer and threads. Pouch does not set
COOP/COEP; these would gain from it:

- ONNX Runtime Web's CPU (WASM) fallback with threads, for OCR (PP-OCRv6) and ASR
  (Parakeet int8) when WebGPU is missing or lacks shader-f16.
- DuckDB-Wasm's `coi` bundle (threads and SIMD) instead of the `eh` bundle.
- libav.js threaded builds for video decode and transcode.

Costs to weigh first: every subresource and frame must be same-origin or CORP/CORS
(the report viewer frame, the gateway already sends CORS), and the offline copy and
service worker must serve the headers too.

## Later (lower priority)

- A9: boot capability check for unusual devices (simulate by deleting APIs in
  `addInitScript`); Cast receiver display mode is a gap note only. The Transformers.js
  provider already checks the WebGPU adapter (`gpuSupport`). Open: other APIs (OPFS,
  Cache Storage, workers) and real Firefox/Safari runs.
- Phones and tablets for Transformers.js are refused (`deviceSupport`: a Pixel 10 Pro
  froze for about a minute on the first one-shot prefill). Revisit after chunked
  prefill, which splits the prompt's GPU work into short submissions the compositor can
  interleave; a tiny timed probe could then qualify individual devices instead of
  refusing by class.
- Large-file steering: prompt the agent to use `run` rather than `read` on big data.
- Known gaps: Firefox/Safari untested; storage persistence not requested for model
  cache; subagents not aborted on network loss.
- Speech I/O: abandoned for now. Survey in `test/journeys/reports/speech-cactus-survey.md`:
  Whistle (17 MB, WASM CPU, closed engine source) or Moonshine (MIT) for STT; device
  voices for TTS; Kokoro/Kitten depend on GPL-3.0 eSpeak NG. No Google/Chrome-only paths.
