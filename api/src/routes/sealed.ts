/**
 * BayLeaf Sealed: EHBP ciphertext relay (issue #55, enabled in production)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 *
 * Every other inference lane in this Worker (`openrouter:`, `vertex:`,
 * `bedrock:`) forwards **plaintext** through `routes/proxy.ts`. That makes the
 * BayLeaf-operator ZOA story a *posture*: an operator with deploy rights could
 * ship a revision that logs request bodies (see `AGENTS.md`).
 *
 * The Sealed lane is the one route where that is not true. The client uses a
 * Tinfoil SDK to verify a hardware attestation and then encrypts the request
 * body to the attested enclave's HPKE key using EHBP (Encrypted HTTP Body
 * Protocol, RFC 9180 HPKE at the application layer, independent of TLS). This
 * Worker relays those bytes. It is on the auth path and can meter usage, but it
 * does not hold the enclave-bound key, so a malicious logging revision would
 * capture ciphertext.
 *
 * The precise, testable claim — deliberately narrower than "traffic never
 * touches BayLeaf":
 *
 *   BayLeaf carries encrypted traffic but does not possess the enclave-bound
 *   key required to read it. Plaintext requests are rejected rather than
 *   downgraded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE FILE AND NOT A MODE BIT ON proxy.ts
 *
 * A boolean on the plaintext proxy would be one inverted condition away from
 * silently downgrading sealed traffic to a readable path. The two routes have
 * opposite obligations: `proxy.ts` parses JSON for validation, attribution,
 * routing, metering, and replayable credential healing; this route MUST NEVER
 * parse the body. Those cannot safely share a handler. Sealed constants also
 * live here rather than in `constants.ts` because this lane is not an
 * `ALT_BACKENDS` row — it has no `<prefix>:` model routing and no plaintext
 * forwarding block.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POKA-YOKE INVARIANTS (each maps to a check below; do not relax casually)
 *
 *  1. Kill-switch fails closed: `SEALED_ENABLED` must be exactly "true".
 *  2. `/sealed/v1/*` accepts POST only. No GET, no bodyless requests. This one
 *     is genuinely cryptographic, not stylistic: see the note below.
 *  3. `Ehbp-Encapsulated-Key` required, strict 64-lowercase-hex syntax.
 *  4. Enclave destination allowlisted to https + `*.tinfoil.sh`, no redirects.
 *  5. Client-supplied Tinfoil credentials rejected; BayLeaf credential stripped
 *     before forwarding; the server-side key is substituted.
 *  6. The body is NEVER parsed, cloned, schema-validated, or logged. It is
 *     passed as an opaque stream.
 *  7. A 2xx upstream response MUST carry `Ehbp-Response-Nonce` or we fail
 *     closed — that header is what proves the response came back encrypted.
 *  8. There is no fallback to `/v1/*`. Any failure is an error, never a
 *     downgrade.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY BAYLEAF CANNOT READ EITHER DIRECTION, AND WHY POST-ONLY IS THE HINGE
 *
 * The server-side `tk_` credential is a bearer *authorization* token. It grants
 * no cryptographic capability against EHBP. Confidentiality binds to the
 * attested enclave keypair, not to the account credential, which is exactly how
 * BayLeaf can be the biller without being a reader.
 *
 * Requests: the client encapsulates an ephemeral X25519 key against the
 * enclave's public key. `Ehbp-Encapsulated-Key` carries the ephemeral PUBLIC
 * key. Decapsulation needs the enclave's private key (sealed in the TEE) or the
 * client's ephemeral private key (never transmitted). We hold neither.
 *
 * Responses: NOT encrypted under a fresh key that crosses the wire. The key is
 * derived from the same HPKE context:
 *
 *     exported_secret = context.export("ehbp response", 32)
 *     salt            = encapsulated_key || response_nonce
 *     prk             = HKDF-Extract(salt, exported_secret)
 *     key             = HKDF-Expand(prk, "key", 32)
 *
 * We see the whole salt and neither half of the input keying material.
 * `Ehbp-Response-Nonce` is a SALT, not a key, which is why relaying it in a
 * cleartext header is safe.
 *
 * Now the hinge. We are an ACTIVE intermediary, so ask whether we could
 * substitute our own encapsulated key and read the enclave's reply to us. For a
 * request WITH an encrypted body: no. The body was sealed to a context derived
 * from the client's key, so swapping the key makes the body undecryptable and
 * the enclave rejects it. The body cryptographically binds the key, which the
 * EHBP spec calls "implicit authentication of the encapsulated key."
 *
 * For a BODYLESS request that binding does not exist, and the substitution
 * works. Quoting the spec directly:
 *
 *   "Requests without a body (GET, HEAD, DELETE, OPTIONS) cannot have encrypted
 *    responses. The encrypted request body provides implicit authentication of
 *    the encapsulated key: without it, a man-in-the-middle could substitute
 *    their own key."
 *
 * That is why invariant 2 exists and why the model catalog is a separate
 * endpoint rather than a GET on this route. Allowing a bodyless request through
 * `/sealed/v1/*` would hand this relay the one capability the lane exists to
 * deny it. Do not "helpfully" add GET support here.
 *
 * What remains possible for a malicious BayLeaf is to originate its OWN EHBP
 * session and read those replies. But it cannot recover the user's prompt to
 * ask anything meaningful, so that is forgery and cost abuse, not a
 * confidentiality break of user data.
 *
 * What BayLeaf sees regardless: headers, timing, byte sizes, request counts,
 * caller identity, and the upstream token-usage header. Content, no. Metadata,
 * yes. Say both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEFERRED SCOPE
 *
 * `/sealed/policy` (the C1–C6 rubric and pinned-measurement artifact) remains
 * deferred. OpenAPI paths are registered manually below while handlers remain
 * plain Hono: this preserves the wildcard route and, more importantly, ensures
 * no validation middleware ever parses the opaque EHBP request body.
 */

import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv, Bindings } from '../types';
import { resolveAuth } from '../utils/auth';
import { resolveBackendCredential } from '../utils/backend';
import { healBackendKey } from '../provision';
import { checkAndIncrement, parseLimit } from '../utils/campusRpd';
import {
  SealedAttestationRequestSchema,
  SealedAttestationResponseSchema,
  SealedErrorSchema,
  SealedHealthResponseSchema,
  SealedModelsResponseSchema,
} from '../schemas';

// ── Sealed lane constants ────────────────────────────────────────────

/**
 * Tinfoil's Attestation Transparency Cache. Serves the signed attestation
 * bundle (SEV-SNP report + Sigstore bundle + VCEK + enclave cert) that the
 * client verifies before encrypting anything.
 *
 * GET returns the current router enclave. POST {"enclaveUrl": "..."} returns a
 * specific enclave's bundle — the SDK re-verifies with POST after an HPKE key
 * rotation, so BOTH verbs must be relayed.
 */
const TINFOIL_ATC_ATTESTATION = 'https://atc.tinfoil.sh/attestation';

/** EHBP request header carrying the HPKE encapsulated key (hex X25519). */
const EHBP_ENCAPSULATED_KEY = 'Ehbp-Encapsulated-Key';

/** EHBP response header carrying the 32-byte response nonce (hex). */
const EHBP_RESPONSE_NONCE = 'Ehbp-Response-Nonce';

/** Client-supplied header naming the attested enclave to route to. Untrusted. */
const ENCLAVE_URL_HEADER = 'X-Tinfoil-Enclave-Url';

/** Opt in to header/trailer usage accounting so we can meter without decrypting. */
const REQUEST_USAGE_METRICS = 'X-Tinfoil-Request-Usage-Metrics';

/** Upstream usage report: `prompt=<n>,completion=<n>,total=<n>`. */
const USAGE_METRICS = 'X-Tinfoil-Usage-Metrics';

/** Both EHBP headers are lowercase hex of a fixed length. */
const HEX_64 = /^[0-9a-f]{64}$/;

/** Credential prefixes that must never arrive from a client on this route. */
const PROVIDER_CREDENTIAL_PREFIXES = ['tk_', 'admin_'];

/**
 * Never follow a redirect on this lane. A 3xx could walk a credential-bearing
 * request off the allowlisted enclave origin.
 *
 * The Workers runtime does NOT implement `redirect: 'error'` ("won't be
 * implemented since it does not make sense at the edge"), which is the obvious
 * way to express this and is what Tinfoil's Go reference proxy relies on. So
 * the invariant must be enforced in two parts: ask for `manual`, which returns
 * the 3xx as an ordinary response instead of following it, and then explicitly
 * treat any 3xx as a failure. Dropping either half silently re-opens the hole.
 */
const NO_REDIRECT: RequestInit = { redirect: 'manual' };

/** True iff the response is a redirect we must refuse to follow. */
function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** True iff the Sealed kill-switch is exactly the string "true". Fails closed. */
export function isSealedEnabled(env: Bindings): boolean {
  return env.SEALED_ENABLED === 'true';
}

/** Fetch Tinfoil's model catalog without minting a per-user credential. */
export async function fetchSealedModels(env: Bindings): Promise<Array<Record<string, unknown>> | null> {
  const serverKey = env.TINFOIL_API_KEY;
  if (!serverKey) return null;

  try {
    const res = await fetch('https://inference.tinfoil.sh/v1/models', {
      headers: { Authorization: `Bearer ${serverKey}` },
      ...NO_REDIRECT,
    });
    if (!res.ok || isRedirect(res)) return null;
    const body = await res.json() as { data?: Array<Record<string, unknown>> };
    return body.data ?? [];
  } catch {
    return null;
  }
}

/**
 * Validate a client-supplied enclave URL against the allowlist.
 * Returns the normalized origin, or null if unacceptable.
 *
 * Treat this as untrusted input: without the allowlist, a client could use
 * BayLeaf's credential-substituting relay as an open proxy to any host.
 */
function allowedEnclaveOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'tinfoil.sh' && !host.endsWith('.tinfoil.sh')) return null;
  // Origin only. Any client-supplied path, query, or fragment is discarded so
  // the request path comes from our own routing, not from the header.
  return url.origin;
}

/** JSON error that never echoes request content back to the caller. */
function sealedError(message: string, status: 400 | 401 | 403 | 405 | 429 | 502 | 503) {
  return Response.json(
    { error: { message, code: status, lane: 'sealed' } },
    { status },
  );
}

// ── Route app ────────────────────────────────────────────────────────

export const sealedRoutes = new OpenAPIHono<AppEnv>();

// Register documentation separately from runtime handlers. In particular,
// never convert the ciphertext relay to `.openapi()`: request validation would
// parse or buffer the body, violating the route's central security invariant.
sealedRoutes.openAPIRegistry.registerPath({
  method: 'get',
  path: '/health',
  operationId: 'sealedHealth',
  tags: ['Sealed'],
  summary: 'Check Sealed lane health',
  description:
    'Reports whether the EHBP confidential-inference lane is enabled, configured, and able to reach the Tinfoil attestation service. Carries no user content.',
  security: [],
  responses: {
    200: {
      description: 'Sealed lane status',
      content: { 'application/json': { schema: SealedHealthResponseSchema } },
    },
    503: {
      description: 'Sealed is disabled on this deployment',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
  },
});

sealedRoutes.openAPIRegistry.registerPath({
  method: 'get',
  path: '/attestation',
  operationId: 'getSealedAttestation',
  tags: ['Sealed'],
  summary: 'Get the current signed attestation bundle',
  description:
    'Relays Tinfoil\'s signed enclave attestation bundle. The client must verify the bundle before encrypting any request; serving it through BayLeaf does not make BayLeaf a trusted attestation authority.',
  security: [],
  responses: {
    200: {
      description: 'Signed attestation bundle for the current inference router',
      content: { 'application/json': { schema: SealedAttestationResponseSchema } },
    },
    502: {
      description: 'Attestation service failure or refused redirect',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
    503: {
      description: 'Sealed is disabled on this deployment',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
  },
});

sealedRoutes.openAPIRegistry.registerPath({
  method: 'post',
  path: '/attestation',
  operationId: 'postSealedAttestation',
  tags: ['Sealed'],
  summary: 'Get a signed attestation bundle after enclave key rotation',
  description:
    'Relays the Tinfoil SDK\'s attestation lookup for a specific enclave. Both GET and POST are required because the SDK re-verifies after an HPKE key rotation. The routing body contains no prompt or completion content.',
  security: [],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: SealedAttestationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Signed attestation bundle for the requested enclave',
      content: { 'application/json': { schema: SealedAttestationResponseSchema } },
    },
    502: {
      description: 'Attestation service failure or refused redirect',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
    503: {
      description: 'Sealed is disabled on this deployment',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
  },
});

sealedRoutes.openAPIRegistry.registerPath({
  method: 'get',
  path: '/models',
  operationId: 'listSealedModels',
  tags: ['Sealed'],
  summary: 'List Sealed models',
  description:
    'Returns Tinfoil\'s complete live catalog with the bare model IDs clients must place inside encrypted requests. This plaintext catalog call contains no user content and does not mint a per-user provider key.',
  security: [],
  responses: {
    200: {
      description: 'Complete live Sealed model catalog',
      content: { 'application/json': { schema: SealedModelsResponseSchema } },
    },
    502: {
      description: 'Tinfoil catalog unavailable',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
    503: {
      description: 'Sealed is disabled or misconfigured',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
  },
});

sealedRoutes.openAPIRegistry.registerPath({
  method: 'post',
  path: '/v1/{path}',
  operationId: 'sealedInference',
  tags: ['Sealed'],
  summary: 'Relay an EHBP-encrypted inference request',
  description:
    'POST-only ciphertext relay for Tinfoil SDK requests. Use an EHBP-capable Tinfoil SDK rather than constructing this request manually. The SDK verifies hardware attestation, encrypts the complete OpenAI-compatible JSON body to the enclave, and decrypts the response. BayLeaf authenticates and rate-limits the caller, substitutes a server-held Tinfoil credential, and streams the bytes unchanged. BayLeaf never parses, buffers, clones, logs, or schema-validates the body. There is no plaintext fallback. The path may contain multiple segments, for example `chat/completions` or `responses`.',
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      path: z.string().openapi({
        description: 'Tinfoil v1 operation path; may contain multiple slash-separated segments.',
        example: 'chat/completions',
      }),
    }),
    headers: z.object({
      'Ehbp-Encapsulated-Key': z.string().regex(/^[0-9a-f]{64}$/).openapi({
        description: 'Lowercase hex X25519 HPKE encapsulated key generated by the verified client.',
      }),
      'X-Tinfoil-Enclave-Url': z.string().url().openapi({
        description: 'Attested HTTPS enclave origin under tinfoil.sh, selected by the verified client.',
        example: 'https://inference.tinfoil.sh',
      }),
    }),
    body: {
      required: true,
      description: 'Opaque EHBP ciphertext. This is not plaintext JSON, even if the SDK retains `Content-Type: application/json`.',
      content: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Opaque EHBP-encrypted response. Decrypt with the same verified client transport.',
      headers: {
        'Ehbp-Response-Nonce': {
          description: 'Required lowercase hex response nonce proving the successful response is encrypted.',
          schema: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
        'X-Tinfoil-Usage-Metrics': {
          description: 'Non-streaming token usage metadata when available. Streaming usage arrives in an upstream trailer that Cloudflare Workers cannot expose.',
          schema: { type: 'string' },
        },
        'X-Bayleaf-Sealed-Relay': {
          description: 'Always `ciphertext` on relayed responses.',
          schema: { type: 'string', enum: ['ciphertext'] },
        },
      },
      content: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    },
    400: {
      description: 'Missing encryption headers, unapproved enclave, or malformed encrypted request',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
    401: {
      description: 'Missing, invalid, or revoked BayLeaf API key',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
    403: {
      description: 'Client supplied a provider credential instead of a BayLeaf credential',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
    429: {
      description: 'Daily Sealed request limit reached',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
    502: {
      description: 'Enclave unreachable, refused redirect, or successful upstream response was not encrypted',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
    503: {
      description: 'Sealed disabled, misconfigured, or provider credential replaced',
      content: { 'application/json': { schema: SealedErrorSchema } },
    },
  },
});

/**
 * Kill-switch guard for the whole lane. Runs before every handler so a
 * disabled lane cannot leak reachability or upstream state.
 */
sealedRoutes.use('*', async (c, next) => {
  if (!isSealedEnabled(c.env)) {
    return sealedError(
      'The BayLeaf Sealed lane is not enabled on this deployment.',
      503,
    );
  }
  await next();
});

/**
 * GET /sealed/health — kill-switch state and upstream reachability.
 * Unauthenticated. Carries no user content.
 */
sealedRoutes.get('/health', async (c) => {
  let attestationReachable = false;
  try {
    const res = await fetch(TINFOIL_ATC_ATTESTATION, { method: 'GET', ...NO_REDIRECT });
    attestationReachable = res.ok && !isRedirect(res);
  } catch {
    attestationReachable = false;
  }
  return c.json({
    lane: 'sealed',
    enabled: true,
    transport: 'ehbp',
    provider: 'tinfoil',
    server_credential_configured: Boolean(c.env.TINFOIL_API_KEY),
    attestation_reachable: attestationReachable,
  });
});

/**
 * GET|POST /sealed/attestation — relay the signed attestation bundle.
 *
 * This is NOT a place BayLeaf gets to be trusted. The SDK verifies the bundle's
 * Sigstore signature and SEV-SNP report client-side regardless of who served
 * it, and cross-checks the HPKE public key against the enclave certificate's
 * SANs. Tampering here produces a client-side verification failure, not a
 * silent downgrade. We relay it only so a client needs exactly one network
 * dependency: BayLeaf.
 *
 * The SDK requires this URL be https, which constrains local dev (see
 * TESTING.md).
 */
sealedRoutes.on(['GET', 'POST'], '/attestation', async (c) => {
  const method = c.req.method;
  const upstream = await fetch(TINFOIL_ATC_ATTESTATION, {
    method,
    ...NO_REDIRECT,
    headers: { 'Content-Type': c.req.header('Content-Type') ?? 'application/json' },
    // The attestation request body carries routing metadata (enclaveUrl, repo),
    // never user content. Relayed opaquely.
    body: method === 'POST' ? c.req.raw.body : undefined,
  });
  if (isRedirect(upstream)) {
    return sealedError('Attestation source attempted a redirect; refusing.', 502);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
});

/**
 * POST /sealed/v1/* — the ciphertext relay. The only inference path in this
 * Worker that never sees plaintext.
 *
 * Deliberately NOT mounted for GET: a bodyless request cannot carry an
 * encrypted body, and EHBP cannot encrypt a response to one (the encrypted
 * request body is what implicitly authenticates the encapsulated key; without
 * it a MITM could substitute their own). Catalog lookups belong on
 * `/sealed/models`, not here.
 */
sealedRoutes.post('/v1/*', async (c) => {
  // ── 1. Reject client-supplied provider credentials before anything else.
  // A `tk_` here would mean the caller is trying to use their own Tinfoil key
  // through our relay, which would put us in the position of laundering an
  // unmetered credential.
  const rawAuth = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  if (PROVIDER_CREDENTIAL_PREFIXES.some((p) => rawAuth.startsWith(p))) {
    return sealedError(
      'Do not send a Tinfoil credential to BayLeaf. Authenticate with a BayLeaf key (sk-bayleaf-...) or Campus Pass; BayLeaf supplies the provider credential.',
      403,
    );
  }

  // ── 2. Authenticate the caller with the existing BayLeaf auth resolver.
  // We use it purely as an identity/authorization gate. Its `.authorization`
  // field is an OpenRouter key and is intentionally discarded here — the
  // upstream for this lane is Tinfoil, not OpenRouter.
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth;

  // ── 3. Require the EHBP encapsulated key with strict syntax.
  // Its absence is the signal that a body is NOT encrypted. Failing closed
  // here is the single most important check in this file: it is what makes
  // "plaintext is rejected rather than downgraded" true.
  const encapsulatedKey = c.req.header(EHBP_ENCAPSULATED_KEY)?.trim().toLowerCase();
  if (!encapsulatedKey || !HEX_64.test(encapsulatedKey)) {
    return sealedError(
      `The Sealed lane requires an end-to-end encrypted body. Missing or malformed ${EHBP_ENCAPSULATED_KEY}. Use a Tinfoil SDK with this endpoint as its base URL; there is no plaintext fallback.`,
      400,
    );
  }

  // ── 4. Resolve and allowlist the enclave destination.
  const enclaveOrigin = allowedEnclaveOrigin(c.req.header(ENCLAVE_URL_HEADER));
  if (!enclaveOrigin) {
    return sealedError(
      `Missing or unapproved ${ENCLAVE_URL_HEADER}. It must be an https origin under tinfoil.sh.`,
      400,
    );
  }

  // ── 5. Enforce BayLeaf's daily request limit before acquiring or using an
  // upstream credential. Campus Pass shares the provider-agnostic per-IP
  // counter with standard inference. Keyed users have an atomic D1 counter
  // dedicated to Sealed, since its spend does not pass through OpenRouter.
  if (auth.isCampusMode && auth.clientIp) {
    const limit = parseLimit(c.env.CAMPUS_RPD_LIMIT);
    const status = await checkAndIncrement(c.env.CAMPUS_RPD, auth.clientIp, limit);
    if (status) {
      return sealedError(
        `Campus Pass daily request limit reached (${status.limit} requests). Resets at ${status.resetsAt}.`,
        429,
      );
    }
  } else if (auth.userKeyRow) {
    const limit = parseLimit(c.env.SEALED_RPD_LIMIT);
    const today = new Date().toISOString().split('T')[0];
    const result = await c.env.DB.prepare(
      `UPDATE user_keys
          SET sealed_rpd_count = CASE
                WHEN sealed_rpd_date = ? THEN sealed_rpd_count + 1
                ELSE 1
              END,
              sealed_rpd_date = ?
        WHERE bayleaf_token = ? AND revoked = 0
          AND (sealed_rpd_date != ? OR sealed_rpd_count < ?)`,
    ).bind(today, today, auth.userKeyRow.bayleaf_token, today, limit).run();
    if (result.meta.changes === 0) {
      return sealedError(
        `Sealed daily request limit reached (${limit} requests). Resets at midnight UTC.`,
        429,
      );
    }
  }

  // ── 6. Resolve the caller's own upstream credential, minting one on first
  // use of this lane (migration 0005). Keyed users get a per-user Tinfoil key
  // so that Sealed spend is attributable per user; Campus Pass has
  // no email and therefore no row, so it shares a pool key.
  //
  // Per-user keys are what make the out-of-band billing report useful: it
  // indexes spend by key *name*, and the name carries the user's email, so a
  // single admin call yields a per-user dollar table with no local join.
  //
  // We fail closed rather than falling back to the org-wide key. A fallback
  // would keep the request working while silently destroying the per-user
  // attribution that spend enforcement on this lane depends on.
  const cred = await resolveBackendCredential(auth, 'tinfoil', c.env);
  if (!cred) {
    return sealedError(
      'Could not obtain an upstream credential for your account. This is a BayLeaf-side problem, not a problem with your key; please retry shortly.',
      503,
    );
  }
  const serverKey = cred.secret;

  // ── 7. Build the upstream URL from OUR path, not from client input.
  // `/sealed/v1/chat/completions` → `<enclave>/v1/chat/completions`.
  const path = new URL(c.req.url).pathname.replace(/^\/sealed/, '');
  const upstreamUrl = `${enclaveOrigin}${path}`;

  // ── 8. Construct a fresh header set. Allowlist, never copy-and-delete:
  // an inherited header is a leak waiting for someone to forget to strip it.
  // Note what is absent: the caller's BayLeaf credential, their IP, their
  // email, and every `x-stainless-*` client telemetry header.
  const upstreamHeaders = new Headers({
    Authorization: `Bearer ${serverKey}`,
    'Content-Type': c.req.header('Content-Type') ?? 'application/octet-stream',
    [EHBP_ENCAPSULATED_KEY]: encapsulatedKey,
    // Ask for usage accounting in headers, since we cannot read it from the
    // encrypted JSON.
    [REQUEST_USAGE_METRICS]: 'true',
  });
  const accept = c.req.header('Accept');
  if (accept) upstreamHeaders.set('Accept', accept);

  // ── 9. Forward the body as an opaque stream.
  // This is the load-bearing line of the whole lane. We do not call
  // `c.req.json()`, `.text()`, `.arrayBuffer()`, or `.clone()`. The bytes are
  // never materialized in Worker memory as a value we could log.
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: c.req.raw.body,
      ...NO_REDIRECT,
    });
  } catch {
    return sealedError('Sealed upstream unreachable.', 502);
  }
  if (isRedirect(upstream)) {
    return sealedError(
      'Sealed upstream attempted a redirect. Refusing to carry a credential-bearing request off the attested origin.',
      502,
    );
  }

  // ── 9b. A rejected credential is healed but NOT retried.
  //
  // Every other lane retries inline via `sendWithHeal`, which requires the call
  // to be replayable. This one is not: we streamed the client's ciphertext body
  // straight through, so it is already consumed, and buffering it to enable a
  // retry would defeat the entire point of the lane.
  //
  // Healing anyway matters here more than on the plaintext catch-all, because
  // Sealed is the *only* route that uses a Tinfoil credential. With no heal at
  // all, a user whose key was deleted or exhausted upstream would receive 401s
  // forever with nothing able to repair the row. So we re-mint now and ask the
  // client to retry, which converts a permanent failure into a single retryable
  // one.
  //
  // A 401/403 here is unambiguous: the caller's own BayLeaf credential was
  // already validated in step 2 and stripped in step 7, so the only credential
  // in the upstream request is the one we just supplied.
  if ((upstream.status === 401 || upstream.status === 403) && cred.row) {
    await healBackendKey(cred.row, 'tinfoil', cred.secret, c.env);
    return sealedError(
      'Your Sealed credential was rejected upstream and has been replaced. Retry the request.',
      503,
    );
  }

  // ── 10. A successful response MUST be encrypted. The response nonce is the
  // proof; without it the enclave would be handing back readable bytes, which
  // on this lane is a protocol violation rather than a convenience.
  const responseNonce = upstream.headers.get(EHBP_RESPONSE_NONCE)?.trim().toLowerCase();
  if (upstream.ok && (!responseNonce || !HEX_64.test(responseNonce))) {
    return sealedError(
      `Sealed upstream returned a success without a valid ${EHBP_RESPONSE_NONCE}. Refusing to relay a possibly unencrypted response.`,
      502,
    );
  }

  // ── 11. Meter from the usage header only. This is the entire cost-control
  // surface available to us: we cannot read token counts out of an encrypted
  // body. Non-streaming responses report here; streaming reports in an HTTP
  // trailer, which the Workers runtime does not expose (see TESTING.md).
  const usage = upstream.headers.get(USAGE_METRICS);

  // ── 11. Relay the response bytes unchanged.
  //
  // `Content-Encoding: identity` is load-bearing, not decorative. The Workers
  // runtime (and the Cloudflare edge) will transparently gzip a response whose
  // Content-Type looks compressible, such as application/json, whenever the
  // client sent a permissive Accept-Encoding. That silently breaks EHBP.
  //
  // The reason is a layering mismatch on the client: an EHBP transport parses
  // length-prefixed AES-GCM frames directly off the raw response stream, which
  // sits BELOW the HTTP library's content-decoding layer. So the client's
  // decryptor is handed gzip bytes and fails with a framing error, even though
  // an ordinary buffered HTTP client would have decompressed transparently and
  // seen nothing wrong. Declaring an explicit encoding suppresses the automatic
  // compression and keeps the ciphertext byte-exact.
  //
  // Compressing ciphertext is pointless anyway: it is incompressible by
  // construction. The only effect is corruption.
  const responseHeaders = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
    'Content-Encoding': 'identity',
    'Cache-Control': 'no-store',
  });
  if (responseNonce) responseHeaders.set(EHBP_RESPONSE_NONCE, responseNonce);
  if (usage) responseHeaders.set(USAGE_METRICS, usage);
  // Relay observability: surface what the relay could actually see, so the
  // "BayLeaf is blind to content but not to metadata" claim is demonstrable
  // rather than asserted. Not a retention mechanism — nothing is stored.
  responseHeaders.set('X-Bayleaf-Sealed-Relay', 'ciphertext');
  responseHeaders.set('X-Bayleaf-Sealed-Usage-Visible', usage ? 'header' : 'none');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

/**
 * Explicit 405 for non-POST on the ciphertext route, so a misconfigured client
 * gets a clear protocol error instead of falling through to the 404 page.
 */
sealedRoutes.all('/v1/*', (c) =>
  sealedError(
    'The Sealed ciphertext relay accepts POST only. Bodyless requests cannot carry an encrypted body; use GET /sealed/models for the catalog.',
    405,
  ),
);

/**
 * GET /sealed/models — Tinfoil's catalog with bare upstream model IDs.
 *
 * The dedicated `/sealed` route establishes provider provenance. Unlike the
 * plaintext proxy, this relay cannot strip a model prefix because the model
 * field is inside the EHBP-encrypted body. The catalog therefore advertises
 * the exact bare IDs clients must encrypt and send (for example `glm-5-2`).
 *
 * This is a plaintext catalog request carrying no user content, which is why it
 * is a separate endpoint from the ciphertext relay rather than a GET on it.
 */
sealedRoutes.get('/models', async (c) => {
  // Deliberately the ORG key, not the caller's per-user key. Listing models is
  // a plaintext, user-content-free request, and pinning it to a per-user
  // credential would make catalog availability depend on a user's inference
  // credential state. It also avoids minting a per-user key as a side effect of mere
  // catalog browsing, which would defeat the on-demand minting in the relay.
  const serverKey = c.env.TINFOIL_API_KEY;
  if (!serverKey) return sealedError('Sealed lane is misconfigured.', 503);

  const data = await fetchSealedModels(c.env);
  if (!data) return sealedError('Sealed catalog unavailable upstream.', 502);
  return c.json({ object: 'list', data });
});
