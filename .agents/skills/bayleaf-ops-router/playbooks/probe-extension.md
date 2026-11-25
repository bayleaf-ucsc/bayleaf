---
source-skill: bayleaf-ops-router
description: Diagnose monitoring failures, renew browser-probe credentials, or extend the unified BayLeaf monitoring Worker.
status: practiced; monitor sampling and alert verification remain human gates
last-reviewed: 2026-10-09
---

# Probe Monitoring and Extension

## When to use

Use for monitoring incidents, browser-session renewal, or a new route or material
contract change under `chat/probe/`, including new credentials, upstreams, models,
deadlines, cleanup behavior, or UptimeRobot monitors. Read `chat/probe/AGENTS.md`
and `README.md` first. For credential renewal, use the focused procedure below,
not the route-extension/deployment checklist. A model-only update also invokes
`model-swap.md`; update the pinned probe constant in that workflow.

## Browser Monitor Diagnosis and Credential Renewal

Current credential expiry and deployment evidence belong
in `chat/probe/AGENTS.md` and `README.md` (Credentials), not a second expiry ledger
here. Automatic renewal is not installed.

1. Inspect authenticated GET diagnostics for `/chat/basic/e2e`, using the local
   ignored `chat/probe/worker.secrets.json` monitoring password in memory. Compare
   `/chat/basic`, which uses the same user but a separate restricted API key.
   A 503 / `browser_identity` at `identity`, before browser launch, plus HTTP
   200 / `ok` is a credential/identity lead, not a browser-rendering failure.
   Check documented expiry; do not assume every identity failure is expiry or
   claim a campus login outage. This browser route never exercises CILogon.
   For a failure after browser launch, reproduce the full probe through the same
   Puppeteer SDK over authenticated Cloudflare CDP and isolate the failing
   operation before assuming renamed selectors: simplified scripts can miss races.
   `getPlatformProxy` remote setup can stall; do not rely on it here.
2. **[HUMAN GATE]** Obtain approval to mint and install a replacement, including
   its lifetime. A 365-day JWT was explicitly approved for the dedicated non-admin
   probe user; it is not a general session policy. Its longer validity extends
   the compromise window, and it can access that user's saved chats. Do not
   change the global session lifetime or grants to make monitoring green.
3. Read the dedicated identity/password from ignored `bootstrap.secrets.json`,
   never print them. Ordinary `/api/v1/auths/signin` must return the expected
   account ID and role `user`; `/api/v1/auths/api_key` under that fresh session
   must match local `OWUI_API_KEY`. Stop on mismatch or failed sign-in. Existing
   JWTs and the encrypted app-spec signing-key value cannot sign a new JWT.
4. Open the running Chat container with:

   ```sh
   doctl apps console f1a1e758-62e9-4e99-90cb-212cab12958d open-webui --context bayleaf
   ```

   This is an interactive shell, not one-shot `exec`. An agent can drive it with
   `pexpect` through `uv run --with pexpect`, with **no console logfile or raw
   buffer/error output**. A human can use the equivalent DO dashboard console.
   Disable remote shell history and echo before minting:
   `unset HISTFILE; set +o history; stty -echo`.
5. Inside Chat, use the installed Python/PyJWT and `os.environ['WEBUI_SECRET_KEY']`
   to sign HS256 claims containing only the verified `id`, current integer `iat`,
   a fresh UUID `jti`, and integer `exp = iat + 365 * 86400` for the approved
   one-year renewal. This matches OWUI v0.11.4's token format; recheck upstream
   `open_webui/utils/auth.py` if the version changes. Capture the resulting token
   into private local process memory, then exit the console. **Never export the
   signing key**, install it in the Worker, or put JWTs in session output, shell
   arguments/history, repository files, or raw diagnostics. Do not import OWUI's
   full application or run migrations merely to sign a token.
6. Verify the minted JWT through `GET /api/v1/auths/`: expected ID, email, and
   role `user`. Decode its claims locally only to check/record expiry. Do not
   install an unverified token or substitute an admin credential.
7. Follow `cloudflare-cf-tool` for account/auth selection. Confirm BayLeaf's
   identity and the probe's pinned account; do a real authenticated read to
   refresh `cf` OAuth before passing its bearer privately to Wrangler if needed.
   From `chat/probe/`, pipe exactly `{"OWUI_E2E_TOKEN": "<minted token>"}` via
   stdin to `wrangler secret bulk`. Do not type a real token in that example or
   rewrite other secrets. This secret-only renewal requires no Chat restart,
   source deployment, or global session-setting change.
8. Independently verify the probe account's authenticated chat list is empty
   before qualification; stop on unexpected records rather than deleting them.
   Run focused production browser GET and HEAD. Both must return 200 / `ok`,
   with rendering/persistence passed, close and exact-chat cleanup confirmed.
   Independently confirm the account is empty afterward. On failure, preserve
   the stage and investigate only marked synthetic records under README's cleanup
   contract. Report times as observations, not a latency baseline.
9. Record the expiry, method, and qualification in the canonical probe docs.
   Confirm UptimeRobot's next successful sample separately: direct success does
   not prove monitor recovery or alert delivery. Do not assume logout/password
   changes revoke this JWT without checking the deployed revocation mechanism.

**Installer gotcha:** `qualify-prod.mjs --install-secrets` uses ordinary sign-in,
so it would replace the one-year browser token with a default-duration session
and also rewrite the direct OpenRouter credential. For a browser-only long-lived
renewal, use the focused container-side signing and single-secret upload above.

## Design Gates

1. State what a green transaction establishes and what remains untested. Prefer
   a layer that isolates a meaningful boundary over a broad check with ambiguous
   failures.
2. Keep the route in the existing Worker. Use fixed upstream, model, prompt, and
   parameters; accept only GET/HEAD and no query string. HEAD performs the same
   fresh work and withholds headers through completion and cleanup.
3. Reuse the shared SSE validator and metrics-v2 contract for OpenAI-compatible
   streaming. Success requires visible answer text, `finish_reason: stop`,
   `[DONE]`, EOF, and bounded cleanup.
4. Assign an independent fixed limiter key and validate a bounded deadline.
   Never cache success or retry inference internally.
5. Use the least-authority dedicated credential. Never use Adam's personal key,
   an admin JWT, a signing secret, or a provider management key in the Worker.
6. Confirm the data posture. Synthetic prompt/answer bytes stay in memory and
   out of logs, stores, and responses; observability remains disabled.

## Keyed BayLeaf API Identity

`/api/recommended` uses the `probe@bayleaf.dev` pseudo-user, with a dedicated
`sk-bayleaf-` credential and distinct OpenRouter spend cap. This makes attribution
consistent with the Chat probes without sharing credentials or authority. It
must not use Campus Pass or a human user's key.

Provision the identity through the existing `api/scripts/spend-limits.mjs`
roster path. It creates the provider key at the chosen cap and emits a mode-0600
D1 SQL file. Apply that file from `api/`, then delete it. Pipe the row's token
directly from a remote D1 JSON query into `wrangler secret put
BAYLEAF_API_KEY`; do not print it or place it in shell history. Keep the
one-address roster file mode 0600 and remove it afterward.

Before provisioning, query D1 and OpenRouter for `probe@bayleaf.dev` to avoid a
duplicate or half-state. Run the spend-limit tool once as a dry run, then with
`--apply`. If OpenRouter creation succeeds but the D1 insert fails, stop and
reconcile that half-state rather than rerunning blindly. First inference should
not be the mechanism that silently decides the monitor's budget.

Provider-side spend limits are not durable across genuine credential self-heal.
After a heal, rerun the spend-limit tool for this identity. A 429 can therefore
mean either a correctly exhausted synthetic budget or cap drift, not necessarily
a general API outage.

## Implementation and Verification

1. Add the route mapping, route-specific secret check, limiter key, fixed request,
   content-free diagnostic prefix, and any pinned model constant.
2. Add tests for exact URL/body/auth, redirects, missing secret, independent
   admission, GET/HEAD completed-work parity, content-free errors, shared stream
   timing, and model drift against canonical checked-in configuration.
3. Extend `qualify.mjs` and `qualify-prod.mjs`; qualification output remains an
   allowlist of status and timing metadata, never content or raw errors. Give each
   route a focused `--<route>-only` mode so an unrelated browser or sign-in failure
   cannot couple to its evidence.
4. Update `chat/probe/AGENTS.md`, `README.md`, `chat/DESIGN.md`, and root
   `AGENTS.md`. Distinguish source, deployed, qualified, monitored, and
   alert-verified states explicitly.
5. Run `npm test`, `node --check qualify.mjs`, `node --check qualify-prod.mjs`,
   `npx wrangler deploy --dry-run`, and `git diff --check`.
6. **[HUMAN GATE]** Obtain approval before provisioning production credentials,
   uploading Worker secrets, or deploying.
7. Deploy with the new route disabled or unconfigured until its scoped secret is
   installed. Qualify unauthenticated GET/HEAD denial and authenticated GET/HEAD
   completion after Cloudflare propagation. Record Worker version and concrete
   observations without presenting them as a latency distribution. Record failures
   and deadline stalls alongside passes; a later pass does not establish alert
   reliability or justify relaxing a deadline.
8. **[HUMAN GATE, ADAM]** Add the UptimeRobot ordinary HTTP monitor manually, after
   step 7 passes so setup failures stay out of its history.
   The playbook does not automate UptimeRobot: new probes are rare, so API
   automation would add more credential and maintenance surface than it removes.
   Record URL, name, Basic username `probe`, interval, timeout, and alert contact.
   When Adam explicitly requests dashboard integration and provides a logged-in
   browser, the agent may use that UI. Prefer cloning an existing probe monitor
   to retain non-secret settings, but explicitly configure and verify Basic
   credentials: cloning may show Basic initially yet save Auth type None.
   Never treat cloning as proof of password transfer. Check inherited
   interval/timeout and public status auto-add separately; never assume cloning
   preserves a historical documented cadence. Alert verification remains Adam's.
9. Adam verifies initial samples, optional public status-page inclusion, and one
   controlled failure/recovery alert. A direct 200 does not pass this gate, nor
   does a first timing sample or an Operational label while the card says Preparing.

For `/api/recommended`, the manual monitor fields are:

| Field | Value |
|---|---|
| Type | Ordinary HTTP(S) monitor |
| URL | `https://probe.bayleaf.dev/api/recommended` |
| Name | `BayLeaf API: recommended inference` |
| Authentication | HTTP Basic, username `probe`, existing probe password |
| Interval | 15 minutes initially |
| Timeout | Greater than the 25-second Worker deadline, with network headroom |
| Alerts | Existing email alert contact |

Do not mark monitoring complete until Adam checks the first timing samples and
the controlled failure/recovery notification.

## Rollback and Retirement

Pause the UptimeRobot monitor first to stop synthetic traffic. Disable the whole
Worker only if existing routes must also stop; otherwise remove or unconfigure
the affected route and redeploy. For `/api/recommended`, mark the
`probe@bayleaf.dev` D1 row revoked, remove `BAYLEAF_API_KEY` from the probe
Worker, and verify the old token returns 401. Reconcile the retained provider
key deliberately according to the API key-lifecycle policy; do not delete D1
rows or provider credentials ad hoc.

## Recording

Commit the route, tests, qualification harnesses, synchronized docs, and this
playbook as one coherent `add:` or `update:` commit after production behavior is
accepted. Never commit secret, roster, SQL, `.dev.vars`, or `*.secrets.json`
files. Do not commit or push without explicit approval.
