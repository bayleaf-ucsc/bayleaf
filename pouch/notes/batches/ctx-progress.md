# Context meter progress (user story: "about how many tokens of context my current session contains")
- [x] facts: pi-ai usage per reply (openai-completions asks include_usage; prompt, cached, reply tokens) stored in each pi.assistant entry; pi.usage doc = running totals (Usage panel "in/out", not context); Transformers.js usage.input = fit() prompt count from the worker's tokenizer (trim count only went to onHint); pi-ai/utils/estimate (3.5 chars/token) + pi-durable estimateContext = the same measured+estimate shape used for auto-compaction; windows: /sealed/models context_window (optional in API schema; page defaulted 131072 silently), Localhost /models length or null (32768 default), LFM3 BUDGET 4096 (pi told 131072)
- [x] src/context.js: contextOf(active entries) = newest non-error reply usage newer than the head + estimate after; describe() text/label/level; short(); autoCompactAt()
- [x] agent.js: export compactionFor; watch push adds view.context from value.entries (active, not history)
- [x] local/provider.js: message.contextTrimmed = r.trimmed (persists in storage; node e2e checks)
- [x] main.js: windowReported on Sealed models; contextNow/renderCtx (called from updateSend); #composer-ctx opens Usage; Usage panel .ctx-now section with Compact now
- [x] pouch.html: #composer-ctx button + CSS (warn color + words, inline-block so " / 128k" keeps its space, phone hides window)
- [x] fix: kept turns after a compaction head have lower ids: measured only if id > head.id (as pi-durable)
- [x] fix: label claimed the pre-usage estimate omits the system prompt; it includes it (stored entry)
- [x] tests: test/ctx-node.mjs 5/5 (incl. real compaction, LFM3 trim persistence), test/ctx-browser.mjs 8/8; graph-fixture `usage` option (additive)
- [x] regressions: node batchA-E, composer, local, ul (scratch build), theme, localhost, prompt, markdown pass; browser batchA 9, B 17, C 22, D 11, E 10 (flaked once under 9-way parallel load, passes alone), composer, localhost 10, sendmode 11, graphs-node, graphs-browser 13, subagent-browser 10, watch-browser 16 (fixture consumers) pass; upgrade-browser fails building its baseline tree (missing quickjs deps in /tmp/pouch-qa/ul/basetree), unrelated
- [x] docs: README (allowance section + Transformers.js), JOURNEYS D8c, LANGUAGE Context (context meter, trimmed)
- [ ] unverified: live Sealed usage reporting through Tinfoil (no live requests by design); real oMLX usage; real LFM3 trimming in a browser with the model; walkthrough images not regenerated (composer toolbar gained a control when a session has content)
Not committed, not deployed.
