# Batch G progress
- [ ] orient (reading main.js editor wiring)
- [x] viewer.html, headers.mjs (_headers detach verified with wrangler dev), build/deploy/sw/offline lists, Pouch CSP frame-src 'self' media-src blob:
- [ ] exfil suite test/viewer-exfil-browser.mjs
- [x] exfil suite: Chromium + WebKit pass. Static: 0 leaks. Interactive residual: WebRTC (both), WebKit script-added preconnect. Naive viewers leak 30+ channels (sanity). WebKit preconnect + target-link click connections fixed by viewer inert cleanup (DOMParser fixpoint: drop link/base/meta http-equiv, targets, incl. template content).
- [ ] app integration: src/viewer.js done; next editor Raw|Preview, media, links
- [x] previews (src/preview.js, main.js wiring, pouch.html seg controls), /task scoping (taskscope-node), prompt line + guard
- [ ] batchG-browser passing? then regressions, docs, walkthrough, real check
- [x] batchG-browser 8/8; walkthrough scene 'reports' (2 shots); README/JOURNEYS/DEPLOYMENT/WALKTHROUGH docs; ul-node regex fix (minified get(s8) false positive)
- [x] real Sealed check HR8: GLM-5.3, 5 sent (6th aborted at cap), report static, screenshot /tmp/pouch-qa/shots/batchG-sealed-report.png
- [ ] regression sweep running (/tmp/pouch-qa/regress.log); then full walkthrough x2, build --with-models, deploy --check
- gap: viewer under the offline copy (sandboxed frame navigation through sw.js) unverified
- [x] all node + browser suites green (pwa 17/17, batchA-G, composer, graphs, localhost, ns, sendmode, subagent, upgrade, watch); walkthrough 0 changed on rerun; build --with-models + deploy --check ok (71 files); exfil Chromium+WebKit PASS on final dist
- [x] offline: Chromium does not serve sandboxed viewer from sw.js -> Preview says so offline (tested)
- fixed: exfil test --json argv bug (tried to write argv[0]; EACCES, nothing changed)
DONE (not committed, not deployed)
