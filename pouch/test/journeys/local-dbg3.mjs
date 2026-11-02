import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { newSession } from './lib.mjs';
const srv = spawn('node', ['/tmp/pouch-qa/local-serve.mjs', '/tmp/pouch-qa/local-build', '8792'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const ctx = await chromium.launchPersistentContext('/tmp/pouch-qa/local-profile', { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU'], viewport: { width: 1400, height: 900 } });
await ctx.route('https://**/*', (r) => r.request().url().endsWith('/models') ? r.fulfill({ json: { data: [] } }) : r.abort());
const page = ctx.pages()[0];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (!/ERR_FAILED/.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
await page.goto('http://127.0.0.1:8792/pouch.html');
await page.waitForSelector('#model option[value^="local:"]', { state: 'attached' });
const id = await page.$eval('#model option[value^="local:"]', (o) => o.value);
await page.selectOption('#model', id);
await page.waitForFunction(() => /ready|error/.test(document.querySelector('#addons-settings').dataset.tjs ?? ''));
await page.evaluate(() => { window.__st = []; new MutationObserver(() => window.__st.push(document.querySelector('#status').textContent)).observe(document.querySelector('#status'), { childList: true, characterData: true, subtree: true }); });
console.log('state', await page.$eval('#addons-settings', (b) => b.dataset.tjs));
console.log('seed...');
await Promise.race([page.evaluate(async () => {
  const root = await navigator.storage.getDirectory(); const names = [];
  for await (const n of root.keys()) names.push(n);
  for (const n of names) await root.removeEntry(n, { recursive: true });
  const w = await (await root.getFileHandle('README.md', { create: true })).createWritable(); await w.write('# Lantern\nA converter.\n'); await w.close();
  return names;
}).then((x) => console.log('seeded, removed', x)), new Promise((r) => setTimeout(() => { console.log('SEED TIMEOUT'); r(); }, 10000))]);
console.log('newSession...'); await newSession(page); console.log('ok');
await page.selectOption('#model', id);
await page.fill('#input', 'Read README.md and summarize it in one sentence.');
await page.press('#input', 'Enter');
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  console.log(i * 5, await page.textContent('#send-label'), '|', (await page.textContent('#status')).slice(0, 100), '|', await page.$$eval('#log .msg', (d) => d.map((x) => x.className + ':' + x.textContent.slice(0, 80)).join(' || ')));
  if ((await page.textContent('#send-label')) === 'Send' && i > 1) break;
}
console.log('STATUSES', JSON.stringify(await page.evaluate(() => window.__st)));
await page.screenshot({ path: '/tmp/pouch-qa/local-dbg3.png' });
await ctx.close(); srv.kill();
