# Run evidence: privacy-notice-change

Dated record of past runs of [`privacy-notice-change.md`](../playbooks/privacy-notice-change.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-11-11 (Rooms #159): New opt-in content store; drafted with the facet and approved
  as drafted, no user email (no existing data affected). Disclosed the Durable Object
  30-day PITR residual and that owners can keep extending expiry 90 days at a time.
  Telemetry wording changed from "none at launch" to active once Adam approved the
  vocabulary in the same review; keep notice and activation in one decision.

- 2026-11-04 (CollabMD retirement, initially local): Replaced active room-sharing
  disclosure with an explicit undeployed retirement note; existing documents,
  sidecars and collaborator copies remain. No retention policy change, publication,
  live-room cleanup or user notification occurred.

- 2026-10-21 (#97, isolated local hardening): Retirement needs linkable generation
  fences in addition to owner-free cleanup handles. Draft disclosure distinguishes
  eventual handoff from atomic identity deletion and requires offline replay before
  recovery enablement. No publication, deployment, notice or real SMTP test occurred.

- 2026-10-20 (issue #94 approved publication): Owner approved deployment, commit
  and push of the opt-in room disclosure. No new provider, inference retention or
  existing-document retention policy was introduced. No notification email was
  sent; the upstream save-feedback limitation and waived soak remain explicit in
  the service qualification record rather than being reported as passing tests.

- 2026-10-20 (#113 activation): New apex sources were explicitly approved and
  browser-readback verified under the existing fields/90-day retention. CSP blocks
  Cloudflare's separately injected analytics beacon; do not allow it to silence
  console errors. No existing retained content or provider roster changed.

- 2026-10-20 (#113 diagnostic web, local): Two new apex arrival sources use the
  existing policy/retention, with independent disabled switches. The draft names
  exact HTML paths and exclusions; preview recovery drops tenant material before
  telemetry. Publication and activation remain gated, not implied by local tests.

- 2026-10-20 (issue #94, unpublished): Drafted fixed-folder collaborative-room
  disclosure: public gateway plus app password, retained sidecars/documents,
  collaborator copies, and suggested rather than enforced two-hour duration.
  Existing sandbox providers are unchanged. Publication/rollout and any notice
  decision remain gated; this adds no automatic notice-sending step.

- 2026-10-20 (Daytona telemetry, unpublished draft): Lifecycle event counts need
  not retain sandbox identities: atomic event receipts and 15-minute buckets suffice.
  Discarding OTLP logs/traces without reading bodies does not prevent the edge
  transport receiving them. Draft that boundary explicitly; activation remains gated.

- 2026-10-18 (API activity preparation): Added a separate user clock, daily-coalesced
  authenticated activity and an explicit unknown historical-activity migration.
  No account deletion in the prep revision; publication and deployment require
  operator approval. Key revocation is not account retirement or sandbox deletion.
  Prep commit 9979d9c was then explicitly approved, migrated and deployed; an
  authenticated read-only production request changed the operator's activity from
  unknown to a timestamp, with unchanged account creation and same-day coalescing.
  With subsequent approval the cleanup follow-up was migrated/deployed in dry-run
  mode. SELECT-only execution of the deployed eligibility module against production
  found zero candidates among 122 accounts (none old enough); no account deletion
  or provider revocation occurred. Atomic D1 retirement plus an upstream-key outbox
  replaces Chat's non-atomic HTTP delete. Subsequent explicit approval enabled
  live mode (deployed settings and health verified), commit and push, with an
  explicit decision not to send user notices. Public policy now describes the
  18-month rule, unknown timestamps, holds/exemptions and resource dependencies.

- 2026-10-18: Drafted Chat's 18-calendar-month account-row retention, with no
  rollout grace period by operator decision. Read-only qualification found 11
  candidates without profile content or group memberships. Default OWUI user
  pagination repeated accounts at tied creation timestamps; explicit unique-email
  sorting fixed discovery. All 53 offline tests passed. Approved one-shot
  enforcement deleted exactly those 11 accounts; complete re-enumeration verified
  595 → 584 users. The job builds from GitHub main, requiring approved publication
  before the scheduled-job image can be rebuilt. User notices are not sent
  automatically and remain subject to the notice-text approval gate.

- 2026-10-08 (Sandboxes dashboard, local): Drafted metadata-only login/session
  retention and sign-in activity-refresh disclosures. No new processor or
  inference-content storage; deployment and notice publication remain pending.

- 2026-10-08: Drafted the opt-in configured-preview-header storage disclosure
  for issue #86 alongside the local implementation. It extends the existing
  encrypted preview credential record, not inference-content retention or the
  processor list. Publication and any rollout communication remain operator decisions.

- 2026-10-05: Corrected the pending-Registrar-approval claim from Adam's account
  of the consultation: ITS suitability for P3 data and users' responsibility for
  permitted uses are distinct. Used the documentation-correction exception;
  data handling did not change and nothing was published.

- 2026-09-29: Drafted opt-in disposable-grant metadata retention alongside a
  disabled local implementation. No new processor or inference-content storage;
  existing data handling is unchanged until rollout. No publication or notices
  were sent during implementation.

- 2026-08-25: drafted from issue #65; the notification mechanics (exact
  queries for active users) are untested sketches.
- 2026-09-03: a terminology revision also corrected documentation of existing
  Sealed metadata visibility. No data handling changed, so user notification
  would have contradicted the public notice's material-change threshold; scope
  and step 5 now use that threshold explicitly.
- 2026-09-16: notice migrated from `docs/privacy.html` to root `PRIVACY.md`
  (GitHub-served markdown). Section 602.3 ACR weight moves off BayLeaf pages;
  `landing/` replaced `docs/` as the Pages source. Steps updated blindly,
  never yet guided a run.

## Moved from the playbook body

```text
- Since 2026-09-16 the notice is GitHub-served markdown (`PRIVACY.md`): push
```
