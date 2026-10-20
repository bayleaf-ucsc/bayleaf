# Native OWUI production rollout

2026-10-20. **Status: native metrics ACTIVE and bounded production qualification
passed after one unchanged-source retry of an upstream-image unpack failure.**
This report covers only Chat's native aggregate metrics source. The parent owns
the collector, disclosure, other telemetry classes and commits. No email, manual
retention run, forced cleanup or git-history operation was performed here.

## Approved change and preflight

- OWUI remains **v0.12.3**, one instance, one worker, unchanged
  `apps-s-1vcpu-2gb` size. No database/schema upgrade or pool-size increase.
- Change the Chat component from direct GHCR image deployment to the repo-root
  `telemetry/otlp/Dockerfile`, with its immutable standard-image base pin and
  hash/version guards. Keep repository-push auto-deploy disabled: unrelated
  documentation pushes must not restart campus Chat.
- Enable only the qualified native metrics lane, five-minute exports, dedicated
  source-scoped write capability, source paging at 99 points maximum, empty
  resources, pre-aggregation minimization and bounded DB callbacks. Traces, logs,
  exemplars and automatic instrumentation remain disabled.
- Parent approved 90-day active retention. Collector write/read authority stays
  separate. No read capability is injected into Chat.

Before the DO update, all copied runtime/reference bytes matched published main
`1d56584c4d2b8576413ad615e625addab70e0f7e`. The native runtime is the same artifact
qualified on arm64 and amd64 in [`otlp-rollout.md`](otlp-rollout.md). Source refresh
was explicitly requested with `doctl apps update --update-sources`.

The previous active deployment was `28a67c9e-6403-40bf-a7bc-8a918e74b2e0`.
A fresh spec was captured privately before editing, with mode 0600 rollback and
desired-spec files under the approved temporary `bayleaf-native-20261020`
directory. Jobs, encrypted secrets, ingress and all unrelated settings were
preserved by structural comparison. The single scheduled retention job was not
invoked. New write credentials were loaded from ignored local secret storage and
never printed; no full spec, environment dump or user-count value was printed.

Production PostgreSQL headroom was checked **before enabling**: 25 maximum
connections, three reserved, 11 current client connections excluding the
diagnostic session, leaving 11 nonreserved slots. Initial counting was corrected
to exclude PostgreSQL background processes, which do not consume client slots.
No sessions were terminated and no database network rule was changed.

## Five-minute exporter-off baseline

The existing unmodified source was observed for 300 seconds, with 120 loopback
health/version requests. CPU and RSS came from the actual server process;
normalized SELECT counters and client connection totals came from content-free
aggregate queries. No raw query text, parameters, identities or chat data were
retained.

- CPU: **4.357%** of one core over the window.
- RSS mean/peak: **1,823,499,605 / 1,823,526,912 bytes**.
- Loopback health/version p95: **8.557 ms**, zero HTTP errors.
- Normalized SELECT counter increase: **977**, not attributable to telemetry.
- Client connections: **11 → 11**; native metrics connections: **zero**.
- Recent-log scan available: no pool timeout or cancellation error detected.

This probe p95 is not the full distribution of authenticated campus-user
requests. The on/off windows are sequential observations, not randomized matched
load. Those limitations must remain visible even if the proposed numerical gates
pass.

## Deployment and completed production checks

Submitted deployment: `d0db876c-ae36-403a-9d01-083abd8e4169`.
DO reports **ERROR**, with one error step. Its resolved Chat source commit is
`1d56584c4d2b8576413ad615e625addab70e0f7e`, as intended. Sanitized build diagnostics
identify `BuildJobExitNonZero`: unpacking the immutable upstream image failed with
`failed to get filesystem from image: unexpected EOF`, before the first COPY or
guard execution. This is an image-fetch/unpack failure, not a failed source guard.
A single unchanged-source, forced-build retry,
`b36b8678-f928-4db2-81e1-a3ebcb35fc34`, reached **ACTIVE**. The previous deployment
remained active throughout the failed attempt. No runtime source edit, guard
exception, version change or rollback was needed. The retry resolved the same
published commit `1d56584c4d2b8576413ad615e625addab70e0f7e`.

Read-only runtime audit verified the installed patched source/adapter bytes,
dependency versions, guarded active configuration, uvicorn PID 1 and version
`0.12.3`. The prior startup sentinel and source-verification message were present.
One worker, one instance, the original size and scheduled retention job were
preserved. Repository-push auto-deploy remains disabled. Final control-plane
readback verified all unrelated configuration and the scheduled job unchanged,
no pending deployment, public health HTTP 200 and public version `0.12.3`.

### Five-minute exporter-on acceptance

The same 300-second, 120-request loopback probe measured:

- CPU: **2.823%**, a **−1.534 percentage-point** change from baseline.
- RSS mean/peak: **1,634,629,359 / 1,635,262,464 bytes**, below the off baseline.
- Loopback health/version p95: **8.771 ms**, **+2.50%**; zero HTTP errors.
- Normalized SELECT counter increase: **842**, not causally attributable to
  telemetry. No claim that this total measures the three callback SELECTs.
- Client connections: **11 → 12**; exactly **one** `bayleaf-otlp` connection at
  the end of the window.
- Recent runtime-log scan: no pool timeout or cancellation error detected.
- Separate warmed, read-only callback probes: total **11.427 ms**, active
  **7.934 ms**, active-today **9.230 ms**. Returned counts were not retained.

All six numerical/error gates below passed. This is a bounded sequential
observation, not a matched-load causal experiment or full campus-user latency
distribution. The 2-GB instance still warrants memory monitoring; one lower-RSS
window is not a long-term capacity guarantee. Campus OIDC, uploads and tools were
not newly exercised by this qualification.

### Actual collector readback

An authenticated bounded private read after activation was not truncated and
verified, without printing or retaining gauge values:

- All five names present: `http.server.requests`, `http.server.duration`,
  `webui.users.total`, `webui.users.active`, `webui.users.active.today`.
- Only approved route/method/status/single-instance dimensions; gauge attributes
  empty. Empty source resources are enforced by the audited source/exporter.
- Every observed native batch within the **99-point** source bound.
- Every returned native record expires exactly **90 days after observation**.

The known authenticated **120 points/minute** retry-headroom caveat remains:
five-minute steady export fits, but a lost acknowledgement of a near-full batch
can consume the same minute's retry budget. No collector policy was changed here.
Paging/freshness and three-minute-active-gauge limitations remain as documented
in `otlp-rollout.md`. Suppressed exporter logs make collector freshness an
important operational signal; this run is not a long-term network-failure soak.

Private handoff material is under
`/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/bayleaf-native-20261020/`:
`rollback-spec.json`, `desired-spec.json`, `release-source.json`,
`headroom-before.json`, `sample-off.json`, `logs-off.json`, and
`update-response.json`. Completed follow-up evidence includes
`failed-deployment-details.json`, `retry-deployment.json`, `retry-result.json`,
`runtime-audit.json`, `sample-on.json`, `logs-on.json`, `callback-timings.json`,
`comparison.json`, `collector-readback-flags.json` and `final-flags.json`.
Specs are mode 0600.
Do not print their contents.
`ops.py` is an overcompressed, throwaway operator helper, not application code or
recommended reusable tooling. Its background `wait` invocation is read-only and
bounded, but misses terminal failure after DO clears the in-progress deployment;
it must not be treated as an authoritative status check. No production code was
written through console sessions; only aggregate diagnostics were executed.

The numerical probe gates are CPU increase no greater than five percentage
points, loopback p95 increase no greater than 10%, healthy HTTP probes, no new
pool/cancellation error, one dedicated metrics connection and callback probes
below 100 ms. A failed acceptance gate requires rollback, not a pool increase or
longer deadline. Missing measurements must be recorded as gaps, not successes.

## Rollback

The private pre-change spec restores the prior upstream image and original
one-line harness with native export disabled, preserving its scheduled job and
unrelated settings. It can be submitted with an explicit source refresh; never
restore unpatched upstream source while leaving metrics enabled. Alternatively,
the qualified custom-image source kill switch sets all four OTel enable flags
off together and retains hash/version validation. Collector admission off alone
does not stop source export. No retained telemetry is manually deleted as part
of rollback.
