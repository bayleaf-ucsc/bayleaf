/**
 * API Proxy Route Handlers
 *
 * Proxies requests to OpenRouter with system prompt injection.
 * Handles both Chat Completions (/v1/chat/completions) and
 * Responses API (/v1/responses) with format-appropriate injection.
 * Resolves sk-bayleaf- proxy tokens to real OR keys via D1.
 * Supports Campus Pass for on-campus users.
 *
 * Note: this sub-app is mounted at /v1, so paths are relative to /v1.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { proxy } from 'hono/proxy';
import type { AppEnv } from '../types';
import { OPENROUTER_API, BEDROCK_MANTLE_API, VERTEX_MODELS, isVertexEnabled, isBedrockEnabled, altBackend } from '../constants';
import { resolveAuth, type AuthResult } from '../utils/auth';
import { getGCPAccessToken } from '../utils/gcp';
import { checkAndIncrement, inspectCounter, parseLimit } from '../utils/campusRpd';
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ResponseRequestSchema,
  ApiErrorSchema,
} from '../schemas';

export const proxyRoutes = new OpenAPIHono<AppEnv>();

/**
 * Per-key daily request limits, sourced from the ALT_BACKENDS table so the
 * dashboard, error messages, and `data.bayleaf` payload all agree. Resets at
 * midnight UTC.
 */
const VERTEX_RPD_LIMIT = altBackend('vertex')!.rpdLimit;
const BEDROCK_RPD_LIMIT = altBackend('bedrock')!.rpdLimit;

// ── GET / (mounted as /v1) — bare root returns 200 OK ─────────────
// Some agent harnesses probe the base_url to test connectivity.
proxyRoutes.get('/', (c) => c.body(null, 200));

/**
 * Enforce the Campus Pass per-IP daily request limit. No-op for keyed users.
 * Returns null on pass, or a 429 JSON Response on cap-exceeded.
 *
 * Called at the top of /chat/completions and /responses handlers — the only
 * billable LLM endpoints. Inspection routes (/models, /auth/key) and proxy
 * passthroughs are not gated.
 */
async function enforceCampusRpd(
  env: AppEnv['Bindings'],
  auth: AuthResult,
): Promise<Response | null> {
  if (!auth.isCampusMode) return null;
  // In campus mode, isCampusPassEligible guarantees clientIp is non-null
  // (getAuthIP returned an on-campus IP). Guard for the type system.
  if (!auth.clientIp) return null;
  const limit = parseLimit(env.CAMPUS_RPD_LIMIT);
  const status = await checkAndIncrement(env.CAMPUS_RPD, auth.clientIp, limit);
  if (status === null) return null;
  return Response.json(
    {
      error: {
        message:
          `Campus Pass daily request limit reached (${status.limit} requests). ` +
          `Resets at ${status.resetsAt}. ` +
          `Provision a free personal API key at https://api.bayleaf.dev/ for higher limits.`,
        code: 429,
      },
    },
    {
      status: 429,
      headers: { 'Access-Control-Allow-Origin': '*' },
    },
  );
}

/** Build the system prompt prefix, adding campus suffix when applicable. */
function buildSystemPrefix(env: AppEnv['Bindings'], isCampusMode: boolean): string {
  let prefix = env.SYSTEM_PROMPT_PREFIX;
  if (isCampusMode && env.CAMPUS_SYSTEM_PREFIX) {
    prefix += '\n\n' + env.CAMPUS_SYSTEM_PREFIX;
  }
  return prefix;
}

/** Inject the `user` field for OR per-user analytics. */
function injectUser(body: { user?: string }, auth: AuthResult): void {
  if (body.user) return;
  if (auth.userEmail) {
    body.user = auth.userEmail;
  } else if (auth.isCampusMode) {
    body.user = 'campus-anonymous';
  }
}

/** Forward a modified JSON body to OpenRouter and return the response. */
async function forwardJson(
  url: string,
  authorization: string,
  body: unknown,
): Promise<Response> {
  const res = await proxy(url, {
    method: 'POST',
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}

/**
 * Fetch the Bedrock mantle catalog and shape it into prefixed `/v1/models`
 * entries. Returns [] when the backend is disabled or the upstream call fails,
 * so a flaky mantle never breaks the combined model listing. Each id is
 * namespaced with `bedrock:` and the display name gets a "Bedrock: " prefix to
 * match the OpenRouter/Vertex convention.
 */
async function fetchBedrockModels(env: AppEnv['Bindings']): Promise<any[]> {
  if (!isBedrockEnabled(env)) return [];
  try {
    const res = await fetch(`${BEDROCK_MANTLE_API}/models`, {
      headers: { Authorization: `Bearer ${env.BEDROCK_BEARER_TOKEN}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: any[] };
    if (!Array.isArray(data.data)) return [];
    return data.data.map((model) => ({
      ...model,
      id: `bedrock:${model.id}`,
      name: model.name ? `Bedrock: ${model.name}` : `Bedrock: ${model.id}`,
    }));
  } catch {
    return [];
  }
}

// ── POST /responses — Responses API proxy ─────────────────────────

const responsesRoute = createRoute({
  method: 'post',
  path: '/responses',
  operationId: 'createResponse',
  tags: ['LLM'],
  summary: 'Responses API',
  description:
    'OpenAI Responses API endpoint. The BayLeaf system prompt is injected via the `instructions` field. ' +
    'If you provide your own `instructions`, the prefix is prepended.',
  security: [{ Bearer: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: ResponseRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Response result',
      content: {
        'application/json': {
          schema: z.object({}).passthrough().openapi({
            description: 'OpenAI Responses API response object',
          }),
        },
      },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

proxyRoutes.openapi(responsesRoute, async (c) => {
  const auth = await resolveAuth(c);
  // Auth guard: resolveAuth() returns a pre-built error Response when auth
  // fails. This is a raw Response, not a typed Hono response, because the
  // auth layer is shared across routes and predates the OpenAPI types.
  if (auth instanceof Response) return auth as any;

  const rpdRejection = await enforceCampusRpd(c.env, auth);
  if (rpdRejection) return rpdRejection as any;

  const body = c.req.valid('json') as {
    instructions?: string;
    user?: string;
    [k: string]: unknown;
  };

  const systemPrefix = buildSystemPrefix(c.env, auth.isCampusMode);
  body.instructions = body.instructions
    ? systemPrefix + '\n\n' + body.instructions
    : systemPrefix;

  injectUser(body, auth);

  // Proxy passthrough: forwarding the upstream response verbatim. The actual
  // response shape comes from OpenRouter, not from our Zod schema.
  return forwardJson(`${OPENROUTER_API}/responses`, auth.authorization, body) as any;
}, (result, c) => {
  if (!result.success) {
    // Hook return type is not modeled by the library's generics
    return c.json({ error: { message: 'Invalid JSON in request body.', code: 400 } }, 400) as any;
  }
});

// ── POST /chat/completions — Chat Completions proxy ───────────────

const chatCompletionsRoute = createRoute({
  method: 'post',
  path: '/chat/completions',
  operationId: 'chatCompletions',
  tags: ['LLM'],
  summary: 'Chat Completions',
  description:
    'OpenAI-compatible chat completions endpoint. Supports streaming via `stream: true`. ' +
    'A system prompt identifying the BayLeaf service is prepended automatically; ' +
    'if you include your own system message, the prefix is prepended to it.',
  security: [{ Bearer: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: ChatCompletionRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Completion result (or SSE stream if `stream: true`)',
      content: {
        'application/json': {
          schema: ChatCompletionResponseSchema,
        },
      },
    },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

proxyRoutes.openapi(chatCompletionsRoute, async (c) => {
  const auth = await resolveAuth(c);
  // Auth guard — see note on responsesRoute handler above.
  if (auth instanceof Response) return auth as any;

  const rpdRejection = await enforceCampusRpd(c.env, auth);
  if (rpdRejection) return rpdRejection as any;

  const body = c.req.valid('json') as {
    messages?: Array<{ role: string; content?: unknown; [k: string]: unknown }>;
    user?: string;
    [k: string]: unknown;
  };

  if (body.messages && Array.isArray(body.messages)) {
    const systemPrefix = buildSystemPrefix(c.env, auth.isCampusMode);
    // Look for system or developer message (developer replaces system on newer models)
    const systemIndex = body.messages.findIndex(
      m => m.role === 'system' || m.role === 'developer',
    );

    if (systemIndex >= 0) {
      const msg = body.messages[systemIndex];
      const existing = msg.content;
      if (typeof existing === 'string') {
        msg.content = systemPrefix + '\n\n' + existing;
      } else if (Array.isArray(existing)) {
        // Content is an array of content parts — prepend as a text part
        existing.unshift({ type: 'text', text: systemPrefix + '\n\n' });
      } else {
        // null, undefined, or unexpected — replace with prefix string
        msg.content = systemPrefix;
      }
    } else {
      body.messages.unshift({ role: 'system', content: systemPrefix });
    }
  }

  injectUser(body, auth);

  // Prefix routing
  const modelStr = typeof body.model === 'string' ? body.model : '';
  
  if (modelStr.startsWith('vertex:')) {
    // Master kill-switch: when the Vertex backend is disabled, reject `vertex:`
    // traffic before any GCP auth. Fail closed (issue #36 — no credible ZDR
    // path with Google). Mirror this guard for any future alternate backend.
    if (!isVertexEnabled(c.env)) {
      return c.json({ error: { message: 'The Vertex AI backend is currently disabled. Use an `openrouter:` model instead. See https://api.bayleaf.dev/llms.txt for available models.', code: 503 } }, 503) as any;
    }
    // Keyed users: enforce per-key Vertex RPD against the user_keys row.
    // Campus Pass users: already counted by enforceCampusRpd above (one
    // unified per-IP counter applies across all providers); no per-key
    // bookkeeping exists or is needed.
    if (auth.userKeyRow) {
      const RPD_LIMIT = VERTEX_RPD_LIMIT;
      const today = new Date().toISOString().split('T')[0];
      const user = auth.userKeyRow;

      if (user.vertex_rpd_date !== today) {
        await c.env.DB.prepare(
          "UPDATE user_keys SET vertex_rpd_count = 1, vertex_rpd_date = ? WHERE bayleaf_token = ?"
        ).bind(today, user.bayleaf_token).run();
      } else if (user.vertex_rpd_count >= RPD_LIMIT) {
        return c.json({ error: { message: `Vertex AI daily budget exceeded (${RPD_LIMIT} requests). Resets at midnight UTC.`, code: 429 } }, 429) as any;
      } else {
        await c.env.DB.prepare(
          "UPDATE user_keys SET vertex_rpd_count = vertex_rpd_count + 1 WHERE bayleaf_token = ?"
        ).bind(user.bayleaf_token).run();
      }
    }

    // Rewrite model name
    let targetModel = modelStr.replace('vertex:', '');
    if (!targetModel.includes('/')) {
      targetModel = `google/${targetModel}`;
    }
    body.model = targetModel;

    // Forward to Vertex OpenAI-compatible endpoint.
    // We route all Vertex traffic through the `global` location because some
    // partner MaaS models (e.g. zai-org/glm-*) are only published there. Gemini
    // models are also available globally, so a single endpoint covers all cases.
    try {
      const accessToken = await getGCPAccessToken(c.env.GCP_SERVICE_ACCOUNT_EMAIL, c.env.GCP_SERVICE_ACCOUNT_PRIVATE_KEY);
      const projectId = c.env.GCP_PROJECT_ID;
      const vertexUrl = `https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/global/endpoints/openapi/chat/completions`;

      return forwardJson(vertexUrl, `Bearer ${accessToken}`, body) as any;
    } catch (e: any) {
      return c.json({ error: { message: `Failed to route to Vertex AI: ${e.message}`, code: 500 } }, 500) as any;
    }
  } else if (modelStr.startsWith('bedrock:')) {
    // Master kill-switch: when the Bedrock backend is disabled, reject
    // `bedrock:` traffic before any upstream call. Fail closed (issue #41 —
    // the POC token is from a non-BAA personal account; production needs an
    // enterprise-account key). Mirror of the Vertex guard above.
    if (!isBedrockEnabled(c.env)) {
      return c.json({ error: { message: 'The Amazon Bedrock backend is currently disabled. Use an `openrouter:` model instead. See https://api.bayleaf.dev/llms.txt for available models.', code: 503 } }, 503) as any;
    }
    // Keyed users: enforce per-key Bedrock RPD against the user_keys row.
    // Bedrock spend goes to AWS, not OpenRouter, so it is not metered by the
    // OpenRouter dollar budget and needs its own counter. Campus Pass users
    // are already counted by enforceCampusRpd above (unified per-IP counter
    // across all providers); no per-key bookkeeping exists or is needed.
    if (auth.userKeyRow) {
      const RPD_LIMIT = BEDROCK_RPD_LIMIT;
      const today = new Date().toISOString().split('T')[0];
      const user = auth.userKeyRow;

      if (user.bedrock_rpd_date !== today) {
        await c.env.DB.prepare(
          "UPDATE user_keys SET bedrock_rpd_count = 1, bedrock_rpd_date = ? WHERE bayleaf_token = ?"
        ).bind(today, user.bayleaf_token).run();
      } else if (user.bedrock_rpd_count >= RPD_LIMIT) {
        return c.json({ error: { message: `Amazon Bedrock daily budget exceeded (${RPD_LIMIT} requests). Resets at midnight UTC.`, code: 429 } }, 429) as any;
      } else {
        await c.env.DB.prepare(
          "UPDATE user_keys SET bedrock_rpd_count = bedrock_rpd_count + 1 WHERE bayleaf_token = ?"
        ).bind(user.bayleaf_token).run();
      }
    }

    // Strip the `bedrock:` prefix; forward the mantle model id verbatim
    // (e.g. `bedrock:google.gemma-3-12b-it` -> `google.gemma-3-12b-it`).
    // mantle ids already carry their owner segment, so no rewrite beyond
    // prefix removal. Auth is a static bearer token (no JWT minting).
    body.model = modelStr.replace('bedrock:', '');
    return forwardJson(`${BEDROCK_MANTLE_API}/chat/completions`, `Bearer ${c.env.BEDROCK_BEARER_TOKEN}`, body) as any;
  } else {
    // OpenRouter passthrough
    if (modelStr.startsWith('openrouter:')) {
      body.model = modelStr.replace('openrouter:', '');
    }
    return forwardJson(`${OPENROUTER_API}/chat/completions`, auth.authorization, body) as any;
  }
}, (result, c) => {
  if (!result.success) {
    // Hook return type is not modeled by the library's generics
    return c.json({ error: { message: 'Invalid JSON in request body.', code: 400 } }, 400) as any;
  }
});

// ── GET /models — Custom Models Interceptor ─────────────────────────
// Intercepts the models list to inject Vertex AI models and prefix OpenRouter models.

const modelsRoute = createRoute({
  method: 'get',
  path: '/models',
  operationId: 'listModels',
  tags: ['LLM'],
  summary: 'List available models',
  description: 'Lists models available via OpenRouter (prefixed with openrouter:), Vertex AI (prefixed with vertex:), and Amazon Bedrock (prefixed with bedrock:). Alternate backends appear only when enabled.',
  security: [{ Bearer: [] }],
  responses: {
    200: { description: 'Model list' },
    401: { description: 'Missing or invalid API key' },
  },
});

proxyRoutes.openapi(modelsRoute, async (c) => {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;

  try {
    const res = await fetch(`${OPENROUTER_API}/models`, {
      headers: { Authorization: auth.authorization }
    });
    
    if (!res.ok) {
      return new Response(await res.text(), { status: res.status, headers: { 'Access-Control-Allow-Origin': '*' } }) as any;
    }

    const data = await res.json() as { data: any[] };
    
    // Prefix all OpenRouter models
    const orModels = data.data.map(model => ({
      ...model,
      id: `openrouter:${model.id}`,
      name: `OpenRouter: ${model.name}`
    }));

    // Combine with Vertex models, but only when the Vertex backend is enabled.
    // When disabled, the picker must not advertise models we will reject.
    const vertexModels = isVertexEnabled(c.env) ? VERTEX_MODELS : [];

    // Bedrock (mantle) models are fetched live and prefixed with `bedrock:`,
    // only when the backend is enabled. Unlike Vertex's hardcoded curated
    // list, mantle's catalog shifts often, so we mirror its `/models` at
    // request time. A mantle failure must not break the whole listing — we
    // tolerate it by contributing no Bedrock entries (same posture as an OR
    // 5xx affecting only its own slice).
    const bedrockModels = await fetchBedrockModels(c.env);

    return c.json({ data: [...orModels, ...vertexModels, ...bedrockModels] }, 200, { 'Access-Control-Allow-Origin': '*' }) as any;
  } catch (e: any) {
    return c.json({ error: { message: `Failed to fetch models: ${e.message}`, code: 500 } }, 500, { 'Access-Control-Allow-Origin': '*' }) as any;
  }
});


// ── GET /auth/key — Augmented key info interceptor ────────────────
// OpenRouter exposes /v1/auth/key as a way for an agent to introspect its
// budget. Since BayLeaf splits traffic across two backends, we intercept this
// endpoint, forward to OpenRouter to get the OR-side limits, and splice in a
// `data.bayleaf` block describing per-backend usage. The OR-shaped top-level
// fields (data.usage, data.limit, data.limit_remaining, data.label, data.rate_limit)
// are passed through unchanged so existing OR-aware clients keep working.

const authKeyRoute = createRoute({
  method: 'get',
  path: '/auth/key',
  operationId: 'getKeyInfo',
  tags: ['LLM'],
  summary: 'Inspect API key budget',
  description:
    'Returns the OpenRouter `/auth/key` response augmented with a `data.bayleaf` ' +
    'block reporting per-backend usage. The `bayleaf.openrouter` sub-object ' +
    'mirrors the OR-side dollar budget. For keyed users, `bayleaf.vertex` ' +
    'reports the per-key requests-per-day budget consumed by `vertex:` model ' +
    'traffic. For Campus Pass connections, `bayleaf.campus` reports the ' +
    'unified per-IP requests-per-day budget covering all providers (Vertex ' +
    'and OpenRouter alike).',
  security: [{ Bearer: [] }],
  responses: {
    200: { description: 'Key info' },
    401: { description: 'Missing or invalid API key' },
  },
});

proxyRoutes.openapi(authKeyRoute, async (c) => {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;

  // Fetch the OR-side response. We keep its status code and payload shape
  // for the top-level fields, then splice in our `bayleaf` augmentation.
  let orStatus = 200;
  let orPayload: { data?: Record<string, unknown> } = {};
  try {
    const res = await fetch(`${OPENROUTER_API}/auth/key`, {
      headers: { Authorization: auth.authorization },
    });
    orStatus = res.status;
    if (res.ok) {
      orPayload = await res.json() as { data?: Record<string, unknown> };
    } else {
      // Forward OR's error verbatim — no augmentation makes sense here.
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
      }) as any;
    }
  } catch (e: any) {
    return c.json({ error: { message: `Failed to fetch key info: ${e.message}`, code: 500 } }, 500, { 'Access-Control-Allow-Origin': '*' }) as any;
  }

  const orData = orPayload.data ?? {};
  const orUsage = typeof orData.usage === 'number' ? orData.usage : null;
  const orLimit = typeof orData.limit === 'number' ? orData.limit : null;
  const orRemaining = typeof orData.limit_remaining === 'number'
    ? orData.limit_remaining
    : (orLimit !== null && orUsage !== null ? orLimit - orUsage : null);

  // Build the bayleaf augmentation. OR sub-block always present; Vertex only
  // when we have a keyed user (the per-key Vertex RPD counter lives in the
  // user_keys row). Campus sub-block present for Campus Pass connections,
  // reporting the unified per-IP RPD that covers all providers.
  const bayleaf: {
    openrouter: {
      usage: number | null;
      limit: number | null;
      limit_remaining: number | null;
      applies_to: string;
    };
    vertex?: {
      requests_today: number;
      limit: number;
      limit_remaining: number;
      resets_at: string;
      applies_to: string;
    };
    bedrock?: {
      requests_today: number;
      limit: number;
      limit_remaining: number;
      resets_at: string;
      applies_to: string;
    };
    campus?: {
      requests_today: number;
      limit: number;
      limit_remaining: number;
      resets_at: string;
      applies_to: string;
    };
  } = {
    openrouter: {
      usage: orUsage,
      limit: orLimit,
      limit_remaining: orRemaining,
      applies_to: 'models with prefix "openrouter:"',
    },
  };

  if (auth.userKeyRow) {
    const today = new Date().toISOString().split('T')[0];
    // If the stored date is stale, the next /v1/chat/completions call will
    // reset the counter to 1. From the agent's perspective, today's usage is
    // effectively zero — report it that way.
    const requestsToday = auth.userKeyRow.vertex_rpd_date === today
      ? auth.userKeyRow.vertex_rpd_count
      : 0;
    // Next midnight UTC: bump to tomorrow's date and pin to 00:00:00Z.
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    bayleaf.vertex = {
      requests_today: requestsToday,
      limit: VERTEX_RPD_LIMIT,
      limit_remaining: Math.max(0, VERTEX_RPD_LIMIT - requestsToday),
      resets_at: tomorrow.toISOString(),
      applies_to: 'models with prefix "vertex:"',
    };

    const bedrockRequestsToday = auth.userKeyRow.bedrock_rpd_date === today
      ? auth.userKeyRow.bedrock_rpd_count
      : 0;
    bayleaf.bedrock = {
      requests_today: bedrockRequestsToday,
      limit: BEDROCK_RPD_LIMIT,
      limit_remaining: Math.max(0, BEDROCK_RPD_LIMIT - bedrockRequestsToday),
      resets_at: tomorrow.toISOString(),
      applies_to: 'models with prefix "bedrock:"',
    };
  }

  if (auth.isCampusMode && auth.clientIp) {
    const limit = parseLimit(c.env.CAMPUS_RPD_LIMIT);
    const status = await inspectCounter(c.env.CAMPUS_RPD, auth.clientIp, limit);
    bayleaf.campus = {
      requests_today: status.count,
      limit: status.limit,
      limit_remaining: status.remaining,
      resets_at: status.resetsAt,
      applies_to: 'all /v1/chat/completions and /v1/responses requests (per network address)',
    };
  }

  return c.json(
    { data: { ...orData, bayleaf } },
    orStatus as 200,
    { 'Access-Control-Allow-Origin': '*' },
  ) as any;
});


// ── Catch-all — General OpenRouter proxy ──────────────────────────
// Paths like /models, /auth/key, etc. These are documented in OpenAPI
// as a generic proxy but the handler forwards everything transparently.

const proxyGetRoute = createRoute({
  method: 'get',
  path: '/{path}',
  operationId: 'proxyGet',
  tags: ['LLM'],
  summary: 'Generic /v1/* proxy (GET)',
  description:
    'Catch-all GET proxy for any `/v1/*` path not handled by a more specific route above. ' +
    'Forwards to OpenRouter with your resolved credentials. ' +
    'Note: chat completions are routed by `model` prefix to OpenRouter or Vertex AI; ' +
    'this catch-all only covers OpenRouter-only paths (rarely needed once `/v1/models`, ' +
    '`/v1/auth/key`, `/v1/chat/completions`, and `/v1/responses` are accounted for).',
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      path: z.string().openapi({ example: 'credits' }),
    }),
  },
  responses: {
    200: { description: 'Proxied OpenRouter response' },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

const proxyPostRoute = createRoute({
  method: 'post',
  path: '/{path}',
  operationId: 'proxyPost',
  tags: ['LLM'],
  summary: 'Generic /v1/* proxy (POST)',
  description:
    'Catch-all POST proxy for any `/v1/*` path not handled by a more specific route above. ' +
    'Forwards to OpenRouter with your resolved credentials.',
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      path: z.string(),
    }),
  },
  responses: {
    200: { description: 'Proxied OpenRouter response' },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

/**
 * Shared catch-all proxy handler.
 *
 * Accepts `Context<AppEnv>` (not the route-specific generic) because this
 * handler is shared between GET and POST catch-all routes and returns a raw
 * proxied Response from OpenRouter — not a typed Hono response.
 */
async function handleProxy(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname.replace('/v1', '');
  const openRouterUrl = `${OPENROUTER_API}${path}${url.search}`;

  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth;

  const res = await proxy(openRouterUrl, {
    ...c.req,
    headers: {
      ...c.req.header(),
      Authorization: auth.authorization,
      host: undefined,
    },
  });
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}

// Proxy passthrough: the handler returns a raw Response from OpenRouter,
// not a typed Hono response matching the route's declared schema.
proxyRoutes.openapi(proxyGetRoute, async (c) => handleProxy(c) as any);
proxyRoutes.openapi(proxyPostRoute, async (c) => handleProxy(c) as any);
