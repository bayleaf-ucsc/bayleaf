# Local operator workbench

From `telemetry/`, run:

```sh
npm run dashboard
```

Open **http://127.0.0.1:4318** (use that address, not `localhost`).
UI edits reload the browser; Node's watch mode restarts server edits.
`PORT` overrides the port. Ctrl-C stops the app.

The server uses `READ_SECRET` from its environment, or reads only that field from
the existing ignored `telemetry/.dev.vars.production.json`. It never sends the
credential to the browser. This is an operator-capability boundary, not a local
OS-user boundary: other processes/users on the same machine may access loopback.
Do not tunnel, share, proxy or bind this app to the network. No deployment needed.

No runtime dependencies, build step, browser persistence, disk cache, exports,
third-party scripts or automatic polling. Each manual read covers 1 hour to 1 year (1 h, 6 h, 24 h, 7, 30 and 90 days, 1 year),
with at most 96 requests per class (six concurrent) and a 30-second overall upstream
deadline. Upstream reads return the oldest 500 rows with no cursor, so a window that
overflows one read is sampled rather than exhausted: the newest ten minutes in full
(keeping latest values current), then evenly spaced strata sized from observed
density. Exactly the spans read are reported; sampled panels show their coverage
percentage and shade read spans on charts. Dense metrics (about 1,500 rows/hour)
read completely up to 24 hours and partially over 7 days. Upstream raw reads span at most
seven days, so longer windows read newest-first seven-day chunks, sampling only
chunks that overflow. Nothing older than the 90-day retention maximum (policies.js
bounds retention to 1–90 days) is read: charts hatch that region, so a 1-year view
always shows at least 275 days that hold nothing by design. The oldest ten minutes
of retention are also skipped, so no included row expires before the five-minute
view lifetime. A metric-name read filter
upstream would remove the sampling, but changes the collector contract.
Snapshots clear at their earliest input expiry or five minutes, whichever comes
first. Browser/devtool copies and screenshots are also derived artifacts: do not
retain them past input expiry. No public sharing is implied by this prototype.

Panels follow operator questions rather than storage classes: *Is everything up?*
(probe runs as duration strips with failures marked, plus source freshness against
expected cadence), *Is Chat being used?* (global user gauges, reset-aware HTTP
request rates, route and status mix), *Who arrives?*, *Are retention promises kept?*
(per-UTC-day deletion strips; missing reports are never zeros), *What are the
sandboxes doing?* (Daytona capacity by region/class and lifecycle transitions) and
*Are inboxes receiving?* (additive 15-minute deltas). A collapsed raw inventory
remains for inspection. Charts mark UTC midnights, when "active today" resets.
Cumulative counters are differenced only between adjacent exports of one exact,
unreset series; HTTP figures are observed rates, never totals across unread time.

Windows over 24 hours read metrics from the collector's `/v1/read/metric-buckets`
when deployed (about 200 buckets per metric, coarser on overflow; each bucket row
carries its earliest expiry). Until then the server falls back to sampling.
All templates escape interpolations by construction (`html` tagged template).

Checks: `node --test dashboard/dashboard.test.mjs` from `telemetry/`.
