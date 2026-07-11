/**
 * Zod Schemas
 *
 * Single source of truth for request/response validation AND OpenAPI spec
 * generation. Every schema here is used both at runtime (via Zod parse) and
 * at doc-generation time (via @hono/zod-openapi).
 */

import { z } from '@hono/zod-openapi';

// ── Shared ────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.number().int(),
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
    description: 'System instructions. BayLeaf prepends its own prefix to this field.',
  }),
}).passthrough().openapi('ResponseRequest');

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
// The /key endpoints are dashboard plumbing (browser session-gated,
// called by the dashboard JS to provision/inspect/revoke a personal key).
// They are intentionally not part of the public OpenAPI surface, so no
// schemas are exported here. Agent-facing budget introspection lives at
// /v1/auth/key, which works with bearer tokens and reports both backends.

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
