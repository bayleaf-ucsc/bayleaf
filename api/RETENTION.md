# Data Retention: BayLeaf API

What `api.bayleaf.dev` stores, where, and for how long.

This service is the platform's **zero-operator-access (ZOA) target**, in the
sense of the [AWS Mantle design](https://aws.amazon.com/blogs/machine-learning/exploring-the-zero-operator-access-design-of-mantle/):
it retains no prompt or completion content, and exposes no operator interface to
read request content in flight (no request-body logging, Workers Observability
disabled, no interactive shell into the runtime). The only operator-observable
signal is request metadata. This is a strong ZOA *posture*, not a
hardware-attested ZOA *guarantee*: there is no signed-deploy/attestation barrier,
so an operator with deploy rights could in principle ship a content-logging
revision. We commit not to, and treat any such change as material.

---

## Plaintext OpenRouter Traffic

**Not stored, not logged, not observable in flight.** Requests and responses are
streamed through to the upstream provider with zero local caching and are never
written to any store or log. The provider operates under zero-data-retention
(ZDR): prompts and completions are not logged or used for training, and only
request metadata is retained provider-side.

The user's email is injected as the `user` field in upstream requests (keyed
users only; campus-pass users send `"campus-anonymous"`). OpenRouter receives
this for per-user rate limiting but does not retain it under ZDR.

Plaintext inference permits a model only when OpenRouter publishes a nonempty
`hugging_face_id` and the corresponding Hugging Face repository resolves.
Missing, malformed, negative, or unavailable evidence fails closed with HTTP
403.

### Model-policy KV (`MODEL_STATUS`)

This KV namespace stores only model-eligibility verdicts keyed by OpenRouter
model slug. Positive (`open`) and definite-negative (`closed`) verdicts expire
after 24 hours. Lookup failures, upstream errors, and malformed responses produce
an `unknown` verdict that is denied but not cached. No prompt, completion, user
identity, or request body enters this cache.

---

## Sealed Lane Traffic (`/sealed/*`, enabled)

**Prompt and completion content is not stored, not logged, and not readable by
BayLeaf.** The Sealed lane (issue #55) differs from the proxy above in kind, not
degree. For the ordinary proxy, "we do not read your prompts" is a *commitment*
an operator could break by deploying a body-logging revision. For Sealed it is a
*structural* property:
clients verify a hardware attestation and encrypt request bodies to the enclave's
public key (EHBP, RFC 9180 HPKE, applied at the application layer independently
of TLS) before those bytes reach BayLeaf. BayLeaf does not hold the
enclave-bound private key, so a body-logging revision would capture ciphertext.

Requests lacking end-to-end encryption are **rejected**, not served over a
readable path. There is no plaintext fallback on this lane.

Tinfoil's current Sealed catalog lists only open-weight models. The requested
model field is inside the encrypted request body and is unreadable by BayLeaf.
For non-streaming responses, however, Tinfoil's usage header reports the model
that executed, so model choice is not categorically hidden from BayLeaf.

What BayLeaf *does* observe on Sealed traffic, and this is the honest boundary of
the claim:

- caller identity (BayLeaf key or Campus Pass IP), timestamps, request counts;
- request and response byte sizes;
- token counts and executed model for non-streaming requests, via an upstream response header.
  (Streaming token counts arrive in an HTTP trailer that the Cloudflare Workers
  runtime does not expose, so BayLeaf does not observe them in flight.)

None of the above is written to D1 or to any log. Content is unreachable; the
fact that you asked is not.

The Sealed lane also introduces the confidential-inference provider (currently
Tinfoil) as a **metadata processor**: it receives a per-user API key, token
counts, and timestamps. It cannot decrypt prompts or completions. As of
2026-07-29 the deliberate decision is that the per-user key may carry the user's
email, on the grounds that the property being defended is the opacity of *data*,
not of identity or metadata.

---

## D1 Database (`user_keys`)

| Column | Sensitivity | Notes |
|---|---|---|
| `email` | PII | UCSC email, primary key |
| `bayleaf_token` | Secret | User-facing `sk-bayleaf-*` credential |
| `or_key_hash` | Low | Truncated hash for dashboard display; nullable until first plaintext use |
| `or_key_secret` | Secret | Full OpenRouter API key; nullable until first plaintext use |
| `revoked` | — | 0 = active, 1 = revoked |
| `created_at` | — | ISO timestamp |
| `daytona_sandbox_id` | Low | Cached sandbox UUID (nullable) |
| `tinfoil_key` | Secret | Full Tinfoil key; nullable until first Sealed use |
| `tinfoil_key_name` | PII | Tinfoil billing-attribution name derived from the user's email |
| `sealed_rpd_count`, `sealed_rpd_date` | Low | Sealed request guardrail state |

**Retention:** Account rows persist while the key is active. Revoked keys remain
in D1 indefinitely (needed for reject-on-use behavior). No automatic purge of
old revoked rows exists today.

**Future:** Consider periodic scrubbing of `or_key_secret` from revoked rows
after a grace period (the key is already deleted at OpenRouter on revocation,
so the stored value is inert).

---

## Code Sandbox (Daytona)

| User type | Sandbox lifecycle | Auto-delete |
|---|---|---|
| Keyed | Persistent: stop after 15 min idle, archive after 60 min stopped | **90 days** after archive (`DAYTONA_AUTO_DELETE_MINUTES = 129600`) |
| Campus Pass | Ephemeral: created per-request, destroyed immediately after | Immediate |

Sandbox content (filesystem, installed packages, user files) lives entirely on
Daytona's infrastructure, labeled by email. BayLeaf stores only the sandbox ID
in D1 as a cache (cleared on explicit deletion).

Users who need to preserve sandbox artifacts should copy them out before the
90-day inactivity window closes. Any tool call resets the idle clock.

---

## Session Cookies

| Cookie | Content | Expiry |
|---|---|---|
| `bayleaf_session` | JWT with email, name, picture (signed, not encrypted) | 24 hours |
| `oauth_state` | Random UUID (OIDC CSRF token) | 10 minutes |

No server-side session store. Logout deletes the cookie immediately.

---

## Web Search and Fetch

**Not stored.** Search queries and URL extractions are forwarded to Tavily;
responses are returned to the caller without caching. Tavily does not receive
user identity.

---

## Cloudflare Workers Platform

Observability (request tracing) is **disabled** in the worker configuration, so
no request or response bodies are captured by the platform. Standard Cloudflare
edge logs (IP, URL, status code) are subject to Cloudflare's platform retention
(~72 hours for non-Enterprise); these are metadata only and never include
prompt or completion content.

---

## Summary

| Data class | Location | Retention |
|---|---|---|
| Prompts and completions | Not stored, not logged (ZDR passthrough, ZOA posture) | — |
| Sealed-lane prompts and completions | Not stored, not logged, and not decryptable by BayLeaf (attested E2EE) | — |
| Plaintext model-policy verdicts | Cloudflare `MODEL_STATUS` KV | 24 hours for positive and definite-negative; unknown is not stored |
| Account records (D1) | Cloudflare D1 | Indefinite while active |
| Sandbox content | Daytona | 90 days after last activity |
| Session state | Client cookie | 24 hours |
| Edge logs | Cloudflare | ~72 hours (platform default) |
