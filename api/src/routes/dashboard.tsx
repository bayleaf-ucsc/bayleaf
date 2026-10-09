/**
 * Dashboard Route Handlers
 * Browser-facing HTML routes — hidden from OpenAPI docs.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv, OpenRouterKey } from '../types';
import { getSession } from '../utils/session';
import { getAuthIP, isCampusPassEligible } from '../utils/ip';
import { inspectCounter, parseLimit } from '../utils/campusRpd';
import { getActiveRow, resolveOrKeyInfo } from '../provision';
import { findSandboxByLabel, getSandboxInfo, type SandboxInfo } from '../daytona';
import { LandingPage, type CampusUsage } from '../templates/landing';
import { DashboardPage, type AltBackendUsage } from '../templates/dashboard';
import { renderPage } from '../templates/layout';
import { ALT_BACKENDS, isBackendEnabled } from '../constants';
import { isSealedEnabled } from './sealed';
import { maxGrantSeconds } from '../grants';
import { getTinfoilUsage } from '../tinfoil';

export const dashboardRoutes = new OpenAPIHono<AppEnv>();

/** GET / - Landing page (redirects to dashboard if logged in) */
dashboardRoutes.get('/', async (c) => {
  const session = await getSession(c);
  if (session) return c.redirect('/dashboard');

  const showCampusPass = isCampusPassEligible(c.req.raw, c.env);

  // When the visitor is eligible for Campus Pass, look up their per-IP RPD
  // counter and surface it on the card. The IP is the lookup key but is
  // never sent back to the client — only the count, limit, and reset time.
  let campusUsage: CampusUsage | undefined;
  if (showCampusPass) {
    try {
      const ip = getAuthIP(c.req.raw, c.env);
      if (!ip) throw new Error('No auth IP despite campus eligibility');
      const limit = parseLimit(c.env.CAMPUS_RPD_LIMIT);
      const status = await inspectCounter(c.env.CAMPUS_RPD, ip, limit);
      campusUsage = {
        count: status.count,
        limit: status.limit,
        remaining: status.remaining,
        resetsAt: status.resetsAt,
      };
    } catch (e) {
      // Don't fail the page if KV is briefly unavailable; just omit the usage line.
      console.error('Failed to inspect campus RPD counter:', e);
    }
  }

  return renderPage(
    c,
    <LandingPage
      showCampusPass={showCampusPass}
      recommendedModel={c.env.RECOMMENDED_MODEL}
      loginButtonText={c.env.OIDC_LOGIN_BUTTON_TEXT}
      campusUsage={campusUsage}
    />,
  );
});

/** GET /dashboard - Main user interface */
dashboardRoutes.get('/dashboard', async (c) => {
  // Token management now lives here; retain its cache and framing protections.
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'");
  const session = await getSession(c);
  if (!session) return c.redirect('/login');

  // Look up the user's proxy key mapping in D1, self-healing the upstream OR
  // key if it has gone away. A null orKey here is not fatal: we render the
  // page without usage numbers rather than erroring out the whole dashboard.
  const row = await getActiveRow(session.email, c.env);
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayStart = new Date(`${today}T00:00:00.000Z`);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sealedEnabled = isSealedEnabled(c.env);
  // Start both metadata reads together. No key minting/healing or D1 writes.
  const sealedBilling = row && sealedEnabled && row.tinfoil_key
    ? Promise.all([
        getTinfoilUsage(row.tinfoil_key, dayStart, now, c.env),
        getTinfoilUsage(row.tinfoil_key, monthStart, now, c.env),
      ])
    : Promise.resolve([null, null] as const);
  const orKey: OpenRouterKey | null = row ? (await resolveOrKeyInfo(row, c.env))?.orKey ?? null : null;

  // Fetch sandbox status (non-blocking — don't fail the page if this errors).
  let sandboxInfo: SandboxInfo | null = null;
  if (row && c.env.DAYTONA_API_KEY) {
    try {
      if (row.daytona_sandbox_id) {
        try {
          sandboxInfo = await getSandboxInfo(row.daytona_sandbox_id, c.env);
        } catch {
          sandboxInfo = await findSandboxByLabel(session.email, c.env);
          await c.env.DB.prepare(
            'UPDATE user_keys SET daytona_sandbox_id = ? WHERE email = ? AND revoked = 0',
          ).bind(sandboxInfo?.id ?? null, session.email).run();
        }
      } else {
        sandboxInfo = await findSandboxByLabel(session.email, c.env);
        if (sandboxInfo) {
          await c.env.DB.prepare(
            'UPDATE user_keys SET daytona_sandbox_id = ? WHERE email = ? AND revoked = 0',
          ).bind(sandboxInfo.id, session.email).run();
        }
      }
    } catch (e) {
      console.error('Failed to fetch sandbox status:', e);
    }
  }

  const gwsEnabled = !!(c.env.GWS_CLIENT_ID && c.env.GWS_CLIENT_SECRET && c.env.GWS_PROJECT_ID);
  // Build the per-backend RPD view model from ALT_BACKENDS so the LLM card
  // stays in sync with the actual set of alternate backends. Only enabled
  // backends are surfaced; today's count falls back to 0 when the stored
  // date is stale (the next request resets the counter).
  const altBackendUsage: AltBackendUsage[] = row
    ? ALT_BACKENDS.filter((b) => isBackendEnabled(c.env, b.key)).map((b) => {
        const count = row[b.rpdDateField] === today ? row[b.rpdCountField] : 0;
        return { label: b.label, count, limit: b.rpdLimit };
      })
    : [];

  const [sealedToday, sealedMonth] = await sealedBilling;
  const sealedUsage = row && sealedEnabled ? {
    count: row.sealed_rpd_date === today ? row.sealed_rpd_count : 0,
    limit: parseLimit(c.env.SEALED_RPD_LIMIT),
    hasProviderKey: !!row.tinfoil_key,
    today: sealedToday,
    month: sealedMonth,
  } : undefined;

  return renderPage(c, <DashboardPage session={session} row={row} orKey={orKey} recommendedModel={c.env.RECOMMENDED_MODEL} sandboxInfo={sandboxInfo} gwsEnabled={gwsEnabled} sealedEnabled={sealedEnabled} sealedUsage={sealedUsage} grantsEnabled={c.env.GRANTS_ENABLED === 'true'} grantMaxSeconds={maxGrantSeconds(c.env)} sealedRecommendedModel={c.env.SEALED_RECOMMENDED_MODEL} altBackendUsage={altBackendUsage} />);
});
