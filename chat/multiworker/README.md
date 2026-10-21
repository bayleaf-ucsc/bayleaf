# Local multi-worker toolkit lab (#35)

An intentionally small proof of concept for
[BayLeaf #35](https://github.com/bayleaf-ucsc/bayleaf/issues/35).
Nothing here deploys to DigitalOcean or changes the vendored toolkit files.
Baseline mode imports them unchanged; Redis mode patches an in-memory GWS copy.

## Run

```sh
GWS_MODE=baseline docker compose -f chat/multiworker/compose.yaml up --build -d --wait
docker compose -f chat/multiworker/compose.yaml exec -T worker-a python /lab/probe.py
```

The API adapters are accessible **only inside the lab network**, as `worker-a`
and `worker-b` on port 8080. No ports are published on the host. Docker Engine 29
suppressed host port bindings on this internal network in the first experiment,
so the probe runs inside worker A rather than weakening network isolation.
The Docker network is internal: running containers cannot contact Google,
Daytona, inference providers, or production BayLeaf. Image builds still need
network access to install dependencies. No real credentials are needed.
Valkey has snapshots and append-only persistence disabled. There are no durable
data volumes. The fixtures are in-memory and contain only synthetic data.

Stop just this lab, without affecting other Docker projects:

```sh
docker compose -f chat/multiworker/compose.yaml down
```

The baseline probe asserts **expected broken behavior**, so `passed: true` means the
experiment reproduced its prediction, not that the toolkit is multi-worker safe.
It uses fresh chat IDs each run. For the cold-route test, restart worker B before
repeating the probe, since the first run intentionally warms its callback route:

```sh
docker compose -f chat/multiworker/compose.yaml restart worker-b
docker compose -f chat/multiworker/compose.yaml up -d --wait --no-recreate
```

## What this actually tests

Two containers are two independently loaded toolkit processes. In baseline mode,
the adapter imports the repository's unchanged `gws_toolkit` and `lathe` sources read-only. Each gets a
real async Valkey client at `app.state.redis`, the interface OWUI provides.
Direct worker URLs make cross-process routing deterministic rather than relying
on a load balancer to randomly expose a bug.

GWS uses its real consent-URL builder, lazy route setup, callback handler and
token lookup. The token-exchange and Google API boundaries are redirected to local fixtures.
The fixture always returns a synthetic successful token: this does not test
Google consent, code verification, or the modal/event handshake. The calendar
fixture accepts only the synthetic bearer token and returns one synthetic calendar.

Lathe uses its real `_core_interpret`, including context resolution, local locks,
HTTP requests, WebSocket transport and output/error formatting. A shared fake
Daytona service implements the small context/execute protocol. It understands
only the literal commands `x = 35` and `print(x)`, never arbitrary Python.

This is **not a full Open WebUI deployment or acceptance test**. It bypasses
OWUI tool discovery/dispatch, authorization, Socket.IO and event delivery. There
is no PostgreSQL, vector DB, object store, model, RAG, sandbox provisioning,
filesystem workload or real Python kernel. Those are subsequent experiments,
not capabilities implied by these results.

## Predictions

1. A cold process B has no GWS callback route until a GWS invocation registers
   it there. Full OWUI's SPA fallback may turn this into HTML rather than the
   adapter's straightforward 404. Shared tokens alone would not fix lazy routes.
2. Even after B registers its route, it cannot consume A's pending nonce.
3. A can finish its own flow, but B cannot see the resulting token.
4. Providing `app.state.redis` does not fix either toolkit automatically.
5. Lathe reuses a context on A, but B allocates a second context for the same
   chat and shared sandbox. The variable is missing on B without a reset warning;
   returning to A restores access to the original variable.

The useful design distinction is **remote data versus local identity**. Lathe's
interpreter already runs remotely, but the pointer identifying it lives in the
toolkit instance. A process-local `asyncio.Lock` protects only that process, not
competing initializations by other workers.

## Experimental GWS Redis path

```sh
GWS_MODE=redis docker compose -f chat/multiworker/compose.yaml up -d --wait
docker compose -f chat/multiworker/compose.yaml exec -T worker-a python /lab/probe_redis.py
docker compose -f chat/multiworker/compose.yaml exec -T worker-a python /lab/test_state.py
python3 chat/multiworker/restart_probe.py
```

`gws_redis.py` builds an in-memory module from the read-only vendored source.
Guarded replacements change the three storage write/consume sites, and an AST
pass adds awaits to the state helpers and auth-URL builder. Source drift that
breaks a replacement aborts startup. The module overrides the read/clear helpers
with async implementations. This temporary transformation is scaffolding for
comparison, **not a recommended production patching pattern**. A real upstream
implementation should make the edits directly and review the resulting source.

The experiment reuses `app.state.redis`. Pending nonces use a ten-minute TTL
and atomic `GETDEL`; tokens use provider expiry minus the existing safety margin,
with millisecond TTLs and an explicit expiry check. Hashed JSON tuple keys avoid
delimiter collisions and use a lab-specific namespace. No refresh tokens or new
database persistence are added. Valkey still has disk persistence disabled;
this changes which processes can access tokens, not just their lifetime.

Redis failures propagate to a generic HTTP 503 handler in **this adapter**;
there is no silent process-local fallback on outage. Fallback is used only when
the client is explicitly `None`, as in a single-worker unconfigured deployment.
Seven offline tests exercise that memory path and the loader. `GWS_MODE=memory`
also enables it in the adapter, but it is not multi-worker safe.

The adapter registers callback routes during lifespan startup in experimental
modes. This fixes the cold-worker case here. It is **not evidence that OWUI
loads toolkit routes at startup**: finding an appropriate OWUI integration hook
remains separate work, including behavior after valve changes or toolkit reloads.

The positive probe exercises cross-worker callbacks, actual `gws_authorize`
status and `gws_action` calendar calls, replay races, user/chat isolation,
delimiter-bearing IDs, key TTLs, accelerated real server-side expiry, clearing
and an injected failed Redis connection on B. The outage simulation swaps B's
client for an unreachable local port, not a full Valkey outage or failover.
The restart driver restarts both adapters while preserving Valkey/fixtures and
verifies that cached authorization and a pending flow survive. No Docker socket
is exposed inside the containers. No claim of survival across a Valkey restart
is made. To return to the original behavior, switch back to `GWS_MODE=baseline`.

Both probes use unique chat IDs, but the baseline's cold-route assertion requires
a fresh/restarted B. The Redis probe checks that B needs no per-worker flow init;
for a demonstrably cold-process run, restart both adapters or recreate them first.

## Direct upstream development

The sibling `../gws-toolkit` checkout supplies the directly edited `0.8.0-dev`
toolkit, tests, and optional `owui_worker.py` ASGI callback adapter. The candidate
is parked on upstream branch
[`feature/multiworker-readiness`](https://github.com/rndmcnlly/gws-toolkit/tree/feature/multiworker-readiness),
commit [`b86136d`](https://github.com/rndmcnlly/gws-toolkit/commit/b86136d).
Use that branch/commit, not upstream `main`, for the overlay below. Nothing is
released or scheduled for adoption. BayLeaf's vendored production copy is unchanged.

```sh
# Default sibling checkout; set GWS_PROJECT to use a different upstream directory.
docker compose -f chat/multiworker/compose.yaml -f chat/multiworker/compose.upstream.yaml up --build -d --wait
docker compose -f chat/multiworker/compose.yaml exec -T worker-a python /lab/probe_redis.py
docker compose -f chat/multiworker/compose.yaml exec -T worker-a python - < ../gws-toolkit/tests/test_state.py
docker compose -f chat/multiworker/compose.yaml exec -T worker-a python - < ../gws-toolkit/tests/test_worker.py
python3 chat/multiworker/restart_probe.py

# Exercise the exact same toolkit with its Redis client explicitly absent.
UPSTREAM_GWS_MODE=upstream-memory docker compose -f chat/multiworker/compose.yaml -f chat/multiworker/compose.upstream.yaml up -d --wait
docker compose -f chat/multiworker/compose.yaml exec -T worker-a python /lab/probe_single.py
```

Use the first `up` command again to restore shared state. The overlay binds
upstream source directly and does **not** call the experimental AST transformer.
Unlike the prototype's eager startup registration, the upstream callback adapter
intercepts the exact path before the SPA and resolves the current module/valves
on demand. The lab substitutes its mounted module and synthetic valves for the
adapter's real OWUI database/cache resolver. It does not yet test that resolver
end to end inside a running OWUI service.

The upstream source adds per-user/chat consent leases, guarded token writes,
conditional invalidation for stale 401s, configuration-bound namespaces, and
accurate returned-scope labels. Its own README documents the adapter requirement
and deployment/retention implications. Single-worker deployments need no new
valves; distributed operation needs the ASGI adapter on every worker in addition
to Redis. This is not yet a released or production-qualified toolkit.

## Remaining experiments, not implemented fixes

- GWS: run the upstream adapter and database-backed resolver inside real OWUI,
  then exercise real Google consent. The earlier AST prototype still has the
  incremental-consent race; the directly edited upstream candidate serializes
  flows instead and never invents grants by unioning labels from different
  access tokens. A failure after nonce consumption can require fresh consent.
- Lathe: shared context identity keyed by deployment, user, chat and sandbox
  generation, plus cross-process initialization coordination. Test simultaneous
  first calls, worker restarts, sandbox restarts and privacy isolation. Sharing
  an ID alone does not serialize concurrent Python execution.
- Full OWUI: fresh PostgreSQL, Valkey and a supported external vector DB;
  shared local storage as an explicit same-host substitute for Spaces; synthetic
  password accounts instead of CILogon. Coordinate migrations before starting
  replicas, bound **pool plus overflow** per worker, disable runtime dependency
  installation races, and test real tool dispatch, streaming and config sync.
  Separate two-replica routing from two uvicorn workers in one container.

Do not assume multiple workers eliminate deploy downtime or that Redis outages
degrade safely to single-worker operation. Those claims require separate tests.
This lab makes no production readiness or availability claim.

## First observed run (2026-10-20, operator local date)

All 12 probe assertions matched the predictions: both Valkey checks, cold-route
404, warmed cross-worker nonce rejection (400), same-worker callback success
(200), replay rejection, token visibility on A but not B, interpreter creation,
same-worker reuse, silent cross-worker context fork (`NameError`), and successful
return to A's original interpreter. These are reproduced defects, not 12
production acceptance passes. Neither vendored toolkit was modified.

## Redis experiment observed run (2026-10-20, operator local date)

The positive probe passed 29 assertions, including real toolkit calendar-action
dispatch against the fixture. All seven memory-fallback/loader unit tests passed.
The restart experiment confirmed tokens, a pending flow, callback-route presence
and replay rejection after restarting both worker processes. Lathe remains
unchanged and its interpreter identity still forks across workers.

One harness correction: this Docker Compose version does not accept `restart
--wait`. Use `restart`, then `up -d --wait --no-recreate` for health readiness.

## Direct upstream candidate observed run (2026-10-20, operator local date)

The directly mounted `0.8.0-dev` source passed 33 memory/real-Valkey state tests,
six ASGI-adapter tests, all 29 distributed probe assertions and seven single-worker
memory probe assertions. Restarting both adapters preserved authorization and
pending consent, with replay still rejected. The actual locally cached OWUI
v0.12.3 qualification image loaded the candidate and preserved its two async
tool-method signatures. The lab was restored to upstream Redis mode afterward.

The ASGI wrapper is now exercised instead of eager lab startup registration.
Its real OWUI database/cache resolver is still unqualified end to end, as is real
Google consent. No production toolkit or service was changed. The upstream
candidate was subsequently committed and pushed only to its parked feature
branch. The adapter is an explicit distributed-install requirement,
not a claim that source upload plus Redis alone solves callback routing.
