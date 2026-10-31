// Batch D regressions in the real page, on the scripted fake (test/graph-fixture.js; no
// Sealed request is ever made): scrolling rules while streaming (README
// "Scrolling"), subagent framing (breadcrumbs, agent-hue frame, motion, Esc and
// Back), click-outside and Esc for every popover, ARIA roles, usage as outside
// state, and the round 3 critique items.
// Run: node test/batchD-browser.mjs   (BROWSER=webkit for WebKit; ONLY=a,b for sections)
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchD-'));
const video = process.env.POUCH_VIDEO;
const BROWSER = process.env.BROWSER || 'chromium';

const stub = `
import { createFake, panelRules } from './test/graph-fixture.js';
window.fake = createFake(); window.panelRules = panelRules;
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => (window.__titles = (window.__titles ?? 0) + 1, { choices: [{ message: { content: 'Merging Monthly Spending CSVs With A Long Title' } }] }) } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true, codeFingerprint: 'a'.repeat(64), enclaveFingerprint: 'a'.repeat(64), releaseTag: 'v0.0.1', steps: { fetchDigest: { status: 'success' } } }; }
}`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife',
  define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"test"' },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
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
const ESSAY = '# Walkable towns\n\nTowns should be walkable.\n\nWalking cuts car trips by 40%.\n\nSo plan for feet.\n';

// Every Element.animate call, for the motion checks (its id is set by src/motion.js).
const LOG_ANIMS = `(() => {
  const orig = Element.prototype.animate; window.__anims = [];
  Element.prototype.animate = function (k, o) {
    const a = orig.call(this, k, o), n = this;
    queueMicrotask(() => window.__anims.push({ id: a.id, cls: String(n.className), pseudo: o?.pseudoElement ?? null, delay: o?.delay ?? 0, kf: JSON.stringify(k).slice(0, 160) }));
    return a;
  };
})();`;
// A profile from before Batch B: version 3 with the change-review store (migration check).
const OLD_DB = `(() => { if (localStorage.getItem('batchB-old')) return; localStorage.setItem('batchB-old', '1');
  const r = indexedDB.open('bayleaf-pouch', 3);
  r.onupgradeneeded = () => { for (const s of ['sessions', 'settings', 'mounts', 'shared']) r.result.createObjectStore(s); r.result.createObjectStore('changes', { keyPath: 'seq', autoIncrement: true }).createIndex('session', 'session'); };
  r.onsuccess = () => r.result.close(); })();`;

let profiles = 0;
async function open(ctxOpts = {}) {
  const context = await (BROWSER === 'webkit' ? webkit : chromium).launchPersistentContext(join(scratch, 'profile' + (++profiles)), { headless: true, viewport: { width: 1280, height: 800 }, ...ctxOpts });
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname === '/usage') return r.fulfill({ json: { sealed: { remaining: 400, limit: 500 } } });
    if (u.pathname.includes('usage') || u.pathname === '/campus-pass') return r.fulfill({ json: {} });
    return r.abort();
  });
  await context.addInitScript(LOG_ANIMS);
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|unsupported MIME type/.test(m.text())) errors.push(m.text()); });
  await page.goto(url);
  await page.waitForSelector('#badge.ok', T);
  await page.selectOption('#model', 'fake').catch(() => {});
  await page.click('#welcome button >> text=Got it').catch(() => {});
  const h = {
    page, context,
    rule: (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r),
    send: async (text, key = 'Enter') => { await page.fill('#input', text); await page.press('#input', key); },
    idle: () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T),
    busy: () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Stop', null, T),
    gate: (g) => page.evaluate((g) => { window.fake.gates[g] = true; }, g),
    anims: (re) => page.evaluate((s) => window.__anims.filter((a) => new RegExp(s).test(a.id ?? '')), re),
  };
  h.files = async () => { if ((await page.getAttribute('#app', 'data-panel')) !== 'files') await page.click('#rail [data-panel="files"]'); };
  h.settled = async () => { await h.idle(); await page.waitForTimeout(500); await h.idle(); };
  return h;
}


const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const failed = [];
async function section(name, fn, ctxOpts) {
  if (ONLY && !ONLY.has(name)) return;
  errors.length = 0;
  const h = await open(ctxOpts);
  try { await fn(h, h.page); assert.deepEqual(errors, [], 'page errors: ' + errors.join('\n')); }
  catch (e) {
    failed.push(name); console.log('FAIL', name, e.message.split('\n').slice(0, 6).join('\n'));
    await h.page.screenshot({ path: join(process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots', `batchD-${BROWSER}-${name}-fail.png`) }).catch(() => {});
    console.log('unmatched:', JSON.stringify(await h.page.evaluate(() => window.fake?.unmatched?.slice(-6)).catch(() => null)));
  } finally { await h.context.close().catch(() => {}); }
}

// ── B: scrolling while streaming (README "Scrolling") ──
const para = (n, w = 'reply') => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of the long ${w}: walkable towns, short trips, shade trees and benches every block.`).join('\n\n');
const geo = (page, sel = '#log') => page.evaluate((sel) => { const l = document.querySelector(sel); return l && { top: l.scrollTop, gap: l.scrollHeight - l.scrollTop - l.clientHeight, h: l.scrollHeight, ch: l.clientHeight, ov: getComputedStyle(l).overflowY, osb: getComputedStyle(l).overscrollBehaviorY }; }, sel);
const streaming = (page) => page.evaluate(() => !!document.querySelector('#log .typing'));
// A user scroll up: a wheel on desktop; a finger drag on touch (Chromium: CDP
// gesture; WebKit has no touch synthesis, so a scrollBy stands in: the rules
// key off scroll events, whatever made them).
async function scrollUp(h, page, px, touch) {
  const box = await page.locator('#log').boundingBox();
  if (touch && BROWSER === 'chromium') {
    const cdp = await h.context.newCDPSession(page);
    await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), yDistance: px, speed: 1200, gestureSourceType: 'touch' });
  } else if (touch) await page.evaluate((px) => document.getElementById('log').scrollBy(0, -px), px);
  else { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -px); }
}
async function followCase(h, page, touch) {
  await h.rule({ who: 'main', when: '/stream long/.test(c.since)', reply: { content: para(70), size: 18, ms: 18 } });
  if (touch) { await page.fill('#input', 'stream long please'); await page.click('#send'); } else await h.send('stream long please');
  await page.waitForFunction(() => { const l = document.getElementById('log'); return l.scrollHeight > l.clientHeight + 400; }, null, T);
  // Rule 1: at the end, it follows.
  for (let i = 0; i < 3; i++) { await page.waitForTimeout(150); const g = await geo(page); assert.ok(g.gap <= 4, 'follows at the end: ' + JSON.stringify(g)); }
  // A small scroll up (under the old 60 px "near the end" band) stops following at once.
  await scrollUp(h, page, 40, touch);
  await page.waitForTimeout(250);
  const a = await geo(page); await page.waitForTimeout(600); const b = await geo(page);
  assert.ok(await streaming(page), 'still streaming during the check');
  assert.ok(Math.abs(b.top - a.top) <= 1 && b.gap > a.gap, 'not pulled back down: ' + JSON.stringify({ a, b }));
  await page.waitForSelector('#below:not([hidden])', T);
  // The pill resumes following.
  await page.click('#below');
  await page.waitForTimeout(500);
  for (let i = 0; i < 2; i++) { await page.waitForTimeout(200); const g = await geo(page); assert.ok(g.gap <= 4, 'follows again after the pill: ' + JSON.stringify(g)); }
  await h.idle(); await page.waitForTimeout(200);
  assert.ok((await geo(page)).gap <= 4, 'ends at the end');
  return a.gap;
}
await section('scroll-follow', async (h, page) => {
  const g = await followCase(h, page, false);
  ok(`scroll: follows at the end; a 40 px wheel up mid-stream stops following (${Math.round(g)} px from the end, not pulled back); the pill resumes`);
});
await section('scroll-touch', async (h, page) => {
  const g = await followCase(h, page, true);
  ok(`scroll (390 px touch): a finger drag up mid-stream stops following (${Math.round(g)} px from the end); the pill resumes`);
}, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: BROWSER === 'chromium' });

await section('scroll-reasoning', async (h, page) => {
  await page.evaluate(() => { const c = document.getElementById('reasoning-expanded'); c.checked = true; c.onchange(); });
  await h.rule({ who: 'main', when: '/warm up/.test(c.since)', reply: para(14) });
  await h.send('warm up'); await h.settled();
  await h.rule({ who: 'main', when: '/think long/.test(c.since)', reply: { reasoning: para(40, 'reasoning'), content: para(12), size: 18, ms: 12 } });
  await h.send('think long please');
  await page.waitForFunction(() => document.querySelector('#log .msg details.reasoning[open] .thinking')?.textContent.length > 1200, null, T);
  // While it streams: a capped box showing the newest lines, with no scroll box of its own.
  const live = [];
  for (let i = 0; i < 3; i++) { live.push(await geo(page, '#log .msg details.reasoning .thinking')); await page.waitForTimeout(120); }
  for (const g of live) {
    assert.ok(g.h > g.ch + 20, 'capped while streaming: ' + JSON.stringify(g));
    assert.ok(g.gap <= 2, 'shows the newest reasoning (follows inside): ' + JSON.stringify(g));
    assert.equal(g.ov, 'hidden', 'no inner scroll box to trap a wheel or finger');
  }
  // A wheel over the live block scrolls the thread.
  await page.evaluate(() => document.querySelector('#log .msg details.reasoning').scrollIntoView({ block: 'center' }));
  const box = await page.locator('#log .msg details.reasoning .thinking').boundingBox();
  const t0 = (await geo(page)).top;
  await page.mouse.move(box.x + 20, box.y + box.height / 2); await page.mouse.wheel(0, -120); await page.waitForTimeout(300);
  assert.ok((await geo(page)).top < t0 - 20, 'wheel over the reasoning scrolls the thread');
  await h.idle();
  const done = await geo(page, '#log .msg details.reasoning .thinking');
  assert.ok(done.h <= done.ch + 1, 'done: full height, no inner scroll box: ' + JSON.stringify(done));
  ok(`scroll: streaming reasoning is a ${Math.round(live[0].ch)} px box showing its newest lines, overflow hidden (no nested scroller), the wheel over it scrolls the thread; done, it is full height`);
});

await section('scroll-anchor', async (h, page) => {
  await h.rule({ who: 'main', when: '/warm up/.test(c.since)', reply: para(14) });
  await h.send('warm up'); await h.settled();
  await h.rule({ who: 'main', when: '/think then write/.test(c.since)', reply: { reasoning: para(10, 'reasoning'), content: para(50), size: 18, ms: 20 } });
  await h.send('think then write');
  await page.waitForFunction(() => document.querySelector('#log .msg:last-of-type details.reasoning')?.textContent && /of the long reply/.test(document.querySelector('#log .msg:last-of-type .md, #log .msg:last-of-type .body')?.textContent ?? ''), null, T);
  await page.waitForTimeout(300);
  const sum = page.locator('#log .msg:last-of-type details.reasoning > summary');
  // Measured in the same task as the click: while following, the stream moves it up before that.
  const clickAt = () => page.evaluate(() => { const s = document.querySelector('#log .msg:last-of-type details.reasoning > summary'); const y = s.getBoundingClientRect().y; s.click(); return [y, document.querySelector('#log .msg:last-of-type details.reasoning > summary').getBoundingClientRect().y]; });
  const [y0, y1] = await clickAt(); await page.waitForTimeout(600); const y2 = (await sum.boundingBox()).y;
  assert.ok(await streaming(page), 'still streaming');
  assert.ok(await page.evaluate(() => document.querySelector('#log .msg:last-of-type details.reasoning').open), 'opened');
  assert.ok(Math.abs(y1 - y0) <= 2 && Math.abs(y2 - y0) <= 2, `summary stays put while the reply streams on: ${y0} ${y1} ${y2}`);
  const [y4, y3] = await clickAt();
  assert.ok(Math.abs(y3 - y4) <= 2, `closing keeps it too: ${y4} ${y3}`);
  await h.idle();
  ok(`scroll: opening and closing a reasoning block mid-stream keeps its summary in place (moved ${Math.round(Math.abs(y2 - y0))} px)`);
});

await section('scroll-nested', async (h, page) => {
  await h.rule({ who: 'main', when: '/helper/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'helper', task: 'Help.' }]] });
  await h.rule({ who: 'main', when: '/Started subagent/.test(c.since)', reply: [['subagent', { action: 'join', ids: ['s2'] }]] });
  await h.rule({ who: 'helper', reply: [['bash', { command: 'echo a' }]] });
  await h.rule({ who: 'helper', when: '/a/.test(c.since)', reply: para(30, 'report') });
  await h.rule({ who: 'main', when: '/report/.test(c.since)', reply: para(20) });
  await h.send('start a helper'); await h.settled();
  await page.click('#log .subagent details.sa-log > summary');
  const inner = '#log .subagent .sa-items';
  await page.waitForSelector(inner, T);
  const g = await geo(page, inner);
  assert.notEqual(g.osb, 'contain', 'the inline transcript lets the thread take over at its end');
  await page.evaluate((s) => { const n = document.querySelector(s); n.scrollIntoView({ block: 'center' }); n.scrollTop = n.scrollHeight; }, inner);
  const t0 = (await geo(page)).top;
  const box = await page.locator(inner).boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2); await page.mouse.wheel(0, 200); await page.waitForTimeout(400);
  assert.ok((await geo(page)).top > t0 + 20, 'wheel past the inner end scrolls the thread');
  ok(`scroll: the inline subagent transcript (overscroll ${g.osb}) hands the wheel to the thread at its end`);
});

// ── C: subagent framing: breadcrumbs, frame in the agent's hue, motion, Esc and Back ──
async function spawnHelper(h, page) {
  await h.rule({ who: 'main', when: '/helper/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'helper', task: 'Help with the essay.' }]] });
  await h.rule({ who: 'main', when: '/Started subagent/.test(c.since)', reply: 'Started helper in the background.' });
  await h.rule({ who: 'helper', reply: [['bash', { command: 'echo a' }]] });
  await h.rule({ who: 'helper', gate: 'helperDone', reply: 'Helper report: fine.' });
  await h.send('start a helper'); await h.settled();
  await page.waitForSelector('#log .subagent button[aria-label="Open subagent helper"]', T);
}
const inChild = (page) => page.evaluate(() => document.getElementById('log').classList.contains('child-view'));
await section('frame', async (h, page) => {
  await spawnHelper(h, page);
  await page.evaluate(() => { window.__anims.length = 0; });
  await page.fill('#input', 'a draft for main');
  await page.click('#log .subagent button[aria-label="Open subagent helper"]');
  await page.waitForSelector('#log.child-view .sa-crumbs', T);
  // Breadcrumbs: <session title> > helper, the first a link back.
  const crumbs = await page.evaluate(() => [...document.querySelectorAll('.sa-crumbs li')].map((li) => ({ t: li.textContent.trim(), link: !!li.querySelector('a, button'), cur: li.querySelector('[aria-current="page"]') != null })));
  const title = (await page.textContent('#title')).trim();
  assert.equal(crumbs.length, 2, JSON.stringify(crumbs));
  assert.ok(crumbs[0].link && crumbs[0].t.includes(title.slice(0, 12)), 'parent crumb is the session title, a link: ' + JSON.stringify(crumbs));
  assert.ok(crumbs[1].cur && /helper/.test(crumbs[1].t), 'current crumb is the subagent');
  // The frame: the whole chat column, composer included, in the helper's hue.
  const f = await page.evaluate(() => {
    const card = document.querySelector('#log .sa-view-head'), chat = document.getElementById('chat'), form = document.getElementById('composer');
    const probe = (n) => { const p = document.createElement('i'); p.style.color = 'var(--agent)'; n.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
    return { agent: probe(card), chat: probe(chat), shadow: getComputedStyle(chat).boxShadow, ring: getComputedStyle(chat, '::after').boxShadow, form: getComputedStyle(form).borderTopColor, cls: chat.className };
  });
  assert.ok(/in-child/.test(f.cls), 'the chat column is marked');
  assert.equal(f.chat, f.agent, 'the frame uses the agent hue');
  assert.ok((f.ring + f.shadow).includes(f.agent), 'a ring in that hue: ' + JSON.stringify(f));
  assert.equal(f.form, f.agent, 'the composer carries the frame');
  // Motion: zoom in from the card (transform/opacity only).
  const opened = await h.anims('^child-open$');
  assert.equal(opened.length, 1, 'one open animation: ' + JSON.stringify(await h.anims('.')));
  assert.ok(/scale/.test(opened[0].kf) && !/height|width|top|left/.test(opened[0].kf.replace(/transform-origin/g, '')), 'transform/opacity only: ' + opened[0].kf);
  // Drafts are per view: the child's box starts empty; main's draft waits.
  assert.equal(await page.inputValue('#input'), '');
  await page.fill('#input', 'a steer for helper');
  // Esc pops out (no popover open), toward the card; the drafts trade places.
  await page.press('#input', 'Escape');
  await page.waitForFunction(() => !document.getElementById('log').classList.contains('child-view'), null, T);
  assert.equal(await page.inputValue('#input'), 'a draft for main');
  assert.ok(!(await page.evaluate(() => document.getElementById('chat').className)).includes('in-child'));
  assert.equal((await h.anims('^child-close$')).length, 1, 'pop-out motion');
  // Back pops out too, without leaving the page.
  await page.click('#log .subagent button[aria-label="Open subagent helper"]');
  await page.waitForSelector('#log.child-view', T);
  assert.equal(await page.inputValue('#input'), 'a steer for helper', 'the child draft was kept');
  const u0 = page.url();
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById('log').classList.contains('child-view'), null, T);
  assert.equal(page.url(), u0);
  assert.ok(await page.isVisible('#log .subagent'), 'still on the page, the card in view');
  // The parent crumb pops out as well.
  await page.click('#log .subagent button[aria-label="Open subagent helper"]');
  await page.click('.sa-crumbs li:first-child a, .sa-crumbs li:first-child button');
  assert.ok(!(await inChild(page)));
  await h.gate('helperDone'); await h.settled();
  ok(`frame: crumbs "${crumbs.map((c) => c.t).join(' > ')}", chat column and composer ringed in the helper's hue (${f.agent}), zoom in from the card and out toward it, Esc, Back and the parent crumb pop out, drafts kept per view`);
});
await section('frame-reduced', async (h, page) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await spawnHelper(h, page);
  await page.evaluate(() => { window.__anims.length = 0; });
  await page.click('#log .subagent button[aria-label="Open subagent helper"]');
  await page.waitForSelector('#log.child-view', T);
  const marked = await page.evaluate(() => document.getElementById('chat').classList.contains('still-mark'));
  assert.ok(marked, 'a brief highlight instead');
  assert.equal((await h.anims('^child-')).length, 0, 'no motion');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('log').classList.contains('child-view'), null, T);
  await h.gate('helperDone'); await h.settled();
  ok('frame (reduced motion): opens and pops out instantly with a highlight, no animation');
});

// ── D: click outside and Esc dismiss every popover where that is safe ──
const vis = (page, sel) => page.isVisible(sel);
const dlgOpen = (page, id) => page.evaluate((id) => document.getElementById(id).open, id);
// Outside: a point on the chat log well away from any popover.
async function clickOutside(page) { const b = await page.locator('#log').boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + 60); }
async function clickBackdrop(page) { await page.mouse.click(4, 400); }
await section('dismiss', async (h, page) => {
  const done = [];
  // Shield popover.
  await page.click('#shield-btn'); await page.waitForSelector('#shield-pop:not([hidden])', T);
  await clickOutside(page); assert.equal(await vis(page, '#shield-pop'), false, 'shield: outside');
  await page.click('#shield-btn'); await page.waitForSelector('#shield-pop:not([hidden])', T);
  await page.focus('#input'); await page.keyboard.press('Escape'); assert.equal(await vis(page, '#shield-pop'), false, 'shield: Esc (focus in the composer)');
  done.push('shield');
  // Completion (@ / $): the typed text stays.
  await page.fill('#input', '@'); await page.waitForSelector('#ac:not([hidden])', T);
  await clickOutside(page); assert.equal(await vis(page, '#ac'), false, 'completion: outside');
  assert.equal(await page.inputValue('#input'), '@', 'completion: the text stays');
  await page.fill('#input', '/ne'); await page.waitForSelector('#ac:not([hidden])', T);
  await page.press('#input', 'Escape'); assert.equal(await vis(page, '#ac'), false, 'completion: Esc');
  assert.equal(await page.inputValue('#input'), '/ne');
  await page.fill('#input', '');
  done.push('completion');
  // Folder action sheet (and every sheet: revert, confirmations).
  await h.files();
  await page.click('#tree [data-path="/work"] .more, #tree .row[data-path="/work"] button.more').catch(async () => page.click('#tree button.more >> nth=0'));
  await page.waitForFunction(() => document.getElementById('sheet').open, null, T);
  await clickBackdrop(page); assert.equal(await dlgOpen(page, 'sheet'), false, 'sheet: outside');
  await page.click('#tree button.more >> nth=0'); await page.waitForFunction(() => document.getElementById('sheet').open, null, T);
  await page.keyboard.press('Escape'); assert.equal(await dlgOpen(page, 'sheet'), false, 'sheet: Esc');
  done.push('folder sheet');
  // The key sheet: dismissed, its typed key comes back on reopening.
  await page.click('#auth'); await page.waitForFunction(() => document.getElementById('sheet').open, null, T);
  await page.fill('#sheet input', 'sk-bayleaf-typed');
  await clickBackdrop(page); assert.equal(await dlgOpen(page, 'sheet'), false, 'key sheet: outside');
  await page.click('#auth'); await page.waitForFunction(() => document.getElementById('sheet').open, null, T);
  assert.equal(await page.inputValue('#sheet input'), 'sk-bayleaf-typed', 'key sheet: the draft is kept');
  await page.keyboard.press('Escape'); assert.equal(await dlgOpen(page, 'sheet'), false, 'key sheet: Esc');
  await page.click('#auth'); await page.waitForFunction(() => document.getElementById('sheet').open, null, T);
  assert.equal(await page.inputValue('#sheet input'), 'sk-bayleaf-typed', 'key sheet: kept after Esc too');
  await page.keyboard.press('Escape');
  done.push('key sheet (draft kept)');
  // Split send menu, while a turn runs; Esc closes it and does not stop the turn.
  await h.rule({ who: 'main', when: '/slow/.test(c.since)', gate: 'slowDone', reply: 'Slow done.' });
  await h.send('slow'); await h.busy();
  await page.waitForSelector('#sendmode:not([hidden])', T);
  await page.click('#sendmode-more'); await page.waitForSelector('#sendmode-menu:not([hidden])', T);
  await clickOutside(page); assert.equal(await vis(page, '#sendmode-menu'), false, 'split menu: outside');
  await page.click('#sendmode-more'); await page.waitForSelector('#sendmode-menu:not([hidden])', T);
  await page.keyboard.press('Escape'); assert.equal(await vis(page, '#sendmode-menu'), false, 'split menu: Esc');
  assert.equal(await page.textContent('#send-label'), 'Stop', 'Esc on the menu did not stop the turn');
  await h.gate('slowDone'); await h.settled();
  done.push('split menu');
  // Egress approval: dismissing answers Deny, the answer that sends nothing.
  await h.rule({ who: 'main', when: '/search it/.test(c.since)', reply: [['bash', { command: 'bayleaf web search walkable towns' }]] });
  await h.rule({ who: 'main', when: '/denied|not sent|declined|refused|deny/i.test(c.since)', reply: 'Not sent.' });
  await h.send('search it');
  await page.waitForFunction(() => document.getElementById('egress').open, null, T);
  await clickBackdrop(page);
  assert.equal(await dlgOpen(page, 'egress'), false, 'egress: outside answers Deny');
  await h.settled();
  await h.rule({ who: 'main', when: '/search again/.test(c.since)', reply: [['bash', { command: 'bayleaf web search shade trees' }]] });
  await h.rule({ who: 'main', when: '/denied|not sent|declined|refused|deny/i.test(c.since)', reply: 'Not sent.' });
  await h.send('search again');
  await page.waitForFunction(() => document.getElementById('egress').open, null, T);
  await page.keyboard.press('Escape'); assert.equal(await dlgOpen(page, 'egress'), false, 'egress: Esc answers Deny');
  await h.settled();
  done.push('egress (Deny)');
  // The key sheet while its check is in flight: kept open, and it says why.
  await h.context.route('https://api.bayleaf.dev/usage', async (r) => { await new Promise((res) => setTimeout(res, 1500)); r.fulfill({ json: { budgets: [{ provider: 'sealed', remaining: 400, limit: 500 }] } }); });
  await page.click('#auth'); await page.waitForFunction(() => document.getElementById('sheet').open, null, T);
  await page.fill('#sheet input', 'sk-bayleaf-abc123'); await page.click('#sheet button[type="submit"]');
  await page.waitForTimeout(150); await clickBackdrop(page);
  assert.equal(await dlgOpen(page, 'sheet'), true, 'key check in flight: kept open');
  assert.match(await page.textContent('#sheet .keep-note'), /Checking the key/);
  await page.waitForFunction(() => !document.getElementById('sheet').open, null, T);
  done.push('key sheet mid-check (kept, says why)');

  ok('dismiss: ' + done.join(', '));
});
await section('dismiss-phone', async (h, page) => {
  await page.click('#flipper'); await page.waitForFunction(() => document.getElementById('app').classList.contains('side-open'), null, T);
  await page.mouse.click(370, 400);
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('side-open'), null, T);
  await page.click('#flipper'); await page.waitForFunction(() => document.getElementById('app').classList.contains('side-open'), null, T);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('side-open'), null, T);
  ok('dismiss (phone): the sessions drawer closes on a tap outside and on Esc');
}, { viewport: { width: 390, height: 844 }, hasTouch: true });

// ── Round 3 critique items ──
const ESSAY_LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the essay.`);
await section('critique', async (h, page) => {
  const done = [];
  await h.rule({ who: 'main', when: '/setup/.test(c.since)', reply: [['write', { path: '/work/essay.md', content: ESSAY_LINES.join('\n') + '\n' }]] });
  await h.rule({ who: 'main', when: '/Wrote|Successfully|bytes/i.test(c.since)', reply: 'ok.' });
  await h.send('setup'); await h.settled();
  await h.files();
  // 8: the folder sheet has no default-looking action.
  await page.click('#tree button.more >> nth=0'); await page.waitForFunction(() => document.getElementById('sheet').open, null, T);
  assert.equal(await page.locator('#sheet-actions button.primary').count(), 0, 'no primary action in the folder sheet');
  await page.keyboard.press('Escape');
  done.push('8 folder sheet neutral');
  await page.click('#tree .row[data-path="/work/essay.md"]');
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Line 12'), null, T);
  // 10: "Pouch is editing..." while a write to the open file streams in.
  await h.rule({ who: 'main', when: '/rewrite/.test(c.since)', reply: { content: '', then: [['write', { path: 'essay.md', content: ESSAY_LINES.map((l) => l + ' Rewritten with care and a little more length.').join('\n') + '\n' }]], size: 12, ms: 15 } });
  await h.rule({ who: 'main', when: '/Wrote|Successfully|bytes/i.test(c.since)', reply: 'Rewritten.' });
  await page.evaluate(() => { const i = document.getElementById('input'); i.value = 'rewrite it'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#send');
  await page.waitForSelector('#editor-busy:not([hidden])', T);
  await h.settled();
  assert.equal(await page.isVisible('#editor-busy'), false, 'gone once written');
  done.push('10 editing indicator');
  // 2 and 3: the conflict, its diff and its status.
  await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.type(' MINE');
  await h.rule({ who: 'main', when: '/tweak/.test(c.since)', reply: [['edit', { path: '/work/essay.md', oldText: 'Line 10 of', newText: 'Line 10 (THEIRS) of' }]] });
  await h.rule({ who: 'main', when: '/Successfully|Edited|replaced/i.test(c.since)', reply: 'Tweaked.' });
  await page.evaluate(() => { const i = document.getElementById('input'); i.value = 'tweak line 10'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#send'); await h.settled();
  await page.waitForSelector('#conflict-bar:not([hidden])', T);
  await page.click('#save');
  await page.waitForSelector('#editor-status:not([hidden])', T);
  const st = await page.evaluate(() => ({ ed: document.getElementById('editor-status').textContent, inPane: !!document.getElementById('editor-status').closest('#editor-pane'), chat: document.getElementById('status').textContent }));
  assert.ok(/Not saved/.test(st.ed) && st.inPane && !/Not saved/.test(st.chat), 'conflict status in the editor pane: ' + JSON.stringify(st));
  await page.click('#conflict-diff');
  await page.waitForSelector('.cm-deletedChunk', T);
  const d = await page.evaluate(() => {
    const c = document.querySelector('.cm-deletedChunk');
    return { showDiff: document.getElementById('conflict-diff').hidden, before: getComputedStyle(c, '::before').content, after: getComputedStyle(c, '::after').content,
      strike: getComputedStyle(c.querySelector('.cm-deletedLine')).textDecorationLine, banner: document.getElementById('review-text').textContent };
  });
  assert.equal(d.showDiff, true, 'Show diff hidden while the diff is open');
  assert.match(d.before, /Pouch's version/); assert.match(d.after, /Your version/);
  assert.equal(d.strike, 'line-through'); assert.match(d.banner, /struck through/);
  while (await page.locator('.cm-deletedChunk .cm-chunkButtons button[name="accept"]').count()) await page.locator('.cm-deletedChunk .cm-chunkButtons button[name="accept"]').first().click();
  await page.click('#save');
  await page.waitForFunction(() => document.getElementById('conflict-bar').hidden, null, T);
  assert.equal(await page.isVisible('#editor-status'), false, 'no stale "Not saved" after the save');
  done.push('2 editor status cleared', '3 diff labels, strike, Show diff hidden');
  // 1: Usage fits its drawer.
  await page.click('#rail [data-panel="usage"]');
  await page.waitForSelector('#usage-body table.tokens', T);
  const u = await page.evaluate(() => { const t = document.querySelector('#usage-body table.tokens'), p = document.getElementById('usage-body'); const pr = p.getBoundingClientRect(); return { tw: t.getBoundingClientRect().right, pr: pr.right, cells: [...t.querySelectorAll('th, td')].every((c) => c.getBoundingClientRect().right <= pr.right + 0.5), cols: t.rows[0].cells.length }; });
  assert.ok(u.tw <= u.pr + 0.5 && u.cells, 'the table fits the drawer: ' + JSON.stringify(u));
  done.push(`1 usage table fits (${u.cols} columns)`);
  // 6: titled even with a steer in the first turn.
  await page.click('#new-top');
  await page.waitForFunction(() => /New session/.test(document.getElementById('title').textContent), null, T);
  const t0 = await page.evaluate(() => window.__titles ?? 0);
  await h.rule({ who: 'main', when: '/first task/.test(c.since)', gate: 'first', reply: 'First done.' });
  await h.rule({ who: 'main', when: '/side note/.test(c.since)', reply: 'Noted.' });
  await h.send('first task: analyze /'); await h.busy();
  await h.send('side note'); await page.waitForTimeout(300);
  await h.gate('first'); await h.settled(); await page.waitForTimeout(500);
  assert.ok((await page.evaluate(() => window.__titles ?? 0)) > t0, 'a title was asked for');
  assert.match(await page.textContent('#title'), /Merging Monthly/);
  done.push('6 titled after a steer');
  ok('critique: ' + done.join('; '));
});
await section('critique-phone', async (h, page) => {
  await h.rule({ who: 'main', when: '/helper/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'sales-analyst', task: 'Analyze the sales.' }]] });
  await h.rule({ who: 'main', when: '/Started subagent/.test(c.since)', reply: 'Started.' });
  await h.rule({ who: 'sales-analyst', reply: 'Sales report: up 4%.' });
  await page.fill('#input', 'start a helper'); await page.click('#send'); await h.settled();
  await page.waitForFunction(() => document.querySelector('#log .subagent .sa-status')?.textContent === 'finished', null, T);
  await page.click('#log .subagent button[aria-label="Open subagent sales-analyst"]');
  await page.waitForSelector('#log.child-view .sa-crumbs', T);
  await page.waitForTimeout(350); // the zoom-in (200 ms) scales what it measures
  const g = await page.evaluate(() => {
    const name = document.querySelector('.sa-crumbs .sa-name');
    return { full: name.scrollWidth <= name.clientWidth + 1, stats: getComputedStyle(document.querySelector('.sa-bar .sa-stats')).display, status: document.querySelector('.sa-view-head .sa-status').textContent,
      composer: getComputedStyle(document.getElementById('composer')).display, dbg: (() => { const e = document.querySelector('.sa-ended'); return e && [getComputedStyle(e).display, getComputedStyle(e).position, e.querySelector('button')?.getBoundingClientRect().height, e.parentElement.id]; })(), ended: document.querySelector('.sa-ended')?.textContent ?? '', endedH: document.querySelector('.sa-ended')?.getBoundingClientRect().height ?? 0 };
  });
  assert.ok(g.full, 'the name is not cut'); assert.equal(g.stats, 'none', 'stats moved under Details');
  assert.equal(g.status, 'finished'); assert.match(g.ended, /sales-analyst finished/);
  assert.equal(g.composer, 'none', 'no disabled composer'); assert.ok(g.endedH < 70 && g.endedH >= 40, 'a compact bar: ' + JSON.stringify(g));
  ok(`critique (phone): "sales-analyst" uncut, stats under Details, "finished" everywhere, one ${Math.round(g.endedH)} px ended bar instead of the disabled composer`);
}, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: BROWSER === 'chromium' });

// SECTIONS

server.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} checks passed (${BROWSER})` + (failed.length ? `, FAILED: ${failed.join(', ')}` : ''));
process.exit(failed.length ? 1 : 0);
