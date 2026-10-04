# Personal browser sandbox: issue #81 qualification spike

2026-10-03. An amsmith-only experiment against the existing shared sandbox.
Issue: <https://github.com/bayleaf-ucsc/bayleaf/issues/81>. ✨

## Result

Unmodified OpenChamber **2.1.0** and OpenCode **2.0.22** run through the deployed
private preview gateway. No BayLeaf Worker code, schema, global resource policy,
or Chat deployment was changed.

The operator-approved D1 change renamed this experiment's keyed port-3000
registration to `amsmith-sandbox.bayleaf-proxies.dev`, re-encrypted its upstream
credential with the new hostname as AES-GCM associated data, and shortened its
expiry to **2026-10-04 04:06:51 UTC (October 3, 9:06:51 PM Pacific)**. A private
local backup preserves the original row. The original nonce URL returns 404.

This is a temporary application address, not the proposed durable entrance.
It has no Start/Resume screen, renewal button, automatic application relaunch,
or shared-runtime arbitration. Existing gateway policy blocks service-worker
script requests on this non-nonce hostname. Do not later assign arbitrary
preview content to this origin.

## Existing environment and managed footprint

The sandbox was archived, with **1 vCPU, 2 GiB RAM, 3 GiB disk**, 15-minute idle
stop and 60-minute archive interval. The ordinary sandbox exec endpoint woke it.
Node 25.9.0 and Bun 1.3.6 were present; global OpenCode was 1.1.35.

The spike installed these exact packages with npm under
`~/.local/share/bayleaf-browser-spike/tools-oc2.1.0-code2.0.22`:

```sh
npm install --prefix "$HOME/.local/share/bayleaf-browser-spike/tools-oc2.1.0-code2.0.22" \
  --no-audit --no-fund @openchamber/web@2.1.0 @opencode/cli@2.0.22
```

Installation took 28 seconds and the managed tree initially occupied about
1.1 GiB. Direct package versions are pinned; transitive dependencies were
resolved by npm and recorded in its sandbox-local lockfile. The global
installation and preexisting user configuration were preserved.

Within `~/.local/share/bayleaf-browser-spike/`:

- `launch.py`: operator-started Python launcher and six-hour supervisor.
- `tools-oc2.1.0-code2.0.22/`: pinned application executables and dependencies.
- `config/`, `data/`, `cache/`, `state/`: isolated XDG roots inherited by managed
  processes. Project-local configuration can still be discovered normally.
- `openchamber/`: explicit `OPENCHAMBER_DATA_DIR`, including application state.
- `owner-key`: ordinary owner BayLeaf key, mode 0600, under a mode-0700 root.
- `runtime.json`: managed process ID, deadline, port, and versions.
- `install.log`, `server.log`, `supervisor.log`: setup/runtime diagnostics.

The shared working directory is **`/home/daytona/workspace`**. Select that
directory as an OpenChamber project to work with files also reached by Lathe
and the sandbox API. Default general chats instead use OpenChamber's managed
chat directories. UI qualification left a synthetic response session; file
qualification left `workspace/bayleaf-spike-check.txt`.

## Provider and access configuration

The credential was uploaded separately through the authenticated sandbox file
API, never embedded in the launcher, CLI arguments, or browser URL. At startup
the launcher reads it into `BAYLEAF_API_KEY`, fetches the authenticated
`/.well-known/opencode/config` document, and writes its `config` object to the
isolated global OpenCode configuration. The returned default model is inside
that object. OpenCode V2 accepted the endpoint's compatibility-format provider
configuration. This is a startup snapshot of remote configuration, not a
demonstration of automatic well-known credential onboarding or key rotation.

Default model during qualification: `bayleaf-remote/openrouter:z-ai/glm-5.3-flash`.
Inference takes the normal BayLeaf ZDR path. Files, agent histories, and the
owner credential persist in the ordinary cloud sandbox. That credential grants
the owner's broader ordinary-key authority, not inference-only authority.

OpenChamber binds port 3000 on all sandbox interfaces using the supported
`OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true` override. Authentication is supplied
by **private Daytona preview transport plus the owner-authenticated BayLeaf
gateway**, not a second OpenChamber UI password. The unsigned Daytona preview
returned 401. No native OpenChamber tunnel is enabled; relay is disabled with
`OPENCHAMBER_RELAY_HOST=off`. The managed OpenCode server uses a rotated password
and binds to loopback on an allocated port. No Host-to-localhost adapter or
upstream source patch was needed.

At the six-hour deadline the supervisor attempts to terminate its managed
OpenChamber process group. Gateway expiry independently prevents new forwarded
requests and bounds sockets/HTTP streams under the deployed preview contract.
Actual process cleanup and subsequent idle sleep have **not** been observed.
This is not proof of a six-hour compute-cost bound or coordination with Lathe.
Ordinary idle sleep can occur sooner and loses running processes.

## Evidence

| Check | Observation |
| --- | --- |
| Human login | Adam reported completing CILogon in the OpenChamber browser; the new hostname subsequently served the application there |
| Rendered UI | Separate headless Chrome loaded the UI and BayLeaf default model without page errors |
| Browser inference | Sent a synthetic prompt through the UI and received `BROWSER_STREAM_OK` |
| Reload/reconnect | Reloaded the page; the response/session remained visible |
| Sandbox CLI inference | Same provider returned `BAYLEAF_SPIKE_OK`, exit 0, in 5.82 seconds |
| Terminal | Created a synthetic terminal, sent a shell command over the gateway WebSocket, received the expected output, deleted only that terminal |
| File operations | Wrote and read the synthetic workspace file through OpenChamber's gateway routes |
| Anonymous gateway fetch | 401 |
| Anonymous top-level navigation | 302 to login flow |
| Wrong Origin | 403 |
| Stable-origin service-worker request | 403 |
| Old nonce hostname | 404 after rename |
| Unsigned Daytona preview | 401 |
| WebSocket expiry | A synthetic six-second gateway session closed after 5.9 seconds with code 1008 |

Automated application and WebSocket tests used short-lived, operator-signed
synthetic gateway cookies. They exercise transport and expiry, not a second
independent end-to-end CILogon login. A non-owner login was not repeated here.
Browser inference proves response delivery through the UI; chunk-by-chunk SSE
timing and a multi-hour streaming soak were not measured.

## Memory and cost

Use cgroup metrics rather than `free`: the latter reported the host's roughly
377 GiB RAM rather than the sandbox's 2 GiB allocation.

At Adam's requested memory check:

| Metric | Measurement |
| --- | ---: |
| Cgroup current | 1,990,479,872 bytes, about 1.85 GiB |
| Cgroup maximum and historical peak | 2,147,483,648 bytes, 2 GiB |
| Anonymous memory | 492.9 MiB |
| File cache | 1,345.7 MiB |
| Inactive file cache | 1,247.2 MiB |
| Kernel memory | 58.3 MiB |
| OpenCode RSS | 300 MiB |
| OpenChamber RSS | 242 MiB |
| OOM events / kills | 0 / 0 |
| Memory-limit reclaim events | 677 |

Most accounted memory was reclaimable file cache, not a nearly-2-GiB anonymous
working set. RSS figures are not additive measures of unique memory. The
environment fits simple interaction so far; representative agent work with a
substantial subprocess remains a sizing gate.

[Daytona pricing](https://www.daytona.io/pricing), checked 2026-10-03: CPU
$0.0504/vCPU-hour, RAM $0.0162/GiB-hour. This shape is approximately **$0.0828
per running hour**, or **$0.4968 for six running hours**, plus any applicable
storage charges and inference. Storage is listed at $0.000108/GiB-hour after
the first 5 free GiB. These are posted rates, not an invoice measurement.

## Findings to carry into implementation

1. **Gateway reuse works.** Its owner authentication, forwarded host/protocol,
   binary WebSockets, and origin isolation cover the basic browser application.
   Keeping identity and transport out of the application is a useful architectural
   separation; a bespoke OpenChamber fork was unnecessary for this spike.
2. **Check project-context headers.** The deployed gateway's request allowlist
   omits OpenChamber's `x-opencode-directory` header. File operations can fall
   back to server-global last-directory state. A repeated synthetic write after
   the browser changed context was denied; the initial workspace write/read
   passed. Qualify two projects/tabs and the exact required header set before
   claiming full file-browser compatibility. Do not broaden all headers blindly.
3. **Error flattening obscures diagnostics.** Gateway non-2xx upstream responses
   become fixed 502s. An exploratory `/api/projects` request used a nonexistent
   endpoint and produced 502; this was not evidence that project UI failed.
4. **Use a named User-Agent for operator Python requests.** Bare urllib requests
   received 403 for both upload and remote configuration retrieval; the same
   authenticated operations succeeded with `BayLeaf-Preview-Qualification/1.0`.
   The responsible edge rule was not identified.
5. **No automatic repair machinery yet.** Only this existing, minimally configured
   sandbox was exercised. Old/conflicting installations, partial-install retry,
   owner-key rotation, backup/regrowth, archived relaunch, extension policy,
   non-owner lifecycle behavior, and shared deadline arbitration remain open.
6. **Keep stable entrance separate from app origin.** The one-off DB row is enough
   to feel the interface. It does not implement the issue's durable entrance or
   browser-state retirement policy. Prefer a gateway-owned stable entrance leading
   to a qualified application-generation origin for the actual feature.

## Operator handoff

The sandbox keeps the launcher and npm lockfile. It does not automatically
restart OpenChamber on wake. A later work period needs an explicit operator
launch and a newly qualified private registration; rerunning launch creates a
new six-hour supervisor deadline but does not renew gateway access.

Rollback of browser exposure uses the existing ordinary-key
`DELETE /sandbox/expose/3000` operation, which revokes the renamed keyed row too.
Stop only the marked managed process group after checking `runtime.json` and
its actual process identity. Preserve the shared sandbox and user work. Export
wanted managed histories/configuration before explicitly removing this spike's
directory. Never reset the entire shared sandbox as routine spike cleanup.
