# Pouch run: QuickJS in a worker (experiment)

A proof of concept for letting Pouch's agent run JavaScript without giving the
code any reach beyond a snapshot of files. Nothing here is wired into
`pouch/src`.

```
npm ci
npm test                 # 20 Node tests (core + worker_threads + apply)
node build.mjs           # dist/index.html, one self-contained file
node test/browser.mjs    # Playwright: run/apply/conflict/timeout/cancel/oom/CSP/network
```

## Shape

| File | Role |
| --- | --- |
| `src/core.js` | `runRequest(quickjs, request)`: snapshot in; stdout/stderr, status, proposed changes out. Runtime-agnostic contract. |
| `src/worker.js` | One-shot runner protocol (`ready`, `run`, `result`) over any port. |
| `src/worker-browser.js` | Browser worker entry; drops `fetch`, `importScripts`, `indexedDB` etc. after the engine loads (defense in depth, not separately tested). |
| `src/host.js` | `snapshot(fs, paths)`, `runInWorker(makeWorker, request, {signal})`, `applyChanges(fs, changes, {atomic})`, `MemFS`. |
| `src/demo.js`, `index.html`, `build.mjs` | Demo page, built like `pouch.html`: one hashed inline script. |
| `test/run.test.mjs`, `test/node-worker.mjs`, `test/browser.mjs` | Tests. |

The guest sees `console`, `print`, `args`, `stdin`, `exit(code)` and a frozen
`fs` (`readFile`, `readBytes`, `writeFile`, `exists`, `rm`, `readdir`) over an
in-memory copy of the snapshot. Its writes come back as
`[{path, op, baseHash, bytes?}]`; `applyChanges` refuses any change whose file
no longer matches `baseHash` (or, for `create`, now exists).

Limits: `timeMs` (QuickJS interrupt handler, backed by a host `terminate()` at
`timeMs + 1 s`), `memoryBytes` (QuickJS allocator limit), `maxOutputBytes`,
`maxFileBytes`, `maxFiles`, `stackBytes`. Exit codes follow the shell:
timeout 124, cancelled 130, oom 137.

Cancellation is `terminate()`. A worker busy in a loop cannot read a cancel
message, and a SharedArrayBuffer flag needs cross-origin isolation, which a
saved single file cannot have. One worker per run also means a guest that
corrupts its engine (a stack overflow leaks objects and trips QuickJS's
free-time assertion) never affects the next run.

## Library

`quickjs-emscripten-core` 0.32.0 plus `@jitl/quickjs-singlefile-browser-release-sync`
0.32.0 (wasm inlined as base64; Node tests use the `-mjs-` twin), all MIT
(QuickJS itself is MIT, Fabrice Bellard and Charlie Gordon). Exact pins in
`package.json` and `package-lock.json`. Neither package uses `eval` or
`new Function` on the host side. Sizes: worker bundle 856 KiB (276 KiB gzip);
the whole demo page 1020 KiB (292 KiB gzip). A run, including worker spawn
and wasm instantiation, takes about 90 ms in Chromium.

## CSP delta

Pouch: `script-src <hashes>`, everything else as below. This page adds exactly:

- `'wasm-unsafe-eval'` in `script-src`, to compile the inline wasm.
- `worker-src blob:`, to start the worker from the bundled source string.

Checked in the browser: a `blob:` worker inherits the page policy (inside it
`eval` and `new Function` throw EvalError, wasm compiles, a fetch to another
host is refused); the page itself still refuses `eval`; a `data:` worker is
refused; no CSP violations and no requests besides the page during the demo.

Assessment. `'wasm-unsafe-eval'` permits compiling wasm, not evaluating JS
strings. Wasm can only call what its importer hands it, so it adds no
capability that already-running page script lacks; it does not open an
injection path on its own. `worker-src blob:` is the weaker point: any page
script could run an arbitrary string as a worker, bypassing the script
hashes. That worker still inherits `connect-src api.bayleaf.dev` and its
own `eval` ban, and has no DOM, but it could reach the IndexedDB/OPFS of the
origin and the BayLeaf API with a key it is given. It is only reachable by
code that already runs on the page (hashed), and the worker source is a
constant inside that hashed script. The guest itself never sees any of
this: it lives in the QuickJS heap, and an escape would have to break both
QuickJS and the wasm sandbox. The trade is acceptable, and the README's
"no eval" claim stays true for JS in both the page and the worker.

A narrower alternative: run QuickJS on the main thread with only the
interrupt handler (no `worker-src` change), losing hard cancellation of
anything stuck in one long native call.
