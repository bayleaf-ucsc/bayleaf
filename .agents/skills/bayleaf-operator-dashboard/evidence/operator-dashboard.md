# Run evidence: operator-dashboard

Dated record of past runs of [`SKILL.md`](../SKILL.md), newest first unless noted.
Consult for diagnosis; current procedure lives in the linked file.

- 2026-10-26 (later): Rebuilt panels around operator questions (up, Chat use,
  arrivals, retention, sandboxes, inboxes) instead of storage classes; wired in the
  previously unread `lifecycle` class, Daytona and Inboxes series. `app.js` now uses
  an escaping `html` tagged template and one shared `timeChart` frame. Collector
  `/v1/read/metric-buckets` exists in source (needs operator-approved deploy plus a
  `metric_points(name, observed_at)` index); the dashboard falls back on 404. The
  default window is 24 hours, the longest that raw sampling reads completely.
- 2026-10-26 (windows): Added 30-day, 90-day and 1-year views. Raw reads chunk at
  the collector's seven-day limit; nothing beyond the 90-day retention maximum is
  read (hatched), and the last ten minutes of retention are skipped so earliest-
  expiry clearing doesn't wipe long views instantly. The undeployed bucket route
  gained a 6-hour size and a 90-day aggregate window.

- 2026-10-26: Multi-day Chat gauges looked "truncated": collection was live, but
  oldest-first bisection spent its 48-query budget on the window's first hours
  (rows are `ORDER BY observed_at ASC`), leaving stale headlines. Replaced with a
  complete newest tail plus density-sized strata and explicit covered spans. Size
  strata from the denser end: sources join over time, so the oldest rows mislead.
  Also: a watch-mode server restart mints a new session cookie; the page now
  reloads on SSE reconnect instead of failing reads with 403.

- 2026-10-20 (#113): Include `proxies` and `inboxes` in the arrival heatmap's
  explicit service list when enabling those sources. Aggregate bars were already
  dynamic; a fixed tooltip list otherwise silently omits part of the timeline.

- 2026-10-20: Initial workflow extracted from a running live-data prototype.
  UI hot reload and arrival heatmap were browser-checked; native gauge charts
  added without expanding collection. Preserve this lightweight iteration loop.

## Moved from the body

Original wording, verbatim, as it stood in the procedure.

Opening provenance:

```text
Last reviewed: 2026-10-20. Extracted from the initial live implementation and
browser-tested iteration; not independently agent-benchmarked.
```

Read strategy (superseded by sampling):

```text
- Reads are capped at 500 rows/request. The local server recursively splits time
  windows with a query budget and deadline. Preserve explicit partial-coverage
  warnings, including dense same-millisecond gaps. Inspect
```
