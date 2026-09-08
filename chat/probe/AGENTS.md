# BayLeaf Probe

One Cloudflare Worker at `https://probe.bayleaf.dev`, a non-public operational
service protected by HTTP Basic authentication. UptimeRobot polls it for
availability and response-time monitoring; `https://status.bayleaf.dev` is the
public UptimeRobot status surface, not this Worker's UI. The Worker owns no
history, dashboard, or alert delivery. Read `README.md` for the full measurement
contract, qualification procedures, credential handling, and deployment state.

## Probe Layers

All routes accept GET and HEAD, use the fixed prompt `What's BayLeaf?`, and
perform fresh work. HEAD withholds headers until the transaction finishes,
including browser cleanup. HTTP 200 means the whole contract passed, not just
that a server answered. The two OWUI layers use the same dedicated non-admin
account under ordinary model permissions and rate limits.

| Route | What success establishes | What it does not test |
|---|---|---|
| `/chat/basic` | OWUI API-key authentication, model authorization, filters, OpenRouter connection, and a complete nonempty SSE answer from Basic | Browser UI, Socket.IO, saved conversations, or campus login; no chat/session IDs are sent |
| `/chat/basic/e2e` | Remote Cloudflare browser loads Basic, submits through the UI, renders a completed answer, verifies its persisted record, closes the browser, and deletes the exact synthetic chat | Campus login: an ordinary session JWT is injected rather than exercising CILogon |
| `/openrouter/basic` | Direct OpenRouter streaming inference on `z-ai/glm-5.3-flash`, explicitly restricted to ZDR providers, using the shared SSE validator | OWUI, its credentials, or Basic's system prompt and injected context |

Browser failure with HTTP success points toward the browser/session/persistence
path; OWUI HTTP failure with direct success points toward the OWUI-specific path.
These are diagnostic leads, not proofs: credentials, provider routing, context,
output length, caches, and transient load differ. None checks factual correctness
or BayLeaf API/Sealed availability.

## Measurement Snapshot (2026-09-08)

Production qualification at 19:38-19:40 UTC, version
`b30214e8-7ae7-4a33-916c-c7b006b1fbe5`. These are concrete examples of current
measurements, **not established typical values, averages, percentiles, or SLOs**.
Each column is an independent request. All six returned 200 / `ok`.

| Route | GET Worker total | HEAD Worker total |
|---|---:|---:|
| `/chat/basic` | 13.130 s | 17.775 s |
| `/chat/basic/e2e` | 19.963 s | 16.753 s |
| `/openrouter/basic` | 14.456 s | 1.601 s |

Browser detail distinguishes cumulative event offsets from additive phases:

| Measurement | Kind | GET | HEAD |
|---|---|---:|---:|
| First visible answer | Offset from Worker start | 15.291 s | 12.868 s |
| Completed rendered answer | Offset from Worker start | 19.337 s | 16.219 s |
| Persistence read/validation | Sequential phase | 75 ms | 54 ms |
| Browser close | Sequential phase | 124 ms | 87 ms |
| Exact-chat cleanup | Sequential phase | 237 ms | 249 ms |

Both synthetic chats were independently observed and confirmed deleted; no chats
remained. Totals exclude monitor-to-Worker transport and response delivery.
UptimeRobot response times therefore need not equal these Worker totals.

## Metrics and Monitoring

- Authenticated GET returns metrics-v2 JSON; HEAD returns the same measurement
  contract through headers. `Server-Timing` carries additive `p_<phase>` durations
  and total/accounted/unaccounted summaries. `X-BayLeaf-Probe-Events` carries
  cumulative event offsets, never additional durations to sum.
- HTTP phases separate response headers, first byte, first non-reasoning answer,
  answer streaming, stop-to-DONE, DONE-to-EOF, validation, and stream cleanup.
- Browser phases separate acquisition/setup, navigation, composer preparation,
  submission, remaining render waits, persistence verification, close, and chat
  cleanup. Event offsets expose overlapping document/auth/creation/render work.
  A persistence read is not a measurement of the original database write.
- Configure ordinary UptimeRobot HTTP monitors with HTTP Basic authentication;
  use the monitoring password, never an upstream credential. Five-minute polling
  means nominally 288 transactions/day per route, plus retries. UptimeRobot owns
  collection, history, alerts, and the public status page; do not assume it stores
  the detailed phase headers. Inspect authenticated GET JSON for decomposition.
- HTTP work has a 25-second deadline (plus up to one second of cleanup), suitable
  for a 30-second monitor. Browser work has a 55-second deadline plus up to roughly
  21 seconds of close/cleanup. UptimeRobot's 60-second maximum cannot cover that
  worst case: treat browser monitoring as experimental until budgets are aligned.
- The deployed browser JWT expires **2026-10-08 19:38:04 UTC**. Automatic renewal
  is not installed. Follow `README.md` for explicit renewal; distinguish an expired
  monitor credential from a campus-user outage.
- Production endpoint qualification is recorded; UptimeRobot collection, public
  status-page inclusion of each monitor, and alert delivery require separate
  verification. Do not infer those from a successful direct probe request.

## Implementation Rules

- Keep all probe layers in this one Worker, separate from BayLeaf API. It may
  hold the dedicated non-admin Chat API key, ordinary monitoring session JWT,
  and an OpenRouter inference-only key. Never an administrator credential,
  JWT-signing secret, or OpenRouter management/provisioning key.
- Direct `/openrouter/basic` pins Basic's checked-in base model and enforces
  `provider.zdr: true`. Update its constant and drift test with Basic model swaps.
  It omits Basic's system prompt and injected context, not a matched workload.
- Metrics v2: authenticated GET JSON and HEAD headers include additive,
  nonoverlapping monotonic phases, separately named event offsets, and failed
  phases plus independent cleanup. Never label cumulative offsets as durations
  or subtract independent requests to claim pure OWUI/database overhead.
- Browser success requires completed visible output, verified persistence, and
  confirmed exact synthetic-chat cleanup. Close and cleanup get independent
  bounded budgets after cancellation. Never delete unmarked or unrelated chats.
- Session injection skips campus login; do not claim CILogon coverage.
- Fixed upstream, model, and prompt. No caller-supplied inference parameters.
- HEAD must do the same work as GET and withhold headers until completion.
- Never turn partial output, rate limiting, or a cached result into success.
- No response contents, credentials, or raw errors in logs or metric responses.
- No D1, KV, scheduled jobs, custom UI, or notification pipeline without a new
  requirement. UptimeRobot owns collection, history, and alert delivery.
- `npm test` and `npx wrangler deploy --dry-run` before deploying.
- `*.secrets.json` and `.dev.vars*` are ignored. Never print or commit them.
- Do not change existing Chat grants merely to make the probe green.
