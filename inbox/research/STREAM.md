# Resumable arrival stream: transport and cost qualification

Issue [#97](https://github.com/bayleaf-ucsc/bayleaf/issues/97), "Extension: catch up,
then follow a live inbox stream". Desk research against Cloudflare documentation
fetched on 2026-10-21, plus local Miniflare behavior. Nothing deployed or measured
in production. Prices are list prices on Workers Paid (Standard usage model).

## Question

Owners want to stop polling: catch up from a cursor, then follow new arrivals
without gaps. The issue warns: "do not assume an open SSE connection sleeps for
free". What does a held-open connection cost on each Cloudflare option, and what
is the simplest design that is gap-free?

## What the documentation says

**Stateless Workers bill CPU, not wall time.** Workers Standard has "No charge or
limit for duration"; billing is requests (10 M/month included, then $0.30/M) and CPU
time (30 M CPU-ms included, then $0.02/M CPU-ms).
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
"Waiting on network requests (such as `fetch()` calls, KV reads, or database
queries) does **not** count toward CPU time."
[Limits: CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
HTTP-triggered Workers have no duration limit: "As long as the client remains
connected, the Worker can continue processing, making subrequests, and streaming a
response body."
[Limits: Duration](https://developers.cloudflare.com/workers/platform/limits/#duration)
So an SSE response held open by an ordinary Worker costs one request plus the CPU
it actually executes (polls, serialization, heartbeats). It is not free (it holds
an isolate, a connection, and subrequest budget), but idle wall time is not billed.

**Service bindings do not add request charges.** "Requests made from your Worker to
another worker via a Service Binding do not incur additional request fees ... billed
as one request (for the initial invocation of Worker A) [and] the total amount of
CPU time used across both Worker A and Worker B."
[Pricing: Service bindings](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings)
RPC can return a `ReadableStream` or `Response` "with automatic streaming flow
control"; only byte-oriented streams are supported.
[RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/) The API
facade relaying an SSE body from `InboxManagement` therefore costs one API request
plus both Workers' CPU. Service-binding invocations share the top-level request's
six-connection "waiting for headers" limit, which a stream does not hold after its
headers arrive. [Limits: Simultaneous open connections](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)

**Practical lifetime bounds exist anyway.** Runtime updates give "existing Workers
requests and connections up to 20 minutes to finish. This includes streaming HTTP
responses", and crashes or resource pressure can interrupt earlier.
[Limits: Runtime updates](https://developers.cloudflare.com/workers/platform/limits/#runtime-updates)
Client-to-Cloudflare HTTP/1.1 keep-alive and HTTP/2 idle limits are 400 s.
[Connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)
Every stream design must survive disconnection; heartbeats every tens of seconds
keep intermediaries from reaping a quiet stream. Paid plans allow 10,000
subrequests per invocation by default.
[Limits: Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)

**Durable Objects bill wall time unless hibernatable.** "Durable Objects are billed
for compute duration (wall-clock time) while the Durable Object is actively running
or is idle in memory but unable to hibernate", at 128 MB regardless of use: 400,000
GB-s/month included, then $12.50/M GB-s; requests 1 M included, then $0.15/M.
[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
Hibernation requires that "No request/event is still being processed". An SSE
response served from a DO is an unfinished request, so the object stays in the
billed non-hibernatable state for the stream's whole life.
[DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
The Hibernation WebSocket API is the exception: "Clients remain connected while the
Durable Object is not in memory" and duration "do[es] not accrue during
hibernation"; outgoing messages are free, incoming ones bill at 20:1, and protocol
pings or `setWebSocketAutoResponse` replies incur no duration.
[DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

**D1 is the shared bottleneck, not the bill.** Each D1 database "is inherently
single-threaded, and processes queries one at a time": about 1,000 queries/s at 1 ms
each, less with per-request overhead. Rows read cost $0.001/M after 25 B/month.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workers pricing: D1](https://developers.cloudflare.com/workers/platform/pricing/#d1)
Polling streams compete with reception on the same database.

## Cost model: 50 owners, one client each, 8 connected hours/day, 30 days

Connected time: 50 x 8 h x 30 = 12,000 h = 43.2 M s. Figures are marginal on top of
the existing $5 plan minimum and assume the account's included allowances are not
already consumed by other BayLeaf traffic (worst case noted).

| Option | Billable drivers | Estimate/month |
|---|---|---|
| A. Client polls the finite feed every 30 s | 1.44 M API requests, each also paying API key auth (an API D1 read) | request component $0 included or $0.432 at overage rates; CPU and D1 additional |
| B. Worker SSE, 300 s lifetime, polls D1 every 3 s | 144,000 connections (12/h); 14.4 M D1 polling batches (at least two rows each when empty); assumed 1 CPU-ms per poll, not measured | requests $0.0432 worst case; CPU 14.4 M ms, $0 included or $0.288 worst case; about 30–45 M idle D1 rows, $0 included, $0.03–$0.045 at overage rates |
| C. SSE served from a per-owner Durable Object | 43.2 M s x 0.128 GB = 5.5296 M GB-s, minus 0.4 M included | **$75**: 5.1296 M excess GB-s rounded up to 6 M, x $12.50/M (following Cloudflare's current examples and rounding rule) |
| D. Hibernating WebSocket DO, notified after commit | connections plus one DO request per receipt (for example 200/owner/day = 300,000), active wall time only | sparse-event model about $0 included; at 10 ms active time per receipt, 384 GB-s/month; reauth alarms and recovery work additional |

B's real cost is load: at peak, 50 concurrent streams polling every 3 s add about 17
batches/s (about 50 statements/s if the finite feed's three-query batch is reused)
to the single-threaded inbox D1, and
arrival latency is up to the poll interval. C is the trap the issue anticipated: an
open SSE stream from a DO cannot rely on WebSocket hibernation. D can avoid the idle
D1 polling load, with lower expected latency, but the cost of wake-up reconciliation
and active revocation checks must also be included in a real implementation.

These estimates exclude receipt ingestion, R2, facade authentication CPU, stream
lease writes, event-log writes/deletes/index maintenance, and non-idle replay.
Those need measured CPU and `meta.rows_read/rows_written`, not inferred zero cost.
The D1 allowance is shared with other services; the under-$1 estimate for B is
an idle transport model, not a spend cap. Six connections is a per-invocation
outbound establishment limit, not a six-subscriber platform cap. Application
subscriber limits must be enforced separately.

## Gap-free design (independent of transport)

Gap-freedom comes from storage, not from the socket:

1. **One durable event per stored receipt, in the commit transaction.** The batch
   that marks a message `stored` also bumps a single-row high-water counter and
   inserts `events(seq, inbox_id, message_id, ...)`. D1 serializes writes, so commit
   order equals sequence order: once a reader has seen `seq = n`, no event with a
   smaller seq can appear later. This is the "outbox written with the receipt"
   pattern; there is no separate wake-up that can be lost.
   [D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
   documents transactional rollback of the whole sequence if any statement fails.
2. **Cursors are positions, not timestamps.** A cursor names (feed epoch, inbox, seq).
   Reading `after` a cursor is a range scan on `(inbox_id, seq)`.
3. **Revalidate on read.** Events are joined with currently visible messages, and
   removed with their messages, so a stale event never resurrects deleted or
   expired content.
4. **Expired cursor is detectable.** A cursor from another epoch (database rebuilt,
   exported elsewhere) or above the high-water mark (history rewound, for example a
   point-in-time restore) cannot be honored safely; the reader is told to resync.
5. **Catch up, then follow, with one loop.** The stream replays pages from the
   cursor and then keeps asking the same query. Whether "keep asking" is a timer
   (B) or a DO wake-up (D) changes latency and cost, not correctness. A DO wake-up
   lost to eviction is reconciled by the next read from D1.

## Recommendation

**Recommended next transport: B, a finite `events?after=` feed plus a short, bounded-lifetime SSE
stream from the inbox Worker that catches up from D1, polls D1 every few seconds,
and closes itself (default 300 s), letting the client reconnect with its cursor.**

- It is the simplest thing that is gap-free, because correctness lives in D1 (1–4
  above) and the stream is just repeated reads. No new binding, class migration or
  coordination state.
- The idle request/CPU/read component is sub-dollar at the target scale; lease
  writes add approximately another dollar at overage rates (see implementation
  outcome below). Both are far below C's idle wall-time charge. Bounded lifetime
  limits subrequests and runtime-update disruption, but is **not** the revocation
  mechanism: the implemented facade actively reauthenticates inside the connection.
- Subscriber limits need no in-memory coordinator: a D1 lease row per open stream,
  expiring at the lifetime bound, caps streams per inbox even across isolates.
- Cursors, minimal event references and replay semantics remain useful across
  transports. Moving from SSE to WebSocket does require a new live client adapter;
  it must not silently change the finite-feed contract. A self-hosted offramp can
  implement the finite feed with SQLite and live following with a bounded loop.

Revisit **D** if any trigger holds: many more concurrent streams (the D1 poll rate
approaches about 10% of capacity), sub-second latency becomes a requirement, or
D1 contention shows up in reception latency. D's cost is mostly complexity: a
Durable Object class and migration, a post-commit notify (best effort, reconciled
from D1), WebSocket upgrade forwarding through the API facade, and the fact that
browser `WebSocket` and `EventSource` cannot set an `Authorization` header.
An SSE client under today's owner auth must use authenticated `fetch()` streaming,
not a bearer token in a URL. Browser cookie/session access is not added here.
Avoid **C**.

## Open questions

- Production check of B: measure actual CPU per poll and D1 query time with a
  synthetic owner before enabling for anyone but the operator.
- Verify real Cloudflare edge flushing, disconnect propagation and runtime-update
  reconnection with `curl -N` against the deployed operator pilot. The implementation
  now has the API own SSE; its service binding exchanges finite JSON pages, never
  a long response body. Local real-HTTP tests prove this path does not buffer to EOF.
- Measure passive sandbox control-plane auth load and quota behavior. Rechecking
  canonical sandbox auth every two seconds includes a Daytona metadata read; 50
  sandbox-authenticated owners would cause about 25 passive requests/s while connected.
  Failure or slowness ends the stream; it must not silently extend access.

## Implementation outcome (local only)

Finite catch-up was implemented first. That initial handoff deliberately omitted
an unqualified SSE experiment (its large slow-reader fixture timed out during D1
seeding, not stream handling). **The resumed assignment completes actual live SSE**:
the API streams directly and internally reads the same durable event feed over its
service binding. There is no client polling substitute and no DO duration billing.
No production traffic, remote migration or deployment was performed here.

The API re-resolves the actual owner credential every iteration, including sandbox
verifier/control-plane checks. A 4.5-second freshness watchdog (50 ms timer cadence)
fails closed even if those operations stall; it does not merely trust the original
account generation for five minutes. Real localhost HTTP tests cover both ordinary
key and sandbox revocation/rotation, generation change, inbox TTL/destruction,
caps, disconnect cleanup, stalled auth, slow readers and replay-limit reconnection.
An event-loop stall or bytes already sent cannot be undone: five seconds is the
server-side running-runtime detection target, not a guaranteed network delivery time.

Implemented bounds: four leases per inbox across isolates; lease hard expiry 300 s;
stream lifetime at most 300 s; poll at most every two seconds; page 100 references;
1,000 events/512 KiB per connection; two seconds without pull demand; one page and
one encoded chunk (64 KiB including reserved terminal allowance) in application
buffering. Normal disconnect release is immediate/best effort with `waitUntil`;
crashed/lost release cannot reserve a slot past the lease deadline.

The study's B table uses a three-second polling example. The implemented default
is **two seconds**, to leave room inside the five-second auth/liveness target:
21.6 M checks/month and 144,000 five-minute connections at the stated scale.
At an **unmeasured assumption** of 1 CPU-ms/check, CPU overage is $0.432 and request
overage $0.0432; roughly 65–110 M idle D1 row reads (including auth) add about
$0.065–$0.11 if allowances are already spent. That is about **$0.54–$0.59/month**
for the modeled idle request/CPU/read component. Acquisition/release also write
the lease table and indexes: estimating 3–4 billed row writes per insert/delete,
144,000 connections add 0.864–1.152 M row writes, or **$0.864–$1.152** at D1 overage
rates. Combined idle estimate: **about $1.40–$1.75/month**, or zero incremental
within unused plan allowances. Verify actual index accounting with D1 meta rather
than treating this estimate as measurement. This excludes receipt/event ingestion,
real auth CPU and third-party control-plane costs/limits.

Integration source: `0003_lifetimes.sql` matches the main TTL work byte for byte
(SHA-256 `6b7553ba82c1421b3df644c80ac2149ab0759debe2a0cff1f1cc6e940d3182b2`).
Events/leases are `0004_events.sql`. New event/lease reads use execution-time
`unixepoch()` LIVE predicates, and the atomic stored/event commit preserves the
TTL stored-mark/post-read fence. **Do not replace main's Worker wholesale**: keep
its latest async visibleMessage, lifetime receipt checks and sweep budget/pagination
fixes. The lease-prune addition is bounded to 50 indexed expired rows per sweep;
the integration agent should place it inside the current sweep's budget mechanism.

The implemented log uses a monotonic **per-inbox** counter (not a global one),
written with the receipt commit in a D1 batch. Event rows live only as long as
their messages. Thus ordinary deletion/expiry filters the replay, but does not
expire a cursor: nothing visible has been lost from the log. `expired` is reserved
for a foreign database epoch or a cursor beyond a rewound head. A restore that
reuses the epoch and has already caught up past an old cursor cannot be detected;
operators must regenerate `event_feed.epoch` after restore/import before reopening
reception. Events/heads are read in one primary D1 batch; read replication is not
enabled or assumed. Deletion here means live-store deletion, not provider history.

### Exposure decisions for this local revision

| Surface | Decision | Follow-up |
|---|---|---|
| HTTP and generated OpenAPI | Expose finite GET events and bounded live SSE under existing owner middleware | Local real-HTTP/API/RPC tests; integration/rollout by main session |
| Main agent reference (`llms.txt`) | Explain finite catch-up and explicitly requested live monitoring; no unsolicited watcher | Exact schema stays code-owned |
| Hosted OpenChamber/OpenCode | Defer new typed event tool and live client; existing HTTP access unchanged | Adapter maintainer after transport contract qualification |
| Hosted Nanobot | Defer new event MCP tool or background watcher; existing HTTP access unchanged | Adapter maintainer after transport contract qualification |
| BayLeaf Chat | Defer event tooling, no reception-driven inference | Operator to choose scope after qualification |
| Desktop Standard/Sealed | HTTP docs only; no new installation or background subscription | Desktop adapter maintainer after transport qualification |
| Browser diagnostics | Omit: existing metadata snapshot is unchanged | Broader inspector remains separately deferred |

All shipped authority remains ordinary-key/sandbox-credential owner scope, without
new credentials, inference budgets or autonomous behavior. Fresh/existing/sleeping
client delivery and behavioral discovery are not claimed from source changes.

### Local verification

- `inbox/`: `npm install` completed; `npm test`: **63 tests, 17 suites, 63 passed,
  zero failures, cancellations, skips or todos** (baseline was 53 tests).
- `api/`: `npm install` completed; `npm run test:inboxes` passed (one facade harness),
  `npm run test:inboxes-e2e`: **67 checks passed**, `npm run test:docs` passed
  (one documentation harness), `npx tsc --noEmit` passed. Facade/docs harnesses do
  not emit assertion counts; no invented totals are reported here.
- `git diff --check` passed.
- `npm run test:inbox-stream`: **18 tests, 18 passed**, zero failures/cancellations/
  skips/todos. This standalone harness supplies build-only adapter fixtures in
  memory, performs actual Node HTTP streaming, and uses real API/inbox D1/R2/RPC.
- The opt-in live qualification client refuses to run without `--live`; the guard
  was tested without credentials or network. The live path itself has not run here.

Coverage includes bounded 100-event replay, empty pages, concurrent delayed R2
commit ordering, atomic rollback on event-insert failure and stale-object cleanup,
email symmetry, backfill, owner isolation, expiry/deletion revalidation, sequence
non-reuse, epoch/rewind HTTP 410, key rotation, pilot/disabled gates, SSE OpenAPI
exposure and no inference credentials or external provider/network calls. The
stream suite also tests a receipt committed between acquisition's `after=now`
snapshot and the first read: acquisition returns a concrete starting cursor,
so that handshake interval cannot silently skip an arrival.

This isolated worktree has uninitialized adapter submodules. API bundling was
tested with explicitly synthetic, ignored `.sandbox-plugin-ref.json` and
`.nanobot-assets.json` build-only fixtures, not real package assets. These fixtures
were removed after testing so they cannot be mistaken for deployment inputs.
Actual adapter packaging, production migration timing/backfill cost, CPU and
edge transport behavior remain unqualified. In a fully initialized checkout,
generate the ordinary approved manifests before rerunning the API harnesses.
