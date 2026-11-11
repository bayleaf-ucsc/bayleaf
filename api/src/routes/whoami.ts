/**
 * Read-only identity reflection: tells an agent on whose behalf its credential acts.
 * Discloses only what the credential holder already knows (their own account email).
 * App tokens reach this handler only with identity.read, which the grantor approved
 * on a consent page naming the app; without it the global gate refuses them.
 */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { resolveAuth } from '../utils/auth';
import { WhoamiResponseSchema } from '../schemas';
import { grantScopes, requireScope } from '../grants';

export const whoamiRoutes = new OpenAPIHono<AppEnv>();
whoamiRoutes.openapi(createRoute({ method: 'get', path: '/', tags: ['Meta'], operationId: 'whoami',
  middleware: [requireScope('identity.read')] as const,
  summary: 'Identify the account a credential acts for',
  description: 'Reflects the caller\'s own account email and credential kind. No provisioning, provider calls or counter changes. Campus Pass returns a null email. App tokens need identity.read and report credential grant with the grantor\'s email.',
  security: [{ Bearer: [] }, {}], responses: {
    200: { description: 'Caller identity', content: { 'application/json': { schema: WhoamiResponseSchema } } },
    401: { description: 'Missing or invalid credential' },
  } }), async c => {
  c.header('Cache-Control', 'no-store');
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;
  // The gate already enforces identity.read; refuse rather than reflect if it ever moves.
  const grant = c.get('inferenceGrant');
  if (auth.credential === 'grant' && !(grant && grantScopes(grant).includes('identity.read')))
    return c.json({ error: { message: 'This app token cannot inspect identity.', code: 403 } }, 403) as any;
  return c.json({ credential: auth.credential, email: auth.userEmail }, 200);
});
