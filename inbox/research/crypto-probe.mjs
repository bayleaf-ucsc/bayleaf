// Root-cause probe: which node:crypto digest names and key forms does pinned workerd accept?
// Usage: node crypto-probe.mjs [compatibilityDate] [flag,flag]
import { generateKeyPairSync, sign } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from '../node_modules/miniflare/dist/src/index.js';

const date = process.argv[2] || '2026-08-01';
const flags = (process.argv[3] || 'nodejs_compat').split(',');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = generateKeyPairSync('ed25519');
const data = Buffer.from('canonicalized header bytes');
const fixture = {
  data: data.toString('base64'),
  rsaSpki: rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  rsaPkcs1: rsa.publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64'),
  rsaSig: sign('sha256', data, rsa.privateKey).toString('base64'),
  edSpki: ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  // mailauth's Ed25519 path signs SHA-256(header) with pure Ed25519.
  edSig: sign(null, (await import('node:crypto')).createHash('sha256').update(data).digest(), ed.privateKey).toString('base64')
};

const script = `
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
const b = s => Buffer.from(s, 'base64');
function attempt(f) { try { return String(f()); } catch (e) { return 'throws: ' + e.message; } }
export default { async fetch(req) {
  const f = await req.json();
  const data = b(f.data);
  const out = {};
  const spki = attempt(() => crypto.createPublicKey({ key: b(f.rsaSpki), format: 'der', type: 'spki' }).asymmetricKeyType);
  out['createPublicKey rsa spki'] = spki;
  out['createPublicKey rsa pkcs1'] = attempt(() => crypto.createPublicKey({ key: b(f.rsaPkcs1), format: 'der', type: 'pkcs1' }).asymmetricKeyType);
  const key = crypto.createPublicKey({ key: b(f.rsaSpki), format: 'der', type: 'spki' });
  for (const name of ['rsa-sha256', 'RSA-SHA256', 'sha256', 'SHA256', 'SHA-256', 'sha-256', 'rsa-sha1', 'sha1'])
    out['verify ' + name] = attempt(() => crypto.verify(name, data, key, b(f.rsaSig)));
  out['createVerify rsa-sha256'] = attempt(() => crypto.createVerify('rsa-sha256').update(data).verify(key, b(f.rsaSig)));
  out['createVerify RSA-SHA256'] = attempt(() => crypto.createVerify('RSA-SHA256').update(data).verify(key, b(f.rsaSig)));
  out['createHash rsa-sha256'] = attempt(() => crypto.createHash('rsa-sha256').digest('hex').slice(0, 8));
  const ek = attempt(() => crypto.createPublicKey({ key: b(f.edSpki), format: 'der', type: 'spki' }).asymmetricKeyType);
  out['createPublicKey ed25519 spki'] = ek;
  out['verify null ed25519'] = attempt(() => crypto.verify(null, crypto.createHash('sha256').update(data).digest(),
    crypto.createPublicKey({ key: b(f.edSpki), format: 'der', type: 'spki' }), b(f.edSig)));
  // WebCrypto baseline with the same bytes.
  const rk = await crypto.subtle.importKey('spki', b(f.rsaSpki), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  out['subtle RSASSA-PKCS1-v1_5'] = String(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', rk, b(f.rsaSig), data));
  try {
    const edk = await crypto.subtle.importKey('spki', b(f.edSpki), { name: 'Ed25519' }, false, ['verify']);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    out['subtle Ed25519'] = String(await crypto.subtle.verify('Ed25519', edk, b(f.edSig), h));
  } catch (e) { out['subtle Ed25519'] = 'throws: ' + e.message; }
  return Response.json(out);
} };`;

const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: date, compatibilityFlags: flags }));
try {
  const res = await mf.dispatchFetch('http://probe.test', { method: 'POST', body: JSON.stringify(fixture) });
  console.log(JSON.stringify({ date, flags, results: await res.json() }, null, 1));
} finally { await mf.dispose(); }
