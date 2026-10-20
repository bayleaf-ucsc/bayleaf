# Browser-arrival network classification: local qualification

2026-10-20. Explicit operator approval covers the coarse browser-arrival network
dimension. This record establishes local behavior, **not production activation**.
No remote migration, deployment, commit or push was performed in this scoped run.

## Contract and source of truth

- Browser JSON remains schema 1: destination and referring hostname only.
  The strict validator rejects a supplied `network_location` or address field.
- Collector enrichment runs only for accepted `/v1/browser` payloads and reads
  only Cloudflare's `CF-Connecting-IP`. Missing/invalid addresses become
  `unknown`; valid addresses become `campus-network` or `other-network`.
  Neither `X-Forwarded-For` nor `Forwarded` is consulted. The public collector
  must remain behind Cloudflare's edge, not an untrusted header-preserving proxy.
- Stored browser rows use schema 2 / policy 3. Private browser read envelopes
  advertise these versions; historical rows retain schema 1 / policy 2.
  Service records/read envelopes retain their existing versions and never gain
  this dimension, including synthetic browser probe summaries.
- The API matcher was extracted into `api/src/utils/ipRanges.js`, with strict
  whole-address parsing replacing permissive `parseInt` parsing. Valid explicit
  IPv4/IPv6 CIDR configurations remain supported. `@ucsc` resolves the canonical
  list in `api/src/utils/campus-networks.json`; unknown aliases fail closed.
  The repository API Wrangler setting now uses `@ucsc`. The already deployed API
  still uses its equivalent explicit list until its next ordinary deployment;
  no API production deployment is needed for collector rollout.
- No IP, hash, prefix, raw forwarding headers or stable visitor identifier is
  passed to storage or application logging. Only the three-valued enum persists.
  Existing platform connection-metadata visibility is not removed by this change.
- Network location is not campus affiliation: campus visitors and VPN egress
  can classify as campus-network; campus members accessing off campus may not.

## Evidence

`node --test test/network.test.js` covers:

- First/last included addresses and adjacent excluded addresses for all four
  campus IPv4 ranges and the campus IPv6 /32; IPv6 case, compression and embedded
  IPv4, custom /0, /32 and /128 boundaries, and alias/list equivalence.
- Missing, malformed, partial, zoned, bracketed, overlong, multiply compressed,
  trailing-junk, port-suffixed and comma-separated addresses; unknown aliases.
- Spoofed forwarding headers cannot override or replace the trusted header.
- Actual collector ingestion and authenticated readback with real SQLite,
  browser-only enrichment, client-category rejection and content-free responses.
- Existing-row migration yields unknown, preserving version and expiry; the SQL
  constraint rejects non-enum data. No service table has this dimension.
- Ninety-day expiry excludes records before purge, then physical purge removes
  them. No retention ceiling/cutoff or observation timestamp is reset.
- Bundled collector in actual workerd/D1 admits and privately reads the enum.
  All fixture addresses and credentials are synthetic; outbound calls are blocked.

Local integration checks: telemetry `npm test` passes (61 tests, including the
concurrent signed-out Chat collector test); API
`npm run test:campus-pass` passes; API `npx --no-install tsc --noEmit` passes.
Re-run after integration with the concurrent signed-out Chat arrival changes.

## Operator integration / production order

1. Review the exact privacy and implementation diff, including the API matcher
   extraction. Publication and affected-user notices remain operator gates.
2. Apply **only collector migration `0003_browser_network.sql`** to the existing
   telemetry database before deploying the collector. It adds one constrained
   column with default unknown, does not rebuild tables, and changes no retention
   metadata. Do not retroactively infer categories for historical observations.
3. Deploy the collector revision with existing observability disabled, the same
   retention bindings, and the unchanged browser client payload. No source
   bundle rebuild, secret, new binding or API deployment is required for this
   dimension. Signed-out Chat rollout is a separate source activation.
4. Privately verify new browser rows have schema 2 / policy 3 and the expected
   category for the testing network, while old rows remain unknown and service
   rows have no category. Do not log or export test connection addresses.
5. For rollback, an older collector can coexist with the additive column:
   its browser inserts take the unknown default. Leave the column/migration in
   place; preserve all retention rules and purge scheduling.
