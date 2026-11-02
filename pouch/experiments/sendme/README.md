# Sendme-compatible browser handoff experiment

Standalone proof of concept, not integrated into Pouch and not deployed. Uses
Iroh's actual `iroh-blobs` collection protocol, interoperable in principle with
the native [Sendme](https://github.com/n0-computer/sendme) CLI. Qualification
results below distinguish that claim from what has been tested.

## Run locally

Requires Rust 1.91+ with `wasm32-unknown-unknown`, Node.js, LLVM's `llvm-ar`, and wasm-bindgen CLI
matching the pinned library version. Installation of experiment-local tools:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.122 --locked --root tools
cargo install sendme --version 0.37.1 --locked --no-default-features --root tools
npm ci
npm run build
npm run serve
```

`build.mjs` selects Homebrew's LLVM archiver on Apple Silicon when present;
else it expects `llvm-ar` on PATH. Override with `AR_wasm32_unknown_unknown`.
Apple's default archiver produced empty Wasm archives during qualification.

Open <http://127.0.0.1:8743> in two windows. Explicitly connect each endpoint,
select synthetic/public files, create a ticket, and paste it in the other window.
Native peers use `tools/bin/sendme send PATH` and `tools/bin/sendme receive TICKET`.
The sender must remain open. Tickets are reusable until sharing stops.

The QR embeds a receive URL with the ticket in its fragment. A localhost URL
cannot open this app on a phone. Physical-phone testing needs a separately
authorized reachable HTTPS deployment; no tunnel or deployment is configured.
The local server serves only browser assets, not Rust source or native tools.

## Why this shape

`src/lib.rs` is a small Rust/Wasm wrapper around `iroh` and `iroh-blobs`, using
`MemStore` rather than a custom filesystem or native `FsStore`. Sendme wraps
even one file in a named collection; doing the same here is necessary for CLI
interoperability. `app.js` provides file selection, QR handoff, pause/retry,
explicit downloads, and endpoint teardown.

No Pouch API key, private files, model, or prompt is involved. No Pouch source,
egress allowlist, CSP, deployment, or runtime dependencies are changed. Any
future integration needs explicit person-controlled network and filesystem
capabilities, not automatic mounting of received content.

## Trust and limits

- Browser Iroh connections currently go through relays. Public n0 relays and
  default discovery infrastructure are used. They observe connection metadata;
  the transport is encrypted between endpoints. This is not anonymity.
- Treat tickets as access-bearing. No recipient authentication, single-use
  enforcement, or campus-account binding is added. Content hashes are not
  passwords; this is not a hardened confidential-file sharing service.
- Only explicitly selected files are imported. Data and validated partial
  downloads stay in Wasm memory, not persistent browser storage. Reload loses
  them. This is transport encryption, not encrypted-at-rest backup.
- Stop closes the endpoint. It cannot recall copies already downloaded.
- Prototype bounds: 256 files, 64 MiB aggregate including collection metadata.
  Collection names are checked for traversal, absolute paths, duplicates,
  backslashes and drive prefixes. Received files are download links, not
  automatically executed or written to a mounted filesystem.
- Files are copied into memory several times. Not appropriate for large files.
  The limits are experiment guardrails, not a hostile-peer resource-exhaustion
  audit. Empty directories and filesystem metadata are not preserved.
- Pause/retry reuses verified ranges while the receiving node remains alive.
  Cross-reload resume, offline delivery, shared-folder merging, and durable
  identity management are deliberately out of scope.

## Tests

```sh
npm exec playwright install chromium
cargo test --lib
npm test
BROWSER=webkit npm test
```

`test.mjs` uses real public-relay connections and synthetic bytes, independent
browser contexts, and the actual Sendme 0.37.1 binary. It checks browser ↔ browser,
browser → CLI, CLI directory → browser, and interruption/retry with nonzero
verified-byte reuse. JSON reports and screenshots go to ignored `test-results/`.

First Chromium run passed all four transfer tests (2026-11-01 Pacific), including
an interrupted 8 MiB transfer with 16,473 validated bytes reused on retry. Browser
and native versions interoperated despite using blobs 0.104.0 and 0.103.1
respectively. The Wasm asset is about 6.4 MB uncompressed: this is a nontrivial
addition, not a tiny JavaScript utility.

Chromium also passed receive-link fragment handling, visible QR generation, and
390px layout without horizontal overflow. No QR scan on a physical phone has
been tested.

Automated WebKit 2370 loaded the runtime without unhandled page errors, but
failed to connect to the public relay within the 30-second endpoint-online
timeout (`deadline has elapsed`). No WebKit file transfer passed. This could be
transport/browser/environment behavior; do not treat it as universal Safari
incompatibility without investigating. Physical phone, Safari, different
networks, and hostile peers remain unqualified. See ignored per-run reports for
local evidence.
