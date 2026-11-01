// The context meter in the real page (src/context.ts, main.js renderCtx, Usage
// panel): hidden before anything is said; after a reply that reports usage, the
// exact count against the model's window ("12.5k / 128k"), then "~" once text is
// added after it; near the auto-compaction point it turns warn-colored and says
// so in words (aria-label, title). It is the second reading of the composer's one
// Usage button (the first is the allowance, each with its own bar); it opens Usage, which spells it out with a
// Compact now button; both themes; phone layout drops the window but keeps the
// count, with no horizontal scroll. BayLeaf Sealed is the scripted fake
// (test/graph-fixture.js, its `usage` option). Transformers.js trimming is
// covered in node (test/ctx-node.mjs): the test build has no local model.
// Nothing reaches api.bayleaf.dev: every non-loopback request is routed here.
// Run: node test/ctx-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-ctx-'));
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });

const stub = `
import { createFake } from './test/graph-fixture.js';
window.fake = createFake();
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => { throw new Error('the old plaintext title path was used'); } } };
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
const t0 = Date.now();
const ok = (name) => { passed++; console.log('ok', name, `(${((Date.now() - t0) / 1000).toFixed(0)} s)`); };
const errors = [];
const T = { timeout: 15000 };
let bayleafHits = 0;

async function open(name, viewport = { width: 1280, height: 800 }) {
  const context = await pw.chromium.launchPersistentContext(join(scratch, name), { headless: true, viewport });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, context_window: 131072, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    if (u.pathname.endsWith('/campus-pass')) return r.fulfill({ json: { campus_network: true, enabled: true, quota: { remaining: 150, limit: 200 } } });
    if (!/\/sealed\/attestation|\/campus-pass/.test(u.pathname)) { bayleafHits++; console.log('  bayleaf request:', r.request().method(), u.pathname); }
    return r.abort();
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#badge.ok', T);
  await page.click('#welcome button >> text=Got it', { timeout: 2000 }).catch(() => {});
  return { context, page };
}
const rule = (page, r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r);
const idle = (page) => page.waitForFunction(() => document.getElementById('send-label')?.textContent === 'Send', null, T);
async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
const meter = (page) => page.$eval('#composer-ctx', (b) => ({ hidden: b.hidden, text: b.innerText, label: document.getElementById('composer-usage').ariaLabel, level: b.dataset.level, fill: b.style.getPropertyValue('--fill'), color: getComputedStyle(b).color }));
async function shoot(page, name) {
  for (const t of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, t);
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(shots, `merged-usage-${name}-${t}.png`) });
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}

let s;
try {
  s = await open('desk');
  const { page } = s;
  assert.equal((await meter(page)).hidden, true, 'nothing to count before the first message');
  await page.waitForFunction(() => document.getElementById('composer-usage-num').textContent === '150', null, T);
  const alone = await page.evaluate(() => ({ sep: getComputedStyle(document.querySelector('#composer-usage .sep')).display, label: document.getElementById('composer-usage').ariaLabel,
    fill: document.getElementById('composer-allow').style.getPropertyValue('--fill'), bar: getComputedStyle(document.getElementById('composer-allow'), '::after').content }));
  assert.equal(alone.sep, 'none');
  assert.equal(alone.fill, '75%');
  assert.notEqual(alone.bar, 'none', 'the allowance reading has its bar when the fraction is known');
  assert.match(alone.label, /^Usage\. Allowance: about 150 of 200 BayLeaf Sealed requests left today \(shared on this network\)[^]*\. Opens Usage\.$/);
  assert.doesNotMatch(alone.label, /Context/);
  ok('hidden before the session holds anything: the button is the allowance reading alone, with its 75% bar');

  // Titles take the first unmatched-or-title request; main gets the usage rule.
  await rule(page, { who: 'main', reply: { content: 'Hello there.', usage: { prompt_tokens: 12431, completion_tokens: 69 }, ms: 1 } });
  await send(page, 'hi');
  await idle(page);
  await page.waitForFunction(() => /server reported/.test(document.getElementById('composer-usage').ariaLabel ?? ''), null, T);
  let m = await meter(page);
  assert.equal(m.text, '12.5k / 128k');
  assert.equal(m.level, 'ok');
  assert.equal(m.fill, '10%');
  assert.match(m.label, /^Usage\. Allowance: about 150 of 200 [^]*\. Context: 12,500 tokens of a 131,072-token window; as the last reply's server reported\. Opens Usage\.$/);
  const one = await page.evaluate(() => ({ buttons: document.querySelectorAll('#composer-toolbar button[id^="composer-"]').length, usage: document.querySelectorAll('#composer-toolbar #composer-usage').length,
    inside: !!document.querySelector('#composer-usage #composer-ctx'), ctxButton: document.getElementById('composer-ctx').tagName, title: document.getElementById('composer-usage').title,
    sep: getComputedStyle(document.querySelector('#composer-usage .sep')).display !== 'none', h: document.getElementById('composer-usage').getBoundingClientRect().height }));
  assert.deepEqual([one.buttons, one.usage, one.inside, one.ctxButton, one.sep], [1, 1, true, 'SPAN', true]);
  assert.match(one.title, /Allowance: [^]*Context: 12,500/);
  assert.ok(one.h >= 44, JSON.stringify(one));
  await shoot(page, 'desktop');
  ok('after a reply: one Usage button naming both readings; the context is the exact server count against the window, 10% bar');

  // A message typed but not sent changes nothing: only the stored conversation counts.
  await page.fill('#input', 'x'.repeat(5000));
  assert.equal((await meter(page)).text, '12.5k / 128k');
  await page.fill('#input', '');
  ok('a draft is not counted (it is not in the context yet)');

  // Near the point where Pouch compacts by itself (about 98k of a 128k window).
  await rule(page, { who: 'main', reply: { content: 'Long answer.', usage: { prompt_tokens: 80000, completion_tokens: 500 }, ms: 1 } });
  await send(page, 'more');
  await idle(page);
  await page.waitForFunction(() => /^80\.5k/.test(document.getElementById('composer-ctx').innerText), null, T);
  m = await meter(page);
  assert.equal(m.text, '80.5k / 128k');
  assert.match(m.label, /Pouch compacts by itself at about 98\.3k; \/compact does it now/);
  ok('near auto-compaction: warn level, and the words say where Pouch compacts and that /compact does it now');

  // Colors in both themes: the near color differs from the plain one and from the surface.
  const colors = await page.evaluate(() => {
    const de = document.documentElement, was = de.dataset.theme, b = document.getElementById('composer-ctx'), out = {};
    for (const t of ['light', 'dark']) {
      de.dataset.theme = t;
      const near = getComputedStyle(b).color; b.dataset.level = 'ok';
      const plain = getComputedStyle(b).color; b.dataset.level = 'near';
      out[t] = { near, plain, surface: getComputedStyle(document.getElementById('composer')).backgroundColor };
    }
    if (was) de.dataset.theme = was; else delete de.dataset.theme;
    return out;
  });
  for (const t of ['light', 'dark']) { assert.notEqual(colors[t].near, colors[t].plain, t); assert.notEqual(colors[t].near, colors[t].surface, t); }
  assert.notEqual(colors.light.near, colors.dark.near);
  ok('both themes: the near color is the theme\'s warn color, distinct from plain text and the surface');

  // It opens Usage, which spells it out with Compact now.
  await page.click('#composer-usage');
  await page.waitForSelector('#usage-body .ctx-now', T);
  const panel = await page.$eval('#usage-body .ctx-now', (s) => ({ text: s.textContent, level: s.dataset.level, first: s === s.parentElement.firstElementChild, button: s.querySelector('button')?.textContent }));
  assert.ok(panel.first, 'above the allowance');
  assert.equal(panel.level, 'near');
  assert.match(panel.text, /This session's context80\.5k of 128k tokens/);
  assert.match(panel.text, /Nothing is sent to count it/);
  assert.match(panel.button, /^Compact now \(/);
  await page.screenshot({ path: join(shots, 'ctx-usage-panel.png') });
  await page.click('#usage .panel-close');
  ok('opens Usage: the count, the words, how it was counted, and Compact now');

  // Phone: the count stays, the window part hides, no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(200);
  const phone = await page.evaluate(() => {
    const b = document.getElementById('composer-usage'), r = b.getBoundingClientRect(), bar = document.getElementById('composer-toolbar').getBoundingClientRect();
    const ctx = document.getElementById('composer-ctx').getBoundingClientRect(), send = document.getElementById('send').getBoundingClientRect();
    return { ctxW: ctx.width, sendRight: send.right, num: document.getElementById('composer-usage-num').getBoundingClientRect().width, of: getComputedStyle(document.getElementById('composer-ctx-of')).display, w: r.width, h: r.height, right: r.right, barRight: bar.right, sw: document.documentElement.scrollWidth, visible: r.width > 0 };
  });
  assert.equal(phone.of, 'none');
  assert.ok(phone.visible && phone.h >= 44 && phone.ctxW > 0 && phone.num > 0, JSON.stringify(phone));
  assert.ok(phone.right <= phone.barRight + 0.5 && phone.sendRight <= phone.barRight + 0.5 && phone.sw <= 390, JSON.stringify(phone));
  await page.screenshot({ path: join(shots, 'ctx-phone.png') });
  await shoot(page, 'phone');
  ok('phone (390 px): both counts stay in one 44 px button, the window hides, no horizontal scroll');

  assert.equal(bayleafHits, 0, 'counting sends nothing');
  assert.deepEqual(errors, []);
  ok('no page errors; no request beyond the fake for counting');
} finally {
  await s?.context.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${passed} passed`);
process.exit(0);
