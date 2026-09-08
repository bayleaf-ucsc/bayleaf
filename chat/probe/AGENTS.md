# BayLeaf Probe

Operational adapter for UptimeRobot Free, not a public inference service or a
metrics store. Read `README.md` for its measurement contract and deployment state.

- Keep the Worker separate from BayLeaf API. It holds only a dedicated non-admin
  Chat API key, never an administrator credential or an OpenRouter key.
- Fixed upstream, model, and prompt. No caller-supplied inference parameters.
- HEAD must do the same work as GET and withhold headers until completion.
- Never turn partial output, rate limiting, or a cached result into success.
- No response contents, credentials, or raw errors in logs or metric responses.
- No D1, KV, scheduled jobs, custom UI, or notification pipeline without a new
  requirement. UptimeRobot owns collection, history, and alert delivery.
- `npm test` and `npx wrangler deploy --dry-run` before deploying.
- `*.secrets.json` and `.dev.vars*` are ignored. Never print or commit them.
- Do not change existing Chat grants merely to make the probe green.
