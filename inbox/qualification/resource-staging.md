# Isolated Cloudflare resource qualification, 2026-10-21

**Workload qualification only. Production memory/concurrency gate remains open.**
No production inbox requests, real SMTP, production bindings, persistent storage,
or enablement changes. No commit or push. All task-created Workers were deleted;
final account listing at approximately 16:34 UTC contained zero matching temporary
Workers. Existing operator pilot and disabled restricted-creation gate remain.

## Method

`resource-staging.mjs` copies the current receiver source into a temporary module,
adds exports for its existing buffer/parser/metadata/search/text functions, and
imports the normal guarded generated DKIM verifier. Function bodies are unchanged.
Wrangler tree-shakes unreachable receiver code: this is a pure processing benchmark,
**not** the complete email handler, D1/R2 transaction, owner RPC, or Email Routing
event. It exercises the current receiver's resource-intensive processing functions.
The source and generated-verifier SHA-256 values are in the results JSON.

Each temporary Worker uses compatibility date 2026-08-01, `nodejs_compat`, a 30,000 ms
CPU limit, no bindings/routes/crons, disabled observability, and workers.dev only.
A random bearer is required before body reading; only its SHA-256 is compiled into
the module. Access expires after 20 minutes. Neither bearer nor OAuth credentials
are written to result files. Synthetic RSA keys exist only in the local process;
the public key is served by an injected in-memory DoH response. No DNS lookup,
mail send, content storage or inference occurs. Only counters/verdicts are returned.

The client streams fresh requests in 64 KiB chunks. The Worker uses the actual
`readBounded`, `parseEmail`, `emailMeta`, `emailSearch`, and bounded text conversion.
Base64 fixtures use repetitive inert ASCII, not arbitrary binary/Unicode mail.
The RSA fixture is freshly signed for `fixture.invalid`; verification precedes
restricted MIME parsing. This establishes cryptographic processing, not real
campus DNS, selector ownership or actual sender controls.

## Measured matrix

Source evidence: `resource-staging-results.json`. Window 16:27:46–16:30:31 UTC.
Worker version `3f9f2ea5-c0a4-4dc3-8ebf-84ef18fc41fe`; startup **86 ms**;
bundle 1514.83 KiB raw / 470.43 KiB gzip. Startup is Wrangler's platform-reported
startup measurement, not request CPU.

Each row ran client concurrency 1, 2 and 4: seven invocations per fixture,
28 invocations total, about 532 MiB synthetic upload. No automatic retry/ramp.

| Fixture | Raw bytes | Seven outcomes | Individual client wall range |
|---|---:|---|---:|
| Base64 attachment | 26,197,870 | 7 parsed; one attachment each | 8.41–28.24 s |
| Base64 text | 26,197,836 | 7 parsed; 32,768 search / 262,144 text chars | 7.98–27.03 s |
| Almost-matching boundary lines | 26,197,648 | 7 explicit MIME resource rejections | 7.26–33.06 s |
| Near-1 MiB RSA-2048 DKIM | 1,045,144 | 7 trusted, then parsed | 0.60–1.48 s |

All HTTP results were 200 benchmark envelopes, including intentional parser
rejection; these are not SMTP acceptance statuses. No HTTP platform errors 1101
or 1102 and no application exceptions were observed. Client times include upload
and network contention and **must not be described as CPU timings**.

The Worker-local active counter reached **two**, even when four requests were in
flight at the client. Cloudflare distributed/serialized work; this did not establish
four simultaneous parses sharing one isolate. No heap measurement API was used.
Successful requests do not bound peak heap, cover adversarial MIME generally, or
prove safe parallel owner reads. The benchmark also omits remote storage waits
that could retain buffers longer. No reduced service size is justified by these
results alone, and none was applied. Keep the restricted 1 MiB cap and operator
scope; do not waive the unrestricted near-25 MiB memory/admission gate.

## CPU instrumentation and provisioning blockers

The first matrix's trace WebSocket connected but collected no events because the
initial debug handshake was missing. The harness now sends that handshake and
handles binary frames. This correction is not yet remotely validated.

Two short CPU-only follow-up attempts uploaded successfully (reported startup
127 and 73 ms) but failed enabling workers.dev with Cloudflare error **10007,
Worker does not exist on your account**. The uploaded Workers did exist on later
listing and were explicitly deleted. The harness now deletes the exact created
name after a bounded propagation wait even when deployment only partly succeeds,
rather than trusting an immediately consistent script list. No test requests were
made in these two attempts. `resource-staging-cpu.json` preserves the last attempt.

A single GraphQL metrics query for the completed matrix failed with **rate limiter
budget depleted, retry after five minutes**. Response: `resource-staging-analytics.json`.
Work stopped rather than repeatedly provisioning or polling. Thus invocation CPU
quantiles, platform memory/CPU failure counters, and trace outcome counts remain
unmeasured. The observed HTTP outcomes are useful but do not substitute for them.
The first shell remained alive after its completed cleanup until the harness timeout;
the saved report confirms deletion at 16:30:36. Subsequent code explicitly deletes
the tail subscription as well as closing the socket.

## Reproduce, with explicit deployment authorization

From `inbox/`, after dependencies are installed and `cf` profile `ucsc` is authenticated,
set `CLOUDFLARE_ACCOUNT_ID` privately to the explicitly authorized account. There is
no default account. The deployment flag authorizes both the bounded live workload
and deletion of its temporary Worker; cleanup runs in `finally`.
The published analytics response omits its request ray identifier; no credentials,
account identifiers, recipient addresses or message identifiers are retained.

```sh
node qualification/resource-staging.mjs --deploy-test-delete --output qualification/resource-staging-results.json
# Optional four-request instrumentation pass, after provisioning/analytics recover:
node qualification/resource-staging.mjs --deploy-test-delete --cpu-pass --output qualification/resource-staging-cpu.json
```

Use a foreground timeout of at least ten minutes or a background shell with a
bounded timeout. Preserve earlier reports under distinct names before rerunning.
Never fall back to a production endpoint. If interrupted during cleanup, list
Workers in the explicit BayLeaf account and delete only the exact task-created name
reported by this run. Confirm absence afterward; an immediate list can lag uploads.

## Exact remaining gates

1. Obtain actual CPU/outcome counters and broaden controlled representative MIME
   cases (especially Unicode/QP and near-limit parsed owner reads); establish an
   admission/allocation strategy or reviewed smaller limit for concurrent memory.
2. Execute `smtp-runbook.md` only with separate authorization: disposable routing
   domain/clone and isolated storage, controlled SPF/DKIM sender with final Cloudflare
   DATA replies and queue logs, agreed retry horizon and bounded synthetic sends.
   Confirm permanent `setReject`, including 4.x text; DNS/storage thrown-error
   behavior, recovery/retries, stored-then-throw acknowledgement ambiguity,
   duplicates, and cleanup. No retry semantics may be inferred from HTTP.
3. Before restricted creation: actual UCSC-signed positive delivery, real selectors,
   matching/mismatched pins on the same signature, exact alignment, forged-From
   rejection, cap clarity, ordinary owner/API readback and current discovery.
   Receiver/verifier migration and propagation must remain confirmed; never roll
   back to a pre-verifier build while a restricted inbox exists.
4. Campus enablement remains a separate decision with the retirement/recovery
   procedure (including independently surviving ledger or endpoint invalidation
   after dual rollback), disclosure/publication and remaining service qualification
   gates. This resource benchmark neither enables DKIM creation nor campus access.
