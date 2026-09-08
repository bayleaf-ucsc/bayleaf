# BayLeaf Probe

Operational adapter for UptimeRobot Free, not a public inference service or a
metrics store. Read `README.md` for its measurement contract and deployment state.

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
