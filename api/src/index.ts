/**
 * BayLeaf API Server
 *
 * A Cloudflare Worker that provides:
 * 1. OIDC authentication (provider-agnostic: CILogon, Google, etc.)
 * 2. OpenRouter API key provisioning for authenticated users
 * 3. LLM inference proxy with campus-specific system prompt injection
 * 4. Sandboxed code execution (Daytona)
 *
 * OpenAPI spec is auto-generated from Zod schemas via @hono/zod-openapi.
 *
 * @see https://bayleaf.dev
 */

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import type { AppEnv } from './types';
import { renderErrorPage } from './templates/layout';
import { getModelInfo } from './openrouter';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { keyRoutes } from './routes/key';
import { proxyRoutes } from './routes/proxy';
import { sandboxRoutes } from './routes/sandbox';
import { docsRoutes } from './routes/docs';
import { RecommendedModelResponseSchema } from './schemas';

const app = new OpenAPIHono<AppEnv>();

// ── Security scheme (shared across all routes) ───────────────────

app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
  type: 'http',
  scheme: 'bearer',
  description:
    'BayLeaf API key (`sk-bayleaf-...`), or omit entirely on the UCSC campus network for Campus Pass access.',
});

// ── CORS middleware ───────────────────────────────────────────────

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400,
}));

// Redirect old /api/v1/* paths for backwards compatibility
app.all('/api/v1/*', (c) => c.redirect(c.req.url.replace('/api/v1', '/v1'), 301));

// Redirects
app.get('/docs/', (c) => c.redirect('/docs', 301));

// ── Top-level API endpoint: recommended model ─────────────────────

const recommendedModelRoute = createRoute({
  method: 'get',
  path: '/recommended-model',
  operationId: 'getRecommendedModel',
  tags: ['Meta'],
  summary: 'Recommended model',
  description:
    'Returns the currently recommended model slug and display name. ' +
    'Use this to stay up-to-date as the recommendation changes over time.',
  security: [],
  responses: {
    200: {
      description: 'Recommended model info',
      content: {
        'application/json': {
          schema: RecommendedModelResponseSchema,
        },
      },
    },
  },
});

app.openapi(recommendedModelRoute, async (c) => {
  const model = c.env.RECOMMENDED_MODEL;
  const info = await getModelInfo(model);
  return c.json({ model, name: info?.name ?? model }, 200);
});

// ── Mount route groups ────────────────────────────────────────────

app.route('/v1', proxyRoutes);
app.route('/sandbox', sandboxRoutes);
app.route('/docs', docsRoutes);
app.route('/', authRoutes);
app.route('/', keyRoutes);
app.route('/', dashboardRoutes);

// ── Auto-generated OpenAPI spec ──────────────────────────────────

app.doc31('/docs/openapi.json', (c) => ({
  openapi: '3.1.0',
  info: {
    title: 'BayLeaf API',
    version: '1.0.0',
    description:
      'BayLeaf API provides free LLM inference and sandboxed code execution for the UC Santa Cruz campus community. ' +
      'It is an OpenAI-compatible proxy backed by OpenRouter, restricted to zero-data-retention endpoints.\n\n' +
      '**Authentication:** Include `Authorization: Bearer <key>` on all requests. ' +
      'On the UCSC campus network, you may omit the header entirely (Campus Pass). ' +
      'Off-campus, provision a free personal key at https://api.bayleaf.dev/.\n\n' +
      `**Recommended model:** \`${c.env.RECOMMENDED_MODEL}\`. ` +
      'Fetch the latest recommendation from [/recommended-model](/recommended-model).',
    contact: {
      name: 'Adam Smith',
      url: 'https://bayleaf.dev',
      email: 'amsmith@ucsc.edu',
    },
    license: {
      name: 'MIT',
      url: 'https://github.com/rndmcnlly/bayleaf/blob/main/api/LICENSE',
    },
  },
  servers: [
    { url: 'https://api.bayleaf.dev', description: 'Production' },
  ],
  security: [{ Bearer: [] }],
  tags: [
    { name: 'LLM', description: 'OpenAI-compatible inference endpoints (proxied to OpenRouter)' },
    { name: 'Sandbox', description: 'Sandboxed Linux code execution and file I/O' },
    { name: 'Key', description: 'API key management (session-authenticated)' },
    { name: 'Meta', description: 'API metadata and documentation' },
  ],
}));

// ── 404 fallback ──────────────────────────────────────────────────

app.notFound((c) => c.html(renderErrorPage('Not Found', 'The page you requested does not exist.'), 404));

// ── Error handler ─────────────────────────────────────────────────

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.html(renderErrorPage('Server Error', 'An unexpected error occurred.'), 500);
});

export default app;
