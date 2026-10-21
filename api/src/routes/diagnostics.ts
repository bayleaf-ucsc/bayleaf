/** Read-only owner views on the existing identity origin. No provider calls. */
import { OpenAPIHono } from '@hono/zod-openapi';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { getSession } from '../utils/session';
import { getAccountRow } from '../sandboxCredentials';
import { diagnosticHeaders, diagnosticPage, diagnosticPath, escape, clock, when, bytes, count, pill, meter } from '../templates/diagnostics';
import { managedSlot } from '../serviceDefs';
import { InboxLimitsSchema } from '../schemas';

const RETURN = '__Host-bl-diagnostic-return';
const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' as const };
const kinds = ['proxies', 'inboxes'] as const;
/** Start the return marker with OAuth, not an arbitrarily old interstitial visit. */
export function prepareDiagnosticLogin(c: Context<AppEnv>): void {
  const kind = c.req.query('diagnostic') ?? getCookie(c, RETURN);
  if (kinds.includes(kind as typeof kinds[number])) {
    setCookie(c, RETURN, kind!, { ...cookieOptions, maxAge: 600 });
  }
}
export function consumeDiagnosticReturnTo(c: Context<AppEnv>): string | null {
  const kind = getCookie(c, RETURN);
  deleteCookie(c, RETURN, cookieOptions);
  return kinds.includes(kind as typeof kinds[number]) ? diagnosticPath(kind as typeof kinds[number]) : null;
}

export const diagnosticRoutes = new OpenAPIHono<AppEnv>();
diagnosticRoutes.onError(cause => {
  // Never let database/RPC failures reach the app's exception logger.
  void cause;
  return new Response(diagnosticPage('Diagnostics unavailable', '<div class="empty"><p><strong>No reliable reading right now.</strong></p><p>Try again in a few minutes.</p></div>'),
    { status: 503, headers: diagnosticHeaders() });
});
diagnosticRoutes.use('*', async (c, next) => {
  for (const [key, value] of diagnosticHeaders()) c.header(key, value);
  await next();
});

const note = (strong: string, rest = '') => `<div class="empty"><p><strong>${strong}</strong></p>${rest ? `<p>${rest}</p>` : ''}</div>`;

for (const kind of kinds) diagnosticRoutes.get(`/${kind}`, async c => {
  const session = await getSession(c);
  const service = kind === 'proxies' ? 'Proxies' as const : 'Inboxes' as const;
  const title = kind === 'proxies' ? 'Your preview links' : 'Your inboxes';
  const page = (body: string, status: 200 | 404 | 503 = 200, lede?: string) => new Response(
    diagnosticPage(title, body, { service, lede, account: session?.email }), { status, headers: diagnosticHeaders() });
  if (!session) {
    setCookie(c, RETURN, kind, { ...cookieOptions, maxAge: 600 });
    // Avoid the main dashboard, whose budget/key inspection can heal provider keys.
    return page(`<div class="actions"><a class="button" href="/login?diagnostic=${kind}">Sign in to inspect</a></div><p class="small muted">Read-only. Signing in here does not start a sandbox, create API credentials${kind === 'inboxes' ? ' or open any receipt URL' : ' or contact your apps'}.</p>`,
      200, `Sign in with your campus account to see ${kind === 'proxies' ? 'the preview links' : 'the inboxes'} that belong to you, and nobody else.`);
  }
  const account = await getAccountRow(session.email, c.env);
  const now = Math.floor(Date.now() / 1000);
  const snapshot = (summary: string) => `<div class="snapshot">${summary}<span>Snapshot at <time datetime="${new Date(now * 1000).toISOString()}">${clock(now)}</time> · <a href="">Refresh</a></span></div>`;
  const noAccount = note('No BayLeaf API account for this sign-in.', 'There is nothing to show until you have used the API with an agent.');
  if (kind === 'proxies') {
    if (c.env.PREVIEWS_ENABLED !== 'true') return page(note('The preview gateway is switched off.', 'No preview links work on this deployment right now.'), 503);
    const rows = await c.env.DB.prepare(`SELECT p.hostname,p.access,p.expires_at,p.deployment,p.slot,p.owner_key_hash,
      EXISTS(SELECT 1 FROM sandbox_credentials sc JOIN user_keys u ON u.email=sc.email
        WHERE sc.id=p.owner_key_hash AND sc.email=p.email AND sc.state='active' AND sc.sandbox_id=u.daytona_sandbox_id) AS bound
      FROM preview_registrations p WHERE p.email=? ORDER BY p.expires_at DESC LIMIT 64`)
      .bind(session.email).all<{ hostname: string; access: string; expires_at: number; deployment: string;
        slot: string; owner_key_hash: string | null; bound: number }>();
    const domain = c.env.PREVIEWS_DOMAIN || 'bayleaf-proxies.dev';
    let valid = 0, expired = 0;
    const items = rows.results.map(row => {
      const ok = row.expires_at > now && ['public', 'private'].includes(row.access) &&
        (row.deployment !== '__browser' || (c.env.BROWSER_SANDBOX_ENABLED === 'true' &&
          managedSlot(row.slot) && row.access === 'private' && !!row.owner_key_hash && !!row.bound));
      const lapsed = row.expires_at <= now;
      if (ok) valid++; else if (lapsed) expired++;
      // Do not turn database text into an arbitrary external URL.
      const safeHost = row.hostname.endsWith(`.${domain}`) &&
        /^[a-z0-9-]+$/.test(row.hostname.slice(0, -domain.length - 1));
      const access = row.access === 'private' ? 'Private, owner only' : row.access === 'public' ? 'Public, anyone with the link' : 'Unknown access';
      const state = ok ? pill('ok', 'Valid') : lapsed ? pill('off', 'Expired') : pill('off', 'Unavailable');
      const expiry = `${lapsed ? 'Expired' : 'Expires'} ${when(row.expires_at, now)}`;
      return `<li data-state="${ok ? 'ok' : 'off'}"><span class="host">${escape(row.hostname)}</span><span class="meta">${state}<span>${access}</span><span>${expiry}</span></span>${ok && safeHost ? `<a class="go" href="https://${escape(row.hostname)}/" rel="noreferrer" target="_blank">Open<span class="muted" aria-hidden="true"> &#8599;</span></a>` : ''}</li>`;
    });
    const other = items.length - valid - expired;
    const summary = `<ul class="stats" aria-label="Summary"><li><b>${valid}</b> valid</li>${expired ? `<li><b>${expired}</b> expired</li>` : ''}${other ? `<li><b>${other}</b> unavailable</li>` : ''}</ul>`;
    const body = items.length
      ? snapshot(summary) + `<ul class="rows">${items.join('')}</ul>${items.length === 64 ? '<p class="small muted">Showing up to 64 retained links, latest expiry first.</p>' : ''}${valid < items.length ? '<p class="small muted">For an expired or unavailable link, ask your agent to expose the app again, or restore a managed app in Sandboxes.</p>' : ''}`
      : note('No preview links right now.', 'Ask your agent to expose an app from your sandbox, or open one in Sandboxes.');
    return page(body + `<details><summary>About this snapshot</summary><ul><li><strong>Valid</strong> means the gateway will admit visitors. It does not check that the app is running.</li><li>Expired links disappear after hourly cleanup. Revoked links are never listed.</li><li>Upstream destinations stay encrypted and are not shown. Nothing here contacts your apps or wakes your sandbox.</li></ul></details><div class="actions small"><a href="https://sandbox.bayleaf.dev/">Manage apps in Sandboxes</a><a href="/llms.txt">Agent recovery guide</a></div>`,
      200, 'Temporary links to apps in your BayLeaf sandbox, latest expiry first.');
  }
  if (c.env.INBOXES_ENABLED !== 'true' || !c.env.INBOXES ||
      (c.env.INBOXES_PILOT_OWNER && account?.account_generation !== c.env.INBOXES_PILOT_OWNER)) {
    return page(note('Inboxes are not available for this account.', 'The service is an operator-only pilot on this deployment.'), 404);
  }
  if (!account) return page(noAccount);
  // RPC responses are deliberately projected onto recognition metadata only.
  // No raw bodies, MIME, sender headers, subjects, paths, tokens or payload previews.
  const rpc = c.env.INBOXES;
  const listing = await rpc.listInboxes(account.account_generation) as { error?: string; inboxes?: Inbox[] };
  if (!listing || listing.error || !Array.isArray(listing.inboxes)) return page(note('Inbox readings are unavailable.', 'Try again in a few minutes.'), 503);
  const shown = listing.inboxes.slice(0, 10);
  const effective = InboxLimitsSchema.safeParse(await rpc.getLimits(account.account_generation).catch(() => null));
  const capacity = effective.success
    ? `<div class="meters">${meter('Inbox slots (including deleting)', count(effective.data.owner.inboxes), count(effective.data.owner.max_inboxes), effective.data.owner.inboxes / effective.data.owner.max_inboxes)}${meter('All inbox storage', bytes(effective.data.owner.bytes), bytes(effective.data.owner.max_bytes), effective.data.owner.bytes / effective.data.owner.max_bytes)}</div><p class="small muted">${count(effective.data.owner.remaining_inboxes)} slots available at this snapshot. Pending and cleanup storage count too.</p>`
    : '<p class="small muted">Current owner limits could not be read.</p>';
  const cards = await Promise.all(shown.map(async box => {
    const active = box.state === 'active';
    const ended = typeof box.expires_at === 'number' && box.expires_at <= now;
    let receipts = `<p class="small muted">${ended ? 'Its lifetime ended, so reception' : 'Reception'} has stopped while deletion completes${
      typeof box.cleanup_not_before === 'number' ? `, not before ${when(box.cleanup_not_before, now)}` : ''}.</p>`;
    if (active) {
      const result = await rpc.listMessages(account.account_generation, box.id, { limit: 5, archived: 'all' }) as {
        error?: string; messages?: { received_at: number; expires_at: number; size: number }[]; next_cursor?: string | null };
      receipts = !result || result.error || !Array.isArray(result.messages) ? '<p class="small muted">Recent receipts could not be read.</p>' :
        result.messages.length ? `<table><thead><tr><th scope="col">Received</th><th scope="col">Size</th><th scope="col">Expires</th></tr></thead><tbody>${result.messages.map(m =>
          `<tr><td>${when(m.received_at, Math.max(m.received_at, now))}<small>${clock(m.received_at)}</small></td><td>${bytes(m.size)}</td><td>${when(m.expires_at, now)}</td></tr>`).join('')}</tbody></table>${result.next_cursor ? '<p class="hint">Older receipts are available through your agent.</p>' : ''}`
          : '<p class="small muted">Nothing received yet, or everything has expired.</p>';
    }
    const lifetime = typeof box.expires_at === 'number' ? `<p class="hint">${ended ? 'Lifetime ended' : 'Lifetime ends'} ${when(box.expires_at, now)}; reception stops then.</p>` : '';
    const reception = !active ? pill('off', ended ? 'Expired, deleting' : 'Deleting') : box.type === 'email' ? pill('warn', 'Any sender')
      : box.closed ? pill('ok', 'Credential required') : pill('warn', 'Open to anyone');
    const name = box.label || (box.type === 'email' ? 'Email inbox' : 'Webhook inbox');
    return `<section class="card" aria-label="${escape(name)}"><div class="card-head"><h2>${escape(name)}</h2><span class="pills">${pill('off', box.type === 'email' ? 'Email' : 'Webhook')}${reception}</span></div><code class="addr">${escape(box.address || box.url)}</code>${box.type === 'http' ? '<p class="hint">Shown as text, not a link: visiting a webhook URL creates a receipt.</p>' : ''}${lifetime}<div class="meters">${meter('Storage', bytes(box.usage.bytes), bytes(box.limits.bytes), box.usage.bytes / box.limits.bytes)}${meter('Today (UTC)', count(box.usage.receipts_today), count(box.limits.daily_receipts), box.usage.receipts_today / box.limits.daily_receipts)}</div><h3>Recent receipts</h3>${receipts}</section>`;
  }));
  const messages = shown.reduce((sum, box) => sum + (Number(box.usage.messages) || 0), 0);
   const summary = `<ul class="stats" aria-label="Summary"><li><b>${shown.length}</b> ${shown.length === 1 ? 'inbox' : 'inboxes'}</li><li><b>${count(messages)}</b> retained or pending ${messages === 1 ? 'message' : 'messages'}</li></ul>`;
  const body = capacity + (cards.length ? snapshot(summary) + cards.join('') + (listing.inboxes.length > shown.length ? '<p class="small muted">Showing the first ten inboxes. Your agent can list the rest.</p>' : '')
    : note('No inboxes yet.', 'Ask your agent to create one through the BayLeaf API.'));
  return page(body + `<details><summary>About this snapshot</summary><ul><li>Inboxes store content for up to 90 days. The operator can technically read it; this page never shows it.</li><li>Excluded here: message bodies, subjects, senders, headers, request paths and credentials.</li><li>Up to five recent receipts per inbox, archived ones included. Storage can include pending or cleanup work.</li><li>Credential-required inboxes are not checked for usable credentials.</li></ul></details><div class="actions small"><a href="/llms.txt#inboxes-receive-email-and-webhooks-while-you-are-away">Manage inboxes with your agent</a></div>`,
    200, 'Addresses, quotas and recent receipt times. Content stays with your agent.');
});

interface Inbox {
  id: string; type: 'email' | 'http'; label: string | null; state: string; address?: string; url?: string; closed?: boolean;
  expires_at?: number | null; cleanup_not_before?: number;
  usage: { bytes: number; messages: number; receipts_today: number };
  limits: { bytes: number; daily_receipts: number };
}
