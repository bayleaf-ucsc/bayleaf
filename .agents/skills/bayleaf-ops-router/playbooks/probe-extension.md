---
source-skill: bayleaf-ops-router
description: Add or materially change a synthetic route in the unified BayLeaf monitoring Worker.
status: First production run completed; monitor sampling and alert verification remain human gates
last-reviewed: 2026-09-09
---

# Probe Extension

## When to use

Use for a new route or material contract change under `chat/probe/`, including
new credentials, upstreams, models, deadlines, cleanup behavior, or UptimeRobot
monitors. Read `chat/probe/AGENTS.md` and `README.md` first. A model-only update
also invokes `model-swap.md`; update the pinned probe constant in that workflow.

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
   allowlist of status and timing metadata, never content or raw errors.
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
   observations without presenting them as a latency distribution.
8. **[HUMAN GATE, ADAM]** Add the UptimeRobot ordinary HTTP monitor manually.
   The playbook does not automate UptimeRobot: new probes are rare, so API
   automation would add more credential and maintenance surface than it removes.
   Record URL, name, Basic username `probe`, interval, timeout, and alert contact.
9. Adam verifies initial samples, optional public status-page inclusion, and one
   controlled failure/recovery alert. A direct 200 does not pass this gate.

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

## Refinement Log

- 2026-09-09: First run used `probe@bayleaf.dev` across services with distinct
  credentials and a `$1/day` API cap. Adam created the 15-minute UptimeRobot
  monitor before deployment, so setup failures can appear in its initial history.
  The full qualification run passed API GET/HEAD but failed on an unrelated
  remote-browser HEAD; adding `--api-only` made layer evidence independent.
  Endpoint qualification passed; initial monitor sampling and controlled
  failure/recovery alert verification remain Adam gates.
