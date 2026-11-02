# Wanix and BayLeaf Pouch: research notes (2026-10-30)

Read-only investigation for Pouch (issue #120). Nothing in the Pouch worktree was edited.
Sources: <https://wanix.dev/>, <https://github.com/tractordev/wanix> at shallow-clone commit
`dd17950e1d67d51c0b65d81d2597e0507ac67b89` (2026-10-26, Jeff Lindsay), GitHub and npm APIs,
and a headless Playwright probe (below). The clone was deleted afterwards; no Wanix build
scripts were run. Probe harness kept in `/tmp/wanix-research/scripts/` (my own files only).

## 1. What Wanix is

- **Pitch:** "Wasm-native Unix sandboxing for the web ... No server. Inspired by Plan 9."
  An embeddable runtime: a Go kernel compiled to Wasm (`wanix.wasm`) plus a JS bundle
  (`wanix.min.js`) exposing custom elements `<wanix-namespace>`, `<wanix-bind>`,
  `<wanix-task>`, `<wanix-term>` (xterm.js), `<wanix-vm>` (v86), `<wanix-workbench>` (VS Code web).
- **Architecture (README, `fs/`, `web/`, `wasi/`, `gojs/`, `v86/`):**
  - Per-task namespaces composed with binds (Plan 9 style), union directories (`union=after`).
  - Kernel devices under `#` paths: `#task`, `#term`, `#vm`, `#ramfs`, `#pipe`, `#signal`,
    `#web` (OPFS at `#web/opfs`, DOM, workers, caches, service worker), `#wanix`.
  - Filesystems in `fs/`: memfs, tarfs (`type=archive` binds tar/tar.gz from a URL), httpfs
    (with its own `SPEC.md`), cowfs, r2fs, syncfs, metacache, localfs, fusekit; plus `web/idbfs`,
    `web/fsa` (File System Access), `web/caches`.
  - 9P (`fs/p9kit` client+server): import/export namespaces across origins via iframe +
    `postMessage` (`allow-origins`) or over WebSocket (`type=import src=wss://...`).
  - Task drivers: `gojs` (Go `GOOS=js`), `wasi` (wasip1 via `@bjorn3/browser_wasi_shim`),
    `js` (worker). Shell is `rc` (a Go reimplementation of Plan 9 rc with its own coreutils:
    ls, find, stat, gzip, bind/unbind, watch, write, ...; `rc/`).
  - VMs: v86 x86 emulator booting a small Linux (`extras/linux`: init, startnet, domctl,
    workerctl; containers.conf hints at podman inside). Networking via v86 `relay_url=inbrowser`
    or a `#net/ether` namespace (`elements/vm.js`), i.e. virtual unless you plumb a relay.
- **Maturity:** pre-1.0. Releases v0.1 (2024-02), v0.2 (2024-04), v0.3 (2025-08),
  v0.4-preview (2026-07); npm `latest` = 0.4.0-beta, `alpha` = 0.4.0-rc2. `site/public/wanix-sw.js`
  says "STILL IN DEVELOPMENT, DO NOT USE IN PRODUCTION". 13 open issues.
- **License:** MIT (Copyright 2023 Jeff Lindsay).
- **Governance:** effectively single-maintainer: progrium (Jeff Lindsay, of Dokku/localtunnel
  fame) has 767 commits; next contributor has 9. 854 stars, 48 forks. Sponsor-funded, Discord.
  README "AI Disclosure": parts written with AI assistance; no vibe-coded PRs accepted.
- **Runtime asset sizes (v0.4-preview release):** `wanix.min.js` 532 KB, `wanix.wasm` 3.6 MB,
  `rc.wasm` 7.0 MB, `v86.tgz` 1.7 MB, `wanix-linux.tgz` 9.7 MB, `workbench.zip` 23.7 MB.
  Minimal shell = ~11 MB uncompressed; Linux VM adds ~11 MB.
- **Browser support:** tests drive Chrome only (`test/wtest/chrome.go`). My probe (below):
  rc shell works in Chromium and WebKit headless.
- **Server:** none required; static assets. wanix.dev itself is a Cloudflare Worker that
  redirects `/lib/` and `/extras/` to jsDelivr (`dev/worker/index.js`) and sends no COOP/COEP.
- **CSP / isolation needs (source reading + probe):**
  - `wasm-unsafe-eval`: yes (Go and WASI Wasm). Pouch already grants it.
  - `unsafe-eval`: not required; the bundled cbor-x probes `new Function("")` in a try and falls
    back (`wasi/worker/lib.js:87-91`).
  - Workers: module workers from URLs relative to the bundle (`import.meta.url`), so
    `worker-src 'self'` suffices if self-hosted; Pouch has `'self' blob:`.
  - **SharedArrayBuffer:** the `wasi` driver needs it (`wasi/worker/worker.js:35`,
    `wasi/callbuffer.ts` uses `Atomics.wait` for synchronous syscalls), therefore
    cross-origin isolation (COOP `same-origin` + COEP `require-corp`). The dev server and the
    SW-served responses set exactly those headers (`cmd/wanix/serve.go:89-90`,
    `web/sw/service.go:132-133`, `examples/serve.go`). The `gojs` driver (rc, Go tools) does not.
  - Service worker: optional (`#web/sw`, for serving the namespace over HTTP).

## Probe (headless Playwright 1.64, 2026-10-30)

Page: `#ramfs/new` root, an inline `hello.txt`, `rc.wasm` from jsDelivr, rc task + term.
Served from localhost with and without COOP/COEP.

| Browser | Isolated | Prompt after | `ls`; `cat hello.txt` |
|---|---|---|---|
| Chromium | no | 0.61 s | ok |
| Chromium | yes | 0.60 s | ok |
| WebKit | no | 0.82 s | ok |
| WebKit | yes | 0.89 s | ok |

Firefox could not launch in this environment (Playwright profile error), so untested. Not
probed: WASI binaries, v86 Linux, OPFS binds, 9P import. Timings are warm-ish (CDN cache) and
exclude the 11 MB download on a cold phone.

## 2. Fit with Pouch

- **Replace just-bash?** rc is a real interpreter over a real namespace, but it is *rc*, not
  bash: models trained on bash will trip on rc syntax (`if(...)` / `if not`, `~` matching,
  single quotes only, list-valued variables, backquote `{...}` instead of `$(...)`). That is a regression for small Local-lane models. A bash-compatible shell would need a
  WASI build (busybox ash, dash) and thus the SAB/COI path. Net: no clean replacement.
- **Replace/augment `run`?** Real binaries are the attraction: WASI python (CPython wasi
  build ~25 MB+), busybox, a Go git (go-git under gojs). Each is tens of MB and the WASI ones
  need COI. The v86 Linux VM gives a genuine POSIX userland (the gap NEXT/README name: git,
  python, package managers), at ~11 MB extra and seconds of boot, but no network without a relay,
  so package managers still fail under the single-peer CSP. The remote BayLeaf sandbox already
  covers expressive work.
- **Unify `/work` as a namespace?** This is the strongest conceptual fit. Pouch's `src/vfs.js`
  already "stitches one tree from several stores" (OPFS `/work`, File System Access `/mnt/*`,
  memory fallback). Wanix's bind/union model, with `#web/opfs`, `web/fsa`, `idbfs`, `caches`
  (model files in Cache Storage), `httpfs`, and 9P import (a remote sandbox as a mount), is the
  general form of that hand-built stitching. Adopting it means routing every file op through a
  Go-Wasm kernel: 4 MB before any shell, and a second VFS of record to reason about.
- **Capability model for egress grants?** Namespaces are capabilities in the Plan 9 sense: a
  task sees only what was bound. That maps to `run`'s file-snapshot isolation and to egress
  (bind a `#net`/fetch device only when granted). But Wanix does not enforce network policy
  itself; the page CSP still does that, so it adds no stronger guarantee than Pouch has.
- **Costs:** bytes (11 MB minimum, vs Pouch's single hash-checked HTML; the Local model's 1.1 GB
  is opt-in so the precedent exists for opt-in downloads only); CSP unchanged for gojs; COI for
  WASI requires host headers (`_headers` on Cloudflare Static Assets, since COOP/COEP cannot be
  set by `<meta>`), breaks COI on `file://` copies, and constrains any future cross-origin
  embeds. CORS `fetch` to api.bayleaf.dev is unaffected by `require-corp` as long as the API
  answers CORS (it does for Pouch today). Startup sub-second warm.

## 3. Risks and stance

- Single maintainer, pre-1.0 API churn (elements API is new in 0.4), Chrome-only CI.
- Large Go-Wasm TCB: kernel, 9P, tar parser, xterm.js, cbor-x, browser_wasi_shim, optionally
  v86 and a Linux image. All auditable (MIT) but far beyond what an auditor of "one HTML file and
  its CSP hash" can review. Must be self-hosted and SHA-pinned, never jsDelivr (breaks single peer).
- ZDR/single-peer: compatible if self-hosted and no `import`/WebSocket binds; the
  `allow-origins` export feature must stay off (it would expose the namespace to other origins).

## 4. Recommendation: borrow ideas, watch; do not adopt now

Ideas worth borrowing:
1. **Namespace-as-capability for `run` and subagents:** describe each tool call's view as an
   explicit bind list (`/work/src -> ro`, `/scratch -> ramfs`), shown in the Trust panel.
2. **Union binds / layered roots** for `/work` over a read-only seed archive (tar bind) for
   templates, skills or course starter code.
3. **Everything-is-a-file control surfaces** (`#task/<id>/cmd|env|fd`, `ctl` files) as a token-
   cheap, poka-yoke interface for small models: `cat /task/3/status` instead of new tool schemas.
4. **9P/httpfs as the protocol for the remote sandbox mount**, if one is ever wanted.

Smallest experiment worth running (2 h box, `pouch/experiments/wanix/`): a standalone page,
self-hosted `wanix.min.js` + `wanix.wasm` + `rc.wasm` (SHA-pinned), under Pouch's exact CSP
with no COI, binding `#web/opfs` into the namespace. Measure: does it boot under the CSP, can
rc read and write the same OPFS `/work` Pouch uses without corruption, cold-load bytes and time
on the Pixel, Firefox. Optional second hour: a WASI busybox under `_headers` COOP/COEP to
quantify what COI costs. Kill criteria: any CSP loosening beyond `wasm-unsafe-eval`, or
cold load > 3 s on phone.
