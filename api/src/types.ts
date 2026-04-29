/**
 * BayLeaf API Type Definitions
 */

/** Cloudflare Worker bindings (env vars + secrets) */
export interface Bindings {
  // D1 database
  DB: D1Database;

  // Public configuration
  SPENDING_LIMIT_DOLLARS: string;
  SPENDING_LIMIT_RESET: string;
  KEY_NAME_TEMPLATE: string;
  ALLOWED_EMAIL_DOMAIN: string;
  SYSTEM_PROMPT_PREFIX: string;
  RECOMMENDED_MODEL: string;       // Model slug shown in dashboard examples

  // OIDC configuration (provider-agnostic: works with CILogon, Google, etc.)
  OIDC_ISSUER: string;             // e.g. "https://cilogon.org" or "https://accounts.google.com"
  OIDC_SCOPES: string;             // e.g. "openid email profile org.cilogon.userinfo"
  OIDC_AUTHORIZE_PARAMS: string;   // Extra query params for /authorize (e.g. "idphint=urn:mace:incommon:ucsc.edu")
  OIDC_LOGIN_BUTTON_TEXT: string;  // e.g. "Sign in with UCSC"
  
  // Campus Pass configuration
  CAMPUS_IP_RANGES: string;        // Comma-separated CIDR ranges (e.g., "128.114.0.0/16,169.233.0.0/16")
  CAMPUS_SYSTEM_PREFIX: string;    // Additional system prompt prefix for campus mode
  
  // Sandbox (Daytona) configuration
  DAYTONA_API_URL: string;         // Control plane URL (e.g. https://app.daytona.io/api)
  DAYTONA_PROXY_URL: string;       // Toolbox proxy URL (e.g. https://proxy.app.daytona.io/toolbox)
  DAYTONA_DEPLOYMENT_LABEL: string; // Label prefix for sandbox tagging (e.g. api.bayleaf.dev)
  DAYTONA_AUTO_DELETE_MINUTES: string; // Minutes after archive before auto-delete (129600 = 90 days; "-1" = never)

  // Secrets (set via wrangler secret put)
  OPENROUTER_PROVISIONING_KEY: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  CAMPUS_POOL_KEY: string;         // Shared OpenRouter key for campus access
  DAYTONA_API_KEY: string;         // Sandbox provider API key

  // Web search and fetch providers
  TAVILY_API_KEY: string;          // Tavily search API key
  JINA_API_KEY: string;            // Jina Reader API key

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
  or_key_hash: string;
  or_key_secret: string;
  revoked: number;           // 0 = active, 1 = revoked
  created_at: string;
  daytona_sandbox_id: string | null;  // cached sandbox ID (null = not yet provisioned)
}

/** Hono app environment type */
export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
}
