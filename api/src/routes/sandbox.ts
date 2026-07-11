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
 *   GET  /              Report sandbox status without side effects (keyed only)
 *   POST /exec         Execute a bash command (campus-pass or keyed)
 *   POST /poke         Refresh the inactivity timer to prevent auto-stop (keyed only)
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
  type SandboxInfo,
  ensureSandbox,
  createEphemeralSandbox,
  waitForReady,
  waitForStarted,
  execCommand,
  downloadFile,
  uploadFile,
  findSandboxByLabel,
  getSandboxInfo,
  refreshActivity,
  deleteSandbox,
} from '../daytona';
import {
  SandboxExecRequestSchema,
  SandboxExecResponseSchema,
  SandboxUploadResponseSchema,
  SandboxDeleteResponseSchema,
  SandboxStatusResponseSchema,
  SandboxPokeResponseSchema,
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
 * Look up the user's sandbox WITHOUT side effects (no create, no start).
 * Mirrors the dashboard's status lookup: try the cached ID, fall back to a
 * label lookup, and self-heal the D1 cache when the two disagree. Returns
 * null when the user has no sandbox at all. Use this for read-only status;
 * use resolveSandboxId() when the sandbox must actually be running.
 */
async function lookupSandboxInfo(
  email: string,
  env: AppEnv['Bindings'],
): Promise<SandboxInfo | null> {
  const row = await env.DB.prepare(
    'SELECT daytona_sandbox_id FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(email).first<Pick<UserKeyRow, 'daytona_sandbox_id'>>();

  const cachedId = row?.daytona_sandbox_id ?? null;

  if (cachedId) {
    try {
      return await getSandboxInfo(cachedId, env);
    } catch {
      // Stale cached ID (deleted externally, 404, etc.) — fall through.
    }
  }

  const sandbox = await findSandboxByLabel(email, env);

  // Self-heal the cache when the label lookup found a different (or first) ID.
  if (sandbox && sandbox.id !== cachedId) {
    await env.DB.prepare(
      'UPDATE user_keys SET daytona_sandbox_id = ? WHERE email = ? AND revoked = 0',
    ).bind(sandbox.id, email).run();
  }

  return sandbox;
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

    // Non-campus auth always implies a `sk-bayleaf-` token, which always has
    // a userEmail. The TypeScript narrowing relies on resolveAuth's contract.
    const sandboxId = await resolveSandboxId(auth.userEmail!, c.env);
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
// File routes use plain Hono handlers (not .openapi()) because the path
// contains a multi-segment wildcard that @hono/zod-openapi's {param}
// syntax can't capture — it maps to Hono's `:param` which matches only
// one segment. We register the OpenAPI docs manually instead.

sandboxRoutes.openAPIRegistry.registerPath({
  method: 'get',
  path: '/sandbox/files/{path}',
  operationId: 'sandboxDownloadFile',
  tags: ['Sandbox'],
  summary: 'Download a file',
  description:
    'Downloads a file from the user\'s persistent sandbox by absolute path. ' +
    'Requires a BayLeaf API key (`sk-bayleaf-...`); Campus Pass cannot access files (no persistent sandbox).',
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
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
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

sandboxRoutes.get('/files/*', async (c) => {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth;

  if (auth.isCampusMode || !auth.userEmail) {
    return c.json({
      error: { message: 'File access requires a BayLeaf API key.', code: 403 },
    }, 403);
  }

  // Extract the file path from the URL. c.req.path includes the full path
  // (with the /sandbox mount prefix), e.g. /sandbox/files/home/daytona/...
  const filePath = c.req.path.replace(/^\/sandbox\/files/, '');

  try {
    const sandboxId = await resolveSandboxId(auth.userEmail, c.env);
    const resp = await downloadFile(sandboxId, filePath, c.env);

    if (!resp.ok) {
      const status = resp.status === 404 ? 404 : 502;
      const message = resp.status === 404 ? `File not found: ${filePath}` : 'Failed to download file.';
      return c.json({ error: { message, code: status } }, status as 404 | 502);
    }

    // Binary passthrough: forwarding raw file bytes from the sandbox provider.
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: 200, headers });
  } catch (e) {
    console.error('Sandbox file download error:', e);
    return c.json({
      error: { message: 'Failed to access sandbox file.', code: 502 },
    }, 502);
  }
});

// ── PUT /files/* ───────────────────────────────────────────────────

sandboxRoutes.openAPIRegistry.registerPath({
  method: 'put',
  path: '/sandbox/files/{path}',
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
          schema: { type: 'string', format: 'binary' },
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
        },
      },
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

sandboxRoutes.put('/files/*', async (c) => {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth;

  if (auth.isCampusMode || !auth.userEmail) {
    return c.json({
      error: { message: 'File access requires a BayLeaf API key.', code: 403 },
    }, 403);
  }

  const filePath = c.req.path.replace(/^\/sandbox\/files/, '');

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

// ── GET / (status) ─────────────────────────────────────────────────
// Registered manually (like the file routes) rather than via .openapi()
// because a createRoute() GET on path '/' collides with the DELETE '/'
// route in the generated OpenAPI spec: @hono/zod-openapi merges same-path
// path-items and drops one method depending on registration order. The
// Hono router itself dispatches both fine (it keys on method+path), so we
// keep a plain .get('/') handler and register the docs by hand.

sandboxRoutes.openAPIRegistry.registerPath({
  method: 'get',
  path: '/',
  operationId: 'sandboxStatus',
  tags: ['Sandbox'],
  summary: 'Get sandbox status',
  description:
    'Reports the current state of the user\'s persistent sandbox without side effects: ' +
    'it does **not** create or start a sandbox. Returns `state: "none"` when no sandbox ' +
    'exists yet (one is created automatically on the first `POST /sandbox/exec`). ' +
    'Requires a BayLeaf API key (`sk-bayleaf-...`); Campus Pass users have no persistent sandbox.',
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: 'Sandbox status',
      content: {
        'application/json': {
          schema: SandboxStatusResponseSchema,
          example: {
            id: 'a1b2c3d4', state: 'started', cpu: 1, memory: 1, disk: 3,
            autoStopInterval: 15, autoArchiveInterval: 60,
          },
        },
      },
    },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    403: {
      description: 'Sandbox status requires a BayLeaf API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    502: {
      description: 'Sandbox backend failure',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

sandboxRoutes.get('/', async (c) => {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth;

  if (auth.isCampusMode || !auth.userEmail) {
    return c.json({
      error: { message: 'Sandbox status requires a BayLeaf API key.', code: 403 },
    }, 403);
  }

  try {
    const sandbox = await lookupSandboxInfo(auth.userEmail, c.env);

    if (!sandbox) {
      return c.json({ id: null, state: 'none' }, 200);
    }

    return c.json({
      id: sandbox.id,
      state: sandbox.state,
      cpu: sandbox.cpu,
      memory: sandbox.memory,
      disk: sandbox.disk,
      autoStopInterval: sandbox.autoStopInterval,
      autoArchiveInterval: sandbox.autoArchiveInterval,
      createdAt: sandbox.createdAt,
      updatedAt: sandbox.updatedAt,
    }, 200);
  } catch (e) {
    console.error('Sandbox status error:', e);
    return c.json({
      error: { message: 'Failed to fetch sandbox status.', code: 502 },
    }, 502);
  }
});

// ── POST /poke ─────────────────────────────────────────────────────

const pokeRoute = createRoute({
  method: 'post',
  path: '/poke',
  operationId: 'sandboxPoke',
  tags: ['Sandbox'],
  summary: 'Keep the sandbox alive',
  description:
    'Refreshes the sandbox\'s inactivity timer to prevent it from auto-stopping ' +
    '(default: 15 minutes idle). If the sandbox is stopped or archived, it is ' +
    'started first — so a poke both wakes a sleeping sandbox and keeps a running ' +
    'one awake. Cheaper than a no-op `exec`. Requires a BayLeaf API key (`sk-bayleaf-...`).',
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: 'Inactivity timer refreshed',
      content: {
        'application/json': {
          schema: SandboxPokeResponseSchema,
          example: { id: 'a1b2c3d4', state: 'started', poked: true },
        },
      },
    },
    401: {
      description: 'Missing, invalid, or revoked API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    403: {
      description: 'Poke requires a BayLeaf API key',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    502: {
      description: 'Sandbox backend failure',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

sandboxRoutes.openapi(pokeRoute, async (c) => {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;

  if (auth.isCampusMode || !auth.userEmail) {
    return c.json({
      error: { message: 'Sandbox poke requires a BayLeaf API key.', code: 403 },
    }, 403);
  }

  try {
    // ensureSandbox() (via resolveSandboxId) starts a stopped/archived sandbox
    // and waits for 'started'. That lifecycle change already counts as activity;
    // refreshActivity() then resets the timer for an already-running sandbox.
    const sandboxId = await resolveSandboxId(auth.userEmail, c.env);
    await refreshActivity(sandboxId, c.env);
    return c.json({ id: sandboxId, state: 'started', poked: true as const }, 200);
  } catch (e) {
    console.error('Sandbox poke error:', e);
    return c.json({
      error: { message: 'Failed to poke sandbox.', code: 502 },
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
