# Isolated LFM3 browser qualification

No Pouch integration, cloud inference, remote fallback or public deployment. The only HTTP server is static and loopback-only. All generated operations run against synthetic in-memory files in a dedicated browser worker. Generated code is never evaluated. The bash interpreter is just-bash with a small command allowlist, no network commands, no real processes, and execution limits.

This directory was rebuilt here at Adam's explicit request after the prior `bayleaf-pouch` worktree was accidentally deleted during qualification. Existing production files are untouched.

## Reproduce

```sh
cd pouch/experiments/lfm3-webgpu/qualification
npm ci --ignore-scripts --no-audit --no-fund
node build.mjs
python3 download.py
python3 server.py
```

In another shell in this directory:

```sh
node run.mjs baseline
node run.mjs agent
node run.mjs offline
node run.mjs restart-offline
node run.mjs fresh-offline
node run.mjs resources
node summarize.mjs
```

The runner expects the installed Google Chrome macOS application. It opens and closes only its own browser/profile. Quit the static server with Ctrl-C. No downloaded assets, profiles or node_modules are tracked. `assets-manifest.json` records public URLs, redirect hosts (not signed credential-bearing URLs), bytes and SHA256. The model, tokenizer, runtime JS and WASM are all locally served. Network is disconnected with Playwright's browser-context offline mode for offline phases; HTTP cache is disabled to test Cache Storage explicitly.

Two optional policy negative controls require separate static servers, each stopped after testing:

```sh
CONNECT_ONLY_API=1 PORT=8769 python3 server.py
# Another shell: node run.mjs csp-api-only
NO_WASM_EVAL=1 PORT=8770 python3 server.py
# Another shell: node run.mjs csp-no-wasm
```

Run `summarize.mjs` after these controls too, because its complete summary expects their JSON results. Source changes are not automatically refreshed in the installed service-worker cache. This qualification cache is deliberately versioned v1; to test changed served sources, use a new cache version/profile or explicitly clear only this experiment's own installation. Do not confuse a stale cached app with the current source.

## Tool semantics

Adapted from previously read Pouch `src/tools.js`: read, overwrite/create, exact single-match replacement with no write on ambiguity, simulated bash against shared files. This smaller qualification harness omits paging, batched edits, replaceAll, binary handling, live mounts, egress CLI, subagents and UI change hooks. It uses the actual published tokenizer chat template, native XML tool-call parsing and tool-role results. Error recovery trials inject a deliberately failing real tool call before asking the model to recover; these are not claims the model spontaneously made those errors.

At most eight model/tool rounds, at most eight calls per generated round, 384 output tokens/round, 8,192 input-plus-output qualification context cap, 120-second task deadline checked between rounds. Shell calls have a three-second abort signal and 1,000-command/loop limits. A single GPU inference is bounded by output/context caps, not hard preempted by the task deadline. Browser-process interruption needs host termination if GPU execution wedges.

The tree trial requires bash inspection, three read calls and a relevant summary with unchanged bytes. Editing trials compare the complete synthetic workspace against exact expected file strings and require a final response within bounds. The feature is deliberately tiny and explicitly specified across three files, not representative application engineering.
