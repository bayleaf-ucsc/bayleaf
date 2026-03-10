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
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ),
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
      content: z.string(),
    })),
  ]).openapi({
    description: 'The input to the model. Can be a string or array of message objects.',
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

// ── Key management ───────────────────────────────────────────────

export const KeyInfoResponseSchema = z.object({
  exists: z.literal(true),
  key: z.object({
    usage_daily: z.number(),
    usage_monthly: z.number(),
    limit: z.number().nullable(),
    limit_remaining: z.number().nullable(),
    created_at: z.string(),
  }),
}).openapi('KeyInfoResponse');

export const KeyCreatedResponseSchema = z.object({
  success: z.literal(true),
  key: z.string().openapi({
    description: 'The new BayLeaf API key (sk-bayleaf-...). Store it securely — it cannot be retrieved again.',
  }),
}).openapi('KeyCreatedResponse');

export const KeyRevokedResponseSchema = z.object({
  success: z.literal(true),
}).openapi('KeyRevokedResponse');

// ── Meta ─────────────────────────────────────────────────────────

export const RecommendedModelResponseSchema = z.object({
  model: z.string(),
  name: z.string(),
}).openapi('RecommendedModelResponse');
