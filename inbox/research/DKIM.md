# DKIM verification inside a Cloudflare Worker (research, #97)

**Result: local verifier qualification, not production readiness.** mailauth 8.0.1's DKIM verifier works on the pinned
workerd (`1.20260811.1`, compatibility date `2026-08-01`, `nodejs_compat`) once a
digest-name translation and a narrow selector-grammar extension are applied at
build time. The research policy passes a 54-case matrix and matches Node on a
15-message public corpus (14 signed), with live DNS. Not every message is accepted:
the corpus includes policy rejections. A later local integration wires this shared
verifier into `src/worker.js` for creation-only opt-in restrictions, gated off by
default. See `../qualification/DKIM-INTEGRATION.md`. No deploy, no mail sent,
no user mail read in this worktree.

```bash
npm ci --ignore-scripts   # here and in ../ (esbuild, miniflare)
npm test                  # matrix: Node baseline and real workerd, plus tripwire
npm run probe             # root-cause probe of workerd node:crypto
node real-world.mjs [--lenient] /path/outside/repo/*.eml   # live DNS, untrusted files
```

## Root cause

mailauth calls `crypto.verify(signatureHeader.algorithm, ...)`, passing the DKIM
`a=` tag (`rsa-sha256`) as a digest name. Node's OpenSSL looks digest names up
case-insensitively, so it finds the alias `RSA-SHA256`. workerd's `node:crypto`
(`src/workerd/api/node/crypto.c++`, `maybeGetDigest` and `VerifyHandle`) calls
`ncrypto::getDigestByName`, which calls BoringSSL `EVP_get_digestbyname`; that
compares with `strcmp`. `crypto-probe.mjs` shows the whole surface in workerd:

| Call | workerd 2026-08-11 |
|---|---|
| `verify('rsa-sha256')`, `createVerify('rsa-sha256')` | throws `Unknown digest` |
| `verify('RSA-SHA256' / 'sha256' / 'SHA256')` | correct |
| `verify('SHA-256')` | throws (WebCrypto spelling, also not an OpenSSL name) |
| `createPublicKey` SPKI and PKCS#1 RSA, raw Ed25519 SPKI | correct |
| `verify(null, ..., ed25519)` | correct (why Ed25519 never hit the bug) |
| `crypto.subtle` RSASSA-PKCS1-v1_5 and Ed25519 | correct |

Neither a date change to 2026-08-18 nor adding `nodejs_compat_v2` fixed it in
the pinned runtime. The pinned toolchain accepts dates only through 2026-08-18
(identical result), and upstream workerd `main` and ncrypto `main` (checked
2026-10-21, latest release `v1.20261021.1`) still use the same `strcmp` path. This
is source inspection, not an execution test of the latest release; the issue
search was not exhaustive.

## Options compared

| Option | Verdict |
|---|---|
| **(a) Shim mailauth's one `crypto.verify` call** | **Recommended.** `../scripts/crypto-shim.mjs` maps exactly `rsa-sha256` to `sha256` and is substituted by an esbuild plugin for one importer (`dkim-verifier.js`). The build fails unless it fires exactly once. Canonicalization, tag/key parsing and DKIM validation stay in maintained upstream code; application acceptance policy is local. |
| (a') Swap that call to WebCrypto | Unnecessary: node:crypto works once the name resolves, and WebCrypto is async, which would mean editing vendor control flow instead of one argument. |
| (b) Another maintained library | This limited npm search did not identify a better-qualified alternative. Examined results included a Python wrapper, Haraka plugins, nodemailer signing helpers, and ZK-email helpers (circuit-oriented, last release 2025-02). This is not exhaustive evidence that no other maintained verifier exists. mailauth (Postal Systems, released 2026-10-19) remains our evaluated candidate. |
| (c) Own verifier on mailauth canonicalization | Rejected. Signature checking is the easy part; the risk lives in tag parsing, header selection, `l=`, key-record parsing and alignment, which we would then own. |
| Upstream fix | Ideal end state: mailauth passing `hashAlgo` (`sha256`) instead of `algorithm` works on both Node and workerd. The signer has the same pattern. Not filed (outward-facing, Adam's call). `dkim.test.mjs` has a tripwire that fails when the unshimmed bundle starts passing, so we notice when the shim can go. |

`../scripts/build-dkim.mjs` also patches only mailauth's selector regex, preserving strict mode
and the separate `d=` hostname grammar. It permits underscores at any position
in selector labels, dot-separated labels, max 63 bytes per label, no empty labels
or leading/trailing hyphens. Literal RFC 6376 §3.1 imports RFC 5321 `sub-domain`,
which excludes underscores. This is a deliberate interoperability extension for
real DNS selector names, not a claim that the literal ABNF permits underscores.
Both patches are guarded against upstream source drift. Native Node comparison
uses the same selector patch but not the crypto shim.

Supply-chain cost includes mailauth and maintaining both patches: the deep import still bundles
Joi, tldts, libmime, nodemailer's addressparser and ARC helpers. The shared production
verifier bundle is 1,207,614 bytes minified, 422,888 gzip; the complete Worker
dry-run is recorded in `../qualification/DKIM-INTEGRATION.md`. mailauth joins
postal-mime as a pinned runtime dependency.
Startup CPU on Cloudflare is unmeasured. Pin exact versions and rerun this suite on
every bump; a refactor that moves the call trips the build guard.

## Synthetic matrix (`dkim.test.mjs`, 54/54 pass)

Every case runs in Node with native mailauth and in real workerd with the shimmed
bundle; per-signature results must match exactly. Keys are generated per run; DNS
is an injected resolver (one RR split into two strings, as real DNS does).

| Expect trusted | Cases |
|---|---|
| yes | RSA-SHA256; Ed25519-SHA256; unsigned header added (`X-Injected`, see risks); aligned + ESP signature; failing wrong-key signature then valid aligned one; replay of identical bytes |
| no, crypto | body tampered; body appended; signed Subject changed; signed From local part changed; aligned signature corrupted while ESP signature is valid |
| no, `l=` | partial `l=` with appended text; `l=` covering the whole body (rejected anyway) |
| no, key/DNS | NXDOMAIN; revoked `p=`; SERVFAIL; hang (1.5 s bounded timeout); two TXT records; 1024-bit key; `t=y` testing key; Ed25519 signature with RSA key; rsa-sha1; expired `x=`; future `t=` |
| no, alignment/allowlist | aligned but not allowlisted; `d=attacker` with `From` at ucsc.edu; `d=ucsc.edu` with `From` elsewhere; `d=mail.ucsc.edu` with `From` at ucsc.edu |
| no, From/structure | second From prepended; two mailboxes; malformed From; no signature; copied `Authentication-Results: dkim=pass` with no signature; five signatures; empty allowlist |
| tripwire | unshimmed bundle still yields `Unknown digest: rsa-sha256` for RSA and passes Ed25519 |
| selector compatibility | four valid underscore selectors (internal, leading, trailing and dotted labels); five malformed/overlong selectors rejected before DNS |
| optional per-domain selector pin | match, case normalization, mismatch, empty deny set, unrelated domain, cannot bypass alignment or allowlist, any passing pinned signature, failing pinned signature cannot borrow another signature's success |

Mutation check: removing the From-domain equality, `l=` rejection, `t=y`
rejection or the signature-time check each fails exactly the case meant to catch
it. Removing `fromFields !== 1` fails nothing because `headerFrom.length !== 1`
also catches duplicates; both stay as defense in depth.

## Real-world messages (independent signers, live DNS)

15 raw messages from the public `inbox.sourceware.org/gcc-patches` archive
(fetched 2026-10-21, kept outside the repo, not committed). Node used `node:dns`;
workerd used bounded DoH (`dohResolver`, `cloudflare-dns.com`). Allowlist set to
each message's own From domain. **workerd matched Node on all 15, per signature.**
After the selector extension, a full rerun accepted 11 and rejected four (unsigned,
two weak-key messages, and non-exact IBM alignment). This demonstrates verifier
behavior, not SMTP integration or a worst-case CPU/memory qualification.

| Signer (d= / selector) | Messages | Strict verdict | Reason |
|---|---|---|---|
| gmail.com / 20251104 | 2 | trusted | |
| Nvidia.com / selector2 (Microsoft 365) | 2 | trusted | mixed-case `d=` handled |
| qualcomm.com + oss.qualcomm.com / google (Google Workspace) | 6 | trusted | 8bit `format=flowed` bodies included |
| ibm.com / pp1, From linux.ibm.com | 1 | rejected | pass, but subdomain alignment is relaxed, not exact |
| redhat.com / mimecast20190719 | 2 | rejected | 1024-bit key under our 2048 floor |
| suse.de / susede2_rsa + susede2_ed25519 | 1 | trusted with selector extension | Ed25519 passes; 1024-bit RSA signatures rejected |
| unsigned | 1 | rejected | |

Before the selector patch, strict mode rejected SUSE while `--lenient` passed.
The narrow patch now permits its real Ed25519 signature without globally relaxing
strict validation. A first harness version decoded 8bit mail as latin1 and
re-encoded UTF-8, failing 6 bodies in both runtimes; the harness now passes bytes.

## Trusted-result boundary (implemented locally, not deployed)

`../src/dkim-verifier.mjs` `authenticate(raw, { resolver, allowedDomains, selectorPins })` returns
`{ trusted: true, domain, selector, algo, from }` only when all of these hold:

- exactly one From field with exactly one syntactically valid mailbox;
- some signature has `status.result === 'pass'` in mailauth strict mode
  (`rejectRsaSha1`, `minBitLength: 2048`), algorithm `rsa-sha256` or
  `ed25519-sha256`, valid `t=`/`x=`, From in `h=`, no `l=`, key not `t=y`;
- that signature's `d=` (lowercased) **equals** the From domain **and** is on the
  inbox owner's allowlist.

Optional `selectorPins: { 'ucsc.edu': ['workspace_selector'] }` additionally
requires that the **same passing signature** use one of that domain's selectors.
Omission means no selector restriction; an empty list denies all. Comparison is
DNS case-insensitive. A pin does not establish a human identity or pin key
material, and requires an explicit rotation procedure. Exact alignment and the
2048-bit RSA floor are approved policy, not open choices.

Anything else is `trusted: false` with a reason code. The production-facing
`verifyEmailDomain` wrapper fixes strict mode and the DoH resolver and returns
only pass/domain/selector/algorithm (or failure/transience), never full signature
diagnostics. Restricted `worker.js` reception checks it before MIME parsing or
reservation and stores only that small `dkim_auth` proof, distinct from the
verbatim `authentication_results` sender text. Allowlist entries are domains, never
addresses: a From-header match is not authentication, and DKIM says nothing about
local parts. Restricted production reception deliberately uses a hard 1 MiB cap
(25 MiB DKIM verification remains unqualified), 32 KiB headers, 200 header lines, four
signatures, four DNS queries, 1.5 s abortable DoH, one TXT record of at most 8 KiB.

## Residual risks

- **Domain, not person.** A pass establishes a signature under a key published
  for `d=` and `s=`, not proof of a mailbox holder. Public DNS showed
  `s1._domainkey.ucsc.edu` CNAME delegation into SendGrid. That proves key-lookup
  delegation, not that every campus integration can sign arbitrary identities:
  SendGrid account provisioning, sender restrictions and campus controls are
  unknown to us. Domain allowlisting accepts authorized delegated signers unless
  a selector pin excludes them. UCSC's observed DMARC `pct=0` concerns requested
  receiver enforcement, not the validity or strength of DKIM verification.
- **Replay.** A valid signed message can be re-sent to any inbox address, forever
  until key rotation; DKIM does not bind the envelope recipient. Only `x=` (rarely
  set) limits it. Message-ID dedup would be a heuristic, not a fix.
- **Unsigned headers stay mutable**, and the agent sees them. Adapters must
  present only signed fields as authenticated, or none.
- **DNS trust.** DoH answers are not DNSSEC-validated by us; we trust Cloudflare's
  resolver and the domain's DNS.
- **Shim drift.** Guarded by the build check and tripwire, not eliminated.
- **Forwarders and lists** that rewrite bodies or subjects break signatures;
  ARC is ignored, so such mail fails closed.

## Remaining questions

Approved: exact alignment, RSA >=2048, interoperable underscore selectors,
optional selector pins, explicit delegated-signer caveat. Local upstream issue
drafts are in `UPSTREAM-ISSUES.md`; nothing has been published.

1. Which selectors should an owner pin, and how will their rollover be handled?
2. Which UCSC Workspace selector signs normal campus mail? Public DNS alone does
   not reveal it; a header from a message Adam chooses to share would.
