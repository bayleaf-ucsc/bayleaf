/**
 * BayLeaf Courses Server
 *
 * A Cloudflare Worker that provides self-service course AI model
 * management for the UC Santa Cruz community. Instructors link Canvas
 * courses to BayLeaf Chat models; students install them with one click.
 *
 * Plain Hono (no OpenAPI) — server-rendered HTML with hono/jsx.
 *
 * @see https://bayleaf.dev
 */

import { Hono } from 'hono';
import type { AppEnv } from './types';
import { renderErrorPage } from './templates/layout';
import { dalMiddleware, requireSession } from './middleware';
import { authRoutes } from './routes/auth';
import { landingRoutes } from './routes/landing';
import { courseRoutes } from './routes/courses';

const app = new Hono<AppEnv>();

// -- Global middleware: inject DALs on every request ------------------

app.use('*', dalMiddleware);

// -- Public routes (no session required) ------------------------------

app.route('/', authRoutes);
app.route('/', landingRoutes);

// -- Protected routes (session required) ------------------------------

app.use('/courses/*', requireSession);
app.route('/', courseRoutes);

// -- 404 fallback -----------------------------------------------------

app.notFound((c) => c.html(renderErrorPage('Not Found', 'The page you requested does not exist.'), 404));

// -- Error handler ----------------------------------------------------

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.html(renderErrorPage('Server Error', 'An unexpected error occurred.'), 500);
});

export default app;
