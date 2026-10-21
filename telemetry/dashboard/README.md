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
third-party scripts or automatic polling. Each manual read covers 1 hour to 7 days,
with at most 48 requests per class and a 30-second overall upstream deadline.
Capped windows split recursively; unresolved windows are explicitly incomplete.
Snapshots clear at their earliest input expiry or five minutes, whichever comes
first. Browser/devtool copies and screenshots are also derived artifacts: do not
retain them past input expiry. No public sharing is implied by this prototype.

Initial panels: arrivals, native gauge snapshots and HTTP measurements, synthetic
probe outcomes/timings, deletion reports and latest accepted source observations.
HTTP totals/percentiles are deliberately not synthesized from overlapping
cumulative windows. This first iteration exposes those measurements for inspection
instead of inventing a traffic total. Missing reports are not zeros.

Checks: `node --test dashboard/dashboard.test.mjs` from `telemetry/`.
