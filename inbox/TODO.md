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
- [ ] **Authenticated email sender restrictions:** qualify a maintained DKIM
  verifier and trusted result boundary. The current mailauth PoC fails valid RSA
  DKIM on pinned workerd (`Unknown digest: rsa-sha256`). Require positive and
  adversarial real-runtime tests before exposing allowlists; a From-header match
  or copied Authentication-Results is not authentication. Domain signatures rely
  on the sending institution's mailbox policy and do not prevent replay.
- [ ] **Disposable inbox lifetimes:** allow an explicit inbox expiry/TTL with a
  simple 15-minute experiment preset, separate from 90-day message retention.
  Expired endpoints must stop accepting and serving content immediately, even
  before the cleanup sweep, then enter the same durable destruction/reconciliation
  path as explicit deletion. Reads, arrivals and archive changes never renew the
  lifetime. Make expiry and cleanup-pending status visible to agents and the future
  diagnostic UI. Walking away should leave no live endpoint, credentials or
  accepted payloads lingering indefinitely; disclose provider/tombstone residuals
  rather than promising instantaneous total erasure. Existing inboxes must not
  silently acquire an idle-expiry policy.
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
- [ ] **Offramps and optional extensions:** portable original-payload export with
  a metadata manifest and modest self-hosting recipe; separately qualify optional
  JWT sender grants (public JWK, strict audience/expiry/algorithm policy). These
  are not requirements for passive bearer-guarded reception.
