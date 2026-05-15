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
import { OPENROUTER_API, VERTEX_MODELS } from '../constants';
import { resolveAuth, type AuthResult } from '../utils/auth';
import { getGCPAccessToken } from '../utils/gcp';
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ResponseRequestSchema,
  ApiErrorSchema,
} from '../schemas';

export const proxyRoutes = new OpenAPIHono<AppEnv>();

// ── GET / (mounted as /v1) — bare root returns 200 OK ─────────────
// Some agent harnesses probe the base_url to test connectivity.
proxyRoutes.get('/', (c) => c.body(null, 200));

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
    // Enforce API key requirement for Vertex (no Campus Pass for now to ensure budget controls)
    if (!auth.userKeyRow) {
      return c.json({ error: { message: 'Vertex AI models are not available via anonymous Campus Pass. Please authenticate.', code: 403 } }, 403) as any;
    }

    const RPD_LIMIT = 100;
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
  description: 'Lists models available via OpenRouter (prefixed with openrouter:) and Vertex AI (prefixed with vertex:).',
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

    // Combine with Vertex models
    return c.json({ data: [...orModels, ...VERTEX_MODELS] }, 200, { 'Access-Control-Allow-Origin': '*' }) as any;
  } catch (e: any) {
    return c.json({ error: { message: `Failed to fetch models: ${e.message}`, code: 500 } }, 500, { 'Access-Control-Allow-Origin': '*' }) as any;
  }
});


// ── Catch-all — General OpenRouter proxy ──────────────────────────
// Paths like /models, /auth/key, etc. These are documented in OpenAPI
// as a generic proxy but the handler forwards everything transparently.

const proxyGetRoute = createRoute({
  method: 'get',
  path: '/{path}',
  operationId: 'proxyGet',
  tags: ['LLM'],
  summary: 'OpenRouter proxy (GET)',
  description:
    'Catch-all proxy for any OpenRouter `/v1/*` GET endpoint. ' +
    'The request is forwarded to `openrouter.ai/api/v1/{path}` with your resolved credentials. ' +
    'Notable paths: `/v1/models` (list available models), `/v1/auth/key` (check key usage).',
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      path: z.string().openapi({ example: 'models' }),
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
  summary: 'OpenRouter proxy (POST)',
  description:
    'Catch-all proxy for any OpenRouter `/v1/*` POST endpoint not listed above. ' +
    'The request is forwarded to `openrouter.ai/api/v1/{path}` with your resolved credentials.',
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
