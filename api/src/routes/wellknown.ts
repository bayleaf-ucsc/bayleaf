/**
 * OpenCode well-known endpoints.
 *
 * Implements OpenCode's `.well-known/opencode` provider-onboarding contract,
 * letting a user run a single command:
 *
 *   opencode auth login https://api.bayleaf.dev
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
 * effective config. We use that round trip to inject a `provider.bayleaf`
 * block whose `apiKey` substitutes from the same wellknown token.
 *
 * This file exposes:
 *   GET /.well-known/opencode          (public; static-ish discovery doc)
 *   GET /.well-known/opencode/config   (auth: Campus Pass or sk-bayleaf-...)
 *
 * Reference (read at design time, not pinned in code):
 *   - packages/opencode/src/cli/cmd/providers.ts (login command)
 *   - packages/opencode/src/auth/index.ts        (WellKnown schema)
 *   - packages/opencode/src/config/config.ts     (wellknown -> authEnv -> remote_config merge)
 *   - packages/opencode/src/config/variable.ts   (substitute() reads input.env then process.env)
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { resolveAuth } from '../utils/auth';
import { getModelInfo } from '../openrouter';
import type { ModelCost } from '../openrouter';

export const wellKnownRoutes = new Hono<AppEnv>();

// ── Configuration ────────────────────────────────────────────────

/** OpenCode provider id under which BayLeaf appears in the merged config. */
const PROVIDER_ID = 'bayleaf';

/** Name of the env var the wellknown token is bound to inside OpenCode. */
const TOKEN_ENV_NAME = 'BAYLEAF_API_KEY';

/**
 * Parse the operator-curated companion model list from
 * `c.env.OPENCODE_CURATED_MODELS`. Comma-separated, surrounding whitespace
 * tolerated, empty entries dropped, duplicates removed. The recommended model
 * is added separately by the caller (always first in the resulting picker).
 */
function parseCuratedModels(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const slug = part.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

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
 * `auth.command` is a POSIX `sh -c` invocation that prompts the user for
 * their key on the controlling terminal with echo disabled, then prints it
 * to stdout for OpenCode to capture. Windows users without WSL will see the
 * subprocess fail; /llms.txt documents WSL as the recommended path on Windows.
 */
wellKnownRoutes.get('/opencode', (c) => {
  const baseUrl = absoluteBaseUrl(c.req.url); // e.g. https://api.bayleaf.dev

  // sh -c command. Single-quoted in the source, no shell-interpolation traps.
  // Reads a line from /dev/tty so it works even if stdin/stdout are piped,
  // disables terminal echo so the key never appears on screen, and prints
  // a literal '\n' to stderr after the read so the user's terminal advances
  // a line. The trailing `printf %s "$key"` writes the captured key to stdout
  // without a trailing newline; OpenCode `.trim()`s the result anyway, but we
  // keep the contract crisp.
  const shScript =
    'tty="/dev/tty"; ' +
    '[ -r "$tty" ] || tty=""; ' +
    'if [ -n "$tty" ]; then ' +
    '  stty -echo < "$tty" 2>/dev/null; ' +
    '  printf "Paste your BayLeaf API key (sk-bayleaf-...): " > "$tty"; ' +
    '  IFS= read -r key < "$tty"; ' +
    '  stty echo < "$tty" 2>/dev/null; ' +
    '  printf "\\n" > "$tty"; ' +
    'else ' +
    '  IFS= read -r key; ' +
    'fi; ' +
    'printf "%s" "$key"';

  return c.json({
    auth: {
      command: ['sh', '-c', shScript],
      env: TOKEN_ENV_NAME,
    },
    remote_config: {
      url: `${baseUrl}/.well-known/opencode/config`,
      headers: {
        Authorization: `Bearer {env:${TOKEN_ENV_NAME}}`,
      },
    },
  });
});

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
 * The returned shape is `{ "config": { ... opencode config ... } }`. We
 * include only the `provider.bayleaf` block; the user's own opencode.json,
 * agent definitions, and other settings are preserved by OpenCode's merge.
 */
wellKnownRoutes.get('/opencode/config', async (c) => {
  // Auth: Campus Pass or sk-bayleaf-. Same path as /v1/*.
  const authResult = await resolveAuth(c);
  if (authResult instanceof Response) return authResult;

  const baseUrl = absoluteBaseUrl(c.req.url);

  // Build the model list: recommended first, then the curated set without
  // duplicates. We tolerate getModelInfo failures (e.g. transient OR /models
  // 5xx) by skipping the affected entry rather than failing the whole config
  // fetch — OpenCode startup must not be blocked by a flaky upstream.
  const recommended = c.env.RECOMMENDED_MODEL;
  const curated = parseCuratedModels(c.env.OPENCODE_CURATED_MODELS);
  const slugOrder = [recommended, ...curated.filter((s) => s !== recommended)];

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
    name: 'BayLeaf API',
    options: {
      baseURL: `${baseUrl}/v1`,
      apiKey: `{env:${TOKEN_ENV_NAME}}`,
    },
    models,
  };

  return c.json({
    config: {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [PROVIDER_ID]: providerEntry,
      },
    },
  });
});

// ── Helpers ───────────────────────────────────────────────────────

interface OpenCodeModelEntry {
  name: string;
  cost?: ModelCost;
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
