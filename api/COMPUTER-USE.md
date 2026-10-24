# Computer-use v1: design and qualification

Operator: Adam Smith. Deployed with explicit approval on 2026-10-24.
Live checks cover specification and unauthenticated denial only, not functional
computer-use API qualification. Desktop browser observations are in `DESKTOP.md`.
The exact contracts belong to generated OpenAPI (`routes/computer.ts` and
`schemas.ts`), not this report.

## Files changed

New files:

- `api/src/computerUse.ts`: fixed generation probe, transport, signed handles,
  no-op floor-control seam and content-free errors.
- `api/src/routes/computer.ts`: owner-only OpenAPI routes and streaming responses.
- `api/scripts/test-computer.mjs`: credential-free synthetic full-app harness.
- `api/COMPUTER-USE.md`: this design/qualification/exposure report.

Updated files:

- `api/src/schemas.ts`: strict requests and generated response contracts.
- `api/src/index.ts`: route mounting only.
- `api/src/types.ts` and `api/src/sandboxCredentials.ts`: request-local caller and
  trusted provider proxy metadata; no database or credential-policy change.
- `api/src/routes/llms.ts` and `api/src/apiReference.ts`: workflow orientation.
- `api/scripts/test-docs.mjs`: generated-contract assertions.
- `api/package.json`: `test:computer` command.
- `api/AGENTS.md`: maintenance pointers and content-handling invariant.
- `.agents/skills/bayleaf-ops-router/playbooks/bayleaf-powered-agent-capabilities.md`
  and `new-service-facet.md` in that same directory: refinement log entries.

## Scope and design

- Owner API under `/sandbox/computer/*`, tag Sandbox. Ordinary personal keys and
  sandbox credentials only. Existing `resolveAuth` validates identity, then
  `callerAuthority` rechecks the actual credential when reading the cached D1
  machine ID. No Campus Pass, temporary inference tokens or browser-cookie fallback.
- No create/start/wake, `resolveSandboxId`, `ensureSandbox`, label discovery,
  readiness echo, D1 cache repair or action retry. A missing cached ID returns
  409 `sandbox_not_running`; missing Toolbox at session open returns 410
  `sandbox_not_running`, other unavailable Toolbox responses return 409.
  Missing, ambiguous or malformed Xvfb generation returns 409
  `desktop_not_running`. Messages ask the client to start the sandbox or Desktop
  deliberately. No separate Desktop start route: managed Desktop owns activation.
- All 16 methods use POST with JSON. This keeps signed observation handles out of
  paths/query strings and avoids HTTP caches for screenshots. Session open takes
  `{}`; subsequent methods take a handle plus their single-operation fields.
- GUI transport is Daytona Toolbox `/computeruse/*`, including for agents inside
  the sandbox. The only exception is the approved, constant read-only generation
  probe using `/process/execute`: Python reads `/proc/sys/kernel/random/boot_id`,
  exact `Xvfb` comm plus display argument `:0`, and field 22 after the last `)` of
  `/proc/<pid>/stat`. Exactly one triple is required; no caller-controlled code,
  paths or arguments enter the command. A 3-second Python alarm independently
  bounds the probe (the low-level execution request also carries `timeout: 5000`,
  following the existing helper convention). Outbound fetches have an 8-second
  timeout and reject redirects.
- Handles contain the SHA-256 hash of that triple, a random nonce, owner hash,
  cached sandbox ID, purpose and 24-hour expiry. HS256 uses purpose-separated
  `OIDC_CLIENT_SECRET`, matching the existing secret-reuse pattern. No session
  database/migration or screenshot/keypress content is stored. Handles convey no
  authority without a currently valid owner credential.
- The generation probe runs at open and in parallel with every screenshot.
  Boot ID or process-starttime changes reject a reused PID: the earlier
  PID-reuse-after-restart limitation is closed. Input methods validate the signed
  handle but do not add a generation-probe round trip to each action.
- Screenshots stream unchanged as provider image bytes or base64 JSON. Supporting
  both avoids decoding, buffering or re-encoding images and preserves streaming
  with backpressure. JSON clients accept `screenshot` or `Screenshot`. Other
  provider JSON metadata is advisory. Response headers are allowlisted, with
  `no-store` and `nosniff`; no upstream cookies or private headers are forwarded.
- Display/window metadata is normalized case-insensitively and schema-checked.
  Action responses are a fixed success acknowledgement, not evidence that the
  intended application operation happened. `keyboard/press` maps to Toolbox
  `keyboard/key`. No batched lists, accessibility or recordings.
- Coordinates are native display pixels even for scaled/region screenshots.
  Window IDs/zero geometry are advisory, based on the spike. Release held keys
  and buttons with matching up calls, preferably in `finally`. No automatic
  release is attempted after a failed session because that might affect a new
  desktop generation.

### Accepted boundaries and remaining questions

1. No atomic snapshot: the generation check and screenshot run in parallel, so a
   restart between checking identity and capturing pixels can escape that call's
   check. A later screenshot detects the changed generation. An action before
   that next screenshot may act on a replacement display. This is not floor control.
2. On any Toolbox failure during a session the API returns 410 `session_ended`.
   Clients must discard the handle. A stateless signature cannot permanently
   tombstone that nonce after a transient failure: replay can work if the same
   generation recovers. Enforcing permanent revocation needs stored state in the
   owner DO, beyond the no-DB-handle v1 design. This is not represented as solved.
3. `checkComputerFloor` is intentionally a no-op. Future work must serialize input
   with the owner's SandboxBrowser DO and return 423 `human_has_floor`. A bare
   check outside that serialization is not a race-free lock. No hook is required
   in the parallel Desktop work for v1; the DO integration is future work.
4. Personal-key calls go straight from cached D1 ID to configured Toolbox proxy.
   Sandbox-credential auth already performs a passive control-plane ownership
   check. That existing security requirement is retained, not bypassed for latency;
   its `toolboxProxyUrl`, when present, is passed as request-only trusted metadata
   to avoid an additional lookup. No proxy URL is currently cached in D1, so
   personal-key calls use `DAYTONA_PROXY_URL` (or its existing default).
5. Toolbox reads refresh Daytona activity. The fixed probe is read-only with
   respect to guest files/processes, not an activity-neutral status operation.
   Direct X11 and localhost Toolbox remain available to power users and bypass
   this API and future floor control. No claim of guest-level isolation is made.
6. Screenshot/typed-content transit has no API retention or standing operator
   inspection interface, consistent with the API's ZDR/ZOA posture, not attested
   ZOA. Applications, guest files and agent histories can persist that content.
   Copying screenshots into Chat would also enter Chat's stored history.
7. Functional live qualification remains pending for busy-screen payloads, streaming/body failures, actual
   Daytona down/up/region/compressed paths, supported formats and Desktop
   restart behavior. The synthetic API suite does not qualify these live paths. Image-stream
   errors after response headers cannot be changed into JSON 410; clients must
   discard the handle on transport/decode failure as well.
8. v1 has body/field/deadline bounds, but no new request-rate or concurrency cap.
   Existing sandbox resource limits still apply. Decide abuse/concurrency policy
   alongside floor-control work, rather than claim that a no-op seam enforces it.

## Route inventory

All are POST beneath `/sandbox/computer`:

```text
/session
/mouse/move       /mouse/click       /mouse/drag       /mouse/scroll
/mouse/down       /mouse/up
/keyboard/type    /keyboard/press    /keyboard/hotkey
/keyboard/down    /keyboard/up
/screenshot       /screenshot/compressed
/display/info     /display/windows
```

## Capability exposure decision

Approved follow-up (2026-10-24): [`sandbox-cli/README.md`](sandbox-cli/README.md)
records shipped sandbox-only CLI/MCP wiring, Adam-only managed app refresh and
the updated exposure matrix. OpenChamber uses a published duplicate-suppression
plugin switch; Nanobot partitions its existing adapter through parent config.
Live registry/read-only checks pass. Desktop was inactive during this release,
so live screenshots/input and browser image rendering remain unqualified.

The original API-only request authorized API/OpenAPI/llms orientation and deferred
adapter work, including CLI/MCP adapters. The historical matrix below describes
that earlier decision, superseded for hosted delivery by the follow-up above.
Inventory checked locally: plugin and Nanobot READMEs, well-known configs,
desktop skill distribution in llms.ts, and Chat tool architecture in DESIGN.md.

| Surface / verbs | Decision and reason | Discovery and invocation | Authority/consent | Follow-up owner and gate |
|---|---|---|---|---|
| HTTP API, all v1 methods | Expose, deployed 2026-10-24 | Generated OpenAPI plus concise llms workflow | Owner key/sandbox credential; observation handle is not authority | Adam/API maintainer: functional live qualification remains pending |
| Hosted OpenChamber plugin, reads and input | Defer per brief; submodule untouched | Future native image-capable tools and focused skill, calling the central API | Native permission path for consequential control; human coordination without claiming a lock | Plugin maintainer: independently release package/pin, qualify fresh and already-running installations after API deployment |
| Hosted Nanobot, reads and input | Defer; no native mutation approval UI | Future MCP image results plus installed skill and parent enabledTools/assets | Adam must decide input scope and consent before enabling writes; no localhost shortcut | Nanobot maintainer: separate package and parent installer release, qualify sleeping-client update behavior |
| BayLeaf Chat, reads and input | Defer; no toolkit/model grants changed | Future toolkit and ordinary-user discoverable skill | Establish per-user API authority, consequential-action approval and stored screenshot-history disclosure | Chat maintainer with Adam: approve integration/data boundary before source or production changes |
| Desktop OpenChamber/OpenCode, Standard and Sealed | Defer dedicated tools/skill delivery | Existing platform skill points to llms; this change adds orientation, not native image tooling | Owner API key, not temporary token; user consent for installation and input | Desktop integration maintainer: catalog skill/version or plugin choice, qualify updates and unprompted discovery in a fresh user session |

No adapter listing, runtime discovery, behavioral offering, installed-client
update or functional live API check is claimed. A future model choosing to call the
documented HTTP API through shell is not equivalent to native adapter delivery.

## Verification and deployment notes

- Approved deployment 2026-10-24: API
  `f3f98287-5610-4d89-b628-94558f449422`, Sandboxes frontend
  `42f7146a-7cfc-4aeb-b522-81874689834f`. Both deploy commands exited successfully;
  the API build regenerated published Nanobot assets at
  `6863a08e671eb7697a28b6582ac8e3bf1b17346d` (not fixtures).
- Live smoke: Sandboxes GET 200, generated spec lists all 16 computer POST routes,
  unauthenticated computer session POST 401. No live API input or functional
  screenshot/action qualification was performed.
- Release checks passed: TypeScript, `test:computer`, `test:docs`, `test:previews`
  (39 security groups, including embedded WS without Fetch Metadata),
  `test:service-sessions`, `test:sandbox-browser` (33 lifecycle groups plus Python
  checks), `test:sandbox-credentials`, and `git diff --check`.
- `tsc --noEmit`: passes after preparing the existing generated local assets.
- `npm run test:docs`: workerd documentation suite passes. New assertions cover
  all 16 POST contracts, owner-only security, error contracts and screenshot media.
- `npm run test:computer`: credential-free full-app HTTP harness passes. Covers
  genuine signed temporary-token rejection, valid Campus Pass rejection, invalid
  and revoked owner credentials, sandbox credentials and provider proxy metadata,
  no create/start/wake/readiness/cache mutation, 409/410 paths, strict generation
  output, handle tampering/expiry/owner/machine/purpose rejection, boot/PID/starttime
  changes, PascalCase, every action, four screenshot paths, parallel checks,
  malformed/oversized JSON, header minimization, and no content-bearing logs.
  The exact Python probe also runs against synthetic `/proc` fixtures, including
  stat comm with multiple closing parentheses and zero/one/two matches.
- `npm run test:sandbox-credentials`: existing custody/auth/accounting regression
  harness passes with the request-only proxy metadata addition.
- Initial implementation used synthetic providers and test-only generated assets.
  Deployment must rebuild verified published adapter assets through Wrangler's
  configured build, never deploy Nanobot fixtures. No dependency upgrade was made.
- npm reported 5 existing dependency vulnerabilities (3 moderate, 2 high).
  Dependency remediation was not part of this task.
- No new secret, D1 migration, Wrangler binding or feature flag. Workers
  observability remains disabled. Desktop activation remains an explicit managed
  app operation, not a hidden side effect of session open. No submodule edits.
