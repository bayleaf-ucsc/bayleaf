// F1/F2 (fake Sealed client, 0 model requests) and F3 (real build from file://, network off).
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { fixtureHtml, serveHtml, fakeNetwork } from './fixture.mjs';
import { rowMore, sheetClick, ensurePanel, waitRow } from './lib.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); console.log(c ? 'PASS' : 'FAIL', m); };
const prof = (n) => { const d = '/tmp/pouch-qa/ro-' + n; rmSync(d, { recursive: true, force: true }); return d; };
const st = (page) => page.evaluate(() => ({ badge: document.querySelector('#badge').className, label: document.querySelector('#badge').ariaLabel, status: document.querySelector('#status').textContent, send: document.querySelector('#send').disabled, sendLabel: document.querySelector('#send').textContent, placeholder: document.querySelector('#input').placeholder }));
const opfs = (page, p) => page.evaluate(async (p) => { let d = await navigator.storage.getDirectory(); const parts = p.split('/'); try { for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x); return await (await (await d.getFileHandle(parts.at(-1))).getFile()).text(); } catch { return null; } }, p);
async function upload(page, dir, name, text) {
  await rowMore(page, dir);
  const chooser = page.waitForEvent('filechooser');
  await sheetClick(page, 'Upload files here');
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await sleep(700);
  if (await page.$('#sheet[open]')) { await sheetClick(page, 'Replace'); await sleep(500); }
}
async function idle(page, timeout = 20000) {
  const t = Date.now(); await sleep(300);
  while (Date.now() - t < timeout) { if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return sleep(300); await sleep(100); }
  throw new Error('never idle');
}

// ── F1/F2 ──
const srv = await serveHtml(await fixtureHtml());
const ctx = await chromium.launchPersistentContext(prof('t15'), { headless: true, viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const net = await fakeNetwork(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { console.log('DIALOG', d.message()); d.accept(); });
await page.goto(srv.url);
await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 20000 });
ok(/ok/.test((await st(page)).badge), 'online: verified, Send enabled');

// in-flight turn, then the network drops
await page.evaluate(() => window.script.push({ slow: 80 }));
await page.fill('#input', 'tell me a long story'); await page.click('#send');
await page.waitForSelector('.msg.assistant.streaming', { timeout: 5000 });
await sleep(1200);
const t0 = Date.now();
await ctx.setOffline(true); await page.evaluate(() => { window.netDown = true; });
await idle(page, 10000);
const endMs = Date.now() - t0;
let s = await st(page);
const log = await page.textContent('#log');
ok(endMs < 3000 && /Connection lost/.test(log), `in-flight turn ends with "Connection lost" in ${endMs} ms`);
ok(/offline/.test(s.badge) && /Offline: the model is unreachable/.test(s.label), 'badge: offline, not "not verified": ' + s.label);
ok(/Offline: the model is unreachable/.test(s.status) && !/verif/i.test(s.status), 'status says offline (distinct from verification failure)');
ok(s.send === true && /Offline/.test(await page.getAttribute('#send', 'title')), 'Send disabled with the offline reason as its title');

// typing while offline is kept; Enter does not send
const reqs0 = await page.evaluate(() => window.requests.length);
await page.fill('#input', 'draft typed on the train');
await page.press('#input', 'Enter'); await sleep(400);
ok((await page.inputValue('#input')) === 'draft typed on the train' && (await page.evaluate(() => window.requests.length)) === reqs0, 'composer text preserved; Enter sends nothing offline');

// files, editor, review, archives and run keep working offline
await ensurePanel(page, 'files');
await upload(page, '/work', 'notes.txt', 'offline notes\n');
ok((await opfs(page, 'notes.txt')) === 'offline notes\n', 'offline: upload into /work');
await upload(page, '/work', 'sum.js', 'const n = fs.readFile("notes.txt").length; fs.writeFile("out/len.txt", String(n)); console.log("len", n);\n');
await rowMore(page, '/work/sum.js'); await sheetClick(page, 'Run script');
await page.waitForSelector('#sheet[open] pre.run-out', { timeout: 10000 });
const ranText = await page.textContent('pre.run-out');
await page.locator('#sheet-actions button', { hasText: 'Cancel' }).click();
ok(/status: ok/.test(ranText) && /len 14/.test(ranText) && (await opfs(page, 'out/len.txt')) === '14', 'offline: Run script runs and writes: ' + ranText.split('\n')[0]);
// run's change is listed (review) and can be undone
await page.click('#rail button[data-panel="files"]').catch(() => {});
await sleep(500);
const changeTxt = await page.$$eval('.changes .change', (rs) => rs.map((r) => r.textContent).join(' | '));
ok(/len\.txt/.test(changeTxt), 'offline: the run\'s change shows under the turn');
await page.locator('.changes .change:has-text("len.txt") button', { hasText: 'Diff' }).last().click(); await sleep(600);
ok(await page.isVisible('#editor-pane, #editor, .cm-mergeView, .cm-editor').catch(() => false), 'offline: Diff opens in the editor');
await page.locator('.changes .change:has-text("len.txt") button', { hasText: 'Undo' }).last().click(); await sleep(800);
if (await page.$('#sheet[open]')) { await page.locator('#sheet-actions button').first().click(); await sleep(600); }
ok((await opfs(page, 'out/len.txt')) === null, 'offline: Undo of the run\'s change');
// editor: open, edit, save
await ensurePanel(page, 'files');
await page.click('#tree .row:has(.name[title="/work/notes.txt"])'); await sleep(600);
await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('more\n');
await page.click('#save'); await sleep(600);
if (await page.$('#sheet[open]')) { await page.locator('#sheet-actions button').first().click(); await sleep(400); }
ok((await opfs(page, 'notes.txt')) === 'offline notes\nmore\n', 'offline: editor edit and save');
// archives: download /work as .zip, unpack it again
await ensurePanel(page, 'files');
await rowMore(page, '/work');
const dl = page.waitForEvent('download');
await sheetClick(page, 'Download as .zip');
const zipPath = '/tmp/pouch-qa/ro-t15-work.zip';
await (await dl).saveAs(zipPath);
ok(statSync(zipPath).size > 100, 'offline: Download as .zip: ' + statSync(zipPath).size + ' bytes');
await rowMore(page, '/work');
const ch = page.waitForEvent('filechooser'); await sheetClick(page, 'Upload files here');
await (await ch).setFiles({ name: 'back.zip', mimeType: 'application/zip', buffer: readFileSync(zipPath) }); await sleep(800);
await rowMore(page, '/work/back.zip'); await sheetClick(page, 'Unpack here'); await sleep(1200);
if (await page.$('#sheet[open]')) { await page.locator('#sheet-actions button').first().click(); await sleep(800); }
const tree = await page.evaluate(async () => { const out = []; async function walk(d, pre) { for await (const [n, h] of d.entries()) { out.push(pre + n); if (h.kind === 'directory') await walk(h, pre + n + '/'); } } await walk(await navigator.storage.getDirectory(), ''); return out; });
ok(tree.some((p) => /^(back|work)(\/work)?\/notes\.txt$/.test(p)), 'offline: unpack a .zip: ' + tree.join(',') + ' ' + page.dialogs);
const offlineNet = net.length;

// F2: the network returns
await page.evaluate(() => { window.netDown = false; });
await ctx.setOffline(false);
await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 15000 }).catch(() => {});
s = await st(page);
ok(/ok/.test(s.badge) && s.send === false, 'back online: re-verified and Send enabled without reload: ' + s.label);
ok((await page.inputValue('#input')) === 'draft typed on the train', 'back online: draft still in the composer');
await sleep(500);
const after = net.slice(offlineNet);
ok(after.some((u) => /\/sealed\/models/.test(u)) && after.some((u) => /campus-pass|usage/.test(u)), 'back online: relay re-checked and usage refreshed: ' + [...new Set(after.map((u) => new URL(u).pathname))].join(' '));
await page.click('#send'); await idle(page);
ok((await page.evaluate(() => window.requests.length)) > reqs0, 'back online: the draft sends');

// classifier: requests fail like a dropped network while navigator.onLine stays true
await ctx.unroute('https://**/*');
await ctx.route('https://**/*', (r) => r.abort('internetdisconnected'));
await page.evaluate(() => { window.netDown = true; });
await page.fill('#input', 'captive portal'); await page.click('#send'); await idle(page);
await sleep(1500);
s = await st(page);
ok(/offline/.test(s.badge) && s.send === true, 'failed-fetch classifier: offline without an offline event');
await ctx.unroute('https://**/*'); await fakeNetwork(ctx, net);
await page.evaluate(() => { window.netDown = false; });
await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 20000 }).catch(() => {});
ok(/ok/.test((await st(page)).badge), 'recovers by the periodic re-check (15 s)');
console.log('page errors:', errors);
await ctx.close(); srv.close();

// ── F3: a saved copy from file://, network off ──
const dir = '/tmp/pouch-qa/ro-saved'; mkdirSync(dir, { recursive: true });
copyFileSync(process.env.POUCH_BUILD ?? '/tmp/pouch-qa/ro-build/pouch.html', dir + '/pouch.html');
const c3 = await chromium.launchPersistentContext(prof('t15-file'), { headless: true, viewport: { width: 1400, height: 900 } });
await c3.setOffline(true);
const p3 = await c3.newPage();
const e3 = []; p3.on('pageerror', (e) => e3.push(e.message)); p3.on('console', (m) => { if (m.type() === 'error') e3.push(m.text()); }); p3.on('dialog', (d) => d.accept());
await p3.goto('file://' + dir + '/pouch.html');
await sleep(4000);
const f3 = await p3.evaluate(async () => {
  const r = { origin: location.origin, onLine: navigator.onLine };
  try { await navigator.storage.getDirectory(); r.opfs = 'yes'; } catch (e) { r.opfs = 'no: ' + e.name; }
  try { await new Promise((res, rej) => { const q = indexedDB.open('probe-f3'); q.onsuccess = res; q.onerror = () => rej(q.error); }); r.idb = 'yes'; } catch (e) { r.idb = 'no: ' + e.name; }
  r.sw = 'serviceWorker' in navigator;
  r.tag = [...document.querySelectorAll('#tree .row')].map((x) => x.textContent).join(' | ').slice(0, 200);
  return r;
});
const s3 = await st(p3);
console.log('F3', JSON.stringify(f3), JSON.stringify(s3));
ok(true, `F3 file://: opfs ${f3.opfs}, idb ${f3.idb}, badge ${s3.badge}, status "${s3.status.slice(0, 80)}"`);
ok(/offline/.test(s3.badge) && s3.send, 'F3: offline start shows the offline state, not a verification failure');
await ensurePanel(p3, 'files');
await upload(p3, '/work', 'a.js', 'console.log("from file://", 6*7); fs.writeFile("b.txt", "ok")\n');
await rowMore(p3, '/work/a.js'); await sheetClick(p3, 'Run script');
await p3.waitForSelector('#sheet[open] pre.run-out', { timeout: 10000 }).catch(() => {});
const r3 = await p3.textContent('pre.run-out').catch(() => '(no sheet)');
ok(/from file:\/\/ 42/.test(r3), 'F3: run works from file:// offline: ' + r3.split('\n')[0]);
await p3.reload(); await sleep(3000);
await ensurePanel(p3, 'files');
const persisted = await p3.$$eval('#tree .row .name', (rs) => rs.map((r) => r.title));
const tag3 = await p3.textContent('#tree .row:has(.name[title="/work"])');
ok(!persisted.includes('/work/a.js') && /memory only/.test(tag3), 'F3 finding: file:// has no OPFS in Chromium, so /work is memory only (tagged) and a reload empties it');
console.log('F3 errors:', e3.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)).slice(0, 5));
await c3.close();
console.log(`${results.filter((r) => r[0]).length}/${results.length} passed`);
