/**
 * Zod Schemas
 *
 * Single source of truth for request/response validation AND OpenAPI spec
 * generation. Every schema here is used both at runtime (via Zod parse) and
 * at doc-generation time (via @hono/zod-openapi).
 */

import { z } from '@hono/zod-openapi';
import { SERVICE_DEFS } from './serviceDefs';

const DecisionContextSchema = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
const DecisionQuestionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: DecisionContextSchema,
    criteria: z.object({ true: DecisionContextSchema, false: DecisionContextSchema }).strict().optional() }).strict(),
  z.object({ type: z.literal('choice'), instructions: DecisionContextSchema,
    criteria: z.record(z.string(), DecisionContextSchema.nullable()).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 255) }).strict(),
  z.object({ type: z.literal('score'), instructions: DecisionContextSchema,
    criteria: z.array(DecisionContextSchema).min(1).max(128) }).strict(),
]);
const EmbeddedDecisionMediaSchema = z.union([
  z.string().regex(/^data:(image|audio|video)\/[a-zA-Z0-9.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  z.object({ content_type: z.string().regex(/^(image|audio|video)\/[a-zA-Z0-9.+-]+$/),
    base64: z.string().min(4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
]).openapi('EmbeddedDecisionMedia');
export const DecisionRequestSchema = z.object({
  model: z.string().min(1).max(256), state: DecisionContextSchema,
  questions: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), DecisionQuestionSchema)
    .refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 64),
  provider: z.object({
    data_collection: z.enum(['allow', 'deny']).nullable().optional(), zdr: z.boolean().nullable().optional(),
    order: z.array(z.string()).optional(), only: z.array(z.string()).optional(), ignore: z.array(z.string()).optional(),
    allow_fallbacks: z.boolean().optional(), require_parameters: z.boolean().optional(),
    sort: z.enum(['price', 'throughput', 'latency']).optional(),
    max_price: z.record(z.string(), z.string()).optional(),
  }).strict().optional(),
  images: z.array(EmbeddedDecisionMediaSchema).max(4).optional(),
  audio: z.array(EmbeddedDecisionMediaSchema).max(4).optional(),
  videos: z.array(EmbeddedDecisionMediaSchema).max(2).optional(),
}).strict().openapi('DecisionRequest', {
  description: 'Typed decision questions over text or structured JSON. Embedded media fields reserve the multimodal contract: requests containing media are currently rejected until the backend transport is verified. No remote URLs, tracing or broadcast fields.',
});
const DecisionProbabilitySchema = z.number().min(0).max(1);
export const DecisionResponseSchema = z.object({
  id: z.string().optional(), model: z.string(), provider: z.string().optional(),
  answers: z.record(z.string(), z.discriminatedUnion('type', [
    z.object({ type: z.literal('noul'), noul: DecisionProbabilitySchema }),
    z.object({ type: z.literal('choice'), choice: z.string(),
      probabilities: z.record(z.string(), DecisionProbabilitySchema).optional(), confidence: DecisionProbabilitySchema.optional() }),
    z.object({ type: z.literal('score'), score: z.number(),
      probabilities: z.record(z.string(), DecisionProbabilitySchema).optional(), confidence: DecisionProbabilitySchema.optional(),
      legend: z.record(z.string(), DecisionContextSchema).optional() }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional() }),
}).openapi('DecisionResponse');

export const CampusPassResponseSchema = z.object({
  campus_network: z.boolean().nullable().describe('Whether the trusted client IP matches campus ranges. Null means the address or configuration is unavailable.'),
  enabled: z.boolean().describe('Whether campus ranges and the standard inference pool credential are configured.'),
  inference: z.object({
    provider: z.literal('openrouter'),
    status: z.enum(['available', 'unavailable', 'unknown']),
    reasons: z.array(z.enum(['off_campus', 'network_unknown', 'disabled', 'quota_exhausted', 'quota_unknown',
      'pool_key_unavailable', 'pool_budget_exhausted', 'shared_credit_exhausted', 'upstream_unknown'])),
  }).describe('Advisory only: available means no known blocker, not a reservation or model-health guarantee. Does not describe Sealed.'),
  quota: z.object({
    remaining: z.number().int().nonnegative(), limit: z.number().int().positive(),
    resets_at: z.iso.datetime(), scope: z.literal('network_address'), approximate: z.literal(true),
  }).nullable().describe('Read-only daily inference counter, shared across Campus Pass lanes. IPv4 per address, IPv6 per /64. Null off-campus or when inspection fails. KV is eventually consistent.'),
  shared_credit: z.object({
    status: z.enum(['available', 'unavailable', 'unknown']),
    checked_at: z.iso.datetime().nullable(),
  }).describe('Combined pool-key and account-credit assessment. Provider metadata is cached for up to 15 seconds per Worker isolate; no dollar values are disclosed.'),
}).openapi('CampusPassResponse');

export const UsageResponseSchema = z.object({
  observed_at: z.iso.datetime(),
  budgets: z.array(z.object({
    provider: z.string(), unit: z.enum(['usd', 'requests']),
    status: z.enum(['available', 'unavailable', 'not_provisioned']),
    period: z.string().nullable(), used: z.number().nullable(),
    limit: z.number().nullable(), remaining: z.number().nullable(),
    resets_at: z.iso.datetime().nullable(),
  })),
}).openapi('UsageResponse');

// ── Shared ────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.union([z.number().int(), z.string()]),
  }),
}).openapi('ApiError');

// ── LLM: Chat Completions ────────────────────────────────────────

export const ChatCompletionRequestSchema = z.object({
  model: z.string().openapi({ example: 'openrouter/auto' }),
  messages: z.array(
    z.object({
      role: z.string().openapi({ example: 'user' }),
      content: z.any().optional().openapi({
        description:
          'Message content. String, null (for tool-call assistant messages), ' +
          'or an array of content parts (text, image_url, etc.).',
      }),
    }).passthrough(),
  ).openapi({
    description:
      'Supports all OpenAI message roles: system, user, assistant, tool, function. ' +
      'Extra fields (tool_calls, tool_call_id, name, etc.) are forwarded to the upstream provider.',
  }),
  stream: z.boolean().optional().default(false).openapi({
    description: 'If true, response is streamed as server-sent events.',
  }),
  temperature: z.number().optional().openapi({
    description: 'Sampling temperature (0-2).',
  }),
  max_tokens: z.number().int().optional().openapi({
    description: 'Maximum tokens to generate.',
  }),
}).passthrough().openapi('ChatCompletionRequest');

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      message: z.object({
        role: z.string(),
        content: z.string(),
      }),
      finish_reason: z.string(),
    }),
  ),
  usage: z.object({
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }).optional(),
}).openapi('ChatCompletionResponse');

// ── LLM: Responses API ──────────────────────────────────────────

export const ResponseRequestSchema = z.object({
  model: z.string().openapi({ example: 'openrouter/auto' }),
  input: z.union([
    z.string(),
    z.array(z.object({
      role: z.string(),
      content: z.any().optional(),
    }).passthrough()),
  ]).openapi({
    description:
      'The input to the model. Can be a string or array of message objects. ' +
      'Message content can be a string, null, or array of content parts.',
  }),
  instructions: z.string().optional().openapi({
    description: 'System instructions forwarded unchanged to the inference provider.',
  }),
}).passthrough().openapi('ResponseRequest');

// ── Sealed confidential inference ────────────────────────────────

export const SealedErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.number().int(),
    lane: z.literal('sealed'),
  }),
}).openapi('SealedError');

export const SealedHealthResponseSchema = z.object({
  lane: z.literal('sealed'),
  enabled: z.literal(true),
  transport: z.literal('ehbp'),
  provider: z.literal('tinfoil'),
  server_credential_configured: z.boolean(),
  attestation_reachable: z.boolean(),
}).openapi('SealedHealthResponse');

export const SealedAttestationRequestSchema = z.object({}).passthrough().openapi('SealedAttestationRequest', {
  description:
    'Tinfoil SDK routing metadata, relayed without interpretation. Clients should let the SDK construct this body.',
});

export const SealedAttestationResponseSchema = z.object({}).passthrough().openapi('SealedAttestationResponse', {
  description:
    'Signed attestation bundle verified by the client, including enclave evidence, certificate, and HPKE public key.',
});

export const SealedModelSchema = z.object({
  id: z.string().openapi({ example: 'glm-5-3' }),
  name: z.string().openapi({ example: 'GLM-5.3' }),
  object: z.string().openapi({ example: 'model' }),
  owned_by: z.string().openapi({ example: 'tinfoil' }),
  type: z.string().optional().openapi({ example: 'chat' }),
  context_window: z.number().int().optional(),
  endpoints: z.array(z.string()).optional(),
}).passthrough().openapi('SealedModel');

export const SealedModelsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(SealedModelSchema),
}).openapi('SealedModelsResponse');

// ── Sandbox ──────────────────────────────────────────────────────

export const SandboxExecRequestSchema = z.object({
  command: z.string().openapi({
    description: 'Bash command to execute. Runs under `set -e -o pipefail` with a 120s timeout.',
  }),
  workdir: z.string().optional().default('/home/daytona/workspace').openapi({
    description: 'Working directory for the command.',
  }),
}).openapi('SandboxExecRequest');

export const SandboxExecResponseSchema = z.object({
  exitCode: z.number().int().openapi({
    description: 'Exit code of the command (0 = success).',
  }),
  output: z.string().openapi({
    description: 'Combined stdout and stderr output.',
  }),
}).openapi('SandboxExecResponse');

export const SandboxUploadResponseSchema = z.object({
  success: z.literal(true),
  path: z.string(),
  bytes: z.number().int(),
}).openapi('SandboxUploadResponse');

export const SandboxDeleteResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
}).openapi('SandboxDeleteResponse');

export const SandboxStatusResponseSchema = z.object({
  id: z.string().nullable().openapi({
    description: 'Sandbox ID, or null if no sandbox exists yet.',
  }),
  state: z.string().openapi({
    description:
      'Current sandbox state: started, stopped, archived, error, starting, ' +
      'stopping, archiving — or "none" if no sandbox exists yet.',
  }),
  cpu: z.number().optional().openapi({ description: 'Allocated vCPUs.' }),
  memory: z.number().optional().openapi({ description: 'Allocated memory in GiB.' }),
  disk: z.number().optional().openapi({ description: 'Allocated disk in GiB.' }),
  autoStopInterval: z.number().optional().openapi({
    description: 'Minutes of inactivity before the sandbox auto-stops.',
  }),
  autoArchiveInterval: z.number().optional().openapi({
    description: 'Minutes stopped before the sandbox auto-archives.',
  }),
  createdAt: z.string().optional().openapi({ description: 'Creation timestamp (ISO 8601).' }),
  updatedAt: z.string().optional().openapi({ description: 'Last update timestamp (ISO 8601).' }),
}).openapi('SandboxStatusResponse');

export const SandboxPokeResponseSchema = z.object({
  id: z.string().openapi({ description: 'Sandbox ID.' }),
  state: z.string().openapi({ description: 'Sandbox state after the poke (started).' }),
  poked: z.literal(true).openapi({
    description: 'Confirms the inactivity timer was refreshed.',
  }),
}).openapi('SandboxPokeResponse');

// ── Key management ───────────────────────────────────────────────
//
// POST|DELETE /key are dashboard plumbing (browser session-gated, called by the
// dashboard JS to provision or revoke a personal key). They are intentionally
// not part of the public OpenAPI surface, so no schemas are exported here.
// Agent-facing budget introspection lives at /v1/auth/key, which works with
// bearer tokens and reports every backend.

// ── Web Search & Fetch ───────────────────────────────────────────

export const WebSearchRequestSchema = z.object({
  query: z.string().min(1).openapi({
    description: 'Search query string.',
    example: 'UC Santa Cruz computational media',
  }),
  max_results: z.number().int().min(1).max(20).optional().default(5).openapi({
    description: 'Maximum number of results to return (1–20, default 5).',
  }),
}).openapi('WebSearchRequest');

export const WebSearchResultSchema = z.object({
  title: z.string().openapi({ description: 'Page title.' }),
  url: z.string().openapi({ description: 'Page URL.' }),
  snippet: z.string().openapi({ description: 'Relevant snippet from the page.' }),
}).openapi('WebSearchResult');

export const WebSearchResponseSchema = z.object({
  results: z.array(WebSearchResultSchema).openapi({ description: 'Search results.' }),
  answer: z.string().optional().openapi({ description: 'AI-generated summary answer, if available.' }),
}).openapi('WebSearchResponse');

export const WebFetchRequestSchema = z.object({
  urls: z.union([
    z.string().url(),
    z.array(z.string().url()).min(1).max(20),
  ]).openapi({
    description:
      'A URL or array of URLs to fetch (up to 20). A single URL string returns a single result; ' +
      'an array fetches all URLs in one call.',
    example: 'https://example.com/article',
  }),
  format: z.enum(['markdown', 'text']).optional().default('markdown').openapi({
    description: 'Desired response format (default: markdown).',
  }),
}).openapi('WebFetchRequest');

export const WebFetchResultSchema = z.object({
  url: z.string().openapi({ description: 'The fetched URL.' }),
  content: z.string().openapi({ description: 'Page content in the requested format.' }),
}).openapi('WebFetchResult');

export const WebFetchFailureSchema = z.object({
  url: z.string().openapi({ description: 'The URL that failed to fetch.' }),
  error: z.string().openapi({ description: 'Reason the URL could not be fetched.' }),
}).openapi('WebFetchFailure');

export const WebFetchResponseSchema = z.object({
  results: z.array(WebFetchResultSchema).openapi({
    description: 'Successfully fetched pages.',
  }),
  failed_results: z.array(WebFetchFailureSchema).optional().openapi({
    description: 'URLs that could not be fetched, if any.',
  }),
}).openapi('WebFetchResponse');

// ── Meta ─────────────────────────────────────────────────────────

export const RecommendedModelResponseSchema = z.object({
  model: z.string(),
  name: z.string(),
}).openapi('RecommendedModelResponse');

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.string().datetime(),
}).openapi('HealthResponse');

// ── Transient previews ─────────────────────────────────────────────

// Lathe #98 wire contract. ASCII bounds make character and byte counts equal.
const RESERVED_PREVIEW_HEADERS = new Set(['host', 'cookie', 'origin', 'referer', 'forwarded',
  'x-real-ip', 'true-client-ip', 'connection', 'upgrade', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'content-length', 'expect', 'http2-settings', 'proxy-authorization', 'proxy-authenticate']);
export const PreviewUpstreamHeadersSchema = z.record(z.string(), z.string()).refine(headers => {
  const entries = Object.entries(headers);
  const names = entries.map(([name]) => name.toLowerCase());
  return entries.length <= 16 && new Set(names).size === entries.length &&
    entries.every(([name, value]) => name.length >= 1 && name.length <= 64 &&
      !/[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name) &&
      !RESERVED_PREVIEW_HEADERS.has(name.toLowerCase()) &&
      !/^(?:x-forwarded-|sec-|cf-|daytona-|x-daytona-|x-lathe-)/i.test(name) &&
      value.length <= 4096 && !/[^\x20-\x7e]/.test(value)) &&
    entries.reduce((size, [name, value]) => size + name.length + value.length, 0) <= 8192;
}, 'Invalid upstream header configuration').openapi('PreviewUpstreamHeaders', {
  description: 'Application headers, independent of access policy. Maximum 16 entries, 64-byte HTTP-token names, 4096-byte printable ASCII values, 8192 total name/value bytes. Case-insensitive duplicates and routing, transport, browser-security and provider-reserved headers are forbidden. Fixed Authorization, including Basic, is supported; platform credentials are rejected. Values overwrite browser headers on HTTP and WebSocket requests. Public visitors can exercise injected credentials.',
});

// Lathe's command-style v2 contract: access is a required policy, not a
// negotiated result. The optional tag is an untrusted hint that BayLeaf ignores.
export const PreviewRegistrationSchema = z.object({
  owner: z.object({
    subject: z.string().min(1).max(200),
    email: z.email().max(254),
  }).strict(),
  upstream_url: z.url().max(2048),
  access: z.enum(['public', 'private']),
  upstream_headers: PreviewUpstreamHeadersSchema.optional(),
  tag: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/).optional().openapi({
    description: 'Optional untrusted display hint. BayLeaf does not include it in hostnames.',
  }),
}).strict().openapi('PreviewRegistration');

export const PreviewRegistrationResponseSchema = z.object({
  url: z.url(),
  expires_at: z.iso.datetime(),
  upstream_headers_applied: z.literal(true).optional().openapi({
    description: 'Exact true acknowledgement, present only for nonempty upstream_headers.',
  }),
}).openapi('PreviewRegistrationResponse');

export const PreviewLabelSchema = z.object({
  label: z.string().regex(/^[a-z0-9-]{1,63}$/),
}).openapi('PreviewLabel');

export const SandboxExposeRequestSchema = z.object({
  port: z.number().int().min(3000).max(9999).refine(port => !Object.values(SERVICE_DEFS).some(service => service.port === port), 'Reserved managed-service port').openapi({ example: 5000 }),
  access: z.enum(['private', 'public']).default('private'),
  upstream_headers: PreviewUpstreamHeadersSchema.optional(),
}).strict().openapi('SandboxExposeRequest');

export const SandboxExposeSlotSchema = z.object({
  slot: z.string().regex(/^[3-9][0-9]{3}$/),
}).openapi('SandboxExposeSlot');
// Temporary inference grants: seconds are positive; administrator policy sets
// the ceiling at runtime so clients receive the current maximum on rejection.
const GrantModelSchema = z.string().min(1).max(200);
const GrantModelsListSchema = z.array(GrantModelSchema).min(1).max(16).describe('Authorized backend-qualified standard model slugs, without inference type tags. Every model must be eligible. Sealed is excluded.');
export const GrantRequestSchema = z.object({
  models: GrantModelsListSchema.optional(),
  model: GrantModelSchema.optional().describe('Legacy singleton shorthand, mutually exclusive with models. Bare OpenRouter slugs remain accepted.').openapi({ example: 'openrouter:qwen/qwen3.8-27b' }),
  expires_in: z.number().int().positive().describe('Requested lifetime in seconds. The runtime administrator maximum is enforced by rejection, never clamping; invalid_lifetime reports the current maximum.').openapi({ example: 600 }),
}).strict().refine(v => (v.model !== undefined) !== (v.models !== undefined), 'Specify models or model, not both.').openapi('GrantRequest');
export const GrantTokenSchema = z.object({
  grant_id: z.string().describe('Grant identifier for management/revocation; called id in the list response.'),
  name: z.string().describe('Public recognition name, not a credential. Bound into the signed token; names are unique among this owner\'s retained grants.'),
  key: z.string().describe('Compatibility alias for access_token, identical secret value.'),
  access_token: z.string().describe('Opaque bearer credential, shown only at issuance. Send in Authorization, never URLs or logs; keep out of public page source.'),
  token_type: z.literal('Bearer'), models: GrantModelsListSchema,
  model: z.string().describe('Compatibility alias for the first authorized model.'),
  expires_at: z.number().int().describe('Absolute expiry, Unix seconds. Visitor-authorized lifetime starts at approval, not exchange.'),
  expires_in: z.number().int().describe('Seconds remaining at issuance/exchange, not a new lifetime allocation.'),
   base_url: z.string().describe('Standard inference base URL. Append /chat/completions, /decisions, or /responses (OpenRouter only).'),
}).openapi('GrantToken');
export const GrantErrorSchema = z.object({ error: z.object({
  code: z.string().describe('Machine-readable reason, such as invalid_request, invalid_lifetime, invalid_grant, model_not_allowed, login_required, or grants_disabled.'),
  message: z.string().describe('Human-readable explanation; do not parse this as a stable protocol field.'),
}) }).openapi('GrantError');
export const ClientDescriptorRequestSchema = z.object({
  client_name: z.string().trim().min(1).max(80).describe('App-supplied label shown at consent; not a verified app identity.'),
  redirect_uri: z.string().min(1).max(2048).describe('Exact callback URI: HTTPS, or HTTP localhost/127.0.0.1/[::1]. No credentials or fragment. Preserve host, port, path and query unchanged through exchange.').openapi({ example: 'http://127.0.0.1:5173/callback' }),
}).strict().openapi('ClientDescriptorRequest');
export const ClientDescriptorSchema = z.object({
  client_id: z.string().describe('Opaque signed descriptor for initiating authorization; not permanent registration or an inference credential. Valid for ten minutes.'),
  expires_at: z.number().int().describe('Descriptor expiry, Unix seconds.'),
}).openapi('ClientDescriptor');
export const GrantExchangeSchema = z.object({
  grant_type: z.literal('authorization_code'), code: z.string().min(1).max(128).describe('Single-use callback code, valid for at most two minutes after approval and bounded by the original transaction deadline.'),
  client_id: z.string().min(1).max(8192).describe('The identical descriptor used to initiate this browser authorization.'),
  redirect_uri: z.string().min(1).max(2048).describe('The exact callback URI bound into the descriptor and authorization transaction.'),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).describe('Original cryptographically random S256 PKCE verifier. SHA-256 then base64url without padding must match the authorization challenge.'),
}).strict().openapi('GrantExchange');
// Documentation-only query schema. The browser handler also accepts an internal
// ?request= continuation; registering this must never install public validation.
export const GrantAuthorizeQuerySchema = z.object({
  client_id: z.string().describe('Signed descriptor returned by POST /grants/clients.'),
  response_type: z.literal('code'), model: GrantModelSchema.optional().describe('Legacy singleton shorthand, mutually exclusive with models.'),
  models: z.string().optional().describe('JSON array of 1–16 backend-qualified model slugs, mutually exclusive with model. Example: ["openrouter:qwen/qwen3.8-27b"].'),
  expires_in: z.string().describe('Requested positive integer lifetime in seconds, as a query string; the runtime ceiling still applies.'),
  state: z.string().min(1).max(256).describe('Cryptographically random application state, retained by the initiating tab and verified on callback.'),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe('Base64url SHA-256 of the verifier, without padding.'),
  code_challenge_method: z.literal('S256'),
}).refine(v => (v.model !== undefined) !== (v.models !== undefined), 'Specify models or model, not both.').openapi('GrantAuthorizeQuery');
export const GrantListSchema = z.object({ grants: z.array(z.object({
  id: z.string().describe('Same identifier as grant_id in the issuance response. Use to revoke this grant.'),
  name: z.string().nullable().describe('Public recognition name; null for older unnamed grants.'),
  models: GrantModelsListSchema,
  model: z.string().describe('Compatibility alias for the first authorized model.'),
  expires_at: z.number().int().describe('Expiry, Unix seconds.'), created_at: z.number().int().describe('Creation time, Unix seconds.'),
  client_name: z.string().nullable().describe('App-supplied consent label; null for direct issuance.'),
  redirect_uri: z.string().nullable().describe('Bound callback URI; null for direct issuance.'),
})) }).describe('Active grant metadata for the current owner. Credentials cannot be recovered through listing.').openapi('GrantList');

export const GrantModelsSchema = z.object({
  models: z.array(z.object({ id: z.string().describe('Backend-qualified selectable model ID.'), name: z.string().describe('Display label.') })),
  backends: z.array(z.object({ id: z.string(), label: z.string(),
    enabled: z.boolean().describe('Administrator enabled this standard backend.'),
    available: z.boolean().describe('Backend-specific catalog availability, not a model-health or inference guarantee. OpenRouter reports successful retrieval, Vertex has a static catalog when enabled, and Bedrock requires a nonempty retrieved catalog.'),
  })),
}).openapi('GrantModels');
// Browser lifecycle metadata only: no credentials, file contents, or setup logs.
export const BrowserSandboxStatusSchema = z.object({
  phase: z.enum(['idle', 'opening', 'ready', 'failed', 'expired', 'stopped', 'unavailable']),
  machine: z.string().optional(),
  progress: z.string().optional(),
  operation: z.string().optional(),
  deadline: z.number().int().optional().describe('Private browser-link expiry, Unix seconds; not a compute deadline.'),
  updated_at: z.number().int().optional(),
  started_at: z.number().int().optional(),
  heartbeat_at: z.number().int().optional(),
  timeline: z.array(z.object({step:z.string(),at:z.number().int(),error:z.string().optional()})).max(40).optional(),
  previous_failure: z.object({at:z.number().int(),error:z.string(),progress:z.string(),elapsed:z.number().nonnegative()}).optional(),
  url: z.string().url().optional(),
  error: z.string().optional(),
}).openapi('BrowserSandboxStatus');

export const BrowserSandboxErrorSchema = z.object({ error: z.string() }).openapi('BrowserSandboxError');
