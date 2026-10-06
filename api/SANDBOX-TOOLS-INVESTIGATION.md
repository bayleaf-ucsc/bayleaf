# Hosted OpenCode V2: BayLeaf tools and remote updates

Investigation for [issue #83](https://github.com/bayleaf-ucsc/bayleaf/issues/83),
2026-10-05. ✨ Investigation only: no deployment, package publication, credential
changes, sandbox changes, or issue updates were performed.

## Recommendation

**Implementation follow-up:** the local V2 plugin, sandbox endpoints,
and qualification harness now live in `sandbox-plugin/` and the service scripts.
See `sandbox-plugin/README.md`. Nothing has been published or deployed. The
sections below preserve the investigation that motivated those changes.

Create a **separate sandbox well-known integration and remote configuration**,
sharing the existing provider/model-building logic rather than copying it.
Use native V2 configuration and a small V2-only plugin that:

1. Registers BayLeaf as a websearch provider and selects it by default. Keep the
   existing `websearch` tool and its query permissions.
2. Replaces `webfetch` under its existing effective name, calling BayLeaf's
   `/web/fetch` endpoint. Advertise the actual extraction contract, not direct
   HTTP retrieval capabilities that the API does not provide.
3. Reads the owner's BayLeaf credential internally. Never put the key in tool
   inputs, outputs, URLs, command arguments, or plugin options.

Register the hosted environment as a **real V2 well-known connection**, not a
downloaded configuration snapshot. Publish reviewed plugin releases and change
the **exact package version** in the remote configuration to roll them out.

This avoids changing desktop users' search/fetch preferences through the shared
standard configuration, and avoids requiring V1 plugin compatibility. Keep
application binary updates separate: OpenCode and OpenChamber are deliberately
pinned by the installer.

## What is wrong with the current assembly?

`scripts/browser-setup.py:255–275` downloads the standard authenticated remote
config into the managed global `opencode.json`. `environment():315–326` supplies
`BAYLEAF_API_KEY` to the process. **No well-known source is registered** by this
installer, so V2's ongoing remote-config refresh does not apply.

The snapshot is refreshed during setup, not by a browser tab opening onto an
already-ready environment. The controller can join an existing ready work period
without setup. Bundled sandbox skills likewise arrive through setup and restoration,
not an independent ongoing update channel.

The managed root/config isolation and existing API web adapter are useful
separation-of-concerns patterns. The snapshot is the architectural mismatch:
configuration that looks remotely managed is actually a locally saved copy.

## V2 tool controls

### Search

The V2 [websearch guide](https://opencode.ai/v2/docs/websearch/) documents
`websearch: false` to remove search from model requests, and
`websearch: { provider: "..." }` to choose a provider.

The [plugin API](https://opencode.ai/v2/docs/build/plugins/) supports:

```ts
await ctx.websearch.transform((editor) => {
  editor.add({
    id: "bayleaf",
    name: "BayLeaf",
    execute: async ({ query }, { signal }) => {
      // POST /web/search, authenticated internally, using signal.
      // Map each { title, url, snippet } result to:
      // { title, url, content: snippet, time: {} }
      return results
    },
  })
  editor.default.set("bayleaf")
})
```

This is an illustrative skeleton, not an executable implementation. Prefer the
provider extension over replacing the search tool: it preserves native
`websearch` query permission checks and source formatting. Do not hand out the
platform's Tavily key, and do not configure native Tavily with a BayLeaf token:
those credentials and endpoints are different contracts. Select BayLeaf
explicitly, not `random`, to avoid unexpected provider switching.

### Fetch

There is no documented custom fetch-provider configuration analogous to search.
V2 tools are plugin registrations. A plugin can `editor.remove("webfetch")`,
`editor.update("webfetch", ...)`, or add a complete definition with that same
effective name. Later valid registrations override earlier definitions.

The built-in fetch plugin ID is `opencode.tool.webfetch`. A sandbox configuration
can explicitly disable it through:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "-opencode.tool.webfetch",
    "<published-bayleaf-plugin>@<reviewed-exact-version>"
  ],
  "websearch": { "provider": "bayleaf" }
}
```

The package above is a placeholder, not an existing publication. Disabling the
built-in before adding our same-name replacement prevents a silent direct-fetch
fallback if our plugin fails. Merely denying the `webfetch` permission is not a
replacement: it would also affect the intended same-name tool.

API adaptation:

| OpenCode tool | BayLeaf API | Important differences |
| --- | --- | --- |
| `websearch({query})` | `POST /web/search` with `{query, max_results:5}` | Map `snippet` to V2 `content`, use `time:{}` because publication dates are absent. Optional API answer need not be used. |
| `webfetch({url, format, timeout})` | `POST /web/fetch` with `{urls:url, format}` | API supports `markdown` and `text`, not raw `html`; honor cancellation/timeouts locally. |

The replacement fetch description/schema should offer only supported formats.
It retrieves extracted public-page content through Tavily, not arbitrary HTTP
response bodies, authenticated pages, or private sandbox previews. Partial
`failed_results` must become explicit failures, not successful empty content.
Do not silently claim raw HTML, JSON/API retrieval, or binary download parity.
Those jobs can remain explicit shell/HTTP or specialized-tool tasks.

**Permission gate:** overriding a tool does not retain its executor's internal
permission checks. Built-in fetch explicitly checks `webfetch` against the URL.
The replacement must preserve equivalent behavior; the general plugin
`options.permission` mechanism is not evidence of URL-resource parity. Qualify
allow, ask, deny, and rejection behavior with the supported V2 permission API
before shipping. Keeping native search avoids this problem for search.

## Remote configuration really does update while running

The public guides do not fully describe the well-known refresh loop. The
following findings come from **the exact sandbox-pinned V2 release 2.0.22**,
Git commit `527f0b931d1f9b3ebd34e106c51b31ce5db5b075`, not V1 source:

- [`packages/core/src/config.ts`](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/config.ts):
  lines 145–182 load authenticated well-known config, 230–236 place it below
  local settings, and **308–325 refresh every 10 minutes** while a location is
  loaded. An unchanged manifest still causes remote config to be fetched again.
- The same file, lines 265–276, publishes `Config.Event.Updated` when config
  entries change.
- [`plugin/supervisor.ts`](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/plugin/supervisor.ts):
  lines 153–173 activate locally available plugins, then install missing ones;
  line 213 subscribes to the config-updated event.
- [`plugin/module.ts`](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/plugin/module.ts):
  lines 85–105 resolve cached packages or install missing targets with `npm.add`.

Therefore changing a remote plugin entry from exact version A to exact version B
is a **new install target**, not an update of an unchanged package selector.
The source supports automatic installation and activation after config refresh.
This should comfortably meet the one-day goal for active, connected instances,
but an end-to-end hot-update test is still required.

By contrast, leaving an unpinned `@latest` selector unchanged does **not** imply
automatic installation of a newer release. V2 checks for outdated plugins and
provides `plugin update`; detection and installation are distinct. Exact pins
also provide a deliberate rollout/rollback control rather than trusting the
registry's latest release blindly.

Stopped/archived sandboxes cannot update while asleep. They should fetch the
current remote config when the application next starts. Do not wake machines or
extend work periods solely to update tools.

V2 tool snapshots are stable per model request: tool changes affect subsequent
snapshots, not executors already captured by an in-flight request. There is no
reason to restart OpenChamber daily to deliver ordinary tool revisions.

## Bootstrap and configuration shape

Suggested new integration origin: `https://api.bayleaf.dev/sandbox` (proposed,
not deployed). It would expose:

```text
/sandbox/.well-known/opencode
/sandbox/.well-known/opencode/config
```

Keep the standard and Sealed desktop endpoints intact. Share provider/model
construction in `src/routes/wellknown.ts`; render native V2 `providers`,
`package`, `settings`, and `plugins` in the sandbox config. Do not infer the V2
shape from the potentially V1 schema at `opencode.ai/config.json`.

The existing owner key is already transferred securely. V2 supports adding a
well-known source and creating a credential through its API:

- `POST /api/experimental/integration/wellknown`, body `{url: integrationOrigin}`.
- `POST /api/credential`, with the origin as `integrationID`, a key credential,
  and activation requested.

These are documented in the [V2 API](https://opencode.ai/v2/docs/api/) and its
OpenAPI contract. Qualify the bootstrap ordering and idempotent key rotation on
the managed **2.0.22** assembly before adopting them. Do not edit SQLite or seed
legacy `auth.json`, and do not invoke an interactive device flow when the
installer already has the authorized owner's key. Pass bootstrap bodies through
protected local transport, never secret-bearing command arguments.

Replace the downloaded global snapshot with minimal local installation policy
(for example, keeping binary `update` disabled). A retained snapshot would sit
above remote settings and could keep overriding newly published model/tool
defaults. Preserve user-added local preferences instead of overwriting them on
every setup. Remote defaults remain user-overridable, not an enforcement boundary.

## Qualification gates before implementation rollout

1. Isolated V2 2.0.22 fixture: register a synthetic well-known source and key,
   confirm native config is loaded, and verify config refresh without restart.
2. Publish/install fixture plugin A, change the remote pin to B, and verify a
   new tool appears in an existing session after refresh. Check absence of
   duplicate plugin IDs, cleanup of old registrations, and unrelated settings
   preservation. Repeat with a second loaded project location.
3. Verify startup and hot refresh when BayLeaf or the package registry fails.
   Config fetch failures in the pinned source contribute no remote documents
   for that load: **do not assume last-known-good remote config survives**.
   Missing-plugin activation can also have a temporary gap. Decide and test
   recovery/last-known-good requirements before promising seamless availability.
4. Exercise real BayLeaf search and extraction with a user key, plus invalid,
   revoked, and rotated keys; propagate explicit content-free errors. Never
   attach the BayLeaf Authorization header to the target website, and use
   redirect restrictions on authenticated BayLeaf requests.
5. Verify permissions, cancellation, bounded results, extraction failures,
   unsupported formats, and the exact model-visible names. With our plugin
   unavailable, the native direct-fetch executor must remain absent.
6. Verify start, continue, restart, stop/wake, and archive/wake on the hosted
   assembly without extending work deadlines or waking compute for updates.

Search queries and target URLs are plaintext to BayLeaf and Tavily. This is not
Sealed inference or attested operator-inaccessibility. Keep credentials and
request content out of new diagnostics; review the existing privacy disclosures
for this specific tool path rather than inheriting inference claims wholesale.

## Outcome

A separate sandbox remote configuration is the preferred scope. A V2 plugin
can provide the familiar search/fetch tools with BayLeaf-backed implementations.
The pinned V2 remote-config loop already provides sub-day distribution; the
missing step is genuine integration registration plus centrally changed exact
plugin pins. Runtime behavior is source-backed, not yet experimentally qualified.
