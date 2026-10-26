# BayLeaf telemetry: live production, local defaults disabled

Inboxes adds fixed 15-minute receipt/lifecycle/cleanup aggregates to the existing
private metrics class under policy 4. Its dedicated writer cannot read telemetry.
The receiver/exporter flags are enabled in production; real HTTP receipt, guard
and lifecycle export is verified. Live email/cleanup counters remain pending.
See `qualification/inboxes.md`; never add addresses, resource ids, paths or payloads.
Export extends that matrix to 31 fixed series with `inbox.export.pages` (`1`) and
`inbox.export.bytes` (`By`), only transport `http|email` and outcome `emitted`.
These are best-effort completed-generation counters, not client-delivery evidence.

Read root `AGENTS.md` first. Issue [#112](https://github.com/bayleaf-ucsc/bayleaf/issues/112)
tracks this work. On 2026-10-20 the operator explicitly approved deployment and
live collection of five classes with 90-day retention, including the later Daytona
approval below. Approval is not proof
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
ranges. Client wire schema remains 1; stored browser schema 2/policy 4 is defined
in `src/browser-policy.js`. Existing rows become unknown without renewed expiry.
Policy 4 adds explicitly approved Proxies apex entry/recovery and Inboxes apex
entry arrivals. Both are deployed/enabled and actual-browser readback is verified;
tenant application/receipt origins and authenticated diagnostics are excluded.
See `qualification/diagnostics.md` for versions and completed owner/private-app
and signed-in non-owner qualification against synthetic resources. The apparent
private-navigation failure was an external provider-login redirect blocked in
both access modes, not a reason to relax gateway authorization.
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
production retention is **90 days for all five classes**, configured before
first database use; accepted configuration is integer 1–90. Policy version 2
broadens the bound, not any existing database's durable ceiling.
Per-class `retention_state` persists a decreasing
TTL ceiling and increasing retired-observation cutoff, atomically with each
admission/read/purge. Do not delete/reset these five content-free rows during
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
seven operator GET `/v1/read/*` routes, with concise field/parameter descriptions;
do not reintroduce ingestion or public-page operations. `src/openapi.js` derives
read vocabularies/limits. Update contract tests with storage/read changes.
The minimal Scalar shell pins its external jsDelivr script, disables interactive
requests, auth persistence, renderer telemetry and external fonts, and limits
connections with CSP. The CDN still sees the script request; raw OpenAPI needs
no third-party script. This authorization does not expose tools or change llms.txt.
Source activation is separate rollout work, not part of local
policy editing. Privacy/retention drafts require exact-diff publication approval
before commit/push; affected-user notice text/notification remains an operator gate.

## Live Daytona integration

`daytona/README.md` records the approved policy and live qualification gates for
webhooks and organization-only OTLP metrics. Both switches default false locally;
production enables them with 90-day retention. Real private readback verified both
sources after migration `0004`, without changing existing writer/read authority.
Service policy 3 adds source `daytona`, eight fractional capacity gauges and a
fifth class, `lifecycle`: only 15-minute transition-count buckets, no resource
identifiers. Migration `0004` must precede deployment. Five content-free retention
rows now persist. The operator-read reference adds `/v1/read/lifecycle` without
new public data access or agent exposure. The operator approved committing/pushing
the reviewed privacy/code changes, then permanent activation, and explicitly
waived affected-user notification. Qualification passed for state updates and
organization gauges, not a complete creation census. Publication and permanent
activation evidence are in `qualification/daytona.md`. Initial acceptance buckets
include disposable synthetic traffic: do not interpret that as human usage.
