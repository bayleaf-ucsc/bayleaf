# Public browser arrival integration

Initial local preparation record for [#112](https://github.com/bayleaf-ucsc/bayleaf/issues/112),
with the signed-out Chat addition qualified below. Current deployment/activation
state is authoritative in [the rollout record](../qualification/rollout.md), not
the historical disabled-source descriptions below. Chat's independent switch
remains off by default; this addition performed no deployment, activation, commit
or push. Source rollout and disclosure review remain parent/operator responsibilities.

## Source contract and boundaries

`entry.mjs` imports the existing `adapters/browser.mjs` and `common.mjs` policy,
not a copied sanitizer/transport. `build.mjs` tree-shakes and bundles those modules
into a generated TypeScript string for inline use and `landing/arrival.js` for
self-hosting. Runtime has no package dependencies. Esbuild comes from the existing
API development tooling. Generated source equality is tested so a later shared
policy change cannot silently leave stale deployed client code unnoticed.

One POST at initial public document execution to
`https://telemetry.bayleaf.dev/v1/browser`, body:

```json
{"schema_version":1,"destination":"landing","referring_hostname":"example.org"}
```

`destination` is fixed by the render, not derived from the URL. Only the approved
hostname sanitizer reads `document.referrer`. No client timestamp, identifier,
session, current URL, query, path, fragment, filename, IP or UA field is sent.
Fetch uses `credentials: omit`, empty `referrer`, `no-referrer`, no authorization,
manual redirects and no-store. The sole explicit request header is JSON content
type. Standard browser network metadata (including Origin, UA and source IP) still
exists in transport: the collector/edge must discard it, not persist it. CORS
preflight may occur. This is content-minimizing collection, not transport anonymity.

The three initial static clients make one attempt with a 1-second abort deadline, no retries/queue/beacon fallback,
no storage, no navigation/click/page lifecycle listeners and no response-body
consumption. Failures do not alter the page or show messages. Exact production
origin and root pathname checks are an additional backstop. They do not replace
server authentication gating. The pathname is inspected locally but never sent.

## Parent-owned enablement seams

- **Landing:** the HTML loads only same-origin `arrival.js`, with
  `referrerpolicy="no-referrer"`. No remote initial script request can leak a
  referring URL. Checked-in `telemetry/browser/config.json` explicitly sets
  `landingEnabled: false`. `node telemetry/browser/build.mjs` reads that config
  and reproducibly generates the matching artifact; there are no activation CLI
  flags. After approval, parent changes the config to true and rebuilds. Ordinary
  rebuilds then preserve activation instead of silently turning it off. The
  source-equality test reads the same config and works in either state; separate
  in-memory test fixtures exercise both states without editing source activation.
  Pages already copies the landing tree. Publishing the config and matching asset
  remains the parent's approved commit/push workflow.
- **Sandboxes:** Worker accepts exact string
  `BROWSER_ARRIVALS_ENABLED="true"`; unset, `"false"`, other strings and booleans
  stay off. Parent added an explicit false deployment variable. `renderSandboxPage` includes inline static
  bundled code only when enabled **and no authenticated user exists**. Its nonce
  is covered by existing CSP. Only that public response adds
  `https://telemetry.bayleaf.dev` to connect-src; authenticated root keeps its
  original CSP and contains no arrival client. Invalid sessions may fall back to
  the ordinary public overview after validation. Login/callback/service responses
  never embed this client.
- **API:** `LandingPage` now has optional `browserArrivalsEnabled` defaulting to
  false. It embeds static inline bundled code only on exact boolean true. Existing
  root route redirects authenticated users before rendering. Parent wired the
  prop from exact `c.env.BROWSER_ARRIVALS_ENABLED === 'true'` in
  `api/src/routes/dashboard.tsx`, declared its optional string binding in
  `api/src/types.ts`, and added an explicit false deployment variable.
  Do not put the script in BaseLayout or API index/global middleware. No new API
  endpoint, dashboard integration or agent capability is introduced.
- **Chat: locally qualified, activation separate.** `chat-gate.js` uses the
  actual pinned v0.12.3 loader seam in the existing guarded native image. Only an
  initial public root with no token marker, followed by the resolved auth card,
  can load `chat-client.mjs`. Direct auth, callbacks/logout, private deep links
  and signed-in documents are excluded. A bounded DOM-presence observer ends
  after one attempt, pagehide, session/private-route detection or 15 seconds.
  `chat-entry.mjs` bundles the same adapter with a fixed null referrer and repeats
  the sign-out check immediately before fetch. `entry.mjs` deliberately still
  does not admit Chat: generic root/path gating cannot resolve authentication.
  `node telemetry/browser/build-chat.mjs` reproducibly generates the separate
  module without touching the other sources. Independent runtime switch:
  `BAYLEAF_CHAT_ARRIVALS_ENABLED=true` (unset/exact false is off; malformed refuses
  boot). Full semantics, pinned asset copying, 16 browser checks, privacy evidence,
  deployment environment and native-preserving rollback:
  [Chat arrivals qualification](../qualification/chat-arrivals.md).

## Tests (all synthetic, no production writes or collection)

```sh
node --test telemetry/browser/browser.test.mjs
node --test telemetry/browser/chat.test.mjs
node sandbox/test-worker.mjs
node api/scripts/test-browser-arrivals.mjs
uv run --script telemetry/browser/test-browser.py
# With the documented local synthetic Chat containers, never production:
uv run --script telemetry/browser/test-chat-browser.py
uv run --script telemetry/browser/test-chat-browser.py source-disabled
```

The browser harness uses installed Google Chrome via Playwright. Every browser
HTTP request, including third-party iframe requests and the collector, is
intercepted/fulfilled in-process. Fixtures use synthetic data only, held in memory.
Production hostnames are used solely to exercise exact-origin checks and CORS.
The harness even installs a synthetic collector cookie to prove it is omitted.
No remote browser service, real user session or collector request is involved.

Verified 2026-10-20:

- Six Node tests pass: generated source match, disabled default, exact body/wire
  options for all three sources, hostname filtering, bounded failure/no retry,
  private-origin/path suppression, API landing/default/private-template boundaries.
- Sandboxes adapter tests pass with disabled/malformed switches, public-only
  enabled embedding, nonce/CSP checks and authenticated/auth/private-route absence.
- Full API app regression passes with real signed synthetic JWT sessions and a
  read-only fake DB: only anonymous root with exact-true switch embeds the client;
  authenticated root redirects to dashboard, authenticated dashboard has no
  arrival script, and anonymous dashboard redirects to login. All outbound fetches
  are denied and asserted absent; HTML scripts are not executed in this test.
- Real Chrome passes all three sources at 1280×900 and 360×800: same approved body,
  no Cookie/Referer/Authorization on POST, no Referer on landing script request,
  no URL/query leakage, no extra event on history change, no event if enabled code
  is replayed on `/dashboard`, no page exceptions. Visible text and bounding
  rectangles match exactly between enabled/disabled variants.

These are local source/protocol tests, not evidence of deployed CORS, collector
admission, retention, production artifacts, live source activation or full
accessibility conformance. Both the actual API landing template and full-app
anonymous/authenticated routing are covered, with no live provider/collector calls.

## Landing ACR and documentation implications

No visual/layout/semantic-content/control changes are expected or observed.
The new script performs no DOM writes, focus changes, status announcements or
interactive work. All useful content remains available without JavaScript or
when collection fails. Existing measured contrast colors and CSS are untouched.

The absolute **no runtime JavaScript** claim becomes false even with collection
disabled: an inert script executes. Root AGENTS.md now describes content/control
independence from JS and lists the generated asset/config. `politics/VPAT-pages.md`
now names the script, preserves the old four-page audit as historical evidence,
replaces the no-JS rationale for WCAG 4.1.3 with absence of dynamic status, and
records the dated local Chrome comparison. This does not requalify the whole
page, repeat keyboard/reflow/contrast/assistive-technology tests or close existing
video gaps. Publication and privacy notices remain parent-owned. Operator has
chosen no email notice; this agent sent none.

Playbook note: `accessibility-evidence.md` is Chat recording-oriented and correctly
warns against generalizing recordings into full criterion-wide conformance. This
run uses local interception and text/geometry comparisons, not Chat recordings or
assistive-technology qualification. Its refinement-log edit was not made because
the delegated file-ownership boundary excludes the playbooks.
