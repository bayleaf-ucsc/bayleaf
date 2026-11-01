// Build dist/index.html: the demo as one self-contained file, the way
// pouch/build.mjs builds pouch.html (inline script, CSP stamped with its hash).
//
//   cd pouch/experiments/quickjs && npm ci && node build.mjs
//
// Two bundles: the worker (QuickJS + inline wasm) becomes a string constant
// inside the page bundle, so the page still has exactly one inline script.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const sha256 = (s, enc) => createHash('sha256').update(s).digest(enc);
const opts = { bundle: true, minify: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', legalComments: 'inline', logLevel: 'warning' };
const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;

const worker = (await build({ ...opts, entryPoints: ['src/worker-browser.js'] })).outputFiles[0].text;
const page = (await build({ ...opts, entryPoints: ['src/demo.js'], define: { WORKER_SRC: JSON.stringify(worker) } })).outputFiles[0].text;

const app = page.replaceAll('</script', '<\\/script');
let html = readFileSync('index.html', 'utf8').replace('<script>/*APP*/</script>', () => `<script>${app}</script>`);
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, body]) => `'sha256-${sha256(body, 'base64')}'`);
html = html.replace('__SCRIPT_HASHES__', hashes.join(' '));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log(`worker bundle ${kib(worker.length)} (${kib(gzipSync(worker).length)} gzip)`);
console.log(`dist/index.html ${kib(html.length)} (${kib(gzipSync(html).length)} gzip), ${hashes.length} inline script(s)`);
console.log(`sha256 ${sha256(html, 'hex')}`);
