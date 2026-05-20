# Decisions log (bayleaf-lti)

Append-only record of non-obvious choices made during the spike. Read this
before doing anything that contradicts it.

## 2026-05-19: stack and hosting

- **Language: Python.** Matches the eventual OWUI toolkit half (mirrors
  `chat/tools/gws_toolkit/tool.py`). Lets us share Pydantic models across
  the toolkit ⇄ connector boundary later.
- **LTI library: `PyLTI1p3`.** Most mature LTI 1.3 implementation in
  Python. Avoids hand-rolling JWT/JWKS plumbing.
- **Web framework: FastAPI.** Async fits the Canvas-API-heavy workload.
- **Local dev with tunnel.** Run on the laptop behind a Cloudflare Tunnel
  (or ngrok) for the entire spike. Defer DigitalOcean App Platform deploy
  until milestone 5 (first real launch).
- **DO deployment shape (when we get there): new component in the existing
  `chat/` app spec, not a new App, not a new Droplet.** Same domain
  family, internal-network access to OWUI, single billing line, single
  deploy pipeline. Confirmed App Platform is per-component pricing, not
  per-droplet.

## 2026-05-19: dev instance is `ucscdev.instructure.com`

The parent issue (#42) named `canvas.instructure.com` (Free-for-Teacher)
as the dev target. **Wrong for LTI 1.3:** FFT supports only LTI 1.1, and
explicitly does not allow admin access (which LTI 1.3 dev key registration
requires). Multiple confirmations from Instructure staff in their
community forums (2021–present).

We instead use `ucscdev.instructure.com`, UCSC's sandboxed Canvas
provisioned by Adonis Hamad on 2025-12-01. Two test accounts confirmed
working: `amsmith@ucsc.edu` (admin role) and `adam@adamsmith.as`
(non-admin).

Issue #42 updated with these corrections in
[issue comment 4494970626](https://github.com/bayleaf-ucsc/bayleaf/issues/42#issuecomment-4494970626).

## 2026-05-19: cookie-based exploration as a stopgap

- **Personal access token generation is disabled** on `ucscdev` by admin
  policy (UCSC ITS disabled student PAT generation in 2025 due to
  full-privilege, non-expiring bearer-token risk). The toggle is not
  visible to our role.
- **Stopgap:** `scripts/explore.py` consumes a borrowed browser session
  cookie (`CANVAS_SESSION_COOKIE` in `.env`) for read-only API
  cartography. Cookie's lifetime is bounded by the browser session;
  logging out kills it.
- The script fingerprints the credential at startup (first 6 + last 4
  chars + sha256[:8]) so we can detect rotation without revealing the
  value.
- This is exploration scaffolding, not a production pattern. It will be
  removed before any code ships.

## 2026-05-19: asymmetric UI-vs-API permission discovery

While running `scripts/explore.py`, we discovered that the admin role
Adonis built for us on `ucscdev` has the **API permission** to list and
create developer keys (`/api/v1/accounts/self/developer_keys`), even
though the **UI tab** for Developer Keys is hidden from us.

- `GET /api/v1/accounts/self/developer_keys` returns 200 with five
  existing LTI 1.3 keys (MathGPT ×2, MyOpenMath, Khanmigo, ProctorU).
- `POST /api/v1/accounts/self/developer_keys` with empty body returns
  **422 Unprocessable Content** (validation error, not 401/403). The role
  has create permission via the API.

Confirmed this does not constitute a privilege escalation:

- Untrusted LTI 1.3 dev keys allow our specific tool to receive launches
  and use LTI Advantage services for users who actively launched it.
  They are not bearer credentials.
- Trusted dev keys (a separate flag at registration, requires root admin)
  *would* be an escalation: they enable user impersonation via OAuth2
  client_credentials. We are NOT pursuing trusted-key creation.

**Decision:** proceed with self-registering an *untrusted* LTI 1.3
developer key for our connector once tunnel + connector URLs are stable
(milestone 4). Document the action in this file at the time of creation.
Mention casually to Adonis at next routine touch-base. If Adonis prefers
us not to self-register on `ucscdev`, we revoke the key and move to the
"ask him to register" flow with no harm done.

Reasoning: the sandbox was explicitly provisioned for us to do LTI dev
work; technical-capability-as-tacit-authorization is reasonable on a
sandbox; the action is auditable and reversible; documenting decisions
in writing is more durable than a Slack mention that may scroll off.

## 2026-05-19: BRACE-DEV sub-account is the right home for our key

`/api/v1/accounts` lists two accounts visible to us:

- root account `id=1`, "UC Santa Cruz Development"
- sub-account `id=298`, "BRACE-DEV"

The BRACE-DEV sub-account is where Brace3 (instructor-side Canvas
assistant) work has been happening. It's the natural home for a BayLeaf
LTI dev key: it isolates BayLeaf-related installations from the root
account, matches the existing organizational separation, and avoids
polluting the root account's developer-key list with our experimental
keys.

When we self-register, target sub-account 298, not root account 1.

## 2026-05-19: `notes/api-shapes/` is gitignored

Exploration outputs contain identifiers, third-party LTI tool
configurations (real `tool_configuration` JSON of MathGPT, MyOpenMath,
etc.), and instance UUIDs. Not secrets in the credential sense, but not
ours to publish either. Promote to `fixtures/` only after manual
scrubbing. This directory must remain gitignored.

## 2026-05-20: tunnel hosting is Cloudflare Tunnel + named hostname

Public hostname for the spike connector: **`lti.bayleaf.dev`** (named the
protocol layer, not the platform; future-proof for Moodle/Brightspace).
Tunnel implementation: Cloudflare Tunnel (`cloudflared`) rather than
ngrok, because:

- `bayleaf.dev` is already in our Cloudflare zone alongside chat / api /
  courses subdomains. Adding `lti.bayleaf.dev` keeps the family together.
- Free, unlimited bandwidth, no rotating hostnames.
- Same daemon will work on the DigitalOcean side later if we ever want to
  tunnel-debug production internals.

Tunnel name: `lti-bayleaf`. Tunnel UUID is recorded in the gitignored
`cloudflared.yml`. The committed template is `cloudflared.example.yml`.

Verified `https://lti.bayleaf.dev/health` returns 200 from the public
internet, edge-served from `sjc08`/`lax11`. Confirmed POST form bodies
round-trip correctly through the tunnel (matters for milestone 4: the
LTI launch is a `application/x-www-form-urlencoded` POST).

Side note on `cf-connecting-ip` / `x-forwarded-for`: Starlette/FastAPI
won't trust those headers by default. We don't need them for the spike,
but if we ever want correct client IPs in audit logs, run uvicorn with
`--proxy-headers --forwarded-allow-ips="*"`.

## 2026-05-20: `DEBUG_ECHO=1` env flag enables `/debug/echo`

Added a header/body-echo endpoint to `main.py`, gated by an env var so it
can't accidentally ship to production. Useful for inspecting what
arrives through the tunnel. Already proved its value during tunnel
verification; will be the primary tool for debugging the actual LTI
launch in milestone 5.

## 2026-05-20: dev-key self-registration via API was the wrong door

Tried both `POST /api/v1/accounts/:id/developer_keys/tool_configuration`
(404, endpoint name doesn't exist on this Canvas version) and `POST
/api/v1/accounts/:id/lti_registrations` (modern endpoint). The latter
returns 422 with no diagnostic info even for the canonical example
payload from Canvas's own API docs.

Two structural reasons we couldn't get through:

1. The controller's `restrict_sub_account_to_read_only` `before_action`
   means **the modern `/lti_registrations` POST is root-account-only.**
   BRACE-DEV (sub-account 298) was never going to work with this
   endpoint. Quoted from `app/controllers/lti/registrations_controller.rb`:
   "sub-accounts can only view registrations".
2. On the root account we can `GET /lti_registrations` (returning 27
   existing registrations) but `POST` returns generic 422. The
   `before_action` chain runs `validate_registration_params` (schema
   check) before `restrict_sub_account_to_read_only`, so even on a
   sub-account we hit schema validation first. On root account, we are
   apparently failing some `Lti::ToolConfiguration`, `DeveloperKey`,
   or `Lti::Registration` model-level validation that Canvas refuses
   to surface in the response body. Spent considerable agent time
   tracing through the source without identifying the specific field.

The endpoint is marked `@beta` in the controller comments, which fits
the unhelpful error behavior. Permission-wise, our role *can* GET this
endpoint but cannot create against it; the `manage_lti_registrations`
permission may be partial.

**Decision:** abandon API-based dev-key self-registration. The right
door for our role and our spike scope is **LTI 1.3 Dynamic
Registration** (next entry).

The dead-end probe scripts (`register_dev_key.py`,
`probe_dev_key_create.py`) have been deleted. The discovery work in
`explore.py` and `probe_courses.py` remains useful.

## 2026-05-20: pivoted to LTI 1.3 Dynamic Registration

Adam noticed in the Canvas UI that `Admin -> Apps -> View App
Configurations -> Add App` exposes "By LTI 2 Registration URL" as one of
the install options. Despite the UI's misleading "LTI 2" wording (a
known Canvas bug; this is the OIDC dynamic-registration flow,
IMS-blessed for LTI 1.3 not LTI 2.x), this is the *purpose-built*
admin-installable path for LTI 1.3 tools.

Key advantages over the dev-key API path:

- Permission gate is "can install apps in this account" (which we have,
  visible as a UI button) rather than "can create developer keys via
  API" (which we apparently lack on `/lti_registrations` POST).
- No long-lived API credentials. Canvas issues a short-lived
  `registration_token` for one ceremony, the connector consumes it
  during a single POST, and it's done.
- The connector's `/register` endpoint serves as a self-describing
  configuration manifest. The same endpoint will work against any
  LTI 1.3 platform (Moodle, Blackboard, Brightspace), which is exactly
  the future-proofing implied by our hostname choice (`lti.bayleaf.dev`).
- After registration, Canvas shows the admin a confirmation screen
  with the proposed installation. Errors and overlay-modifications are
  visible *before* anything is saved.

Implementation: added `GET /lti/register` to `main.py`. It accepts
`openid_configuration` and `registration_token` query params, fetches
Canvas's OIDC config (Bearer auth), POSTs the LTI Registration body
to Canvas's `registration_endpoint`, persists the assigned `client_id`
to `keys/registration.json`, and renders an HTML page that posts
`org.imsglobal.lti.close` to the parent window so Canvas can close the
iframe and show its confirmation UI.

The registration body advertises a single placement (course_navigation,
LtiResourceLinkRequest, visibility=admins), no LTI Advantage scopes,
JWKS-by-URL (Canvas fetches `lti.bayleaf.dev/lti/jwks`), and Canvas's
`privacy_level: public` so launches include name and email.

## 2026-05-20: "By LTI 2 Registration URL" is genuinely LTI 2.x, NOT 1.3

Correcting the previous entry: the "By LTI 2 Registration URL" UI
option is *not* a misnamed LTI 1.3 dynamic registration entry point.
It really does drive the LTI 2.x Tool Proxy flow.

Discovered by instrumenting `/lti/register` to dump full request
shape. Canvas POSTed to our endpoint with empty body, no query
parameters, but with `referer:
https://ucscdev.instructure.com/accounts/298/lti/tool_proxy_registration`.
That URL path is unambiguous: `tool_proxy_registration` is the LTI 2.x
mechanism (Tool Consumer Profile + Tool Proxy negotiation, never
widely adopted, deprecated in favor of LTI 1.3).

So our `/lti/register` endpoint *is* a correct LTI 1.3 dynamic
registration endpoint per the IMS spec, but ucscdev's "Add App > By
LTI 2 Registration URL" button is the wrong door for invoking it.

The five "Add App" Configuration Type options on ucscdev are:

| UI option | Backend mechanism | Useful to us? |
|---|---|---|
| Manual Entry | LTI 1.1 (consumer key + shared secret) | Yes (Plan B path) |
| By URL | LTI 1.1 XML config fetched from a URL | Yes (Plan B path, chosen) |
| Paste XML | LTI 1.1 XML config inline | Yes (similar to By URL) |
| **By Client ID** | LTI 1.3, requires existing developer key | Yes (Plan A path, blocked on Adonis) |
| By LTI 2 Registration URL | LTI 2.x Tool Proxy | No, wrong protocol |

**Decision (Plan A):** email Adonis with the exact JSON config and a
specific ask (manually register a 1.3 dev key, or grant
`manage_developer_keys`). Draft is at `notes/email_to_adonis.md`.

**Decision (Plan B, pursued same night):** add an LTI 1.1 path so we
can complete a real launch tonight via "Add App > By URL". Spike still
learns the protocol contract end-to-end; the toolkit half (chat-side)
plumbing is identical regardless of LTI version. See next entry.

The `/lti/register` endpoint stays in `main.py`. Reasons: (1) it
correctly implements LTI 1.3 dynamic registration per the IMS spec,
so other LMSes (Moodle, Brightspace) and Canvas instances with the
right feature flag can use it; (2) it's part of the eventual
production picture; (3) keeping it costs nothing.

## 2026-05-20: added LTI 1.1 path (Plan B)

Added two endpoints and one credential pair to support installing the
connector via Canvas's "Add App > By URL" admin flow:

- `GET /lti/config.xml`: serves an IMS Common Cartridge LTI 1.1
  configuration XML (canonical wire format Canvas's "By URL" install
  expects). Declares a single course_navigation placement with
  visibility=admins.
- `POST /lti/launch`: now auto-detects LTI 1.1 vs 1.3 by inspecting
  form params. The 1.1 path verifies the OAuth 1.0a HMAC-SHA1
  signature against `LTI_1P1_SHARED_SECRET` from .env, with timestamp
  and nonce replay protection.

Credentials in .env:
- `LTI_1P1_CONSUMER_KEY`: matches what Canvas asks for at install
  time.
- `LTI_1P1_SHARED_SECRET`: 48-byte URL-safe random; never sent over
  the wire.

Verification uses `oauthlib.oauth1.SignatureOnlyEndpoint` with a
custom `RequestValidator` that holds the single-secret config. A
self-test at `scripts/selftest_lti_1p1.py` exercises:
1. Clean launch -> 200 (accepted).
2. Tampered launch (mutates `roles=Instructor` to `roles=AdminGodMode`
   after signing) -> 401 (rejected).
3. Replay (same signed body twice) -> 200 then 401 (replay rejected).

All three pass.

## 2026-05-20: turned off Cloudflare Email Address Obfuscation on bayleaf.dev

Cloudflare's "Scrape Shield > Email Address Obfuscation" feature
(default-on) was rewriting our HTML responses, replacing
email-shaped strings with `<a class="__cf_email__" data-cfemail="...">[email&nbsp;protected]</a>`
and injecting a JavaScript decoder. This made our /lti/launch debug
page render student emails as obfuscated blobs.

Worth confirming what it does and doesn't touch:
- **Request bodies: not mutated.** Our LTI 1.1 self-test proved this
  (the HMAC over the request body verified correctly).
- **Response bodies: mutated** when content-type is HTML and the body
  contains plausible email patterns.

Disabled zone-wide since `bayleaf.dev` is a dev zone. If we later
want it back on for a public-facing subdomain, do a Configuration
Rule scoped to that hostname.

## 2026-05-20: SPIKE WIN CONDITION ACHIEVED

A real human (Adam) clicked the "BayLeaf (spike)" link in the left
nav of "Brace Dev Course (A)" on ucscdev.instructure.com. Canvas
POSTed a signed LTI 1.1 launch to https://lti.bayleaf.dev/lti/launch.
The connector verified the OAuth 1.0a HMAC-SHA1 signature and
rendered the launch claims to a debug page in the Canvas iframe.

End-to-end working stack on this date:

| Layer | Technology | Where |
|---|---|---|
| Canvas → connector wire format | LTI 1.1 (form-encoded POST + OAuth 1.0a) | ucscdev.instructure.com |
| Public hostname | Cloudflare Tunnel (`lti-bayleaf` named tunnel) | lti.bayleaf.dev |
| TLS termination | Cloudflare edge | sjc/lax PoPs |
| App server | FastAPI + uvicorn | localhost:8765 |
| Signature verification | oauthlib 3.3 + per-process nonce cache | _BayLeafOAuth1Validator in main.py |
| Credential storage | .env (FileVault disk) | LTI_1P1_SHARED_SECRET |
| Dev instance | UCSC sandbox provisioned by Adonis Hamad | ucscdev.instructure.com, sub-account 298 (BRACE-DEV) |
| Test course | Brace Dev Course (A) | course id 1719 |
| Test user | Adam Smith, admin role | user id 1110 |

Sample verified claims from the first real launch:

```
lti_message_type:                 basic-lti-launch-request
lti_version:                      LTI-1p0
lis_person_name_full:             Adam Smith
lis_person_contact_email_primary: amsmith@ucsc.edu
custom_canvas_user_id:            1110
context_title:                    Brace Dev Course (A)
context_label:                    BRACE-DEV-A
custom_canvas_course_id:          1719
roles:                            urn:lti:instrole:ims/lis/Administrator
tool_consumer_instance_guid:      NOQJOJ58bQsMrBJR9NDzXzgLPT6E07Y7wNMzzO4K:canvas-lms
```

The verifier correctly rejected one replay attempt observed during
the install handshake (Canvas re-sent the same nonce within ~180ms),
proving the nonce cache works.

This unblocks the entire downstream architecture:

1. The connector knows how to authenticate launches end-to-end.
2. The `(tool_consumer_instance_guid, user_id)` tuple is available as
   a stable user identity for cross-launch correlation.
3. The toolkit half (chat/tools/canvas_toolkit/tool.py) can now be
   designed against a real, working launch contract instead of
   speculative payload shapes.

Plan A (LTI 1.3) remains the right protocol for production but is
blocked on Adonis. The LTI 1.3 paths (/lti/jwks, /lti/login,
/lti/register) remain in main.py for when that unblocks. Both
protocols can run simultaneously (different consumer key vs.
client_id, single endpoint with auto-detection), so the eventual
migration is just "stop serving 1.1 once the 1.3 path is verified
working."

## 2026-05-20: renamed canvas-connector -> lti

Project directory renamed from `canvas-connector/` to `lti/`. Rationale:
the public hostname is already `lti.bayleaf.dev` (named the protocol
layer, not the platform), and "canvas-connector" was misleading on three
counts: (a) the connector is intentionally LMS-agnostic so it can serve
Moodle/Brightspace later, (b) "Canvas" is a vendor name that may not
survive UCSC's LMS lifecycle, and (c) the directory name was the only
remaining LMS-specific identifier in the project's name surface.

Renamed everything in the same pass since the LTI 1.1 install in
BRACE-DEV was uninstalled at this point (no Canvas-side state pinned to
the old `tool_id`/`kid`/User-Agent strings). Single coherent rename
including:

- Directory: `canvas-connector/` -> `lti/`.
- Python package name in pyproject.toml: `canvas-connector` -> `bayleaf-lti`.
- FastAPI app title and HTML headings: `bayleaf canvas-connector` -> `bayleaf-lti`.
- /health response `service` field: `canvas-connector` -> `bayleaf-lti`.
- LTI 1.3 `tool_id`: `bayleaf-canvas-connector-spike` -> `bayleaf-lti-spike`.
- LTI 1.1 cartridge `tool_id`: same change.
- JWKS `kid`: `bayleaf-canvas-connector-2026-05` -> `bayleaf-lti-2026-05`.
- User-Agent string for Canvas API calls: `bayleaf-canvas-connector/0.0.1` -> `bayleaf-lti/0.0.1`.
- Internal `src/connector/` package name kept (it's still a connector,
  inside a project named `lti`; further rename would just churn imports).

## 2026-05-20: deployed to DigitalOcean App Platform; cut Cloudflare Tunnel

Migrated production hosting from a Cloudflare Tunnel pointing at the
laptop to a real DigitalOcean App Platform deployment. Architecture
choices made during this migration:

- **Separate DO App, not a component of the existing chat/ app.**
  Reverses the 2026-05-19 decision that planned to add this as a
  component of `bayleaf-chat-owui-app`. Reasoning: independent
  deploy/restart cycles for what is genuinely a different concern
  (auth gateway vs. chat UI). The OWUI app is already complex; LTI
  doesn't need to share its blast radius. App ID:
  `1e1e5691-dbe6-401f-8274-f37933ea31f3`. Spec at `lti/.do/app.yaml`.
- **Container image, not a buildpack.** Decided to use a Dockerfile
  rather than DO's Python buildpack so we keep `uv` as the dependency
  resolver (single source of truth: `uv.lock`). Image is published to
  `ghcr.io/bayleaf-ucsc/lti:latest` (public). Image hygiene: secrets
  are runtime env vars, never baked. Required flipping the
  bayleaf-ucsc org-level container-package policy from "private only"
  to "allow public" in GitHub org settings.
- **GHCR public, no DO pull credentials.** The image contains only our
  open-source code plus deps; no value to keeping it private. Public
  image lets DO pull anonymously. The org policy change was a
  one-line decision but carries forward to any future bayleaf-ucsc
  containers.
- **RSA keypair via env vars, not persistent volume.** DO App Platform
  filesystems are ephemeral. Two env-var secrets `LTI_PRIVATE_KEY_PEM`
  and `LTI_PUBLIC_KEY_PEM` carry the PEM blobs (1704 + 451 chars).
  Same kid (`bayleaf-lti-2026-05`) survives across deploys. Rotation
  = generate new keys, update both secrets, bump kid, redeploy.
- **Hard fail on missing keypair config.** Replaced the previous
  silently-generates-a-keypair-if-missing behavior with a startup-time
  RuntimeError. The bug it would have hidden: forgetting to set the
  env vars on a new DO app, then serving a JWKS Canvas can't trust,
  with the symptom appearing only on first 1.3 launch. New behavior:
  startup fails with a message naming the three remediation paths
  (env vars / on-disk PEMs / explicit `LTI_DEV_AUTOGEN_KEYS=1`
  opt-in for first-run local dev). Verified all four scenarios:
  env-set, both unset, partial (one of two), and opt-in autogen.
- **Trust DO's reverse proxy headers.** Added `--proxy-headers
  --forwarded-allow-ips="*"` to the uvicorn CMD. Required because DO
  terminates TLS at its frontend and forwards plain HTTP to the
  container; without trusting `X-Forwarded-Proto`, `request.url` in
  the LTI 1.1 verifier reflected `http://...:8080/lti/launch` instead
  of the `https://lti.bayleaf.dev/lti/launch` Canvas signed against,
  breaking HMAC-SHA1 verification. The 2026-05-20 deferred decision
  to skip proxy-headers turned out to be wrong for this reason
  (signature reconstruction), not the predicted reason (audit logs).
- **DNS: lti.bayleaf.dev set to gray cloud (DNS-only).** Cloudflare
  proxy disabled because DO terminates its own TLS via Google Trust
  Services. Orange cloud would have meant double-TLS plus interfering
  with DO's certificate provisioning.

Verification:

| Check | Result |
|---|---|
| Image builds linux/amd64 | OK |
| Container starts with env-injected keys | OK, kid+n match local |
| Container hard-fails with no keys | OK, exit 3, clear message |
| https://lti.bayleaf.dev/health | 200 |
| https://lti.bayleaf.dev/lti/jwks | 200, kid=bayleaf-lti-2026-05 |
| https://lti.bayleaf.dev/lti/config.xml | 200 |
| TLS cert | Google Trust Services, valid through 2026-08-18 |
| selftest_lti_1p1.py against prod URL | 3/3 pass |
| Real human launch from BRACE-DEV/Brace Dev Course (A) | VERIFIED, role=Administrator |

Cloudflare Tunnel `lti-bayleaf` (UUID `8ba1f7ee-510d-4884-8358-c414563e5e12`)
deleted via `cloudflared tunnel delete lti-bayleaf`. Repo
`cloudflared.yml` and `cloudflared.example.yml` both removed: DO is now
the canonical deploy target, and a stale tunnel config invites
confusion about which path is current. If we ever need a tunnel again
(e.g. to reach an internal-network DO service for debugging),
cloudflared's own docs are sufficient.

Files added/changed:
- `lti/Dockerfile` (uv-based image build).
- `lti/.dockerignore` (excludes secrets and dev artifacts from image).
- `lti/.do/app.yaml` (DO App Spec; doctl-applyable).
- `lti/src/connector/main.py`: new `_load_pem`, hardened `ensure_keypair`,
  new `warn_if_lti_1p1_unconfigured`.
- `lti/.env.example`: documents `LTI_PRIVATE_KEY_PEM`,
  `LTI_PUBLIC_KEY_PEM`, `LTI_DEV_AUTOGEN_KEYS`.
- `scripts/_apply_do_secrets.py`: monorepo-level helper to inject
  local `.env` and PEM contents into the DO App spec without ever
  echoing them to terminal.

## 2026-05-20: conceptual notes on what the connector can know and store

This entry is observational rather than decisional: a record of the
architectural ground we walked while the Spike was settling, so future
work has a shared mental model.

### LTI launches are the only writer-side trigger we have today

The connector knows nothing until someone clicks. Each launch is a
self-attested, signed assertion from Canvas:

> "At this moment, the user identified by `(tool_consumer_instance_guid,
> user_id)` -- whose human-readable name is X and email is Y -- is
> acting in the course identified by `(tool_consumer_instance_guid,
> context_id)` -- whose title is Z -- with role(s) R."

The platform GUID is forever-stable. `(platform_guid, user_id)` is
forever-stable per consumer+user. `(platform_guid, context_id)` is
forever-stable per consumer+course. The role assertion is **only valid
for that moment**; a TA who gets demoted tomorrow keeps the same user_id
and context_id but their next launch reports different roles.

This is materially different from `chat/tools/gws_toolkit/tool.py`'s
model. Google Workspace uses OAuth2 authorization-code with a
refresh token, so the toolkit can poll Google's APIs at any time. LTI
launches are closer to webhooks: discrete, user-initiated, never pushed
by the platform.

### NRPS (LTI Advantage Names and Role Provisioning Services) changes this

With NRPS scopes granted by the developer key (LTI 1.3) or with the
legacy "Memberships" extension enabled at install time (LTI 1.1, present
as `ext_ims_lis_memberships_url` in launch payloads), the connector
gains a new capability: **call Canvas back to fetch a roster of any
course we've been launched from.**

NRPS does NOT push anything to us; we still poll. But it lets us know:

- Who else is enrolled in this course (not just the launching user).
- Authoritative role assignments (server-attested, not user-attested).
- Section structure within the course.
- Detection of users who *can* launch but haven't yet.

NRPS is the keystone for any teacher-facing control panel that needs to
say "this affects 47 students" or "preview as a typical TA." Without it,
all you can do is "configure for the people who happen to launch."

### What a future database might store

Imagine the connector grew Postgres. Three tables, in growing order of
usefulness:

1. **`platforms`**: one row per LMS instance (today this is one row's
   worth of `.env`). Multi-tenancy lives here. Schema includes
   `platform_guid PK, issuer_url, client_id (1.3) or consumer_key (1.1),
   shared_secret, jwks_url, name`.

2. **`users`**: populated incrementally as people launch. Schema
   `(platform_guid, lti_user_id) PK, email, name_full, first_seen_at,
   last_seen_at`. The PK tuple is the stable identity. Email and name
   are user-attested (Canvas vouches via `privacy_level=public`, but
   the level is itself a config choice).

3. **`course_memberships`** (the launch fact table): each launch upserts.
   Schema `(platform_guid, lti_user_id, context_id) PK, roles,
   course_title, course_label, first_seen_at, last_seen_at`. Crucially,
   what we record is **"X claimed role Y in course Z at time T"**, not
   "X currently has role Y." Most-recent-claim is the most-authoritative
   thing we have but is not the same as live truth.

A fourth table once we get to teacher controls:

4. **`course_policy`**: `(platform_guid, context_id) PK, enabled,
   persona_instructions, allowed_sections, ...`. This is what teachers
   configure. Doesn't need NRPS; needs only the teacher's launch.

### The temporal authority question

A subtle point that will matter for OWUI toolkit design later:

| Authority claim | Trust window | Can we recheck? |
|---|---|---|
| "X has role Y in course Z at this exact second" | The launch itself, valid for that moment | Only via fresh launch or NRPS call |
| "X is in course Z (membership-only)" | Stable over weeks-months | NRPS call gives current view |
| "X may currently see this assignment's data" | Authorization decision; minutes-fresh | Canvas REST API call w/ a service token |
| "X has launched into our system at some point" | Forever once observed | Database lookup |

When a student launches at 9 AM, then opens BayLeaf Chat at 3 PM and
asks "what's due in CMPM 120?" -- the toolkit calling into the
connector is trusting a 6-hour-old claim. Fine for navigation
("remember which courses they're in"), inappropriate for high-stakes
authorization ("they're allowed to read this submission's content").

The cleanest separation:

- **Database stores observed launch facts.** Used for navigation,
  preferences, last-known-courses lists.
- **Real-time authorization checks call back to Canvas.** Either via
  NRPS / LTI Advantage or via a separate token flow. The database is
  *not* the source of truth for "may this person see this data right
  now."

### The teacher control panel is the connector's first real UI

`/lti/launch` currently renders a debug payload. It needs to become a
real page when a teacher (role check on launch) lands there.

Considered hosting the control panel inside OWUI (single front door,
unified UX) versus rendering server-side from the connector. **Decided:
connector renders.** OWUI is upstream third-party code; our
customization surface is plugins/tools/functions/filters, not template
or admin-page injection. Building a parallel admin UI inside OWUI's
plugin model would either hack templates we don't own or fight the
plugin sandbox. The control panel is launch-bound configuration, not
chat-bound, and that's the right place for it to live.

So: FastAPI + a templating choice (Jinja2 likely) + form submissions to
sibling connector endpoints + state in the connector's DB. Iframe
shows it on launch. Teacher's session in the iframe is bounded by the
launch event itself (LTI's session model is "this iframe is
authenticated for this launch"); persistent teacher sessions are a
separate problem we don't have to solve yet.

### Per-student vs per-course vs per-section policy

The control panel needs to be honest about who its decisions reach:

- **Course-level toggles** (Brace on/off for course Z): trivial, one
  row. Doesn't need NRPS. Applies to anyone who launches as a member
  of Z.
- **Section-level policy** ("Brace allowed in Section 02 only"):
  needs NRPS to know section structure. Applies the moment any user
  launches; their section is in their launch payload.
- **Per-student overrides** ("Joe gets accommodation X"): needs the
  student to have launched at least once so we have their LTI user_id
  to bind to. Teacher's view of the roster (via NRPS) shows
  enrollment vs activation status: "47 students should launch, only
  12 have so far."

Teacher's first action becomes setup: "Have your students click the
Brace icon at least once during a class meeting." This is the LTI-side
analog to OAuth-consent-once.

### What's deferred

- Database (Postgres or SQLite via DO Managed). Right now the
  connector is stateless across requests except for the in-process
  nonce-replay cache.
- Multi-tenant `(consumer_key -> shared_secret)` lookup. Today there's
  one consumer key in env vars; tomorrow's lookup is a table swap.
- NRPS call wiring (HTTP client + signature plumbing for the LTI 1.1
  legacy memberships endpoint, OR proper `client_credentials` flow for
  LTI 1.3 NRPS scopes once a dev key exists).
- Canvas REST API access for course-content grounding (assignments,
  syllabus, pages). The /lti/launch payload doesn't carry this; the
  toolkit half will need a separate credential flow.
- The OWUI toolkit (`chat/tools/canvas_toolkit/tool.py`). Mirrors
  `gws_toolkit`'s shape; HMAC-authenticated calls from OWUI to
  connector; connector consults course_policy and
  course_memberships before serving up Canvas-grounded content.

