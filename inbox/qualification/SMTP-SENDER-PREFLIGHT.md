# SMTP sender preflight (2026-10-21)

Scope: fewer than five synthetic self-mail messages, operator-owned sender and
new disposable BayLeaf recipient only. Production gates, existing inboxes and
runtime are outside this test's mutation scope.

## Established capabilities

- The installed `gws-ucsc` wrapper uses the isolated UCSC credential configuration
  and the native `gws-guard` confirmation mechanism. `auth status` reported OAuth2.
- Gmail `users.settings.sendAs.list` confirmed the expected operator account as
  its primary sender. No unrelated mailbox messages were listed or read. Primary status is
  the identity evidence; no separate `verificationStatus=accepted` was observed.
- The initial profile request timed out after 45 seconds. Guard source inspection
  shows `getProfile` is not recognized as read-only and requires native approval.
  The settings-list request provided the needed identity check without changing
  the guard. No direct-credential Gmail request was used.
- Local Postfix configuration has no relayhost, SMTP SASL authentication, password
  map or signing milter configured. This does not establish the absence of every
  possible remote sender, but the examined setup supplies no controlled signed MTA
  with Cloudflare-MX delivery/queue transcripts.
- Repository configuration defines the production receiver and restricted creation
  false, with no isolated restricted/fault-injection environment identified.

## Probe implementation

The recorded run used an in-memory operator-key lookup. The published
`smtp-selfmail-probe.py --send-one` instead requires explicit environment inputs
`BAYLEAF_QUALIFICATION_SENDER` and `BAYLEAF_QUALIFICATION_TOKEN`, supplied privately
after fresh send authorization. It confirms the primary UCSC sender, creates a 15-minute unrestricted email
inbox, verifies it is empty, and requests exactly one synthetic Gmail send through
the guarded wrapper. One readback follows after ten seconds, with no send retry.
The `finally` block requests destruction of only the newly created inbox.
Manifest/raw evidence uses a private directory outside the repository, mode 0700,
with mode-0600 files. No bearer is persisted. Gmail's sent copy is not deleted.

Initial two create attempts failed before any inbox or send with HTTP 403. A
read-only check identified Cloudflare error 1010 on the default Python HTTP
client. The probe now identifies itself as `BayLeafQualification/1.0` rather than
using Python's default User-Agent. This changes no server rule or credential.

## Initial outcome: blocked before confirmed submission, invocation finished

The third invocation created exactly one empty, unrestricted disposable email
inbox. It reached the native Gmail confirmation and ended with `RuntimeError`
after its bounded wait. The background completion event has been received; no
invocation remains pending and no replacement send was started. The guard retains
its normal **Google Workspace confirmation → Allow Once** approval for
`gmail users messages send` on the operator's UCSC account. That approval was not
obtained for this run. Do not approve a stale dialog or infer permission from this
report; a future attempt needs a fresh, explicitly coordinated guarded action.

**Observed no-send result:** zero confirmed Gmail submissions, zero matches from
one narrowly scoped Gmail Sent search for this exact disposable recipient and
the synthetic qualification subject, no pagination, zero BayLeaf message/event
rows, and no downloaded raw message. No SMTP exchange was observed. Thus this
run provides **no delivery, DKIM domain/selector, selector-pin, rejection or retry
qualification**. The counter is confirmed submission evidence, not an assertion
that an API timeout alone proves a message could never have been submitted.

### Exact-resource cleanup

- The probe's `finally` block requested destruction of its one created inbox and
  received `state: destroying`.
- A subsequent read-only D1 check scoped to that exact inbox found zero message,
  credential, event and stream-lease rows. The one inbox row remains `destroying`.
- A separate R2 list restricted to its exact `m/{inbox_id}/` prefix returned zero
  objects. No content or sender credential remains in this test resource.
- **Final inbox-row removal is not yet verified:** normal 15-minute quiescence and
  the scheduled sweep still apply. Do not claim complete physical erasure. Opaque
  cleanup records and provider recovery history remain the documented residuals.
- Private manifest and sanitized follow-up checks are in
  the operator's private OpenCode temporary directory (exact path omitted).
  It contains no raw message or API bearer. The manifest holds the exact cleanup
  handle for a later one-shot scheduled-cleanup verification. The two earlier
  failed-create manifests contain no created resource.

## Approved one-hour Gmail ticket: successful follow-up

After explicit authorization for synthetic test mail, the operator approved a
one-hour UCSC Gmail-only guard ticket. The probe explicitly attached it to each
`gws-ucsc` call; no direct Gmail credential access or guard bypass was used.
`--guard-ticket` is an optional probe argument, not a stored credential or
automatic approval mechanism. The ticket remains scoped to this session and is
left to expire normally.

- Exactly one confirmed Gmail submission and one matching BayLeaf receipt after
  the single ten-second readback. The received raw MIME was 7,325 bytes.
- Live public DNS verification passed in both Node and pinned workerd:
  `d=ucsc.edu`, `s=ucsc-google-2018`, `a=rsa-sha256`, strict policy.
- A separate workerd check used the **exact received bytes**, without line-ending
  conversion. The correct selector pin passed (126 ms); an intentionally wrong
  selector pin failed with `no-qualifying-signature` (48 ms). These are local
  verifier wall times, not production CPU measurements.
- This qualifies this actual campus-signed specimen and same-signature selector
  pin behavior. It does not establish every campus mail path uses this selector
  or justify permanently pinning it without handling future key rotation.
- Destruction of the newly created disposable inbox was acknowledged in `finally`.
  Physical finalization of this follow-up resource remains unverified. Synthetic
  raw evidence is private outside the repository; the Gmail Sent copy remains.

BayLeaf Inboxes remains receive-only. Gmail is solely the external test sender.
Restricted creation remains disabled; the received message used an unrestricted
temporary inbox and was independently verified afterward.

## Personal-profile follow-up: delivery passes, alignment fails

With separate explicit send authorization and a one-hour Gmail-only ticket for
the personal profile, `--account as` selected `gws-as` and verified that profile's
primary sender. Exactly one synthetic message was submitted and received in a
new unrestricted temporary inbox; the raw message was 7,224 bytes. Destruction
was acknowledged afterward, with physical finalization not yet verified.

The signature passed cryptographically in both Node and workerd, but used
`d=adamsmith-as.20251104.gappssmtp.com`, `s=20251104`, rather than the From domain
`adamsmith.as`. The strict allowlist policy therefore returned
`trusted: false`, `no-qualifying-signature`. An independent workerd run on the
exact received bytes reproduced the valid signature and alignment rejection
(129 ms local wall time). A selector pin cannot repair domain misalignment.

This is expected policy behavior, not a failed mail receipt or broken RSA
verification. It establishes how this specific personal-profile message was
signed, not every possible mail path for that domain. Domain-aligned DKIM mail
configuration would need separate investigation and authorization; neither the
sender configuration nor the inbox policy was changed. Both approved tickets
are left to expire normally, and no bearer is recorded in source or evidence.

## What Gmail cannot qualify

Gmail API submission and BayLeaf receipt prove neither the final DATA response
from Cloudflare MX nor sender queue/retry behavior. No rejection/retry semantics
may be inferred from API status, a missing receipt, or local workerd tests.

Restricted live receipt, selector-mismatch rejection, DNS/storage exceptions and
post-commit acknowledgement ambiguity remain blocked by the lack of an identified
isolated route and controlled SMTP-boundary evidence. Production restricted
creation remains disabled. No fault is injected into the shared receiver.

The successful follow-up closes basic delivery and actual campus-selector evidence.
Next identify an **existing** operator-controlled sender whose logs expose
Cloudflare's final SMTP responses and retry attempts. Without that sender or a
separately approved isolated fault route, retain the SMTP gate as unqualified;
do not provision new accounts/infrastructure or enable the global DKIM gate.
