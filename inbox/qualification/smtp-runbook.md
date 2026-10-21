# Operator runbook: real SMTP failures, retries and duplicates

**Not executed.** Prepared 2026-10-21 for issue #97. Every live send, fixture
deployment, rule/DNS change and fault injection below requires Adam's explicit
approval. Do not run this against arbitrary users or weaken the existing pilot.

## What the Cloudflare docs actually promise

Sources fetched 2026-10-21 (the old email-routing URLs redirect to email-service):

- [Workers email API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/):
  `message.setReject(reason)` rejects with a **permanent SMTP error**. A reason
  starting `4.7.0` does **not** select temporary SMTP semantics.
- [Inbound limits](https://developers.cloudflare.com/email-service/platform/limits/):
  inbound message maximum is **25 MiB**, including MIME overhead. Do not confuse
  this with the separate outbound Email Sending 5 MiB limit.
- [Email lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/):
  inbound processing checks authentication/reputation, then routing, then Worker
  action. Its documented soft-bounce/exponential-backoff behavior describes
  **outbound delivery/forwarding**. It does not specify an uncaught inbound Worker
  exception retry schedule, SMTP status, or durable event replay guarantee.
- [Postmaster](https://developers.cloudflare.com/email-service/reference/postmaster/):
  inbound mail must pass SPF or DKIM and is subject to DMARC/reputation checks.
  Forwarded destination errors are returned in-session. Email Routing does not
  forward NDRs to the original sender. Neither observation establishes what an
  uncaught storage error in our non-forwarding Worker does.

**Do not invent a 4xx-on-throw contract, retry duration or exactly-once delivery.**
The outcome of thrown exceptions is a test question. SMTP sender retry policy
belongs to the sending MTA; Cloudflare event replay, if observed, is separate.

## Prerequisites and containment

1. Approve a bounded test window and budget: at most 20 ordinary messages plus
   explicitly approved rate/size cases. Use only synthetic text and attachments.
   Agree a retry observation horizon using the controlled sender's configured
   queue lifetime; if it exceeds the test window, stop and mark it pending rather
   than silently running an unattended watch.
2. Prefer a **separate disposable Email Routing domain and Worker clone**, with
   separate D1/R2, matching production source/version/vars. Never fault the shared
   receiving Worker, remove real bindings, change real mailbox quotas, or delete
   real objects. Reconcile DNS with Email Routing's actual required SPF/MX records;
   do not install a conflicting second SPF record or replace them with `-all`.
3. Use an operator-controlled MTA/source IP and domain with working SPF and DKIM,
   a controlled return mailbox and access to delivery/queue logs. A cloud relay's
   initial `250 queued` proves only relay acceptance: capture its later connection
   and final DATA reply **from Cloudflare MX**. If direct SMTP is blocked or rejected
   for reputation, resolve that before interpreting Worker outcomes.
4. Create two test email inboxes A/B and one HTTP-type inbox H. Keep their handles,
   nonces, owner key and exact addresses in a private mode-0600 evidence directory,
   not this repo or terminal transcripts destined for publication. Record baseline
   counts and verify no unrelated content is present. Distinct synthetic run IDs
   and Message-IDs identify tests, but are not deduplication keys in BayLeaf.
5. Prepare a reviewed **test-only clone** with faults selected by exact disposable
   envelope recipients, not MIME headers. Fault locations: before reservation,
   R2 put rejection, after successful R2 put but before stored-row update, and
   after stored-row update but before handler return. Every fault must rethrow;
   do not swallow it or substitute `setReject`. For commit-stage cases, wrap the
   real binding operation, then throw at the named point. No real outage or
   production secret is needed. This fault adapter is **not implemented here**;
   review its diff locally before any authorized deployment.
6. Keep Worker observability disabled. Do not globally tail request/content logs.
   Use sender-side synthetic SMTP transcripts, private owner readback and narrowly
   scoped storage-count checks. Cloudflare Email activity logs already contain
   addresses and metadata: treat them as private evidence, not a new publication
   or telemetry feed. Record Worker version, fault adapter diff/hash, bindings,
   compatibility date, routing rule and test clock in the private manifest.

## Test matrix and required evidence

For each case record UTC send/attempt times, sending MTA queue ID, synthetic
Message-ID/run ID, RCPT reply, **final DATA SMTP numeric reply and text**, disconnect
stage, owner-visible count, D1 states/counters and R2 object count. Check after
delivery, after one authorized later check, and after scheduled cleanup when needed.
No polling loops or automatic retries from an agent unless separately approved.

| Case | Procedure | Expected result / acceptance question |
|---|---|---|
| Baseline | Send one signed small text message to A, no faults. | Successful SMTP acceptance and exactly one stored row/object in this controlled single attempt; metadata/text/raw read succeed. Proves the sender reaches the Worker. |
| Envelope vs. headers | RCPT A, header To B; repeat as Bcc-only to A, with To naming only a controlled unrelated mailbox. | Only A receives. Header fields never route. No copy to B from the mismatched header. |
| Unknown/type mismatch/destroyed | Send separately to an unused valid nonce, H's email-form address, and a destroyed A replacement. | Permanent rejection, no receipt/object. BayLeaf reason is `5.1.1 Address not found`; record actual outer SMTP code rather than assuming it equals the embedded reason. |
| Feature disabled | On the **isolated clone only**, disable reception and send one synthetic message. | `setReject('Inbox service unavailable')`: permanent rejection expected, no stored object. Restore the clone flag before proceeding. |
| Rate reject with `4.7.0` text | On a dedicated clone inbox set ACCEPT_LIMIT to 1/60 s; send two sequential valid messages within the same window, verifying the first passes. | Second calls `setReject('4.7.0 Rate limited, try later')`. Docs predict a **permanent outer error**, not retryable 4xx. If approximate per-colo limiting does not trigger, mark inconclusive; do not flood until it does. |
| Daily/byte quota | On clone-only test inboxes use deliberately small daily/byte limits and cross them with two small messages. | `setReject('5.2.2 Mailbox full')`, permanent error, no new row/object beyond the permitted reservation. Previous stored message remains intact. |
| Raw size | Approve one valid MIME message just under 25 MiB including headers, then one just over. | Under-limit is conditional on parser/resource qualification; over-limit should be rejected at Cloudflare ingress, possibly without Worker invocation. Report which boundary rejects, do not infer from missing counts alone. |
| Throw before reservation | Send to exact fault recipient once with controlled MTA retries enabled. | Record actual SMTP failure/disconnect, whether MTA queues/retries, whether Cloudflare replays without a sender attempt, and whether any data exists. Retryability is **unknown until measured**. Remove fault, then allow one approved retry to test recovery. |
| R2 put fails | Throw from clone R2 put. | Worker throws `storage unavailable`, not `setReject`. Normally no readable receipt; pending state may be cleaned inline or by sweep. Distinguish original throw from cleanup success. Observe SMTP/MTA behavior as above. |
| R2 put succeeds, D1 finalize fails | Throw after put, before marking stored. | Raw object/pending row may remain but must be unreadable and discoverable by stale-pending cleanup after >15 minutes. Retry can produce another stored receipt. Verify all abandoned raw objects eventually disappear, including late-write reconciliation. |
| Stored then throw | Throw only after real stored-row update. | A receipt already exists even if SMTP fails or disconnects. A sender retry **may create a duplicate**. This is an acknowledgement ambiguity, not proof that the sender violated protocol. |
| Replay identical MIME | Send the same bytes and Message-ID in two distinct SMTP transactions. | Two independent BayLeaf message IDs/objects, quota permitting. No deduplication exists. Do not promise exactly once or silently discard a legitimate resend. |
| Lost final acknowledgement | Using only the controlled sender, close the SMTP connection after the final DATA dot before reading the server's reply; then intentionally replay once. | First transaction's commit is uncertain from sender evidence. Count zero/one before replay, then inspect total. Duplicates are permitted. Do not use an SMTP proxy on unrelated traffic. |

### Retry observation

- Record each sender attempt from its MTA log, with actual next-attempt schedule
  and configured final queue expiry. Do not assume Cloudflare's outbound
  exponential backoff applies to this inbound Worker.
- Compare sender attempts against added rows/objects. A later receipt without a
  sender attempt suggests platform replay, but requires complete sender logs
  before calling it such. Preserve this as observation, not a guarantee.
- Distinguish outer SMTP `4xx`, `5xx`, `2xx` and connection loss. The enhanced code
  embedded in our human-readable reason is not the outer SMTP status.
- After faults are removed, verify one approved queued retry can store/read a
  message. If a storage exception results in permanent rejection or acknowledged
  loss without durable receipt, stop rollout and seek a documented Cloudflare
  contract/support answer. Local exception tests cannot waive this gate.
- If the horizon ends without retries, report the duration/configuration and
  "not observed", never "Cloudflare never retries".

## Cleanup, evidence and rollout decision

Revoke test HTTP credentials, destroy test inboxes, verify stored/pending/deleting
rows and R2 prefixes empty after quiescence and sweeps, then remove only approved
disposable routing/infrastructure. Report opaque cleanup handles and provider
recovery history as residuals. Purge test payload/transcript files on the agreed
schedule; do not leave a retrying sender pointed at a recycled address.

Publish only sanitized case IDs, source/version/config summaries, outer SMTP
statuses, elapsed times, retry/duplicate counts and cleanup confirmations. Keep
addresses, handles, credentials, raw mail, full headers and transcripts private.
Link any provider support clarification without exposing message contents.

**Gate remains open** until permanent-reject behavior, exception durability/retry
semantics, acknowledgement ambiguity/duplicates and cleanup are evidenced or
explicitly accepted with documented limitations. This runbook itself is not
approval to send, provision, deploy or remove anything.
