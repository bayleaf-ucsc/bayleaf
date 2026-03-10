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
import type { AppEnv } from '../types';
import { OPENROUTER_API } from '../constants';
import { resolveAuth, type AuthResult } from '../utils/auth';
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ResponseRequestSchema,
  ApiErrorSchema,
} from '../schemas';

export const proxyRoutes = new OpenAPIHono<AppEnv>();

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
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
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
    messages?: Array<{ role: string; content: string }>;
    user?: string;
    [k: string]: unknown;
  };

  if (body.messages && Array.isArray(body.messages)) {
    const systemPrefix = buildSystemPrefix(c.env, auth.isCampusMode);
    const systemIndex = body.messages.findIndex(m => m.role === 'system');

    if (systemIndex >= 0) {
      body.messages[systemIndex].content =
        systemPrefix + '\n\n' + body.messages[systemIndex].content;
    } else {
      body.messages.unshift({ role: 'system', content: systemPrefix });
    }
  }

  injectUser(body, auth);

  // Proxy passthrough — see note on responsesRoute handler above.
  return forwardJson(`${OPENROUTER_API}/chat/completions`, auth.authorization, body) as any;
}, (result, c) => {
  if (!result.success) {
    // Hook return type is not modeled by the library's generics
    return c.json({ error: { message: 'Invalid JSON in request body.', code: 400 } }, 400) as any;
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

  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');

  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth;

  headers.set('Authorization', auth.authorization);

  const response = await fetch(openRouterUrl, {
    method: c.req.method,
    headers,
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}

// Proxy passthrough: the handler returns a raw Response from OpenRouter,
// not a typed Hono response matching the route's declared schema.
proxyRoutes.openapi(proxyGetRoute, async (c) => handleProxy(c) as any);
proxyRoutes.openapi(proxyPostRoute, async (c) => handleProxy(c) as any);
