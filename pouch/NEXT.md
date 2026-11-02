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

Next:
- Shrink the escape hatches: 585 `as` casts, 461 non-null assertions, 35 `as unknown as`.
  A ratchet would hold the line: a node test that counts them per module against a
  committed baseline and fails when a count grows (lowering the baseline as they go).
- Retire the `app` service locator where a region needs only two or three functions:
  pass them in explicitly.
- Shrink the cross-region accessor cells (the `get`/`set` pairs in region interfaces, such
  as the `state.ts` cells `agent`, `client` and `view`, written from several regions).
- Reconcile the type mismatches the migration papered over with casts: `SessionId` (string)
  against pi-durable's numeric `ConversationId` across `src/ns/watch.ts` and the harness
  region (legacy numeric ids may never match a watch key); `FileServer.writeFile`'s
  `Promise<unknown>` receipt against just-bash's `IFileSystem` (one cast at `new Bash`);
  `Allowance.resetsAt` as `Date` (usage) against `string | number` (control plane).

Possible bugs the types surfaced (not fixed in the migration, which changed no behavior):
- `src/ns/watch.ts`: `deps.busy(...).catch` throws when the harness answers a plain `false`
  (no agent open) instead of a promise.
- `src/media.ts`: `ffmpeg -h filter=scale` returns a help shape without `flags`, so
  `a.flags.has('filters')` throws a TypeError after ffmpeg answered.
- `src/interface/session-list.ts`: removing a model as the user (not an agent) asks
  "undefined asks to remove ...".
- `src/subagents.ts`: `label()` returns an undefined handle as is, so a wake reads "A message
  from undefined woke it".
- `src/localhost.ts`: `applyProfile` appends `LOCALHOST_NOTE` to system content assuming a
  string; array content becomes "[object Object]".
- `src/interface/harness.ts`: `childByRef`'s fallback compares a numeric registry id with a
  string ref, so it never matches (`src/interface/commands.ts` passes the numeric id when the
  child is gone).
- `src/markdown.ts`: inline code such as `https:443` looks like a path but parses as an
  external target, and `ctx.kind(undefined)` is called on it.

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
