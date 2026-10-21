# Remaining Inboxes work (#97)

Current contract: [DESIGN.md](DESIGN.md). Evidence: [QUALIFICATION.md](QUALIFICATION.md).
Operations/recovery: [OPERATIONS.md](OPERATIONS.md). Keep access operator-only and
restricted-email creation disabled until the relevant gates are resolved and
enablement is explicitly approved.

- [ ] **SMTP boundary and full storage failures:** identify an authorized signed
  sender with final Cloudflare MX DATA replies and queue logs; execute the bounded
  [runbook](qualification/smtp-runbook.md) on an isolated full receiver/D1/R2.
  Qualify permanent `setReject` (including 4.x text), envelope/Bcc, oversize,
  DNS/storage throws, recovery/retries, post-commit acknowledgement ambiguity,
  duplicates and cleanup. Gmail submission/provider activity cannot substitute.
- [ ] **Restricted-email creation rollout:** after SMTP qualification, verify full
  stored-policy/readback and oversize behavior, current receiver propagation and
  discovery, then obtain explicit gate approval. Exact UCSC signature/pin and
  isolated live wrong-pin/domain cases already passed; no need to repeat those
  as unresolved research. Selector rotation and delegated-domain authority must
  remain explicit. Adapter policy UI/mutation exposure is deferred.
- [ ] **Unrestricted MIME memory/admission:** near-25 MiB CPU samples passed but
  peak heap and concurrent same-isolate receipt/parsed-owner-read allocation are
  unbounded by this evidence. Review byte-weighted admission/buffering across
  storage awaits or a smaller service limit; qualify representative Unicode/QP
  and adversarial read workloads. Existing 1 MiB restricted slice can proceed
  through its own remaining gates. Do not infer four simultaneous parsers from
  four clients or rewrite historical cleanup fixtures as 100-inbox load tests.
- [ ] **Operational recovery execution:** qualify provider restore/drain and
  complete inventory replay against the documented closed-service protocol;
  implement a small private operator runner only if needed. Local recovery drill
  passes. Both-ledger loss policy is decided: remain closed pending the incident's
  operator choice, never automatically reset endpoints or add a new ledger service.
- [ ] **Managed installed-client qualification:** actual OpenChamber browser
  permissions, Nanobot gateway registration, ten-minute refresh, managed relink,
  and receipt during confirmed host sleep followed by cursor reconciliation.
  Production controller derives ownership from authenticated email, with no
  test-machine override. Staging credential verifiers live in staging D1 and
  are not production credentials; Daytona secrets/adapter discovery fix the
  destination to `api.bayleaf.dev`. Temporary inference tokens cannot authorize
  inboxes, and a sandbox credential is machine/account-bound, not single-inbox.
  Build a bounded synthetic controller/transport fixture (exact-inbox GET relay,
  owner/sender keys retained locally), or separately isolated deployed identity/
  routing. Do not upload broad operator keys or target the real stopped workspace.
  Source-only managed preflight created no resources and is not a runtime pass.
- [ ] **Remaining live SSE boundaries:** separately revocable synthetic reader
  authority for five-second propagation, runtime-update reconnect, true transport
  backpressure and sustained auth/control-plane cost. Epoch/replay limits and
  revocation pass locally; live full TTL, subscriber cap and ordinary resume passed.
- [ ] **Discovery/AX:** finish the active published-adapter trial, then assess
  natural receiving-intent and negative prompts across fresh/existing desktop
  Standard/Sealed and hosted clients using `qualification/discovery-evals.json`.
  Preserve permission denial and prompt-injection boundaries; package/runtime
  checks are not behavioral parity. Chat remains deferred.
- [ ] **Campus rollout decision:** review the remaining reliability/resource/
  recovery gates, effective 100-inbox backlog capacity and indefinite-prefix
  growth, current privacy/retention publication and aggregate telemetry coverage.
  Local fences and six-resource physical cleanup do not prove all historical
  trial finalizations, provider-history erasure or a global deletion deadline.
- [ ] **Optional follow-ups:** current GUI export importers and live email export
  parity; JWT sender grants (public JWK, strict audience/expiry/algorithms); broader
  owner content inspector only if justified by a concrete need. Exact export and
  [self-hosting recipe](SELF-HOSTING.md) already exist. Private-preview navigation
  remains tracked by #113's separate diagnostics work.
