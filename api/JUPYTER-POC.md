# Managed JupyterLab: isolated qualification

2026-10-09. Deployed for owner evaluation. ✨

Production Linux installation reached ready. Authenticated `/lab` and
`/api/status` succeeded; the native token was absent from Lab HTML, missing-token
API access failed, and managed logs contained no app secret. The owner-gated
browser link requires a fresh UCSC login in the agent's browser panel, so live
interactive notebook/kernel qualification remains outstanding. Release versions
and shared rollout evidence are recorded in `NANOBOT-POC.md`.

## Integration follow-up

The parent-approved candidate is now registered in `serviceDefs.ts` and the shared
installer/controller. `jupyter-adapter.py` remains the single source: the Worker
uploads it beside `setup.py`, which loads it only when selecting Jupyter. The
Wrangler text rule includes both Python files; the existing esbuild harnesses
already handle all `.py` imports.

The reconstructible app-secret helper is purpose-separated by service. The
managed registration helper requires a secret for both Nanobot and Jupyter and
maps it to a fixed header; there is no arbitrary platform-header parameter.
Jupyter bypasses Nanobot's post-registration finalization because its WS URLs
are relative. It receives no owner/inference key. Inherited Nanobot app auth and
inference credentials are removed from its environment.

The combined workerd/D1/DO lifecycle suite passes 28 checks, including Jupyter
registration encryption, no inference credential upload, owner/origin denial on
HTTP and WS, fixed Authorization overriding spoofed headers, WS echo, renewal,
expiry and sibling-service coexistence. The four adapter tests, shared installer,
dashboard source/rendering tests and TypeScript checks pass. The five-card UI
keeps two desktop columns with the final Files card spanning the last row, and
one column on mobile. Actual five-card desktop/mobile browser qualification and
live Linux/Daytona checks remain pending.

The 18-check real Jupyter HTTP/kernel/terminal fixture evidence below comes from
the preceding isolated qualification agent. Integration reused that exact adapter
source; this integration pass reran adapter and workerd tests, not that fixture.
The proposed patch below is historical and must not be applied over integration.

## Decision

Use native Jupyter token authentication with a managed app-only 256-bit secret,
injected as `Authorization: token <secret>` by the existing private preview
gateway's encrypted registration-scoped `upstream_headers`. No inference key,
new sandbox, additional password, or gateway forwarding change is needed.

**Important boundary:** Jupyter deliberately skips its own XSRF and origin checks
for token-authenticated requests. Its `disable_check_xsrf` stays false, cookie-only
requests still require XSRF, and there is no wildcard allowed origin. BayLeaf's
existing owner, exact-origin mutation, and WebSocket-origin gates are therefore
load-bearing before every injection. A raw app cookie or app token must never
satisfy the owner gate. The local fixture checks this independently, but is a
model of the gateway, not a workerd integration test.

JupyterLab's default bootstrap embeds its server token in page configuration.
The adapter uses the supported `page_config_hook` to replace the browser-visible
`token` with `""`. The native IdentityProvider still holds the real token.
The hook also leaves `wsUrl` empty so the frontend derives its WebSocket address
from the browser origin. No post-registration origin/finalization hook is needed.

`allow_remote_access=True` permits Daytona's non-loopback upstream Host; this is
Jupyter's DNS-rebinding Host gate, not an authentication or CORS bypass. The app
still requires its token. `trust_xheaders=False`, empty origin allowlists, and
native authentication remain in force. Cookie-only cross-origin requests are
not granted an exception. A gateway change to selectively inject on only some
requests would need fresh qualification: wrapped `_xsrf` cookies are not exposed
under their original names to browser JavaScript.

## Upstream grounding

Inspected installed release source, then tested the real distribution:

- [Jupyter Server 2.21.1 identity.py](https://github.com/jupyter-server/jupyter_server/blob/v2.21.1/jupyter_server/auth/identity.py):
  `get_token`, `get_user_token`, `should_check_origin`; header auth, login-cookie
  persistence, token-authenticated origin exemption.
- [Jupyter Server 2.21.1 handlers.py](https://github.com/jupyter-server/jupyter_server/blob/v2.21.1/jupyter_server/base/handlers.py):
  `check_host`, `check_origin`, `check_xsrf_cookie`; exact token-XSRF exception.
- [JupyterLab 4.6.4 labapp.py](https://github.com/jupyterlab/jupyterlab/blob/v4.6.4/jupyterlab/labapp.py):
  line 737 sets the page token; its JupyterHub path similarly removes it at 914.
- [JupyterLab Server 2.28.1 handlers.py](https://github.com/jupyterlab/jupyterlab_server/blob/v2.28.1/jupyterlab_server/handlers.py):
  lines 147–149 apply the page-config hook immediately before rendering.

PyPI latest stable releases at qualification: `jupyterlab==4.6.4`,
`jupyter-server==2.21.1`, `ipykernel==7.4.0`. Python **3.11+** is required by this
ipykernel pin (the other two distributions permit Python 3.10).

## Files and integration

The isolated qualification initially added these Jupyter-specific files:

- `scripts/jupyter-adapter.py`: install/configure/start/health functions intended
  for the shared installer's namespace. Dedicated venv, atomic staged release,
  repaired post-rename kernelspec, recorded resolved package inventory, private
  config/data/runtime/settings/workspaces directories, shared `~/workspace` root.
- `scripts/harness-jupyter-local.py`: real HTTP/kernel/terminal qualification in
  a disposable HOME/XDG root with dedicated loopback ports. No live credentials.
- `scripts/test-jupyter-setup.py`: configuration, secret, environment isolation,
  owner-edited-file preservation, and health-shape regressions.

The integration patch is at:

```
/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/jupyter-integration.patch
```

It passed `git apply --check` against the concurrent Nanobot work at generation
time. Parent must coordinate before applying. It proposes changes to:

1. `scripts/browser-setup.py`: embed adapter, add registry row, authenticated
   `/api/status` health check. Release `jupyterlab-4.6.4-managed-v1`, port **8793**
   (free in the inspected registry), directory `jupyter`.
2. `src/serviceDefs.ts`: `jupyter`, root
   `/home/daytona/.local/share/bayleaf/jupyter`, slot `__jupyter`,
   `credential:false`, install/start/error allowlists.
3. `src/sandboxBrowser.ts`: generalize Nanobot's reconstructible HMAC app secret
   to purpose-separate by service; upload Jupyter's app secret without owner-key
   upload; pass it at registration. Jupyter does not enter Nanobot finalization.
4. `src/routes/previews.ts`: extend only the managed registration helper to map
   Jupyter's secret to `Authorization: token …`. The existing generic HTTP/WS
   forwarding code already does the required injection. Reject a Jupyter managed
   registration lacking its app secret.
5. `../sandbox/services.ts`: concise JupyterLab card. The current two-column CSS
   grid already wraps any number of cards, with one column below 800px; no
   four-card limit was found. Verify five-card rendering after integration.

The patch embeds the adapter in the existing single-file installer, so it needs
no new Worker asset builder, deployment package, plugin release, or D1 migration.
The separate adapter remains the isolated qualification fixture. If maintained
as an independent production module instead, parent should use one text source
and ensure it is available before `browser-setup.py`'s main dispatch, including
inside every harness. Do not append function definitions after its main call.

## Actual qualification

Both reuse of the qualification venv and a **fresh pip installation into the
managed staged venv** passed 18 real-server checks. The fresh run verified the
post-rename kernelspec points at the final venv Python and a resolved package
inventory was written. It launched that installation, not the harness venv.

Passed: unauthenticated direct API denial; nonlocal Host with native token;
Lab bootstrap; absence of app secret from HTML; relative WS and blank browser
token; login and XSRF cookies issued; owner-gate denial despite app credentials;
cross-origin mutation denied before injection; cookie-only mutation without
XSRF rejected; kernel creation and Python execution via proxied WebSocket;
contents API writing `~/workspace`; terminal creation and WebSocket command
output; actual health payload; deletion of test kernels and terminals.

Four focused adapter tests also passed. Servers, kernels, terminals, and temp
HOME files were cleaned up. Adam's Jupyter configuration was never accessed.

Measured summed RSS for server + one idle Python kernel + terminal was roughly
147 MiB on fresh installation and 198 MiB in the reused environment (macOS ARM64).
This does not establish a Linux concurrent-workload floor. The candidate imposes
no additional arbitrary 2-GiB gate (`memoryGiB:0`, matching Nanobot); ordinary
new sandbox provisioning still supplies the existing medium resource profile.
Use Linux owner evaluation before asserting any minimum or concurrency guarantee.
Installation requires 1 GiB free disk; user kernels can consume much more memory.

Reproduce with an isolated Python 3.11+ venv:

```sh
uv pip install --python <venv>/bin/python jupyterlab==4.6.4 jupyter-server==2.21.1 ipykernel==7.4.0 aiohttp==3.13.0 psutil==7.2.2
python3 api/scripts/test-jupyter-setup.py
JUPYTER_QUALIFY_INSTALL=1 <venv>/bin/python api/scripts/harness-jupyter-local.py
```

Top-level app pins follow the existing pip-managed Nanobot convention. Each
installation records all resolved distribution versions in `packages.json`;
transitive dependencies are inventoried, not hash-locked across platforms.

## Parent integration / live gates

- Integration and workerd assertions are now complete as described above. Run
  the remaining real-browser and live checks before claiming deployment readiness.
- Qualify native Linux process-group lifecycle and live Daytona Host forwarding.
  The isolated test uses a small local reverse proxy, not Cloudflare or Daytona.
- Test actual browser Lab rendering, file save, kernel restart, terminal, five
  dashboard cards, link renewal, revocation, and wrong-owner/anonymous access.
  The local HTTP/WS tests do not claim browser-engine/UI qualification.
- Deployment, production restarts, commits and pushes remain unperformed and
  require the parent's explicit user authorization.

Suggested maintain-sandbox refinement entry (shared playbook left to parent):
“2026-10-09 (Jupyter, isolated): JupyterLab exposes its native token in bootstrap
page config unless masked with its page-config hook. Injected token auth works
for kernels and terminals but natively bypasses cookie-XSRF/origin checks, making
the private gateway's independent owner/exact-origin gate essential. No public
origin finalization was needed; relocated venvs require kernelspec repair.”
