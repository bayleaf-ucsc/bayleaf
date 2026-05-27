/**
 * Claim-code device flow.
 *
 * A generic browser-mediated handshake that lets an untrusted process running
 * in a terminal acquire the user's existing BayLeaf API key, gated by a
 * one-time approval in a logged-in browser session, without the key ever
 * crossing a screen-visible channel. Modeled on OAuth 2.0 device authorization
 * grant (RFC 8628).
 *
 * Two-code design (this is the screen-share-safe property):
 *
 *   user_code    Short, human-readable (XXXX-XXXX). Displayed in the user's
 *                terminal and on the browser approval page so they can
 *                visually verify they're approving the same session that
 *                their terminal initiated. Appears in the claim_url shared
 *                with the browser. Carries no entropy of cryptographic value.
 *   device_code  Long (128-bit), high-entropy hex string. Held by the polling
 *                terminal as its bearer credential against /poll. Never
 *                displayed to the user, never appears in the browser URL,
 *                never appears on screen during a live demo.
 *
 * An attacker who watches a screen share sees only the user_code. They can
 * use it to *visit* the approval page (and might try social engineering),
 * but they cannot poll for the resulting key without the device_code, which
 * stays in the legitimate terminal's process memory the entire time.
 *
 * Endpoints:
 *
 *   POST /auth/claim/initiate
 *     Public. Body: { client?: string } (free-form short label, e.g. "OpenCode").
 *     Returns: { device_code, user_code, claim_url, expires_in, poll_interval }.
 *     Writes two KV entries (TTL 600s):
 *       claim:device:<DEVICE_CODE>  →  ClaimRecord (the canonical record)
 *       claim:user:<USER_CODE>      →  device_code (lookup index)
 *
 *   GET /auth/claim?c=USER_CODE
 *     Browser-facing. Looks up via the user_code index, then the canonical
 *     record. If the user is not signed in, redirects through /login with a
 *     return-to-here cookie. If signed in, renders an approval page showing
 *     the requesting client's name, the user_code (which the user verifies
 *     matches their terminal), the user's identity, and the requesting IP's
 *     rough origin. Submits to /auth/claim/approve via POST with a CSRF token.
 *
 *   POST /auth/claim/approve
 *     Browser-facing. Session-required, CSRF-checked. Body: form-encoded
 *     user_code + token + action (approve|deny). On approve, fetches (or
 *     mints) the user's existing sk-bayleaf-... token and writes it into the
 *     canonical record with status 'approved'. On deny, sets status 'denied'.
 *
 *   GET /auth/claim/poll?d=DEVICE_CODE
 *     Public. Looks up the canonical record directly by device_code. Returns:
 *       202 { status: "pending" }
 *       200 { status: "approved", key: "sk-bayleaf-..." }  (then deletes KV)
 *       410 { status: "denied" }                            (then deletes KV)
 *       404 { status: "expired" }                           (KV TTL elapsed)
 *
 * KV record (under `claim:device:<DEVICE_CODE>`):
 *   ClaimRecord = {
 *     status: 'pending' | 'approved' | 'denied',
 *     user_code: string,             // for cross-reference / cleanup
 *     client: string,                // sanitized requesting client name
 *     created_at: number,            // ms since epoch (initiate time)
 *     initiator_ip: string | null,   // CF-Connecting-IP at initiate time
 *     initiator_country: string | null, // CF-IPCountry at initiate time
 *     key?: string,                  // populated on approve, deleted on poll
 *     approved_by?: string,          // email of approving user
 *   }
 *
 * Security notes:
 *
 * - The device_code is the bearer credential against /poll. 128 bits of
 *   entropy (32 hex chars) makes guessing irrelevant within the 10-min TTL.
 * - The user_code is decorative for the polling channel: knowing it gives
 *   an attacker no ability to retrieve the key (they'd need to guess the
 *   device_code as well, which they can't observe and can't brute-force).
 * - The CSRF token on the approve form is a HMAC over (user_code, email,
 *   action) signed with OIDC_CLIENT_SECRET. An attacker who tricks a logged-in
 *   user into visiting a malicious URL cannot forge the form submission.
 * - One-shot delivery: GET /auth/claim/poll deletes both KV entries as soon
 *   as it returns the key (or on deny). A second poll returns 404 expired.
 * - Existing-key delivery: we hand back the user's current dashboard key. If
 *   they don't have one yet, we mint one (same code path as POST /key).
 *   Revocation from the dashboard invalidates the key everywhere it's used.
 */

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv, Session, UserKeyRow } from '../types';
import { getSession } from '../utils/session';
import { generateBayleafToken } from '../utils/token';
import {
  getKeyName,
  findKeyByName,
  findKeyByHash,
  createKey,
} from '../openrouter';
import { renderPage, ErrorPage } from '../templates/layout';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';

export const claimRoutes = new Hono<AppEnv>();

// ── Configuration ────────────────────────────────────────────────

/** TTL on KV records (must align with `expires_in` we return to clients). */
const CLAIM_TTL_SECONDS = 600;

/** Poll interval we ask polling clients to honor (informational). */
const POLL_INTERVAL_SECONDS = 1;

/** Max length of the user-supplied client label, after sanitization. */
const CLIENT_LABEL_MAX_LEN = 40;

/** Default client label if the caller doesn't supply one. */
const DEFAULT_CLIENT_LABEL = 'a coding agent';

/** Cookie name for "where to send the user after they sign in" (claim flow only). */
const RETURN_TO_COOKIE = 'claim_return_to';

// ── Types ────────────────────────────────────────────────────────

type ClaimStatus = 'pending' | 'approved' | 'denied';

interface ClaimRecord {
  status: ClaimStatus;
  user_code: string;
  client: string;
  created_at: number;
  initiator_ip: string | null;
  initiator_country: string | null;
  key?: string;
  approved_by?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Generate a short, human-readable user code: 8 Crockford-base32 chars
 * formatted as ABCD-1234. Crockford's alphabet (no I, L, O, U) keeps it
 * unambiguous when read off a screen. This carries ~40 bits of entropy,
 * which is ample for collision-free uniqueness among currently-pending
 * claims under a 10-minute TTL but is *not* the polling credential.
 */
function generateUserCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % 32];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Generate the device code: 32 lowercase hex chars (128 bits of entropy).
 * This is the bearer credential the polling terminal uses against /poll;
 * never displayed on screen, never appears in any URL the user opens.
 */
function generateDeviceCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Normalize a user code from URL/form input (uppercase, strip whitespace). */
function normalizeUserCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Light validation on a user code: must match ABCD-1234 after normalization. */
function isWellFormedUserCode(code: string): boolean {
  return /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code);
}

/** Validation on a device code: 32 lowercase hex chars exactly. */
function isWellFormedDeviceCode(code: string): boolean {
  return /^[0-9a-f]{32}$/.test(code);
}

/**
 * Sanitize the user-supplied client label.
 *
 * The label is rendered verbatim on the approval page (an HTML form), so we
 * must strip anything that could break out of the surrounding text node or
 * attribute. We allow only letters, digits, space, and a small set of safe
 * punctuation. Length is capped. Empty input falls back to the default.
 */
function sanitizeClientLabel(input: unknown): string {
  if (typeof input !== 'string') return DEFAULT_CLIENT_LABEL;
  const cleaned = input
    .replace(/[^A-Za-z0-9 _.\-+@/()]/g, '')
    .trim()
    .slice(0, CLIENT_LABEL_MAX_LEN);
  return cleaned || DEFAULT_CLIENT_LABEL;
}

/**
 * HMAC-SHA-256 over a canonical string, returning a base64url digest.
 * Used for CSRF tokens scoped to (email, user_code, action).
 */
async function hmacSign(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** CSRF token canonical input: `${email}|${userCode}|${action}`. */
async function csrfToken(secret: string, email: string, userCode: string, action: string): Promise<string> {
  return hmacSign(secret, `${email}|${userCode}|${action}`);
}

/** Constant-time string compare to thwart token-shape timing leaks. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolve the user's current sk-bayleaf-... token, minting one if they don't
 * have an active key yet. Returns null on persistent failure to provision.
 *
 * This duplicates a chunk of POST /key intentionally rather than refactoring;
 * the path is simple enough that pulling it into a shared helper would just
 * push the orchestration around without making it clearer. If the dashboard
 * provisioning logic grows further we'll factor it.
 */
async function ensureUserToken(
  email: string,
  env: AppEnv['Bindings'],
): Promise<string | null> {
  const active = await env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 0',
  ).bind(email).first<UserKeyRow>();
  if (active) {
    // Self-heal if the OR key is gone — same logic as ensureOrKey in routes/key.ts
    const orKey = await findKeyByHash(active.or_key_hash, env);
    if (orKey && !orKey.disabled) return active.bayleaf_token;

    console.log(`Self-healing OR key for ${email} during claim flow`);
    const keyName = getKeyName(email, env.KEY_NAME_TEMPLATE);
    const newOrKey = await createKey(keyName, env);
    if (!newOrKey?.key) return null;
    await env.DB.prepare(
      'UPDATE user_keys SET or_key_hash = ?, or_key_secret = ? WHERE email = ?',
    ).bind(newOrKey.hash, newOrKey.key, email).run();
    return active.bayleaf_token;
  }

  // No active row — provision a fresh key, reusing a revoked OR key only if
  // it's still alive upstream. Mirrors POST /key's logic.
  const revoked = await env.DB.prepare(
    'SELECT * FROM user_keys WHERE email = ? AND revoked = 1',
  ).bind(email).first<UserKeyRow>();

  const keyName = getKeyName(email, env.KEY_NAME_TEMPLATE);
  let orKeyHash: string;
  let orKeySecret: string;

  if (revoked) {
    const orKey = await findKeyByHash(revoked.or_key_hash, env);
    if (orKey && !orKey.disabled) {
      orKeyHash = revoked.or_key_hash;
      orKeySecret = revoked.or_key_secret;
    } else {
      const newOrKey = await createKey(keyName, env);
      if (!newOrKey?.key) return null;
      orKeyHash = newOrKey.hash;
      orKeySecret = newOrKey.key;
    }
  } else {
    const _existingOrKey = await findKeyByName(keyName, env); // defensive lookup, can't adopt without secret
    void _existingOrKey;
    const newOrKey = await createKey(keyName, env);
    if (!newOrKey?.key) return null;
    orKeyHash = newOrKey.hash;
    orKeySecret = newOrKey.key;
  }

  const bayleafToken = generateBayleafToken();
  if (revoked) {
    await env.DB.prepare(
      "UPDATE user_keys SET bayleaf_token = ?, or_key_hash = ?, or_key_secret = ?, revoked = 0, created_at = datetime('now') WHERE email = ?",
    ).bind(bayleafToken, orKeyHash, orKeySecret, email).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO user_keys (email, bayleaf_token, or_key_hash, or_key_secret) VALUES (?, ?, ?, ?)',
    ).bind(email, bayleafToken, orKeyHash, orKeySecret).run();
  }
  return bayleafToken;
}

// ── POST /auth/claim/initiate ────────────────────────────────────

claimRoutes.post('/initiate', async (c) => {
  // Body is optional (just a client label). Tolerate empty/non-JSON bodies.
  let clientLabel = DEFAULT_CLIENT_LABEL;
  try {
    const ct = c.req.header('Content-Type') ?? '';
    if (ct.includes('application/json')) {
      const body = await c.req.json<{ client?: unknown }>().catch(() => ({} as { client?: unknown }));
      clientLabel = sanitizeClientLabel(body.client);
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      const form = await c.req.parseBody().catch(() => ({}));
      clientLabel = sanitizeClientLabel((form as Record<string, unknown>).client);
    }
  } catch {
    // fall through with default label
  }

  // Generate codes, retrying on the (vanishingly rare) collision in either index.
  let userCode = generateUserCode();
  let deviceCode = generateDeviceCode();
  for (let i = 0; i < 5; i++) {
    const userCollision = await c.env.CLAIM_CODES.get(`claim:user:${userCode}`);
    const deviceCollision = await c.env.CLAIM_CODES.get(`claim:device:${deviceCode}`);
    if (!userCollision && !deviceCollision) break;
    if (userCollision) userCode = generateUserCode();
    if (deviceCollision) deviceCode = generateDeviceCode();
  }

  const record: ClaimRecord = {
    status: 'pending',
    user_code: userCode,
    client: clientLabel,
    created_at: Date.now(),
    initiator_ip: c.req.header('CF-Connecting-IP') ?? null,
    initiator_country: c.req.header('CF-IPCountry') ?? null,
  };
  // Two writes: canonical record under device_code, lookup pointer under user_code.
  // KV writes are independent; if the second one fails the first is harmless and
  // will TTL out. (Workers KV doesn't offer transactions; this pair is idempotent.)
  await c.env.CLAIM_CODES.put(`claim:device:${deviceCode}`, JSON.stringify(record), {
    expirationTtl: CLAIM_TTL_SECONDS,
  });
  await c.env.CLAIM_CODES.put(`claim:user:${userCode}`, deviceCode, {
    expirationTtl: CLAIM_TTL_SECONDS,
  });

  const url = new URL(c.req.url);
  const baseUrl = absoluteBaseUrl(url);
  // Note: device_code is intentionally NOT logged. The user_code is fine to log
  // (carries no secret value) and is useful for support / audit.
  console.log(`claim initiate: user_code=${userCode} client=${clientLabel} ip=${record.initiator_ip ?? '-'} country=${record.initiator_country ?? '-'}`);

  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    claim_url: `${baseUrl}/auth/claim?c=${encodeURIComponent(userCode)}`,
    expires_in: CLAIM_TTL_SECONDS,
    poll_interval: POLL_INTERVAL_SECONDS,
  });
});

// ── GET /auth/claim?c=USER_CODE ──────────────────────────────────

claimRoutes.get('/', async (c) => {
  const codeRaw = c.req.query('c') ?? '';
  const userCode = normalizeUserCode(codeRaw);

  if (!isWellFormedUserCode(userCode)) {
    return renderPage(
      c,
      <ErrorPage title="Invalid claim code" message="The link you followed has a malformed claim code. Return to your terminal and run the setup command again." />,
      400,
    );
  }

  // Session-required. If absent, set a return-to cookie and redirect through /login.
  const session = await getSession(c);
  if (!session) {
    setCookie(c, RETURN_TO_COOKIE, `/auth/claim?c=${encodeURIComponent(userCode)}`, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 600,
      secure: new URL(c.req.url).hostname !== 'localhost',
    });
    return c.redirect('/login', 302);
  }

  // Lookup user_code -> device_code -> record.
  const deviceCode = await c.env.CLAIM_CODES.get(`claim:user:${userCode}`);
  if (!deviceCode) {
    return renderPage(
      c,
      <ErrorPage title="Claim code expired" message="This claim code has expired or was already used. Return to your terminal and run the setup command again to start over." />,
      404,
    );
  }
  const recordRaw = await c.env.CLAIM_CODES.get(`claim:device:${deviceCode}`);
  if (!recordRaw) {
    return renderPage(
      c,
      <ErrorPage title="Claim code expired" message="This claim code has expired or was already used. Return to your terminal and run the setup command again to start over." />,
      404,
    );
  }
  const record = JSON.parse(recordRaw) as ClaimRecord;

  if (record.status !== 'pending') {
    return renderPage(
      c,
      <ErrorPage title="Already responded" message={`This claim was already ${record.status}. Return to your terminal and run the setup command again if you need to start over.`} />,
      409,
    );
  }

  const approveTok = await csrfToken(c.env.OIDC_CLIENT_SECRET, session.email, userCode, 'approve');
  const denyTok = await csrfToken(c.env.OIDC_CLIENT_SECRET, session.email, userCode, 'deny');
  return renderPage(
    c,
    <ApprovalPage
      session={session}
      userCode={userCode}
      record={record}
      approveTok={approveTok}
      denyTok={denyTok}
    />,
  );
});

// ── POST /auth/claim/approve ─────────────────────────────────────

claimRoutes.post('/approve', async (c) => {
  const session = await getSession(c);
  if (!session) {
    return renderPage(c, <ErrorPage title="Sign in required" message="Your session expired. Sign in and try again." />, 401);
  }

  const form = await c.req.parseBody().catch(() => ({}));
  const codeRaw = String((form as Record<string, unknown>).code ?? '');
  const action = String((form as Record<string, unknown>).action ?? '');
  const submittedToken = String((form as Record<string, unknown>).token ?? '');
  const userCode = normalizeUserCode(codeRaw);

  if (!isWellFormedUserCode(userCode) || (action !== 'approve' && action !== 'deny')) {
    return renderPage(c, <ErrorPage title="Bad request" message="Malformed approval form." />, 400);
  }

  const expected = await csrfToken(c.env.OIDC_CLIENT_SECRET, session.email, userCode, action);
  if (!constantTimeEqual(expected, submittedToken)) {
    return renderPage(c, <ErrorPage title="Security check failed" message="Form token didn't validate. Reload the approval page and try again." />, 403);
  }

  const deviceCode = await c.env.CLAIM_CODES.get(`claim:user:${userCode}`);
  if (!deviceCode) {
    return renderPage(c, <ErrorPage title="Claim code expired" message="This claim code has expired. Return to your terminal and run the setup command again." />, 404);
  }
  const recordRaw = await c.env.CLAIM_CODES.get(`claim:device:${deviceCode}`);
  if (!recordRaw) {
    return renderPage(c, <ErrorPage title="Claim code expired" message="This claim code has expired. Return to your terminal and run the setup command again." />, 404);
  }
  const record = JSON.parse(recordRaw) as ClaimRecord;
  if (record.status !== 'pending') {
    return renderPage(c, <ErrorPage title="Already responded" message={`This claim was already ${record.status}.`} />, 409);
  }

  if (action === 'deny') {
    record.status = 'denied';
    record.approved_by = session.email;
    await c.env.CLAIM_CODES.put(`claim:device:${deviceCode}`, JSON.stringify(record), {
      expirationTtl: CLAIM_TTL_SECONDS,
    });
    console.log(`claim deny: user_code=${userCode} email=${session.email} client=${record.client}`);
    return renderPage(c, <ResultPage kind="denied" client={record.client} />);
  }

  // action === 'approve'
  const token = await ensureUserToken(session.email, c.env);
  if (!token) {
    return renderPage(c, <ErrorPage title="Could not provision a key" message="Failed to provision your BayLeaf API key. Try the dashboard's Get key flow first, then run the setup command again." />, 500);
  }
  record.status = 'approved';
  record.approved_by = session.email;
  record.key = token;
  await c.env.CLAIM_CODES.put(`claim:device:${deviceCode}`, JSON.stringify(record), {
    expirationTtl: CLAIM_TTL_SECONDS,
  });
  console.log(`claim approve: user_code=${userCode} email=${session.email} client=${record.client}`);
  return renderPage(c, <ResultPage kind="approved" client={record.client} />);
});

// ── GET /auth/claim/poll?d=DEVICE_CODE ───────────────────────────

claimRoutes.get('/poll', async (c) => {
  const deviceCode = (c.req.query('d') ?? '').trim();
  if (!isWellFormedDeviceCode(deviceCode)) {
    return c.json({ status: 'expired' }, 404);
  }

  const recordRaw = await c.env.CLAIM_CODES.get(`claim:device:${deviceCode}`);
  if (!recordRaw) {
    return c.json({ status: 'expired' }, 404);
  }
  const record = JSON.parse(recordRaw) as ClaimRecord;

  if (record.status === 'pending') {
    return c.json({ status: 'pending' }, 202);
  }
  if (record.status === 'denied') {
    // One-shot delete on denial too, so a denied code can't be polled forever.
    await c.env.CLAIM_CODES.delete(`claim:device:${deviceCode}`);
    await c.env.CLAIM_CODES.delete(`claim:user:${record.user_code}`);
    return c.json({ status: 'denied' }, 410);
  }
  // approved
  if (!record.key) {
    // Shouldn't happen — defensive.
    await c.env.CLAIM_CODES.delete(`claim:device:${deviceCode}`);
    await c.env.CLAIM_CODES.delete(`claim:user:${record.user_code}`);
    return c.json({ status: 'expired' }, 404);
  }
  await c.env.CLAIM_CODES.delete(`claim:device:${deviceCode}`);
  await c.env.CLAIM_CODES.delete(`claim:user:${record.user_code}`);
  console.log(`claim poll-success: user_code=${record.user_code} email=${record.approved_by ?? '-'}`);
  return c.json({ status: 'approved', key: record.key }, 200);
});

// ── Pages ─────────────────────────────────────────────────────────

interface ApprovalPageProps {
  session: Session;
  userCode: string;
  record: ClaimRecord;
  approveTok: string;
  denyTok: string;
}

function ApprovalPage({ session, userCode, record, approveTok, denyTok }: ApprovalPageProps) {
  const ipLine = record.initiator_ip
    ? `from ${record.initiator_ip}${record.initiator_country ? ` (${record.initiator_country})` : ''}`
    : 'from an unknown address';

  // Inline styles only here — this page is one-shot, no need to thread CSS through layout.
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Authorize — BayLeaf API</title>
        {html`<style>
          * { box-sizing: border-box; }
          body { font-family: system-ui,-apple-system,sans-serif; line-height: 1.6;
            max-width: 560px; margin: 0 auto; padding: 2rem 1rem; background: #fafafa; color: #333; }
          h1 { color: #003c6c; margin-top: 0; }
          .code { font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size: 2rem;
            background: #1a1a1a; color: #0f0; padding: 1rem 1.25rem; border-radius: 6px;
            text-align: center; letter-spacing: 0.1em; margin: 1.5rem 0; user-select: all; }
          .ident { background: white; border: 1px solid #ccc; border-radius: 6px; padding: 1rem; margin: 1rem 0; }
          .ident strong { color: #003c6c; }
          .meta { color: #555; font-size: 0.9rem; }
          form { display: inline; }
          button { padding: 0.75rem 1.5rem; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
          .approve { background: #003c6c; color: white; }
          .approve:hover { background: #005a9e; }
          .deny { background: white; color: #333; border: 1px solid #ccc; margin-left: 0.5rem; }
          .actions { margin-top: 1.5rem; }
          .warn { font-size: 0.9rem; color: #7a5a00; background: #fff8e1; border: 1px solid #ffd54f;
            padding: 0.75rem; border-radius: 4px; margin-top: 1rem; }
        </style>`}
      </head>
      <body>
        <h1>Authorize {record.client}</h1>
        <p>
          A program in your terminal is requesting access to BayLeaf as you. Confirm
          that the code below matches the one shown in your terminal:
        </p>
        <div class="code">{userCode}</div>
        <div class="ident">
          <p style="margin: 0 0 0.5rem 0;">
            Sign in as: <strong>{session.email}</strong>
          </p>
          <p class="meta" style="margin: 0;">
            Request {ipLine}.
            {' '}<a href="/logout">Switch account</a>
          </p>
        </div>
        <p>
          On approval, your BayLeaf API key will be sent to the requesting terminal
          (only that one time, only that one terminal). The key never appears on
          screen and is not written to your shell history.
        </p>
        <p class="warn">
          If you didn't initiate this request, click <strong>Deny</strong>. If the
          code above doesn't match what you see in your terminal,
          {' '}<strong>do not approve.</strong>
        </p>
        <div class="actions">
          <form method="post" action="/auth/claim/approve">
            <input type="hidden" name="code" value={userCode} />
            <input type="hidden" name="action" value="approve" />
            <input type="hidden" name="token" value={approveTok} />
            <button type="submit" class="approve">Approve</button>
          </form>
          <form method="post" action="/auth/claim/approve">
            <input type="hidden" name="code" value={userCode} />
            <input type="hidden" name="action" value="deny" />
            <input type="hidden" name="token" value={denyTok} />
            <button type="submit" class="deny">Deny</button>
          </form>
        </div>
      </body>
    </html>
  );
}

interface ResultPageProps {
  kind: 'approved' | 'denied';
  client: string;
}

function ResultPage({ kind, client }: ResultPageProps) {
  const title = kind === 'approved' ? 'Approved' : 'Denied';
  const msg = kind === 'approved'
    ? `${client} has been authorized. Return to your terminal — your agent should be configured automatically within a few seconds.`
    : `Authorization for ${client} was denied. You can close this tab.`;
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title} — BayLeaf API</title>
        {html`<style>
          body { font-family: system-ui,-apple-system,sans-serif; line-height: 1.6;
            max-width: 560px; margin: 0 auto; padding: 2rem 1rem; background: #fafafa; color: #333; }
          h1 { color: #003c6c; margin-top: 0; }
        </style>`}
      </head>
      <body>
        <h1>{title}</h1>
        <p>{msg}</p>
      </body>
    </html>
  );
}

// ── Tiny URL helper ──────────────────────────────────────────────

/**
 * See routes/wellknown.ts for the rationale. Kept local to avoid a cross-route
 * import dependency.
 */
function absoluteBaseUrl(u: URL): string {
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0';
  return `${isLocal ? u.protocol.replace(':', '') : 'https'}://${u.host}`;
}

// ── Login return-to support ──────────────────────────────────────

/**
 * Read the return-to cookie set on /auth/claim's redirect-to-login path,
 * delete it, and return the value if it's a safe-looking same-origin path.
 * Used by routes/auth.tsx after successful OIDC callback.
 */
export function consumeClaimReturnTo(c: import('hono').Context<AppEnv>): string | null {
  const cookieVal = getCookie(c, RETURN_TO_COOKIE);
  if (!cookieVal) return null;
  deleteCookie(c, RETURN_TO_COOKIE, { path: '/' });
  // Only honor a same-origin path that starts with /auth/claim?c= (avoid open-redirect).
  if (/^\/auth\/claim\?c=[A-Z0-9-]{1,16}$/i.test(cookieVal)) return cookieVal;
  return null;
}
