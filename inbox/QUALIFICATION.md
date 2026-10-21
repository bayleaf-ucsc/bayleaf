# Inboxes qualification and delivery

Issue [#97](https://github.com/bayleaf-ucsc/bayleaf/issues/97). Operator-only webhook
qualification deployed with Adam's approval on 2026-10-20. No campus rollout.
Email Routing/MX are now enabled for registered inboxes. Email delivery is
unrestricted by sender; authenticated allowlists remain unimplemented.

## Deployed pilot

- Receiving Worker `bayleaf-inboxes`: `a6062055-474e-4a10-a2b6-af8eaff40c78`.
- API Worker `bayleaf-api`: `a69d6729-d02d-484a-9f25-c033b797fb78`.
- Collector `bayleaf-telemetry`: `3194981a-83b3-4d0b-aa34-e2c7888f3f73`.
- Sandboxes handoff `bayleaf-sandboxes`: `f80f038d-4807-4c33-99d2-8a6a6e0a5589`.
- Dedicated D1 `bayleaf-inboxes`: `f23c3a91-2a81-4811-ae93-ff8343684f87`;
  `0001_inboxes.sql` applied. Private Standard R2 bucket `bayleaf-inboxes`, WNAM;
  no public R2 domain or managed public URL.
- Proxied apex/wildcard DNS and trusted apex/wildcard Universal TLS verified.
- API access requires the operator's existing account generation via
  `INBOXES_PILOT_OWNER`; other authenticated owners receive 404. Public docs identify
  this as operator-only qualification and email transport as pending.
- API staged through `api/scripts/stage-inboxes-deploy.py`: reviewed API changes,
  normal build hooks, and clean published adapter commits, never fixture assets.
  The initial pilot used plugin `3ce541891bbc2a3146d61176b325b1bf926d086c` and
  Nanobot `24d49f4e0240a3bd884881b7b7b71e85eba08b04`. With explicit publication
  approval, the inbox-capable adapter branches were published as plugin
  `eb40edabc1e7dd58a6e9be586115779402ccfd23` and Nanobot
  `16ee3c3ba44f6ae64d6847e64a79fa7949c18c2a`; parent build hooks now resolve
  those commits. Installed-client qualification is a separate pending gate.
- Source API config deliberately remains `INBOXES_ENABLED:false`; staging enables
  the restricted pilot. An ordinary source deploy disables the pilot. Do not remove
  the owner restriction or enable campus access before remaining gates are resolved.
- Initial live smoke: authenticated inbox list succeeded with zero pre-existing
  inboxes; generated docs contain Inboxes and the pilot notice.

### Luna usability playtest and deployed refinements

GPT-6 Luna started from public `llms.txt`, without a private endpoint checklist.
Using the operator's existing key and synthetic reports, it created an HTTP
inbox and one-hour sender credential, observed anonymous denial, delivered a
report, retrieved metadata/text, saved exact bytes privately, revoked the sender
credential and requested inbox destruction. No existing user content was read.

Findings and follow-up:

- Cloudflare returned plain-text HTTP 403/error 1010 for Python's default urllib
  user agent. Independently reproduced: an honest `BayLeafInboxClient/1.0`
  user agent succeeds. Public docs now explain edge versus JSON API errors;
  Cloudflare protections were not globally weakened.
- Credential creation now returns `inbox_closed:true` plus a sticky-authentication
  reminder, rather than relying on prior documentation alone.
- Destruction and destroying inbox views now return `cleanup_not_before` (earliest
  finalization, not a deadline). Docs explain the 15-minute quiescence and next
  15-minute sweep, with retries/backlog caveats. The test's early follow-up was
  correctly still `destroying`; physical cleanup is pending verification.
- The public walkthrough now covers timed issuance, delivery, retrieval and
  cleanup while keeping owner and sender credentials distinct and sender tokens
  out of terminal output.

GLM-5.3-Flash subsequently completed a similar fresh-user task independently:
creation, timed sender credential, delivery, listing, exact-byte download and
destruction. It found a genuine error-format inconsistency: malformed inbox
subpaths returned HTML while normal missing resources returned JSON. The deployed
API now returns JSON 404s for those subpaths, covered locally and verified live.
Its sanitized diary is `qualification/glm-webhooks.md`.

Parent assessment distinguished product issues from tester mistakes: its mixed
curl `-w`/JSON capture and missing shell variables/imports came from its client
script, not the published walkthrough. `/text` is intentionally a documented JSON
envelope, and adding a receipt id or renaming the route was not justified by this
trial. This is formative usability work, not a controlled model comparison:
documentation changed between trials.

Both synthetic inboxes are in `destroying` state. A SELECT-only live D1 check
verified zero credential rows and zero message rows for each, including GLM's
credential it had not individually revoked: destroy removed it immediately as
designed. Final inbox-row removal after quiescence/the scheduled sweep remains
pending verification; provider history and opaque cleanup records are residuals.

### Astra review and revisions

GPT-6 Astra reviewed tracked/untracked files and both adapter submodules. All three
findings were addressed: actual OpenChamber launch environment now derives the
feature flag from the server request and fingerprints it; inbox file downloads use
held directory descriptors and a fixed Python helper with nofollow, directory-relative
publication; generated revocation schema now describes sticky authentication.
Regression evidence: 28 plugin tests (including parent/workspace swap attacks),
28 installer tests, docs and TypeScript checks pass. The plugin's descriptor-relative
helper has been exercised on macOS, not yet in a live Linux hosted session.

### Live email and attachment evidence

Cloudflare Email Routing was enabled with its provider-required locked MX/SPF/DKIM
records and a catch-all Worker action. Unknown recipients still reject; routing
never implicitly creates inboxes. A deliberately unrestricted operator diagnostic
inbox received one user-sent message with an inline PNG. An explicitly requested
five-second polling watch observed arrival and stopped. The decoded attachment
downloaded correctly and was visually readable. At the user's request, the message,
raw MIME object and attachment were deleted, along with the local downloaded copy.
The user's empty diagnostic inbox was retained. No message content, address or
attachment screenshot is included in this repository.

This proves small real-message delivery, decoding and retrieval, not sender
authentication or worst-case MIME/SMTP reliability. The maintained mailauth PoC
passes synthetic tests in Node but fails valid RSA DKIM on pinned workerd; see
`research/README.md`. No sender restriction was silently substituted.

### Diagnostic web experiences (#113)

The minimal signed-out entry point and API-hosted owner receipt diagnostics are
deployed, not a full email client. Actual public HTML arrivals are verified through
the first-party collector; private dashboards, receipt URLs and plaintext
`/llms.txt` are excluded. The operator pilot is unchanged. Real UCSC owner login
and receipt metadata rendering are verified. #113 stays open for a separate
private-preview navigation check. See [issue #113](https://github.com/bayleaf-ucsc/bayleaf/issues/113),
`../api/DIAGNOSTICS.md` and `../telemetry/qualification/diagnostics.md` for exact
scope, versions, evidence and remaining qualification.

### Aggregate service telemetry release

Policy 4 extends the existing private metrics class with source `inboxes`,
15-minute delta windows and fixed receipt/lifecycle/cleanup vocabularies. Source
write authority is separate from private read authority and all existing writers.
Local windows/outbox expire after 24 hours and are bounded to 96 windows; collector
retention is at most 90 days from the original window end. See
[`telemetry/qualification/inboxes.md`](../telemetry/qualification/inboxes.md).
The source and receiver were deployed disabled, migration `0002_telemetry.sql`
applied, separate secrets provisioned without rotating existing capabilities, then
explicitly enabled. Existing Daytona and OWUI paths were preserved on reconciliation
with main. Local evidence: 53 inbox tests and 96 collector tests pass. A fresh
Astra review confirmed no P1/P2 defect in this telemetry delta. Real scheduled
HTTP receipt/guard/lifecycle export was verified for 2026-10-21 04:45–05:00 UTC,
including writer/read role isolation. Live email and scheduled cleanup counters
remain unverified; see the telemetry report for exact evidence.

The inbox, proxy and Sandboxes apex `/llms.txt` handoffs serve a one-sentence gloss
and the main API guide on GET/HEAD. They do not intercept tenant paths or emit
browser-arrival events. Proxies required an explicit apex Worker route and proxied
DNS record; authoritative/public DNS and TLS-validated HTTP were checked despite a
stale local negative DNS cache.

## Approved exposure decisions

Adam approved this matrix in the session's exposure picker. Server ownership is
necessary everywhere; client permission prompts are additional guardrails, not
proof against prompt injection or a substitute for server authorization.

| Surface | Decision | Discovery and invocation | Delivery and verification |
|---|---|---|---|
| HTTP docs | Expose | Generated OpenAPI, Inboxes tag and typed schemas; ordinary key or sandbox credential, never Campus Pass or inference grants | Local tests; live pending |
| `llms.txt` | Expose | Offer collection while clients are off, link to exact HTTP contracts, readable-text endpoint | Advertise only when enabled; local tests |
| Desktop orientation skill | Expose | Compact trigger, load `llms.txt` on demand | Catalog version bump; live discovery pending |
| Hosted OpenChamber | Expose | List/search/read, download; native permission prompts for mutations and downloads | Separate plugin submodule, local tests; publication, pin and installed-client checks pending |
| Hosted Nanobot | Expose, narrowed | List/search/read, quarantine downloads, create and archive; no deletion, destruction or credential tools | Separate adapter submodule and parent installer; local tests; publication and installed-client checks pending |
| BayLeaf Chat | Defer | No new tool or inferred API authority | Revisit after hosted qualification: Chat identity has no user API credential, and copying mail into history is another storage boundary |
| Human diagnostics | Expose metadata only (#113) | API browser session; counts, receipt times/sizes and reception mode, no content or lifecycle controls | Deployed; public arrivals and real owner login/rendering verified |

Webhook credential minting is not an agent tool: the returned secret would enter
model context. Owners can use the documented HTTP API without pasting credentials
into chat. Agent discovery does not authorize unsolicited inbox creation, polling,
forwarding, execution or acting on sender-written instructions.

## Local evidence

- Independent contract tests run in Miniflare with actual D1/R2, email and cron
  events. Four mutation checks established that tests detect owner-filter removal,
  expired-message visibility, wildcard-search escaping and orphan-check removal.
- API facade tests use an RPC stub; the separate end-to-end harness uses both real
  Workers and tests bytes across the private service binding.
- Plugin and MCP tests exercise descriptions, content delimiting, error filtering,
  path constraints and permission behavior. These are not live behavioral evidence.
- Security review found contract-level flaws despite passing tests: last-token
  revocation reopened reception, pre-body authentication could go stale, delayed
  R2 writes could outlive deletion tracking, and HTML stripping was quadratic.
  Hardening landed with 47 passing Worker tests, including delayed-put and failed
  cleanup injection. API integration is rechecked separately.

Commands:

```sh
cd inbox
npm test
# From api/:
npm run test:inboxes
npm run test:inboxes-e2e
npm run test:docs
npm run test:sandbox-plugin
npm run test:nanobot
```

## Still required before user-content enablement

1. Review hardening evidence, retention residuals and recovery behavior. Account
   retirement must remove the owner's inboxes or explicitly block retirement while
   owned inboxes exist; separate databases make an unchecked cross-service lookup
   insufficient for atomic retirement.
2. Test storage failures, slow uploads, delayed puts and concurrent destruction.
   Measure worst-case MIME memory/CPU and bounded cleanup throughput.
3. Approve and publish accurate privacy/retention disclosures, including raw MIME
   headers, HTTP path/query secrets, operator access and provider recovery history.
4. Obtain explicit deployment approval, create dedicated D1/R2, apply migrations,
   configure DNS/Email Routing and verify wildcard TLS. Null-sender SPF/DMARC must
   be reconciled with Cloudflare's actual setup requirements rather than assumed.
5. Qualify real SMTP acceptance/rejection, exceptions, duplicates and retries using
   synthetic mail. A `4.x.x` string in `setReject` does not make rejection temporary.
6. Publish both adapter repositories with approval, regenerate clean parent pins,
   deploy coordinated feature flags, then verify fresh, existing and sleeping
   clients separately. Do not restart users' work for tests.
7. Behavioral playtests: a natural task such as “collect this service's reports
   while my laptop is off” should elicit the inbox option without naming BayLeaf.
   Test ordinary users, malicious received instructions and denied mutations.

JWT signers and verified email sender allowlists remain follow-ups, not silently
enabled features. A UCSC sender allowlist requires a qualified, trusted receiver
authentication result; matching a sender-written From header is not authentication.
