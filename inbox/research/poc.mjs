import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { build } from '../node_modules/esbuild/lib/main.js';
import { Miniflare, convertV4MiniflareOptions } from '../node_modules/miniflare/dist/src/index.js';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import { verify } from './verifier.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'der' }
});
const key = `v=DKIM1; k=rsa; p=${publicKey.toString('base64')}`;
const plain = 'From: Adam <amsmith@ucsc.edu>\r\nTo: test@example.net\r\nSubject: Synthetic research fixture\r\nDate: Tue, 20 Oct 2026 12:00:00 +0000\r\n\r\nOriginal body.\r\n';
async function signed(raw = plain, extra = {}, options = {}) {
  const result = await dkimSign(raw, {
    signatureData: [{ signingDomain: 'ucsc.edu', selector: 'poc', privateKey, ...extra }],
    ...options
  });
  assert.equal(result.errors.length, 0);
  assert.ok(result.signatures);
  return result.signatures + raw;
}
const valid = await signed();
const limited = await signed(plain, { maxBodyLength: 4 });
// The signer correctly refuses h= without From. Mutate that tag to exercise
// the verifier's explicit pre-crypto rejection (not a valid crypto fixture).
const unsignedFrom = valid.replace(/: From;/i, ': Xrom;');
assert.notEqual(unsignedFrom, valid);
const tests = [
  ['valid', valid, true],
  ['wrong-domain', await signed(plain, { signingDomain: 'other.example' }), false],
  ['tampered-body', valid.replace('Original body.', 'Tampered body.'), false],
  ['duplicate-From', 'From: attacker@example.net\r\n' + valid, false],
  ['unsigned-From', unsignedFrom, false],
  ['partial-body', limited + 'Unsigned append.\r\n', false],
  ['DNS-failure', valid, false, { dnsFailure: true }],
  ['DNS-timeout', valid, false, { dnsHang: true }],
  ['no-signature', plain, false],
  ['multiple-mailboxes', await signed(plain.replace('Adam <amsmith@ucsc.edu>', 'amsmith@ucsc.edu, other@ucsc.edu')), false],
  ['malformed-From', await signed(plain.replace('Adam <amsmith@ucsc.edu>', 'amsmith@ucsc.edu garbage')), false],
  ['length-limit-even-full', await signed(plain, { maxBodyLength: 9999 }), false]
];
await build({ entryPoints: [new URL('./verifier.mjs', import.meta.url).pathname],
  outfile: new URL('./bundle.mjs', import.meta.url).pathname,
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', minify: true,
  external: ['node:*'], metafile: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/bundle.mjs');" } });
const bundle = await readFile(new URL('./bundle.mjs', import.meta.url));
console.log(JSON.stringify({ bundleBytes: bundle.length, gzipBytes: gzipSync(bundle).length }));
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.toString(),
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'] }));
try {
  for (const [name, raw, expected, flags] of tests) {
    const baseline = await verify(raw, async () => {
      if (flags?.dnsHang) return new Promise(() => {});
      if (flags?.dnsFailure) throw Object.assign(new Error('mock DNS unavailable'), { code: 'ETIMEOUT' });
      return [[key]];
    });
    assert.equal(baseline.accepted, expected, `Node baseline: ${name}`);
    const response = await mf.dispatchFetch('http://research.test', {
      method: 'POST', body: JSON.stringify({ raw, key, ...flags })
    });
    const verdict = await response.json();
    console.log(JSON.stringify({ name, nodeAccepted: baseline.accepted, accepted: verdict.accepted, reason: verdict.reason,
      error: verdict.error, fromFields: verdict.result?.fromFields,
      fromSyntax: verdict.result?.fromSyntax, queries: verdict.queries,
      signatures: verdict.result?.results.map(r => ({ domain: r.signingDomain,
        status: r.status, limited: r.canonBodyLengthLimited,
        hashed: r.canonBodyLength, total: r.canonBodyLengthTotal })) }));
    // Characterize the incompatibility honestly: valid mail is rejected too.
    assert.equal(verdict.accepted, false, name);
  }
  console.log('UNSUPPORTED: Node baseline passes all cases, workerd rejects valid RSA DKIM (Unknown digest: rsa-sha256).');
} finally { await mf.dispose(); }
