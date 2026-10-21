# Inboxes research

Local research for #97. Production now shares `../src/dkim-verifier.mjs` through
the guarded `../scripts/build-dkim.mjs` build. The research fetch endpoint is not
in the production bundle. Integration is deployed with restricted creation disabled;
see `../OPERATIONS.md` for rollout gates and `../QUALIFICATION.md` for evidence.

## DKIM verification (see `DKIM.md`)

**Result: qualified locally with a scoped build-time shim.** The earlier mailauth
proof of concept failed valid RSA DKIM on pinned workerd with
`Unknown digest: rsa-sha256`. Root cause: mailauth passes the DKIM `a=` tag as a
`node:crypto` digest name; Node resolves it case-insensitively, workerd's BoringSSL
lookup uses `strcmp`. `../scripts/crypto-shim.mjs` translates exactly that name for mailauth's
verifier. A separate narrow selector-grammar patch permits underscores while
keeping strict validation elsewhere. The policy passes a 54-case matrix and
matches Node on every signature in a 15-message public corpus (14 signed, some
rejected by policy) with live DNS. Exact domain alignment and RSA >=2048 remain
required; optional per-domain selector pins restrict the same passing signature.

| File | Purpose |
|---|---|
| `DKIM.md` | Root cause, option comparison, results, proposed trust boundary, open questions |
| `UPSTREAM-ISSUES.md` | Local-only mailauth and workerd issue drafts for review |
| `verifier.mjs` | Test-only `fetch`, re-exporting shared `../src/dkim-verifier.mjs` |
| `../scripts/crypto-shim.mjs` | The one-name digest translation |
| `build.mjs` | Re-exports shared `../scripts/build-dkim.mjs` with guarded crypto and selector fixes |
| `dkim.test.mjs` | Node vs workerd matrix plus an unshimmed tripwire (`npm test`) |
| `crypto-probe.mjs` | workerd `node:crypto` and WebCrypto name/key probe (`npm run probe`) |
| `real-world.mjs` | Live-DNS check of raw `.eml` files kept outside the repo |

Run `npm ci --ignore-scripts` here and in `..` first. Dependencies pin mailauth
8.0.1; the parent supplies esbuild 0.28.1 and Miniflare 5.20260811.1-alpha
(workerd 2026-08-11). Node host tested: 26.12.0.

DKIM authenticates a signing domain's authorization, not the human mailbox
holder, and does not prevent replay. No DMARC/SPF/ARC or campus account policy is
established here.
