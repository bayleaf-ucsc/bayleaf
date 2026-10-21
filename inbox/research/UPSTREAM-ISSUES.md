# Local upstream issue drafts (not published)

Prepared for Adam's review. No issue creation or other remote mutation occurred.

## mailauth: use digest name rather than DKIM algorithm name in RSA verify

**Title:** RSA DKIM fails in workerd: `crypto.verify('rsa-sha256')` throws `Unknown digest`

mailauth 8.0.1 verifies a valid RSA-SHA256 message in Node 26.12.0, but reports
`neutral (Unknown digest: rsa-sha256)` in workerd 1.20260811.1 with compatibility
date 2026-08-01 and `nodejs_compat` (Miniflare 5.20260811.1-alpha).

`dist/esm/dkim/dkim-verifier.js` calls:

```js
crypto.verify(signatureHeader.signAlgo === 'rsa' ? signatureHeader.algorithm : null, ...)
```

`signatureHeader.algorithm` is the DKIM `a=` tag, `rsa-sha256`. Node's OpenSSL
accepts this as a case-insensitive alias of `RSA-SHA256`. workerd's BoringSSL
digest lookup uses exact name comparisons: `RSA-SHA256`, `SHA256`, and `sha256`
verify successfully, but `rsa-sha256` throws. Ed25519 (`null` digest) works.

Would you accept using `signatureHeader.hashAlgo` (`sha256`) for the RSA branch?
Keep the existing algorithm allowlisting, key-type checks and strict-mode SHA-1
rejection. The signer also passes `algorithm` to `crypto.sign`, so the equivalent
change there would merit testing separately.

Our importer-scoped local shim translates only `rsa-sha256` to `sha256`, leaving
the rest of mailauth unchanged for crypto. Synthetic RSA/Ed25519, tampered bodies
and headers, multiple signatures and live-DNS archived messages agree with Node.
A standalone reproducer below isolates the underlying runtime difference.

**Separate selector compatibility question:** strict `SELECTOR` uses hostname
label syntax and rejects live SUSE `susede2_ed25519` signatures. Literal RFC 6376
§3.1 imports RFC 5321's underscore-free `sub-domain`, but underscore selectors
are deployed in practice and legal as DNS labels. Would a narrowly scoped
selector-compatibility option be acceptable, without loosening `d=` or other
strict checks? This is a distinct interoperability request, not a claim that
the literal RFC grammar already permits underscores.

## workerd: Node digest aliases have a case-sensitive compatibility gap

**Title:** `node:crypto.verify` rejects lowercase `rsa-sha256` accepted by Node

Tested: workerd 1.20260811.1, Miniflare 5.20260811.1-alpha, compatibility date
2026-08-01, `nodejs_compat`. Same result with date 2026-08-18 and with
`nodejs_compat_v2` explicitly added. Node 26.12.0 accepts all three names below.
Latest workerd has not been executed for this report.

Minimal module Worker (no dependencies, all keys/messages synthetic):

```js
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';

export default {
  async fetch() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bytes = Buffer.from('synthetic DKIM header fixture');
    const signature = sign('sha256', bytes, privateKey);
    const results = {};
    for (const algorithm of ['rsa-sha256', 'RSA-SHA256', 'sha256']) {
      try { results[algorithm] = verify(algorithm, bytes, publicKey, signature); }
      catch (e) { results[algorithm] = e.message; }
    }
    return Response.json(results);
  }
};
```

Expected (Node): all `true`. Observed (workerd):

```json
{"rsa-sha256":"Unknown digest: rsa-sha256","RSA-SHA256":true,"sha256":true}
```

`createVerify('rsa-sha256')` fails similarly. This breaks mailauth 8.0.1 RSA DKIM
verification, which passes the algorithm identifier from `a=` to `crypto.verify`.
Ed25519 via `verify(null, ...)` is unaffected.

Likely cause: `src/workerd/api/node/crypto.c++` passes the name unchanged through
`ncrypto::getDigestByName` to BoringSSL `EVP_get_digestbyname`, which compares
short/long names with `strcmp`. Could workerd support Node's case-insensitive
digest alias behavior for `verify`, `createVerify` and corresponding signing
APIs? A local library workaround is to use the digest name `sha256` instead.
