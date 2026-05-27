/**
 * Authentication Route Handlers
 *
 * Provider-agnostic OIDC sign-in, callback, and logout.
 * Endpoints are discovered from OIDC_ISSUER via .well-known/openid-configuration.
 * Extra authorize parameters (e.g. idphint for CILogon, hd for Google) are
 * injected from the OIDC_AUTHORIZE_PARAMS env var.
 *
 * These are browser-facing HTML routes, not API endpoints — hidden from OpenAPI docs.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../types';
import { discoverOIDC } from '../constants';
import { setSessionCookie, clearSessionCookie } from '../utils/session';
import { ErrorPage, renderPage } from '../templates/layout';
import { consumeClaimReturnTo } from './claim';

export const authRoutes = new OpenAPIHono<AppEnv>();

/**
 * GET /login - Start OIDC flow
 */
authRoutes.get('/login', async (c) => {
  const url = new URL(c.req.url);
  const state = crypto.randomUUID();

  const oidc = await discoverOIDC(c.env.OIDC_ISSUER);

  const authUrl = new URL(oidc.authorization_endpoint);
  authUrl.searchParams.set('client_id', c.env.OIDC_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', c.env.OIDC_SCOPES);
  authUrl.searchParams.set('state', state);

  // Append provider-specific params (e.g. "idphint=urn:mace:incommon:ucsc.edu" or "hd=ucsc.edu")
  if (c.env.OIDC_AUTHORIZE_PARAMS) {
    const extra = new URLSearchParams(c.env.OIDC_AUTHORIZE_PARAMS);
    for (const [key, value] of extra) {
      authUrl.searchParams.set(key, value);
    }
  }

  setCookie(c, 'oauth_state', state, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 600 });
  return c.redirect(authUrl.toString(), 302);
});

/**
 * GET /callback - OIDC callback
 */
authRoutes.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return renderPage(c, <ErrorPage title="Login Failed" message={`Identity provider returned an error: ${error}`} />, 400);
  }

  if (!code || !state) {
    return renderPage(c, <ErrorPage title="Login Failed" message="Missing authorization code or state." />, 400);
  }

  // Verify state
  if (state !== getCookie(c, 'oauth_state')) {
    return renderPage(c, <ErrorPage title="Login Failed" message="Invalid state parameter. Please try again." />, 400);
  }

  const oidc = await discoverOIDC(c.env.OIDC_ISSUER);

  // Exchange code for tokens
  const origin = new URL(c.req.url).origin;
  const tokenResponse = await fetch(oidc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.OIDC_CLIENT_ID,
      client_secret: c.env.OIDC_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${origin}/callback`,
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    console.error('Token exchange failed:', err);
    return renderPage(c, <ErrorPage title="Login Failed" message="Failed to exchange authorization code." />, 500);
  }

  const tokens = await tokenResponse.json() as { access_token: string };

  // Get user info
  const userResponse = await fetch(oidc.userinfo_endpoint, {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` },
  });

  if (!userResponse.ok) {
    return renderPage(c, <ErrorPage title="Login Failed" message="Failed to get user information." />, 500);
  }

  const user = await userResponse.json() as { email: string; name: string; picture?: string };

  // Verify email domain
  if (!user.email.endsWith(`@${c.env.ALLOWED_EMAIL_DOMAIN}`)) {
    return renderPage(c, <ErrorPage title="Access Denied" message={`Only @${c.env.ALLOWED_EMAIL_DOMAIN} accounts are allowed.`} />, 403);
  }

  // Create session
  await setSessionCookie(c, {
    email: user.email,
    name: user.name,
    picture: user.picture,
  });
  // If a claim flow stashed a return-to cookie, send the user back to it.
  // The cookie value is sanity-checked inside consumeClaimReturnTo (must be
  // a `/auth/claim?c=<short-code>` path) to prevent open-redirect abuse.
  const returnTo = consumeClaimReturnTo(c);
  return c.redirect(returnTo ?? '/dashboard', 302);
});

/**
 * GET /logout - Clear session
 */
authRoutes.get('/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/', 302);
});
