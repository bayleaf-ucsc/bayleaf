# Integrated hardening qualification (2026-10-21, local)

Subsequent authorized production rollout and live results:
[`DEPLOYED-INTEGRATED.md`](DEPLOYED-INTEGRATED.md). The local evidence below is
preserved as the pre-deployment record; its deployment hold has since cleared.

Integrated into the existing main checkout without commits, pushes, remote
migrations or deployment. Independent GLM review reported no blockers; its live
report was not modified. Parent's live-SSE completion signal is still required
before deployment. Pilot restriction and DKIM restricted creation remain unchanged.

## Integration

- Retained TTL/SSE/export/DKIM changes and migrations 0003–0005/0007. Added inbox
  `0006_qualification_hardening.sql` and API `0019_inbox_retirement.sql` without a
  numbering collision.
- Central RPC dispatch fences every owner operation, including export, HAR,
  finite events and lease acquire/read/release. Shared live predicates additionally
  fence atomic reservation/stored mark, receipt lookup, content revalidation and
  export revalidation. Atomic creation checks the durable fence independently.
- `retireOwner` deletes leases in its fence transaction. A real open HTTP SSE ends
  within five seconds after fencing even when the inbox is restored to active.
  The same restored generation cannot create, export or read/follow events.
- Set-based message counter/deletion transactions also delete message events.
  Existing finite event cursor/high-water semantics and expired-lease sweep remain.
  Five TTL transitions run after cleanup/reconciliation; destruction selection and
  ordinary message stages retain durable round-robin progress.
- DKIM verification retains its pre-parse 1 MiB restricted bound and ordering.
  MIME resource errors reject explicitly even after successful DKIM verification;
  ordinary syntax errors retain the raw-only fallback. Nested messages are inert
  attachments for both policies. Exact raw download/export are not reparsed.
- postal-mime 4.0.11 exposes ordinary Error messages, not stable resource codes.
  A regression invokes the installed parser's actual depth, parts and header
  limits and asserts their messages, guarding the rejection classifier against drift.

## Tests

Commands below are local, credential-free unless already synthetic fixtures:

| Command | Result |
|---|---|
| `cd inbox && npm test` | 127 passed, 2 optional importer tests skipped, 0 failed |
| `cd inbox && node --test test/export-resources.test.mjs test/mime-errors.test.mjs` | 9 passed, 2 optional importer tests skipped; includes subsequently added retirement-during-R2-get export regression |
| `cd api && npm run test:inboxes` | passed |
| `cd api && npm run test:inboxes-e2e` | 93 checks passed |
| `cd api && npm run test:inbox-stream` | 19/19, including retirement/restored-generation SSE test |
| `cd api && npm run test:user-retention` | passed |
| `node inbox/qualification/retirement-check.mjs` | passed, two Workers/separate D1/R2, lost ack, missing binding, replay, fairness, actual HTTP 413 and original raw body |
| `cd api && npm run test:docs` | passed |
| `cd api && npm run test:telemetry` | passed, including pending inbox retirement scheduler failure/report path |
| `cd api && npx tsc --noEmit` | passed |
| `cd telemetry && npm test` | 97/97 |

Initial integration tests exposed stale hardcoded migrations in the export
resource fixture and the old DKIM resource-error acceptance expectation. Both
were fixed, then the affected suite reran. The telemetry test's old exception
wording was also updated to account for pending resource cleanup.

### Actual merged cleanup budget

`cd inbox && node qualification/cleanup-bench.mjs --only integrated-ttl-events,stuck-delete-fairness --json qualification/merged-cleanup.json`

Measured with telemetry enabled, real local workerd/D1/R2 and the merged source:
18,900 message rows, 19,000 objects, 18,300 events, 81 expired leases, 1,060 initial
prefixes and 12 expired endpoints. All messages/objects/events/leases were removed
in 29 invocations, counters returned to zero, and no invocation transitioned more
than five expired endpoints. Peak: **285 D1 calls / 402 individual statements,
82 R2 calls, 51 parameters**, 291 ms observed wall time. This includes actual TTL
transitions, event cleanup and telemetry; the harness additionally retains its
50-statement/call reserve (452 statements <=700, 417 binding/R2 calls <=900).
The permanently failing-object scenario leaves only its 50-row batch after six
runs; later rows progress. Full content-free count evidence: `merged-cleanup.json`.

These are local measurements, not production CPU or latency guarantees. Permanent
opaque prefix growth and finite service-wide cleanup capacity remain limits.

### Merged MIME spot check

`cd inbox && node qualification/mime-bench.mjs --tier workerd --only near-limit-attachment,near-limit-text-unicode-qp,qp-soft-break-bomb,many-empty-parts-1m`

Both valid 24.98 MiB fixtures were stored and read; attachment raw download was
26,198,041 bytes and decoded attachment 19,144,411 bytes. Receipt/text/attachment
wall times were 420/223/243 ms; Unicode-QP receipt/text were 408/176 ms with bounded
text. Soft-break and million-empty-part fixtures rejected before storage in 58/22 ms.
The attachment receipt observed 165.5 MB process RSS growth: **production memory
and concurrent-isolate safety remain unqualified**. No size limit was lowered.

## Deployment order and remaining gates

1. Await parent's live-SSE completion signal. GLM hardening review is clear.
2. Deploy collector export-counter vocabulary before the exporting receiver.
3. Apply inbox migrations through 0007 in order (0005 export, 0006 hardening,
   0007 email policy), and API 0019 before its matching runtime. Confirm remote
   applied-migration state first; this integration performed no remote commands.
4. Build the pinned DKIM verifier, deploy the receiver with restricted creation
   disabled, then deploy the matching API. Preserve the operator pilot. Verify
   the old receiver version has drained before any future restricted creation.
5. Qualify deployed paths and record versions separately. This report is not
   deployment evidence or a campus enablement decision.

Account retirement still has an **eventual cross-service handoff**: identity
deletion and the inbox fence are not one transaction. A successful fence is logical
revocation, not physical erasure. Daily retry/replay and pending aggregate reporting
remain intentional. Retirement does not currently emit `destroy_requested`
lifecycle counters; cleanup remains counted. Do not interpret lifecycle counts as
a complete retirement census.

Restoring both ledgers is not solved. Preserve a separately surviving retirement
ledger or invalidate old generations/endpoints before reopening; inbox-only
restore requires complete fence replay with explicit acknowledgements. Historical
orphan generations cannot be reconstructed automatically. Real SMTP behavior,
production memory/concurrency, recovery procedure and disclosure publication
remain campus rollout gates. No worktrees were removed.
