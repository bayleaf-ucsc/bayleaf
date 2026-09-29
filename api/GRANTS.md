# Temporary inference tokens ✨

Implementation for [issue #76](https://github.com/bayleaf-ucsc/bayleaf/issues/76).
Enabled in production on 2026-09-29 with a one-hour maximum lifetime.
Memorable token names and the integrated dashboard card were deployed with
migration `0012` on 2026-09-29. The revised `llms.txt` distinguishes ordinary
keys, temporary tokens, standard inference, and Sealed.

The follow-up covering all standard-inference backends and the full model
dropdown was deployed on 2026-09-29. No further migration is
required. Backend enablement flags are unchanged.

Verified locally with 18 grant/security checks, the 25 preview regression checks,
TypeScript, and Chrome. Synthetic Vertex/Bedrock inference and final-slot races
against the ordinary key confirm shared limits. Browser checks cover the full
prefixed catalog, disabled-backend labels, alternate-backend selection and
issuance, clipboard copy, and revocation. These are not live provider tests.

## Memorable names and the dashboard

“Temporary inference token” is the user-facing term. A **grant** is the underlying
permission; an ordinary **API key** is the separate, broader account credential.

The main dashboard has a separate Temporary inference tokens card between the
API key and service sections. Creation is in a disclosure; each active token entry
shows its name and expiry on one compact line, with Copy/Revoke alongside.
Restrictions and app details live in the token-name tooltip and accessible label,
so richer restrictions need not expand the list into additional rows.
The creation form loads `/grants/models`, the full standard-inference catalog,
grouped by backend with complete prefixes visible. The recommended model is the
default when available. Disabled backends are identified but cannot be selected;
catalog failures contribute no selectable models. This is not the curated
OpenCode shortlist. Issuance still verifies backend eligibility server-side.
`/grants/manage` redirects to `/dashboard#temporary-inference-tokens`.

Each newly issued token has an automatically generated name such as
`snarky-aardvark-7k3m`. Its wire format is:

```text
sk-bayleaf-grant-snarky-aardvark-7k3m.<signed-payload>.<signature>
```

The name is also in the signed payload and grant row: changing or removing the
readable prefix invalidates the token. The signature, not the name's entropy,
provides authority. The UUID remains the internal identifier used for revocation.
Issuance returns `name`; listing includes it, without returning credentials.

There are 16 adjectives, 16 animals, and a four-character base32 suffix: 28 bits
of random recognition data. A database constraint prevents duplicate names for
one owner among retained grant rows, including concurrent creation; issuance
retries collisions. Expired rows awaiting cleanup also reserve names. Names are
not globally unique, and no historical naming ledger survives row cleanup.

The dashboard displays no part of the secret credential, including no masked
input. Copy buttons use credentials held only in page memory after direct
issuance, until reload or revocation. Tokens created through an app can be named
and revoked on the dashboard, but their credentials cannot be retrieved there.
This display is safe to screen-share with respect to temporary-token credentials;
app names and destinations remain visible. Pasting a copied token can expose it.
Earlier unnamed tokens retain their original validity and show “Earlier token”
with a short grant ID; this change does not force existing clients to reauthorize.

Local verification of this follow-up includes signed-name tampering/stripping,
legacy-token compatibility, per-owner name uniqueness, concurrent issuance,
and a headless Chrome check of full-credential clipboard copy, absence from DOM
and visible text, loss of Copy after reload, and revocation. The embedded
OpenChamber browser denied clipboard access; its error path displayed no secret.

## Terms and authority

- **App / OAuth client:** software asking for access. No durable app registry.
- **Client descriptor:** signed metadata with an exact callback and self-supplied
  display name, valid for ten minutes. Stateless on BayLeaf. Not a developer identity.
- **Authorization transaction:** a ten-minute browser-bound consent attempt;
  after approval the code lasts at most two minutes and is redeemable once.
- **Grant:** one owner's permission to use exactly one backend-qualified standard-inference model
  until a deadline. One grant corresponds to one bearer token. No renewal.
- **Token / temporary key:** a signed credential exercising that grant. It is
  transferable, not cryptographically bound to an app or browser origin.
- **Allowance:** the owner's existing backend-specific budget or request quota,
  shared by all their grants and ordinary API use. Minting grants never creates
  provider budgets or resets request counters.

Direct issuance and visitor authorization produce the same token type. Only
`POST /v1/chat/completions` accepts tokens for all enabled standard backends;
`POST /v1/responses` currently supports OpenRouter only. No model listing,
Sealed, web tools, sandbox, account management, minting, or refresh capability.
Fallback model lists, route overrides, and provider plugins are rejected.
OpenRouter retains its published-weights check on inference. Backend-specific
enablement gates and existing provider policies continue to apply.

### Standard backend scope

Grants store the fully qualified model ID (`openrouter:…`, `vertex:…`, or
`bedrock:…`) and enforce it before routing. A bare OpenRouter slug is accepted
for compatibility and normalized to `openrouter:`. Older grant rows with bare
slugs remain valid. Matching text after different prefixes does not confer the
same authority.

- OpenRouter: existing published-weights eligibility and per-owner provider key.
- Vertex: enabled flag and membership in its supported catalog; existing GCP
  credential and per-user daily request limit.
- Bedrock: enabled flag and membership in its ZDR-capable live catalog; existing
  Bedrock credential and per-user daily request limit. Its existing unresolved
  published-weights/institutional gates still prevent production enablement.

Both alternate-backend counters are updated atomically, shared by the ordinary
API key and all its temporary tokens. Disabling a backend blocks outstanding
tokens immediately. A code exchange also rechecks model eligibility. Sealed is
excluded because BayLeaf cannot inspect its encrypted model field to enforce
one-model authority. Production Vertex and Bedrock remain disabled.

## Direct use

On the API dashboard, open **Create a token** in the **Temporary inference
tokens** card. New tokens have a **Copy token** button beside their public name.
The card lists active tokens from both issuance paths and lets the owner revoke
them individually.

Agents and scripts can use an ordinary personal BayLeaf key:

```http
POST /grants
Authorization: Bearer <ordinary-personal-key>
Content-Type: application/json

{"model":"<backend-qualified model ID>","expires_in":3600}
```

The result contains `grant_id`, `name`, `key` (also `access_token`), `token_type: Bearer`,
`model`, `base_url`, `expires_at` (Unix seconds), and `expires_in`. Copy the token
into the inference client's API-key setting. Do not put it in URLs or logs.

Use `GET /grants` to list your active grants and `DELETE /grants/{grant_id}` to
revoke one. Both require an ordinary personal key or a BayLeaf browser session.
Campus Pass cannot issue grants because it has no personal allowance owner.
Cookie-authenticated mutations require a same-origin `Origin` header.

Lifetime is a positive integer, bounded by `GRANTS_MAX_SECONDS` (default 3600).
An excessive request fails with the actual maximum instead of silently truncating.

## Visitor-funded apps

BayLeaf-specific stateless client onboarding wraps an authorization-code + S256
PKCE handoff. This is not CIMD, dynamic client registration, or a general OAuth
authorization server. The token exchange accepts JSON, not form-encoded OAuth
requests. No client secret or refresh token is issued.

1. Generate a cryptographically random PKCE verifier and random `state`. Keep
   them in the initiating tab's `sessionStorage` during the handoff.
2. `POST /grants/clients` with JSON `client_name` and `redirect_uri`. Save the
   returned `client_id` (an expiring signed descriptor). This writes no database row.
3. Navigate to `/grants/authorize` with query parameters:
   `client_id`, `response_type=code`, `model`, `expires_in`, `state`,
   `code_challenge` (base64url SHA-256 of verifier), `code_challenge_method=S256`.
4. BayLeaf signs the visitor in if needed and shows explicit consent naming the
   account, destination origin, exact callback, model, and duration. App names are
   visibly self-supplied. No remembered app-level consent.
5. BayLeaf redirects to the exact callback with `code` and `state`, or with
   `error=access_denied` and `state`. Check state before proceeding. Remove these
   parameters from the address bar. BayLeaf errors before consent stay on BayLeaf.
6. `POST /grants/token` with JSON:

   ```json
   {
     "grant_type": "authorization_code",
     "code": "<callback code>",
     "client_id": "<same signed descriptor>",
     "redirect_uri": "<same exact callback>",
     "code_verifier": "<original verifier>"
   }
   ```

7. Use `access_token` in the Authorization bearer header. Keep it in memory when
   practical. All grant API responses are `Cache-Control: no-store`. Browser CORS
   allows token exchange and inference without cross-site cookies.

Grant lifetime starts at approval, not redemption. The descriptor must be valid
when starting authorization; its subsequent expiry does not invalidate the
already-created transaction. A new authorization in the same browser supersedes
the browser proof for the previous flow: restart that tab's flow if needed.

### Local development

Callbacks support HTTPS, or HTTP with exactly `localhost`, `127.0.0.1`, or `[::1]`.
No public metadata hosting, TLS certificate, or tunnel is needed. The user's
browser follows the redirect; BayLeaf never fetches the callback.

Use an explicit path, for example `http://localhost:5173/`, and preserve its exact
spelling and port. These three hosts are different browser origins. Arbitrary
loopback aliases, numeric address tricks, userinfo, fragments, URL normalization,
and callback query parameters named `code`, `state`, or `error` are rejected.
An IPv6 listener may need separate configuration from an IPv4 listener.

Run the [single-file browser example](examples/grants/index.html):

```sh
python3 -m http.server 5173 --bind 127.0.0.1 --directory api/examples/grants
```

Open `http://127.0.0.1:5173/`. Choose the API origin (production by default),
load the recommended model, and authorize. The example
implements state validation, PKCE, denial, masked/no-display token handling, and
manual reauthorization after a 401. A page reload forgets the token.

### Expiry and errors

Expired tokens receive `401`, `WWW-Authenticate: Bearer error="invalid_token"`, and
JSON `error.code: "token_expired"`. This works even after cleanup removes the grant
row because the token's expiry is signed. Revoked, forged, or otherwise invalid
tokens receive `401 invalid_token`. The header is exposed to browser JavaScript.

Wrong-model or out-of-scope requests receive `403 insufficient_scope`. Offer a
manual authorization action after a 401; do not build an automatic redirect loop.
Fresh approval creates a new grant, rather than silently refreshing the old one.
Expiry/revocation prevents new requests; it does not abort an in-flight completion.

## Storage and operation

`inference_grants` holds ID, owner email, owner-key fingerprint, model, timestamps,
and optional app name/callback. Tokens are signed using purpose-separated HMAC;
the signature is the credential verifier, not a stored plaintext secret. Tokens
cannot be used as login cookies, client descriptors, or consent proofs.

`grant_transactions` holds browser-proof and code hashes, PKCE challenge, app
metadata, state, and (after approval) owner-key fingerprint and grant deadline.
Neither table stores inference content. The existing hourly scheduler deletes
expired transactions and grants when enabled, so expiry leaves at most an hour's
cleanup lag. Revocation deletes a grant immediately. There is no extra per-grant
spend ledger. Existing provider accounting remains authoritative.

An owner-key fingerprint prevents outstanding grants and approved transactions
from reviving after the owner's normal API key is revoked and reissued. No upstream
key is created by issuance; inference uses each backend's normal credential and
account-limit path. OpenRouter uses its existing per-owner provisioning/healing code.

### Rollout and rollback

1. Run `npm run test:grants`, `npm run test:previews`, and `npx tsc --noEmit`.
2. Apply D1 migrations through `0012` before deploying the named-token revision.
   Initial enablement also requires `GRANTS_ENABLED=true`.
3. Verify real campus login, direct dashboard issuance, and a local callback with
   a small real inference request. Local synthetic tests do not verify live OIDC.
4. Disable `GRANTS_ENABLED` and deploy to stop new issuance and token use. Cleanup
   also pauses while disabled. Re-enabling restores unexpired, unrevoked grants.

The OpenAPI document includes issuance, listing, revocation, descriptor issuance,
and code exchange. This guide describes the browser authorization endpoint.

### Local verification (2026-09-29)

The workerd/D1 grant harness verifies both issuance paths, concurrent one-time
redemption, expiry, revocation, owner rotation, scope/model restrictions, cookie
CSRF, callback validation, and cleanup with synthetic accounts and upstreams.
The existing 25 preview security checks also pass. An actual browser completed
local app → consent → local callback → token exchange → synthetic inference,
and created a masked token on the management page. Revocation and the management
layout were also checked at mobile width. Browser testing caught and
fixed a `no-referrer` policy that suppressed the consent form's `Origin` header.
The full fresh CILogon handoff and real inference through a disposable token
have not yet been qualified in production.

### Production rollout (2026-09-29)

Applied migration `0011` to `bayleaf-keys` and deployed Worker version
`1689e9c9-2973-4de2-a2ba-d77795a999b1` with `GRANTS_ENABLED=true` and a 3600-second
maximum. Previous version: `b996b095-a72c-423c-8a06-9b66f399c875`.
Live health, OpenAPI, enabled `llms.txt`, all three loopback descriptor forms,
and unsafe-HTTP callback rejection passed. Using an existing signed-in browser
session, the dashboard displayed the feature and created/revoked a 60-second
token for the recommended model. No real inference was requested in this smoke
check. No commit or push accompanied this deployment; GitHub-hosted guide and
privacy changes remain local pending publication.

Named-token revision: migration `0012` applied and Worker version
`2b03bf25-c926-409e-9df9-5945d597d507` deployed on 2026-09-29. Verified the live
integrated card, three-model dropdown, compact named-token row, and creation and
revocation of a 60-second token. `llms.txt` remains unchanged from initial rollout.
