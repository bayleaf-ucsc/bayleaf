// The look tool in the real page (JOURNEYS AG1, AG4, AG8), with the scripted
// fake in test/graph-fixture.js bundled in place of Tinfoil: no Sealed request is
// ever made. A blue PNG drawn on a canvas lands in /work (bash base64 -d); on a
// model marked images the fake calls look, the card shows a thumbnail from the
// stored bytes and the next request carries the image after the tool message;
// on a text-only model the call fails with the plain refusal.
// Run: node test/look-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-look-'));
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });

const stub = `
import { createFake, panelRules } from './test/graph-fixture.js';
window.fake = createFake(); window.panelRules = panelRules;
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true }; }
}`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.ts')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.ts'), zlib: join(root, 'src/shims/zlib.ts'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
  plugins: [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: root })); } }] });
let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };
const errors = [];
const T = { timeout: 15000 };
const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 } });
try {
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [
      { id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] },
      { id: 'eyes', name: 'eyes', tool_calling: true, multimodal: true, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    return r.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#badge.ok');
  await page.click('#welcome button >> text=Got it').catch(() => {});
  await page.selectOption('#model', 'eyes');
  const rule = (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
  const send = async (text) => { await page.fill('#input', text); await page.press('#input', 'Enter'); };
  const idle = () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
  const imagesIn = (n) => page.evaluate((n) => window.fake.requests.main[n - 1].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((p) => p.type === 'image_url').map((p) => p.image_url.url.slice(0, 22))), n);

  // A real PNG, drawn here and saved into /work by the attachment picker (a local
  // write; the chip is then removed, so nothing is sent with a message).
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; const g = c.getContext('2d'); g.fillStyle = '#1e40ff'; g.fillRect(0, 0, 64, 48); return c.toDataURL('image/png').split(',')[1]; });
  await page.locator('#attachment-picker').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  const chip = page.locator('.attachment').first();
  await chip.waitFor(T);
  const png = await chip.getAttribute('title');
  await chip.locator('button').click();
  assert.match(png, /^\/work\/\.attachments\/.+-chart\.png$/);

  await rule({ who: 'main', when: '/look please/.test(c.since)', reply: [['look', { paths: [png], note: 'checking the colour' }]] });
  await rule({ who: 'main', when: '/image 1, PNG 64x48/.test(c.since)', reply: 'It is a blue rectangle.' });
  await send('look please');
  await page.waitForFunction(() => window.fake.requests.main?.length >= 2, null, T);
  await idle();
  const n = await page.evaluate(() => window.fake.requests.main?.length);
  const msgs = await page.evaluate((n) => window.fake.requests.main[n - 1].messages.map((m) => m.role), n);
  const ti = msgs.lastIndexOf('tool');
  assert.equal(msgs[ti + 1], 'user', 'a user message follows the tool message');
  assert.deepEqual(await imagesIn(n), ['data:image/png;base64,']);
  assert.ok((await page.evaluate(() => window.fake.requests.main.at(-1).tools.map((t) => t.function.name))).includes('look'));
  ok('AG1: look on a model marked images; the next request carries the PNG after the tool message');

  const card = page.locator('#log details.tool', { hasText: 'look: 1 image: ' }).last();
  await card.waitFor(T);
  const thumb = card.locator('summary .look-strip img');
  await page.waitForFunction((el) => el.complete && el.naturalWidth === 64, await thumb.elementHandle(), T);
  assert.match(await thumb.getAttribute('src'), /^blob:/);
  await card.locator('summary').click();
  assert.match(await card.textContent(), /checking the colour[\s\S]*Sent 1 image to the model as shown; they count toward this conversation's context/);
  assert.equal(await card.locator('.look-strip.big img').count(), 1);
  await page.screenshot({ path: join(shots, 'look-card.png') });
  ok('AG4: the card shows a thumbnail while collapsed (blob URL, 64x48), the note, and the context reminder');

  await page.selectOption('#model', 'fake');
  await rule({ who: 'main', when: '/look again/.test(c.since)', reply: [['look', { paths: [png] }]] });
  await rule({ who: 'main', when: '/cannot see images/.test(c.since)', reply: 'Please switch to a model marked images.' });
  await send('look again');
  await page.waitForFunction(() => window.fake.requests.main?.length >= 4, null, T);
  await idle();
  const last = await page.evaluate(() => window.fake.requests.main.at(-1));
  assert.match(last.messages.filter((m) => m.role === 'tool').at(-1).content, /This model cannot see images; ask the person to switch to a model marked images\./);
  assert.deepEqual(await imagesIn(await page.evaluate(() => window.fake.requests.main.length)), [], 'no image sent to the text-only model');
  assert.equal(await page.locator('#log details.tool.error', { hasText: 'look: 1 image' }).count(), 1);
  ok('AG8: a text-only model gets the plain refusal; no pixels in its request');

  assert.deepEqual(errors, []);
  console.log(`${passed} passed`);
} finally {
  await context.close();
  server.close();
}
