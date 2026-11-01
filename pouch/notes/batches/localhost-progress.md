# Localhost provider progress
- [ ] observe oMLX
- [x] observe oMLX 0.7.2 (fixtures in test/fixtures/omlx). Both /v1/chat/completions and /v1/responses work with pi-ai stock APIs (tools must ride a system message's toolsAdded).
  Quirks: keepalive chunk model "keepalive" created 0; reasoning_content; tool calls arrive whole in one chunk; usage carries model_load_duration, time_to_first_token; 404 not_found_error for model; 400 context_length_exceeded; 401 authentication_error (with ACAO for allowed origins); preflight from disallowed origin -> 400 "Disallowed CORS origin"; PNA preflight header -> 400 "Disallowed CORS private-network". POST /v1/responses {} -> 422 (cheap probe), GET -> 405.
- [x] oMLX settings: backed up to /tmp/pouch-qa/omlx-settings.bak.json; server.cors_origins += https://pouch.bayleaf.dev, http://127.0.0.1:8742, http://localhost:8742 (kept https://chat.adamsmith.as). CORS is read at startup only (server.py add_middleware), so one `omlx restart` (2.8 s) at ~23:50 UTC. Verified chat.adamsmith.as preflight 200 and a chat request afterwards.
- [x] src/localhost.js, profile localhost, agent.js wiring, test/dummy-openai.mjs, test/localhost-node.mjs (8 pass incl --omlx)
- [x] CSP: connect-src adds http://localhost:* http://127.0.0.1:* ; [::1] dropped (Chromium 156: "invalid source", verified with a probe page). deploy.mjs check updated; --check passes.
- [x] UI: Settings > Providers > Localhost (url, masked key, transport, Test connection, Remove key, Remove Localhost), picker group, shield, wait notice, specific errors, offline exemption, Usage tokens with 0 requests.
- [x] test/localhost-browser.mjs 11 pass (both transports). Earlier "hang" at Erase all was a wrong wait in the test (hash cleared on load), fixed.
- [x] Real oMLX MiniCPM5-2B: 4/5 strict 5/5 lenient both transports; TTFT ~0.2 s at 3k prompt, ~110 tok/s.
- [ ] Qwen3.8-27B running; regressions running; walkthrough scene added (2 shots); JOURNEYS slice 9 written (LH1-LH12).
- [x] Qwen3.8-27B: 5/5 both transports; TTFT ~18 s uncached 3k prompt (prefill 174 tok/s), gen ~37 tok/s.
- [x] Regressions: node 17/17 suites; browser all pass (graphs-browser flaked once under GPU load, 13/13 on rerun; upgrade-browser 6/6 after recreating /tmp/pouch-qa/ul/basetree from ec88ab0, removed after); pwa 17/17; ul-node 0 retired terms.
- [x] walkthrough: localhost scene (2 shots). subagents-view flips a 14x18 px box every run (pre-existing nondeterminism), so it is "changed 1" on every run; the uncommitted bytes Adam had were overwritten by an equivalent flip state.
- [x] build --with-models, deploy --check OK. Not committed, not deployed.
- oMLX restore: cp /tmp/pouch-qa/omlx-settings.bak.json ~/.omlx/settings.json && omlx restart
