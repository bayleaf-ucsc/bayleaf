# Batch E progress
- [x] 1 provider-consistent titles/compaction: agent.complete (agent.js), naming.js costNote/providerOf, sessions.js nameFrom/compact/unavailable, main.js COMMANDS getters, local/provider maxNew for plain requests; README/JOURNEYS D8b, usage.js text
- [x] 2 /rename bare -> sessions.renameAuto
- [x] 3 terminal: src/terminal.js, tools.js oneAtATime/serialized/shellFor (module-level queue), egress asker, pouch.html panel+rail, layout DEFAULT_W, main.js wiring + Ctrl+`
- [x] test/batchE-node.mjs 6/6, test/batchE-browser.mjs 10/10
- [x] docs: README Terminal + security note, JOURNEYS TM1-TM7, WALKTHROUGH terminal section
- [x] walkthrough terminal scene; flicker: freeze kept on via rAF-throttled MutationObserver (unthrottled version hung the subagents scene); subagents-view 0 changes in 5 runs; subagents-review 2px band flake once (restored)
- [ ] regressions (node, browser, pwa), real oMLX, Sealed (<=5)
- [x] build --with-models (6ea28543...) ; [ ] deploy --check (after final edits)
Notes: product race: clicking New then typing+Enter immediately can send into previous session (pre-existing).

- node suites all pass; browser suites running (summary in browser-summary.txt)
- scripts ready: test/batchE-omlx.mjs, test/batchE-sealed.mjs
- DONE 2026-11-01: all node + browser suites pass (pwa 17/17); walkthrough 21/21, subagents-view stable; oMLX real check ok (titles+compact on oMLX, 0 content requests to BayLeaf; 7 GET /sealed/models reachability rechecks); Sealed 5/5 requests (title, sparkle, compact); build 6ea28543; deploy --check ok. Not committed/deployed.
