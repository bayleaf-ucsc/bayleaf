# Data Retention: BayLeaf API

What `api.bayleaf.dev` stores, where, and for how long.

---

## LLM Proxy Traffic

**Not stored.** Requests and responses are streamed through to OpenRouter with
zero local caching. OpenRouter operates under zero-data-retention (ZDR): prompts
and completions are not logged or used for training.

The user's email is injected as the `user` field in upstream requests (keyed
users only; campus-pass users send `"campus-anonymous"`). OpenRouter receives
this for per-user rate limiting but does not retain it under ZDR.

---

## D1 Database (`user_keys`)

| Column | Sensitivity | Notes |
|---|---|---|
| `email` | PII | UCSC email, primary key |
| `bayleaf_token` | Secret | User-facing `sk-bayleaf-*` credential |
| `or_key_hash` | Low | Truncated hash for dashboard display |
| `or_key_secret` | Secret | Full OpenRouter API key (used for upstream auth) |
| `revoked` | — | 0 = active, 1 = revoked |
| `created_at` | — | ISO timestamp |
| `daytona_sandbox_id` | Low | Cached sandbox UUID (nullable) |

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

**Not stored.** Search queries are forwarded to Tavily; page fetches go through
Jina Reader. Responses are returned to the caller without caching. Neither
third-party service receives user identity.

---

## Cloudflare Workers Platform

Observability (request tracing) is **disabled** in the worker configuration.
Standard Cloudflare edge logs (IP, URL, status code) are subject to
Cloudflare's platform retention (~72 hours for non-Enterprise).

---

## Summary

| Data class | Location | Retention |
|---|---|---|
| Prompts and completions | Not stored (ZDR passthrough) | — |
| Account records (D1) | Cloudflare D1 | Indefinite while active |
| Sandbox content | Daytona | 90 days after last activity |
| Session state | Client cookie | 24 hours |
| Edge logs | Cloudflare | ~72 hours (platform default) |
