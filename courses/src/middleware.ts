/**
 * Middleware — DAL injection and session guard
 *
 * In dev (USE_MOCK_DALS=true), injects mock DALs with canned data.
 * In production, injects live DALs hitting real OWUI and Canvas APIs.
 */

import type { Context, Next } from 'hono';
import type { AppEnv } from './types';
import { createLiveChatDAL } from './dal/live-chat';
import { createLiveCanvasDAL } from './dal/live-canvas';
import { createMockChatDAL } from './dal/mock-chat';
import { createMockCanvasDAL } from './dal/mock-canvas';
import { getSession } from './utils/session';

/**
 * Inject DAL implementations into Hono context variables.
 * Checks USE_MOCK_DALS env var to decide which implementations to use.
 */
export async function dalMiddleware(c: Context<AppEnv>, next: Next) {
  if (c.env.USE_MOCK_DALS === 'true') {
    c.set('chatDAL', createMockChatDAL());
    c.set('canvasDAL', createMockCanvasDAL());
  } else {
    c.set('chatDAL', createLiveChatDAL(c.env));
    c.set('canvasDAL', createLiveCanvasDAL(c.env));
  }
  await next();
}

/**
 * Require an authenticated session. Redirects to /login if missing.
 */
export async function requireSession(c: Context<AppEnv>, next: Next) {
  const session = await getSession(c);
  if (!session) {
    return c.redirect('/login', 302);
  }
  c.set('session', session);
  await next();
}
