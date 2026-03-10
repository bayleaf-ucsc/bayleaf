/**
 * Sandbox Route Handlers
 *
 * Proxies sandboxed code execution and file operations to the sandbox
 * provider (Daytona). Reuses the same auth model as the LLM proxy:
 *   - Campus Pass users get ephemeral one-shot sandboxes
 *   - Keyed users get persistent sandboxes identified by email
 *
 * Keyed users' sandbox IDs are cached in D1 (daytona_sandbox_id column)
 * to avoid a control-plane label lookup on every request — symmetric
 * with how we cache OpenRouter key hashes.
 *
 * Routes (mounted at /sandbox):
 *   POST /exec         Execute a bash command (campus-pass or keyed)
 *   GET  /files/*      Download a file by absolute path (keyed only)
 *   PUT  /files/*      Upload a file by absolute path (keyed only)
 *   DELETE /            Destroy the user's sandbox (keyed or session)
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv, UserKeyRow } from '../types';
import { resolveAuth } from '../utils/auth';
import { getSession } from '../utils/session';
import {
  type EnsureResult,
  ensureSandbox,
  createEphemeralSandbox,
  waitForReady,
  waitForStarted,
  execCommand,
  downloadFile,
  uploadFile,
  findSandboxByLabel,
  deleteSandbox,
} from '../daytona';
import {
  SandboxExecRequestSchema,
  SandboxExecResponseSchema,
  SandboxUploadResponseSchema,
  SandboxDeleteResponseSchema,
  ApiErrorSchema,
} from '../schemas';

export const sandboxRoutes = new OpenAPIHono<AppEnv>();

// ── Shared helper ──────────────────────────────────────────────────

/**
 * Resolve the user's sandbox ID via D1 cache → ensureSandbox().
 * Writes the sandbox ID back to D1 if it changed (new creation, or
 * cached ID was stale).  Returns the sandbox ID on success.
 */
async function resolveSandboxId(
  email: string,
  env: AppEnv['Bindings'],
): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT daytona_sandbox_id FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(email).first<Pick<UserKeyRow, 'daytona_sandbox_id'>>();

  const cachedId = row?.daytona_sandbox_id ?? null;
  const result: EnsureResult = await ensureSandbox(email, env, cachedId);

  if (result.changed) {
    await env.DB.prepare(
      'UPDATE user_keys SET daytona_sandbox_id = ? WHERE email = ? AND revoked = 0',
    ).bind(result.id, email).run();
  }

  return result.id;
}

/** Clear the cached sandbox ID in D1 for the given email. */
async function clearCachedSandboxId(
  email: string,
  env: AppEnv['Bindings'],
): Promise<void> {
  await env.DB.prepare(
    'UPDATE user_keys SET daytona_sandbox_id = NULL WHERE email = ?',
  ).bind(email).run();
}

/**
 * Handle ephemeral sandbox execution for campus-pass users.
 * Creates a sandbox, waits for it, executes the command, and tears it down.
 */
async function execEphemeral(
  command: string,
  workdir: string,
  env: AppEnv['Bindings'],
): Promise<{ exitCode: number; output: string }> {
  let sandboxId: string | null = null;

  try {
    const sandbox = await createEphemeralSandbox(env);
    sandboxId = sandbox.id;

    if (sandbox.state !== 'started') {
      await waitForStarted(sandboxId, env);
    }
    await waitForReady(sandboxId, env);

    return await execCommand(sandboxId, command, workdir, env);
  } finally {
    if (sandboxId) {
      deleteSandbox(sandboxId, env).catch((e) => {
        console.error('Ephemeral sandbox cleanup failed:', e);
      });
    }
  }
}

// ── POST /exec ─────────────────────────────────────────────────────

const execRoute = createRoute({
  method: 'post',
  path: '/exec',
  operationId: 'sandboxExec',
  tags: ['Sandbox'],
  summary: 'Execute a command',
  description:
    'Runs a bash command in a sandboxed Linux environment. ' +
    '**Keyed users** (`sk-bayleaf-...`) get a persistent sandbox that survives across requests. ' +
    '**Campus Pass users** (on-campus, no key) get an ephemeral sandbox created and destroyed per-request. ' +
    'Commands run with `set -e -o pipefail` and a 120-second timeout. ' +
    'The sandbox is a full Debian-based Linux environment with network access.',
  security: [{ Bearer: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: SandboxExecRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Command output',
      content: {
        'application/json': {
          schema: SandboxExecResponseSchema,
          example: { exitCode: 0, output: '4\n' },
        },
      },
    },
    400: {
      description: 'Missing or invalid `command` field',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    403: {
      description: 'Key type does not support sandbox (raw `sk-or-` keys)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    502: {
      description: 'Sandbox backend failure',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

sandboxRoutes.openapi(execRoute, async (c) => {
  const auth = await resolveAuth(c);
  // Auth guard: resolveAuth() returns a pre-built error Response when auth
  // fails — a raw Response, not a typed Hono response.
  if (auth instanceof Response) return auth as any;

  const { command, workdir } = c.req.valid('json');

  try {
    if (auth.isCampusMode) {
      const result = await execEphemeral(command, workdir, c.env);
      return c.json(result, 200);
    }

    if (!auth.userEmail) {
      return c.json({
        error: {
          message: 'Sandbox requires a BayLeaf API key (sk-bayleaf-...) or Campus Pass.',
          code: 403,
        },
      }, 403);
    }

    const sandboxId = await resolveSandboxId(auth.userEmail, c.env);
    const result = await execCommand(sandboxId, command, workdir, c.env);
    return c.json(result, 200);
  } catch (e) {
    console.error('Sandbox exec error:', e);
    return c.json({
      error: { message: 'Sandbox execution failed. Please try again.', code: 502 },
    }, 502);
  }
}, (result, c) => {
  if (!result.success) {
    // Hook return type is not modeled by the library's generics
    return c.json({
      error: { message: 'Missing required field: command', code: 400 },
    }, 400) as any;
  }
});

// ── GET /files/* ───────────────────────────────────────────────────

const downloadFileRoute = createRoute({
  method: 'get',
  path: '/files/{path}',
  operationId: 'sandboxDownloadFile',
  tags: ['Sandbox'],
  summary: 'Download a file',
  description:
    'Downloads a file from the user\'s persistent sandbox by absolute path. ' +
    'Requires a BayLeaf API key (`sk-bayleaf-...`); Campus Pass and raw OpenRouter keys cannot access files.',
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      path: z.string().openapi({
        description: 'Absolute file path inside the sandbox (e.g. `/home/daytona/workspace/output.txt`)',
        example: 'home/daytona/workspace/output.txt',
      }),
    }),
  },
  responses: {
    200: {
      description: 'File contents',
      content: { 'application/octet-stream': { schema: z.string() } },
    },
    400: {
      description: 'Missing file path',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    403: {
      description: 'File access requires a BayLeaf API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'File not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    502: {
      description: 'Sandbox backend failure',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

sandboxRoutes.openapi(downloadFileRoute, async (c) => {
  const auth = await resolveAuth(c);
  // Auth guard — see note on execRoute handler.
  if (auth instanceof Response) return auth as any;

  if (auth.isCampusMode || !auth.userEmail) {
    return c.json({
      error: { message: 'File access requires a BayLeaf API key.', code: 403 },
    }, 403);
  }

  const filePath = '/' + c.req.valid('param').path;

  try {
    const sandboxId = await resolveSandboxId(auth.userEmail, c.env);
    const resp = await downloadFile(sandboxId, filePath, c.env);

    if (!resp.ok) {
      const status = resp.status === 404 ? 404 : 502;
      const message = resp.status === 404 ? `File not found: ${filePath}` : 'Failed to download file.';
      return c.json({ error: { message, code: status } }, status as 404 | 502);
    }

    // Binary passthrough: forwarding raw file bytes from the sandbox
    // provider — not a typed Hono response.
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: 200, headers }) as any;
  } catch (e) {
    console.error('Sandbox file download error:', e);
    return c.json({
      error: { message: 'Failed to access sandbox file.', code: 502 },
    }, 502);
  }
});

// ── PUT /files/* ───────────────────────────────────────────────────

const uploadFileRoute = createRoute({
  method: 'put',
  path: '/files/{path}',
  operationId: 'sandboxUploadFile',
  tags: ['Sandbox'],
  summary: 'Upload a file',
  description:
    'Uploads a file to the user\'s persistent sandbox by absolute path. ' +
    'Parent directories are created automatically. ' +
    'Requires a BayLeaf API key (`sk-bayleaf-...`).',
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      path: z.string().openapi({
        description: 'Absolute file path inside the sandbox',
        example: 'home/daytona/workspace/input.txt',
      }),
    }),
    body: {
      required: true,
      content: {
        'application/octet-stream': {
          schema: z.string(),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Upload confirmation',
      content: {
        'application/json': {
          schema: SandboxUploadResponseSchema,
          example: { success: true, path: '/home/daytona/workspace/input.txt', bytes: 1234 },
        },
      },
    },
    400: {
      description: 'Missing file path',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    403: {
      description: 'File access requires a BayLeaf API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    502: {
      description: 'Sandbox backend failure',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

sandboxRoutes.openapi(uploadFileRoute, async (c) => {
  const auth = await resolveAuth(c);
  // Auth guard — see note on execRoute handler.
  if (auth instanceof Response) return auth as any;

  if (auth.isCampusMode || !auth.userEmail) {
    return c.json({
      error: { message: 'File access requires a BayLeaf API key.', code: 403 },
    }, 403);
  }

  const filePath = '/' + c.req.valid('param').path;

  try {
    const body = await c.req.arrayBuffer();
    const sandboxId = await resolveSandboxId(auth.userEmail, c.env);
    await uploadFile(sandboxId, filePath, body, c.env);

    return c.json({ success: true as const, path: filePath, bytes: body.byteLength }, 200);
  } catch (e) {
    console.error('Sandbox file upload error:', e);
    return c.json({
      error: { message: 'Failed to upload file to sandbox.', code: 502 },
    }, 502);
  }
});

// ── DELETE / ───────────────────────────────────────────────────────

const deleteSandboxRoute = createRoute({
  method: 'delete',
  path: '/',
  operationId: 'sandboxDelete',
  tags: ['Sandbox'],
  summary: 'Destroy sandbox',
  description:
    'Permanently destroys the user\'s persistent sandbox and all its data. This is irreversible.',
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: 'Deletion result',
      content: {
        'application/json': {
          schema: SandboxDeleteResponseSchema,
        },
      },
    },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    502: {
      description: 'Sandbox backend failure',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

sandboxRoutes.openapi(deleteSandboxRoute, async (c) => {
  let email: string | null = null;

  const auth = await resolveAuth(c);
  if (!(auth instanceof Response) && auth.userEmail) {
    email = auth.userEmail;
  }

  if (!email) {
    const session = await getSession(c);
    if (session) email = session.email;
  }

  if (!email) {
    return c.json({ error: { message: 'Unauthorized', code: 401 } }, 401);
  }

  try {
    const row = await c.env.DB.prepare(
      'SELECT daytona_sandbox_id FROM user_keys WHERE email = ? AND revoked = 0',
    ).bind(email).first<Pick<UserKeyRow, 'daytona_sandbox_id'>>();

    let sandboxId = row?.daytona_sandbox_id ?? null;

    if (!sandboxId) {
      const sandbox = await findSandboxByLabel(email, c.env);
      sandboxId = sandbox?.id ?? null;
    }

    if (!sandboxId) {
      return c.json({ success: true as const, message: 'No sandbox found.' }, 200);
    }

    await deleteSandbox(sandboxId, c.env);
    await clearCachedSandboxId(email, c.env);
    return c.json({ success: true as const, message: 'Sandbox deleted.' }, 200);
  } catch (e) {
    console.error('Sandbox delete error:', e);
    return c.json({
      error: { message: 'Failed to delete sandbox.', code: 502 },
    }, 502);
  }
});
