# BayLeaf Inboxes Worker

Issue [#97](https://github.com/bayleaf-ucsc/bayleaf/issues/97). **Local proof of
concept, opened to authenticated campus owners on 2026-10-21.**
The receiver and API are enabled; `INBOXES_PILOT_OWNER` is explicitly empty.
Ordinary API keys and sandbox credentials retain account-generation isolation.
Email Routing/MX are enabled for
registered inboxes; email is unrestricted unless an optional policy is set at creation.
Creation-only DKIM domain restrictions are enabled:
see `OPERATIONS.md` for migration/build/rollout dependencies.
See `QUALIFICATION.md` for deployed versions and remaining test limitations,
accepted by the operator for this community release.
`DESIGN.md` is the contract; change it first, then code and tests.
`OPERATIONS.md` owns deployment, recovery and troubleshooting; `QUALIFICATION.md`
owns current evidence and reproducible commands; `TODO.md` lists unfinished work.
Keep reusable qualification harnesses and dependency rationale, not chronological
handoffs or one-off result JSON. Write generated evidence to explicit private paths
outside the repository. `qualification/discovery-evals.json` is a reusable fixture.

Opaque email addresses (`{nonce}@bayleaf-inboxes.dev`) and webhook URLs
(`https://{nonce}.bayleaf-inboxes.dev/...`) that receive while every client is off.
Reception stores bounded data in this Worker's own D1 and R2. It never replies,
forwards, runs inference or wakes an agent.

## Boundaries

Deployed #113 web revision adds only an apex HTML explainer with a handoff to
API-hosted owner diagnostics, not an owner HTTP API on this domain. Tenant
receipt paths remain untouched. Apex browser arrivals are explicitly enabled under
`BROWSER_ARRIVALS_ENABLED`, with real browser readback verified. See DESIGN.md and
`../telemetry/qualification/diagnostics.md`; real UCSC owner login and receipt
metadata rendering are verified. The separate private-preview navigation gap
is tracked separately by #113.

- **Public surfaces are reception only:** `email()` (Email Routing catch-all) and
  `fetch()` on the inbox domain. There is no owner HTTP API here.
- **Owners reach it only through the API:** `api/src/routes/inboxes.ts` calls the
  `InboxManagement` RPC over the API's `INBOXES` service binding. The owner argument
  is the API's `account_generation`; this Worker never sees an email or CruzID.
- **Separate storage:** D1 `bayleaf-inboxes` and R2 `bayleaf-inboxes` share nothing
  with the inference API. Inboxes intentionally store content, so the API's
  zero-data-retention and zero-operator-access posture does **not** extend here.
  Say so plainly anywhere inboxes are described.
- **Never log content, addresses, nonces or tokens.** Observability is disabled. The
  sweep logs counts only.
- **Untrusted data:** mail and requests are sender-written. Downloads stay inert
  (see the API facade), and agent adapters label text as untrusted, never as
  instructions.
- Exact payload retention is not anonymization: raw mail retains `Received` and
  other sender/provider headers, and HTTP paths, queries and bodies can contain
  personal data or secrets. Network-header filtering does not remove such content.

## Commands

```bash
npm install              # postal-mime, plus local wrangler/miniflare/esbuild
npm test                 # Miniflare contract suite: real D1, R2, rate limits, email, cron
npm run dev              # wrangler dev --local
```

`INBOX_WORKER_SRC=/path/to/copy.js npm test` runs the suite against another copy of
the Worker (used for mutation checks). The suite was written from `DESIGN.md` alone.

## Design notes worth keeping

- **Envelope routing:** only `message.to` (RCPT TO) decides delivery. MIME headers
  are sender text. This is also what makes Bcc work.
- **Separate reject bucket:** failed authentication spends `REJECT_LIMIT`, not
  `ACCEPT_LIMIT`, so knowing a closed inbox's URL does not let anyone exhaust its
  legitimate senders' budget.
- **Reserve, then write:** a `pending` row and quota reservation commit atomically
  before the R2 put, so every object has a row that cleanup can find.
- **Late-write reconciliation:** quiescence and an empty R2 prefix are necessary
  but do not fence an already-started remote put. Durable opaque cleanup records
  must survive inbox/message deletion and reconcile objects that appear later.
- **Sticky authentication:** creating a webhook credential closes reception.
  Revoking the last credential never reopens it. Authentication must be checked
  again atomically after reading an upload, alongside quota reservation.
- **One content store:** raw MIME or exact request bytes; attachments and text are
  derived on read.
- **Portable export:** exact files and the manifest are canonical. The derived
  `bayleaf-inbox-receipt-1` HAR-shaped profile is nonstandard, never a wire capture.
  Preserve post-await TTL checks, bounded metadata/text, reader cancellation and
  digest cleanup. Apply `0005` and collector export-counter support before rollout.
- **Lifetimes are computed, then swept:** an inbox past `expires_at` is dead at every
  check (lookup, reservation, stored mark, owner reads) before the sweep moves it
  into the one destruction transition (`beginDestroy`). Never add a second cleanup
  path, and never let use renew a lifetime. Apply migration `0003` before deploying.

## Remaining qualification and deployment dependencies

See "Remaining qualification" in `DESIGN.md`: real SMTP qualification (including
`setReject` permanence and thrown-error behavior), large-message memory, account
retirement integration, and `PRIVACY.md`/`api/RETENTION.md` disclosures. Deployment
also needs D1/R2 creation, the real D1 id in `wrangler.jsonc`, the migration, Email
Routing catch-all to this Worker, a proxied wildcard DNS record, and null-sender
SPF/DMARC records (`v=spf1 -all`, `v=DMARC1; p=reject`) checked against what Email
Routing itself requires. Deploy this Worker before any API deploy that includes the
`INBOXES` binding.

`compatibility_date` is `2026-08-01` because the pinned local workerd supports
dates only through 2026-08-18; raise it with the tooling.
