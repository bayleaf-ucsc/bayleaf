// Build dist/pouch.html: one self-contained file you can save and open.
//
//   cd pouch && npm ci && node build.mjs
//
// Inlines the pinned Tinfoil SDK (package-lock.json is the supply-chain pin),
// stamps the CSP with the SHA-256 of each inline script so nothing else can run,
// and prints the file's SHA-256 for publishing alongside a release.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const sha256 = (s, enc) => createHash('sha256').update(s).digest(enc);

const sdk = await build({
  stdin: { contents: 'export { TinfoilAI } from "tinfoil";', resolveDir: '.' },
  bundle: true, minify: true, write: false,
  format: 'iife', globalName: 'Tinfoil', platform: 'browser', target: 'es2020',
  // @tinfoilsh/verifier has a Node-only gzip fallback behind a dynamic import.
  external: ['zlib'],
  legalComments: 'inline',
});
// An inline script ends at the first "</script", wherever it appears.
const sdkCode = sdk.outputFiles[0].text.replaceAll('</script', '<\\/script');

let html = readFileSync('pouch.html', 'utf8').replace('<script>/*TINFOIL_SDK*/</script>', () => `<script>${sdkCode}</script>`);

const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(([, body]) => `'sha256-${sha256(body, 'base64')}'`);
html = html.replace('__SCRIPT_HASHES__', hashes.join(' '));

mkdirSync('dist', { recursive: true });
writeFileSync('dist/pouch.html', html);
console.log(`dist/pouch.html  ${(html.length / 1024).toFixed(0)} KiB  ${hashes.length} inline scripts`);
console.log(`sha256 ${sha256(html, 'hex')}`);
