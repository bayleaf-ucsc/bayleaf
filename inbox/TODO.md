# Remaining Inboxes work (#97)

Implemented: isolated email/HTTP reception, owner-scoped API and generated docs,
`llms.txt` discovery, quotas/rate limits, write-only expiring HTTP bearer credentials,
search/archive/download/delete, retention and durable orphan reconciliation, and
hosted adapter source. Operator-only live delivery and multimodal attachment
retrieval have been exercised. See `QUALIFICATION.md` for evidence, versions and
limitations, not just source-level completion.

- [ ] **Resumable arrival stream:** finite catch-up plus SSE/live following, stable
  cursors/event IDs, gap-free transition, expired-cursor recovery, bounded replay
  and slow readers, revocation/destruction termination. Delivery never activates
  inference or an agent. Qualify connection costs and practical transport first.
- [ ] **Authenticated email sender restrictions (local implementation complete,
  rollout pending):** creation-only exact domain allowlists and optional selector
  pins, locally verified RSA >=2048/Ed25519, hard 1 MiB restricted-mail cap. Guarded
  mailauth patches pass positive/adversarial workerd and API isolation tests.
  Existing inboxes remain unrestricted. Live SMTP retry/rejection, real campus
  selectors and deployment propagation remain gates; see
  `qualification/DKIM-INTEGRATION.md`. Domain authority includes delegated signers,
  not proof of a mailbox holder, and does not prevent replay.
- [x] **Disposable inbox lifetimes (local only, not deployed or live-qualified):**
  opt-in `ttl_seconds` (60 s to 30 days) or `preset: "experiment"` (15 minutes) at
  creation; `PATCH /inboxes/{id}` only shortens or sets. `expires_at` is separate
  from 90-day message retention and never renewed by reads, arrivals, credential or
  archive changes. Liveness is computed at check time (lookup, reservation, stored
  mark, every owner operation), so expired endpoints refuse email/HTTP and owner
  reads before any sweep; the sweep then uses the same destruction transition as
  `destroyInbox`. Visible as `expires_at`, `state:"destroying"` and
  `cleanup_not_before` in the API, OpenAPI, `llms.txt` and metadata diagnostics.
  Pre-existing rows keep `NULL`. Deploy order: apply `0003_lifetimes.sql` remotely,
  deploy this Worker, then the API (the PATCH route needs `updateInbox`). Still to
  do live: real expiry of a synthetic pilot inbox, a sweep-driven finalization
  observed in production, and the PRIVACY.md wording reviewed and published.
- [x] **Minimal public web experience (#113):** a tasteful signed-out explanation and
  login entry point, analogous to existing BayLeaf API services. State availability,
  passive reception, limits and the stored-content/privacy boundary. No new
  marketing surface or elaborate application is needed.
  Wire actual HTML entry pages into BayLeaf's first-party browser-arrival telemetry
  (approved service inventory, privacy disclosure, no visitor ids or retained IPs);
  plaintext `/llms.txt` requests are not browser arrivals.
- [x] **Signed-in metadata diagnostics (#113, real owner login verified):**
  typed inboxes, usage, selectable non-clickable addresses and up to five recent
  receipt times, sizes and expiries. Existing API login/account-generation ownership;
  no bodies, subjects, sender fields, request paths, credentials or lifecycle controls.
  Follow the existing distinction between anonymous entry-page arrivals and
  authenticated private dashboards; do not emit user/session/message identifiers
  or turn authenticated activity into public browser-arrival telemetry.
- [ ] **Broader owner inspector (deferred, outside #113):** the earlier postb.in-like
  proposal included bounded content/header inspection, downloads, archive/deletion
  and credential controls. None is authorized or implemented by the metadata-only
  diagnostic slice. Revisit only if a concrete diagnosis/recovery need justifies
  the extra browser authority; agent/API operations already exist.
- [ ] **Campus rollout qualification:** account-retirement/recovery integration
  without resurrection; published privacy/retention disclosures and cleanup
  residuals; real SMTP failure/retry/duplicate behavior; adversarial/near-limit
  MIME resource benchmarks; bounded physical-cleanup throughput; fresh/existing/
  sleeping hosted-client discovery, approval and Linux save-helper checks.
  Do not remove the operator restriction until these are resolved or explicitly
  accepted with honest scope.
  Local 2026-10-21 progress: [MIME measurements](qualification/mime-bench.md),
  [cleanup capacity/limit findings](qualification/cleanup-bench.md),
  [confirmed retirement gap and proposed recovery protocol](qualification/retirement.md),
  and an [unexecuted SMTP runbook](qualification/smtp-runbook.md). Resource and
  retirement blockers remain; no rollout gate is silently waived.
  Follow-up: [local hardening](qualification/hardening.md) implements a durable
  retirement handoff/fence, fixes the demonstrated cleanup-budget overflow and
  blocks the known MIME allocation fixture. Keep remaining memory, recovery,
  combined SSE/TTL and live-SMTP qualification explicit before changing exposure.
- [ ] **Offramps and optional extensions:** portable original-payload export with
  a metadata manifest and modest self-hosting recipe; separately qualify optional
  JWT sender grants (public JWK, strict audience/expiry/algorithm policy). These
  are not requirements for passive bearer-guarded reception.
