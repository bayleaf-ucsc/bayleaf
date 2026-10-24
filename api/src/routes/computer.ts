/** Owner-only computer-use facade. Toolbox traffic counts as Daytona activity,
 * including reads, but never creates, starts, resumes or installs anything.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { resolveAuth } from '../utils/auth';
import { GRANT_PREFIX } from '../grants';
import { callerAuthority } from '../sandboxCredentials';
import { computerError, sessionEnded, desktopGeneration, computerToolbox, field,
  openComputerSession, verifyComputerSession, checkComputerFloor } from '../computerUse';
import { ApiErrorSchema, ComputerSessionRequestSchema, ComputerSessionSchema, ComputerSessionResponseSchema,
  ComputerActionSchemas, ComputerActionResponseSchema, ComputerScreenshotSchema, ComputerCompressedScreenshotSchema,
  ComputerScreenshotResponseSchema, ComputerDisplayResponseSchema, ComputerWindowsResponseSchema } from '../schemas';

export const computerRoutes = new OpenAPIHono<AppEnv>();
computerRoutes.onError((_error, c) => c.req.path.endsWith('/session')
  ? computerError(502, 'computer_unavailable', 'Computer-use service unavailable.') : sessionEnded());
const invalid = () => computerError(400, 'invalid_request', 'Invalid computer-use request. Consult OpenAPI.');

computerRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // Catch locally: content-bearing parser/provider exceptions must never reach
  // index.ts's generic exception logger. Authenticate before reading any body.
  try {
    const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (token?.startsWith(GRANT_PREFIX)) return computerError(403, 'owner_required', 'Temporary inference tokens cannot use the desktop.');
    const auth = await resolveAuth(c);
    if (auth instanceof Response) return auth;
    if (auth.isCampusMode || !auth.userKeyRow) return computerError(403, 'owner_required', 'An ordinary personal key or sandbox credential is required, not Campus Pass.');
    const authority = callerAuthority(auth.userKeyRow);
    // Cached identity only. No label discovery, ensureSandbox, control-plane
    // readiness checks, or D1 cache repair on this path.
    const cached = await c.env.DB.prepare(`SELECT daytona_sandbox_id FROM user_keys WHERE ${authority.sql}`)
      .bind(...authority.values).first<{ daytona_sandbox_id: string | null }>();
    if (!cached) return computerError(401, 'unauthorized', 'Owner authority has been revoked.');
    if (!cached.daytona_sandbox_id) return computerError(409, 'sandbox_not_running', 'No cached sandbox. Start the sandbox or Desktop deliberately before opening a session.');
    c.set('computerCaller', { ...auth.userKeyRow, daytona_sandbox_id: cached.daytona_sandbox_id });
    await next();
  } catch { return computerError(502, 'computer_unavailable', 'Computer-use service unavailable. No input was retried.'); }
});
computerRoutes.use('*', bodyLimit({ maxSize: 32768, onError: () => computerError(400, 'invalid_request', 'Computer-use request exceeds 32 KiB.') }));
computerRoutes.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    try { await c.req.json(); } catch { return invalid(); }
  }
  await next();
});

const description = 'Ordinary personal BayLeaf key or sandbox credential only; never Campus Pass, temporary inference tokens or cookies. ' +
  'No compute wake, creation, stack start or automatic retry. Toolbox reads refresh Daytona activity. ' +
  'Handles expire after 24 hours and bind the owner, sandbox and SHA-256 of (boot_id, Xvfb :0 PID, process starttime). ' +
  'Generation is checked at session open and in parallel with every screenshot, not before each input. ' +
  'On any session_ended discard the handle and deliberately reopen; stateless handles cannot persist a failure tombstone. ' +
  'A concurrent restart between generation check and image capture remains possible. See /llms.txt#computer-use for workflow guidance.';
const error = (description: string) => ({ description, content: { 'application/json': { schema: ApiErrorSchema } } });
const errors = {
  400: error('invalid_request: invalid JSON, schema or body size'), 401: error('Missing, invalid or revoked owner credential'),
  403: error('owner_required: Campus Pass, temporary token or other non-owner authority'),
  409: error('sandbox_not_running or desktop_not_running: deliberately start the sandbox or Desktop'),
  410: error('session_ended: invalid/expired handle, replaced sandbox or changed desktop generation, or Toolbox failure. Discard handle. Missing sandbox at session open uses sandbox_not_running.'),
  423: error('human_has_floor: reserved for future floor control; no lock is implemented in v1'),
  502: error('computer_unavailable: internal service failure'),
};
const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
const caller = (c: Context<AppEnv>) => c.get('computerCaller')!;

computerRoutes.openapi(createRoute({ method: 'post', path: '/session', operationId: 'openComputerSession', tags: ['Sandbox'],
  summary: 'Open an observation session on an already-running Desktop', description,
  security: [{ Bearer: [] }], request: { body: { required: true, content: json(ComputerSessionRequestSchema) } },
  responses: { 200: { description: 'Signed generation handle; opens no processes or display connections', content: json(ComputerSessionResponseSchema) }, ...errors },
}), async c => {
  const row = caller(c), id = row.daytona_sandbox_id!;
  const generation = await desktopGeneration(c.env, id, row.toolbox_proxy_url);
  if (generation instanceof Response) return generation as any;
  const opened = await openComputerSession(c.env, row, id, generation);
  if (!opened) return computerError(502, 'computer_unavailable', 'Session signing is unavailable.') as any;
  return c.json(opened, 200);
}, result => { if (!result.success) return invalid() as any; });

async function session(c: Context<AppEnv>, handle: string): Promise<string | Response> {
  const row = caller(c);
  return await verifyComputerSession(c.env, row, row.daytona_sandbox_id!, handle) ?? sessionEnded();
}

for (const [path, schema] of Object.entries(ComputerActionSchemas)) {
  computerRoutes.openapi(createRoute({ method: 'post', path: `/${path}`, tags: ['Sandbox'],
    operationId: 'computer' + path.split('/').map(s => s[0].toUpperCase() + s.slice(1)).join(''),
    summary: `Single ${path} action`, description: description + ' Held keys/buttons require matching up calls, preferably in finally. Do not replay ambiguous failures.',
    security: [{ Bearer: [] }], request: { body: { required: true, content: json(schema) } },
    responses: { 200: { description: 'Toolbox accepted one action, not proof of application outcome', content: json(ComputerActionResponseSchema) }, ...errors },
  }), async c => {
    const { session: handle, ...action } = c.req.valid('json') as { session: string; [key: string]: unknown };
    const generation = await session(c, handle);
    if (generation instanceof Response) return generation as any;
    const row = caller(c);
    const floor = await checkComputerFloor(c.env, row.email);
    if (floor) return floor as any;
    // Toolbox calls this key, while the BayLeaf method is keyboard/press.
    const upstream = path === 'keyboard/press' ? 'keyboard/key' : path;
    const r = await computerToolbox(c.env, row.daytona_sandbox_id!, `/computeruse/${upstream}`, action, row.toolbox_proxy_url);
    if (!r?.ok) { await r?.body?.cancel(); return sessionEnded() as any; }
    // Action responses are not application state, and may be {}. Never echo
    // untrusted/provider strings (or keypress text) into errors or logs.
    await r.body?.cancel();
    return c.json({ success: true as const }, 200);
  }, result => { if (!result.success) return invalid() as any; });
}

for (const compressed of [false, true]) {
  computerRoutes.openapi(createRoute({ method: 'post', path: compressed ? '/screenshot/compressed' : '/screenshot', tags: ['Sandbox'],
    operationId: compressed ? 'computerScreenshotCompressed' : 'computerScreenshot', summary: compressed ? 'Capture compressed screen or region' : 'Capture full-resolution PNG screen or region',
    description: description + ' The Toolbox response is streamed unchanged as image bytes or base64 JSON according to its Content-Type. Accept screenshot or Screenshot in JSON. Content is never cached or logged.',
    security: [{ Bearer: [] }], request: { body: { required: true, content: json(compressed ? ComputerCompressedScreenshotSchema : ComputerScreenshotSchema) } },
    responses: { 200: { description: 'Transient screenshot, released only after matching generation check', content: {
      ...json(ComputerScreenshotResponseSchema),
      'image/png': { schema: z.string().openapi({ format: 'binary' }) },
      'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) },
      'image/webp': { schema: z.string().openapi({ format: 'binary' }) },
    } }, ...errors },
  }), async c => {
    const input = c.req.valid('json') as z.infer<typeof ComputerCompressedScreenshotSchema>;
    const expected = await session(c, input.session);
    if (expected instanceof Response) return expected as any;
    const row = caller(c), id = row.daytona_sandbox_id!;
    const query = new URLSearchParams({ showCursor: String(input.showCursor) });
    if (input.region) for (const [key, value] of Object.entries(input.region)) query.set(key, String(value));
    if (compressed) for (const key of ['format', 'quality', 'scale'] as const) query.set(key, String(input[key]));
    const path = '/computeruse/screenshot' + (input.region ? '/region' : '') + (compressed ? '/compressed' : '') + '?' + query;
    const [r, actual] = await Promise.all([
      computerToolbox(c.env, id, path, undefined, row.toolbox_proxy_url),
      desktopGeneration(c.env, id, row.toolbox_proxy_url),
    ]);
    if (!r?.ok || actual instanceof Response || actual !== expected) {
      await r?.body?.cancel(); return sessionEnded() as any;
    }
    const type = r.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (!type || !['image/png', 'image/jpeg', 'image/webp', 'application/json'].includes(type)) {
      await r.body?.cancel(); return sessionEnded() as any;
    }
    // Header allowlist: never forward credentials, cache metadata or cookies.
    return new Response(r.body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }) as any;
  }, result => { if (!result.success) return invalid() as any; });
}

for (const windows of [false, true]) {
  computerRoutes.openapi(createRoute({ method: 'post', path: windows ? '/display/windows' : '/display/info', tags: ['Sandbox'],
    operationId: windows ? 'computerWindows' : 'computerDisplayInfo', summary: windows ? 'Inspect windows (advisory)' : 'Inspect native display geometry', description,
    security: [{ Bearer: [] }], request: { body: { required: true, content: json(ComputerSessionSchema) } },
    responses: { 200: { description: 'Normalized display metadata', content: json(windows ? ComputerWindowsResponseSchema : ComputerDisplayResponseSchema) }, ...errors },
  }), async c => {
    const expected = await session(c, (c.req.valid('json') as { session: string }).session);
    if (expected instanceof Response) return expected as any;
    const row = caller(c);
    const r = await computerToolbox(c.env, row.daytona_sandbox_id!, `/computeruse/display/${windows ? 'windows' : 'info'}`, undefined, row.toolbox_proxy_url);
    if (!r?.ok) { await r?.body?.cancel(); return sessionEnded() as any; }
    try {
      const data: unknown = await r.json();
      const list = field(data, windows ? 'windows' : 'displays');
      if (!Array.isArray(list)) return sessionEnded() as any;
      const normalized = list.map(item => Object.fromEntries((windows ? ['id', 'title', 'x', 'y', 'width', 'height'] : ['x', 'y', 'width', 'height'])
        .map(key => [key, field(item, key)]).filter(([, value]) => value !== undefined)));
      const parsed = (windows ? ComputerWindowsResponseSchema : ComputerDisplayResponseSchema).safeParse({ [windows ? 'windows' : 'displays']: normalized });
      if (!parsed.success) return sessionEnded() as any;
      return c.json(parsed.data, 200);
    } catch { return sessionEnded() as any; }
  }, result => { if (!result.success) return invalid() as any; });
}
