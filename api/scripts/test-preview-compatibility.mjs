#!/usr/bin/env node
/** Fast, credential-free regressions against actual private route helpers.
 * Test-only exports are appended in memory: no production export or workerd/D1.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { verify } from 'hono/jwt';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(root + 'src/routes/previews.ts', 'utf8');
console.log('STAGE bundling actual preview helpers (no workerd)');
const bundle = await build({
  stdin: { contents: source + '\nexport { platformCredential, validators, upstreamRequest };',
    resolveDir: root + 'src/routes', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
});
const { platformCredential, validators, upstreamRequest } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const env = {
  OIDC_CLIENT_SECRET: 'synthetic-api-session-secret',
  PREVIEWS_SECRET: Buffer.alloc(32, 7).toString('base64'),
  PREVIEWS_INSTALLATION_KEY: 'synthetic-installation-secret',
  DAYTONA_API_KEY: 'synthetic-daytona-secret',
  ALLOWED_EMAIL_DOMAIN: 'example.test', PREVIEWS_UPSTREAM_SUFFIXES: '.preview.example.test',
};
const target = new URL('https://8765-synthetic-signed-credential.preview.example.test/');
const incoming = 'https://owner-private-synthetic.previews.example.test/';
const iv = crypto.getRandomValues(new Uint8Array(12));
const aes = await crypto.subtle.importKey('raw', Buffer.from(env.PREVIEWS_SECRET, 'base64'), 'AES-GCM', false, ['encrypt']);
const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
  additionalData: new TextEncoder().encode(new URL(incoming).hostname) }, aes, new TextEncoder().encode(target.origin));
const registration = {
  hostname: new URL(incoming).hostname, deployment: '__api', generation: 'synthetic-generation',
  upstream_encrypted: Buffer.concat([Buffer.from(iv), Buffer.from(ciphertext)]).toString('base64'),
};
const request = headers => new Request(incoming, { headers: {
  'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', ...headers,
} });
const signed = (secret, expired = false, paddedParts = false) => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const pad = value => value.padEnd(Math.ceil(value.length / 4) * 4, '=');
  let header = encode({ alg: 'HS256', typ: 'JWT' });
  let payload = encode({ email: 'owner@example.test', exp: expired ? 1 : Math.floor(Date.now() / 1000) + 3600 });
  if (paddedParts) { header = pad(header); payload = pad(payload); }
  const data = `${header}.${payload}`;
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
};
function equivalentSignatures(token) {
  const parts = token.split('.');
  const signature = parts.pop();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // HS256 produces 43 characters: the low two bits of the last character are
  // unused. Test every spelling that atob decodes to the same signature bytes.
  assert.equal(signature.length, 43);
  const canonicalIndex = alphabet.indexOf(signature.at(-1)) & ~3;
  const forms = new Set();
  for (let bits = 0; bits < 4; bits++) {
    const alias = signature.slice(0, -1) + alphabet[canonicalIndex + bits];
    for (const spelling of [alias, alias.replace(/-/g, '+').replace(/_/g, '/')]) {
      forms.add(parts.join('.') + '.' + spelling);
      forms.add(parts.join('.') + '.' + spelling + '=');
      forms.add(parts.join('.') + '.' + spelling.slice(0, 10) + ' ' + spelling.slice(10) + '=');
    }
  }
  return [...forms];
}
let jwtForms = 0;
for (const secret of [env.OIDC_CLIENT_SECRET, env.PREVIEWS_SECRET]) {
  for (const expired of [false, true]) {
    for (const paddedParts of [false, true]) {
      for (const token of equivalentSignatures(signed(secret, expired, paddedParts))) {
        // Establish equivalence using the actual session verifier, not a copied
        // decoder. Expired tokens are signature-verified with expiry disabled.
        await verify(token, secret, { alg: 'HS256', exp: !expired });
        assert.equal(await platformCredential(token, request(), env, target), true);
        const prepared = await upstreamRequest(request({
          Authorization: `Bearer ${token}`, 'X-Nanobot-Auth': token,
        }), env, registration);
        assert.equal(prepared.headers.get('Authorization'), null);
        assert.equal(prepared.headers.get('X-Nanobot-Auth'), null);
        jwtForms++;
      }
    }
  }
}
console.log(`PASS ${jwtForms} Hono-verified JWT spellings excluded by actual helper and header builder`);

for (const credential of ['sk-bayleaf-owner', 'sk-bayleaf-grant-test', 'sk-or-v1-test', 'tk_test', 'admin_test',
  'tvly-test', 'dt_test', 'campus', env.PREVIEWS_INSTALLATION_KEY, env.DAYTONA_API_KEY,
  target.hostname, target.hostname.split('.')[0], 'synthetic-signed-credential', 'SYNTHETIC-SIGNED-CREDENTIAL']) {
  const prepared = await upstreamRequest(request({ Authorization: `Bearer ${credential}`, 'X-Nanobot-Auth': credential }), env, registration);
  assert.equal(prepared.headers.get('Authorization'), null);
  assert.equal(prepared.headers.get('X-Nanobot-Auth'), null);
}
for (const token of ['nbwt_synthetic_application_token', signed('synthetic-app-only-signing-secret') + '=']) {
  const prepared = await upstreamRequest(request({ Authorization: `Bearer ${token}`, 'X-Nanobot-Auth': 'synthetic app password' }), env, registration);
  assert.equal(prepared.headers.get('Authorization'), `Bearer ${token}`);
  assert.equal(prepared.headers.get('X-Nanobot-Auth'), 'synthetic app password');
}
for (const token of ['one.two.!bad', 'one.two.A', 'one.two.===']) {
  assert.equal(await platformCredential(token, request(), env, target), true, 'malformed JWT-like input is stripped without throwing');
}
assert.equal(await platformCredential('synthetic-cookie-value', request({ Cookie: 'bayleaf_session=synthetic-cookie-value' }), env, target), true);
for (const headers of [
  { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
  { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' },
]) {
  // Header builder alone must not forward credentials on the navigation
  // exception. The full foreign-Origin gate belongs to handlePreviewHost.
  const prepared = await upstreamRequest(request({ ...headers, Authorization: 'Bearer nbwt_synthetic', 'X-Nanobot-Auth': 'app-password' }), env, registration);
  assert.equal(prepared.headers.get('Authorization'), null);
  assert.equal(prepared.headers.get('X-Nanobot-Auth'), null);
}
console.log('PASS reserved secrets, malformed JWTs, app-token positive controls and credential origin restrictions');

let etags = 0;
for (const url of [target, new URL('https://synthetic-unprefixed-credential.preview.example.test/')]) {
  const label = url.hostname.split('.')[0];
  const credential = label.replace(/^\d+-/, '');
  for (const sensitive of new Set([url.hostname, label, credential])) {
    for (const text of [sensitive, sensitive.toUpperCase(), `prefix_${sensitive}_suffix`]) {
      for (const prefix of ['', 'W/']) {
        const outgoing = new Headers();
        validators(new Headers({ ETag: `${prefix}"${text}"` }), outgoing, url);
        assert.equal(outgoing.get('ETag'), null);
        etags++;
      }
    }
  }
}
for (const etag of ['"fixture-v1"', 'W/"fixture-v1"', '"' + 'a'.repeat(256) + '"']) {
  const outgoing = new Headers();
  validators(new Headers({ ETag: etag, 'Last-Modified': 'Thu, 08 Oct 2026 00:00:00 GMT' }), outgoing, target);
  assert.equal(outgoing.get('ETag'), etag);
  assert.equal(outgoing.get('Last-Modified'), 'Thu, 08 Oct 2026 00:00:00 GMT');
}
for (const etag of ['"' + target.href + '"', '"' + 'a'.repeat(257) + '"', '"contains space"', 'unquoted']) {
  const outgoing = new Headers();
  validators(new Headers({ ETag: etag, 'Last-Modified': target.href }), outgoing, target);
  assert.equal(outgoing.get('ETag'), null);
  assert.equal(outgoing.get('Last-Modified'), null);
}
console.log(`PASS ${etags} full-hostname/first-label/credential ETag containment cases plus validator positive controls`);
console.log('Focused preview compatibility regressions passed (actual source helpers; no end-to-end/browser qualification).');
