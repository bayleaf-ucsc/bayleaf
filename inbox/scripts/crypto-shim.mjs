// Build-time replacement for mailauth's `import crypto from 'node:crypto'` in
// dkim-verifier.js only (see build-dkim.mjs).
//
// Root cause: mailauth passes the DKIM a= tag ("rsa-sha256") as the digest name to
// crypto.verify. Node's OpenSSL resolves digest names case-insensitively, so it
// finds the alias "RSA-SHA256". workerd's node:crypto calls BoringSSL
// EVP_get_digestbyname, which uses strcmp, so only "RSA-SHA256", "SHA256" and
// "sha256" resolve. Everything else in the verification path works unchanged.
import crypto from 'node:crypto';

// Only the one DKIM algorithm we accept. rsa-sha1 is left untranslated on purpose:
// it still throws in workerd, and mailauth's strict mode rejects it before crypto.
const DIGEST_FOR_DKIM_ALGORITHM = new Map([['rsa-sha256', 'sha256']]);

function verify(algorithm, data, key, signature, callback) {
  const digest = typeof algorithm === 'string'
    ? DIGEST_FOR_DKIM_ALGORITHM.get(algorithm.toLowerCase()) ?? algorithm
    : algorithm;
  return crypto.verify(digest, data, key, signature, callback);
}

export default new Proxy(crypto, {
  get: (target, name, receiver) => name === 'verify' ? verify : Reflect.get(target, name, receiver)
});
