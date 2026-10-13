/** Typed standard inference. Content is transient; OpenRouter remains the accountant. */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types';
import { DecisionRequestSchema, DecisionResponseSchema, ApiErrorSchema } from '../schemas';
import { resolveAuth } from '../utils/auth';
import { resolveBackendCredential, sendWithHeal } from '../utils/backend';
import { enforceGrantModel } from '../grants';
import { standardModelId, supportsOpenRouterOperation } from '../standardModels';
import { checkOpenWeightModel } from '../openWeight';
import { ALT_BACKENDS, isBackendEnabled } from '../constants';
import { enforceCampusRpd, upstreamCredentialUnavailable } from './proxy';

export const decisionsRoutes = new OpenAPIHono<AppEnv>();
// Avoid the application error handler logging provider/parser exceptions.
decisionsRoutes.onError((error, c) => error instanceof HTTPException && error.status === 400
  ? c.json({ error: { code: 400, message: 'Invalid decision request.' } }, 400)
  : c.json({ error: { code: 502, message: 'Decision backend unavailable.' } }, 502));
decisionsRoutes.use('/decisions', bodyLimit({ maxSize: 36 * 1024 * 1024,
  onError: c => c.json({ error: { code: 413, message: 'Decision requests must not exceed 36 MiB encoded.' } }, 413),
}));
decisionsRoutes.use('/decisions', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
const error = { content: { 'application/json': { schema: ApiErrorSchema } } };
decisionsRoutes.openapi(createRoute({
  method: 'post', path: '/decisions', operationId: 'createDecision', tags: ['Decisions'],
  summary: 'Evaluate typed decision questions',
  description: 'Choice, Noul (probability of yes), and ordered Score inference. Uses existing backend credentials and allowances, including model-set temporary tokens and Campus Pass. OpenRouter published weights and ZDR are mandatory. Media is reserved but rejected until the upstream transport is verified; no silent media removal or text fallback. Other backends currently offer zero decision models.',
  security: [{ Bearer: [] }, {}] as Record<string, string[]>[],
  request: { body: { required: true, content: { 'application/json': { schema: DecisionRequestSchema } } } },
  responses: { 200: { description: 'Native typed answers and usage', content: { 'application/json': { schema: DecisionResponseSchema } } },
    400: { description: 'Invalid input, unsupported operation or unverified media transport', ...error },
    401: { description: 'Invalid or expired credential', ...error }, 403: { description: 'Model ineligible or outside token scope', ...error },
    413: { description: 'Encoded request too large', ...error }, 429: { description: 'Shared allowance exhausted', ...error },
    502: { description: 'Invalid upstream response', ...error }, 503: { description: 'Backend disabled or unavailable', ...error } },
}), async c => {
  const auth = await resolveAuth(c); if (auth instanceof Response) return auth as any;
  const body = c.req.valid('json');
  const grantError = enforceGrantModel(c, body); if (grantError) return grantError as any;
  const id = standardModelId(body.model);
  if (!id) return c.json({ error: { code: 400, message: 'Specify a backend-qualified model.' } }, 400) as any;
  const backend = ALT_BACKENDS.find(b => id.startsWith(b.prefix));
  if (backend && !isBackendEnabled(c.env, backend.key))
    return c.json({ error: { code: 503, message: `${backend.label} is disabled.` } }, 503) as any;
  if (!id.startsWith('openrouter:'))
    return c.json({ error: { code: 400, message: 'This backend currently offers zero decision models.' } }, 400) as any;
  if (await checkOpenWeightModel(id, c.env) !== 'open')
    return c.json({ error: { code: 403, message: 'Published open weights could not be verified for this model.' } }, 403) as any;
  if (!await supportsOpenRouterOperation(id, 'decisions'))
    return c.json({ error: { code: 400, message: 'Decision capability and ZDR availability could not be verified for this model.' } }, 400) as any;
  if ([body.images, body.audio, body.videos].some(v => v?.length))
    return c.json({ error: { code: 400, message: 'Embedded media transport is not yet verified for this backend. Media has not been forwarded.' } }, 400) as any;
  const quota = await enforceCampusRpd(c.env, auth); if (quota) return quota as any;
  const credential = await resolveBackendCredential(auth, 'openrouter', c.env);
  if (!credential) return upstreamCredentialUnavailable(c) as any;
  // Allowlisted body and headers: never forward caller tracing/identity or media by accident.
  const payload = { model: id.slice(11), state: body.state, questions: body.questions,
    provider: { ...body.provider, data_collection: 'deny', zdr: true } };
  const response = await sendWithHeal(credential, c.env, secret => fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
  if (response.status >= 300 && response.status < 400)
    return c.json({ error: { code: 502, message: 'Unexpected upstream redirect.' } }, 502) as any;
  if (!response.ok) return new Response(response.body, { status: response.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) as any;
  try {
    const result = DecisionResponseSchema.safeParse(await response.json());
    if (!result.success || Object.keys(result.data.answers).length !== Object.keys(body.questions).length
      || Object.entries(body.questions).some(([key, question]) => result.data.answers[key]?.type !== question.type))
      return c.json({ error: { code: 502, message: 'Upstream returned invalid typed answers.' } }, 502) as any;
    for (const [key, question] of Object.entries(body.questions)) {
      const answer = result.data.answers[key];
      if (answer.type === 'choice' && question.type === 'choice' && !Object.hasOwn(question.criteria, answer.choice))
        return c.json({ error: { code: 502, message: 'Upstream returned an unknown choice.' } }, 502) as any;
      if (answer.type === 'score' && question.type === 'score' && (answer.score < 0 || answer.score > question.criteria.length - 1))
        return c.json({ error: { code: 502, message: 'Upstream returned an out-of-range score.' } }, 502) as any;
    }
    return c.json(result.data) as any;
  } catch { return c.json({ error: { code: 502, message: 'Upstream returned invalid JSON.' } }, 502) as any; }
}, (result, c) => { if (!result.success) return c.json({ error: { code: 400, message: 'Invalid decision request.' } }, 400) as any; });
