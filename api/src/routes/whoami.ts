/**
 * Read-only identity reflection: tells an agent on whose behalf its credential acts.
 * Discloses only what the credential holder already knows (their own account email).
 * Temporary inference tokens never reach this handler: the global grant gate admits
 * them only on POST inference paths, so a third-party app cannot learn its grantor.
 */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { resolveAuth } from '../utils/auth';
import { WhoamiResponseSchema } from '../schemas';

export const whoamiRoutes = new OpenAPIHono<AppEnv>();
whoamiRoutes.openapi(createRoute({ method: 'get', path: '/', tags: ['Meta'], operationId: 'whoami',
  summary: 'Identify the account a credential acts for',
  description: 'Reflects the caller\'s own account email and credential kind. No provisioning, provider calls or counter changes. Campus Pass returns a null email. Temporary inference tokens are rejected with 403.',
  security: [{ Bearer: [] }, {}], responses: {
    200: { description: 'Caller identity', content: { 'application/json': { schema: WhoamiResponseSchema } } },
    401: { description: 'Missing or invalid credential' },
  } }), async c => {
  c.header('Cache-Control', 'no-store');
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;
  // Unreachable for grants (see header comment); refuse rather than reflect if the gate ever moves.
  if (auth.credential === 'grant') return c.json({ error: { message: 'Temporary inference tokens cannot inspect identity.', code: 403 } }, 403) as any;
  return c.json({ credential: auth.credential, email: auth.userEmail }, 200);
});
