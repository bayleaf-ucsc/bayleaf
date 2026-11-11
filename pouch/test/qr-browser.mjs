// Real Pouch page, scripted model (no inference), real CSP and independent
// decoding of screenshots, not just the encoder's matrix. No QR network service.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || '/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode', 'pouch-qr-'));
process.env.POUCH_SHOTS ??= scratch;
const { uiPage } = await import('./ui-journey-browser.mjs');
const payloads = [
  'https://bayleaf.dev/#qr-handoff',
  'A café, 中文, 🐈, e\u0301\nline two',
  'https://example.invalid/#' + 'x'.repeat(999), // 1024 bytes, near maximum density
  '<img src=https://evil.example/track onerror=alert(1)>',
];
assert.equal(new TextEncoder().encode(payloads[2]).length, 1024);
const program = 'root = Stack([a, b, c, d])\n' + payloads.map((v, i) => `${'abcd'[i]} = QRCode(${JSON.stringify(v)}, ${JSON.stringify(['Open on phone', 'Unicode text', 'Long payload', '<b>Literal label</b>'][i])})`).join('\n');
const reply = 'Scan only if you trust the payload.\n\n```openui-lang\n' + program + '\n```';
const app = await uiPage({ fake: true });
setTimeout(() => { console.error('FAIL QR browser: over 3 minutes'); process.exit(2); }, 180_000).unref();

async function decodeShot(qr, expected, path) {
  const png = PNG.sync.read(await qr.locator('svg').screenshot({ path }));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(result, `QR screenshot decodes: ${path}`);
  assert.equal(result.data, expected);
  assert.deepEqual(result.binaryData, [...new TextEncoder().encode(expected)]);
}

try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const outside = [], errors = [], dialogs = [], requests = [];
    try {
      await context.route('https://**/*', (r) => {
        const u = new URL(r.request().url());
        if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
        if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
        outside.push(u.href); return r.abort();
      });
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`));
        // Track clipboard calls, with an intentional rejection to test fallback.
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => {
          if (window.__denyCopy) throw new Error('permission denied');
          (window.__copied ??= []).push(s);
        } } });
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
      page.on('request', (r) => requests.push(r.url()));
      await page.goto(app.url);
      await page.waitForSelector('#badge.ok');
      await page.locator('#welcome-dismiss').click();
      const rule = (r) => page.evaluate((r) => window.fake.rule({ ...r, when: new Function('c', 'return ' + r.when) }), r);
      await rule({ who: 'main', when: '/QR code/.test(c.since)', reply: [['read', { path: '/pouch/skills/ui-blocks/SKILL.md' }]] });
      await rule({ who: 'main', when: '/# UI blocks/.test(c.since)', reply: { content: reply, size: 100, ms: 10 } });
      await page.fill('#input', 'Show a QR code I can scan on my phone.');
      await page.press('#input', 'Enter');
      await page.waitForFunction(() => window.fake.requests.main?.length >= 2);
      await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send');
      const skillRequest = await page.evaluate(() => JSON.stringify(window.fake.requests.main[1].messages));
      assert.match(skillRequest, /QRCode\(value, label\?\)/, 'discovery skill teaches the new component');
      const oui = page.locator('#log .msg.assistant .body div.oui').first();
      assert.equal(await oui.locator('.oui-qr').count(), 4);
      assert.equal(await oui.locator('.oui-errors').count(), 0);
      assert.equal(await oui.locator('a, img, iframe, script, foreignObject').count(), 0);
      assert.deepEqual(await oui.locator('.oui-qr-payload').allTextContents(), payloads);
      assert.equal(await oui.locator('figcaption').last().textContent(), '<b>Literal label</b>');
      assert.deepEqual(await page.evaluate(() => window.__copied ?? []), [], 'no automatic clipboard write');
      for (const width of [1280, 360]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
        for (let i = 0; i < payloads.length; i++) {
          const qr = oui.locator('.oui-qr').nth(i);
          await decodeShot(qr, payloads[i], join(scratch, `${name}-${width}-${theme}-${i}.png`));
          const fit = await qr.evaluate((q) => {
            const svg = q.querySelector('svg').getBoundingClientRect(), box = q.getBoundingClientRect();
            return { inside: svg.right <= box.right + 0.5, square: Math.abs(svg.width - svg.height) < 1, overflow: q.scrollWidth - q.clientWidth };
          });
          assert.ok(fit.inside && fit.square && fit.overflow <= 0, JSON.stringify(fit));
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
        await oui.locator('.oui-qr').first().screenshot({ path: join(scratch, `${name}-${width}-${theme}-component.png`) });
      }
      await oui.locator('.oui-qr button').first().click();
      assert.deepEqual(await page.evaluate(() => window.__copied), [payloads[0]]);
      assert.equal(await oui.locator('.oui-qr button').first().textContent(), 'Copied');
      await page.evaluate(() => { window.__denyCopy = true; });
      await oui.locator('.oui-qr button').nth(1).click();
      assert.equal(await oui.locator('.oui-qr button').nth(1).textContent(), 'Copy failed');
      const before = await oui.locator('svg path').evaluateAll((paths) => paths.map((p) => p.getAttribute('d')));
      await page.reload();
      await page.waitForSelector('#session-list .session', { state: 'attached' });
      await context.setOffline(true);
      const n = requests.length;
      if (!(await page.locator('#log div.oui').count())) await page.$eval('#session-list .session', (s) => s.click());
      await page.locator('#log div.oui').first().waitFor();
      assert.deepEqual(await page.locator('#log .oui svg path').evaluateAll((paths) => paths.map((p) => p.getAttribute('d'))), before);
      await decodeShot(page.locator('#log .oui-qr').first(), payloads[0], join(scratch, `${name}-offline.png`));
      assert.deepEqual(requests.slice(n).filter((u) => !u.startsWith('blob:') && !u.startsWith('data:')), [], 'offline replay fetched nothing');
      assert.deepEqual(outside.filter((u) => u !== 'https://api.bayleaf.dev/campus-pass'), []);
      assert.deepEqual(await page.evaluate(() => window.__csp ?? []), []);
      assert.deepEqual(dialogs, []);
      assert.deepEqual(errors, []);
      console.log(`PASS QR ${name}: skill discovery, streamed reply, 16 screenshot decodes, 360px/desktop light/dark, explicit copy/failure, offline replay, no payload egress or CSP violation`);
    } finally { await context.close(); await browser.close(); }
  }
} finally { app.close(); }
console.log('QR screenshots:', scratch);
