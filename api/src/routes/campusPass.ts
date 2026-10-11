/** Passive browser discovery. No inference, provisioning, healing, or quota writes. */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { z } from '@hono/zod-openapi';
import type { AppEnv, Bindings } from '../types';
import { CampusPassResponseSchema } from '../schemas';
import { campusNetworkStatus, getAuthIP } from '../utils/ip';
import { inspectCounter, parseLimit } from '../utils/campusRpd';
import { OPENROUTER_API } from '../constants';

type Report = z.infer<typeof CampusPassResponseSchema>;
type Reason = Report['inference']['reasons'][number];
type CreditReading = Report['shared_credit'] & { reasons: Reason[] };
const CACHE_MS = 15_000;
// Bounded to one entry, coalescing concurrent reads. Only reduced metadata and a
// credential fingerprint survive inspection, never balances or provider payloads.
let cached: { fingerprint: string; expires: number; reading: Promise<CreditReading> } | undefined;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

async function readMetadata(path: string, secret: string): Promise<{ status: number; data: Record<string, unknown> | null }> {
  try {
    const response = await fetch(`${OPENROUTER_API}${path}`, {
      headers: { Authorization: `Bearer ${secret}` }, redirect: 'manual', signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, data: null };
    }
    const body = await response.json() as { data?: Record<string, unknown> };
    const data = body?.data;
    return { status: response.status,
      data: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
  } catch {
    return { status: 0, data: null };
  }
}

async function inspectSharedCredit(env: Bindings): Promise<CreditReading> {
  const [key, account] = await Promise.all([
    readMetadata('/key', env.CAMPUS_POOL_KEY),
    env.OPENROUTER_PROVISIONING_KEY ? readMetadata('/credits', env.OPENROUTER_PROVISIONING_KEY)
      : Promise.resolve({ status: 0, data: null }),
  ]);
  const reasons: Reason[] = [];
  let unknown = false;
  if (key.status === 401 || key.status === 403) reasons.push('pool_key_unavailable');
  else if (!key.data) unknown = true;
  else {
    const data = key.data;
    // Current OpenRouter metadata includes all enforcing budget layers. Honor
    // the key's own cap too, and tolerate older responses without layer metadata.
    if (!(data.limit === null || (finite(data.limit) && data.limit >= 0)) ||
        !(data.limit_remaining === null || finite(data.limit_remaining))) unknown = true;
    if (finite(data.limit_remaining) && data.limit_remaining <= 0) reasons.push('pool_budget_exhausted');
    else if (data.limit !== null && !finite(data.limit_remaining)) unknown = true;
    if (Array.isArray(data.budgets)) {
      for (const budget of data.budgets) {
        if (!budget || !finite(budget.remaining_usd)) unknown = true;
        else if (budget.remaining_usd <= 0 && !reasons.includes('pool_budget_exhausted')) reasons.push('pool_budget_exhausted');
      }
    } else if (data.budgets != null) unknown = true;
    if (data.effective_budget != null) {
      const budget = data.effective_budget as { remaining_usd?: unknown };
      if (!finite(budget.remaining_usd)) unknown = true;
      else if (budget.remaining_usd <= 0 && !reasons.includes('pool_budget_exhausted')) reasons.push('pool_budget_exhausted');
    }
    if (data.expires_at != null) {
      const expiry = Date.parse(String(data.expires_at));
      if (!Number.isFinite(expiry)) unknown = true;
      else if (expiry <= Date.now()) reasons.push('pool_key_unavailable');
    }
    if (data.is_management_key === true || data.is_provisioning_key === true) reasons.push('pool_key_unavailable');
    if (Array.isArray(data.allowed_data_regions) && data.allowed_data_regions.length === 0) reasons.push('pool_key_unavailable');
  }
  if (account.data && finite(account.data.total_credits) && finite(account.data.total_usage)) {
    if (account.data.total_credits - account.data.total_usage <= 0) reasons.push('shared_credit_exhausted');
  } else unknown = true;
  if (unknown) reasons.push('upstream_unknown');
  return {
    status: reasons.some(r => r !== 'upstream_unknown') ? 'unavailable' : unknown ? 'unknown' : 'available',
    checked_at: new Date().toISOString(), reasons,
  };
}

async function sharedCredit(env: Bindings): Promise<CreditReading> {
  const bytes = new TextEncoder().encode(JSON.stringify([env.CAMPUS_POOL_KEY, env.OPENROUTER_PROVISIONING_KEY]));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    b => b.toString(16).padStart(2, '0')).join('');
  if (!cached || cached.fingerprint !== fingerprint || cached.expires <= Date.now()) {
    cached = { fingerprint, expires: Date.now() + CACHE_MS, reading: inspectSharedCredit(env) };
  }
  return cached.reading;
}

export const campusPassRoutes = new OpenAPIHono<AppEnv>();
campusPassRoutes.openapi(createRoute({
  method: 'get', path: '/campus-pass', tags: ['Meta'], operationId: 'inspectCampusPass',
  summary: 'Check keyless standard inference availability for this browser',
  description: 'Unauthenticated and read-only. Returns 200 even off-campus or when a budget is exhausted. ' +
    'Uses the same trusted Cloudflare client IP and quota as inference. Never consumes an inference request. ' +
    'No cookies or Authorization header needed; wildcard CORS supports static JS apps. Responses are no-store. ' +
    'Shared credit combines pool-key budget and OpenRouter account credit without exposing dollar amounts. ' +
    'Unknown is not exhausted. Availability is advisory and not model-specific; inference can still fail.',
  security: [], responses: { 200: { description: 'Caller-specific Campus Pass assessment',
    content: { 'application/json': { schema: CampusPassResponseSchema } } } },
}), async c => {
  c.header('Cache-Control', 'no-store');
  const network = campusNetworkStatus(c.req.raw, c.env);
  const enabled = !!(c.env.CAMPUS_IP_RANGES && c.env.CAMPUS_POOL_KEY);
  const reasons: Reason[] = [];
  if (network === false) reasons.push('off_campus');
  if (network === null) reasons.push('network_unknown');
  if (!enabled) reasons.push('disabled');
  let quota: Report['quota'] = null;
  const ip = getAuthIP(c.req.raw, c.env);
  if (network === true && ip) {
    try {
      const counter = await inspectCounter(c.env.CAMPUS_RPD, ip, parseLimit(c.env.CAMPUS_RPD_LIMIT));
      if (!Number.isInteger(counter.count) || counter.count < 0) throw new Error('Invalid counter metadata');
      quota = { remaining: counter.remaining, limit: counter.limit, resets_at: counter.resetsAt,
        scope: 'network_address', approximate: true };
      if (counter.remaining === 0) reasons.push('quota_exhausted');
    } catch { reasons.push('quota_unknown'); }
  }
  const credit: CreditReading = enabled ? await sharedCredit(c.env)
    : { status: 'unavailable', checked_at: null, reasons: [] };
  reasons.push(...credit.reasons);
  const blocked = reasons.some(r => !['network_unknown', 'quota_unknown', 'upstream_unknown'].includes(r));
  return c.json({ campus_network: network, enabled,
    inference: { provider: 'openrouter' as const, status: blocked ? 'unavailable' as const
      : reasons.length ? 'unknown' as const : 'available' as const, reasons },
    quota, shared_credit: { status: credit.status, checked_at: credit.checked_at },
  });
});
