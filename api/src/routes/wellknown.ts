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
 * `auth.command` runs the BayLeaf claim-code device flow (see
 * routes/claim.tsx). The script:
 *   1. POSTs to /auth/claim/initiate to get a short claim code and URL.
 *   2. Prints those to /dev/tty (or stderr if no tty) so the user can open
 *      the URL in a browser, sign in if needed, and approve the request.
 *   3. Polls /auth/claim/poll every 2s for up to 10 min.
 *   4. On approval, the captured `sk-bayleaf-...` key is printed to stdout
 *      (and only stdout) for OpenCode to capture and store.
 *
 * The script depends on `curl` and `python3`. Both are present by default on
 * macOS, modern Linux, and WSL. Systems without `python3` see the script fail
 * fast with a clear message; /llms.txt documents the manual `bayleaf` provider
 * config as the documented escape hatch.
 *
 * Windows: pure POSIX `sh`. Use WSL or set up the manual provider config.
 */
wellKnownRoutes.get('/opencode', (c) => {
  const baseUrl = absoluteBaseUrl(c.req.url); // e.g. https://api.bayleaf.dev

  return c.json({
    auth: {
      command: ['sh', '-c', buildAuthCommand(baseUrl, 'OpenCode')],
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
    name: 'BayLeaf (Remote)',
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

/**
 * Build the POSIX `sh -c` script that drives the claim-code device flow.
 *
 * Contract: the script must print *only* the captured `sk-bayleaf-...` key
 * (no trailing newline) to stdout. Everything else — prompts, the claim URL,
 * progress dots, errors — goes to /dev/tty (with stderr fallback). The
 * encompassing `agent` (OpenCode here) reads stdout and stores the result;
 * any stray bytes on stdout would corrupt the stored credential.
 *
 * Dependencies: `curl` and `python3`. Failures during the curl/python pipeline
 * are caught and reported to the user via the tty, exit code 1.
 */
function buildAuthCommand(apiBase: string, clientName: string): string {
  // Inline the api base + client name. The client name is hard-coded by us
  // (not user input) so we can JSON-stringify it without escape hazards.
  // Both are embedded as literal sh strings; we double-quote them in shell
  // so spaces/special chars in clientName won't matter.
  const apiBaseSh = JSON.stringify(apiBase);            // "https://api.bayleaf.dev"
  const clientNameSh = JSON.stringify(clientName);      // "OpenCode"
  const initiateBodySh = JSON.stringify(JSON.stringify({ client: clientName }));

  // Heredoc-style multi-line POSIX script. Newlines inside `sh -c <arg>` are
  // fine, no need to chain with `;`. Single-quoted python snippets pass
  // through as one shell argument.
  return `set -u
api=${apiBaseSh}
client=${clientNameSh}

# Detect a usable controlling terminal. We can't just test \`[ -r /dev/tty ]\`
# because /dev/tty exists and is "readable" in a definitional sense even when
# the calling process has no controlling tty (e.g. an OpenCode subprocess). The
# only reliable test is to actually try writing to it and check the exit status.
tty="/dev/tty"
if ! ( : > "$tty" ) 2>/dev/null; then tty=""; fi

log() {
  if [ -n "$tty" ]; then printf '%s\\n' "$1" > "$tty"; else printf '%s\\n' "$1" >&2; fi
}
fail() { log "$1"; exit 1; }

command -v curl >/dev/null 2>&1 || fail "BayLeaf claim flow needs 'curl'. Install it or use manual setup: https://api.bayleaf.dev/llms.txt"
command -v python3 >/dev/null 2>&1 || fail "BayLeaf claim flow needs 'python3'. Install it or use manual setup: https://api.bayleaf.dev/llms.txt"

init=$(curl -fsS -X POST -H 'Content-Type: application/json' -d ${initiateBodySh} "$api/auth/claim/initiate") || fail "Could not reach $api to start the claim flow."

# Two codes:
#   user_code   short, screen-safe; shown to the user; appears in the browser URL.
#   device_code 32-char hex; held only by this script; the bearer credential we
#               present at /poll. Never displayed, never logged.
# An attacker who watches a screen share sees only the user_code; without the
# device_code they can't poll for the resulting key.
user_code=$(printf '%s' "$init" | python3 -c 'import sys,json; print(json.load(sys.stdin)["user_code"])' 2>/dev/null) || fail "Claim flow returned an unexpected response."
device_code=$(printf '%s' "$init" | python3 -c 'import sys,json; print(json.load(sys.stdin)["device_code"])' 2>/dev/null) || fail "Claim flow returned an unexpected response."
url=$(printf '%s' "$init" | python3 -c 'import sys,json; print(json.load(sys.stdin)["claim_url"])' 2>/dev/null) || fail "Claim flow returned an unexpected response."

log ""
log "To authorize $client to access BayLeaf, open this URL in your browser:"
log ""
log "  $url"
log ""
log "Code (verify it matches the page): $user_code"
log ""

# Try to open the browser automatically. webbrowser.open() handles platform
# differences (macOS \`open\`, Linux \`xdg-open\`, WSL via Windows host, etc.)
# and silently no-ops if no GUI is available. Run in the background and
# discard output: a failure here is not user-visible because the URL is
# already printed above for them to open by hand. We pass the URL via env
# rather than interpolating it into the python source, to avoid quoting hazards
# even though we control the source of $url.
BAYLEAF_CLAIM_URL="$url" python3 -c 'import os, webbrowser; webbrowser.open(os.environ["BAYLEAF_CLAIM_URL"])' >/dev/null 2>&1 &

log "Waiting for approval (10 min timeout)..."

deadline=$(( $(date +%s) + 600 ))
while :; do
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then fail "Timed out waiting for approval."; fi

  # Note: -sS, not -fsS. We want to *receive* the body even on 4xx (the server
  # returns 410 for denied and 404 for expired with a JSON body whose .status
  # field is the source of truth). -f would suppress the body and dump us into
  # the retry-after-sleep branch, hanging forever after a deny.
  body=$(curl -sS "$api/auth/claim/poll?d=$device_code" 2>/dev/null) || { sleep 1; continue; }
  status=$(printf '%s' "$body" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["status"])
except Exception: print("error")
' 2>/dev/null)

  case "$status" in
    pending) sleep 1 ;;
    approved)
      key=$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("key",""))' 2>/dev/null)
      [ -n "$key" ] || fail "Approved but no key was returned."
      log "Approved."
      printf '%s' "$key"
      exit 0
      ;;
    denied) fail "Authorization denied." ;;
    expired) fail "Claim code expired before approval." ;;
    *) sleep 1 ;;
  esac
done`;
}
