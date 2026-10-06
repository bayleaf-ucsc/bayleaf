# BayLeaf Sandboxes public home

`sandbox.bayleaf.dev` is the public service home for **BayLeaf Sandboxes**.
Use singular “your sandbox” for an individual workspace. The hostname stays
singular. The current Worker is a static coming-soon teaser with no JavaScript,
cookies, authentication, inference, storage, or compute operations.

`worker.js` owns the page; `wrangler.jsonc` pins the BayLeaf account and domain.
Deploy from the repository root with:

```sh
./api/node_modules/.bin/wrangler deploy --config sandbox/wrangler.jsonc
```

The CTA links to the existing API dashboard. Future authenticated management
reuses the API's authentication authority and lifecycle state; the cross-origin
session mechanism is not implemented. The intended dashboard can share the
existing `bayleaf-keys` D1 database and access existing lifecycle services through
explicit bindings/interfaces; the static teaser needs no data bindings yet.
See issue #84. Do not broaden cookie
scope or introduce an independent OAuth application incidentally.

Verify the public page at desktop/mobile sizes and its links after changes.
The landing-page ACR does not cover this separate surface. Deploy first, commit
only when requested, following the root AGENTS.md.

Initial deployment: `6dd3b8bb-d9f0-4ac0-b33b-23b9bf7ed677` (2026-10-05).
Live GET/HEAD and desktop/mobile rendering verified. The domain's injected
Cloudflare analytics script is blocked by this page's no-script CSP.
