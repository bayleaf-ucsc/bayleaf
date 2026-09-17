# Owner-authenticated previews: issue #71

Status: owner-authenticated HTTP/WebSocket gateway deployed and enabled on
2026-09-17. Generic wrapping is implemented in the upstream Lathe checkout and
passed isolated and production OWUI tests. BayLeaf Chat now runs upstream Lathe
0.27.0 with wrapping enabled. Evidence and limitations are below. ✨

## Contract

**Final naming decision (2026-09-17):** `{cruzid}-{nonce}.bayleaf-proxies.dev`,
with a fresh 96-bit random nonce on every registration, no visible port, and no
stable redirect alias. Ports/opaque slots stay server-side. This supersedes the
stable-name experiments recorded later in the evidence history. A future named
launcher would be a separate Worker-served surface that creates transient URLs.

### Lathe installation

`POST /previews/registrations`, authenticated by the single approved Lathe
installation's bearer credential, accepts:

```json
{
  "owner": { "subject": "owui-user-id", "email": "person@ucsc.edu" },
  "slot": "5000",
  "upstream_url": "https://5000-token.proxy.daytona.work/"
}
```

The registering deployment obtains identity from OWUI's injected user context.
The model must never supply ownership. The deployment is trusted to assert an
email in `ALLOWED_EMAIL_DOMAIN`. Browser ownership is exact normalized email
equality with the existing API login session. A subject's email cannot change
through re-registration. Account relinking requires an operator migration.

The response is `{ "url": "https://<cruzid>-<nonce>.bayleaf-proxies.dev/",
"access_mode": "owner-authenticated", "expires_at": "..." }`.
The public username is the CruzID, the exact local part of the normalized campus
email. The random suffix isolates each registration's browser state; it is not
an authentication credential or a hash of identity. Unsupported DNS characters and
overlong labels are rejected rather than silently rewritten. Database uniqueness
and ownership checks still enforce the binding. The
installation-local subject maps to that email, and cannot be rebound to another
email through this endpoint. Retired URLs are not redirected or deliberately reused.
Slots are opaque strings in
the generic contract; this deployment accepts canonical ports 3000–9999.

Registrations default to 24 hours, with a 24-hour ceiling. The optional request
field `expires_at` requests a shorter registration lifetime; it is not an
upstream-lifecycle assertion. The response's `expires_at` describes when the
registration expires, not how long the application or upstream credential will
remain usable. The gateway keeps stale mappings until replacement, revocation,
or expiry, returning an upstream-unavailable error while the target is down.
Every successful registration replaces the slot, rotates its generation, and
invalidates its sessions and unfinished login flows. Lathe can revoke a slot it
last registered with `DELETE /previews/registrations/<returned-host-label>`.
No list/read endpoint returns upstream URLs. Maximum 16 active slots per owner.

The POC accepts HTTPS origin URLs only (root path, no query, fragment, userinfo,
or alternate port), under explicitly configured upstream DNS suffixes. This
matches Daytona's signed-hostname URLs. It intentionally does not yet implement
generic path/query bearer URLs. Redirects are never followed server-side.

### Keyed user/agent

`POST /sandbox/expose` accepts `{ "port": 5000 }` with an ordinary BayLeaf user
API key. It resolves the caller's existing, running sandbox, obtains the
port-scoped signed URL internally, and returns the same response format. It
does not start, wake, or launch a service. `DELETE /sandbox/expose/5000` revokes
the caller's slot, including one registered by Lathe. Neither endpoint accepts
Campus Pass, an installation credential, or a browser session as authority.

The keyed API obtains a 24-hour Daytona signed URL and keeps its registration
for 24 hours. Re-exposing refreshes that URL. Lathe can choose a
different upstream lifetime without changing the gateway; omitting `expires_at`
uses the gateway's 24-hour registration policy regardless of that choice.

Both entry points use the same canonical email owner and slot. BayLeaf
explicitly trusts its one Chat installation to assert that identity, so a
registration from either path replaces the previous registration. A future
second installation must receive an explicit namespace/identity policy, not
automatic authority based on matching email text.

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
now receives a fresh origin. Replacing the same owner/slot retires the previous
hostname and closes its sockets. Its service workers, caches, and local storage
cannot control the next origin. The flat hostname works with the existing
single-level wildcard certificate; a nested `{nonce}.{cruzid}` shape would need
additional TLS provisioning and would still be same-site for cookie purposes.

Service workers are allowed on nonce origins. Root-relative
`Service-Worker-Allowed` headers are preserved, supporting root-scoped workers.
Script fetches still require owner authentication; reserved authentication routes
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

Authenticated requests require Fetch Metadata or an exact matching Origin;
legacy browsers that provide neither are denied. Request and response headers
use allowlists. Redirects may only target the same upstream origin or the exact
protected preview origin, are translated to the preview origin, and carry no
upstream response body. Upstream errors become fixed gateway errors. No caching,
upstream error logging, or request/response content storage is introduced.
Application response bodies are streamed unchanged. An application that embeds
its upstream hostname in its body can still disclose that hostname: the actual
Daytona/application combination must pass an echo/absolute-URL containment test
before screen-safe deployment. This is a qualification requirement, not a
claim that header filtering sanitizes arbitrary application content.

## Configuration and retention

- `PREVIEWS_ENABLED` must equal `true`.
- `PREVIEWS_API_ORIGIN`: canonical HTTPS API origin.
- `PREVIEWS_DOMAIN`: isolated preview domain, never a Chat/API parent domain.
- `PREVIEWS_SECRET`: independent 32-byte base64 secret for AES-GCM encryption
  of stored upstream credentials and signing preview sessions.
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
Expired registrations and flows are deleted by the scheduled cleanup; owner
slug mappings persist to prevent origin reassignment. Upstream URLs are encrypted
at rest, but the gateway decrypts them to forward traffic. They are credentials,
not application content. D1 backup retention still applies to deleted ciphertext
and identity metadata. Runtime observability remains disabled.

New active state is bounded to 16 slots per owner and 64 pending login flows per
hostname. Registration bodies are limited to 8 KiB. Upstream HTTP operations
have a five-minute deadline, bounded further by registration expiry. Cloudflare's
platform request/upload limits also apply. This is an initial resource bound,
not per-owner traffic accounting or a guarantee against unauthenticated traffic
exhausting a hostname's pending-login allowance.

WebSocket upgrades require the exact preview Origin and a valid owner session.
A `PreviewConnections` Durable Object per hostname relays frames and owns socket
lifetime. Up to 16 connections per hostname and 4 MiB per frame are allowed.
Establishment has a ten-second timeout which is cleared after the handshake.
Negotiated subprotocols are checked and forwarded; text and binary frames work.

Registration replacement and revocation synchronously invalidate old-generation
connections. A Durable Object alarm closes idle sockets at the earlier of browser
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

`npm run test:previews` passes 24 grouped security checks against the actual
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
Final URLs are `{cruzid}-{nonce}.bayleaf-proxies.dev`: no port, stable alias, or
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
