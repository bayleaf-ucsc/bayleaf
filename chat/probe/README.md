# BayLeaf Probe

A small Cloudflare Worker that makes a synthetic opening conversation measurable
by UptimeRobot Free. No UI, historical storage, or alerting machinery of its own.

**Deployment state (2026-09-09 UTC): all four layers are deployed at
`probe.bayleaf.dev`; the new `/api/recommended` layer is credentialed and
production-qualified.** Adam created its UptimeRobot monitor manually at a
15-minute interval before deployment, so its initial history may include setup
failures. Initial green samples and failure/recovery alert delivery are not yet
verified.

The dedicated non-admin Chat account and restricted API key exist. The same
`probe@bayleaf.dev` pseudo-user now has a separate BayLeaf API token and `$1/day`
OpenRouter cap. Authenticated HEAD checks wait for actual completed answers;
unauthenticated requests return 401.
Source preflight passed 33 tests, qualification-script syntax checks, Wrangler
4.130.0 dry-run bundling, and `git diff --check`.

Browser, direct OpenRouter, BayLeaf API, and metrics v2 run in this same Worker.
Production qualification is recorded below. Earlier localhost/remote-browser
experiments are retained as historical evidence, not the current deployment
state. No Chat grant change was made for the API layer.

Initial qualification found a real non-admin authorization failure: Basic was
shared, but its new base model lacked a model-table record and read grant.
Registering that base as public, active, and hidden repaired the failure without
a probe-only exception. See `../models/base-glm-5.3-flash/model.json`. The hidden
flag affects the picker only; direct raw-model use is now authorized too.

Three direct non-admin checks after repair completed in 2.16, 2.13, and 1.97
seconds. After deployment propagated, the first Worker check reached its
25-second deadline and correctly returned 503; the next four HEAD checks passed
in 1.79, 2.34, 3.37, and 2.00 seconds. These are qualification observations, not
a latency distribution or an explanation of the timed-out request.

## Contract

`GET` or `HEAD https://probe.bayleaf.dev/chat/basic`, authenticated with HTTP Basic
(username `probe`, password held as a Worker secret), makes one streaming request
to Chat's `/api/chat/completions` using `basic` and exactly `What's BayLeaf?`.

The Worker returns 200 only after receiving nonempty answer text, an OpenAI
`finish_reason: stop`, the `[DONE]` sentinel, and clean stream EOF. Errors,
truncation, tool calls, unsupported protocols, size limits, and deadlines fail
closed. HTTP headers are withheld until that check finishes, including for HEAD.
UptimeRobot's initial-response timing therefore includes the completed Chat
transaction plus network and Worker overhead.

Authenticated responses, including disabled/configuration/admission failures,
include `X-BayLeaf-Probe-Result` and metrics v2. GET returns JSON containing
`version`, `layer`, `result`, and `metrics`; HEAD remains bodyless with the same
metric headers and completed-work semantics. This replaces the original GET's
plain `OK`/failure text; the monitor's status-code contract and existing HTTP
result codes are preserved. Codes contain no upstream body, output, or credentials:

- `ok` — the complete transaction passed.
- `chat_http_<status>` — Chat did not return HTTP 200 (for example, `chat_http_401`).
- `chat_transport` — the Worker could not complete the request to Chat.
- `chat_protocol` — Chat returned 200 but not an SSE response body.
- `stream_incomplete` — SSE ended without a nonempty answer, `stop`, and `[DONE]`.
- `stream_invalid` — malformed SSE, tool call, error event, truncation, or a size limit.
- `rate_limited`, `deadline`, `client_aborted`, `probe_internal` — Worker-side admission
  or lifecycle failure.
- `disabled`, `not_configured` — authenticated kill-switch or missing/invalid
  route-specific configuration. Unauthenticated callers get no detailed metrics.

This checks OWUI authentication, model authorization, filters, its configured
OpenRouter connection, and HTTP streaming. It does **not** check campus login,
frontend rendering, Socket.IO, native tool continuation, or saved-chat writes.
No parent, chat, or session IDs are sent, so the built-in OWUI path does not
create a conversation record. This is not the browser Temporary Chat path.
No claim that database latency has been ruled out: the browser comparison below
does not isolate database cost.

Chat uses its existing ZDR inference connection. The adapter consumes only its
fixed synthetic prompt and answer, retaining neither. It does not receive human
conversations. Workers observability and preview URLs are disabled. Replies
contain only status/measurement metadata with `Cache-Control: no-store`.

## Direct OpenRouter

`GET` and `HEAD /openrouter/basic` use the same Worker, password, kill switch,
deadline, and SSE parser. The only additional secret is `OPENROUTER_API_KEY`, an
**inference-only** credential. Never supply a provisioning/management key. The
route needs neither the OWUI API key nor the browser session. Missing its secret
fails before admission or any outbound call; no key is provisioned automatically.

The fixed endpoint is `https://openrouter.ai/api/v1/chat/completions`, redirects
are not followed, and the fixed model is `z-ai/glm-5.3-flash`, matching Basic's
checked-in base configuration. A test detects model drift. The request includes
only `What's BayLeaf?`, `stream: true`, `provider: {zdr: true, sort: "throughput"}`,
`reasoning: {effort: "low"}`, and `max_tokens: 2048`. Truncation still fails,
rather than treating the token cap as successful completion. No tools or retries.
OpenRouter routing explicitly enforces ZDR, not merely non-training.

This is **not a matched-context comparison**: direct inference omits Basic's
system prompt, user/date expansion, skills, and filter-injected context. Provider
selection, output length, caches, and independent load can differ. Neither route
proves the answer is factually correct. Never subtract these independent requests
to report pure OWUI, database, network, or inference overhead. Update the constant
when changing Basic; there is no runtime admin/configuration lookup. Direct
transport/protocol/HTTP failures use `openrouter_transport`,
`openrouter_protocol`, and `openrouter_http_<status>`; SSE codes are shared.

## BayLeaf API

`GET` and `HEAD /api/recommended` use the same Worker, HTTP Basic boundary, kill
switch, HTTP deadline, and SSE parser. The route holds a dedicated
`BAYLEAF_API_KEY` (`sk-bayleaf-...`) for the `probe@bayleaf.dev` pseudo-user. It
does not use Adam's personal key, Campus Pass, an OpenRouter management
credential, or the direct route's OpenRouter inference key.

The fixed upstream is `https://api.bayleaf.dev/v1/chat/completions`; redirects
are not followed. The fixed model is `openrouter:z-ai/glm-5.3-flash`, matching
`api/wrangler.jsonc`'s namespaced `RECOMMENDED_MODEL`; a drift test fails when
they diverge. The request explicitly includes `provider: {zdr: true, sort:
"throughput"}`, low reasoning effort, and `max_tokens: 2048`. The API still
performs its normal keyed bearer and D1 lookup, per-user OpenRouter credential
acquisition/healing, model-prefix routing, and open-weight evidence check.

Success establishes one complete, nonempty keyed plaintext inference through
those controls. It does not test the unauthenticated recommendation endpoint,
Campus Pass, Tinfoil/Sealed, API web search, sandbox execution, factual
correctness, or a human user's key. BayLeaf API and the probe both retain no
prompt or completion content; the fixed synthetic bytes are consumed in memory.
Transport/protocol/HTTP failures use `api_transport`, `api_protocol`, and
`api_http_<status>`; SSE codes are shared.

## Metrics v2

All elapsed measurements use the Worker's monotonic `performance.now()`, not
wall-clock timestamps. Browser synthetic-marker age alone uses `Date.now()`.
Cloudflare's clock resolution can produce zero-length phases; decimal places are
not a precision guarantee. Measurements end before response serialization and
delivery, so they exclude the monitor-to-Worker network path. The direct-only
qualification fallback uses Node's monotonic clock, not Cloudflare's runtime.

`metrics` contains `unit: "ms"`, `phases`, `events`, `total`, `accounted`, and
`unaccounted`, plus `failed_phase` on a rejected phase or failed stream validation.
Only attempted phases and observed events appear. Missing is not zero. A failed
wait retains its elapsed duration; cleanup cannot erase the first failed phase.

- **Phases are additive, sequential, nonoverlapping intervals** around the work
  the Worker actually awaits. `accounted` is their sum; `unaccounted` is the
  remainder of `total`, including code/gaps outside the instrumented phases.
- **Events are offsets from that same start**, not durations. They can occur
  inside phases or during other waits. Never add event offsets to phases.
- `Server-Timing` contains `p_<phase>;dur=<ms>` and the `total`, `accounted`,
  `unaccounted` summary entries. Add only `p_` entries, not the summaries.
- `X-BayLeaf-Probe-Events` contains bounded, fixed-name `event=offset_ms` pairs;
  `X-BayLeaf-Probe-Metrics-Version: 2` identifies these semantics. Headers round
  to three decimals; JSON retains native numeric precision. Rounding can leave
  tiny discrepancies when summing headers.
- `X-BayLeaf-Probe-Stage` identifies the failed/last HTTP phase, or the last
  browser work stage. Browser JSON also contains `stage`, `work_result`, `cleanup`,
  and `close`, preserving the work outcome when cleanup/close overrides `result`.
- Names and fields are code-defined, never derived from upstream errors, URLs,
  model answers, IDs, session tokens, or request bodies. No human requests are
  accepted, retained, or logged. Unauthorized and invalid-route/method replies
  remain minimal and do not expose timing details.

Common phases are `authentication`, `configuration`, and `admission`.
Authentication starts at the Basic credential comparison; configuration covers
the kill switch and route-specific bindings/deadline checks. Routing falls in
the unaccounted remainder. Gate denials also identify their failed phase.
Work deadline starts after authenticated configuration
checks and covers admission plus work, not independent cleanup budgets.

### HTTP phases and events (OWUI, direct OpenRouter, and BayLeaf API)

| Phase | Sequential blocking interval |
|---|---|
| `response_headers` | Start fetch through receiving HTTP headers |
| `header_validation` | Check HTTP status and SSE content type/body |
| `await_first_byte` | Start stream consumption through first nonempty body read |
| `await_answer` | First read through first parsed non-whitespace answer, excluding reasoning |
| `answer_stream` | First answer through successful `stop` |
| `stop_to_done` | First `stop` through terminal `[DONE]`, including any usage chunk |
| `done_to_eof` | `[DONE]` through clean EOF, including trailing-frame checks |
| `validation` | Verify complete framing, stop/sentinel, and nonempty visible answer |
| `stream_cleanup` | Cancel/release the reader, or cancel a rejected HTTP body |

The event offsets are `request_start`, `response_headers`, `first_byte`,
`first_answer`, `stop`, `done`, and `eof`. Reads can contain multiple events with
equal timestamps. `first_byte` may be a keepalive or reasoning, not an answer.
Partial SSE frames and partial `<think>`/`<thinking>` tags do not advance the
answer marker. `stop` alone is not completion: the probe waits for DONE, EOF,
validation, and bounded cleanup. On failure, the active wait can end without its
normal terminating event. These are observation times, not provider token times.

### Browser phases and events

| Phase | Sequential blocking interval |
|---|---|
| `identity`, `stale_cleanup` | Verify normal user and recover only stale marked synthetic chats |
| `launch`, `context`, `page` | Acquire remote browser, isolated context, and page |
| `interception`, `setup`, `render_observer` | Install fixed-request guard, origin-scoped session injection, render observer |
| `navigation` | Navigate through DOMContentLoaded, including document/assets needed for that event |
| `composer` | Remaining wait for visible composer, including frontend auth/model loading |
| `typed`, `submitted` | Paste/verify exact prompt, then await send-button click |
| `first_rendered`, `rendered` | Remaining waits for first answer and completed-message Copy control |
| `creation_response` | Remaining wait for the creation reply, usually already received during rendering |
| `persisted` | Read and validate the exact marked chat's completed, error-free assistant record |
| `render_validation` | Confirm that same persisted message has completed visible answer text |
| `browser_close`, `chat_cleanup` | Independent bounded close/disconnect, then exact-chat deletion and absence verification |

Events are `navigation_request`, `document_headers`, `auth_request`,
`auth_headers`, `domcontentloaded`, `composer_ready`, `send_start`,
`send_returned`, `creation_request`, `creation_headers`, `creation_body`,
`first_rendered`, `complete_rendered`, `persistence_verified`, and
`render_verified`. Network events refer only to fixed known endpoints and may be
absent on early failure or frontend changes. Auth loading overlaps navigation and
composer preparation, not an independently additive phase.

A DOM mutation observer is installed **before navigation/send** so a fast answer
can be observed during the click await. Only two fixed event names cross CDP;
the callback is ignored before the validated synthetic submission. Times are
Worker receipt times, including remote CDP delay. Awaited render predicates are
a fallback observation if the callback has not arrived. First rendering excludes
reasoning/tool `details`, controls, and hidden text; completion additionally
requires OWUI's completed-message Copy control. No screenshots or DOM text leave
the browser. Rendering phases measure **remaining waits**, not full generation
time: rendering and creation events may precede those phases.

The browser lane uses Socket.IO. It does not expose SSE first-byte/stop/DONE/EOF
markers, pure inference time, separate DB latency, or independent DNS/TLS/network
costs. Persistence measures a client-observed authenticated read and validation,
not the time the database originally committed the answer. These limitations are
deliberate rather than filled with misleading derived numbers.

## Bounds

- `ENABLED` must equal `true`; unset or false fails closed.
- Deadline defaults to 25 seconds, leaving headroom for UptimeRobot's documented
  30-second default. If its monitor is explicitly set to 60 seconds, the Worker
  can use up to 55 seconds. Deadline includes the rate-limit binding and stream.
- Browser work uses `BROWSER_DEADLINE_MS=55000`; HTTP routes retain
  `DEADLINE_MS=25000`. An omitted browser override falls back to `DEADLINE_MS`.
  Browser cleanup adds independent time beyond its work deadline, as below.
- Maximum received stream: 1 MiB; maximum individual SSE event: 64 Ki characters.
- Cloudflare's rate-limit binding permits 6 authenticated checks/minute **per
  route per Cloudflare location**, not globally. Fixed independent keys are
  `owui`, `browser`, `openrouter`, and `api` (up to 24 total/minute/location).
  Chat's ordinary per-user limits and the API pseudo-user's provider-side spend
  cap remain enabled. No exemption from campus rate limits and no internal
  inference retry.
- UptimeRobot may issue confirmation retries. Every authorized, admitted request
  performs fresh work: neither failures nor successes are cached. Concurrent
  requests can run; these rate guards are not a global concurrency lock.
- At five-minute polling, nominal volume is 288 requests/day, plus retries and
   any additional response-time sampling. Verify actual monitor behavior.

## Browser Contract

Authenticated GET and HEAD at `/chat/basic/e2e` use their own rate-limit key
and share the kill switch. They start a fresh Cloudflare browser, inject the
dedicated ordinary session JWT into **origin-scoped localStorage**, open Basic,
paste the exact same prompt, and submit through the frontend. This skips the
campus authentication flow: it does **not** test CILogon.

Success requires both a visible nonempty response with OWUI's completed-message
Copy control and a persisted, nonempty, error-free, `done: true` assistant record
for that same message. The probe uses OWUI v0.11.3's `#chat-input`,
`#send-message-button`, and response-container selectors. A chat URL or network
idle is not success. HEAD waits for the entire lifecycle, including cleanup.

OWUI v0.11.3 creates opening chats inside `/api/chat/completions`, not
`/api/v1/chats/new`. Request interception validates the fixed model, exact
prompt, new-chat intent, and Socket.IO session before allowing that request.
It adds only `chat_variables.bayleaf_probe`, a timestamp/UUID synthetic marker
stored atomically with the chat. The prompt and ordinary background tasks are
unchanged. The creation response's `chat_id` is captured immediately.

On success or failure, the browser is closed before exact-chat deletion.
Cleanup independently checks owner, marker, model, and the single fixed user
message. It requires DELETE to return true, GET to report absence (OWUI uses
401 here), and a still-authenticated list to confirm disappearance. Deletion
also cancels the chat's backend tasks in pinned OWUI. No unmarked chat is deleted.

Lost creation replies are recovered by the marker rather than the URL or title.
A bounded scan of this dedicated account inspects at most five records; a larger
history fails closed. Before launching, stale marked chats older than ten minutes
are cleaned up, leaving other concurrent runs and unrelated records alone. A
hard Worker/browser crash can leave a synthetic record until a subsequent run
or manual recovery. There is no scheduled cleanup or persistence service.

The work deadline is `BROWSER_DEADLINE_MS`. Closing has a separate five-second CDP
budget plus one second to disconnect; chat cleanup has an independent 15-second
budget. Neither failure is swallowed or reported green. Thus the browser route
can take up to roughly **deadline + 21 seconds** before returning, unlike the
HTTP route, which has at most one extra second for stream cleanup. `waitUntil` protects cleanup after disconnect within Cloudflare's
runtime limits; it is not a crash-proof guarantee. Browser acquisition uses a
60-second idle expiry as a backstop if the connection/close cannot be confirmed.
Do not attach this route to the existing 30-second monitor without revisiting
the timeout contract.

Browser responses add content-free `X-BayLeaf-Probe-Stage`,
`X-BayLeaf-Probe-Cleanup`, and `X-BayLeaf-Probe-Close` headers. Result codes are
`ok`, `browser_<stage>`, `browser_deadline`, `browser_client_aborted`, `browser_cleanup_failed`, or
`browser_close_failed`; cleanup/close failures take precedence, while stage
retains the last attempted work stage. The older browser qualification below
used cumulative checkpoints; **v2 uses the separate phase/event semantics above**.
No screenshots, page logs, request bodies, or answers are emitted or saved.

## BayLeaf API Production Qualification (2026-09-09)

The `BAYLEAF_API_KEY` secret was installed before code deployment. Version
`1af21000-c643-46c8-95b6-97cd65ee86a9` reached the custom domain at
**02:35:02 UTC**. Targeted qualification completed at **02:37:48 UTC**: anonymous
GET and HEAD both returned 401 without detailed metrics, and authenticated GET
and HEAD returned 200 / `ok` after complete streams.

| Route | GET Worker Total | HEAD Worker Total |
|---|---:|---:|
| `/api/recommended` | 3.115 s | 2.407 s |

These are independent observations, not a benchmark or SLO. GET/HEAD client
elapsed times were 3.238/2.509 s. Additive phase accounting passed, GET returned
metrics-v2 JSON, HEAD was bodyless, and no response content was printed. A prior
all-layer run also passed API GET/HEAD at 6.623/1.973 s, but exited nonzero when
an unrelated browser HEAD failed during remote-browser launch/close. Its exact
cleanup check found zero remaining chats. This motivated the targeted
`qualify-prod.mjs --api-only` mode rather than coupling API evidence to browser
availability.

The `probe@bayleaf.dev` D1 row was independently verified active with a complete
OpenRouter credential mapping, and the spend-limit dry run confirmed its
provider-side cap is `$1/day`. Temporary roster and SQL files were removed. Adam
created the UptimeRobot monitor manually at a 15-minute interval before setup;
its first green sample and alert behavior remain a separate verification gate.

## Production Qualification (2026-09-08)

Deployed at **19:38:12 UTC** (12:38:12 PDT), version
`b30214e8-7ae7-4a33-916c-c7b006b1fbe5`, serving 100% of the existing custom domain.
Qualification completed at **19:40:04 UTC**. All six unauthorized GET/HEAD
checks returned 401 with no detailed metrics. All six authenticated checks
returned 200 / `ok`; GET JSON matched timing headers, HEAD was bodyless, and
additive phase accounting passed. No response content was printed.

| Route | GET Worker Total | HEAD Worker Total |
|---|---:|---:|
| `/chat/basic` | 13.130 s | 17.775 s |
| `/openrouter/basic` | 14.456 s | 1.601 s |
| `/chat/basic/e2e` | 19.963 s | 16.753 s |

These are single observations, not a benchmark. Totals exclude client-to-Worker
transport. Browser GET/HEAD first-render offsets were 15.291/12.868 s;
complete-render offsets were 19.337/16.219 s. Persistence verification took
75/54 ms, browser close 124/87 ms, and exact-chat cleanup 237/249 ms (phases).
Both browser checks verified completed rendering and persistence and reported
confirmed close/cleanup. The independent harness observed each exact marked
record during its run, verified its subsequent GET returned 401, and confirmed
the authenticated list was empty. Final result: **two records observed, zero
recovery deletions needed, zero remaining chats**.

Preflight: **30 tests passed**, Wrangler 4.130.0 dry-run, harness syntax checks,
and `git diff --check` passed. Only the browser deadline received an override;
the existing HTTP deadline, per-route 6/min/location limits, kill switch,
disabled observability, and restricted API credential were preserved.

The two additional Worker secrets were installed via an internal stdin pipe:
`OWUI_E2E_TOKEN` from ordinary sign-in and the existing approved inference-only
`OPENROUTER_API_KEY`. No signing secret, admin JWT, provisioning key, or new key
was used. The **deployed** session expires **2026-10-08 19:38:04 UTC**. Renew it
before then for continued browser operation; automatic renewal is not installed.
The harness signs in separately for cleanup observation, so its own displayed
expiry does not replace the deployed token's expiry.

`node qualify-prod.mjs` performs the bounded production GET/HEAD checks and
independent cleanup verification. Run only with explicit authorization and no
concurrent browser qualification; it requires the dedicated account to start
empty. It creates no server, secret file, or monitor. To explicitly install or
renew the two additional secrets, source only `~/.tokens/openrouter-api` into
the environment and run `node qualify-prod.mjs --install-secrets`. That option
uploads secrets to the existing Worker but does not deploy code or run inference.
After independently confirming that `BAYLEAF_API_KEY` is the dedicated
`probe@bayleaf.dev` token, `node qualify-prod.mjs --install-api-secret` uploads
only that one secret. It never folds an ambient BayLeaf token into the existing
secret-renewal command.
`node qualify-prod.mjs --api-only` restricts production qualification to
anonymous and authenticated GET/HEAD checks of `/api/recommended`; use it when
the API route needs independent evidence rather than coupling its result to a
transient remote-browser acquisition.
Local durable secret files are left unchanged. No commit or push was made.

## Earlier Local Qualification (2026-09-08)

`node qualify.mjs` silently signs in with the ignored bootstrap file's dedicated
non-admin email/password. It verifies role/user ID and that the session's API key
matches `worker.secrets.json`, then starts Wrangler on `127.0.0.1:8791` with the
inspector on `127.0.0.1:8792`. An exclusively created, ignored mode-0600 `.dev.vars`
holds the JWT only for the experiment and is removed in `finally`. Do not run
concurrent copies. The harness stops after a failed browser check; a successful
one is followed by HTTP GET and HEAD. It stops the server and verifies/retries
only this experiment's marked synthetic cleanup. It creates no persistent monitor.

`node qualify.mjs --openrouter` additionally runs direct GET/HEAD if an
inference-only `OPENROUTER_API_KEY` is available in the ignored Worker secrets
file or environment. Without opt-in or a key it explicitly skips direct work.
`node qualify.mjs --bayleaf-api` similarly adds local Worker GET/HEAD checks for
`/api/recommended` using the dedicated token from `worker.secrets.json` or
`BAYLEAF_API_KEY`.
Source only the documented inference credential (`~/.tokens/openrouter-api`),
never the management credential. `node qualify.mjs --direct-only` uses that
environment key to run the same direct inference/parser in Node without reading
Chat credentials or starting Wrangler. This fallback does **not** qualify the
Worker HTTP route. Neither mode provisions credentials or uploads Worker secrets.
`node qualify.mjs --api-only` provides the equivalent parser-only fallback for
BayLeaf API and requires `BAYLEAF_API_KEY`; it likewise does not qualify the
Worker route.

Earlier metrics-v2 verification (2026-09-08): two attempts to start the local Worker
exited during Wrangler startup, before browser launch. Safe diagnostics did not
establish a cause. Both final scans confirmed zero new synthetic records; each
temporary secret file was removed and server exited. Consequently the new
browser instrumentation had mock coverage but **had not yet been requalified live**.
The prior browser results below predate this instrumentation.

The Node direct-only fallback passed against OpenRouter with enforced ZDR:
total **1.794 s**, headers **0.834 s**, first byte **0.835 s**, first answer
**0.901 s**, stop **1.788 s**, DONE **1.791 s**, EOF **1.792 s** (event offsets).
Its additive header wait was 833.418 ms; first-byte wait 1.400 ms; remaining
answer wait 65.282 ms; answer streaming 886.939 ms; stop-to-DONE 3.003 ms;
DONE-to-EOF 1.253 ms; validation 0.433 ms; cleanup 1.878 ms. Header validation
was 0.117 ms and unaccounted work 0.532 ms. One observation, not a benchmark or a
Cloudflare deployment measurement. No secret file/server was created by fallback.

Final metrics-v2 source verification: **29 tests passed**, including fake-clock
stream boundaries, failed phases, browser close/cleanup deadlines, serialized
render-observer behavior, and GET/HEAD parity. Wrangler 4.130.0 dry-run, harness
syntax check, and `git diff --check` passed. Ports 8791/8792 had no remaining
listeners and `.dev.vars` was absent. No deployment, commit, secret upload,
credential provisioning, or grant change was made. The dependency advisory below
was reconfirmed by `npm audit` and remains unresolved.

The successful run used a **55-second work deadline**, a local Worker, and a
**remote Cloudflare browser**, with the same non-admin identity for both layers:

| Check | Result | End-to-End Time |
|---|---|---:|
| Browser GET | 200; rendering and persistence passed; close and deletion confirmed | 25.439 s |
| HTTP GET | 200; complete SSE answer | 12.553 s |
| HTTP HEAD | 200; complete SSE answer before headers | 13.989 s |

Browser cumulative checkpoints were: composer ready 8.348 s, submit returned
11.071 s, completed answer rendered 24.451 s, persisted-record check 24.845 s,
and cleanup/close finished 25.432 s. The final harness scan found no remaining
new synthetic records. These observations include browser acquisition, UI/CDP
round trips, frontend assets, network placement, and ordinary background work.
They do not establish a latency distribution, production-Worker latency, or a
causal estimate of database overhead.

Per-run CDP browser closure was confirmed. A separate, optional account-wide
session inventory through Node's `getPlatformProxy` stalled at remote connection
setup and was stopped after 60 seconds; it produced no inventory result and
launched no browser. Final local process/port checks found no remaining probe
Wrangler/workerd processes or listeners on 8791/8792. The temporary secret file
and one-off recovery script were removed. Final verification: 20 tests passed,
Wrangler 4.130.0 dry-run passed, harness syntax check and `git diff --check` passed.

Failures during development are not excluded from the record:

- Wrangler 4.123.0's runtime could not start with the September 7 compatibility
  date. Updating to 4.130.0 resolved this before any browser work or chat creation.
- The first remote browser rendered a completed answer but failed persistence
  tracking at 22.882 s: it watched the obsolete creation endpoint. Its marker-only
  scan initially missed the unmarked chat. A separate, narrowly bounded recovery
  matched the sole record by account, creation interval, Basic model, and one
  synthetic prompt (with OWUI's smart apostrophe), deleted it, and verified the
  account list was empty. The recovery script was removed afterward.
- A subsequent remote browser failed exact composer validation at 11.406 s,
  before submission, and closed successfully without creating a chat. Switching
  from text insertion to the editor's paste handler resolved smart-quote handling.
- HTTP GET/HEAD checks accompanying those two development runs passed at
  13.825/10.688 s and 12.037/28.964 s respectively. These are additional one-off
  observations, not a selected benchmark sample.

Dependency audit: `@cloudflare/puppeteer` 1.4.0 brings three high findings through
`@puppeteer/browsers` and `extract-zip` (GHSA-jmr9-qjv8-65gv, unvalidated symlink
path traversal). No safe same-major fix was available on this date; npm proposed
a breaking downgrade to Cloudflare Puppeteer 0.0.11. That downgrade was **not**
applied. This probe uses the remote browser binding, not local browser downloads
or ZIP extraction, but the installed dependency advisory remains unresolved.

## Credentials

The dedicated account has role `user`, no campus-affiliation groups, no personal
chat history, and no connected external accounts. A separate operational group
grants only `features.api_keys`; default and pre-existing group permissions were
verified unchanged. Its group is protected by the existing manual-group namespace.

OWUI API keys are enabled globally with an instance-wide endpoint allowlist of
`/api/chat/completions`. This does not constrain session JWTs. API keys cannot
access chat history or administration endpoints. OWUI v0.11.3 does not enforce
API-key expiration in this path; rotate or revoke explicitly. This same Worker
may hold `OWUI_E2E_TOKEN`, an ordinary session JWT for the dedicated monitoring
user. It can access that user's saved chats and has a broader scope than the
restricted API key. Never give it an admin JWT, bootstrap password, or server
JWT-signing secret. Ordinary sign-in currently defaults to a 30-day session;
automatic renewal/rotation for ongoing browser monitoring is not implemented or
scheduled. Manual renewal is available through `qualify-prod.mjs --install-secrets`.

Local `worker.secrets.json` initially contains `OWUI_API_KEY` and `PROBE_PASSWORD`;
it may additionally hold the authorized inference-only `OPENROUTER_API_KEY`.
For local qualification of `/api/recommended`, it may also hold the dedicated
`BAYLEAF_API_KEY`. The production Worker may hold that token after the API layer
is provisioned; never substitute a personal user token.
Production deployment installed the additional secrets in Cloudflare without
modifying the local secret files.
`bootstrap.secrets.json` contains the dedicated account's setup credentials and
setup metadata. The harness reads only its non-admin identity and password, not
an administrator credential. Both files were created mode 0600 and are ignored by Git. These
are operational secrets, not repository backup material. Transfer to an
appropriate secret store before relying on another checkout or operator.

## Commands

```sh
npm ci
npm test
npx wrangler deploy --dry-run
# For a fresh installation, set ENABLED false before this first deployment:
npm run deploy
npx wrangler secret bulk worker.secrets.json
# Set ENABLED true and redeploy, then qualify before connecting monitoring.
```

Rollback: set `ENABLED` false and redeploy, or pause the UptimeRobot monitor.
Revoke the dedicated account's API key when retiring the probe. Do not restore
an old whole-instance configuration blindly: preserve later operator changes.

For the API layer, revoke the `probe@bayleaf.dev` D1 row and remove the Worker's
`BAYLEAF_API_KEY` secret when retiring it. OpenRouter remains the system of
record for its daily spend cap; follow the probe-extension playbook rather than
adding a D1 limit.

## UptimeRobot Setup (By Adam)

Use an ordinary HTTP monitor, not the paid API-monitor type:

- URL: `https://probe.bayleaf.dev/chat/basic`
- Name: `BayLeaf Chat: opening response`
- HTTP Basic: username `probe`, generated probe password (not the OWUI API key).
- HEAD is supported and expected on Free.
- Five-minute interval initially; email alerts to the existing contact.
- Timeout must exceed the Worker's deadline with network headroom.
- No custom headers, paid integrations, or ntfy bridge required.

For the BayLeaf API layer, Adam manually adds a second ordinary HTTP monitor
after production qualification:

- URL: `https://probe.bayleaf.dev/api/recommended`
- Name: `BayLeaf API: recommended inference`
- HTTP Basic: username `probe`, the same monitoring password.
- Fifteen-minute interval and the existing email alert contact.
- Timeout greater than `DEADLINE_MS` with network headroom.

Manual UptimeRobot setup is an intentional **human gate**. The playbook records
the fields and required checks but does not automate account changes: probes are
added too rarely for automation to earn its maintenance and credential cost.
After creation, Adam verifies the first samples, status-page inclusion if
desired, and one controlled failure/recovery alert before monitoring is complete.

The Free account UI exposes Basic/Digest/Bearer choices and a timeout control;
successful monitor creation and timing semantics still need live verification.
Check that its response-time graph records a multi-second transaction rather
than just edge latency. Verify failure/recovery before relying on alerts, using
the probe's kill switch, not invalidating the production OpenRouter credential.

UptimeRobot Free advertises three months of response-time history. Its exact
sampling and aggregation still need qualification; do not label its averages as
p95 or infer the distribution of timeouts from successful-request timings.
Use existing model-swap records when interpreting step changes. The probe always
follows `basic` in the OWUI/browser lanes; the direct lane pins the checked-in
underlying model as described above. None of the routes archives configuration.
