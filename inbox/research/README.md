# DKIM-only workerd compatibility research

**Result: unsupported unmodified on the pinned local runtime.** No production
files changed, deployment, messages sent, or user mail accessed.

Run `npm ci --ignore-scripts && npm test` here (uses existing parent esbuild
0.28.1 and Miniflare 5.20260811.1-alpha). Dependencies pin mailauth 8.0.1.
The test intentionally succeeds when it reproduces the incompatibility; it is
not an acceptance qualification. Node host tested: 26.12.0. workerd uses
compatibility date 2026-08-01 and `nodejs_compat`.

## Evidence

Synthetic 2048-bit RSA messages use Node key generation and mailauth signing,
with no custom canonicalization or cryptographic implementation. The Node
baseline accepts exactly one valid `From: amsmith@ucsc.edu`, signed by `ucsc.edu`.
Eleven negative fixtures reject: wrong domain, body tampering, duplicate From,
unsigned From, partial-body `l=`, DNS error, DNS hang, absent signature, multiple
mailboxes, malformed From, and `l=` covering the entire body. The unsigned-From
fixture mutates `h=`: mailauth's signer correctly refuses creating such a
signature. It tests explicit pre-crypto rejection, not a valid crypto signature.

Real workerd runs all fixtures but **rejects the valid message too**:
`status.result="neutral"`, `status.comment="Unknown digest: rsa-sha256"`.
Mailauth passes that algorithm name to `node:crypto.verify`; the runtime does
not recognize it. Body hashing and mock DNS work. Rejections cannot establish
the intended authentication policy while positive verification is broken.

Bundling also requires a `node:module` createRequire banner for CommonJS
dependencies. `import.meta.url` is undefined in this harness, so the banner
uses an absolute synthetic filename. Minified bundle: 1,204,165
bytes, gzip 421,571 bytes.
Deep importing still pulls Joi, tldts, libmime and ARC helpers.

## Resolver and result contract

`dkimVerify(Buffer, {strict:true, minBitLength:2048, resolver})`, imported from
`mailauth/lib/dkim/verify`. Resolver is async `(name, "TXT") => string[][]`:
outer array is records, inner array is chunks concatenated into one record.
**Mailauth reads only record zero**, so our wrapper rejects zero/multiple
records. Errors become non-pass (normally `temperror` for timeout).

Acceptance must explicitly require `fromFields===1`, `fromSyntax==="valid"`,
one exact `headerFrom`, and a signature with `status.result==="pass"`, exact
`signingDomain`, allowed `algo`, `signatureTimeValid===true`, signed From in
`signingHeaders.keys`, `canonBodyLengthLimited===false`, and equal
`canonBodyLength`/`canonBodyLengthTotal`. `status.aligned` alone is relaxed
domain alignment, not our exact-domain rule. `status.underSized` diagnoses
partial signing; reject every `l=` even when fully covered.

Research bounds: 1 MiB mail, 32 KiB headers, 200 header lines, four signatures,
no ARC, four DNS calls, 250 ms per lookup, 8 KiB DNS TXT content, one TXT record.
Timeout races do not cancel underlying DNS. Production needs abortable bounded
DoH or independently qualified resolveTxt, plus stream-level limits.

## Remaining gates and security limits

Stop here rather than patch vendor crypto. A reviewed compatibility fix or
newer qualified runtime must first prove positive RSA verification. Then rerun
adversarial tests, multi-record DNS policy, realistic campus signatures,
memory/CPU benchmarks, SMTP rejection/retry behavior and full integration.
DKIM authenticates domain authorization, not the human mailbox holder. A domain
signer can authorize any local part. Replay remains possible; DKIM does not bind
the SMTP recipient, and unsigned headers remain mutable. No DMARC/SPF/ARC or
campus account policy is established by this proof of concept.
