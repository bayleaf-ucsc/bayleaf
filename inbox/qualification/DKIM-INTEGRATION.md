# DKIM restrictions: local integration handoff (2026-10-21)

**Historical local handoff; integrated into main.** The source `inbox-dkim`
worktree performed no commits, pushes, deploys or mail sends. Surgical integration
preserved main's SSE/lifetime/qualification Worker. See
[integrated hardening](INTEGRATED-HARDENING.md) for the subsequent merged baseline
and deployment dependencies, and `../QUALIFICATION.md` for deployment evidence.
This historical record does not establish current deployment or enablement state.

## Contract and implementation

- `DESIGN.md` owns the contract. Email creation accepts immutable
  `email_auth: { domains: ["ucsc.edu"], selector_pins: { "ucsc.edu": ["chosen_selector"] } }`.
  Omission/null remains explicitly unrestricted, including existing inboxes.
  Create/list/get reports the policy only to the owner; HTTP rejects email policy.
- Exact domain alignment, RSA >=2048 or Ed25519-SHA256, no SHA-1 or `l=`, signed
  single From, signature times valid, no testing keys. Optional pin is on the
  **same** passing signature. Underscore selectors use a narrow compatibility
  extension, not globally lenient verification. Delegated domain authority is not
  person/mailbox authentication. DNS delegation alone says nothing about the
  provider's account provisioning or sender-identity controls. Replay remains.
- `src/dkim-verifier.mjs` is shared with research. `scripts/build-dkim.mjs`
  guards both vendor patches and generates ignored `.generated/dkim-verifier.mjs`.
  Production has no test fetch endpoint, resolver URL override or strict-mode
  override. It stores only `dkim_auth: {domain,selector,algo}`, never diagnostic
  per-signature result objects. Copied Authentication-Results stays untrusted.
- `src/email-policy.mjs` independently validates owner input; facade schemas are
  only the first layer. Migration **0007_email_auth.sql**, following integrated
  `0006_qualification_hardening.sql`, adds a NULL-default policy column and an immutability
  trigger. Reservation rechecks active state and the exact policy snapshot.
- `EMAIL_AUTH_CREATION_ENABLED` defaults false. This gates new restricted inboxes
  only, never reception enforcement on an existing restricted inbox.

## Bounds and measured evidence

- Hard restricted raw-mail cap **1 MiB**, or a lower configured MAX_EMAIL_BYTES.
  Declared oversize or actual streamed oversize rejects with readable 5.3.4.
  Existing unrestricted mail retains the configured 25 MiB cap. **25 MiB DKIM
  verification is not qualified**, and there is no oversized unverified fallback.
- DKIM caps: 32 KiB headers, 200 header lines, four signatures, four TXT lookups,
  one TXT RR <=8 KiB, 32 KiB DoH response, 1.5 s per lookup, 6.5 s total wait.
  Fixed HTTPS Cloudflare DoH endpoint, manual/no redirects, abortable fetch.
- MIME metadata caps for restricted mail: 256 parts, depth 16, 64 KiB total
  headers, forwarded depth 4, forwarded addresses 256. Parser overflow keeps the
  verified raw message with parse_error, not an authentication bypass. This original
  branch behavior is superseded by integrated hardening: resource-limit failures
  now reject explicitly after verification; other syntax errors retain raw fallback.
- A dedicated REJECT_LIMIT key bounds verification attempts (including successes),
  and only verified mail spends ACCEPT_LIMIT. Address knowledge can exhaust this
  pre-verification budget, a documented availability tradeoff.
- A 1,045,121-byte synthetic signed message passed the real email() endpoint,
  MIME parsing and R2/D1 storage in approximately **36 ms wall time** on this
  laptop. This is not a production CPU measurement or 128 MiB heap proof.
  Large-header, MIME-part overflow and oversize rejection paths are exercised.
- Wrangler local `deploy --dry-run`: complete bundle **1575.77 KiB raw,
  486.95 KiB gzip**, within bundle upload limits. The actual Wrangler-produced
  artifact also booted in pinned workerd and returned 200 at the apex.
  Deployment/startup CPU and adversarial
  concurrent memory behavior have **not** been measured on Cloudflare. Retain
  operator-only pilot scope and the 1 MiB cap until live qualification.
- `npm audit --omit=dev`: zero advisories. The existing pinned development
  toolchain still reports miniflare/sharp/undici/wrangler advisories; not fixed
  here because that would change the runtime under qualification.

## Exact local test evidence

| Command | Result |
|---|---|
| `cd inbox && npm test` | **81 tests passed**, 16 suites, zero failed/skipped. Includes **28 new restriction tests** plus 53 prior tests. |
| `cd inbox/research && npm test` | **54 cases passed**, zero failed/skipped, Node/workerd differential results and unshimmed RSA tripwire. |
| `cd api && npm run test:inboxes-e2e` | **62 checks passed**, real API and inbox Workers with D1/R2 and owner isolation. |
| `cd api && npm run test:inboxes` | Existing API facade script passes (does not emit an assertion count). |
| `cd inbox && npx wrangler deploy --dry-run --outdir .generated/deploy-preview` | Local build succeeds; no upload/deploy. |

Endpoint coverage includes RSA, Ed25519, underscore selector, local proof storage,
From/body/header tampering, copied Authentication-Results, l= abuse, missing and
revoked keys, weak RSA, unaligned/relaxed-only domains, multiple signatures,
same-signature pins, replay, declared/actual size caps, near-cap acceptance, MIME
budget overflow, DNS SERVFAIL/oversized responses, policy validation, creation
gate, immutability, owner isolation, destruction during DNS before reservation,
and failed authentication not spending acceptance quota.

The independent 15-message public corpus research previously matched Node on all
signatures (11 accepted after the selector extension, four policy/unsigned
rejections). No campus user mail was accessed in this worktree. Live keys can
rotate; these are dated observations, not permanent fixtures.

API tests use explicit **test-only** fixtures for unrelated generated plugin/
Nanobot assets (`api/scripts/inbox-test-assets.mjs`). This enables clean-worktree
tests without initialized adapter submodules; it is not adapter delivery or a
valid API deployment build. Production API builds still require normal published
adapter assets. No such fixture is written as a production JSON artifact.
Full API `tsc --noEmit` currently stops only at those two absent generated JSON
imports (`wellknown.ts`, `sandboxBrowser.ts`); no changed-schema errors were
reported. The parent must regenerate real adapter assets and rerun typechecking.

## Historical merge guidance and deployment dependencies

1. Integration completed: new source/build files, pinned mailauth dependency+lock, ignore rule,
   migration 0007 and tests. Merge only Worker hunks: imports, restricted parser
   budget, policy column/view, creation validation/gate, email auth before parse,
   reservation snapshot check. Preserve all SSE, lifetimes, cleanup and
   qualification work from other agents. Merge API schema/description hunks and
   test changes similarly. Schema helpers can retain separate exports.
2. Both `npm test` and Wrangler generate the verifier; direct custom esbuild
   callers must run `node inbox/scripts/build-dkim.mjs` first. Inbox runtime needs
   `nodejs_compat`, with compatibility date 2026-08-01 on the pinned toolchain.
   Keep the guarded build and shim with the dependency, never ship raw mailauth.
3. Apply Inboxes D1 migration 0007 after the coordinated earlier migrations.
   Deploy receiver with creation **false**, verify owner reads/unrestricted
   reception, wait for old receiver versions to stop serving. Deploy API schema
   changes after receiver. Only then enable restricted creation for the existing
   operator pilot. These are instructions, not actions performed here.
4. Create disposable restricted pilot resources for live tests. Confirm positive
   actual UCSC-signed delivery, allowed/mismatched selectors, exact alignment and
   forged From denial. Do not infer real campus selectors from SendGrid DNS.
   Confirm permanent `setReject` behavior and transient DNS/storage thrown-error
   SMTP retries; a 4.x string passed to setReject can still be permanent on
   Cloudflare. Never advertise retry semantics until observed.
5. Verify ordinary API list/get/readback, hosted-client discovery freshness, cap
   rejection clarity, CPU/startup and memory behavior on the live tier. Surface
   adapter support remains explicitly deferred, not claimed by schema changes.
6. Rollback: turn off creation, but retain verifier enforcement. **Do not deploy a
   pre-verifier receiver while a restricted inbox exists**, since old code would
   ignore the policy. Destroy those disposable inboxes first or keep a verified
   receiver revision. Migration is additive; do not undo its schema blindly.

Upstream drafts remain `research/UPSTREAM-ISSUES.md`, local review only.

## Main integration evidence (2026-10-21)

Integrated against main's TTL/SSE/export implementation, with surgical Worker
hunks. The policy predicate is alongside the execution-time lifetime predicate,
not a replacement for it. Creation binds both `expires_at` and immutable policy.
Export streaming, cancellation, digest cleanup, events and sweep paths retain
main's implementation. The GLM-owned live-stream record was not edited.

| Local check | Integrated result |
|---|---|
| `cd inbox && npm test` | 119 passed, zero failed; two optional HAR-validator/Insomnia importer checks skipped because those external dependencies are absent. |
| Focused DKIM suite after two added integration checks | 30 passed, zero failed/skipped: includes unset and false creation gates, continued enforcement while gated, TTL plus policy creation, immutable update denial, and expiry during DNS before reservation. |
| `cd inbox/research && npm test` | 54 passed, zero failed/skipped. |
| API `npx tsc --noEmit` | Passed using main's real generated adapter assets; pins unchanged. |
| API `test:docs`, `test:inboxes` | Passed. |
| API `test:inboxes-e2e` | 93 checks passed. |
| API `node scripts/test-inbox-stream.mjs` | 18 passed, zero failed/skipped. |
| Receiver Wrangler dry-run | 1601.30 KiB raw / 492.87 KiB gzip; generated bundle boots in pinned workerd, apex 200. |
| `npm ci --ignore-scripts` in inbox and research | Both passed with their lockfiles; runtime audit zero advisories. |
| `git diff --check` | Passed. |

Migration numbering is unchanged: `0007_email_auth.sql` follows the integrated
`0006_qualification_hardening.sql`. The earlier isolated **local** Wrangler check
applied 0001–0005 followed by 0007 and demonstrated gap acceptance; it is historical
evidence, not the current schema sequence. The merged inbox harness dynamically
discovers migrations 0001–0007, preserves trigger bodies and can seed pre-events
rows before 0004 for backfill checks. The telemetry migration-upgrade test
deliberately starts with its older schema. Follow the integrated hardening record
for current migration dependencies; never renumber by inference.

### Deployment handoff: keep restricted creation disabled

1. Finish the coordinating session's export/live-trial gates. Deploy the approved
   collector export vocabulary before a receiver that emits export metrics.
2. Check remote applied migrations and apply outstanding Inboxes migrations
   through 0007 in order, including 0005 export, 0006 hardening and 0007 policy.
3. Deploy the integrated receiver with `EMAIL_AUTH_CREATION_ENABLED="false"`.
   The dry-run confirms that exact deployment value; code also denies creation
   when the variable is absent. Keep current email inboxes unrestricted.
4. Wait for receiver propagation, verify ordinary owner reads/unrestricted mail
   and restricted-create denial, then deploy API contracts using real adapter
   assets. Retain `INBOXES_PILOT_OWNER`; do not enable campus access.
5. Leave restricted creation off. Live DKIM/SMTP/CPU/memory qualification and any
   later enablement remain separate work. Never roll back to a pre-verifier
   receiver once restricted inboxes exist; turning creation off does not turn
   enforcement off.

This integration performed no remote migration, deployment, mail send, commit,
push, upstream issue publication or worktree removal.
