/**
 * OpenCode well-known endpoints.
 *
 * Implements OpenCode's `.well-known/opencode` provider-onboarding contract,
 * letting a user run one of two commands:
 *
 *   opencode auth login https://api.bayleaf.dev
 *   opencode auth login https://api.bayleaf.dev/sealed
 *
 * to register BayLeaf as a fully-configured provider, with no manual edits to
 * `opencode.json` and no key pasted into a config file. Verified against
 * anomalyco/opencode at commit dev (Mar 2026): the CLI fetches
 * `/.well-known/opencode`, runs `auth.command` locally, captures the stdout
 * as the credential, and stores it as a `wellknown`-typed entry keyed by URL
 * in `~/.local/share/opencode/auth.json`. On every subsequent OpenCode
 * startup, the stored token is bound to `auth.env` inside OpenCode's
 * substitution map, the `.well-known/opencode` doc is re-fetched, and any
 * `remote_config.url` is fetched (with templated headers like
 * `Authorization: Bearer {env:BAYLEAF_API_KEY}`) and merged into the user's
 * effective config. We use that round trip to inject either the standard
 * BayLeaf provider or the opt-in BayLeaf Sealed provider.
 *
 * This file exposes:
 *   GET /.well-known/opencode                 Standard discovery
 *   GET /.well-known/opencode/config          Standard remote config
 *   GET /sealed/.well-known/opencode          Sealed discovery
 *   GET /sealed/.well-known/opencode/config   Sealed remote config
 *
 * Reference (read at design time, not pinned in code):
 *   - packages/opencode/src/cli/cmd/providers.ts (login command)
 *   - packages/opencode/src/auth/index.ts        (WellKnown schema)
 *   - packages/opencode/src/config/config.ts     (wellknown -> authEnv -> remote_config merge)
 *   - packages/opencode/src/config/variable.ts   (substitute() reads input.env then process.env)
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { resolveAuth } from '../utils/auth';
import { getModelInfo } from '../openrouter';
import type { ModelCost } from '../openrouter';
import { altBackendForModel, isBackendEnabled, parseModelList } from '../constants';
import { fetchSealedModels, isSealedEnabled } from './sealed';

export const wellKnownRoutes = new Hono<AppEnv>();
export const sealedWellKnownRoutes = new Hono<AppEnv>();

// ── Configuration ────────────────────────────────────────────────

/**
 * OpenCode provider id under which BayLeaf appears in the merged config.
 *
 * We deliberately use `bayleaf-remote` rather than `bayleaf` so that users
 * who want full control over their provider definition (custom model list,
 * custom defaults, different baseURL for testing, etc.) can author a
 * `bayleaf` provider in their own opencode.json without it being shadowed
 * or merged with our remote-injected config. The /llms.txt section
 * "Roll your own bayleaf provider" documents that path.
 */
const PROVIDER_ID = 'bayleaf-remote';

/** Provider id supplied remotely and upgraded by the fail-closed Tinfoil transport plugin. */
const SEALED_PROVIDER_ID = 'bayleaf-sealed-remote';

/**
 * Exact pin: verifier and encrypted-transport changes require deliberate review.
 * If models appear but requests lack Ehbp-Encapsulated-Key, check for an interrupted
 * `~/.cache/opencode/packages/${SEALED_PLUGIN}` install. Rename it, retry once, and
 * restart OpenCode: failed plugin imports are cached for the process lifetime.
 */
const SEALED_PLUGIN = 'opencode-tinfoil@0.2.0';

/** Name of the env var the wellknown token is bound to inside OpenCode. */
const TOKEN_ENV_NAME = 'BAYLEAF_API_KEY';

type OpenCodeMode = 'standard' | 'sealed';

// ── GET /.well-known/opencode ────────────────────────────────────

/**
 * Discovery document. Public (no auth) so that `opencode auth login URL`
 * can fetch it before any credential exists.
 *
 * Only returns the `auth` block (how to obtain a credential) and a pointer
 * to the authenticated `remote_config` URL. The provider config itself is
 * NOT inlined here, because (a) it depends on per-user model entitlement and
 * (b) OpenCode's templated-header mechanism only works on `remote_config.url`.
 *
 * `auth.command` is a shell-free curl device flow (see routes/claim.tsx).
 * curl imports Windows' standard OS environment variable, defaulting to Unix,
 * so BayLeaf can send instructions to CON or /dev/stderr while reserving stdout
 * exclusively for the approved key that OpenCode captures.
 */
function discoveryDocument(requestUrl: string, mode: OpenCodeMode) {
  const apiBase = absoluteBaseUrl(requestUrl);
  const loginUrl = mode === 'sealed' ? `${apiBase}/sealed` : apiBase;

  return {
    auth: {
      command: buildCurlAuthCommand(apiBase, mode),
      env: TOKEN_ENV_NAME,
    },
    remote_config: {
      url: `${loginUrl}/.well-known/opencode/config`,
      headers: {
        Authorization: `Bearer {env:${TOKEN_ENV_NAME}}`,
      },
    },
  };
}

wellKnownRoutes.get('/opencode', (c) => {
  return c.json(discoveryDocument(c.req.url, 'standard'));
});

sealedWellKnownRoutes.get('/opencode', (c) => {
  if (!isSealedEnabled(c.env)) {
    return c.json({ error: 'BayLeaf Sealed is currently unavailable.' }, 503);
  }
  return c.json(discoveryDocument(c.req.url, 'sealed'));
});

function buildCurlAuthCommand(apiBase: string, mode: OpenCodeMode): string[] {
  // File-form -b preserves response cookies across --next. This source is the
  // Windows NUL device and a protected, nonexistent absolute path on Unix, so
  // neither platform reads a working-directory-controlled cookie file.
  const cookieEngine = '/dev/NUL';
  return [
    'curl',
    // Must be curl's first argument: ignore .curlrc so tracing/output settings
    // cannot persist the key or add bytes to the stdout OpenCode captures.
    '-q',
    '-s',
    '-b',
    cookieEngine,
    '--variable',
    '%OS=unix',
    '--expand-url',
    `${apiBase}/auth/claim/curl/start/${mode}/{{OS:url}}`,
    '--next',
    '-sf',
    '-b',
    cookieEngine,
    '-o',
    '/dev/stderr',
    `${apiBase}/auth/claim/curl/instructions/unix`,
    '--next',
    '-sf',
    '-b',
    cookieEngine,
    '-o',
    '\\\\.\\CON',
    `${apiBase}/auth/claim/curl/instructions/windows`,
    '--next',
    // macOS curl 8.7.1 misclassifies an empty HTTP/2 429 as transport error 56,
    // bypassing --retry. HTTP/1.1 returns the intended retryable error 22.
    '--http1.1',
    '-fs',
    '--retry',
    String(10 * 60 / 1),
    '--retry-delay',
    '1',
    '--retry-max-time',
    String(10 * 60),
    '-b',
    cookieEngine,
    `${apiBase}/auth/claim/curl/poll`,
  ];
}

// ── GET /.well-known/opencode/config ─────────────────────────────

/**
 * Authenticated remote config. OpenCode fetches this on every startup,
 * passing the wellknown-substituted Bearer token. We use the same auth path
 * as `/v1/*` (Campus Pass or `sk-bayleaf-` token), which means a Campus Pass
 * user gets a working OpenCode session without ever pasting a key:
 * `opencode auth login https://api.bayleaf.dev` would have stored an empty
 * string as the token in that case (the user just hits Enter at the prompt),
 * and Campus Pass IP eligibility carries the rest.
 *
 * The returned shape is `{ "config": { ... opencode config ... } }`. The two
 * login URLs return separate provider definitions; only the Sealed URL adds
 * the exact-pinned `opencode-tinfoil` transport plugin. Both set top-level
 * fields that mirror the recommended power-user setup (see /llms.txt):
 *
 *   - `model`: the selected lane's recommended model, an agent-independent
 *     default so OpenCode lands on BayLeaf without a /models trip. Overridden
 *     by any `model` in the user's own opencode.json.
 *   - `disabled_providers: ["opencode"]` — disables OpenCode Zen (the built-in
 *     `opencode` provider), whose free models persist every prompt and completion
 *     server-side to train or improve those models, with no opt-out. This aligns
 *     the OpenCode experience with the ZDR posture BayLeaf claims everywhere
 *     else. A user who wants Zen back can set their own `disabled_providers`
 *     in full (mergeDeep replaces arrays), or omit it and set `model` to an
 *     `opencode/...` slug. OpenCode Go (separate `opencode-go` provider id,
 *     paid, itself ZDR) is unaffected.
 *
 * Merge order in OpenCode (config.ts:593→599→608) is remote-first, then the
 * user's global opencode.json, then project-local. mergeDeep replaces scalars
 * and arrays (only `instructions` is concatenated), so every field below is a
 * default the user can override in full. The user's own opencode.json, agent
 * definitions, and other settings are preserved by the merge.
 */
async function authenticateRemoteConfig(c: Context<AppEnv>) {
  // Auth: Campus Pass or sk-bayleaf-. Same path as /v1/*.
  const authResult = await resolveAuth(c);
  if (authResult instanceof Response) return authResult;

  return null;
}

wellKnownRoutes.get('/opencode/config', async (c) => {
  const authError = await authenticateRemoteConfig(c);
  if (authError) return authError;

  const baseUrl = absoluteBaseUrl(c.req.url);

  // Build the model list: recommended first, then the curated set without
  // duplicates. We tolerate getModelInfo failures (e.g. transient OR /models
  // 5xx) by skipping the affected entry rather than failing the whole config
  // fetch — OpenCode startup must not be blocked by a flaky upstream.
  const recommended = c.env.RECOMMENDED_MODEL;
  const curated = parseModelList(c.env.OPENCODE_CURATED_MODELS);
  // Drop any slug routed to an alternate backend that is currently disabled, so
  // OpenCode never lists a model whose /v1/chat/completions call would 503.
  // OpenRouter slugs have no alternate backend and always pass.
  const isSlugLive = (slug: string): boolean => {
    const backend = altBackendForModel(slug);
    return backend === null || isBackendEnabled(c.env, backend.key);
  };
  const slugOrder = [recommended, ...curated.filter((s) => s !== recommended)]
    .filter(isSlugLive);

  const models: Record<string, OpenCodeModelEntry> = {};
  for (const slug of slugOrder) {
    const entry = await buildModelEntry(slug);
    if (entry) models[slug] = entry;
  }

  // Provider entry. `apiKey` substitution resolves to the wellknown token
  // OpenCode stored at `opencode auth login` time (see config.ts:555 in
  // opencode dev). For Campus Pass users the token is the empty string, but
  // BayLeaf's auth path treats empty Bearer values as Campus Pass anyway, so
  // requests still work.
  const providerEntry = {
    npm: '@ai-sdk/openai-compatible',
    name: 'BayLeaf',
    options: {
      baseURL: `${baseUrl}/v1`,
      apiKey: `{env:${TOKEN_ENV_NAME}}`,
    },
    models,
  };

  // Top-level `model` and `disabled_providers` (documented above). We only
  // set `model` when the recommended slug actually survived the live-filter
  // and produced a model entry, so we never point OpenCode at a model that
  // isn't in the provider's own `models` map.
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    disabled_providers: ['opencode'],
    provider: {
      [PROVIDER_ID]: providerEntry,
    },
  };
  if (recommended && models[recommended]) {
    config.model = `${PROVIDER_ID}/${recommended}`;
  }
  return c.json({ config });
});

sealedWellKnownRoutes.get('/opencode/config', async (c) => {
  if (!isSealedEnabled(c.env)) {
    return c.json({ error: 'BayLeaf Sealed is currently unavailable.' }, 503);
  }

  const authError = await authenticateRemoteConfig(c);
  if (authError) return authError;

  const baseUrl = absoluteBaseUrl(c.req.url);
  // Bare IDs are required because the model field is encrypted before BayLeaf
  // sees it. A catalog failure omits the provider rather than blocking startup.
  const sealedModels = await buildSealedModelEntries(
    c.env,
    c.env.SEALED_RECOMMENDED_MODEL,
    c.env.SEALED_CURATED_MODELS,
  );
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    disabled_providers: ['opencode'],
    provider: {},
  };

  if (Object.keys(sealedModels).length > 0) {
    config.plugin = [[SEALED_PLUGIN, { defaultProvider: false }]];
    (config.provider as Record<string, unknown>)[SEALED_PROVIDER_ID] = {
      npm: '@ai-sdk/openai-compatible',
      name: 'BayLeaf Sealed',
      options: {
        baseURL: `${baseUrl}/sealed/v1/`,
        apiKey: `{env:${TOKEN_ENV_NAME}}`,
        tinfoil: {
          attestationBundleURL: `${baseUrl}/sealed`,
          transport: 'ehbp',
        },
      },
      models: sealedModels,
    };
    const recommended = c.env.SEALED_RECOMMENDED_MODEL;
    if (recommended && sealedModels[recommended]) {
      config.model = `${SEALED_PROVIDER_ID}/${recommended}`;
    }
  }

  return c.json({ config });
});

// ── Helpers ───────────────────────────────────────────────────────

interface OpenCodeModelEntry {
  name: string;
  cost?: ModelCost;
}

interface SealedCatalogModel {
  id?: unknown;
  name?: unknown;
}

/** Build the configured Sealed model slice from BayLeaf's live public catalog. */
async function buildSealedModelEntries(
  env: AppEnv['Bindings'],
  recommended: string | undefined,
  curatedRaw: string | undefined,
): Promise<Record<string, OpenCodeModelEntry>> {
  const order = [recommended, ...parseModelList(curatedRaw).filter((id) => id !== recommended)]
    .filter((id): id is string => Boolean(id));
  if (order.length === 0) return {};

  const catalog = await fetchSealedModels(env) as SealedCatalogModel[] | null;
  if (!catalog) return {};
  const names = new Map(
    catalog
      .filter((model): model is { id: string; name?: unknown } => typeof model.id === 'string')
      .map((model) => [model.id, typeof model.name === 'string' ? model.name : model.id]),
  );

  return Object.fromEntries(
    order.filter((id) => names.has(id)).map((id) => [id, { name: names.get(id)! }]),
  );
}

/**
 * Build an OpenCode-shaped model entry for a BayLeaf-namespaced slug.
 * Returns null if the upstream lookup fails so the caller can omit it.
 */
async function buildModelEntry(slug: string): Promise<OpenCodeModelEntry | null> {
  const info = await getModelInfo(slug);
  if (!info) return null;
  const entry: OpenCodeModelEntry = { name: info.name };
  if (info.cost) entry.cost = info.cost;
  return entry;
}

/**
 * Resolve the public origin we should advertise to OpenCode.
 *
 * Cloudflare Workers fronting a custom_domain receive `c.req.url` with the
 * scheme already set to `https` for any externally-routed request, so passing
 * that origin directly is fine in production. We force `https` defensively for
 * any non-localhost origin so we never serve OpenCode an `http://` URL by
 * accident (which it would happily fetch unencrypted).
 */
function absoluteBaseUrl(reqUrl: string): string {
  const u = new URL(reqUrl);
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0';
  return `${isLocal ? u.protocol.replace(':', '') : 'https'}://${u.host}`;
}
