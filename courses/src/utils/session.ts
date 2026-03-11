/**
 * Session Token Utilities
 *
 * JWT sessions (HS256) via hono/jwt, cookies via hono/cookie.
 */

import type { Context } from 'hono';
import { sign, verify } from 'hono/jwt';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Session } from '../types';
import { SESSION_COOKIE, SESSION_DURATION_HOURS } from '../constants';

/**
 * Get session from request cookie (verify + decode JWT)
 */
export async function getSession(c: Context<AppEnv>): Promise<Session | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  try {
    return await verify(token, c.env.SESSION_SECRET, 'HS256') as unknown as Session;
  } catch {
    return null; // expired, invalid signature, etc.
  }
}

/**
 * Create a session JWT and set it as a cookie
 */
export async function setSessionCookie(c: Context<AppEnv>, session: Omit<Session, 'exp'>): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DURATION_HOURS * 3600;
  const token = await sign({ ...session, exp }, c.env.SESSION_SECRET);
  const secure = new URL(c.req.url).hostname !== 'localhost';
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: SESSION_DURATION_HOURS * 3600,
    secure,
  });
}

/**
 * Clear the session cookie (logout)
 */
export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
