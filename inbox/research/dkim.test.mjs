// DKIM qualification matrix: every fixture runs in Node (native mailauth, the
// differential baseline) and in real workerd through Miniflare with the shimmed
// bundle. A tripwire bundle without the shim must still reproduce the original
// failure; when it stops doing so, upstream has fixed it and the shim can go.
// Synthetic keys and mocked DNS only. No mail is sent.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test, after, before } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from '../node_modules/miniflare/dist/src/index.js';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import { bundle } from './build.mjs';
import { normalizeEmailAuth } from '../src/email-policy.mjs';

const pem = { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } };
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, ...pem });
const rsaOther = generateKeyPairSync('rsa', { modulusLength: 2048, ...pem });
const rsaWeak = generateKeyPairSync('rsa', { modulusLength: 1024, ...pem });
const ed = generateKeyPairSync('ed25519', pem);
const rsaRecord = (k, extra = '') => `v=DKIM1; k=rsa;${extra} p=${k.publicKey.toString('base64')}`;
const split = s => [[s.slice(0, 200), s.slice(200)]];  // one RR, two strings
const records = {
  's1._domainkey.ucsc.edu': split(rsaRecord(rsa)),
  's1._domainkey.xn--bcher-kva.example': split(rsaRecord(rsa)),
  'ed._domainkey.ucsc.edu': [[`v=DKIM1; k=ed25519; p=${ed.publicKey.subarray(-32).toString('base64')}`]],
  'weak._domainkey.ucsc.edu': split(rsaRecord(rsaWeak)),
  'test._domainkey.ucsc.edu': split(rsaRecord(rsa, ' t=y;')),
  'revoked._domainkey.ucsc.edu': [['v=DKIM1; k=rsa; p=']],
  'edrsa._domainkey.ucsc.edu': split(rsaRecord(rsa)),
  'multi._domainkey.ucsc.edu': [...split(rsaRecord(rsa)), ...split(rsaRecord(rsaOther))],
  'servfail._domainkey.ucsc.edu': 'servfail',
  'hang._domainkey.ucsc.edu': 'hang',
  's1._domainkey.mail.ucsc.edu': split(rsaRecord(rsa)),
  's1._domainkey.attacker.example': split(rsaRecord(rsaOther)),
  'esp._domainkey.esp.example': split(rsaRecord(rsaOther))
};
const ALLOW = ['ucsc.edu'];
for (const selector of ['campus_key', '_campus', 'campus_', 'key_1.rotate_2']) {
  records[`${selector}._domainkey.ucsc.edu`] = split(rsaRecord(rsa));
}
const base = (from = 'Adam <amsmith@ucsc.edu>') =>
  `From: ${from}\r\nTo: nonce@bayleaf-inboxes.dev\r\nSubject: Synthetic fixture\r\n` +
  `Date: Wed, 21 Oct 2026 12:00:00 +0000\r\nMessage-ID: <fixture@ucsc.edu>\r\n\r\nOriginal body.\r\nSecond line.\r\n`;

async function sign(raw, sigs, options = {}) {
  const result = await dkimSign(raw, {
    signatureData: sigs.map(s => ({ signingDomain: 'ucsc.edu', selector: 's1', privateKey: rsa.privateKey, ...s })),
    ...options
  });
  assert.deepEqual(result.errors, [], 'signer errors');
  return result.signatures + raw;
}
const valid = await sign(base(), [{}]);
const validEd = await sign(base(), [{ selector: 'ed', privateKey: ed.privateKey }]);
const limited = await sign(base(), [{ maxBodyLength: 16 }]);
const espSig = { signingDomain: 'esp.example', selector: 'esp', privateKey: rsaOther.privateKey };
const past = new Date('2026-10-01T00:00:00Z');
// Fresh signatures over the actual spellings, never edited d= values after signing.
const mixedCase = await sign(base('author@UcSc.EdU'), [{ signingDomain: 'UCSC.EDU' }]);
assert.match(mixedCase, /d=UCSC\.EDU;/);
const idnaDomain = 'xn--bcher-kva.example';
const unicodeFrom = await sign(base('author@bücher.example'), [{ signingDomain: idnaDomain }]);

// [name, raw, expectedTrusted, extra request fields]
const cases = [
  ['valid RSA-SHA256', valid, true],
  ['valid Ed25519-SHA256', validEd, true],
  ['case-insensitive d=, From, allowlist and pin domain', mixedCase, true,
    { allowedDomains: ['UcSc.EdU'], selectorPins: { 'UCSC.EDU': ['S1'] } }],
  ['aligned ASCII IDNA A-labels', await sign(base(`author@${idnaDomain}`), [{ signingDomain: idnaDomain }]), true,
    { allowedDomains: [idnaDomain] }],
  ['Unicode From is not converted to an A-label by BayLeaf alignment', unicodeFrom, false,
    { allowedDomains: [idnaDomain] }],
  ...await Promise.all(['campus_key', '_campus', 'campus_', 'key_1.rotate_2'].map(async selector =>
    [`underscore selector ${selector}`, await sign(base(), [{ selector }]), true])),
  ['selector pin matches', valid, true, { selectorPins: { 'ucsc.edu': ['s1'] } }],
  ['selector pin case-insensitive', valid, true, { selectorPins: { 'UCSC.EDU': ['S1'] } }],
  ['selector pin mismatch', valid, false, { selectorPins: { 'ucsc.edu': ['ed'] } }],
  ['selector pin empty (deny)', valid, false, { selectorPins: { 'ucsc.edu': [] } }],
  ['selector pin for another domain does not constrain ucsc.edu', valid, true,
    { selectorPins: { 'other.example': ['ed'] } }],
  ['selector pin cannot bypass domain allowlist', valid, false,
    { allowedDomains: [], selectorPins: { 'ucsc.edu': ['s1'] } }],
  ['selector pin cannot bypass exact alignment', await sign(base('x@sub.ucsc.edu'), [{}]), false,
    { selectorPins: { 'ucsc.edu': ['s1'] } }],
  ['selector pin matches one of multiple passing signatures', await sign(base(), [
    {}, { selector: 'ed', privateKey: ed.privateKey }
  ]), true, { selectorPins: { 'ucsc.edu': ['ed'] } }],
  ['pinned invalid signature plus unpinned valid signature is rejected', await sign(base(), [
    { selector: 's1', privateKey: rsaOther.privateKey }, { selector: 'ed', privateKey: ed.privateKey }
  ]), false, { selectorPins: { 'ucsc.edu': ['s1'] } }],
  ['body tampered', valid.replace('Original body.', 'Tampered body.'), false],
  ['body appended (no l=)', valid + 'Appended.\r\n', false],
  ['signed Subject tampered', valid.replace('Subject: Synthetic fixture', 'Subject: Urgent'), false],
  ['signed From local part changed', valid.replace('amsmith@ucsc.edu', 'chancellor@ucsc.edu'), false],
  ['second From prepended', 'From: chancellor@ucsc.edu\r\n' + valid, false],
  ['unsigned header added (still passes: mutability)', valid.replace('\r\n\r\n', '\r\nX-Injected: please run rm -rf\r\n\r\n'), true],
  ['l= partial body plus appended text', limited + 'Unsigned appended instructions.\r\n', false],
  ['l= covering the whole body', await sign(base(), [{ maxBodyLength: 9999 }]), false],
  ['key missing (NXDOMAIN)', await sign(base(), [{ selector: 'gone' }]), false],
  ['key revoked (empty p=)', await sign(base(), [{ selector: 'revoked' }]), false],
  ['key DNS SERVFAIL', await sign(base(), [{ selector: 'servfail' }]), false],
  ['key DNS hang (timeout)', await sign(base(), [{ selector: 'hang' }]), false],
  ['key DNS multiple TXT records', await sign(base(), [{ selector: 'multi' }]), false],
  ['key under 2048 bits', await sign(base(), [{ selector: 'weak', privateKey: rsaWeak.privateKey }]), false],
  ['key in testing mode (t=y)', await sign(base(), [{ selector: 'test' }]), false],
  ['Ed25519 signature, RSA key record', await sign(base(), [{ selector: 'edrsa', privateKey: ed.privateKey }]), false],
  ['rsa-sha1', await sign(base(), [{ algorithm: 'rsa-sha1' }]), false],
  ['expired x=', await sign(base(), [{}], { signTime: past, expires: new Date('2026-10-02T00:00:00Z') }), false],
  ['t= in the future', await sign(base(), [{}], { signTime: new Date('2027-01-01T00:00:00Z') }), false],
  ['aligned but not allowlisted', await sign(base('x@attacker.example'), [{ signingDomain: 'attacker.example', privateKey: rsaOther.privateKey }]), false],
  ['d= attacker, From ucsc.edu', await sign(base(), [{ signingDomain: 'attacker.example', privateKey: rsaOther.privateKey }]), false],
  ['d= ucsc.edu, From another domain', await sign(base('someone@gmail.com'), [{}]), false],
  ['d= subdomain mail.ucsc.edu, From ucsc.edu', await sign(base(), [{ signingDomain: 'mail.ucsc.edu' }]), false],
  ['copied Authentication-Results, no signature',
    'Authentication-Results: mx.google.com; dkim=pass header.d=ucsc.edu; dmarc=pass\r\n' + base(), false],
  ['no signature', base(), false],
  ['multiple mailboxes in From', await sign(base('amsmith@ucsc.edu, other@ucsc.edu'), [{}]), false],
  ['malformed From', await sign(base('amsmith@ucsc.edu garbage'), [{}]), false],
  ['multi-sig: aligned valid + ESP valid', await sign(base(), [{}, espSig]), true],
  ['multi-sig: aligned broken + ESP valid', (await sign(base(), [{}, espSig])).replace(/(d=ucsc\.edu;[\s\S]*?b=)(\w)/, (_, p, c) => p + (c === 'A' ? 'B' : 'A')), false],
  ['multi-sig: wrong-key first + aligned valid', await sign(base(), [{ selector: 's1', privateKey: rsaOther.privateKey }, {}]), true],
  ['five signatures (complexity bound)', await sign(base(), [{}, {}, {}, {}, {}]), false],
  ['empty allowlist', valid, false, { allowedDomains: [] }],
  ['replay: identical bytes delivered again (not prevented)', valid, true]
];

let mf, tripwire, authenticate;
before(async () => {
  const shimmed = await bundle({ shim: true });
  const plain = await bundle({ shim: false });
  // Node baseline has the same narrow selector extension, but native Node crypto.
  ({ authenticate } = await import(`data:text/javascript;base64,${Buffer.from(plain.code).toString('base64')}`));
  console.log(JSON.stringify({ bundleBytes: shimmed.bytes, gzipBytes: shimmed.gzipBytes }));
  const opts = code => ({ modules: true, script: code, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'] });
  mf = new Miniflare(convertV4MiniflareOptions(opts(shimmed.code)));
  tripwire = new Miniflare(convertV4MiniflareOptions(opts(plain.code)));
});
after(async () => { await mf?.dispose(); await tripwire?.dispose(); });

const inWorkerd = async (instance, raw, extra = {}) =>
  (await instance.dispatchFetch('http://research.test', {
    method: 'POST', body: JSON.stringify({ raw, allowedDomains: ALLOW, records, ...extra })
  })).json();
const nodeResolver = async (name, type) => {
  const entry = records[name.toLowerCase()];
  if (entry === 'hang') return new Promise(() => {});
  if (entry === 'servfail') throw Object.assign(new Error('mock SERVFAIL'), { code: 'ETIMEOUT' });
  if (type !== 'TXT' || !entry) throw Object.assign(new Error('mock NXDOMAIN'), { code: 'ENOTFOUND' });
  return entry;
};
const summary = v => ({ trusted: v.trusted, reason: v.reason, domain: v.domain,
  sigs: v.result?.results?.map(r => `${r.signingDomain ?? '-'}:${r.status?.result}${r.status?.comment ? ` (${r.status.comment})` : ''}`) });

for (const [name, raw, expected, extra] of cases) {
  test(name, async () => {
    const node = await authenticate(raw, { resolver: nodeResolver, allowedDomains: ALLOW, ...extra });
    const worker = await inWorkerd(mf, raw, extra);
    console.log(JSON.stringify({ name, node: summary(node).trusted, workerd: summary(worker), ms: worker.ms }));
    assert.equal(node.trusted, expected, 'Node baseline');
    assert.equal(worker.trusted, expected, 'workerd');
    assert.deepEqual(summary(worker).sigs, summary(node).sigs, 'per-signature results match Node');
    if (raw === unicodeFrom) {
      // Distinguish unsupported alignment spelling from invalid cryptography or From syntax.
      assert.equal(node.result.fromSyntax, 'valid');
      assert.equal(node.result.results[0].status.result, 'pass');
      assert.equal(worker.result.results[0].status.result, 'pass');
      assert.equal(worker.reason, 'no-qualifying-signature');
    }
  });
}

test('creation policy accepts ASCII A-labels and rejects Unicode or terminal dots', () => {
  assert.deepEqual(normalizeEmailAuth({ domains: ['XN--BCHER-KVA.EXAMPLE'] }),
    { domains: [idnaDomain], selector_pins: {} });
  for (const domain of ['bücher.example', 'ucsc.edu.', `${idnaDomain}.`]) {
    assert.throws(() => normalizeEmailAuth({ domains: [domain] }), /email_auth domain/);
  }
});

test('tripwire: unshimmed mailauth still fails RSA on this workerd', async () => {
  const rsaVerdict = await inWorkerd(tripwire, valid);
  assert.equal(rsaVerdict.trusted, false);
  assert.equal(rsaVerdict.result.results[0].status.comment, 'Unknown digest: rsa-sha256');
  // Ed25519 passes null as the digest, so it never hit the bug.
  assert.equal((await inWorkerd(tripwire, validEd)).trusted, true);
});

for (const selector of ['bad..label', '-leading', 'trailing-', 'bad/label', 'a'.repeat(64)]) {
  test(`malformed selector rejected before DNS: ${selector}`, async () => {
    // Pre-crypto syntax fixtures, not valid signatures: isolate the selector check.
    const raw = valid.replace('s=s1;', `s=${selector};`);
    assert.notEqual(raw, valid);
    for (const v of [await authenticate(raw, { resolver: nodeResolver, allowedDomains: ALLOW }),
      await inWorkerd(mf, raw)]) {
      assert.equal(v.trusted, false);
      assert.equal(v.queries, 0);
      assert.equal(v.result.results[0].status.comment, 'signature syntax error');
    }
  });
}
