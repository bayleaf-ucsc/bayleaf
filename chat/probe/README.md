# BayLeaf Probe

A small Cloudflare Worker that makes a synthetic opening conversation measurable
by UptimeRobot Free. No UI, historical storage, or alerting machinery of its own.

**State (2026-09-07): deployed and enabled at `probe.bayleaf.dev`.** The dedicated
non-admin Chat account and restricted API key exist. Authenticated HEAD checks
wait for actual completed answers; unauthenticated requests return 401. Adam is
configuring UptimeRobot by hand; collection and alert delivery are not yet verified.

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

This checks OWUI authentication, model authorization, filters, its configured
OpenRouter connection, and HTTP streaming. It does **not** check campus login,
frontend rendering, Socket.IO, native tool continuation, or saved-chat writes.
No parent, chat, or session IDs are sent, so the built-in OWUI path does not
create a conversation record. This is not the browser Temporary Chat path.
No claim that database latency has been ruled out: that comparison is unfinished.

Chat uses its existing ZDR inference connection. The adapter consumes only its
fixed synthetic prompt and answer, retaining neither. It does not receive human
conversations. Workers observability and preview URLs are disabled. Replies
contain only a fixed status string with `Cache-Control: no-store`.

## Bounds

- `ENABLED` must equal `true`; unset or false fails closed.
- Deadline defaults to 25 seconds, leaving headroom for UptimeRobot's documented
  30-second default. If its monitor is explicitly set to 60 seconds, the Worker
  can use up to 55 seconds. Deadline includes the rate-limit binding and stream.
- Maximum received stream: 1 MiB; maximum individual SSE event: 64 Ki characters.
- Cloudflare's rate-limit binding permits 6 authenticated checks/minute **per
  Cloudflare location**, not globally. Chat's ordinary per-user limits remain
  enabled. No exemption from campus rate limits and no internal inference retry.
- UptimeRobot may issue confirmation retries. Every authorized, admitted request
  performs fresh work: neither failures nor successes are cached. Concurrent
  requests can run; these rate guards are not a global concurrency lock.
- At five-minute polling, nominal volume is 288 requests/day, plus retries and
  any additional response-time sampling. Verify actual monitor behavior.

## Credentials

The dedicated account has role `user`, no campus-affiliation groups, no personal
chat history, and no connected external accounts. A separate operational group
grants only `features.api_keys`; default and pre-existing group permissions were
verified unchanged. Its group is protected by the existing manual-group namespace.

OWUI API keys are enabled globally with an instance-wide endpoint allowlist of
`/api/chat/completions`. This does not constrain session JWTs. API keys cannot
access chat history or administration endpoints. OWUI v0.11.3 does not enforce
API-key expiration in this path; rotate or revoke explicitly. Do not put the
bootstrap JWT, password, or server JWT-signing secret into the Worker.

Local `worker.secrets.json` contains only `OWUI_API_KEY` and `PROBE_PASSWORD`;
`bootstrap.secrets.json` contains the setup account credentials and original
admin configuration. Both were created mode 0600 and are ignored by Git. These
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

## UptimeRobot Setup (By Adam)

Use an ordinary HTTP monitor, not the paid API-monitor type:

- URL: `https://probe.bayleaf.dev/chat/basic`
- Name: `BayLeaf Chat: opening response`
- HTTP Basic: username `probe`, generated probe password (not the OWUI API key).
- HEAD is supported and expected on Free.
- Five-minute interval initially; email alerts to the existing contact.
- Timeout must exceed the Worker's deadline with network headroom.
- No custom headers, paid integrations, or ntfy bridge required.

The Free account UI exposes Basic/Digest/Bearer choices and a timeout control;
successful monitor creation and timing semantics still need live verification.
Check that its response-time graph records a multi-second transaction rather
than just edge latency. Verify failure/recovery before relying on alerts, using
the probe's kill switch, not invalidating the production OpenRouter credential.

UptimeRobot Free advertises three months of response-time history. Its exact
sampling and aggregation still need qualification; do not label its averages as
p95 or infer the distribution of timeouts from successful-request timings.
Use existing model-swap records when interpreting step changes. The probe always
follows `basic`; it does not pin the underlying model or archive configuration.
