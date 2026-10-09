# Transient preview gateway: issues #71 and #72

Status: public and owner-authenticated HTTP/WebSocket gateway deployed and
enabled. BayLeaf Chat runs upstream Lathe 0.31.0, including registration-scoped
upstream headers. API/plugin rollout and live qualification are recorded below;
Chat deployment evidence is in `chat/DESIGN.md`. ✨

## Contract

**Current naming decision (2026-09-20):**
`{cruzid}-{access}-{nonce}.bayleaf-proxies.dev`, with a fresh 96-bit random
nonce on every registration, no visible port, and no stable redirect alias.
CruzID gives a useful explanation when one participant in a group cannot enter
another's private preview. The explicit `public` or `private` segment keeps the
agent's access-control choice visible when someone uses the URL away from the
initiating conversation. The nonce remains necessary to isolate service workers
and browser state. BayLeaf ignores Lathe's optional untrusted application `tag`;
the umbrella domain already supplies the service branding.

### Lathe installation

`POST /previews/registrations`, authenticated by the single approved Lathe
installation's bearer credential, accepts:

```json
{
  "owner": { "subject": "owui-user-id", "email": "person@ucsc.edu" },
  "upstream_url": "https://5000-token.proxy.daytona.work/",
  "access": "private",
  "tag": "vscode"
}
```

`access` is required and must be `public` or `private`. It is a command, not a
negotiation: the gateway enforces that policy or rejects registration. `tag` is
optional and ignored by BayLeaf. Legacy `slot`, `requested_access`,
`access_mode`, and request-level `expires_at` fields are rejected.

The registering deployment obtains identity from OWUI's injected user context.
The model must never supply ownership. The deployment is trusted to assert an
email in `ALLOWED_EMAIL_DOMAIN`. Browser ownership is exact normalized email
equality with the existing API login session. A subject's email cannot change
through re-registration. Account relinking requires an operator migration.

The response is `{ "url": "https://<cruzid>-<access>-<nonce>.bayleaf-proxies.dev/",
"expires_at": "..." }`. Public registrations proxy immediately for anyone
with the URL. Private registrations use the owner-login protocol below.
The public username is the CruzID, the exact local part of the normalized campus
email. The random suffix isolates each registration's browser state; it is not
an authentication credential or a hash of identity. Unsupported DNS characters and
overlong labels are rejected rather than silently rewritten. Database uniqueness
and ownership checks still enforce the binding. The
installation-local subject maps to that email, and cannot be rebound to another
email through this endpoint. Retired URLs are not redirected or deliberately reused.

Registrations last 24 hours. The response's `expires_at` describes gateway
retention, not how long the application or upstream credential remains usable.
Lathe registrations are independent leases because v2 supplies no stable slot;
repeated exposure does not revoke an earlier Lathe URL. The installation can
revoke a known hostname with `DELETE /previews/registrations/<host-label>`.
No list/read endpoint returns upstream URLs. Maximum 16 active previews per owner.

The POC accepts HTTPS origin URLs only (root path, no query, fragment, userinfo,
or alternate port), under explicitly configured upstream DNS suffixes. This
matches Daytona's signed-hostname URLs. It intentionally does not yet implement
generic path/query bearer URLs. Redirects are never followed server-side.

### Keyed user/agent

`POST /sandbox/expose` accepts `{ "port": 5000 }` with an ordinary BayLeaf user
API key. It resolves the caller's existing, running sandbox, obtains the
port-scoped signed URL internally, and returns the same response format. It
does not start, wake, or launch a service. `DELETE /sandbox/expose/5000` revokes
the caller's keyed port registration. Neither endpoint accepts
Campus Pass, an installation credential, or a browser session as authority.

Access defaults to **private** (owner login). Optional `"access":"public"`
explicitly permits anonymous access. Port 3100 is reserved for the managed
OpenChamber interface and cannot be exposed through this endpoint. Sandbox
agents use the canonical plugin's `bayleaf_expose` tool, which reads the owner key
internally and defaults to private exposure without displaying credentials. ✨

Public previews may be framed by their owner's active managed OpenChamber origin.
The gateway permits public GET iframe navigation and emits an exact
`frame-ancestors` allowlist containing only self and that current owner origin,
after checking its registration/deadline/key binding. It removes `X-Frame-Options`
only when granting this exception. Other sibling origins remain blocked by CSP;
cross-origin fetches, mutations, private-preview access, and WebSocket rules are
unchanged. Private previews still use their top-level owner-login flow.

Verified in deployed Chromium on 2026-10-03 (Pacific): the reported public service
rendered under the current owner OpenChamber origin and was blocked under an
unrelated sibling origin. The test used synthetic parent documents at those
origins and the real public service, isolating browser framing-policy enforcement.

The keyed API obtains a 24-hour Daytona signed URL and keeps its registration
for 24 hours. Re-exposing the same port replaces that keyed registration.

Both entry points use the same canonical email owner, but only the keyed API has
a stable port slot. A future second installation must receive an explicit
namespace/identity policy, not automatic authority based on matching email text.

### Installation authentication

`PREVIEWS_INSTALLATION_KEY` is a Worker Secret containing a high-entropy random
key (at least 32 characters; generate 32 random bytes and encode as base64url).
The OWUI admin stores the same key in Lathe's admin valve. Lathe presents it as
`Authorization: Bearer <key>` over HTTPS. The Worker compares fixed-size SHA-256
digests using `crypto.subtle.timingSafeEqual` before parsing registrations.
There is no token exchange, OAuth client registry, or public enrollment endpoint.

The key is accepted only for preview registration and installation-scoped
revocation. It cannot authenticate browser access, user-key endpoints, or
sandbox lifecycle operations. Missing/malformed secrets fail closed. Rotate by
replacing the Worker Secret and updating the Lathe valve; old-key requests fail
immediately on the new Worker version. Existing preview grants expire or can be
revoked independently. Rotation is not a promise to terminate existing grants.

### Registration-scoped upstream headers (issue #86, deployed 2026-10-08 Pacific) ✨

Both registration endpoints accept optional `upstream_headers`, following
[Lathe #98](https://github.com/rndmcnlly/lathe/issues/98) and Lathe 0.31.0:

```json
{"port":8765,"access":"private","upstream_headers":{"X-Authenticated-Owner":"true"}}
```

Headers are ordinary model-supplied proxy configuration, independent of public or
private access. No additional approval, identity mapping, or owner preset is
introduced. A nonempty dictionary receives the exact boolean
`"upstream_headers_applied": true` alongside `url` and `expires_at`. Empty or absent
dictionaries retain the existing response. Lathe and the managed `bayleaf_expose`
tool fail closed if this acknowledgement is missing or not exactly true; they
must not substitute a direct Daytona URL. The plugin keeps its existing
access/port permission resource and excludes header values from that resource.

The shared HTTP/WebSocket header builder applies configured values after the
ordinary private-owner and origin gates, overwriting browser values
case-insensitively. Client `Connection` nominations cannot remove these headers.
Fixed `Authorization`, including Basic, is supported. Public visitors can exercise
injected credentials, including on public navigation and permitted iframe loads.
An assertion header has no intrinsic visitor-identity meaning. Unconfigured
headers retain the existing allowlist behavior; there is no new assertion namespace.

Validation matches Lathe: maximum 16 entries, 1–64-byte ASCII HTTP-token names,
0–4096-byte printable ASCII values, and 8192 total name/value bytes. Case-insensitive
duplicate names are rejected. Forbidden names (case-insensitive): `Host`, `Cookie`,
`Origin`, `Referer`, `Forwarded`, `X-Real-IP`, `True-Client-IP`, `Connection`,
`Upgrade`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Content-Length`,
`Expect`, `HTTP2-Settings`, `Proxy-Authorization`, `Proxy-Authenticate`. Forbidden
prefixes: `X-Forwarded-`, `Sec-`, `CF-`, `Daytona-`, `X-Daytona-`, `X-Lathe-`.
Registration validation errors omit names and values. Both endpoints bound JSON
bodies to 64 KiB to accommodate JSON escapes at the inclusive 8192-byte header bound.

BayLeaf additionally rejects recognized platform credentials in configured values,
including decoder-equivalent API/preview JWT signatures and the signed upstream
hostname/label/credential. Basic values are decoded and checked, including each
colon-separated component. These conservative exclusions also apply at forwarding
time and reject the request rather than silently dropping configured headers.
They do not classify every possible credential encoding or unrelated third-party key.

Header-bearing records store a versioned destination/header object inside the
existing hostname-bound AES-GCM `upstream_encrypted` field. Headerless records keep
their URL-only format; no D1 migration is needed. Responses and ordinary metadata
contain neither the destination nor header names/values. Replacement removes the
previous configuration, including when the new request omits headers; revocation,
expiry and hourly cleanup cover the entire encrypted record. D1 backups retain
deleted ciphertext under the existing backup policy. The gateway can decrypt these
credentials: this is not ZOA storage. Model-supplied values already exist in tool
arguments/history, and application response bodies may reflect them.

`PREVIEWS_INSTALLATION_KEY` rotation does not change stored encryption. Replacing
`PREVIEWS_SECRET` makes existing encrypted registrations and preview sessions
unusable; there is no previous-key fallback or automatic re-encryption. Re-register
after rotation. Active sockets retain the existing generation/expiry lifecycle;
use explicit revocation or disable the gateway to terminate them, rather than
assuming key rotation immediately closes every established connection.

**Distribution and qualification:** the managed plugin and its canonical
`bayleaf-sandboxes` skill are published as `ba62f515c5b1001b9562f2351286de004a1ce1b7`.
Worker `d150ca87-5fd8-4925-bb60-f35d1ee26022` deploys the API revision and selects
that exact pin, verified through authenticated production configuration. Live
health and OpenAPI checks passed. Legacy expose wrappers remain retired; the
operator-only `preview-ops.py` and `preview-apps.py` retain headerless compatibility.
BayLeaf Chat has separately deployed exact upstream Lathe 0.31.0, preserving its
existing valves and grants. The companion Code Sandbox skill readback matches.
Six core isolated OWUI checks passed. Actual Basic → production Lathe exposure
verified public Basic/custom-header injection and spoof replacement, private
unauthenticated HTTP 401, and headerless public HTTP 200 with unconfigured headers
filtered. Six smoke leases were revoked and independently returned 404; temporary
fixture directories and the port-8943 listener were removed. The shared sandbox
was preserved because concurrent unowned work had appeared. See `chat/DESIGN.md`.
Live Nanobot 0.3.5 and dufs 0.46.0 qualification is recorded in
[`PREVIEW-HEADERS-QUALIFICATION.md`](PREVIEW-HEADERS-QUALIFICATION.md). Injection,
spoof replacement, anonymous private denial and revocation passed. Direct and
wrapped traffic both arrived from loopback: a holder of a signed/provider preview
capability could spoof Nanobot's assertion directly. Its trusted-peer setting does
not establish passage through BayLeaf's owner gate. Nanobot's initial WS `ready`
frame was lost through the gateway. The cause was accepting the upstream socket
before installing relay listeners across an awaited authorization recheck. Worker
`b814079b-4391-4fc0-95eb-10009c7b6b18` deploys the fix: listeners precede acceptance,
and rejected or partially established handshakes close their upstream sockets.
The regression failed before the fix and all 35 gateway checks passed afterward.
Three fresh live Nanobot connections on the fixed Worker received the initial
`ready` frame in 0.46–0.86 seconds and subsequent non-inference validation replies.
The follow-up lease, disposable sandbox, D1 records and local credentials were
removed with independent cleanup verification; see the qualification report.
Checked successful bodies contained no tested upstream/credential strings; this
is route-specific evidence, not general response sanitization. All six leases and
the disposable sandbox were removed and independently verified absent.

Local evidence: the Worker/D1 suite passed 33 grouped checks, including both
registration endpoints, public/private HTTP and WebSocket injection, denied-owner
and foreign-origin requests, encrypted configuration, case collisions, replacement,
removal, expiry/revocation, bounds and sanitized failures. Focused source-helper
tests cover 180 decoder-equivalent platform JWTs, Basic credential containment,
hostname-bound ciphertext, encryption/installation-key rotation and legacy records.
Independent review caught and verified fixes for leading-space auth-scheme
normalization and malformed JSON handling; trailing CR/LF validation also has
explicit regressions. Plugin unit tests passed 14/14. The isolated real V2 2.0.22
runtime verifies registered header input types, unchanged access/port permissions,
request bodies, exact acknowledgement failures, and headerless compatibility.
The published Git package also passed the isolated V2 runtime harness. These
checks use synthetic providers/identities and do not establish live app qualification.

## Authentication protocol

The gateway and identity broker are co-located in the API Worker. Code redemption
is an internal, atomic database operation, not a public redemption endpoint.
Preview-host requests are dispatched before API CORS, routes, and error logging.
The gateway never reads an API session cookie on a preview hostname.

1. Preview `/__preview/start` creates a five-minute transaction and a random,
   Secure, HttpOnly, host-only `__Host-bl-preview-transaction` cookie. Only its
   digest is stored. It redirects to the canonical API broker.
2. The broker binds that transaction once to another random host-only cookie on
   the API host, then redirects to the exact registered preview `/__preview/prove`.
3. The preview verifies its original transaction cookie before marking the
   transaction proved and returning to the API broker.
4. The broker requires its own transaction cookie and the proved state, performs
   ordinary API login if necessary, and checks owner email. It issues a random
   single-use code, valid for at most 60 seconds.
5. The preview callback atomically consumes the code only alongside the original
   preview cookie and current registration generation. It sets a host-only
   gateway session lasting until registration expiry (at most 24 hours), then
   redirects to `/`.

This extra two-host round trip is important: PKCE or a cookie at only one end
does not by itself stop an attacker initiating a transaction and asking the
owner to complete a copied authorization URL. A copied URL at any intermediate
stage must fail in a browser lacking the appropriate original cookie.

## Origin and application policy

Adam revised the initial stable-origin choice on 2026-09-17: each registration
now receives a fresh origin. Replacing a keyed owner/port registration or
revoking any known hostname closes its sockets. Its service workers, caches,
and local storage cannot control the next origin. The flat hostname works with the existing
single-level wildcard certificate; a nested `{nonce}.{cruzid}` shape would need
additional TLS provisioning and would still be same-site for cookie purposes.

Service workers are allowed on nonce origins. Root-relative
`Service-Worker-Allowed` headers are preserved, supporting root-scoped workers.
Private script fetches still require owner authentication; reserved authentication routes
cannot be fetched as worker scripts or forwarded upstream. A worker installed by
the current app can observe/intercept that generation's navigations, including
the auth handoff. It cannot read HttpOnly cookies or transfer the browser-bound
authorization code into another browser; server requests still undergo all
ownership, generation, and expiry checks. There is no claim that current app
code is excluded from its own origin's browser activity.

Retirement blocks network access, not previously downloaded content: an old
worker may keep showing cached UI. There is no automatic erasure of browser
storage. Fresh origins prevent that state being inherited by a replacement app.

Every request with an Origin must match the exact preview origin. Cross-origin
subresources, sibling-site requests, and unsafe requests lacking a matching
Origin are denied. External top-level GET navigation is allowed. Responses
grant no CORS access and cannot be framed cross-origin. Gateway cookies are
stripped before upstream forwarding. Server-set application cookies are
transported under Secure, HttpOnly, host-only `__Host-bl-app-` names containing
the registration generation and encoded original name/path. The gateway restores
the original names upstream and enforces their path scopes. Parent-domain and
old-generation cookies cannot enter that transport. Lifetimes are capped at
registration expiry; stale-generation cookies are cleared on the next login.

This supports server-managed application sessions, not arbitrary
`document.cookie` integration: JavaScript cannot read/write the original cookie
names through this transport. Applications depending on that behavior require
separate compatibility work. Upstream attempts to set gateway cookies are dropped.

Authenticated private requests require Fetch Metadata or an exact matching Origin;
legacy browsers that provide neither are denied. Request and response headers
use allowlists. Redirects may only target the same upstream origin or the exact
protected preview origin, are translated to the preview origin, and carry no
upstream response body. Upstream HTTP errors keep their status with fixed sanitized
content; transport failures remain gateway errors. No caching,
upstream error logging, or request/response content storage is introduced.
Application response bodies are streamed unchanged. An application that embeds
its upstream hostname in its body can still disclose that hostname: the actual
Daytona/application combination must pass an echo/absolute-URL containment test
before screen-safe deployment. This is a qualification requirement, not a
claim that header filtering sanitizes arbitrary application content.

### HTTP application compatibility (locally tested, 2026-10-08) ✨

- The mandatory private owner-cookie gate runs before forwarding. An application
  password or bearer token cannot authenticate to BayLeaf or bypass that gate.
- Only `Authorization: Bearer <token>` and `X-Nanobot-Auth` are newly allowed
  application credentials, bounded to 4096 characters. They travel only on
  non-navigation requests with the exact preview Origin or `Sec-Fetch-Site:
  same-origin`. Existing origin checks still reject foreign/sibling Origins and
  unsafe requests without the exact Origin. Navigation/iframe exceptions never
  transmit these browser-supplied credentials. Browser-supplied arbitrary auth
  headers and Basic auth stay stripped; registration-configured headers follow
  the separate injection contract above.
- Reserved `sk-` (including ordinary and temporary BayLeaf keys and OpenRouter),
  `tk_`, `admin_`, `tvly-`, `dt_`, and Campus Pass credentials stay stripped in
  both headers. So do configured key/secret/token binding values, the signed
  upstream hostname, first DNS label and port-stripped credential label, incoming non-app
  cookie values, and JWTs signed by BayLeaf's API/preview session secrets
  (including expired tokens and decoder-equivalent signature spellings). Signature
  recognition uses the same base64 decoder as Hono's session verifier, not a
  canonical-token regex. Malformed JWT-like credentials are stripped. These
  exclusions are conservative: app passwords
  colliding with them are unsupported. Opaque credentials for unrelated external
  systems cannot in general be classified; this is not a credential DLP system.
  No identity lookup, provider-key acquisition, credential logging or storage is
  added. Other request-header and cookie allowlists remain unchanged.
- Completed HTTP 400–599 responses, including 500, keep their upstream status.
  Their body is replaced with `Preview application request failed.` (no body for
  HEAD); cookies, authentication challenges, redirects, debug headers and original
  entity headers are dropped. Hosting errors cannot be distinguished from app
  errors by status alone. Fetch rejection/timeout and invalid redirects remain
  sanitized HTTP 502 gateway failures. WebSocket handshake errors still use 502.
- HTTP 304 for GET/HEAD is bodyless and does not require or forward Location.
  `If-None-Match` and `If-Modified-Since` reach the upstream. Successful responses
  and 304 may carry a bounded quoted ETag (`A–Z`, `a–z`, digits, `.`, `_`, `-`,
  optional `W/`, excluding the upstream hostname, first DNS label and port-stripped
  credential, case-insensitively) and canonical HTTP Last-Modified
  date. HTTP 429/503 may carry Retry-After as up to ten decimal digits or a
  canonical HTTP date. Other free-form metadata is not forwarded. `no-store`
  remains mandatory: validator support introduces no gateway or browser caching.

The workerd harness synthesizes Nanobot-style bootstrap 401, password bootstrap
via the custom header, and subsequent `nbwt_` bearer API calls. Token format was
checked against [Nanobot v0.3.5 source](https://github.com/HKUDS/nanobot/blob/v0.3.5/nanobot/webui/gateway_tokens.py).
This qualifies the gateway contract locally, **not a real Nanobot browser flow**.

Production follow-up (2026-10-08 Pacific): deployed Worker
`5bc31933-6d94-4390-b15e-a9c66ab2b171` by operator approval. The existing owner
sandbox was poked; Nanobot was already running. Its login screen and password
bootstrap worked through the private preview. Initial chat creation failed because
Nanobot advertised a loopback WebSocket URL. Setting its supported
`channels.websocket.publicWsUrl` to the private preview's `wss://` origin and
restarting Nanobot resolved that deployment configuration issue. OpenChamber's
browser then created a saved topic and received a BayLeaf-inferred response.
An anonymous bootstrap fetch remained HTTP 401. This qualifies this basic
Nanobot 0.3.5 login/chat flow, not arbitrary successful-body URL containment,
all Apps, or the full project/file workflow. Renewing the preview hostname also
requires updating Nanobot's explicit public WebSocket URL. No Git publication. ✨
Apps requiring JSON error details, WWW-Authenticate challenges, error-set cookies,
browser-supplied Basic auth, unusual validators, or original `document.cookie` names remain outside
the contract. Successful application bodies are still streamed unchanged and must
be separately qualified for upstream-URL containment. Production deployment and
browser qualification require separate approval.

#### Review-fix evidence (2026-10-08) ✨

Astra's two findings were independently confirmed at helper level: decoder-valid
API session JWT signature padding bypassed the original credential regex, and
ETags could disclose the upstream first DNS label or port-stripped credential.
Both checks now cover those equivalent representations without relaxing app
credential permissions. Run `node scripts/test-preview-compatibility.mjs` from
`api/` for fast, credential-free tests of the actual private source helpers and
header builder (test-only exports are appended in memory, not added to production).
The suite checks 180 Hono-verified session JWT spellings across both session secrets,
expiry states, padded signed parts, signature padding, alphabet aliases, whitespace
and unused pad bits, plus 30 hostname/label/credential ETag containment cases and
positive controls. These are helper tests, not owner-gate or browser qualification.

The independent end-to-end attempts did **not** complete: one was manually
interrupted, and a second hit a 90-second timeout before any PASS. Its last marker
preceded `await mf.getD1Database('DB')`; neither completed migrations nor executed
end-to-end probes were established. The earlier 30 grouped checks/five fixture
tests/TypeScript passes were implementation evidence, not an independent rerun.
The durable full harness now reports startup, D1 acquisition, each migration and
each check, with a 90-second deadline naming the last stage if it stalls.

After these fixes, the implementation rerun completed D1 acquisition, all fixture
migrations, all 30 grouped workerd checks and disposal within the deadline;
`npm run test:previews` also passed its five Python fixture tests. The focused
helper suite, `npx tsc --noEmit` and `git diff --check` passed. No startup stall was
reproduced in this run; the earlier independent stall's cause remains unknown.
The new decoder/partial-label regressions are established by the focused helper
suite, not by the unchanged assertions in the 30 grouped end-to-end checks.

## Configuration and retention

- `PREVIEWS_ENABLED` must equal `true`.
- `PREVIEWS_API_ORIGIN`: canonical HTTPS API origin.
- `PREVIEWS_DOMAIN`: isolated preview domain, never a Chat/API parent domain.
- `PREVIEWS_SECRET`: independent 32-byte base64 secret for AES-GCM encryption
  of stored upstream credentials/configured application headers and signing preview sessions.
- `PREVIEWS_INSTALLATION_KEY`: the single approved Lathe installation's secret
  bearer credential, distinct from all user API keys.
- `PREVIEWS_UPSTREAM_SUFFIXES`: comma-separated upstream DNS suffix allowlist.
  Each suffix starts with a dot, for example `.proxy.daytona.work`. Only one
  additional DNS label is accepted. This trusts the hosting provider's DNS;
  custom user-controlled upstream domains are not supported by this policy.

Apply migration `0007_preview_proxies.sql`.
Migration `0009_preview_origin_invalidation.sql` adds a transactional retirement
queue. Triggers capture displaced/deleted hostnames so concurrent registrations
and failed RPC retries cannot lose old-socket invalidation work. Successful
registration/revocation drains its queue; hourly cleanup retries leftovers.
Migration `0008_preview_cruzid_names.sql` changes the POC's initial hashed owner
reservations to exact CruzIDs. It requires zero preview registrations: ciphertext
is bound to its original hostname, so renaming active rows would break it. This
naming revision was migrated and deployed on 2026-09-17; earlier live evidence
below describes the preceding hashed-name version.
Migration `0010_preview_access_policy.sql` records `public | private`, migrating
all pre-v2 registrations to `private`.
Expired registrations and flows are deleted by the scheduled cleanup; owner
slug mappings persist to prevent origin reassignment. Upstream URLs are encrypted
at rest, but the gateway decrypts them to forward traffic. They are credentials,
not application content. D1 backup retention still applies to deleted ciphertext
and identity metadata. Runtime observability remains disabled.

New active state is bounded to 16 previews per owner and 64 pending login flows per
hostname. Registration bodies are limited to 64 KiB (8 KiB before the header-capable
revision). Upstream HTTP operations
have a five-minute deadline, bounded further by registration expiry. Cloudflare's
platform request/upload limits also apply. This is an initial resource bound,
not per-owner traffic accounting or a guarantee against unauthenticated traffic
exhausting a hostname's pending-login allowance.

WebSocket upgrades require the exact preview Origin; private previews also
require a valid owner session.
A `PreviewConnections` Durable Object per hostname relays frames and owns socket
lifetime. Up to 16 connections per hostname and 4 MiB per frame are allowed.
Establishment has a ten-second timeout which is cleared after the handshake.
Negotiated subprotocols are checked and forwarded; text and binary frames work.

Keyed registration replacement and all revocation synchronously invalidate
old-generation connections. A Durable Object alarm closes idle sockets at the earlier of browser
grant or registration expiry; it also rechecks D1 every 30 seconds while sockets
are open. Message handlers independently refuse expired/closed grants. No frame
payloads are persisted or logged. Outbound sockets keep the object active, so
this uses ordinary active Durable Objects rather than hibernation. No sandbox
lifecycle or Daytona account credential is part of the wrapping interface.

The interactive-service acceptance case is a continuous four-hour code-server
session without re-exposure or re-login. Signed URL, registration, and browser
authorization all default to a 24-hour window. Browser traffic may keep Daytona
active according to its lifecycle rules; the gateway adds no background keepalive
and does not wake or relaunch services. WebSocket support must verify continuous
use, reconnects, and closure at registration expiry before claiming this case
works for a full four-hour session. Short live interactive checks and accelerated
clock-boundary tests are recorded below; a four-hour wall-clock soak has not run.

Slots are stored as text and hostnames are looked up exactly, never parsed into
username and port. A future `{username}-{servicename}` registration policy can
reuse the ownership and authentication machinery. Wake/relaunch is a separate
future concern; neither the schema nor the proxy assumes a numeric transport
port can be recovered from the public hostname.

## Qualification and rollout

1. Run the local security harness and TypeScript checks.
2. Review the diff before deploying the disabled API revision and migration.
3. Configure wildcard proxied DNS/TLS and the Worker route for the isolated
   domain; configure one test deployment, then enable the bounded POC.
4. Test an already-running synthetic service with two separate browser profiles:
   owner access, non-owner denial, every copied intermediate URL, sibling-origin
   fetch/form/navigation, reflected upstream host, redirects, errors, expiry,
   replacement, and revocation. Record actual results here.
5. Implement generic wrapping upstream in Lathe, with fail-closed errors and no
   raw URL in tool results, events, logs, or exception messages. Personal
   deployment dogfooding precedes the BayLeaf toolkit update.
6. Qualify dufs/code-server, uploads, cookies, and WebSocket lifetime enforcement.
   Update platform privacy/retention and Chat documentation before enablement.

Rollback: set `PREVIEWS_ENABLED=false` and deploy. Keep Lathe wrapping configured
so exposure fails closed rather than reverting to visible bearer URLs. SSH
exposure remains a separate credential-bearing path.

## Local evidence (2026-09-17)

`npm run test:previews` passes 25 grouped security checks against the actual
bundled Worker under Miniflare/workerd
and applies all D1 migrations to an ephemeral database. Synthetic tests cover
installation/user credential separation; destination and identity policy;
encrypted credential storage; owner/non-owner access; copied intermediate
URLs and concurrent code redemption; sibling-origin requests; credential/header
stripping; upload forwarding; redirect/error containment; replacement,
revocation, expiry, and the production scheduled cleanup handler.

The harness simulates browser cookies and Fetch Metadata. Its test-only
entrypoint restores headers that Node/Miniflare otherwise rewrite or reject
before they reach the gateway. It does not establish real-browser cookie or
SSO behavior, actual Daytona hostname containment, or dufs/code-server support.

## Live evidence (2026-09-17)

Deployed Worker version: `c794b2d0-1ce3-4dfa-b0a0-9da7dd3a5b79`.
Migration 0007 applied remotely. Preview secrets are installed as Worker Secrets;
the local mode-0600 recovery copy is `~/.tokens/bayleaf-previews`.
The zone's wildcard A record is proxied, with documentation-only address
`192.0.2.1` as the unused origin. Worker route `*.bayleaf-proxies.dev/*` handles
requests. HTTPS and certificate coverage were verified by browser access.

`scripts/preview-fixture.py` ran temporarily on port 8787 in the operator's
existing sandbox. `scripts/preview-ops.py` manages the synthetic fixture and
registration tests without printing the upstream bearer URL or credentials.

Verified live:

- Keyed `/sandbox/expose` returned a protected URL and the owner browser reached
  the synthetic service through the two-host login handoff.
- Installation-key registration succeeded for an explicitly synthetic different
  owner. The operator's authenticated browser was denied that preview.
- A separate HTTP client initiated a transaction; copying its authorization URL
  into the authenticated owner browser failed at the preview-host proof step.
- A fresh Chrome profile copying the owner's exact preview URL reached CILogon,
  not the application. It acquired no owner preview session.
- The application echo saw no hidden upstream hostname or gateway cookie.
  `X-Forwarded-Host` matched the protected hostname. A 16-byte upload arrived.
- Same-preview absolute redirects remained wrapped; upstream error responses
  became fixed HTTP 502 errors with no upstream hostname.
- Both synthetic registrations were revoked, the fixture process stopped and its
  file removed, and pending test flows deleted. Independent D1 verification
  found zero test registrations. The formerly authenticated owner browser could
  no longer access the revoked preview. Owner-name reservations remain by design.
- The API health endpoint remained healthy after cleanup.

Two corrections came from live testing: Daytona's authenticated API returned
the suffix `.daytonaproxy01.net`, now explicitly allowlisted alongside the
documented `.proxy.daytona.work`; proxy-aware applications can emit redirects
to the protected hostname itself, which the gateway now accepts and tests.
Wrangler's OAuth token lacked DNS-read/write scope, so the wildcard DNS record
was created through the operator-authenticated Cloudflare browser panel.

The live browser used an existing API session. Fresh CILogon completion and
copying an owner-issued callback before redemption were not separately exercised
live; callback copying, concurrent redemption, expiry, replacement, and scheduled
cleanup passed in the local workerd/D1 suite. These initial HTTP-only checks
preceded the subsequent WebSocket/application qualification below.

### CruzID naming deployment (2026-09-17)

Migration 0008 applied after confirming zero preview registrations. Worker
version `959811ff-d440-4ec2-88ee-f2346ddb80b7` uses exact campus usernames.
A fresh keyed exposure returned `https://amsmith-8787.bayleaf-proxies.dev/`,
and the owner browser reached the synthetic service at that URL. The fixture
was then stopped and removed, its registration revoked, and zero remaining test
registrations independently confirmed. The clean URL returned HTTP 404 after
revocation; API health remained good. No redirect or alias from the earlier
hashed hostname is retained.

### Multi-hour lifetime and WebSocket deployment (2026-09-17)

The four-hour code-server use case exposed three separate clocks: the upstream
signed credential, registry retention, and browser authorization. The deployed
revision defaults all three to 24 hours, while keeping registry lifetime
independent of the upstream's actual availability. Optional `expires_at` now
requests registration retention only. Existing registrations are replaced on
re-registration as before. This phase's deployed version:
`754da34d-f9ef-4ed6-a33f-c0f0712d172f`, including the
`preview-connections-v1` Durable Object migration and `PREVIEW_CONNECTIONS` binding.

The workerd harness advances its test-only clock by four hours and verifies
that an existing browser grant still forwards HTTP requests, then advances past
24 hours and verifies denial. It also checks requested shorter retention, the
24-hour ceiling, and the API's 86400-second Daytona signing request. These are
clock-boundary tests, not evidence of four hours of live WebSocket traffic.

Additional local tests verify text/binary WebSocket relay, reconnects, survival
past the handshake timeout, closure on replacement/revocation, alarm-driven
expiry of idle connections, shorter legacy browser grants, and application-cookie
path/generation/credential isolation.

Live application evidence:

- Dufs 0.46.0: directory UI loaded; browser PUT returned 201, GET returned 200
  with matching contents, and DELETE returned 204.
- Synthetic cookie fixture: application-cookie round trip succeeded; the cookie
  was HttpOnly, and the upstream received no gateway cookie or hidden hostname.
- Code-server 4.137.0: explorer/file access and extension-host connections worked;
  reload reconnected. The original 1 GiB sandbox then OOM-killed code-server
  (`memory.events: oom_kill 1`), while dufs survived. This was not proxy expiry.
- A disposable 2-vCPU/4-GiB sandbox successfully ran a terminal task initiated
  through the browser. Its `terminal-proof.txt` was independently checked. The
  minimum sufficient memory has not been established; 4 GiB is a tested shape,
  not a claim that every sandbox must use that amount.
- Code-server reports the intentional service-worker denial. Offline/PWA and
  service-worker-dependent webviews are not qualified. The release also emitted
  duplicate built-in TypeScript extension and missing VSDA WASM diagnostics;
  the verified core operations above still worked.

Cleanup: both application processes/directories and the synthetic cookie fixture
were removed, and all test registrations revoked. The disposable sandbox stayed
in Daytona's `destroying` state for several minutes; its per-ID HTTP 404 was
independently confirmed before discarding the tracked ID. D1 subsequently showed
zero preview registrations, and the API health check passed.

Upstream Lathe 0.27.0 was developed in `../lathe` beside this checkout: 720 unit
checks, 9/9 Daytona integration scenarios, and
2/2 isolated OWUI preview scenarios passed. The OWUI test used Basic's ZDR path
and actual injected user context. Its temporary `lathe_preview_test` copy omitted
only dependency-install frontmatter to avoid upgrading the live OWUI process
from Pydantic AI 1.x to 2.x. The executable source/schema and wrapped expose path
were checked; this does not qualify the full toolkit/dependency upgrade.
The staging toolkit, sandbox, and registration were cleaned up. Personal proxy
dogfooding was deferred by Adam, so no personal-identity mapping was added.

### Production Chat rollout (2026-09-17)

After explicit approval to upgrade Lathe in passing, production Chat adopted
the exact upstream 0.27.0 source and its Pydantic AI `~=2.5` requirement. The
installation key and wrapper URL are configured, with 86400-second upstream
previews. Existing tool grants and retained valves were verified unchanged.
Full regression with dependency installation passed **7/7 scenarios**, including
view, delegate, and protected exposure. An additional model-mediated smoke test
called the actual production `lathe` toolkit and returned the expected clean
CruzID URL without an upstream hostname. The Code Sandbox skill was updated to
describe owner login, screen sharing, SSH credentials, and the temporary-service
boundary. The vendored source matches the upstream checkout byte-for-byte.

Chat was restarted to establish a clean dependency runtime (deployment
`a25ae1e8-7d81-481b-aa09-e6f57c595b1b`). This was a precaution for cached imports,
not a demonstrated requirement: OWUI already installs new requirements on source
changes. The health check passed. Synthetic fixtures and registrations were
cleaned up; the production smoke's final D1 check initially hit an expired local
Wrangler OAuth token, then passed after refresh. The ops helper now refreshes
through Wrangler and retries once on HTTP 401.

### Final transient-origin rollout (2026-09-17)

Upstream Lathe implementation: [bf7e0e8](https://github.com/rndmcnlly/lathe/commit/bf7e0e8).

Deployed version `b64dc0ea-8724-4915-8725-a67b7c27c815`, migration 0009.
That rollout's URLs were `{cruzid}-{nonce}.bayleaf-proxies.dev`: no port, stable alias, or
implicit launcher. Each registration replaces its owner/slot's previous origin.
The nonce is 96 random bits, not identity hashing or an authorization credential.
The 24-check workerd suite includes concurrent replacement, retired-origin
denial, cookie audience separation, socket closure, and authenticated worker
script delivery. The live API returned the new shape over the existing wildcard
TLS setup. After renewed UCSC login, a real browser registered a root-scoped
worker, confirmed request interception and authenticated network access, and
completed another auth handoff with that worker installed. Re-registration
produced a new origin with zero worker registrations and no controller; the
retired origin returned HTTP 404 at the network boundary. The production Lathe
smoke also returned the nonce URL. Synthetic resources were cleaned up.

### Access-policy v2 rollout (2026-09-20)

BayLeaf retained its integrated API Worker rather than adopting Lathe's bundled
standalone wrapper. Migration 0010 added an explicit `public | private` access
policy and migrated every existing registration to `private`. The strict request
schema rejects legacy protocol fields. Public records bypass owner login;
private records retain the two-host proof. BayLeaf ignores `tag`; new hostnames
make the CruzID and access policy legible while retaining nonce origin isolation.

Access-policy v2 Worker version: `9e80e504-7207-4eb8-b2c6-885bfe4bafc4`. The local
25-check workerd/D1 suite and live raw-contract checks passed. Isolated OWUI
tests passed private and public wrapped exposure. Production Chat then adopted
upstream Lathe 0.29.6; the actual production toolkit returned a private wrapped
URL, a public wrapped URL that served the tracked fixture without login, and no
Daytona hostname. It continued to reject SSH exposure. Synthetic fixtures,
toolkits, sandboxes, and registrations were removed; D1 reported zero remaining
test registrations. Cloudflare's zone bot policy rejects Python's default user
agent before the Worker, so non-browser smoke clients use an explicit test user
agent; this is not a preview authorization result.

The policy-legible hostname revision deployed as Worker
`e45384c2-13f4-4bc2-89c8-c6386bdac09c`. Raw and production-Lathe smokes returned
`amsmith-private-<nonce>` and `amsmith-public-<nonce>` as requested; private
remained owner-authenticated and public served the tracked fixture directly.
