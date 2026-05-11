/**
 * Web Route Handlers
 *
 * Exposes web search and page content fetching as API endpoints, symmetric
 * with how /sandbox/* wraps Daytona. Provider-agnostic contract: the API
 * shape is stable even if Tavily is swapped for another provider.
 *
 * Routes (mounted at /web):
 *   POST /search   Search the web (Tavily)
 *   POST /fetch    Fetch and extract page content from one or more URLs (Tavily Extract)
 *
 * Auth: resolveAuth() — Campus Pass and keyed users both get access.
 * No per-user state, no D1 rows needed (stateless service).
 */

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { resolveAuth } from '../utils/auth';
import { searchWeb, fetchPage } from '../web';
import {
  WebSearchRequestSchema,
  WebSearchResponseSchema,
  WebFetchRequestSchema,
  WebFetchResponseSchema,
  ApiErrorSchema,
} from '../schemas';

export const webRoutes = new OpenAPIHono<AppEnv>();

// ── POST /search ───────────────────────────────────────────────────

const searchRoute = createRoute({
  method: 'post',
  path: '/search',
  operationId: 'webSearch',
  tags: ['Web'],
  summary: 'Search the web',
  description:
    'Search the web and return ranked results with snippets. ' +
    'Optionally includes an AI-generated summary answer.',
  security: [{ Bearer: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: WebSearchRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Search results',
      content: {
        'application/json': {
          schema: WebSearchResponseSchema,
          example: {
            results: [
              { title: 'UCSC Computational Media', url: 'https://cmp.ucsc.edu', snippet: '...' },
            ],
            answer: 'UC Santa Cruz offers a Computational Media program...',
          },
        },
      },
    },
    400: {
      description: 'Missing or invalid request body',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    502: {
      description: 'Search provider failure',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

webRoutes.openapi(searchRoute, async (c) => {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;

  const { query, max_results } = c.req.valid('json');

  try {
    const result = await searchWeb(query, max_results, c.env);
    return c.json(result, 200);
  } catch (e) {
    console.error('Web search error:', e);
    return c.json({
      error: { message: 'Web search failed. Please try again.', code: 502 },
    }, 502);
  }
}, (result, c) => {
  if (!result.success) {
    return c.json({
      error: { message: 'Missing required field: query', code: 400 },
    }, 400) as any;
  }
});

// ── POST /fetch ────────────────────────────────────────────────────

const fetchRoute = createRoute({
  method: 'post',
  path: '/fetch',
  operationId: 'webFetch',
  tags: ['Web'],
  summary: 'Fetch page content',
  description:
    'Fetch one or more web pages and extract their content as clean markdown or plain text. ' +
    'Pass a single URL string for one page, or an array of URLs (up to 20) to fetch many in a single call. ' +
    'Useful for feeding web content to LLMs or other processing pipelines.',
  security: [{ Bearer: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: WebFetchRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Page content',
      content: {
        'application/json': {
          schema: WebFetchResponseSchema,
          example: {
            results: [
              {
                url: 'https://example.com/article',
                content: '# Article Title\n\nContent here...',
              },
            ],
          },
        },
      },
    },
    400: {
      description: 'Missing or invalid request body',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    502: {
      description: 'Fetch provider failure',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

webRoutes.openapi(fetchRoute, async (c) => {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;

  const { urls, format } = c.req.valid('json');

  try {
    const result = await fetchPage(urls, format, c.env);
    return c.json(result, 200);
  } catch (e) {
    console.error('Web fetch error:', e);
    return c.json({
      error: { message: 'Failed to fetch page content. Please try again.', code: 502 },
    }, 502);
  }
}, (result, c) => {
  if (!result.success) {
    return c.json({
      error: { message: 'Missing or invalid required field: urls', code: 400 },
    }, 400) as any;
  }
});