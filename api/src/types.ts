/**
 * BayLeaf API Type Definitions
 */

/** Cloudflare Worker bindings (env vars + secrets) */
export interface Bindings {
  // GCP / Vertex AI
  // Master kill-switch for the Vertex backend. When not exactly the string
  // "true", all `vertex:` routing, model listing, and curated-model exposure
  // is disabled (see isVertexEnabled in constants.ts). Disabled by default
  // pending a credible ZDR path with Google (issue #36).
  VERTEX_ENABLED: string;
  GCP_PROJECT_ID: string;
  GCP_REGION: string;
  GCP_SERVICE_ACCOUNT_EMAIL: string;
  GCP_SERVICE_ACCOUNT_PRIVATE_KEY: string;

  // Amazon Bedrock (bedrock-mantle, OpenAI-compatible)
  // Master kill-switch for the Bedrock backend. When not exactly the string
  // "true", all `bedrock:` routing, model listing, and curated-model exposure
  // is disabled (see isBedrockEnabled in constants.ts). The POC bearer token is
  // from a personal AWS account with no UCSC BAA coverage; production must use
  // an enterprise-account key (issue #41).
  BEDROCK_ENABLED: string;

  // BayLeaf Sealed — attested confidential-inference lane (issue #55)
  // Master kill-switch, same fail-closed semantics as VERTEX_ENABLED /
  // BEDROCK_ENABLED: must be exactly the string "true" or the entire /sealed
  // surface answers 503. Unlike the other backends this is NOT an ALT_BACKENDS
  // row: the sealed lane has no `<prefix>:` model routing and never forwards
  // plaintext. See routes/sealed.ts.
  SEALED_ENABLED: string;
  SEALED_RPD_LIMIT: string;

  // D1 database
  DB: D1Database;

  // KV namespace for Campus Pass per-IP RPD counters
  CAMPUS_RPD: KVNamespace;
  CLAIM_CODES: KVNamespace;

  // Public configuration
  SPENDING_LIMIT_DOLLARS: string;
  SPENDING_LIMIT_RESET: string;
  KEY_NAME_TEMPLATE: string;
  ALLOWED_EMAIL_DOMAIN: string;
  RECOMMENDED_MODEL: string;       // Model slug shown in dashboard examples
  OPENCODE_CURATED_MODELS: string; // Comma-separated namespaced slugs for OpenCode wellknown config (in addition to RECOMMENDED_MODEL)
  SEALED_RECOMMENDED_MODEL: string; // Bare Tinfoil model ID used in Sealed examples
  SEALED_CURATED_MODELS: string;   // Comma-separated companion IDs, in addition to SEALED_RECOMMENDED_MODEL

  // OIDC configuration (provider-agnostic: works with CILogon, Google, etc.)
  OIDC_ISSUER: string;             // e.g. "https://cilogon.org" or "https://accounts.google.com"
  OIDC_SCOPES: string;             // e.g. "openid email profile org.cilogon.userinfo"
  OIDC_AUTHORIZE_PARAMS: string;   // Extra query params for /authorize (e.g. "idphint=urn:mace:incommon:ucsc.edu")
  OIDC_LOGIN_BUTTON_TEXT: string;  // e.g. "Sign in with UCSC"
  
  // Campus Pass configuration
  CAMPUS_IP_RANGES: string;        // Comma-separated CIDR ranges (e.g., "128.114.0.0/16,169.233.0.0/16")
  CAMPUS_RPD_LIMIT: string;        // Per-IP daily request limit for Campus Pass (parsed as integer)
  // Dev-only: when exactly "true", getAuthIP() falls back to 127.0.0.1 when
  // CF-Connecting-IP is absent (local dev has no Cloudflare edge). Never set in
  // production — it would re-introduce the CWE-290 fail-open getAuthIP prevents.
  DEV_LOOPBACK_AUTH: string;
  
  // Sandbox (Daytona) configuration
  DAYTONA_API_URL: string;         // Control plane URL (e.g. https://app.daytona.io/api)
  DAYTONA_PROXY_URL: string;       // Toolbox proxy URL (e.g. https://proxy.app.daytona.io/toolbox)
  DAYTONA_DEPLOYMENT_LABEL: string; // Label prefix for sandbox tagging (e.g. chat.bayleaf.dev; shared with Lathe per issue #14)
  DAYTONA_AUTO_DELETE_MINUTES: string; // Minutes after archive before auto-delete (129600 = 90 days; "-1" = never)

  // Secrets (set via wrangler secret put)
  OPENROUTER_PROVISIONING_KEY: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  CAMPUS_POOL_KEY: string;         // Shared OpenRouter key for campus access
  // Shared Tinfoil key for Campus Pass on the Sealed lane. Campus Pass has no
  // email and therefore no D1 row, so it cannot hold a per-user key; a pool
  // credential is the only option, and it is consequently NOT healable from the
  // request path (see utils/backend.ts). Sealed spend by campus users is
  // attributable only in aggregate, which is the same tradeoff the OpenRouter
  // pool key already makes.
  CAMPUS_SEALED_KEY: string;

  DAYTONA_API_KEY: string;         // Sandbox provider API key

  // Amazon Bedrock bearer token (bedrock-mantle). Long-term Bedrock API key
  // (IAM CreateServiceSpecificCredential, service bedrock.amazonaws.com).
  BEDROCK_BEARER_TOKEN: string;

  // Tinfoil inference credential for the Sealed lane (issue #55).
  //
  // LEGACY / FALLBACK: a single `bayleaf`-org key, still used for the plaintext
  // catalog at GET /sealed/models. Per-user keys (migration 0005) cover the
  // ciphertext relay; the catalog deliberately stays on the org key so listing
  // models has no per-user credential dependency or minting side effect.
  //
  // This credential is NEVER vended to a client. The relay substitutes it for
  // the caller's BayLeaf credential. A user who held it could call Tinfoil
  // directly over plain HTTPS with no attestation and no EHBP, which would
  // silently void the lane's entire confidentiality claim.
  TINFOIL_API_KEY: string;

  // Tinfoil ADMIN credential, used only to mint and delete per-user keys.
  //
  // Strictly more dangerous than OPENROUTER_PROVISIONING_KEY: Tinfoil's admin
  // API re-reveals key secrets on read (`GET /api/keys` returns every user's
  // `tk_` in plaintext), so a leak of this exposes every user's inference
  // credential, not merely the ability to create and destroy keys. Do not use
  // it for anything that a mint/delete does not strictly require, and prefer a
  // separate Worker for billing reconciliation so the request path never gains
  // the ability to enumerate user credentials.
  TINFOIL_ADMIN_KEY: string;

  // Web search and fetch providers
  TAVILY_API_KEY: string;          // Tavily API key (used for both /web/search and /web/fetch)

  // Google Workspace CLI (gws) — optional; enables /docs/gws-* endpoints
  GWS_CLIENT_ID: string;           // OAuth client ID from GCP project (Desktop app)
  GWS_CLIENT_SECRET: string;       // OAuth client secret from GCP project
  GWS_PROJECT_ID: string;          // GCP project ID (e.g. "gws-cli-playground-ucsc")
}

export interface Session {
  email: string;
  name: string;
  picture?: string;
  exp: number; // JWT standard: seconds since epoch
}

export interface OpenRouterKey {
  hash: string;
  name: string;
  label: string;
  disabled: boolean;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
  created_at: string;
  updated_at: string | null;
  expires_at: string | null;
}

export interface OpenRouterKeyCreated extends OpenRouterKey {
  key: string; // The actual API key, only available at creation time
}

/** Hono context variables (set by middleware, read by handlers) */
export interface Variables {
  session: Session;
}

/** Row from the user_keys D1 table */
export interface UserKeyRow {
  email: string;
  bayleaf_token: string;
  // Backend provider credentials are NULL until the user first touches that
  // backend (migration 0005). They are caches hanging off the bayleaf_token,
  // not co-equal columns: the token is the identity record and the only
  // mandatory credential. Never assume these are populated — go through
  // `ensureBackendKey` in provision.ts.
  or_key_hash: string | null;
  or_key_secret: string | null;
  revoked: number;           // 0 = active, 1 = revoked
  created_at: string;
  daytona_sandbox_id: string | null;  // cached sandbox ID (null = not yet provisioned)
  vertex_rpd_count: number;
  vertex_rpd_date: string;
  bedrock_rpd_count: number;
  bedrock_rpd_date: string;
  // Tinfoil / Sealed lane (issue #55). `tinfoil_key` is both the inference
  // credential and the management handle, since Tinfoil has no separate id.
  // `tinfoil_key_name` is the join column back to the out-of-band billing
  // report, which indexes spend by key name.
  tinfoil_key: string | null;
  tinfoil_key_name: string | null;
  sealed_rpd_count: number;
  sealed_rpd_date: string;
}

/**
 * A Tinfoil inference key as returned by the admin API.
 *
 * Note the absence of any `id`/`hash` field: `key` is the identifier, which is
 * why `UserKeyRow` needs no Tinfoil analogue of `or_key_hash`.
 */
export interface TinfoilKey {
  key: string;
  name: string;
  disabled: boolean;
  expires_at: string | null;
  max_tokens: number | null;
  tokens_used: number;
  input_tokens_used: number;
  output_tokens_used: number;
  request_count: number;
  is_admin: boolean;
  /** Always null in practice: provider-side model scoping is not supported. */
  scope: unknown;
  metadata: Record<string, string>;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Create returns the same shape as a list entry. Unlike OpenRouter, the secret
 * is not create-time-only — Tinfoil re-reveals it on every admin read — so
 * there is no separate "…Created" variant carrying an extra field. The alias
 * exists to keep `provision.ts` symmetric across the two providers.
 */
export type TinfoilKeyCreated = TinfoilKey;


/** Hono app environment type */
export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
}
