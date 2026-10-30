// The installable, offline copy (sw.js + src/offline.js) against a real build.
//
//   POUCH_OUT=/tmp/pouch-qa/distA node build.mjs
//   POUCH_OUT=/tmp/pouch-qa/distA node test/pwa-browser.mjs [--webkit]
//
// Serves the build from a local server whose directory can be swapped, to play
// a release (B), a tampered release (HTML not matching SHA256SUMS) and a changed
// sw.js. api.bayleaf.dev is answered locally with 503: no Sealed request is made.
// Fresh browser contexts, no profiles on disk. The whole run is capped at 3 min.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 3 minutes'); process.exit(2); }, 180_000).unref();

const root = resolve(import.meta.dirname, '..');
const A = resolve(process.env.POUCH_OUT || join(root, 'dist'));
const SHOTS = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(SHOTS, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const short = (h) => h.slice(0, 12);
const scratch = mkdtempSync(join(tmpdir(), 'pouch-pwa-'));

// Variants of build A: B (a release with a different label), T (B's SUMS but
// other HTML: tampered), S (B with a changed sw.js, SUMS updated).
const shell = ['pouch.html', 'SHA256SUMS', 'sw.js', 'manifest.webmanifest', 'icons'];
function variant(name, edit) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  for (const f of shell) cpSync(join(A, f), join(dir, f), { recursive: true });
  edit(dir);
  return dir;
}
const sumsOf = (dir) => Object.fromEntries(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split('  ').reverse()));
const resum = (dir, path) => {
  const s = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').replace(new RegExp(`^[0-9a-f]{64}  ${path.replace('.', '\\.')}$`, 'm'), `${sha(readFileSync(join(dir, path)))}  ${path}`);
  writeFileSync(join(dir, 'SHA256SUMS'), s);
};
const htmlA = readFileSync(join(A, 'pouch.html'), 'utf8');
const label = htmlA.match(/<code id="build-id">([^<]+)<\/code>/)[1];
const B = variant('B', (d) => { writeFileSync(join(d, 'pouch.html'), htmlA.replace(`<code id="build-id">${label}</code>`, `<code id="build-id">${label} B</code>`)); resum(d, 'pouch.html'); });
const T = variant('T', (d) => { cpSync(join(B, 'pouch.html'), join(d, 'pouch.html')); writeFileSync(join(d, 'pouch.html'), readFileSync(join(d, 'pouch.html'), 'utf8').replace('</body>', '<!-- injected --></body>')); cpSync(join(B, 'SHA256SUMS'), join(d, 'SHA256SUMS')); writeFileSync(join(d, 'SHA256SUMS'), readFileSync(join(d, 'SHA256SUMS'), 'utf8').replace(/^[0-9a-f]{64}(?=  pouch\.html)/, 'c'.repeat(64))); });
const S = variant('S', (d) => { cpSync(join(B, 'pouch.html'), join(d, 'pouch.html')); cpSync(join(B, 'SHA256SUMS'), join(d, 'SHA256SUMS')); writeFileSync(join(d, 'sw.js'), readFileSync(join(d, 'sw.js'), 'utf8') + '// changed\n'); resum(d, 'sw.js'); });
const hA = sumsOf(A)['pouch.html'], hB = sumsOf(B)['pouch.html'], hT = sumsOf(T)['pouch.html'];

// The server: the deploy's routes and headers (/ is pouch.html), from `serve.dir`.
const csp = htmlA.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1] + "; frame-ancestors 'none'; object-src 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '': 'text/plain' };
const serve = { dir: A, log: [], sums503: false };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname; // the query is ignored, as on Cloudflare
  serve.log.push(path);
  const file = path === '/' ? 'pouch.html' : path.slice(1);
  const full = join(serve.dir, file);
  if (path.includes('..') || !existsSync(full) || (serve.sums503 && file === 'SHA256SUMS')) { res.writeHead(file === 'SHA256SUMS' && serve.sums503 ? 503 : 404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': csp, 'x-content-type-options': 'nosniff',
    'cache-control': /^(pouch\.html|SHA256SUMS)$/.test(file) ? 'no-store' : /^(sw\.js|manifest\.webmanifest)$/.test(file) ? 'no-cache' : 'public, max-age=86400' });
  res.end(readFileSync(full));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const results = [];
const ok = (c, m) => { results.push(!!c); console.log(c ? 'PASS' : 'FAIL', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shellCaches = (page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('pouch-shell-')));
const buildLabel = (page) => page.textContent('#build-id');
const waitPinned = (page, h) => page.waitForFunction(async (h) => !!(await (await caches.open('pouch-shell-' + h)).match('/')), h, { timeout: 10000 }); // '/' is written last
const facts = (page) => page.$$eval('#copy-facts dt', (dts) => Object.fromEntries(dts.map((dt) => [dt.textContent, [dt.nextElementSibling.textContent, dt.nextElementSibling.className]])));
async function openTrust(page) {
  if ((await page.getAttribute('#app', 'data-panel')) !== 'trust') await page.click('#badge');
  await page.waitForFunction(() => document.querySelector('#copy-facts dt'));
  await page.waitForFunction(() => /sw\.js|could not check/.test(document.querySelector('#copy-facts').textContent), null, { timeout: 8000 }).catch(() => {});
}
async function newContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const api = [];
  await ctx.route('https://api.bayleaf.dev/**', (r) => { api.push(r.request().url()); return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test"}' }); });
  return { ctx, api };
}
async function newPage(ctx, errors) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}
async function uploadWork(page, name, text) {
  if ((await page.getAttribute('#app', 'data-panel')) !== 'files') await page.click('#rail button[data-panel="files"]');
  await page.locator('#tree .row:has(.name[title="/work"]) .more').first().click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#sheet-actions button', { hasText: 'Upload files here' }).first().click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await sleep(700);
}
const opfsHas = (page, name) => page.evaluate(async (n) => { try { const w = await navigator.storage.getDirectory(); return await (await (await w.getFileHandle(n)).getFile()).text(); } catch { return null; } }, name);

// ── Chromium: the full story ──
const browser = await chromium.launch({ headless: true });
const errors = [];
if (!process.argv.includes('--webkit-only')) try {
  const { ctx, api } = await newContext(browser);
  const page = await newPage(ctx, errors);
  await page.goto(url + '/');
  await waitPinned(page, hA);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  ok(true, `first visit registers sw.js, takes control and pins A (${short(hA)})`);

  // Installability, as Chromium judges it, and the icons.
  const cdp = await ctx.newCDPSession(page);
  const inst = await cdp.send('Page.getInstallabilityErrors');
  const man = await cdp.send('Page.getAppManifest');
  ok(inst.installabilityErrors.length === 0 && man.errors.length === 0, `installable per Chromium: ${JSON.stringify(inst.installabilityErrors)} manifest errors ${JSON.stringify(man.errors)}`);
  const icons = await page.evaluate(async () => Promise.all(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'].map(async (p) => { const b = await createImageBitmap(await (await fetch(p)).blob()); return `${b.width}`; })));
  ok(icons.join() === '192,512,512,180', 'icons load and decode: ' + icons.join());

  // Reload: served by the worker; the server sees no page request.
  await sleep(1000); // let Chromium's own manifest and icon checks settle
  serve.log = [];
  const nav = await page.reload();
  ok(nav.fromServiceWorker() && !serve.log.includes('/'), `reload is served from the offline copy (fromServiceWorker ${nav.fromServiceWorker()}; server saw: ${serve.log.join(' ')})`);

  // Not handled: api.bayleaf.dev, /models/**, /SHA256SUMS.
  serve.log = [];
  const apiBefore = api.length;
  const swReqs = [];
  ctx.on('request', (r) => { if (r.serviceWorker()) swReqs.push(r.url()); });
  const viaSW = [];
  page.on('response', (r) => { if (/api\.bayleaf\.dev|\/models\//.test(r.url())) viaSW.push([r.url(), r.fromServiceWorker()]); });
  await page.evaluate(async () => { await fetch('/models/x/manifest.0000000000000000.json').catch(() => {}); await fetch('https://api.bayleaf.dev/sealed/models').catch(() => {}); });
  await sleep(300);
  ok(serve.log.includes('/models/x/manifest.0000000000000000.json') && api.length > apiBefore && viaSW.every(([, f]) => !f) && !swReqs.some((u) => /api\.bayleaf|\/models\//.test(u)),
    `api.bayleaf.dev and /models/** pass through (fromServiceWorker: ${JSON.stringify(viaSW.map((x) => x[1]))}, worker-initiated: ${swReqs.length})`);

  // Trust panel: this copy, the worker hash.
  await page.click('#welcome-dismiss').catch(() => {});
  await openTrust(page);
  let f = await facts(page);
  ok(/offline copy/.test(f['Running from'][0]) && f['Offline copy'][0].includes(short(hA)) && f['Service worker'][1] === 'ok' && /matches/.test(f['Service worker'][0]),
    'trust panel: running from the offline copy, its hash, sw.js matches: ' + JSON.stringify(f));
  await page.screenshot({ path: join(SHOTS, 'pwa-trust-panel.png') });

  // Offline: reload loads the app; files persist (OPFS); sessions open.
  await ctx.setOffline(true);
  const offNav = await page.reload();
  await page.waitForSelector('#tree .row', { timeout: 10000, state: 'attached' });
  await page.waitForFunction(() => /offline/.test(document.querySelector('#badge').className), null, { timeout: 10000 });
  await uploadWork(page, 'offline.txt', 'kept offline\n');
  await page.reload();
  await page.waitForSelector('#tree .row', { timeout: 10000, state: 'attached' });
  const kept = await opfsHas(page, 'offline.txt');
  const sessionsBefore = await page.$$eval('#session-list .session', (s) => s.length);
  await page.click('#new-top');
  await sleep(500);
  const tag = await page.textContent('#tree .row:has(.name[title="/work"])');
  ok(offNav.fromServiceWorker() && kept === 'kept offline\n' && !/memory only/.test(tag) && errors.length === 0,
    `offline reload loads, shows offline state, /work persists in OPFS (sessions listed: ${sessionsBefore}; sw ${offNav.fromServiceWorker()} kept ${JSON.stringify(kept)} tag ${tag}); errors: ${JSON.stringify(errors)}`);
  await ctx.setOffline(false);

  // Update flow: publish B; nothing changes until Update is pressed.
  serve.dir = B;
  serve.log = [];
  await page.reload();
  await page.waitForSelector('#update:not([hidden])', { timeout: 10000 });
  const notice = await page.textContent('#update-text');
  ok(notice.includes(short(hA)) && notice.includes(short(hB)) && (await buildLabel(page)) === label, `update notice names both hashes, still running A: "${notice.slice(0, 110)}..."`);
  await page.screenshot({ path: join(SHOTS, 'pwa-update-notice.png') });
  await page.click('#update-later');
  await page.reload(); await sleep(800);
  ok((await buildLabel(page)) === label && (await shellCaches(page)).join() === 'pouch-shell-' + hA, 'Later, then reload: still A, cache unchanged');
  await page.waitForSelector('#update:not([hidden])');
  await page.click('#update-go');
  await page.waitForFunction((l) => document.querySelector('#build-id').textContent === l, label + ' B', { timeout: 10000 })
    .catch(async (e) => { throw new Error('no B after Update: ' + (await page.textContent('#update-text').catch(() => '?')) + ' / ' + (await page.textContent('#status').catch(() => '?'))); });
  ok((await shellCaches(page)).join() === 'pouch-shell-' + hB, `Update verifies, swaps to B (${short(hB)}) and reloads; one shell cache`);

  // Tampered release: refused, B keeps running.
  serve.dir = T;
  await page.reload();
  await page.waitForSelector('#update:not([hidden])', { timeout: 10000 });
  await page.click('#update-go');
  await page.waitForFunction(() => /Update refused/.test(document.querySelector('#update-text').textContent), null, { timeout: 10000 });
  const refusal = await page.textContent('#update-text');
  await page.reload(); await sleep(800);
  ok(/does not match SHA256SUMS/.test(refusal) && (await buildLabel(page)) === label + ' B' && (await shellCaches(page)).join() === 'pouch-shell-' + hB,
    `tampered HTML refused, B keeps running: "${refusal}"`);
  await page.screenshot({ path: join(SHOTS, 'pwa-update-refused.png') });
  ok(hT !== hB, 'tampered SUMS hash differs from B (sanity)');

  // A changed sw.js: the panel warns (and the browser takes the new worker by itself).
  serve.dir = S;
  await page.reload();
  await openTrust(page);
  f = await facts(page);
  ok(f['Service worker'][1] === 'bad' && /differs/.test(f['Service worker'][0]), 'changed sw.js is flagged: ' + f['Service worker'][0]);
  await page.screenshot({ path: join(SHOTS, 'pwa-trust-sw-mismatch.png') });

  // Uninstall offline copy: unregistered, cache gone, stays off on reload; Keep restores.
  serve.dir = B;
  await page.click('#copy-remove');
  await page.waitForFunction(async () => !(await navigator.serviceWorker.getRegistrations()).length && !(await caches.keys()).some((k) => k.startsWith('pouch-shell-')));
  serve.log = [];
  const navOff = await page.reload(); await sleep(1500);
  ok(!navOff.fromServiceWorker() && serve.log.includes('/') && !(await shellCaches(page)).length && !(await page.evaluate(() => navigator.serviceWorker.getRegistrations())).length,
    'Uninstall: worker unregistered, copy deleted, reload comes from the network and stays uninstalled');
  await openTrust(page);
  await page.click('#copy-keep');
  await waitPinned(page, hB);
  ok(true, 'Keep an offline copy: pinned again');

  // Erase all: unregisters and clears before the reload (SHA256SUMS fails, so no new pin).
  await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  serve.sums503 = true; serve.log = [];
  // The reloaded page registers sw.js again (a fresh start); what matters is
  // that the reload came from the network and no copy survived.
  await Promise.all([page.waitForEvent('load', { timeout: 15000 }), page.click('#erase')]);
  await sleep(1500);
  const afterErase = await page.evaluate(async () => ({ shell: (await caches.keys()).filter((k) => k.startsWith('pouch-shell-')), erased: !document.querySelector('#erased').hidden }));
  ok(!afterErase.shell.length && afterErase.erased && serve.log.includes('/'), 'Erase all: worker unregistered and copy cleared: ' + JSON.stringify(afterErase));
  serve.sums503 = false;
  ok(api.length > 0 && api.every((u) => !/\/v1\/chat\/completions/.test(u)), `api.bayleaf.dev answered locally (${api.length} requests), no inference sent`);
  await ctx.close();
} catch (e) { ok(false, 'chromium: ' + e.message.split('\n')[0]); }
await browser.close();

// ── WebKit: load, pin, offline reload (optional) ──
if (process.argv.includes('--webkit')) {
  let wk;
  try {
    serve.dir = A;
    wk = await webkit.launch({ headless: true });
    const { ctx } = await newContext(wk);
    const errs = [];
    const page = await newPage(ctx, errs);
    await page.goto(url + '/');
    await waitPinned(page, hA);
    await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    serve.log = [];
    const online = await page.reload();
    ok(online.fromServiceWorker() && !serve.log.includes('/'), 'WebKit online: pins A and reload is served by the worker');
    // Open gap (2026-10-30): here every worker-served request fails offline
    // ("FetchEvent.respondWith ... Load failed"), yet a bare page with this same
    // sw.js, a page-written cache, CSP headers, routing and a 5 MB body all
    // pass under the same emulation. Unexplained; check in real Safari.
    await ctx.setOffline(true);
    const probe = await page.evaluate(async () => Promise.all(['/', '/pouch.html', '/manifest.webmanifest'].map((p) => fetch(p).then((r) => p + ' ' + r.status, (e) => p + ' ' + e.message))));
    const reload = await page.reload().then(() => 'ok', (e) => e.message.split('\n')[0]);
    await page.waitForSelector('#tree .row', { timeout: 10000, state: 'attached' }).catch(() => {});
    ok(reload === 'ok' && (await buildLabel(page).catch(() => '')) === label, `WebKit offline: fetch via worker ${probe.join(', ')}; reload ${reload}`);
    await ctx.close();
  } catch (e) { ok(false, 'webkit: ' + e.message.split('\n')[0]); }
  await wk?.close();
}

server.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
