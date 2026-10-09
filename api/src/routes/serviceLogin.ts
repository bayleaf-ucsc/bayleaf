/** API-host half of the fixed sandbox login broker. No credentials cross hosts. */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../types';
import { getSession } from '../utils/session';
import { SERVICE_ORIGIN, SERVICE_AUTHORIZE_PATH, serviceApiOrigin, serviceHash, serviceNow,
  serviceToken, validServiceToken, readServiceFlow } from '../serviceSessions';

const BROKER = '__Host-bl-service-broker';
const RETURN_TO = '__Host-bl-service-return';
const COOKIE = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' as const };
export const serviceLoginRoutes = new OpenAPIHono<AppEnv>();
serviceLoginRoutes.onError((_error, c) => c.text('Login unavailable. Please start again.', 503));
serviceLoginRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (new URL(c.req.url).origin !== serviceApiOrigin(c.env)) return c.text('Invalid login origin.', 400);
  await next();
});
serviceLoginRoutes.get('/authorize', async (c) => {
  const fail = () => c.text('Invalid or expired login. Please start again.', 400);
  const flow = await readServiceFlow(c.env, c.req.query('flow'));
  if (!flow) return fail();
  if (flow.stage === 'started') {
    const broker = serviceToken();
    const bound = await c.env.DB.prepare(`UPDATE service_login_flows SET broker_hash=?,stage='bound'
      WHERE id=? AND stage='started' AND expires_at>? RETURNING id`)
      .bind(await serviceHash(broker), flow.id, serviceNow()).first();
    if (!bound) return fail();
    setCookie(c, BROKER, broker, { ...COOKIE, maxAge: 600 });
    return c.redirect(`${SERVICE_ORIGIN}/auth/prove?flow=${flow.id}`, 302);
  }
  const broker = getCookie(c, BROKER);
  if (flow.stage !== 'proved' || !validServiceToken(broker) || await serviceHash(broker) !== flow.broker_hash) return fail();
  const session = await getSession(c);
  if (!session) {
    setCookie(c, RETURN_TO, flow.id, { ...COOKIE, maxAge: 600 });
    return c.redirect('/login', 302);
  }
  if (typeof session.email !== 'string' || session.email.length > 254 ||
      !session.email.endsWith(`@${c.env.ALLOWED_EMAIL_DOMAIN}`)) return fail();
  const code = serviceToken();
  const issued = await c.env.DB.prepare(`UPDATE service_login_flows SET stage='issued',code_hash=?,email=?,name=?,expires_at=?
    WHERE id=? AND stage='proved' AND broker_hash=? AND expires_at>? RETURNING id`)
    .bind(await serviceHash(code), session.email, typeof session.name === 'string' ? session.name.slice(0, 256) : '',
      Math.min(flow.expires_at, serviceNow() + 60), flow.id, flow.broker_hash, serviceNow()).first();
  if (!issued) return fail();
  deleteCookie(c, BROKER, COOKIE);
  deleteCookie(c, RETURN_TO, COOKIE);
  return c.redirect(`${SERVICE_ORIGIN}/auth/callback?flow=${flow.id}&code=${code}`, 302);
});

export function consumeServiceReturnTo(c: Context<AppEnv>): string | null {
  const flow = getCookie(c, RETURN_TO);
  if (!flow) return null;
  deleteCookie(c, RETURN_TO, COOKIE);
  return validServiceToken(flow) ? `${SERVICE_AUTHORIZE_PATH}?flow=${flow}` : null;
}
