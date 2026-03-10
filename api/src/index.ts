/**
 * BayLeaf API Server
 * 
 * A Cloudflare Worker that provides:
 * 1. OIDC authentication with UCSC Google accounts
 * 2. OpenRouter API key provisioning for authenticated users
 * 3. LLM inference proxy with campus-specific system prompt injection
 * 
 * @see https://bayleaf.dev
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './types';
import { errorPage } from './templates/layout';
import { getModelName } from './openrouter';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { keyRoutes } from './routes/key';
import { proxyRoutes } from './routes/proxy';
import { sandboxRoutes } from './routes/sandbox';
import { docsRoutes } from './routes/docs';

const app = new Hono<AppEnv>();

// CORS middleware
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

// Top-level API endpoint: current recommended model
app.get('/recommended-model', async (c) => {
  const model = c.env.RECOMMENDED_MODEL;
  const name = await getModelName(model);
  return c.json({ model, name: name ?? model });
});

// Mount route groups
app.route('/v1', proxyRoutes);
app.route('/sandbox', sandboxRoutes);
app.route('/docs', docsRoutes);
app.route('/', authRoutes);
app.route('/', keyRoutes);
app.route('/', dashboardRoutes);

// 404 fallback
app.notFound((c) => c.html(errorPage('Not Found', 'The page you requested does not exist.'), 404));

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.html(errorPage('Server Error', 'An unexpected error occurred.'), 500);
});

export default app;
