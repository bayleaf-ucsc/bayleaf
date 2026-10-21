---
name: bayleaf-operator-dashboard
description: Launch, troubleshoot, and maintain BayLeaf's private localhost operator telemetry dashboard in telemetry/dashboard/. Use when asked to open or restart the operator dashboard, iterate on its charts, heatmaps, tooltips or layout, inspect dashboard data coverage, or add views of existing telemetry. Not for the public telemetry status page or deploying new collection. Keep the app hot-reloading, read-only and local while exploring what might eventually be shared publicly.
---

# BayLeaf operator dashboard

Last reviewed: 2026-10-20. Extracted from the initial live implementation and
browser-tested iteration; not independently agent-benchmarked.

## Orient

Work from the BayLeaf repository. Read root `AGENTS.md`, `telemetry/AGENTS.md`
and `telemetry/dashboard/README.md`. Check `git status --short` before editing:
other telemetry work may be in progress. Preserve unrelated changes.

This is a small operator workbench for exploring existing data and deciding what
dashboard material might make sense publicly. Favor quick, dependency-free UI
iterations, not a dashboard framework, new hosted service or new collection.
Public sharing is a separate operator decision, not an implication of making a
local chart.

## Launch or reuse

1. Check whether `http://127.0.0.1:4318` already serves the expected BayLeaf
   operator dashboard. Reuse it if it does. Do not kill an unidentified listener.
2. Otherwise run **from `telemetry/`**:

   ```sh
   npm run dashboard
   ```

   Use a background shell for agent-managed launches. No install or build step is
   needed with the repository's current Node environment. On a fresh machine,
   check Node supports `--watch`, built-in fetch and `AbortSignal.any`.
3. Open **http://127.0.0.1:4318** in the browser. Use `127.0.0.1`, not
   `localhost`: exact Host and Origin checks are intentional. If another service
   owns the port, launch with `PORT=4319 npm run dashboard` and use that port.
4. Confirm real panels populate, not just the HTML shell. An empty window is not
   necessarily a failure. Check coverage and unavailable-read messages.
5. Leave the tab open when showing the user the result. Report the URL and how
   to restart. Ctrl-C stops a foreground launch; stop only your own process when
   asked. Do not terminate another session's server.

Credentials: the server uses environment `READ_SECRET`, falling back to only that
field from ignored `telemetry/.dev.vars.production.json`. Do not print/cat that
file, expose the value in command arguments, fixtures, logs or browser code, or
substitute source write keys or an OWUI admin token. If missing, ask the operator
to provide/configure the read capability securely; do not provision production
secrets as part of a launch.

Loopback is not an OS-user authentication boundary: another local process/user
may access it. Do not claim otherwise. No network binding, tunnels or remote
access without a separately reviewed design.

## Iterate with hot reload

Read the current implementation before editing; these are the primary seams:

| File under `telemetry/dashboard/` | Responsibility |
|---|---|
| `index.html` | Shell, controls, introductory copy |
| `app.js` | Rendering, charts, interactions, snapshot clearing |
| `style.css` | BayLeaf palette, layout, tooltip and chart styles |
| `server.mjs` | Local HTTP boundary, private upstream reads, window splitting, reload events |
| `dashboard.test.mjs` | Synthetic read-boundary and local-server tests |
| `README.md` | Human launch guide and constraints |

HTML/JS/CSS edits send an SSE reload event to the browser; server edits restart
through Node watch mode. Reloading performs another live read. Avoid gratuitous
edits/reloads on dense windows. Start with one hour and refresh manually.

Keep the existing simple ES-module/Web-API design. If adding a new asset/module,
update the server's explicit static-file allowlist and UI watcher as needed.
Escape observation strings before interpolating HTML. No remote chart libraries,
tracking, browser persistence or content logging.

Verify the actual rendered UI after edits. For interaction changes, exercise the
affected hover, focus or tap behavior, including a narrow viewport when relevant.
Maintain keyboard access, bounded tooltip positioning and readable text contrast.
Use the project's palette rather than the agent harness's theme.

## Preserve interpretation and privacy

- Arrivals count observations, not unique people. Campus/other/unknown describes
  network location, not affiliation. Unknown must remain visible.
- Arrival timeline tooltips show a service × network heatmap with both green
  intensity and small counts. Keep a consistent shade scale across time buckets.
- User gauges are global snapshots, never sums across times or worker instances.
  Conflicting same-time values are not arbitrarily resolved. Missing data is not
  zero. Native active means activity within three minutes; active-today starts
  at midnight UTC. Neither means concurrent generation.
- Gauge timelines have separate zero-based scales; preserve gaps across missing
  or conflicting samples. Do not connect across unexplained long export gaps.
- HTTP counters/histograms are already recorded, but cumulative readings are not
  additive. Derived rates/quantiles need exact-series/reset-aware deltas,
  deduplication and compatible histogram bounds. Native HTTP duration is not full
  SSE completion latency. Do not invent token/cost/model metrics from this feed.
- Probe samples are synthetic, not user requests or a measured availability SLA.
  Keep additive phase durations separate from event offsets.
- Missing deletion reports do not establish zero deletions. Do not execute a
  cleanup job or generate inference just to make a panel interesting.
- Source status means latest accepted observation, not proof of live health.
- Reads are capped at 500 rows/request. The local server recursively splits time
  windows with a query budget and deadline. Preserve explicit partial-coverage
  warnings, including dense same-millisecond gaps. Inspect current constants
  before changing them; do not silently turn this into an exhaustive exporter.
- No persisted snapshots, exports or automatic polling. Clear views at the
  earliest included observation expiry, or five minutes, whichever is sooner.
  Screenshots/devtool copies also inherit input expiry; do not archive them.
- Preserve server-side credentials, no-store responses, exact local Host/Origin
  checks, same-origin JSON reads, session cookie, CSP and refusal of redirects
  carrying the upstream bearer.

For OWUI source questions, read `chat/AGENTS.md`, relevant `chat/DESIGN.md`
sections, and the pinned sources in `telemetry/otlp/upstream/`. For collection or
retention changes, consult the telemetry policies and operations privacy playbook.
Do not treat a dashboard request as authorization to change/deploy the collector,
enable exporters or publish data. Desired normalization rules discussed in chat
(including PSL-based referrers) are not proof of implementation: inspect source.

## Check and report

From `telemetry/`:

```sh
node --check dashboard/app.js
node --test dashboard/dashboard.test.mjs
```

Run `npm test` for read-contract/server changes and broader integration work.
Run `git diff --check` from the repo. Update the dashboard README when launch,
credentials, read bounds or retention behavior changes. Report what changed,
the local URL, checks actually run and important limitations. Do not commit,
push, deploy or publish without explicit approval.

## Refinement log

- 2026-10-20: Initial workflow extracted from a running live-data prototype.
  UI hot reload and arrival heatmap were browser-checked; native gauge charts
  added without expanding collection. Preserve this lightweight iteration loop.
