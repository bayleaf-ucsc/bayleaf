// Boot with each side panel remembered: the layout restores it while the
// Interface's regions are still being created (src/main.js), so a region that
// reads another too early crashes the page here (#142).
//
//   node build.mjs && node test/boot-browser.mjs
//
// Serves dist/ locally; api.bayleaf.dev and every other host get 503, so no
// Sealed request is made.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 2 minutes'); process.exit(2); }, 120_000).unref();

const dist = resolve(process.env.POUCH_OUT || join(import.meta.dirname, '..', 'dist'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/pouch.html')));
  if (!path.startsWith(dist) || !existsSync(path)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }); res.end(readFileSync(path));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
let passed = 0;
try {
  for (const panel of ['files', 'usage', 'trust', 'settings', 'terminal']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 503, body: 'offline in test' }));
    await ctx.addInitScript((p) => localStorage.setItem('pouch.layout', JSON.stringify({ panel: p })), panel);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#tree .row[data-path]'), null, { timeout: 15_000 });
    await page.waitForTimeout(300); // the deferred panel renders run
    assert.deepEqual(errors, [], `page errors with ${panel} remembered`);
    assert.equal(await page.locator(`#rail button[data-panel="${panel}"]`).getAttribute('aria-pressed'), 'true', `${panel} panel restored`);
    passed++; console.log('ok', panel, 'remembered: boots without errors');
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
console.log(`PASS ${passed} remembered panels boot cleanly`);
