# Self-hosting BayLeaf Inboxes

A modest recipe for running the receiving Worker on your own Cloudflare account and
domain, for example when you need larger limits, your own retention terms, or simply
want to leave BayLeaf. It is an offramp, not a supported product: BayLeaf does not
operate, monitor or update your copy. `DESIGN.md` is the contract for what the code
does; this file only explains how to deploy it.

What you get is exactly `src/worker.js`: email and HTTP reception into your own D1
and R2, the scheduled cleanup sweep, and the `InboxManagement` RPC. What you do
**not** get is the BayLeaf API facade (`api/src/routes/inboxes.ts`), its accounts,
keys, generated docs, hosted agent adapters or diagnostics. You call the RPC from a
Worker of your own; a minimal one is below.

## Requirements

- A Cloudflare account with Workers, D1, R2 and Rate Limiting bindings, and a domain
  whose DNS is on Cloudflare. Plan on Workers Paid: parsing near-25 MiB mail and
  streaming export pages exceed the free plan's CPU allowance. A dedicated domain (or subdomain zone) is simplest, because Email
  Routing's catch-all and the wildcard route claim everything under it.
- A full checkout of this repository: the Worker imports the public page template
  from `api/src/templates/` and `telemetry/browser/`, so build from `inbox/` inside
  the checkout. Node.js and `npm install` in `inbox/`.

## Steps

Commands run from `inbox/` with `npx wrangler` logged in to your account.

1. **Storage.** Create a D1 database and a private R2 bucket:

   ```bash
   npx wrangler d1 create my-inboxes      # note the database_id it prints
   npx wrangler r2 bucket create my-inboxes
   ```

2. **Configuration.** Edit `wrangler.jsonc` (or keep a private copy and pass
   `--config`):
   - `name`: your Worker name; remove BayLeaf's `account_id` or set yours.
   - `routes`: replace `bayleaf-inboxes.dev` with your domain in both patterns and
     both `zone_name`s.
   - `d1_databases[0]`: your `database_name` and `database_id`. `r2_buckets[0]`:
     your bucket name.
   - `ratelimits`: any `namespace_id` integers unique within your account.
   - `vars`: set `INBOX_DOMAIN` to your domain and `INBOXES_ENABLED` to `"true"`.
     Set `INBOX_TELEMETRY_ENABLED` and `BROWSER_ARRIVALS_ENABLED` to `"false"`:
     both report to BayLeaf's collector, which will not accept your data. Override
     any limit from the `DESIGN.md` table here (for example `RETENTION_SECONDS`).
   - Keep `observability` disabled unless you accept platform logs that may contain
     addresses, headers or bodies.

3. **Schema.** Apply the migrations to the remote database:

   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```

4. **DNS and TLS.** Add a proxied record for the apex and a proxied wildcard `*`
   record (the target is irrelevant because the Worker route answers, for example
   `AAAA 100::`). Cloudflare's Universal SSL covers the apex and one wildcard level,
   which is all the code uses; do not issue per-host certificates, which would publish
   every inbox hostname in Certificate Transparency logs.

5. **Deploy** with `npx wrangler deploy`. The apex page is BayLeaf-branded and links to
   BayLeaf's diagnostics; replace `publicDiagnosticPage` if that matters to you.
   Receiving hosts are unaffected.

6. **Email (optional).** In the dashboard, enable Email Routing on the domain. It adds
   and locks its own MX, SPF and DKIM records; keep them. Add one catch-all rule with
   the action *Send to a Worker* and your Worker. The Worker rejects unknown
   recipients itself. It never sends, forwards or replies, so also publish
   `_dmarc TXT "v=DMARC1; p=reject"` to discourage spoofing of your domain. For an
   HTTP-only deployment without Email Routing, a null-sender policy is
   `TXT "v=spf1 -all"` at the apex plus the same DMARC record. When Email Routing
   is enabled, keep its required SPF record alongside DMARC; do not replace it
   with `-all` or publish a second SPF record.

## A minimal owner API

The RPC trusts its first argument as the owner, so only Workers you control may be
bound to it. This single-owner facade relays `POST /{method}` with a JSON array of
the remaining arguments, and keeps downloads inert. It was exercised locally against
the real Worker in Miniflare; adapt it before giving it to anyone else.

```js
// owner-api.js: a single-owner HTTP facade over the InboxManagement RPC.
// POST /{method} with a JSON array of the arguments after `owner`.
const OWNER = 'self-hosted-owner-1'; // any /^[A-Za-z0-9-]{16,128}$/ string, fixed
const METHODS = new Set(['createInbox', 'listInboxes', 'getInbox', 'destroyInbox', 'listMessages',
  'getMessage', 'getMessageText', 'getMessageBody', 'getAttachment', 'setArchived', 'deleteMessage',
  'createCredential', 'listCredentials', 'revokeCredential', 'exportInbox', 'getMessageHar']);
const digest = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

export default {
  async fetch(request, env) {
    const given = await digest(request.headers.get('Authorization') ?? '');
    if (!crypto.subtle.timingSafeEqual(given, await digest(`Bearer ${env.OWNER_TOKEN}`)))
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    const method = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || !METHODS.has(method)) return Response.json({ error: 'not_found' }, { status: 404 });
    const args = await request.json().catch(() => null);
    if (!Array.isArray(args)) return Response.json({ error: 'invalid' }, { status: 400 });
    const result = await env.INBOXES[method](OWNER, ...args);
    if (!(result instanceof Response)) return Response.json(result, { status: result?.error ? 400 : 200 });
    // Stored bytes are sender-controlled: always an inert download.
    const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' });
    const next = result.headers.get('X-Inbox-Export-Next-Cursor');
    if (next) headers.set('X-Inbox-Export-Next-Cursor', next);
    return new Response(result.body, { headers });
  },
};
```

Its `wrangler.jsonc` needs `"services": [{ "binding": "INBOXES", "service": "<your
inbox Worker name>", "entrypoint": "InboxManagement" }]` and a route or custom domain
of its own, outside the inbox domain. Set the token with
`npx wrangler secret put OWNER_TOKEN`. Then, for example:

```bash
curl -sS https://owner.example.org/createInbox -H "Authorization: Bearer $OWNER_TOKEN" \
  -d '[{"type":"http"}]'
curl -sS https://owner.example.org/exportInbox -H "Authorization: Bearer $OWNER_TOKEN" \
  -d '["ibx_...", {}]' -D headers.txt -o page-1.tar
```

## Leaving BayLeaf: addresses and exports

**Addresses cannot move.** `*.bayleaf-inboxes.dev` hostnames and
`@bayleaf-inboxes.dev` addresses belong to BayLeaf's domain and are never reassigned
or redirected. Moving means creating new inboxes on your deployment and updating
every sender (webhook settings, forms, mailing-list subscriptions) to the new URL or
address, then destroying the BayLeaf inbox once nothing arrives there. Use a domain
you control to avoid repeating this later.

**Export first.** `GET https://api.bayleaf.dev/inboxes/{id}/export` (operation
`exportInbox`) returns one tar page of exact payloads plus a manifest; repeat with
`?cursor=` from the `X-Inbox-Export-Next-Cursor` header until it is absent. The
format is in `DESIGN.md`, "Portable export". Check each payload against the
manifest's `sha256`. Each page has exactly one `manifests/{first_id}.json`
(or `manifests/empty.json` for an empty selection), containing the entire page's
`receipts` array, not one manifest per receipt. Discover that member instead of
assuming `manifest.json`; validate each entry's `file`, byte `size` and lowercase
hex `sha256`. The manifest's `next_cursor` equals the response header, or is null
on the final page. See the [focused guide](https://api.bayleaf.dev/docs/inboxes.md)
for the version-1 fields and example tar layout.

HTTP pages also contain `receipts.har`, a HAR reconstruction. Extract pages into separate directories so
their HAR files do not overwrite each other. Large or binary request bodies are
referenced as custom `_file` paths to the exact `.body` files. Standard import tools
are not assumed to resolve them: attach files manually or write an adapter.
`getMessageHar` renders a single HTTP receipt. This is not
a wire capture: the HTTP version and timings are unknown, stored headers are
normalized and redacted, and no observed response is available. Status 0 and
durations -1 mean unknown; `_expectedAcknowledgement` describes configured success
only, with no body for HEAD. These durations violate HAR 1.2's nonnegative
send/wait/receive and total-sum requirements; they are BayLeaf conventions, not
standard unknown sentinels. Status 0, HTTP version "unknown" and uncaptured content
size 0 are likewise BayLeaf placeholders. Underscore extensions do not make these
representations conformant.
The legacy `insomnia-importers@3.6.0` library preserves inline text but imports
custom `_file` references as empty bodies. Current GUI interoperability with
devtools, Postman and Insomnia remains unqualified. The named nonstandard profile
is `log._profile:"bayleaf-inbox-receipt-1"`; exact bytes and the manifest are canonical.

**There is no import operation.** Two honest options:

- *Replay* receipts to the new deployment. For http, send each `.body` with the
  manifest's method, path, query and kept headers (redacted values such as
  `authorization` are gone; use your new credential). For email, resubmitting a
  `.eml` through SMTP adds new `Received` headers and a new envelope. Either way the
  new copies get new receipt times and a fresh retention period, and the BayLeaf
  originals keep their own expiry.
- *Load* directly into your D1/R2 with a script of your own: put each payload at
  `m/{inbox_id}/{message_id}` and insert a `messages` row (`state='stored'`, the
  manifest's `received_at`, `size`, `archived` and `meta` as `meta_json`, an
  `expires_at` of your choosing), incrementing the inbox's `bytes_stored` and
  `message_count` in the same batch. `search_text` is derived at reception, so
  search will not find loaded receipts unless your script fills it. BayLeaf has not
  written or tested such a loader.

Exported files are sender-controlled content. Once exported, their retention and
access are your responsibility, not BayLeaf's.
