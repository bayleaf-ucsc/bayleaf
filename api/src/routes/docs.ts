/**
 * Documentation Routes
 *
 * Machine-facing API documentation served under /docs:
 *   GET /docs               — Interactive API docs (Scalar viewer)
 *   GET /docs/openapi.json  — OpenAPI 3.1 spec (dynamic, embeds current recommended model)
 *   GET /docs/SKILL.md      — Agent skill file describing BayLeaf's machine-facing API surface
 *
 * Note: GET /recommended-model is a top-level API endpoint, not a doc route.
 * It lives in index.ts because it's an operational endpoint that tools poll,
 * not documentation about the API.
 *
 * These endpoints are all public and unauthenticated.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getModelName } from '../openrouter';

export const docsRoutes = new Hono<AppEnv>();

// ── GET /openapi.json ─────────────────────────────────────────────

docsRoutes.get('/openapi.json', async (c) => {
  const model = c.env.RECOMMENDED_MODEL;
  const name = await getModelName(model) ?? model;

  const spec = buildOpenApiSpec(model, name);
  return c.json(spec, 200, { 'Cache-Control': 'public, max-age=300' });
});

// ── GET / — Scalar API reference viewer ───────────────────────────

docsRoutes.get('/', (c) => {
  const html = `<!doctype html>
<html>
<head>
  <title>BayLeaf API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/docs/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
  return c.html(html);
});

// ── GET /SKILL.md ─────────────────────────────────────────────────

docsRoutes.get('/SKILL.md', async (c) => {
  const model = c.env.RECOMMENDED_MODEL;
  const name = await getModelName(model) ?? model;
  const content = buildSkillMd(model, name);
  return c.text(content, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

// ── OpenAPI spec builder ──────────────────────────────────────────

function buildOpenApiSpec(model: string, modelName: string): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'BayLeaf API',
      version: '1.0.0',
      description:
        "BayLeaf API provides free LLM inference and sandboxed code execution for the UC Santa Cruz campus community. " +
        "It is an OpenAI-compatible proxy backed by OpenRouter, restricted to zero-data-retention endpoints.\n\n" +
        "**Authentication:** Include `Authorization: Bearer <key>` on all requests. " +
        "On the UCSC campus network, you may omit the header entirely (Campus Pass). " +
        "Off-campus, provision a free personal key at https://api.bayleaf.dev/.\n\n" +
        `**Recommended model:** \`${model}\` (${modelName}). ` +
        "Fetch the latest recommendation from [/recommended-model](/recommended-model).",
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
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'LLM', description: 'OpenAI-compatible inference endpoints (proxied to OpenRouter)' },
      { name: 'Sandbox', description: 'Sandboxed Linux code execution and file I/O' },
      { name: 'Meta', description: 'API metadata and documentation' },
    ],
    paths: {
      '/v1/chat/completions': {
        post: {
          operationId: 'chatCompletions',
          tags: ['LLM'],
          summary: 'Chat Completions',
          description:
            'OpenAI-compatible chat completions endpoint. Supports streaming via `stream: true`. ' +
            'A system prompt identifying the BayLeaf service is prepended automatically; ' +
            'if you include your own system message, the prefix is prepended to it.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
                example: {
                  model,
                  messages: [
                    { role: 'user', content: 'Explain the halting problem in one paragraph.' },
                  ],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Completion result (or SSE stream if `stream: true`)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatCompletionResponse' },
                },
                'text/event-stream': {
                  description: 'Server-sent events stream (when stream: true)',
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/v1/responses': {
        post: {
          operationId: 'createResponse',
          tags: ['LLM'],
          summary: 'Responses API',
          description:
            'OpenAI Responses API endpoint. The BayLeaf system prompt is injected via the `instructions` field. ' +
            'If you provide your own `instructions`, the prefix is prepended.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ResponseRequest' },
                example: {
                  model,
                  input: 'What is the capital of France?',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Response result',
              content: {
                'application/json': {
                  schema: { type: 'object', description: 'OpenAI Responses API response object' },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/v1/{path}': {
        get: {
          operationId: 'proxyGet',
          tags: ['LLM'],
          summary: 'OpenRouter proxy (GET)',
          description:
            'Catch-all proxy for any OpenRouter `/v1/*` GET endpoint. ' +
            'The request is forwarded to `openrouter.ai/api/v1/{path}` with your resolved credentials. ' +
            'Notable paths: `/v1/models` (list available models), `/v1/auth/key` (check key usage).',
          parameters: [
            { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Proxied OpenRouter response' },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
        post: {
          operationId: 'proxyPost',
          tags: ['LLM'],
          summary: 'OpenRouter proxy (POST)',
          description:
            'Catch-all proxy for any OpenRouter `/v1/*` POST endpoint not listed above. ' +
            'The request is forwarded to `openrouter.ai/api/v1/{path}` with your resolved credentials.',
          parameters: [
            { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Proxied OpenRouter response' },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },

      '/sandbox/exec': {
        post: {
          operationId: 'sandboxExec',
          tags: ['Sandbox'],
          summary: 'Execute a command',
          description:
            'Runs a bash command in a sandboxed Linux environment. ' +
            '**Keyed users** (`sk-bayleaf-...`) get a persistent sandbox that survives across requests. ' +
            '**Campus Pass users** (on-campus, no key) get an ephemeral sandbox created and destroyed per-request. ' +
            'Commands run with `set -e -o pipefail` and a 120-second timeout. ' +
            'The sandbox is a full Debian-based Linux environment with network access.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SandboxExecRequest' },
                example: {
                  command: 'python3 -c "print(2+2)"',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Command output',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SandboxExecResponse' },
                  example: { exitCode: 0, output: '4\n' },
                },
              },
            },
            '400': { description: 'Missing or invalid `command` field' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Key type does not support sandbox (raw `sk-or-` keys)' },
            '502': { description: 'Sandbox backend failure' },
          },
        },
      },
      '/sandbox/files/{path}': {
        get: {
          operationId: 'sandboxDownloadFile',
          tags: ['Sandbox'],
          summary: 'Download a file',
          description:
            'Downloads a file from the user\'s persistent sandbox by absolute path. ' +
            'Requires a BayLeaf API key (`sk-bayleaf-...`); Campus Pass and raw OpenRouter keys cannot access files.',
          parameters: [
            {
              name: 'path',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Absolute file path inside the sandbox (e.g. `/home/daytona/workspace/output.txt`)',
              example: '/home/daytona/workspace/output.txt',
            },
          ],
          responses: {
            '200': {
              description: 'File contents',
              content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
            },
            '400': { description: 'Missing file path' },
            '403': { description: 'File access requires a BayLeaf API key' },
            '404': { description: 'File not found' },
            '502': { description: 'Sandbox backend failure' },
          },
        },
        put: {
          operationId: 'sandboxUploadFile',
          tags: ['Sandbox'],
          summary: 'Upload a file',
          description:
            'Uploads a file to the user\'s persistent sandbox by absolute path. ' +
            'Parent directories are created automatically. ' +
            'Requires a BayLeaf API key (`sk-bayleaf-...`).',
          parameters: [
            {
              name: 'path',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Absolute file path inside the sandbox',
              example: '/home/daytona/workspace/input.txt',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Upload confirmation',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', const: true },
                      path: { type: 'string' },
                      bytes: { type: 'integer' },
                    },
                  },
                  example: { success: true, path: '/home/daytona/workspace/input.txt', bytes: 1234 },
                },
              },
            },
            '400': { description: 'Missing file path' },
            '403': { description: 'File access requires a BayLeaf API key' },
            '502': { description: 'Sandbox backend failure' },
          },
        },
      },
      '/sandbox': {
        delete: {
          operationId: 'sandboxDelete',
          tags: ['Sandbox'],
          summary: 'Destroy sandbox',
          description:
            'Permanently destroys the user\'s persistent sandbox and all its data. This is irreversible.',
          responses: {
            '200': {
              description: 'Deletion result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', const: true },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '502': { description: 'Sandbox backend failure' },
          },
        },
      },

      '/recommended-model': {
        get: {
          operationId: 'getRecommendedModel',
          tags: ['Meta'],
          summary: 'Recommended model',
          description:
            'Returns the currently recommended model slug and display name. ' +
            'Use this to stay up-to-date as the recommendation changes over time.',
          security: [],
          responses: {
            '200': {
              description: 'Recommended model info',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['model', 'name'],
                    properties: {
                      model: { type: 'string', example: model },
                      name: { type: 'string', example: modelName },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/docs/openapi.json': {
        get: {
          operationId: 'getOpenApiSpec',
          tags: ['Meta'],
          summary: 'OpenAPI specification',
          description: 'This OpenAPI 3.1 specification document.',
          security: [],
          responses: {
            '200': {
              description: 'OpenAPI 3.1 JSON document',
              content: { 'application/json': {} },
            },
          },
        },
      },
      '/docs/SKILL.md': {
        get: {
          operationId: 'getSkillMd',
          tags: ['Meta'],
          summary: 'Agent skill file',
          description:
            'Markdown skill file describing BayLeaf\'s machine-facing API surface ' +
            'for agent frameworks and coding assistants.',
          security: [],
          responses: {
            '200': {
              description: 'Markdown document',
              content: { 'text/markdown': {} },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'BayLeaf API key (`sk-bayleaf-...`), or omit entirely on the UCSC campus network for Campus Pass access.',
        },
      },
      schemas: {
        ChatCompletionRequest: {
          type: 'object',
          required: ['model', 'messages'],
          properties: {
            model: {
              type: 'string',
              description: 'Model ID. Any model available on OpenRouter is accepted.',
              example: model,
            },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                  content: { type: 'string' },
                },
              },
            },
            stream: {
              type: 'boolean',
              default: false,
              description: 'If true, response is streamed as server-sent events.',
            },
            temperature: { type: 'number', description: 'Sampling temperature (0-2).' },
            max_tokens: { type: 'integer', description: 'Maximum tokens to generate.' },
          },
          additionalProperties: true,
          description:
            'Standard OpenAI chat completion request. All OpenAI and OpenRouter-specific parameters are accepted and forwarded.',
        },
        ChatCompletionResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', const: 'chat.completion' },
            model: { type: 'string' },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  message: {
                    type: 'object',
                    properties: {
                      role: { type: 'string' },
                      content: { type: 'string' },
                    },
                  },
                  finish_reason: { type: 'string' },
                },
              },
            },
            usage: {
              type: 'object',
              properties: {
                prompt_tokens: { type: 'integer' },
                completion_tokens: { type: 'integer' },
                total_tokens: { type: 'integer' },
              },
            },
          },
        },
        ResponseRequest: {
          type: 'object',
          required: ['model', 'input'],
          properties: {
            model: {
              type: 'string',
              description: 'Model ID.',
              example: model,
            },
            input: {
              description: 'The input to the model. Can be a string or array of message objects.',
              oneOf: [
                { type: 'string' },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      role: { type: 'string' },
                      content: { type: 'string' },
                    },
                  },
                },
              ],
            },
            instructions: {
              type: 'string',
              description: 'System instructions. BayLeaf prepends its own prefix to this field.',
            },
          },
          additionalProperties: true,
          description: 'OpenAI Responses API request. All parameters are forwarded to OpenRouter.',
        },
        SandboxExecRequest: {
          type: 'object',
          required: ['command'],
          properties: {
            command: {
              type: 'string',
              description: 'Bash command to execute. Runs under `set -e -o pipefail` with a 120s timeout.',
            },
            workdir: {
              type: 'string',
              default: '/home/daytona/workspace',
              description: 'Working directory for the command.',
            },
          },
        },
        SandboxExecResponse: {
          type: 'object',
          properties: {
            exitCode: {
              type: 'integer',
              description: 'Exit code of the command (0 = success).',
            },
            output: {
              type: 'string',
              description: 'Combined stdout and stderr output.',
            },
          },
        },
        ApiError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                code: { type: 'integer' },
              },
              required: ['message', 'code'],
            },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing, invalid, or revoked API key. On-campus users can omit the key for Campus Pass access.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ApiError' },
              example: {
                error: {
                  message: 'API key required. On-campus users can omit the key or use "campus". Visit https://api.bayleaf.dev/ for a free personal key.',
                  code: 401,
                },
              },
            },
          },
        },
      },
    },
  };
}

// ── SKILL.md builder ──────────────────────────────────────────────

function buildSkillMd(model: string, modelName: string): string {
  const bt = '`';
  const fence = '```';

  return `---
name: bayleaf-api
description: Use the BayLeaf API for LLM inference, sandboxed code execution, and model discovery at UC Santa Cruz.
---

# BayLeaf API

BayLeaf API (${bt}https://api.bayleaf.dev${bt}) provides free LLM inference and sandboxed
code execution for the UC Santa Cruz campus community. All inference uses
zero-data-retention providers — conversations are never used for training.

Full OpenAPI 3.1 spec: ${bt}https://api.bayleaf.dev/docs/openapi.json${bt}

---

## Authentication

All machine-facing endpoints accept ${bt}Authorization: Bearer <key>${bt}.

| Method | When to use |
|--------|-------------|
| **BayLeaf key** (${bt}sk-bayleaf-...${bt}) | Off-campus, or when you need a persistent sandbox and file access. Provision free at ${bt}https://api.bayleaf.dev/${bt}. |
| **Campus Pass** (omit header) | On the UCSC campus network. No key needed. Sandbox access is ephemeral (one-shot). |

Daily spending limit per key: $1 (resets daily). All rate limiting is handled by the
upstream provider — the API itself imposes no request-rate limits.

---

## LLM Inference

BayLeaf is an OpenAI-compatible proxy. Point any OpenAI-compatible client at
${bt}https://api.bayleaf.dev/v1${bt} with your key and it works.

### Chat Completions

${fence}
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-bayleaf-...

{
  "model": "${model}",
  "messages": [
    { "role": "user", "content": "Explain the halting problem in one paragraph." }
  ]
}
${fence}

Supports ${bt}stream: true${bt} for SSE streaming. All standard OpenAI parameters
(${bt}temperature${bt}, ${bt}max_tokens${bt}, ${bt}tools${bt}, etc.) are forwarded to OpenRouter.

### Responses API

${fence}
POST /v1/responses
Content-Type: application/json
Authorization: Bearer sk-bayleaf-...

{
  "model": "${model}",
  "input": "What is the capital of France?"
}
${fence}

### Other OpenRouter endpoints

Any ${bt}/v1/*${bt} path is proxied directly to OpenRouter. This includes endpoints like
${bt}/v1/models${bt} (list available models), ${bt}/v1/auth/key${bt} (check your key usage),
and any future OpenRouter endpoints. The proxy does no model filtering — any model
ID accepted by OpenRouter works.

---

## Sandboxed Code Execution

BayLeaf provides sandboxed Linux environments for running code.

### Execute a command

${fence}
POST /sandbox/exec
Content-Type: application/json
Authorization: Bearer sk-bayleaf-...

{
  "command": "python3 -c \\"print(2+2)\\"",
  "workdir": "/home/daytona/workspace"
}
${fence}

Response:

${fence}json
{ "exitCode": 0, "output": "4\\n" }
${fence}

- Commands run under ${bt}set -e -o pipefail${bt} with a 120-second timeout.
- The sandbox is a full Debian-based Linux environment with network access.
- ${bt}workdir${bt} defaults to ${bt}/home/daytona/workspace${bt} if omitted.
- **Keyed users** get a persistent sandbox that survives across requests.
- **Campus Pass users** get an ephemeral sandbox that is created and destroyed per-request.

### Download a file

${fence}
GET /sandbox/files/home/daytona/workspace/output.txt
Authorization: Bearer sk-bayleaf-...
${fence}

Returns the raw file bytes. Requires a BayLeaf API key (persistent sandbox only).

### Upload a file

${fence}
PUT /sandbox/files/home/daytona/workspace/input.txt
Authorization: Bearer sk-bayleaf-...
Content-Type: application/octet-stream

<file bytes>
${fence}

Response:

${fence}json
{ "success": true, "path": "/home/daytona/workspace/input.txt", "bytes": 1234 }
${fence}

Parent directories are created automatically. Requires a BayLeaf API key.

### Destroy sandbox

${fence}
DELETE /sandbox
Authorization: Bearer sk-bayleaf-...
${fence}

Permanently destroys the sandbox and all its data.

---

## Model Recommendation

The recommended model changes over time. Fetch the current recommendation:

${fence}
GET /recommended-model
${fence}

Response:

${fence}json
{ "model": "${model}", "name": "${modelName}" }
${fence}

No authentication required.

---

## OpenCode Setup

To use BayLeaf as an [OpenCode](https://opencode.ai) provider:

### 1. Add provider config

Add to ${bt}~/.config/opencode/opencode.json${bt} (create if needed; merge into existing
${bt}"provider"${bt} object if the file already exists):

${fence}json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "bayleaf": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "BayLeaf API",
      "options": {
        "baseURL": "https://api.bayleaf.dev/v1"
      },
      "models": {
        "${model}": {
          "name": "${modelName}"
        }
      }
    }
  }
}
${fence}

Restart OpenCode after any config change.

### 2. Store the API key

Run ${bt}/connect${bt} in OpenCode, select **BayLeaf API** (under **Other**), and paste
your ${bt}sk-bayleaf-...${bt} key.

### 3. Select the model

Run ${bt}/models${bt} and select ${bt}${model}${bt} under BayLeaf API.
`;
}
