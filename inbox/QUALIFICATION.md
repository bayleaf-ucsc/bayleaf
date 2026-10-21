# Inboxes qualification

Current evidence as of **2026-10-21**. Authenticated campus community access is
authorized for HTTP and ordinary receive-only email. Restricted-email creation
remains disabled. Remaining tests are accepted limitations, not access gates. Contract:
[DESIGN.md](DESIGN.md). Deployment, provenance and recovery:
[OPERATIONS.md](OPERATIONS.md). Remaining work: [TODO.md](TODO.md).

## Current deployed baseline

| Component | Version / state |
|---|---|
| API | `353e3a3e-bca7-4116-9369-d86577f6632d`, 100% traffic |
| Receiver | `c2d31aba-9041-472c-820a-76ed25141b68`, 100% traffic; apex wording only |
| Collector export vocabulary | `ba47b369-67c7-4110-acbd-c5521898ab34` qualification release |
| Published adapters | OpenCode `ebf705d43dfb6088329149619e5a68bf5eff3c28`; Nanobot `e1a7d014621f84ca0a0218c3d519bcd48d0f5f11`; parent `39bf426` |
| Migrations | Inboxes `0001`–`0007`, API through `0019` applied |

Community release uses authentic published adapter builds. API/receiver settings,
bindings, secret names and cron schedules matched pre-release snapshots exactly
apart from the intentionally emptied API `INBOXES_PILOT_OWNER`. Source defaults
now preserve `INBOXES_ENABLED=true` and the empty owner restriction. Telemetry,
disabled observability and `EMAIL_AUTH_CREATION_ENABLED=false` are unchanged.
No 100-inbox live load test occurred.
Default owner capacity is 100, including destroying rows. Read effective
`/inboxes/limits`; historical fixture sizes are not current quota promises.
All four deployed API modules and the receiver module match normal published-source
builds after trailing-whitespace normalization. Hosted OpenCode/Nanobot and desktop
skill/HTTP exposure are retained; desktop catalog versions advanced for community
wording. Chat owner credential integration remains deferred. Privacy/storage,
quotas, retention and account-generation ownership are unchanged.

## Capability and evidence matrix

All observations below are dated 2026-10-21 unless noted. Earlier-version live
trials establish their measured paths, not a new full trial on each release.

| Capability | Evidence | Exact remaining boundary |
|---|---|---|
| Community enablement | Local facade accepts the previously pilot-excluded synthetic owner with the empty restriction; ordinary key and sandbox credentials derive the same account generation; Campus Pass and genuine temporary tokens denied; 99 integrated checks and receiver owner-isolation/restricted-creation tests passed. Live configuration, public workflow/llms/OpenAPI/apex, authenticated plugin pin and no-store limits verified: max 100, retained 1, remaining 99 | No second actual community credential was available: nonoperator access is local evidence plus deployed config/module readback, not a second-account live trial. Receiver suite 140 passed/2 optional skips; docs, typecheck and four diagnostics tests passed |
| HTTP reception and ownership | Live create/credential/receive/read/destroy; owner/sender role separation; malformed subpath JSON fix (initial AX 2026-10-20) | Formative synthetic AX, not general client parity |
| Effective limits | Live no-store GET: max 100, retained 6, remaining 94 at readback; anonymous 401; native Nanobot limits tool passed | Snapshot, not reservation; local 99-row concurrent-create fixture admits exactly one 100th, retirement fences all 100 without R2 payloads |
| TTL + SSE | Full real 900-second preset trial on TTL/SSE release: three arrivals, catch-up/live/resume, stable IDs; expiry 404 **217 ms** after deadline; repeated lifetime reconnects | Not repeated full-duration on current release; runtime-update and sustained auth/control-plane load unqualified |
| SSE edges | Four subscribers ready in 280–316 ms; fifth 429/Retry-After 5; release/re-admit 1.8 s (1.68 s receiver recheck); live self-post event 2,074 ms; invalid/foreign cursor 400, beyond-head 410; TTL terminal 886 ms after expiry | Reader revocation/epoch change local-only (19/19 real-HTTP tests). Non-consuming client stayed connected for 25 s twice: edge buffering hides demand; server backpressure drop is not a client-read deadline. X-Accel-Buffering stripped by edge |
| Export/HAR | Integrated live smoke: two pages, **1,064,448 archive bytes**, exact SHA-256, external 1 MiB body, inline text, HAR parity, real 60-second TTL denial; independent docs-first AX: 3/3 payload hashes, two pages, 141 payload bytes, correct cursor query and role separation | One manifest per page. HAR is nonstandard, not wire capture. Legacy `insomnia-importers@3.6.0` drops `_file` body; `har-validator@5.1.5` acceptance is not spec conformance. Current GUI and live email export parity unqualified |
| Physical cleanup | At 10:01:04 UTC, six exact known export/SSE trial IDs: zero inbox/child/event/lease rows and six empty R2 prefixes; ordinary 09:45/10:00 sweeps completed | Earlier waiting was quiescence + bounded round-robin scheduling. Fifth unidentified GLM export trial not attributable. Opaque prefixes/provider history persist; no deletion SLA |
| Retirement/recovery | Deployed atomic API outbox + receiver fence. Local lost-ack/replay/restore/in-flight-write drill: six PASS groups; restored dual-ledger negative control actually resurrects bytes/reception | No live account retirement or provider Time Travel/drain qualification. Both-ledger history loss stays closed pending incident decision; no automatic reset/interlock |
| Small real email | User-sent mail/PNG delivered, decoded/read and requested payload/local-copy deletion completed; later synthetic UCSC and personal-profile messages delivered | Does not establish full SMTP failure/retry or near-limit safety; later trial endpoint finalization not individually verified |
| DKIM specimen | Exact UCSC bytes: `d=ucsc.edu`, `s=ucsc-google-2018`, RSA-SHA256; correct pin accepted (126 ms local workerd), wrong pin rejected (48 ms). Personal-domain valid signature nonaligned with From rejected (129 ms) | These are specimen/local wall measurements, not universal campus selector policy or production CPU. Pin cannot repair misalignment |
| Isolated live DKIM | Correct-pin incoming UCSC mail accepted in no-storage fixture; wrong-pin and wrong-domain retries matched fixture and provider recorded fixed authorization rejection at 17:09:39/17:17:55 UTC | First negative attempts hit catch-all during propagation and are not policy evidence. No full receiver storage, final SMTP numeric reply, oversize, DNS/storage retry or duplicate qualification |
| Hosted adapters | Published Nanobot MCP/live API: limits, native TTL/shorten, finite cursor resume across process shutdown, exact mode-0600 quarantine save, archive, role separation and real expiry. Disposable Linux V2/MCP runtime + sleep/restart marker passed, VM deleted with exact-ID 404 | macOS live service and Linux fixture results are distinct. Actual managed gateway/browser approvals/automatic refresh/relink and live arrival during managed sleep remain unqualified |
| Current OpenCode headless AX | GLM trial on the published head reports 11 inbox tools, live owner limit 100, creation-TTL readback, finite cursor/client-off resume, and a 58-byte mode-0600 save. Mutation approvals used native permission events/API, answered by the harness | Agent-reported observations, not independently replayed evidence. Deny-before-write was reported but the harness deletes downloads after rejection, so absence alone cannot verify it. No browser UI, Nanobot gateway, host-sleep or physical-finalization proof; ambiguous lifetime/404 attribution and exact trial counts excluded |
| Diagnostics/telemetry | Real UCSC owner login and metadata rendering; public apex arrivals verified. Scheduled HTTP/lifecycle counters and export **2 pages/1,064,448 bytes** independently in collector | Best-effort generation counts, not delivery accounting. Email/scheduled-cleanup coverage details in [telemetry qualification](../telemetry/qualification/inboxes.md); private-preview navigation belongs to [diagnostics](../telemetry/qualification/diagnostics.md) |

Discovery fixes from AX are incorporated: four separate clocks, owner/sender roles,
wait-for-ready ordering, SSE frames/stop reasons, response-header-to-query export
cursor, and actual page-manifest layout. The export agent's original inference of
one manifest per receipt was incorrect; source and measured page members agree
on one per page. Package tests do not prove natural-intent recognition.

## Resource and cleanup measurements

These are selected measured workloads, not worst-case guarantees or 100-inbox
benchmarks. Reusable harnesses remain under `qualification/`; one-off JSON logs
are not canonical evidence.

| Workload | Measured result | Interpretation |
|---|---|---|
| Historical pre-hardening cleanup | Mixed run **1,001 D1 calls**; ordinary expiry 200/run; then-default ten-inbox fixture | Found compositional budget bug; superseded by set-based/fair cleanup, not relabeled as current behavior |
| Integrated local cleanup, telemetry on | Initial 18,900 rows / 19,000 objects / 18,300 events / 81 leases, with 1,060 prefixes and 12 expired endpoints: all messages/objects/events/leases removed over 29 invocations; peak **285 D1 calls, 402 statements, 82 R2 calls, 51 parameters, 291 ms wall**; max five TTL transitions/run | Prefix records persist. With 50 reserve: 452 statements <=700, 417 binding/R2 calls <=900. Stuck-delete fixture leaves only its failed 50-row batch after six runs; other rows progress. Not production CPU or global deletion deadline |
| Historical local MIME | Near-25 MiB accepted fixtures; almost-matching boundary fixture OOM under Node 128 MiB old-space despite Miniflare acceptance | Node old-space/process RSS are not Cloudflare heap; guard now rejects known line-heavy fixture |
| Integrated local MIME spot check | Valid 24.98 MiB attachment receipt/text/attachment 420/223/243 ms; Unicode-QP 408/176 ms; allocation fixtures rejected 58/22 ms; attachment receipt process RSS growth 165.5 MB | Process RSS warning, not isolate high-water measurement |
| Isolated Cloudflare processing, 16:27–16:30 UTC | **28 requests**, four fixtures at client concurrency 1/2/4: seven each attachment/text parsed, boundary rejected, near-1 MiB RSA verified/parsed; wall ranges 8.41–28.24 / 7.98–27.03 / 7.26–33.06 / 0.60–1.48 s | Upload/network wall, not CPU. Worker-local overlap reached two, not four. Temporary Workers deleted |
| Instrumented follow-up, 16:51–16:52 UTC | **9/9 outcomes ok**, all CPU/wall records captured; seven stored invocation records exactly matched tail. No observed CPU/memory failure | Heap peak unmeasured; isolate overlap only one despite four clients. Temporary Worker deleted 16:53:11, independently absent 17:01:34 |

Instrumented CPU/platform wall samples (milliseconds):

| Fixture | Raw bytes | CPU | Platform wall |
|---|---:|---:|---:|
| Tiny control | 104 | 8 | 8 |
| Base64 attachment | 26,197,870 | 1,532 | 2,667 |
| Base64 text | 26,197,836 | 1,257 | 2,500 |
| Boundary resource rejection | 26,197,648 | 325 | 1,184 |
| Five RSA-2048 DKIM requests | 1,045,144 each | 53–161 | 74–207 |

The staging benchmark tree-shakes unchanged receiver processing functions with
synthetic in-memory DNS: no SMTP, D1/R2 transaction, storage waits or owner RPC.
Startup (86 ms first matrix, 121 ms follow-up) is separate from invocation CPU.
No peak heap measurement or adversarial worst-case bound exists. `readBounded`
retains chunks while assembling a contiguous buffer. The existing 1 MiB restricted
slice is suitable for further qualification; unrestricted concurrent 25 MiB parsing
still needs a reviewed allocation/admission strategy. No service limit was lowered.
The follow-up local process timed out after remote cleanup; shutdown correction
was syntax-checked, not another remote workload. Staging-only invocation logs can
remain under provider retention (up to seven days); production observability is off.

## Reproduction

Commands run from repository root unless shown. Local harnesses use synthetic
data; live commands require explicit authorization and private environment
credentials. Put generated evidence in a private external `$EVIDENCE` directory,
never tracked report paths. Preserve source/verifier hashes with each new result.

```sh
npm --prefix inbox test
npm --prefix api run test:inboxes
npm --prefix api run test:inboxes-e2e
npm --prefix api run test:inbox-stream
npm --prefix api run test:user-retention
npm --prefix api run test:docs
node inbox/qualification/retirement-check.mjs
node inbox/qualification/recovery-check.mjs
node inbox/qualification/cleanup-bench.mjs --only integrated-ttl-events,stuck-delete-fairness --json "$EVIDENCE/cleanup.json"
node inbox/qualification/mime-bench.mjs --tier workerd --only near-limit-attachment,near-limit-text-unicode-qp,qp-soft-break-bomb,many-empty-parts-1m --json "$EVIDENCE/mime.json"
```

Latest pre-cleanup quota suite: receiver **140 passed, two optional importer
checks skipped**; API E2E **99 checks**; stream **19/19**. Latest adapter release:
OpenCode **31/31**, Nanobot suite and parent installer **8/8**. These are recorded
results, not a claim that all commands ran during documentation consolidation.
Optional legacy compatibility: install pinned packages externally, set
`HAR_VALIDATOR_MODULE` to `har-validator/lib/promise.js` and
`HAR_IMPORTER_MODULE` to `insomnia-importers/dist/src/importers/har.js`, then run
the inbox suite. Without them the two cases skip. DKIM research matrix/tripwire:
`npm --prefix inbox/research test`; live-DNS specimen files stay outside the repo.

Authorized live recipes (ordinary owner key in `BAYLEAF_API_KEY`, never arguments):

```sh
node api/scripts/qualify-inbox-stream.mjs --live --wait-ttl
node api/scripts/qualify-inbox-export.mjs --live
node inbox/qualification/sse-edge-cases.mjs --live
node inbox/qualification/hosted-client-live.mjs --live
# Explicit CLOUDFLARE_ACCOUNT_ID required; deploy/test/delete temporary Worker:
node inbox/qualification/resource-staging.mjs --deploy-test-delete --output "$EVIDENCE/resources.json"
node inbox/qualification/resource-staging-followup.mjs --deploy-test-delete --output "$EVIDENCE/resources-cpu.json"
```

Review each harness's bounds before execution. Resource follow-up enables
observability only on its disposable producer, uses exact-service telemetry and
trace handshake, gates large requests on a tiny CPU control, and deletes exact
resources in finalization. Keep a >=10-minute shell budget; if interrupted,
confirm exact-name cleanup rather than assuming an immediate list is consistent.
SMTP prerequisites, routing evidence and retry protocol live in
[OPERATIONS.md](OPERATIONS.md#isolated-smtp-fixture) and the
[SMTP runbook](qualification/smtp-runbook.md). No HTTP result qualifies SMTP.
