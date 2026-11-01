#!/usr/bin/env node
/**
 * Restricted-egress qualification for the HF artifact gateway (issue #121):
 * unmodified Transformers.js in real Chrome loads and runs an approved model
 * with every network destination except the gateway's origin blocked.
 *
 *   node scripts/qualify-hf-browser.mjs --node-modules <dir> [--playwright <playwright/index.mjs>]
 *     [--gateway https://api.bayleaf.dev/hf/] [--repo onnx-community/LFM3-1.7B-ONNX]
 *     [--revision <commit or alias>] [--dtype q4f16] [--device webgpu] [--headed]
 *
 * <dir> must contain @huggingface/transformers and onnxruntime-web (Pouch's
 * node_modules works). The library is bundled locally and served, with the ORT
 * wasm, from a fake origin the harness answers itself; the page then sets only
 * `env.remoteHost`. Every other request is aborted and reported. Prints a JSON
 * report; exits non-zero unless the model generated text, the gateway was the
 * only network origin, and no response redirected.
 */
import { build } from 'esbuild';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const nodeModules = arg('node-modules');
if (!nodeModules || !existsSync(join(nodeModules, '@huggingface/transformers'))) {
  console.error('usage: node scripts/qualify-hf-browser.mjs --node-modules <dir with @huggingface/transformers and onnxruntime-web>');
  process.exit(2);
}
const gateway = arg('gateway', 'https://api.bayleaf.dev/hf/');
const repo = arg('repo', 'onnx-community/LFM3-1.7B-ONNX');
const revision = arg('revision', 'main');
const dtype = arg('dtype', 'q4f16'), device = arg('device', 'webgpu');
const pw = await import(arg('playwright', process.env.PLAYWRIGHT_MODULE || 'playwright'));

const LOCAL = 'https://qualify.invalid';
const lib = (await build({ stdin: { contents: "export * from '@huggingface/transformers';", resolveDir: nodeModules },
  nodePaths: [nodeModules], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'warning' })).outputFiles[0].contents;
const ortDist = join(nodeModules, 'onnxruntime-web/dist');
const versions = { transformers: JSON.parse(readFileSync(join(nodeModules, '@huggingface/transformers/package.json'))).version,
  ort: JSON.parse(readFileSync(join(nodeModules, 'onnxruntime-web/package.json'))).version };

const page_html = `<!doctype html><meta charset="utf-8"><script type="module">
  import { pipeline, env } from '/transformers.js';
  env.remoteHost = ${JSON.stringify(gateway)};
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.backends.onnx.wasm.wasmPaths = '/ort/';
  const t0 = performance.now();
  try {
    const generator = await pipeline('text-generation', ${JSON.stringify(repo)}, { revision: ${JSON.stringify(revision)}, dtype: ${JSON.stringify(dtype)}, device: ${JSON.stringify(device)} });
    const loaded = performance.now() - t0;
    const messages = [{ role: 'user', content: 'Reply with one short sentence: what is the capital of France?' }];
    const out = await generator(messages, { max_new_tokens: 24, do_sample: false });
    window.result = { ok: true, load_ms: Math.round(loaded), text: out[0].generated_text.at(-1).content };
  } catch (e) { window.result = { ok: false, error: String(e?.stack ?? e) }; }
</script>`;

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const profile = mkdtempSync(join(tmpdir(), 'hf-qualify-'));
const context = await pw.chromium.launchPersistentContext(profile, {
  executablePath: arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), headless: !process.argv.includes('--headed'),
  args: ['--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', '--enable-features=WebGPU'] });
const gatewayOrigin = new URL(gateway).origin;
const seen = [], blocked = [], redirects = [];
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === LOCAL) {
    if (url.pathname === '/') return route.fulfill({ body: page_html, contentType: 'text/html' });
    if (url.pathname === '/transformers.js') return route.fulfill({ body: Buffer.from(lib), contentType: 'text/javascript' });
    const file = url.pathname.startsWith('/ort/') && join(ortDist, url.pathname.slice(5));
    if (file && !file.includes('..') && existsSync(file)) return route.fulfill({ body: readFileSync(file), contentType: types[extname(file)] ?? 'application/octet-stream' });
    return route.fulfill({ status: 404, body: '' });
  }
  if (url.origin === gatewayOrigin) return route.continue();
  blocked.push(url.href);
  return route.abort('blockedbyclient');
});
context.on('response', (r) => {
  const url = new URL(r.url());
  if (url.origin === LOCAL) return;
  seen.push({ origin: url.origin, status: r.status(), method: r.request().method(), path: url.pathname, range: r.request().headers().range ?? null });
  if (r.status() >= 300 && r.status() < 400) redirects.push(r.url());
});

const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
const t0 = Date.now();
await page.goto(`${LOCAL}/`);
await page.waitForFunction(() => window.result, null, { timeout: 30 * 60_000, polling: 1000 });
const result = await page.evaluate(() => window.result);
await context.close();
rmSync(profile, { recursive: true, force: true });

const origins = [...new Set(seen.map((r) => r.origin))];
const report = { gateway, repo, revision, dtype, device, versions, wall_ms: Date.now() - t0, result, network_origins: origins,
  blocked, redirects, requests: seen, console_errors: consoleErrors };
console.log(JSON.stringify(report, null, 2));
process.exit(result.ok && result.text && !blocked.length && !redirects.length && origins.every((o) => o === gatewayOrigin) ? 0 : 1);
