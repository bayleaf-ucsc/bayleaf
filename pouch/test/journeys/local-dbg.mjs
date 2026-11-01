import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const srv = spawn('node', ['/tmp/pouch-qa/local-serve.mjs', '/tmp/pouch-qa/local-build', '8792'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const ctx = await chromium.launchPersistentContext('/tmp/pouch-qa/local-profile-dbg', { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU'] });
await ctx.route('https://**/*', (r) => r.request().url().endsWith('/models') ? r.fulfill({ json: { data: [] } }) : r.abort());
const page = ctx.pages()[0];
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('dialog', (d) => d.accept());
let n = 0; ctx.on('request', (r) => { if (r.url().includes('/models/')) n++; });
ctx.on('requestfailed', (r) => console.log('[failed]', r.url().slice(0, 100), r.failure()?.errorText));
await page.goto('http://127.0.0.1:8792/pouch.html');
await page.waitForSelector('#model option[value^="local:"]', { state: 'attached' });
console.log('option', await page.$eval('#model option[value^="local:"]', (o) => o.textContent + ' disabled=' + o.disabled));
await page.selectOption('#model', { index: await page.$$eval('#model option', (os) => os.findIndex((o) => o.value.startsWith('local:'))) });
for (let i = 0; i < 24; i++) { await new Promise((r) => setTimeout(r, 5000)); console.log(i * 5, 'req', n, '|', await page.$eval('#local-settings', (b) => b.dataset.state + ' ' + (b.dataset.error ?? '')), '|', (await page.textContent('#status')).slice(0, 90)); if (/ready|error/.test(await page.$eval('#local-settings', (b) => b.dataset.state))) break; }
await ctx.close(); srv.kill();
