/**
 * Authentication Route Handlers
 *
 * Google OIDC sign-in, callback, and logout.
 * Browser-facing HTML routes — plain Hono, no OpenAPI.
 */

import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../types';
import { GOOGLE_OIDC } from '../constants';
import { setSessionCookie, clearSessionCookie } from '../utils/session';
import { ErrorPage } from '../templates/layout';

export const authRoutes = new Hono<AppEnv>();

/**
 * GET /login - Start OIDC flow
 */
authRoutes.get('/login', (c) => {
  const url = new URL(c.req.url);
  const state = crypto.randomUUID();

  const authUrl = new URL(GOOGLE_OIDC.authorizationEndpoint);
  authUrl.searchParams.set('client_id', c.env.OIDC_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', `${url.origin}/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('hd', c.env.ALLOWED_EMAIL_DOMAIN);

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
    return c.html(<ErrorPage title="Login Failed" message={`Google returned an error: ${error}`} />, 400);
  }

  if (!code || !state) {
    return c.html(<ErrorPage title="Login Failed" message="Missing authorization code or state." />, 400);
  }

  // Verify state
  if (state !== getCookie(c, 'oauth_state')) {
    return c.html(<ErrorPage title="Login Failed" message="Invalid state parameter. Please try again." />, 400);
  }

  // Exchange code for tokens
  const origin = new URL(c.req.url).origin;
  const tokenResponse = await fetch(GOOGLE_OIDC.tokenEndpoint, {
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
    return c.html(<ErrorPage title="Login Failed" message="Failed to exchange authorization code." />, 500);
  }

  const tokens = await tokenResponse.json() as { access_token: string };

  // Get user info
  const userResponse = await fetch(GOOGLE_OIDC.userinfoEndpoint, {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` },
  });

  if (!userResponse.ok) {
    return c.html(<ErrorPage title="Login Failed" message="Failed to get user information." />, 500);
  }

  const user = await userResponse.json() as { email: string; name: string; picture?: string };

  // Verify email domain
  if (!user.email.endsWith(`@${c.env.ALLOWED_EMAIL_DOMAIN}`)) {
    return c.html(<ErrorPage title="Access Denied" message={`Only @${c.env.ALLOWED_EMAIL_DOMAIN} accounts are allowed.`} />, 403);
  }

  // Create session
  await setSessionCookie(c, {
    email: user.email,
    name: user.name,
    picture: user.picture,
  });
  return c.redirect('/', 302);
});

/**
 * GET /logout - Clear session
 */
authRoutes.get('/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/', 302);
});
