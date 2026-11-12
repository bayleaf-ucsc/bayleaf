# Pouch UX and live-suite repairs (#149, #150)

2026-11-12

## Decisions and changes

- #150: keep blank sessions ephemeral. New creates neither a saved session nor
  a sidebar row until the first send. The empty state now explains this;
  `test/batchF-browser.mjs` checks the explanation alongside storage/row counts.
- #150: QuickJS's missing-`require` ReferenceError retains its original message
  and stack, with guidance to use the global `fs.readFile` / `fs.writeFile`.
  No Node loader or compatibility shim is added. `test/run-node.mjs` checks the
  real engine, successful global-fs use, local `require`, feature detection and
  unrelated errors. The browser suite exercises the actual Run script action.
- #149: all 13 browser Sealed suites use one key-form sign-in helper. It waits
  for the signed-in indicator, closed sheet and verified enclave. The green
  shield alone is not an authentication-readiness signal. The deterministic
  browser regression holds the key check while the shield is green, verifies
  that the helper has not returned or sent inference, then releases it and
  checks that the client uses the checked key.
- #149: remove batch C's Node-side `document` reference; replace watch's obsolete
  prompt sign-in. Live request guards reject zero-request and over-cap runs;
  watch and batch C now assert journey outcomes instead of just printing them.
  Batch A also reads `BAYLEAF_API_KEY`, rather than implicitly using a personal
  token file. Explicit capability skips remain skips, not live passes.

## Local evidence

- `npm run typecheck`, `node arch.mjs`, `node build.mjs`, and
  `node deploy.mjs --check`: pass.
- `node test/run-node.mjs`: pass.
- `node test/batchF-browser.mjs`: 11 checks pass, including both issues' new
  regressions; scripted model, no live inference.
- `node test/boot-browser.mjs`: all five remembered-panel boots pass.
- Syntax checks on every `test/*-sealed.mjs`: pass.
- Full `test/*-node.mjs` sweep: 35 suites pass, four blocked by their existing
  absolute import of `/tmp/pouch-scratch/fidb/node_modules/fake-indexeddb/auto/index.mjs`
  (`batchB`, `local`, `subagents`, `vfs`). No dependency or unrelated source
  changes made to work around that local test-environment assumption.

## Live evidence

- `watch-sealed.mjs`, `CAP=15`, model `glm-5-3`: pass, 13 requests. The model
  registered a watch, woke on three uploaded CSVs and produced `bank-merged.csv`.
- `batchC-sealed.mjs`, `CAP=15`, model `glm-5-3`: authenticated successfully,
  woke on the upload and merged all three months into `data/all.csv` (eight
  rows). The run exhausted its cap before the background-subagent half, then
  failed explicitly on over-cap attempts. Only 15 requests were forwarded;
  attempts 16–18 were aborted. This is not a full-suite pass. Its lightweight
  fixture build has no DuckDB add-on, so model recovery consumed extra turns.
- Batch C now supports `ONLY=2`: upload the same February fixture through the
  UI and check only the background-subagent half, without repeating the watch
  journey or increasing the full-suite cap. `ONLY=2 CAP=10`, model `glm-5-3`:
  pass, 10 requests; `feb-sum` finished and wrote `69.99\n` to
  `data/feb-total.txt`. Both halves therefore succeeded, but not in one
  combined capped run. Total live inference forwarded for this closeout:
  38 requests (13 + 15 + 10), plus three locally aborted over-cap attempts.

## Deployment

Deployed to `https://pouch.bayleaf.dev/`, version
`e5f9ec92-0a4d-47af-9553-27ac4d705a33`. Page SHA-256:
`43f573c6072a66e53d396be73c548c25c6094b7d73c2bbc5048bc8c083b64199`.
`deploy.mjs` verified exact bytes for `/`, `/pouch.html` and `/SHA256SUMS`,
security/cache headers, no cookies, NEL disabled, seven app-shell files and
35 immutable runtime parts. The artifact and rollback material remain under
the ignored `.deploy/<sha256>/` directory.

Other live suites have received the shared sign-in repair, but were not all
rerun against paid inference for this closeout. A dedicated test key is not
present locally; its provisioning and the larger qualification rework remain
separate work. This evidence was recorded before commit, push and issue closure.
