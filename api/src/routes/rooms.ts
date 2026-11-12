/** BayLeaf Rooms owner facade (issue #159): off unless ROOMS_ENABLED is exactly "true".
 * Contract: rooms/DESIGN.md. This file only authenticates and relays to the separate
 * `bayleaf-rooms` Worker's RoomManagement RPC over the ROOMS service binding.
 *
 * Owner identity is user_keys.account_generation, so the Rooms Worker never sees an email.
 * Identity only: never call ensureBackendKey/resolveBackendCredential here, because
 * room-only use must not provision inference credentials. Never log room content, ids,
 * labels or rk_ secrets. Stored content is participant-controlled, so exports are inert.
 *
 * Ordering matches routes/inboxes.ts: the disabled gate answers 404 before auth, and auth
 * runs as route middleware, before the route's Zod validators.
 *
 * App tokens (rooms.read, rooms.manage) are account-wide, not bound to room ids: rooms are
 * short-lived and created by the same workflows that would need the binding, and the
 * per-room delegation mechanism is already the rk_ capability link (SCOPES.md).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, RoomManagement } from '../types';
import { resolveAuth } from '../utils/auth';
import { getSession } from '../utils/session';
import { getActiveRow } from '../provision';
import { requireScope } from '../grants';
import { ApiErrorSchema, RoomCreateRequestSchema, RoomCredentialIssuedSchema, RoomCredentialListSchema, RoomCredentialParamsSchema,
  RoomCredentialRequestSchema, RoomCredentialRevokeSchema, RoomDeleteSchema, RoomExportQuerySchema, RoomIdParamsSchema,
  RoomLimitsSchema, RoomListSchema, RoomSchema, RoomUpdateRequestSchema } from '../schemas';

/** Service narrative rendered beside createRoom in the spec and Scalar. */
const ROOM_WORKFLOW = `Durable shared state for static apps: a room is a log of JSON entries (or Yjs updates) that credentialed participants append to and read, with live WebSocket delivery and HTTP catch-up on https://bayleaf-rooms.dev. It keeps its state while every browser, sandbox and agent is offline. It never runs code, runs inference or wakes an agent. BayLeaf relays, it does not arbitrate: no locks, turns or ownership of parts of the data. Manage rooms with an ordinary BayLeaf key or a sandbox credential; Campus Pass cannot own rooms, and room use provisions no inference credentials. An app token with rooms.read reaches limits, list, get and export; rooms.manage reaches create, update, delete and credentials, and since every participant link can read and export its room, it effectively grants read too. Both cover all of the grantor's rooms. Availability on this deployment is stated in the overview; when disabled every path answers 404.

**Capability links.** Participants never see an owner credential. Issue rk_ credentials and share links of the form https://your.app/#room=r_...&key=rk_...: the fragment never reaches the page host, so page source holds no secrets. Every credential reads, exports and receives presence; scopes add presence, append and manage. A link shown on a projector or QR code is effectively public: give it only presence. Labels are visible to every participant: use pseudonyms. Secrets are shown once.

**Lifetime.** Each room has a fixed expires_at (default 30 days, at most 90 ahead). Use never renews it; PATCH moves it either way. At expiry or deletion sockets get end, then every request 404s. Export first.

**Retention.** Rooms store what participants send: this is not zero data retention, and the operator can technically read stored content. Use pseudonyms, keep rosters, grades and real-name mappings out, and submit anything graded elsewhere. [Participant contract](/docs/rooms.md); [design contract](https://github.com/bayleaf-ucsc/bayleaf/blob/main/rooms/DESIGN.md); [agent workflow](/llms.txt#rooms-shared-state-for-apps-you-build).`;

type Status = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503;
const fail = (c: Context<AppEnv>, message: string, code: Status, extra: Record<string, unknown> = {}) =>
  c.json({ error: { message, code, ...extra } }, code);
const RPC_ERRORS: Record<string, [Status, string]> = {
  invalid: [400, 'Invalid request'], not_found: [404, 'Not found'], disabled: [404, 'Not found'],
  limit: [409, 'Room limit reached'], credential_limit: [409, 'Credential limit reached for this room'],
  label_taken: [409, 'Credential label already used in this room'], unavailable: [503, 'Room service unavailable'],
};
const limit = bodyLimit({ maxSize: 4096, onError: c => fail(c as Context<AppEnv>, 'Request body too large', 413) });
const enabled = (c: Context<AppEnv>) => c.env.ROOMS_ENABLED === 'true' && !!c.env.ROOMS;

// Validation failures share the RPC's `invalid` mapping. Auth has already run (see header).
export const roomRoutes = new OpenAPIHono<AppEnv>({ defaultHook: (result, c) => {
  if (!result.success) return fail(c, 'Invalid request', 400) as any;
} });

// Before auth, so a disabled deployment does not advertise the feature.
roomRoutes.use('*', async (c, next) => {
  if (!enabled(c)) return fail(c, 'Not found', 404);
  c.header('Cache-Control', 'no-store');
  await next();
});

/** Ordinary keys, sandbox credentials and scoped app tokens (already admitted by the
 * global gate) act for their owner. Campus Pass is an IP, not an owner. */
async function owner(c: Context<AppEnv>): Promise<string | Response> {
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth;
  if (auth.isCampusMode || !auth.userKeyRow)
    return fail(c, 'Rooms require a BayLeaf API key: Campus Pass does not establish ownership.', 403);
  return auth.userKeyRow.account_generation || fail(c, 'Account identity unavailable.', 500);
}

const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const who = await owner(c);
  if (who instanceof Response) return who;
  c.set('roomOwner', who);
  await next();
};

/** Bounded JSON object; an empty body is `{}`. Runs after auth and before Zod. */
const jsonBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  const text = await c.req.text();
  let value: unknown = {};
  if (text) {
    if (!/^application\/json\s*(;|$)/i.test(c.req.header('Content-Type') ?? '')) return fail(c, 'JSON body required', 415);
    try { value = JSON.parse(text); } catch { value = null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(c, 'Invalid JSON object', 400);
  }
  c.req.json = async () => value as any;
  await next();
};

/** Inert export: participant-written bytes are never rendered, sniffed or cached here. */
function download(id: string, format: string, result: { content_type?: unknown; body?: unknown }): Response | null {
  const { body } = result;
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) return null;
  const type = typeof result.content_type === 'string' && /^[\w.+-]+\/[\w.+-]+(\s*;\s*charset=utf-8)?$/i.test(result.content_type)
    ? result.content_type : 'application/octet-stream';
  const name = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? `; filename="${id}.${format}"` : '';
  return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Disposition': 'attachment' + name,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' } });
}

type Call = (rpc: RoomManagement, owner: string) => Promise<unknown>;
async function relay(c: Context<AppEnv>, call: Call, opts: { status?: 200 | 201; exported?: [string, string] } = {}): Promise<any> {
  let result: unknown;
  try { result = await call(c.env.ROOMS!, c.get('roomOwner')!); } catch { return fail(c, 'Room service unavailable', 503); }
  if (!result || typeof result !== 'object' || result instanceof Response || 'error' in result) {
    if (result instanceof Response) await result.body?.cancel();
    const { error, label } = (result && typeof result === 'object' ? result : {}) as { error?: unknown; label?: unknown };
    const [code, message] = RPC_ERRORS[String(error)] ?? [503, 'Room service unavailable'];
    return fail(c, message, code, error === 'label_taken' && typeof label === 'string' ? { label } : {});
  }
  if (opts.exported) return download(...opts.exported, result as { content_type?: unknown; body?: unknown }) ?? fail(c, 'Room service unavailable', 503);
  return c.json(result, opts.status ?? 200);
}

// ── OpenAPI route definitions ─────────────────────────────────────

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const error = (description: string) => ({ description, content: json(ApiErrorSchema) });
const errors = {
  400: error('Invalid path, query or body. Checked only after authentication.'),
  401: error('Missing or invalid BayLeaf credential.'),
  403: error('Campus Pass, or an app token without the needed rooms.* scope.'),
  404: error('Unknown room, another owner\'s room, an expired or deleted room, or Rooms disabled on this deployment. These are indistinguishable.'),
  500: error('Account identity unavailable.'),
  503: error('Room service unavailable. Retry later.'),
};
const writeErrors = {
  413: error('Request body over 4 KiB.'),
  415: error('A nonempty body must be application/json.'),
};
// Bearer only: no empty Campus Pass alternative. The scheme also admits sandbox credentials.
const ROOM = { tags: ['Rooms'], security: [{ Bearer: [] }] };
const read = [requireScope('rooms.read'), authenticate];
const manage = [requireScope('rooms.manage'), authenticate];
const write = [limit, requireScope('rooms.manage'), authenticate, jsonBody];

roomRoutes.openapi(createRoute({ ...ROOM, method: 'get', path: '/limits', operationId: 'getRoomLimits', middleware: read,
  summary: 'Read effective room limits and your room count',
  description: 'Call this first. Read from the Rooms Worker\'s enforced configuration, including deployed overrides; no inference credentials are provisioned.',
  responses: { 200: { description: 'Effective limits and owner usage, uncached', content: json(RoomLimitsSchema) }, ...errors },
}), c => relay(c, (rpc, o) => rpc.getLimits(o)));

roomRoutes.openapi(createRoute({ ...ROOM, method: 'post', path: '/', operationId: 'createRoom', middleware: write,
  summary: 'Create a room',
  description: 'Returns the room id participants use on https://bayleaf-rooms.dev. codec is fixed once created. Fails with 409 past the per-owner room limit (default 20). Then issue capability links with createRoomCredentials.\n\n' + ROOM_WORKFLOW,
  request: { body: { required: true, content: json(RoomCreateRequestSchema) } },
  responses: { 201: { description: 'Created', content: json(RoomSchema) }, 409: error('Room limit reached.'), ...writeErrors, ...errors },
}), c => relay(c, (rpc, o) => rpc.createRoom(o, c.req.valid('json')), { status: 201 }));

roomRoutes.openapi(createRoute({ ...ROOM, method: 'get', path: '/', operationId: 'listRooms', middleware: read,
  summary: 'List your live rooms',
  responses: { 200: { description: 'Live rooms', content: json(RoomListSchema) }, ...errors },
}), c => relay(c, (rpc, o) => rpc.listRooms(o)));

roomRoutes.openapi(createRoute({ ...ROOM, method: 'get', path: '/{id}', operationId: 'getRoom', middleware: read,
  summary: 'Get one room with usage and credential metadata', description: 'Includes head, bytes, open sockets and credentials (no secrets).',
  request: { params: RoomIdParamsSchema },
  responses: { 200: { description: 'Room', content: json(RoomSchema) }, ...errors },
}), c => relay(c, (rpc, o) => rpc.getRoom(o, c.req.valid('param').id)));

roomRoutes.openapi(createRoute({ ...ROOM, method: 'patch', path: '/{id}', operationId: 'updateRoom', middleware: write,
  summary: 'Relabel, extend or shorten, freeze or unfreeze a room',
  description: 'expires_at may move either way, up to max_life_days ahead; this is the only way to extend a room. mode read_only freezes appends (reads and presence continue); open unfreezes.',
  request: { params: RoomIdParamsSchema, body: { required: true, content: json(RoomUpdateRequestSchema) } },
  responses: { 200: { description: 'Updated room', content: json(RoomSchema) }, ...writeErrors, ...errors },
}), c => relay(c, (rpc, o) => rpc.updateRoom(o, c.req.valid('param').id, c.req.valid('json'))));

roomRoutes.openapi(createRoute({ ...ROOM, method: 'delete', path: '/{id}', operationId: 'deleteRoom', middleware: manage,
  summary: 'Delete a room and everything it stored',
  description: 'Irreversible. Ends the relay for everyone: open sockets get end "deleted", then every request 404s. Warn participants and export first.',
  request: { params: RoomIdParamsSchema },
  responses: { 200: { description: 'Deleted', content: json(RoomDeleteSchema) }, ...errors },
}), c => relay(c, (rpc, o) => rpc.deleteRoom(o, c.req.valid('param').id)));

roomRoutes.openapi(createRoute({ ...ROOM, method: 'post', path: '/{id}/credentials', operationId: 'createRoomCredentials', middleware: write,
  summary: 'Issue one or many participant capability links',
  description: 'Exactly one of scopes or role, and one of label or labels (up to 100 per call). Each result carries a one-time rk_ secret and link_fragment (room=...&key=...). Give each link only what its holder needs: presence-only for a projected QR code. 409 past the per-room credential limit (default 100) or on a label already used (error.label names it; earlier labels in the same call may have been issued, so list credentials before retrying).',
  request: { params: RoomIdParamsSchema, body: { required: true, content: json(RoomCredentialRequestSchema) } },
  responses: { 201: { description: 'Credentials and their one-time secrets', content: json(RoomCredentialIssuedSchema) },
    409: error('Credential limit reached, or label already used (error.label).'), ...writeErrors, ...errors },
}), c => relay(c, (rpc, o) => rpc.issueCredentials(o, c.req.valid('param').id, c.req.valid('json')), { status: 201 }));

roomRoutes.openapi(createRoute({ ...ROOM, method: 'get', path: '/{id}/credentials', operationId: 'listRoomCredentials', middleware: manage,
  summary: 'List participant credentials', description: 'Metadata only. Secrets can never be read back.',
  request: { params: RoomIdParamsSchema },
  responses: { 200: { description: 'Credentials', content: json(RoomCredentialListSchema) }, ...errors },
}), c => relay(c, (rpc, o) => rpc.listCredentials(o, c.req.valid('param').id)));

roomRoutes.openapi(createRoute({ ...ROOM, method: 'delete', path: '/{id}/credentials/{cid}', operationId: 'revokeRoomCredential', middleware: manage,
  summary: 'Revoke a participant credential', description: 'Its link stops working at once and its open sockets get end "revoked".',
  request: { params: RoomCredentialParamsSchema },
  responses: { 200: { description: 'Revoked', content: json(RoomCredentialRevokeSchema) }, ...errors },
}), c => { const { id, cid } = c.req.valid('param'); return relay(c, (rpc, o) => rpc.revokeCredential(o, id, cid)); });

roomRoutes.openapi(createRoute({ ...ROOM, method: 'get', path: '/{id}/export', operationId: 'exportRoom', middleware: read,
  summary: 'Export every retained entry',
  description: 'format jsonl (default): one JSON entry per line. format yjs (yjs rooms only): one merged Yjs update that Y.applyUpdate(new Y.Doc(), bytes) rebuilds anywhere. Participants can export the same with any credential. Always an inert download; content is participant-written.',
  request: { params: RoomIdParamsSchema, query: RoomExportQuerySchema },
  responses: { 200: { description: 'Exported entries', content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
    headers: z.object({
      'Content-Type': z.string().describe('The Rooms Worker\'s type for the format, such as application/x-ndjson or application/octet-stream.'),
      'Content-Disposition': z.string().describe('Always attachment.'),
      'Content-Security-Policy': z.literal('sandbox'),
      'X-Content-Type-Options': z.literal('nosniff'),
    }) }, ...errors },
}), c => {
  const id = c.req.valid('param').id, format = c.req.valid('query').format;
  // Omit an absent format: structured clone would carry an explicit undefined to a strict RPC.
  return relay(c, (rpc, o) => rpc.exportRoom(o, id, format ? { format } : {}), { exported: [id, format ?? 'jsonl'] });
});

// Keep typos/malformed subpaths machine-readable instead of falling through to
// the site's HTML not-found page. Unknown paths reveal no ownership information.
roomRoutes.all('*', c => fail(c, 'Not found', 404));

// ── Dashboard card endpoints (browser session, hidden from the spec) ─────
//
// The public owner plane stays Bearer-only. These three let the signed-in dashboard
// list, extend and delete rooms; creation and credentials stay agent/API actions, so no
// rk_ secret ever reaches the page. Writes require the BayLeaf Origin and a JSON body.

export const roomDashboardRoutes = new OpenAPIHono<AppEnv>();
const DashboardExtendSchema = z.object({ days: z.number().int().min(1).max(90) }).strict();

roomDashboardRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'");
  if (!enabled(c)) return fail(c, 'Not found', 404);
  const session = await getSession(c);
  if (!session) return fail(c, 'Sign in to BayLeaf.', 401);
  if (c.req.method !== 'GET' && c.req.header('Origin') !== new URL(c.req.url).origin)
    return fail(c, 'Submit from the BayLeaf dashboard.', 403);
  const generation = (await getActiveRow(session.email, c.env))?.account_generation;
  if (!generation) return fail(c, 'Create an API key to own rooms.', 403);
  c.set('roomOwner', generation);
  await next();
});

roomDashboardRoutes.get('/', c => relay(c, (rpc, o) => rpc.listRooms(o)));

roomDashboardRoutes.patch('/:id{[A-Za-z0-9_-]{1,64}}', limit, async c => {
  if (!/^application\/json\s*(;|$)/i.test(c.req.header('Content-Type') ?? '')) return fail(c, 'JSON body required', 415);
  let body: unknown; try { body = await c.req.json(); } catch { body = null; }
  const parsed = DashboardExtendSchema.safeParse(body);
  if (!parsed.success) return fail(c, 'Invalid request', 400);
  const expires_at = new Date(Date.now() + parsed.data.days * 86400_000).toISOString();
  return relay(c, (rpc, o) => rpc.updateRoom(o, c.req.param('id'), { expires_at }));
});

roomDashboardRoutes.delete('/:id{[A-Za-z0-9_-]{1,64}}', c => relay(c, (rpc, o) => rpc.deleteRoom(o, c.req.param('id'))));

roomDashboardRoutes.all('*', c => fail(c, 'Not found', 404));
