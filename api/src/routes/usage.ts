/** Read-only budget inspection: never mint/heal credentials or debit counters. */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { resolveAuth } from '../utils/auth';
import { ALT_BACKENDS, isBackendEnabled, OPENROUTER_API } from '../constants';
import { parseLimit } from '../utils/campusRpd';
import { UsageResponseSchema } from '../schemas';

export const usageRoutes = new OpenAPIHono<AppEnv>();
usageRoutes.openapi(createRoute({ method:'get', path:'/', tags:['LLM'], operationId:'inspectUsage',
  summary:'Inspect personal inference allowances without spending or provisioning',
  description:'Personal keys only. Budgets are shared across clients. USD and request counts are distinct. Null means unknown, not unlimited. Disabled backends are omitted. Provider failures are reported per budget.',
  security:[{Bearer:[]}], responses:{
    200:{description:'Current account allowances',content:{'application/json':{schema:UsageResponseSchema}}},
    401:{description:'Personal key required'},403:{description:'Personal key required'},
  } }), async c => {
  c.header('Cache-Control','no-store');
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;
  if (auth.isCampusMode || !auth.userKeyRow) return c.json({error:'Personal key required'},403) as any;
  const row = auth.userKeyRow;
  const date = new Date(); const today = date.toISOString().slice(0,10);
  const tomorrow = new Date(date); tomorrow.setUTCHours(24,0,0,0);
  type Budget = {provider:string; unit:'usd'|'requests'; status:'available'|'unavailable'|'not_provisioned';
    period:string|null;used:number|null;limit:number|null;remaining:number|null;resets_at:string|null};
  const standard: Budget = {provider:'openrouter',unit:'usd',status:row.or_key_secret?'unavailable':'not_provisioned',
    period:null,used:null,limit:null,remaining:null,resets_at:null};
  if (row.or_key_secret) {
    try {
      const response = await fetch(`${OPENROUTER_API}/auth/key`, {headers:{Authorization:`Bearer ${row.or_key_secret}`},
        redirect:'manual',signal:AbortSignal.timeout(8000)});
      if (response.ok) {
        const {data} = await response.json() as {data:Record<string,unknown>};
        const num = (value:unknown) => typeof value==='number' && Number.isFinite(value) ? value : null;
        const period = ['daily','weekly','monthly'].includes(String(data.limit_reset)) ? String(data.limit_reset) : null;
        standard.status='available';standard.period=period;
        standard.limit=num(data.limit);standard.remaining=num(data.limit_remaining);
        standard.used=num(period==='daily'?data.usage_daily:period==='weekly'?data.usage_weekly:period==='monthly'?data.usage_monthly:data.usage);
        if (period==='daily') standard.resets_at=tomorrow.toISOString();
      } else await response.body?.cancel();
    } catch { /* A provider outage is metadata, never absence of a limit. */ }
  }
  const budgets: Budget[] = [standard];
  const requests = (provider:string,used:number,limit:number) => budgets.push({provider,unit:'requests',status:'available',
    period:'daily',used,limit,remaining:Math.max(0,limit-used),resets_at:tomorrow.toISOString()});
  for (const backend of ALT_BACKENDS) if (isBackendEnabled(c.env,backend.key)) {
    requests(backend.key,row[backend.rpdDateField]===today?row[backend.rpdCountField]:0,backend.rpdLimit);
  }
  if (c.env.SEALED_ENABLED==='true') requests('sealed',row.sealed_rpd_date===today?row.sealed_rpd_count:0,parseLimit(c.env.SEALED_RPD_LIMIT));
  return c.json({observed_at:date.toISOString(),budgets});
});
