/**
 * BayLeaf API Constants
 */

import type { Bindings } from './types';

/** OIDC endpoint discovery result */
export interface OIDCEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

/**
 * Fetch OIDC endpoints from the provider's .well-known/openid-configuration.
 * Works with any compliant provider (CILogon, Google, Keycloak, Dex, etc.).
 */
export async function discoverOIDC(issuer: string): Promise<OIDCEndpoints> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} from ${url}`);
  const doc = await res.json() as OIDCEndpoints;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
    throw new Error(`OIDC discovery response missing required endpoints from ${url}`);
  }
  return doc;
}

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

// ── Alternate inference backends ─────────────────────────────────────
//
// BayLeaf routes chat completions by a `<prefix>:` on the model id. OpenRouter
// (`openrouter:`, or no prefix) is the always-on default. Everything else is an
// "alternate backend": a non-OpenRouter inference path we expose only when its
// ZDR posture is established and its enablement flag is set.
//
// Each alternate backend is one row here. A backend is live only when its env
// flag (`<BACKEND>_ENABLED`) is exactly the string "true". Anything else
// (empty, unset, "false", "0") means disabled, and all of its routing, model
// listing, and curated-model exposure is suppressed. Fail closed.
//
// Vertex (Google) is the first such backend and is currently disabled pending a
// credible ZDR path with Google (issue #36). Amazon Bedrock is the anticipated
// next one (issue #41): UCSC's existing AWS BAA makes it the most likely route
// to BAA-covered ZDR inference, and its `bedrock-mantle` endpoint speaks OpenAI
// Chat Completions with a plain bearer token (no SigV4, no JWT minting). When it
// lands it should be a single new row here (`bedrock` / `bedrock:` /
// `BEDROCK_ENABLED`) plus its own routing block. Note the routing blocks differ
// per backend (Vertex mints a GCP JWT; Bedrock and OpenRouter use a static
// bearer), but the enable/expose/strip surface this table governs is identical.
export interface AltBackend {
  /** Stable internal id, e.g. "vertex". */
  key: string;
  /** Model-id prefix on the wire, e.g. "vertex:". */
  prefix: string;
  /**
   * Bindings env var that gates this backend; must equal "true" to enable.
   * One per backend, named `<BACKEND>_ENABLED` (e.g. "VERTEX_ENABLED",
   * future "BEDROCK_ENABLED").
   */
  envFlag: string;
  /** Human-readable label for error messages and docs. */
  label: string;
}

export const ALT_BACKENDS: readonly AltBackend[] = [
  {
    key: 'vertex',
    prefix: 'vertex:',
    envFlag: 'VERTEX_ENABLED',
    label: 'Google Vertex AI',
  },
  // Future: { key: 'bedrock', prefix: 'bedrock:', envFlag: 'BEDROCK_ENABLED', label: 'Amazon Bedrock' },
];

/** True iff the named alternate backend's env flag is exactly "true". */
export function isBackendEnabled(env: Bindings, key: string): boolean {
  const backend = ALT_BACKENDS.find((b) => b.key === key);
  if (!backend) return false;
  return (env as unknown as Record<string, unknown>)[backend.envFlag] === 'true';
}

/** Convenience wrapper for the Vertex backend (the only one today). */
export function isVertexEnabled(env: Bindings): boolean {
  return isBackendEnabled(env, 'vertex');
}

/**
 * If `modelId` targets an alternate backend, return that backend; else null.
 * Lets callers decide whether a given model id needs an enablement check.
 */
export function altBackendForModel(modelId: string): AltBackend | null {
  return ALT_BACKENDS.find((b) => modelId.startsWith(b.prefix)) ?? null;
}

export const SESSION_COOKIE = 'bayleaf_session';
export const SESSION_DURATION_HOURS = 24;

export const BAYLEAF_TOKEN_PREFIX = 'sk-bayleaf-';

export const DAYTONA_DEFAULT_API_URL = 'https://app.daytona.io/api';
export const DAYTONA_DEFAULT_PROXY_URL = 'https://proxy.app.daytona.io/toolbox';

export const VERTEX_MODELS = [
  {
    id: "vertex:gemini-3.1-pro",
    name: "Vertex: Gemini 3.1 Pro",
    description: "Gemini 3.1 Pro is Google's flagship multimodal model on Vertex AI.",
    pricing: { prompt: "0.00000125", completion: "0.00001" },
    context_length: 2000000,
    architecture: { modality: "text+image+video+audio->text", tokenizer: "Gemini" },
    top_provider: { max_completion_tokens: 65536, is_moderated: false }
  },
  {
    id: "vertex:gemini-2.5-pro",
    name: "Vertex: Gemini 2.5 Pro",
    description: "Gemini 2.5 Pro is Google's most capable 2.5-generation model on Vertex AI.",
    pricing: { prompt: "0.00000125", completion: "0.00001" },
    context_length: 2000000,
    architecture: { modality: "text+image+video+audio->text", tokenizer: "Gemini" },
    top_provider: { max_completion_tokens: 65536, is_moderated: false }
  },
  {
    id: "vertex:gemini-2.5-flash",
    name: "Vertex: Gemini 2.5 Flash",
    description: "Gemini 2.5 Flash is a fast and cost-effective model on Vertex AI.",
    pricing: { prompt: "0.0000003", completion: "0.0000025" },
    context_length: 1000000,
    architecture: { modality: "text+image+video+audio->text", tokenizer: "Gemini" },
    top_provider: { max_completion_tokens: 65536, is_moderated: false }
  },
  {
    id: "vertex:gemini-2.5-flash-lite",
    name: "Vertex: Gemini 2.5 Flash Lite",
    description: "Gemini 2.5 Flash Lite is Google's fastest and lowest-cost model on Vertex AI.",
    pricing: { prompt: "0.0000001", completion: "0.0000004" },
    context_length: 1000000,
    architecture: { modality: "text+image+video+audio->text", tokenizer: "Gemini" },
    top_provider: { max_completion_tokens: 65536, is_moderated: false }
  },
  {
    id: "vertex:zai-org/glm-5-maas",
    name: "Vertex: GLM 5",
    description: "Z.AI's GLM 5, targeting complex systems engineering and long-horizon agentic tasks. Served via Vertex AI MaaS (global endpoint).",
    context_length: 200000,
    architecture: { modality: "text->text", tokenizer: "GLM" },
    top_provider: { max_completion_tokens: 128000, is_moderated: false }
  },
  {
    id: "vertex:zai-org/glm-4.7-maas",
    name: "Vertex: GLM 4.7",
    description: "Z.AI's GLM 4.7, designed for core/vibe coding, tool use, and complex reasoning. Served via Vertex AI MaaS (global endpoint).",
    context_length: 200000,
    architecture: { modality: "text->text", tokenizer: "GLM" },
    top_provider: { max_completion_tokens: 128000, is_moderated: false }
  }
];
