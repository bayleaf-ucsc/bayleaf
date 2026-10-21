# Qualification hardening follow-up (local, not deployed)

Main integration evidence now lives in [INTEGRATED-HARDENING.md](INTEGRATED-HARDENING.md).
The branch-local measurements and handoff below are preserved as their original
qualification context; they are not the merged cleanup-budget measurement.

This revision implements modest fixes identified by the preserved
[MIME](mime-bench.md), [cleanup](cleanup-bench.md) and
[retirement](retirement.md) baseline evidence. Work is isolated to `inbox-qual`.
No real mail, production HTTP, remote Wrangler, commit, push or deployment was run.
The operator pilot restriction and source enablement settings are unchanged.

## Implemented

### Durable retirement, with an honest eventual handoff

- API D1 captures the exact old account generation in `inbox_retirements` in the
  same transaction as its eligibility recheck and account/key deletion. Rollback
  also rolls back this capture. Malformed generations on key rows block retirement.
- A private binding-only `retireOwner` transaction persists an inbox-side fence,
  marks every inbox of that generation destroying, removes sender credentials
  and retains object cleanup prefixes. It acknowledges logical revocation, not
  physical erasure. It works with user-facing receipt/RPC enablement off.
- Owner RPC entry, atomic creation/reservation and public receipt lookups deny
  fenced generations. Even restoring an inbox to `active` cannot bypass a surviving
  fence. Already-started reads cannot recall bytes they have obtained.
- API cleanup retries 20 pending entries and replays up to 20 acknowledged entries
  per invocation, independently of provider-key deletion and pilot flags. Missing
  binding, failure and lost acknowledgement remain pending. Cursor/check ordering
  prevents an unavailable early batch pinning all later generations.
- Provider outbox completion never erases the retirement ledger. Fresh UUID
  generations remain isolated; ordinary key rotation still preserves ownership.

**Not claimed:** identity deletion and remote fencing are not one distributed
transaction. A receipt can arrive before the fence acknowledges. This is explicitly
documented and reported pending, rather than hidden behind identity deletion.

### Bounded cleanup, including progress during failures

- Preserve 200 ordinary expiry, stale-pending and deleting-row attempts per run.
- Cap destroying inbox selection at **five**, up to 200 messages each. A durable
  round-robin cursor yields across inboxes even on failures. This deliberately
  lowers the old unsafe 50-inbox fan-out; physical destruction can take longer.
- Use durable row cursors in all three message stages. A permanently failing
  early R2 deletion batch cannot monopolize every subsequent run.
- Replace two SQL statements per removed message with one set-based counter
  update plus one row deletion, in the same transaction. Overlapping cleanup
  rechecks still prevent double counter decrements. All placeholders are reused
  and bound, never interpolated user values.
- Reconciliation uses one bounded `IN` query per prefix, not one query per object.
  Existing durable prefix pagination/round-robin and late-put reconciliation remain.
- Stress assertions count **individual SQL statements**, not just batch calls:
  sweep plus 50 reserved statements must remain <=700; total binding/R2 calls
  plus 50 reserved calls must remain <=900. Individual statements stay <=100
  parameters. The reserve is for separately integrated <=5 TTL transitions, not
  permission to add arbitrary unbounded work.

| Local stress | Peak D1 calls / statements | Peak R2 calls | Outcome |
|---|---|---:|---|
| Mixed 15,900 message rows, 16,000 objects, 1,060 prefixes, telemetry off | 262 / 327 | 82 | complete in 24 invocations |
| Same mixed backlog, **telemetry enabled** | **268 / 338** | **82** | complete in 24 invocations; peak 239 ms wall |
| 1,000 deleting rows with one permanently failing object, telemetry enabled | 35 / 46 | 4 | after six runs only the failing 50-row batch remains |
| Ordinary expiry, 10,000 rows | 32 / 41 | 4 | 200/run, 50 invocations, unchanged capacity |
| Destruction, 10 inboxes × 1,000 rows | 117 / 163 | 35 | complete in ten invocations |
| Destruction, 60 inboxes × 250 rows | 196 / 237 | 70 | all reached; complete in 24 invocations |

The full matrix was run before the telemetry-enabled mixed/failure rerun. These
are local workerd/D1/R2 timings and counts, not production CPU/latency guarantees.
Permanent cleanup-prefix growth and finite expiry capacity remain operational
limits. The fix removes the demonstrated invocation overflow; it does not make
the service capacity infinite. With five selected inboxes per run, a full default
ten-inbox owner may need 50 successful cron invocations to destroy 50k messages,
up to 12.5 hours with favorable service-wide selection, plus quiescence, orphan
cleanup, other owners and outages. Never present `cleanup_not_before` as a deadline.

### MIME: protect both parsing entry points without rewriting payloads

- A linear byte-only preflight rejects >350,000 LF bytes before postal-mime runs,
  on ingress and owner text/attachment reads. The pinned parser itself splits on
  LF; this is a work guard, not a hand-written MIME parser.
- Maintained postal-mime header/depth/part resource errors now reject ingress
  clearly with `5.3.4 MIME resource limit exceeded`, rather than silently retaining
  resource-exhaustion mail as parse-error receipts. Other parse errors retain the
  original raw-only fallback.
- Supported `maxRfc822NestingDepth:0` keeps nested message/rfc822 content as inert
  attachments. Encoded nested messages cannot trigger recursive parsing that
  bypasses the outer raw-line guard. This intentionally changes derived text:
  forwarded messages are no longer automatically flattened. Their exact decoded
  attachment and outer raw bytes are preserved, covered by regression tests.
- Resource-heavy legacy parsed reads return `resource_limit`, translated by the
  actual API facade to HTTP **413**. Known oversize metadata is checked before
  fetching a parse buffer. Exact raw download remains available for valid owners.

| Fixture | Workerd result | Receipt / text / attachment wall ms |
|---|---|---|
| 24.98 MiB base64 attachment | accepted, exact raw and decoded attachment | 428 / 227 / 237 |
| 24.98 MiB Unicode QP text | accepted, bounded text output | 402 / 259 / n/a |
| 24.98 MiB almost-matching boundaries | explicit resource rejection | 62 / n/a / n/a |
| 24.98 MiB QP soft-break-only bomb | explicit resource rejection | 52 / n/a / n/a |
| 1 million empty parts | explicit resource rejection | 22 / n/a / n/a |
| Depth 20,000 | explicit resource rejection | 7 / n/a / n/a |

The four near-limit rows were rerun with process CPU sampling scoped to this
Node process's own workerd child. A preceding concurrent-suite run could include
an unrelated disappearing workerd PID and produce a negative CPU delta; that
sample is discarded, not represented as negative Worker CPU. Wall times are single
local observations, not percentiles. In the guarded Node tier the original
boundary fixture rejects instead of aborting the 128 MiB-old-space process.
A supplementary base64-decoded two-million-newline text plus HTML fixture
(2.61 MiB raw) passed the bounded Node tier, sampled receipt estimate 24.6 MiB.
This is additional adversarial evidence, not a universal parser guarantee.

**Production memory gate remains open.** The valid near-25 MiB attachment still
has approximately 130+ MiB sampled Node heap/ArrayBuffer estimates in ordinary
diagnostic runs. Node old-space limits are not total isolate limits, and Miniflare
does not enforce production's 128 MB limit or concurrent-isolate traffic. Neither
this preflight nor the maintained parser limits prove every encoded/derived-text
allocation safe. Full near-limit/concurrent safety needs a more comprehensive
parser allocation limit, admission strategy or an explicitly reviewed smaller
service size limit. No size limit was silently lowered and no all-input safety
claim was added.

## Validation and integration handoff

- `cd inbox && npm test`: **58/58** pass, including MIME ingress/legacy reads,
  inert nested messages, disabled-mode retirement and reservation-time fence races.
- `node inbox/qualification/retirement-check.mjs`: real two-Worker, separate-D1/R2
  handoff; missing binding/lost ack; stale generation and recovery replay; actual
  HTTP 413 resource mapping with preserved raw download. Also tests >20 pending
  generations yielding fairly. No OIDC or provider call is needed.
- `cd api && npm run test:user-retention`: pass, including transactional ledger
  rollback/capture, missing-binding pending state and provider-outbox independence.
- Targeted strict TypeScript checking for `src/userRetention.ts` and
  `src/routes/inboxes.ts` passes with Workers types.
- Whole-app API facade/e2e scripts and full `tsc` cannot bundle in this isolated
  worktree because `.sandbox-plugin-ref.json` and `.nanobot-assets.json` are absent.
  No fake deployable pins/assets were manufactured to mask this. Rerun the full
  scripts in the integrated checkout with its correctly generated adapter assets.

### Additive migrations and ordering

1. Reserve/apply inbox **`0006_qualification_hardening.sql`**, after any integrated
   TTL/SSE/export migrations 0003–0005. It creates `retired_owners` and
   `cleanup_progress` only. Tests/harnesses now enumerate migrations in order.
2. Apply API **`0019_inbox_retirement.sql`** (renumber if another integration has
   reserved it), then use its matching source. It creates `inbox_retirements` plus
   bounded-queue indexes. No identity-content backfill is attempted.
3. Deploy the receiver supporting trusted `retireOwner` before the matching API
   retirement sender. Retain the pilot restriction. Old receivers cannot acknowledge
   the new call; the durable API ledger retries rather than losing the target.
4. Confirm existing orphaned generations before assuming this covers history:
   generations deleted by the old implementation were not captured by its provider
   outbox and cannot be reconstructed automatically from the new ledger.

No migrations were applied remotely and no rollout command was run here.

### SSE/TTL/export integration dependency

This branch and the committed `main` ref inspected from this worktree do not yet
contain the other session's TTL/SSE/export delta. Nothing was copied from or
written to its checkout. Preserve its **max-five TTL transitions after existing
cleanup**, merging around the new cursor/select and set-based removal helpers.
The stress test reserves 50 statements/calls but is **not** a measured combined
SSE/TTL pass. Run combined migrations, event retention/stream cleanup, TTL bounds,
retirement-triggered stream termination, export authorization and budget tests
after integration. New stream RPCs must pass the same retired-owner gate.

### Recovery and remaining human gates

Before recovering either database, keep receipt/owner access disabled. For an
inbox-only restore, enumerate **all** surviving API retirement generations and
obtain a successful `retireOwner` acknowledgement for each before reopening.
Normal daily replay is bounded: `pending:0` does not certify every historical
acknowledged entry was visited in this invocation. `checked_at` is written before
the RPC for retry fairness and is not proof of a successful fence. Preserve a
private per-recovery acknowledgement manifest, without content or credentials.

If both ledger databases are rolled back, require a separately surviving deletion
ledger or invalidate pre-recovery generations/endpoints before reopening. That
operator procedure and publication of the draft indefinite-generation disclosure
are still enablement gates, not automatic properties of these tables.

The [live SMTP runbook](smtp-runbook.md) remains unexecuted and requires a concrete
authorized synthetic sender path. No agent guessed one or sent real mail.
