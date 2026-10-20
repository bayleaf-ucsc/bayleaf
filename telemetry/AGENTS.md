# BayLeaf telemetry: live production, local defaults disabled

Read root `AGENTS.md` first. Issue [#112](https://github.com/bayleaf-ucsc/bayleaf/issues/112)
tracks this work. On 2026-10-20 the operator explicitly approved deployment and
live collection of all four classes with 90-day retention. Approval is not proof
of deployment or activation; the local collector remains disabled by default.
Production is live at `telemetry.bayleaf.dev` using `wrangler.production.jsonc`,
with 90-day retention and both receiver switches enabled. Arrivals from all four
public service roots, native metrics and probe summaries are verified. Deletion
hooks are deployed; ordinary scheduled outcomes still need verification. The root
serves public configuration status; observation reads remain private. Consult
`qualification/rollout.md` rather than treating local defaults as production state.
**Do not deploy, create D1, enable exporters/browser code, change production,
commit or push without explicit approval.** No real credentials in fixtures.

`src/policies.js` is the versioned collection policy. `src/validate.js` rejects
unknown fields recursively and reconstructs approved records; SQL only describes
physical storage. New dimensions, jobs, counter names, metric names, result/phase
vocabularies, timestamp resolutions and retention extensions require review.
Keep schema and policy versions explicit. No arbitrary extension dictionaries,
universal log envelope, raw payload archive, provider-response archive or raw
errors. Do not log payloads, headers, exceptions or SQL diagnostics.

Never collect prompts, completions, identities, stable pseudonyms, IP/UA, private
URLs, query strings, filenames, commands, raw SQL, tokens or model strings.
Browser observations are individually stored but have no client timestamp.
Their collector-derived network category stores no IP/hash/prefix. Only the
trusted connecting address is transiently classified using the shared API campus
ranges. Client wire schema remains 1; stored browser schema 2/policy 3 is defined
in `src/browser-policy.js`. Existing rows become unknown without renewed expiry.
Browser observations have no
identifier or per-client dedup. Service run UUIDs identify job/probe runs and
retries only, never accounts. Metrics are aggregate source windows, not a new
individual HTTP request stream. Keep exact reset metadata, do not infer a reset
or turn missing data into zero. Do not sum duplicate global OWUI gauges.

All runtime code is small ES modules using Web APIs. Tests use `node:test`, real
SQLite, and workerd/D1 through Miniflare. Runtime has no package dependencies.
`npm test` uses local dev dependencies or already installed `../api` tooling;
it makes no provider calls. Production protocol qualification is a separate gate.
The default Wrangler config has no real database ID, route or account binding;
Workers observability and both collection switches are off.

Retention defaults to **7 days as a conservative local placeholder**. Approved
production retention is **90 days for all four classes**, configured before
first database use; accepted configuration is integer 1–90. Policy version 2
broadens the bound, not any existing database's durable ceiling.
Per-class `retention_state` persists a decreasing
TTL ceiling and increasing retired-observation cutoff, atomically with each
admission/read/purge. Do not delete/reset these four content-free rows during
purge. Configuration cannot raise a recorded ceiling or restore retired events;
an increase requires an explicitly reviewed policy migration. Metric batch
admission checks every point time as well as envelope/receipt time. Private
bounded reads exclude expiry before purge. Purge is bounded,
not a guarantee about Cloudflare backups, time travel, downloaded exports, or
derived artifacts. D1 paid-plan Time Travel can retain deleted rows up to 30
additional days after physical deletion, itself potentially delayed by purge
backlog/outages. No automatic export/archive. Reports, exports and derived
artifacts expire no later than their earliest included observation's expiry;
copying/aggregation never resets retention. Restore must reapply durable policy
and purge expired rows before reads/collection resume. Do not imply local TTL
establishes full provider erasure. No per-request Sealed inference metadata:
only existing synthetic Sealed probe summaries are in scope.

Ownership during parallel development: core agent owns `src/`, `test/`, migrations,
package/config, this guide and README; separate agents own `otlp/`, `adapters/`
and their `qualification/` material. Coordinate contract changes explicitly.

The operator approved a minimal public integration-status dashboard on 2026-10-20:
root GET/HEAD may show recorded source enablement/verification and current receiver
switches, including while ingestion is disabled. It must expose no telemetry
records, identities, secrets or activity counts and perform no database reads.
No public SQL endpoint or agent capability exposure is authorized.
The operator also authorized public GET/HEAD `/docs` (Scalar reference) and
`/docs/openapi.json` on 2026-10-20. These document existing contracts, grant no
data access, read no credentials/database and remain available with ingestion
disabled. Keep the root status dashboard. The public reference covers only the
five operator GET `/v1/read/*` routes, with concise field/parameter descriptions;
do not reintroduce ingestion or public-page operations. `src/openapi.js` derives
read vocabularies/limits. Update contract tests with storage/read changes.
The minimal Scalar shell pins its external jsDelivr script, disables interactive
requests, auth persistence, renderer telemetry and external fonts, and limits
connections with CSP. The CDN still sees the script request; raw OpenAPI needs
no third-party script. This authorization does not expose tools or change llms.txt.
Source activation is separate rollout work, not part of local
policy editing. Privacy/retention drafts require exact-diff publication approval
before commit/push; affected-user notice text/notification remains an operator gate.
