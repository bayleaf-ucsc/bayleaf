# glm-live-stream: GLM live AX trial of the deployed TTL + SSE inbox stream (2026-10-21)

Live production trial, operator-pilot gated, by glm-5.3-flash (opencode-go) as the
fresh-agent reader. One disposable `preset:"experiment"` HTTP inbox, created,
self-posted to, observed, and destroyed by the canonical client
(`api/scripts/qualify-inbox-stream.mjs --live --wait-ttl`) through the private
credential launcher; the owner key existed only in process memory. Client source
was reviewed before the run. Report separates measured outcome from expectation and
from client-source structure. No credentials, addresses, or received content here.

## Measured outcome

- Summary: `{"received":3,"catchup":true,"liveSelfPost":true,"resumed":true,
  "termination":"expired","ttlDelayMs":217}`. Exit 0. No other output lines,
  therefore no cleanup warning: the final DELETE returned 202 or 404, both accepted.
- Receipts: 3 synthetic self-posts, 3 arrival events observed, each exactly once.
  Event IDs were the asserted stable sequence `evt_1, evt_2, evt_3`, including
  across the reconnect: no duplicate, no gap, no renumbering.
- Catch-up: arrival 1 was posted before the stream opened and was replayed on the
  first connection's catch-up before `ready`.
- Same-connection live delivery: arrival 2 was posted from the `ready` handler and
  its event arrived on the same connection (the client asserts `received === 2`
  before that connection closes). No client polling is possible in this path: the
  harness reads a single SSE body to completion.
- Reconnect across a disconnected arrival: arrival 3 was posted while no connection
  existed; the resumed connection (`Last-Event-ID` with the saved cursor) delivered
  it once, on top of the asserted dedup-by-event-id discipline.
- Lifetime reconnects: the trial held connections through the 5-minute stream
  lifetime repeatedly. Derived from protocol timing, not per-connection logs: a
  900 s preset with connections capped at 300 s requires at least three lifetime
  ends before expiry; every observed terminal reason before 404 was
  `lifetime`/`replay_limit` (asserted), and every reconnect succeeded on the first
  try with no backoff needed and no 429.
- TTL terminal timing: the reconnect at expiry observed HTTP 404 **217 ms** after
  `expires_at` (bound: under 5 s). The inbox's `expires_at` was present as an
  integer at creation; the endpoint died on schedule with no renewal by reads,
  arrivals, credential work, or streams.
- Total wall time: consistent with the full 15-minute preset plus a few reconnect
  setups; completed 01:57 local, well inside the client's 20-minute bound.
- Access revocation vs physical cleanup: 404 on management and stream routes was
  immediate at expiry (measured above). Sweep finalization of storage was pending
  by design (`cleanup_not_before` = expiry + quiesce) and remains unverified; the
  immediate revocation result does not imply physical erasure.

## Expectations vs experience (subjective, model perspective)

- **Could public docs guide implementation? Yes, without opening source.** I had
  previously reviewed the client, so I inverted the test: working only from the
  deployed `/llms.txt` inbox section and the new focused page
  `/docs/inboxes.md`, I could reconstruct the whole protocol (create with preset,
  credential with its own `expires_at`, connect with owner bearer only, wait for
  `ready` before self-posting, resume with `Last-Event-ID`, interpret `end`
  reasons) before re-reading the code. The focused page's frame grammar paragraph
  and four-clocks paragraph were the two pieces llms.txt alone still under-specifies.
- **Error/action semantics:** every terminal state mapped to one obvious next
  action. `lifetime` → reconnect; `not_found` → stop, confirm with a GET, treat
  cleanup as tolerant of 404. The one ambiguity I predicted in
  `qualification/glm-discovery.md` (TTL expiry indistinguishable from destruction)
  is now documented as *just like destruction, then 404*, so the observation was
  confirmation, not confusion. No unexpected error shapes appeared; nothing forced
  content-type sniffing (the JSON 404s arrived as JSON on well-formed routes).
- **Role and clock distinctions:** clear in docs and held in practice. The two
  tokens share the `sk-bayleaf-` prefix and juggling them was the main cognitive
  load of the run; the docs' naming of both formats plus "on 401, check the role"
  turned that from a trap into a checklist item. The four clocks (stream 300 s,
  endpoint 900 s, messages 90 days, credential expiry) never interacted
  confusingly: the credential was set to the inbox's `expires_at` so only one
  deadline had to be tracked live.
- **Passive observation feel: yes.** Events are minimal references; there is no
  acknowledgement, no consumption state, no work-queue guilt. Retrieving the
  message was a separate deliberate act, and nothing about reception implied
  execution: no arrival woke anything. The 300 s lifetime is felt from the client
  side as a deliberate anti-daemon design: staying connected is a choice renewed
  every five minutes, which matches the "never create an unsolicited background
  watcher" guidance rather than fighting it.
- **Transport edges:** none observed. `ready` and same-connection arrivals arrived
  promptly enough that the run's total overhead beyond the 900 s preset was
  negligible; no buffering stalls, no compression surprises, no abrupt EOFs, no
  auth denials. The absence of events is itself unobservable except as silence:
  the connection simply stays open until its next lifetime end.

## Doc-fix verification (follow-up to qualification/glm-discovery.md)

All seven proposed fixes are live in both `/llms.txt` and `/docs/inboxes.md`:
(1) TTL guidance with preset naming and the credential-vs-endpoint expiry
disambiguation; (3) operations list now names `listInboxEvents`/`streamInboxEvents`;
(4) wait-for-`ready`-before-self-post ordering; (5) frame grammar in the focused
guide; (6) both token prefixes named with the 401 role-check advice; (7) mid-stream
TTL expiry documented as `not_found`, then 404. An eighth improvement appeared
unprompted: PATCH shorten-only lifetime guidance. Fix (2), export resume wording,
is not yet assessable: the export/HAR slice is not deployed. Discovery now flows
llms.txt → focused guide → OpenAPI operations, and that path worked.

## Remaining limits

- Single run, single window, one subscriber: no contention on the four-subscriber
  cap (429/`Retry-After`), no slow-reader drop, no `cursor_expired`/410 recovery,
  no mid-stream `auth_revoked` (operator-key revocation deliberately not tested).
  Those paths are covered by local tests only.
- Per-event latencies (first `ready`, self-post-to-frame) were not instrumented by
  the canonical client; ordering and completion are measured, milliseconds beyond
  `ttlDelayMs` are not. A timings flag on the client would close this cheaply.
- Real 90-day retention, multi-day cursor persistence, and the database-epoch
  cursor-invalidation path are untested by construction.
- Physical storage finalization after expiry/destroy remains sweep-scheduled and
  unverified; only immediate access revocation is measured.
- Export and HAR surfaces were not part of this deployment or trial.
- The run proves the deployed stream behaves as documented for this client at this
  time; it does not establish general client parity (browsers, EventSource
  environments, other runtimes) or campus-wide rollout readiness.
