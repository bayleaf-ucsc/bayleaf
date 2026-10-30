// Batch B in the real page, on the scripted fake (test/graph-fixture.js; no
// Sealed request is ever made): continuity color (seeded hues, the same hue
// across sidebar, card, tray and sender tag, contrast in both themes), motion
// (steer FLIP into the transcript, reduced motion, detach fold, watch pulse,
// editor flash), the collapsed subagent header with no bleed, the expanded
// card box, readable agent pills, the trust panel layout, desktop overlay
// sidebar and placeholder, conversation-only revert, change review gone, and
// a steer racing the turn's end is never lost.
// Run: node test/batchB-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
// Videos: POUCH_VIDEO=/tmp/pouch-qa/motion records the steer and detach parts.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchB-'));
const video = process.env.POUCH_VIDEO;

const stub = `
import { createFake, panelRules } from './test/graph-fixture.js';
window.fake = createFake(); window.panelRules = panelRules;
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
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

async function open(ctxOpts = {}) {
  const context = await chromium.launchPersistentContext(join(scratch, 'profile'), { headless: true, viewport: { width: 1280, height: 800 }, ...ctxOpts });
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname === '/usage') return r.fulfill({ json: { sealed: { remaining: 400, limit: 500 } } });
    if (u.pathname.includes('usage') || u.pathname === '/campus-pass') return r.fulfill({ json: {} });
    return r.abort();
  });
  await context.addInitScript(OLD_DB);
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
  h.settled = async () => { await h.idle(); await page.waitForTimeout(500); await h.idle(); };
  return h;
}

let h = await open();
let { page } = h;
try {
  // ── Migration and no change review ──
  const stores = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('bayleaf-pouch'); r.onsuccess = () => { res({ v: r.result.version, s: [...r.result.objectStoreNames] }); r.result.close(); }; }));
  assert.equal(stores.v, 4); assert.ok(!stores.s.includes('changes'), 'changes store deleted: ' + stores.s);
  await h.rule({ who: 'main', when: '/setup/.test(c.since)', reply: [['write', { path: '/work/essay.md', content: ESSAY }]] });
  await h.rule({ who: 'main', when: '/Wrote|Successfully|bytes/i.test(c.since)', reply: 'Wrote essay.md.' });
  await h.send('setup the essay'); await h.settled();
  assert.equal(await page.$$eval('#log .changes, #tree .changed-dot, #review-restore', (n) => n.length), 0, 'no change blocks, tree dots or restore');
  ok(`profile v3 upgraded to v4 without the changes store; an agent write shows no "Changed N files", no tree dot`);

  // ── G2-G7 panel with judges held: color identity across surfaces ──
  await page.evaluate(() => window.panelRules(window.fake, { judgeGate: () => 'hold' }));
  await h.send('review this draft with the panel');
  await page.waitForFunction(() => ['argument', 'evidence', 'clarity', 'audience'].every((j) => window.fake.requests['judge-' + j]?.length >= 1) && window.fake.requests.chair?.length >= 2, null, T);
  if ((await page.getAttribute('#flipper', 'aria-expanded')) !== 'true') await page.click('#flipper');
  await page.waitForFunction(() => document.querySelectorAll('#session-list .s-child').length === 5 && document.querySelectorAll('.tray-row[data-kind="subagent"]').length >= 5, null, T);
  const hues = await page.evaluate(() => {
    const kids = [...document.querySelectorAll('#log .subagent[data-child]')];
    return kids.map((card) => {
      const id = card.dataset.child, name = card.querySelector('.sa-name').textContent;
      const side = [...document.querySelectorAll('#session-list .s-child')].find((r) => r.dataset.child === id);
      const tray = document.querySelector(`.tray-row[data-key="sa:${CSS.escape(id)}"]`);
      return { name, seed: card.style.getPropertyValue('--seed'), card: getComputedStyle(card).borderLeftColor,
        side: side && getComputedStyle(side.querySelector('.sa-dot')).backgroundColor, sideSeed: side?.style.getPropertyValue('--seed'),
        tray: tray && getComputedStyle(tray.querySelector('svg')).color, traySeed: tray?.style.getPropertyValue('--seed') };
    });
  });
  assert.equal(hues.length, 5, JSON.stringify(hues));
  for (const x of hues) {
    assert.ok(x.seed && x.seed === x.sideSeed && x.seed === x.traySeed, 'one seed per agent: ' + JSON.stringify(x));
    assert.ok(x.card === x.side && x.card === x.tray, 'same color on card edge, sidebar dot and tray icon: ' + JSON.stringify(x));
  }
  assert.deepEqual(hues.map((x) => x.seed), ['2', '3', '4', '5', '6'], 'seed = spawn order');
  assert.equal(new Set(hues.map((x) => x.card)).size, 5, 'five distinct colors');
  ok(`G4-G6 identity: seeds = spawn order (s2-s6), five distinct hues, each the same on card edge, sidebar dot and tray row (${hues.map((x) => x.name + ' ' + x.card).join('; ')})`);

  // Contrast: seeds 1-12, both themes; text 4.5:1 on bg, surface, side and the tint; dots 3:1.
  const contrast = async (theme) => page.evaluate((theme) => {
    const de = document.documentElement, was = de.dataset.theme;
    de.dataset.theme = theme;
    const cv = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }), cx = cv.getContext('2d', { willReadFrequently: true });
    const px = (...layers) => { cx.clearRect(0, 0, 1, 1); for (const c of layers) { cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); } return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const probe = document.createElement('div'); document.body.append(probe);
    const bgOf = (v) => { probe.style.cssText = `background: var(${v})`; return getComputedStyle(probe).backgroundColor; };
    const bgs = { bg: bgOf('--bg'), surface: bgOf('--surface'), side: bgOf('--side') };
    let minText = 99, minDot = 99, worst = '';
    for (let n = 1; n <= 12; n++) {
      probe.style.cssText = ''; probe.style.setProperty('--seed', String(n));
      const s = document.createElement('span'); s.style.cssText = 'color: var(--agent); background: var(--agent-tint)'; probe.replaceChildren(s);
      const agent = getComputedStyle(s).color, tint = getComputedStyle(s).backgroundColor;
      const a = px(agent);
      for (const [k, b] of Object.entries({ ...bgs, tint: null })) {
        const back = b ? px(b) : px(bgs.surface, tint);
        const r = ratio(a, back);
        if (r < minText) { minText = r; worst = `seed ${n} on ${k}`; }
        if (b) minDot = Math.min(minDot, r);
      }
    }
    probe.remove(); de.dataset.theme = was ?? '';
    if (!was) delete de.dataset.theme;
    return { minText: +minText.toFixed(2), minDot: +minDot.toFixed(2), worst };
  }, theme);
  const light = await contrast('light'), dark = await contrast('dark');
  assert.ok(light.minText >= 4.5 && dark.minText >= 4.5, `text contrast: light ${JSON.stringify(light)} dark ${JSON.stringify(dark)}`);
  assert.ok(light.minDot >= 3 && dark.minDot >= 3);
  ok(`contrast, seeds 1-12: light text min ${light.minText}:1 (${light.worst}), dark text min ${dark.minText}:1 (${dark.worst}); dots/edges min ${light.minDot} / ${dark.minDot}`);

  // Release the judges; the panel completes.
  await h.gate('hold');
  await page.waitForFunction(() => /Say which to apply/.test([...document.querySelectorAll('#log .msg.assistant .body')].at(-1)?.textContent ?? ''), null, { timeout: 30000 });
  await h.settled();

  // Pills in words (critique 9) and the join summary in color.
  const pills = await page.$$eval('#log details.tool > summary .what', (n) => n.map((x) => x.textContent));
  assert.ok(pills.some((p) => /^subagent: message -> chair \(s2\): "Judges: s3/.test(p)), 'message pill: ' + pills.join(' | '));
  assert.ok(!pills.some((p) => /\{"action"/.test(p)), 'no raw JSON pills');
  // The chair's own compact transcript: join s3-s6.
  await page.click('#log .subagent[data-child] .sa-log > summary');
  await page.waitForSelector('#log .subagent .sa-items', T);
  const chairLines = await page.$$eval('#log .subagent .sa-items .sa-line', (n) => n.map((x) => x.textContent));
  assert.ok(chairLines.some((l) => /agents: join s3-s6/.test(l)), 'join pill: ' + chairLines.join(' | '));
  assert.ok(chairLines.some((l) => /agents: message -> main \(s1\): "Prioritized/.test(l)), 'message to main pill');
  ok(`agent pills read as words: "${pills.find((p) => /message ->/.test(p)).slice(0, 60)}...", "${chairLines.find((l) => /join/.test(l))}"`);

  // Expanded card: its own tinted scroll box with a sticky Collapse bar (critique 5).
  const box = await page.evaluate(() => {
    const it = document.querySelector('#log .subagent .sa-items'), cs = getComputedStyle(it), fold = it.querySelector('.sa-fold');
    it.scrollTop = it.scrollHeight;
    const fr = fold.getBoundingClientRect(), ir = it.getBoundingClientRect();
    return { maxH: cs.maxHeight, overflow: cs.overflowY, bg: cs.backgroundColor, scrolls: it.scrollHeight > it.clientHeight, foldText: fold.textContent, foldTop: Math.round(fr.top - ir.top), sticky: getComputedStyle(fold).position };
  });
  assert.ok(box.maxH !== 'none' && box.overflow === 'auto' && !/rgba\(0, 0, 0, 0\)|transparent/.test(box.bg), JSON.stringify(box));
  assert.ok(box.scrolls && box.sticky === 'sticky' && Math.abs(box.foldTop) <= 1 && /^Collapse chair$/.test(box.foldText), JSON.stringify(box));
  await page.click('#log .subagent .sa-fold');
  assert.equal(await page.$eval('#log .subagent .sa-log', (d) => d.open), false);
  ok(`expanded card: max-height ${box.maxH}, own scroll, tinted ${box.bg}, "Collapse chair" stays at the top while scrolled`);

  // Sender tags in the chair's view carry the sender's hue; header collapses to one bar with no bleed (critique 3).
  await page.click('#session-list .s-child .s-child-open >> text=chair');
  await page.waitForSelector('#log.child-view .sa-view-head', T);
  const tags = await page.evaluate(() => [...document.querySelectorAll('#log .msg-from')].map((t) => ({ t: t.textContent, seed: t.style.getPropertyValue('--seed'), color: getComputedStyle(t).color })));
  const cardOf = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#session-list .s-child')].map((r) => [r.querySelector('.s-child-name').textContent, getComputedStyle(r.querySelector('.sa-dot')).backgroundColor])));
  const ev = tags.find((x) => /judge-evidence \(s4\)/.test(x.t));
  assert.ok(ev && ev.seed === '4' && ev.color === cardOf['judge-evidence'], 'tag tinted like its agent: ' + JSON.stringify({ ev, cardOf }));
  await page.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = 0; });
  await page.waitForTimeout(50);
  const topH = await page.$eval('.sa-view-head', (e) => e.getBoundingClientRect().height);
  await page.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; l.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(80);
  const head = await page.evaluate(() => {
    const hd = document.querySelector('.sa-view-head'), log = document.getElementById('log');
    const r = hd.getBoundingClientRect(), lr = log.getBoundingClientRect();
    const xs = [r.left + 6, (r.left + r.right) / 2, r.right - 12]; // not the panel's resize handle at the edge
    // Every point from the log's top edge down through the bar belongs to the bar: nothing peeks above it.
    const bleed = [];
    for (let y = lr.top; y < r.bottom - 1; y += 3) for (const x of xs) { const e = document.elementFromPoint(x, y); if (!hd.contains(e)) bleed.push(`${Math.round(x)},${Math.round(y)}:${e?.className}`); }
    return { h: r.height, gap: r.top - lr.top, bg: getComputedStyle(hd).backgroundColor, bleed, collapsed: hd.classList.contains('collapsed'), bar: hd.querySelector('.sa-bar').textContent, hidden: getComputedStyle(hd.querySelector('.sa-more')).display };
  });
  assert.ok(head.collapsed && head.h <= 48 && head.hidden === 'none', JSON.stringify(head));
  assert.ok(Math.abs(head.gap) <= 1 && head.bleed.length === 0, 'bleed: ' + JSON.stringify(head));
  assert.match(head.bar, /chair.*done.*req.*Details/);
  assert.ok(!/Use the panel skill|review this draft/.test(head.bar), 'parent named by title, not its first message');
  await page.click('.sa-view-head .sa-more-btn');
  assert.notEqual(await page.$eval('.sa-view-head .sa-more', (e) => getComputedStyle(e).display), 'none');
  await page.click('.sa-view-head .sa-more-btn');
  ok(`subagent view: sender tag "${ev.t}" in judge-evidence's color; header ${Math.round(topH)}px at the top, ${Math.round(head.h)}px bar once scrolled ("${head.bar.replace(/\s+/g, ' ').trim()}"), opaque, flush with the log top, no transcript under any of ${Math.ceil(head.h / 3) * 3} probe points; Details toggles the rest`);
  await page.click('#log .sa-back');

  // ── Trust panel: verdict first, hashes behind Details, mounts stacked (critique 10) ──
  await page.click('#rail [data-panel="trust"]').catch(() => page.click('#shield-btn'));
  await page.waitForSelector('#trust #facts details.facts-more', T);
  const trust = await page.evaluate(() => {
    const d = document.querySelector('#facts details.facts-more'), panel = document.getElementById('trust').getBoundingClientRect();
    const dds = [...document.querySelectorAll('#ns-facts dd pre')];
    return { open: d.open, summary: d.querySelector('summary').textContent, hexVisible: [...document.querySelectorAll('#facts > dd')].some((x) => /[0-9a-f]{40}/.test(x.innerText)),
      ns: getComputedStyle(document.getElementById('ns-facts')).display, overflow: dds.filter((p) => p.getBoundingClientRect().right > panel.right + 1 || p.scrollWidth > p.clientWidth + 1).length, n: dds.length };
  });
  assert.ok(!trust.open && /^Verified/.test(trust.summary) && !trust.hexVisible, JSON.stringify(trust));
  assert.ok(trust.ns === 'block' && trust.n >= 2 && trust.overflow === 0, JSON.stringify(trust));
  ok(`trust panel: "${trust.summary.trim()}" (closed, no hex visible); ${trust.n} namespace blocks stacked, none overflowing`);

  // ── Desktop: sidebar overlays when the chat would drop under 480px; placeholder never clips ──
  await page.click('#rail [data-panel="files"]');
  await page.click('#tree .row[data-path="/work/essay.md"]');
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Walkable'), null, T);
  const lay = await page.evaluate(() => ({ overlay: document.getElementById('app').classList.contains('side-overlay'), side: document.getElementById('app').classList.contains('side-open'), chat: document.getElementById('chat').getBoundingClientRect().width,
    ph: (() => { const i = document.getElementById('input'); return { sh: i.scrollHeight, ch: i.clientHeight, ws: getComputedStyle(i, '::placeholder').whiteSpace }; })() }));
  assert.ok(lay.side && lay.overlay && lay.chat >= 480, JSON.stringify(lay));
  assert.ok(lay.ph.sh <= lay.ph.ch + 2, 'placeholder fits: ' + JSON.stringify(lay.ph));
  ok(`1280px with sessions and editor open: sidebar overlays, chat ${Math.round(lay.chat)}px; empty composer ${lay.ph.ch}px tall holds its placeholder on one line`);

  // ── Editor: an agent edit flashes the changed lines once (R4) ──
  await h.rule({ who: 'main', when: '/flash/.test(c.since)', reply: [['edit', { path: '/work/essay.md', oldText: 'So plan for feet.', newText: 'So plan for feet and bikes.' }]] });
  await h.rule({ who: 'main', when: '/flash/.test(c.all) && /Successfully|Edited|edited|replaced/i.test(c.since)', reply: 'Edited.' });
  await h.send('flash the ending');
  await page.waitForSelector('.cm-line.cm-flash', T);
  const flashed = await page.$$eval('.cm-line.cm-flash', (n) => n.map((x) => x.textContent));
  assert.deepEqual(flashed, ['So plan for feet and bikes.']);
  await h.settled();
  await page.waitForFunction(() => !document.querySelector('.cm-line.cm-flash'), null, T);
  ok(`editor follows the agent's edit and flashes only the changed line ("${flashed[0]}"), then clears`);

  // ── G14 watch wake: the file's tree row pulses once; the woken turn wears the watch accent ──
  await h.rule({ who: 'main', when: '/watch it/.test(c.since)', reply: [['watch', { action: 'watch', paths: ['/work/essay.md'], by: 'user', note: 'offer a re-review' }]] });
  await h.rule({ who: 'main', when: '/Watching/.test(c.since)', reply: 'Watching essay.md.' });
  await h.send('watch it for me'); await h.settled();
  await h.rule({ who: 'main', when: '/\\[from files\\]/.test(c.since)', reply: 'You edited essay.md; want a re-review?' });
  await page.click('.cm-content'); await page.keyboard.press('Control+End'); await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('\nA new line.');
  await page.evaluate(() => document.getElementById('save').click());
  await page.waitForFunction(() => window.__anims.some((a) => a.id === 'pulse:/work/essay.md'), null, T);
  await page.waitForSelector('#log .watch-from', T);
  const labelText = await page.$eval('#log .watch-from', (e) => e.textContent); // the log re-renders: read fresh nodes
  const accent = await page.evaluate(() => { const p = document.createElement('i'); p.style.color = 'var(--watch)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
  assert.equal(await page.$eval('#log .watch-from', (e) => getComputedStyle(e).color), accent);
  await h.settled();
  await h.rule({ who: 'main', when: '/stop watching/.test(c.since)', reply: [['watch', { action: 'unwatch', id: 'w1' }]] });
  await h.rule({ who: 'main', when: '/Stopped watching/.test(c.since)', reply: 'Stopped.' });
  await h.send('stop watching'); await h.settled();
  ok(`watch wake: essay.md's tree row pulsed (animation pulse:/work/essay.md); "${labelText.slice(0, 40)}" in the watch accent ${accent}`);

  // ── D12 revert is conversation-only: later messages fold into a dimmed other branch; files untouched ──
  const before = await page.evaluate(() => document.querySelector('.cm-content').textContent);
  const firstUser = await page.$('#log .msg.user');
  await firstUser.hover();
  await firstUser.$('[data-act="revert"], button[aria-label^="Revert"]').then((b) => b.click());
  await page.waitForSelector('#sheet[open]', T);
  const sheetText = await page.textContent('#sheet-body');
  assert.match(sheetText, /Files stay as they are/); assert.equal(await page.$$eval('#sheet input[type="checkbox"]', (n) => n.length), 0);
  await page.click('#sheet-actions button >> text=Revert');
  await page.waitForSelector('#log details.other-branch', T);
  const branch = await page.textContent('#log details.other-branch > summary');
  assert.equal(await page.evaluate(() => document.querySelector('.cm-content').textContent), before, 'editor text unchanged');
  await page.click('#close-file');
  await page.click('#tree .row[data-path="/work/essay.md"]');
  await page.waitForFunction(() => /feet and bikes\.A new line\./.test(document.querySelector('.cm-content')?.textContent ?? ''), null, T); // reread from disk: kept the later edits
  assert.equal(await page.$$eval('.leaving', (n) => n.length), 0, 'dimmed messages folded away');
  await page.click('#log .notice.reverted button >> text=Undo');
  await page.waitForFunction(() => !document.querySelector('#log details.other-branch'), null, T);
  ok(`revert: sheet says files stay, no checkbox; "${branch}" dimmed and collapsed; essay.md kept its later edits; Undo brings the conversation back`);

  // ── D25 steer delivery: the tray item travels into the transcript (FLIP), its glow fades; Steering status clears ──
  if (video) { await h.context.close(); h = await open({ recordVideo: { dir: join(scratch, 'video'), size: { width: 1280, height: 800 } } }); page = h.page; }
  await h.rule({ who: 'main', when: '/flip test/.test(c.since)', gate: 'g1', reply: [['bash', { command: 'echo step one' }]] });
  await h.rule({ who: 'main', when: '/STEER-FLIP/.test(c.since)', reply: 'Noted your steer.' });
  await h.send('flip test');
  await h.busy();
  await h.send('STEER-FLIP: keep it short');
  await page.waitForSelector('.tray-row[data-kind="steer"]', T);
  assert.match(await page.textContent('#status'), /^Steering/);
  await page.waitForTimeout(400);
  await h.gate('g1');
  await page.waitForFunction(() => window.__anims.some((a) => /^arrive:/.test(a.id ?? '')), null, T);
  const arrive = (await h.anims('^arrive:'))[0], glow = (await h.anims('^glow:'))[0];
  assert.match(arrive.kf, /translate\(/); assert.equal(glow.pseudo, '::after');
  await page.waitForTimeout(1400);
  const landed = await page.evaluate(() => {
    const m = [...document.querySelectorAll('#log .msg')].findLast((n) => /STEER-FLIP/.test(n.textContent));
    const anims = document.getAnimations().filter((a) => /^(arrive|glow):/.test(a.id)).map((a) => a.playState);
    return { label: m?.querySelector('.sa-who')?.textContent, transform: getComputedStyle(m).transform, inLog: !!m?.closest('#log'), running: anims.filter((s) => s === 'running').length, tray: document.querySelectorAll('.tray-row[data-kind="steer"]').length, status: document.getElementById('status').textContent };
  });
  assert.ok(landed.inLog && landed.label === 'You, while it worked' && landed.transform === 'none' && landed.running === 0 && landed.tray === 0, JSON.stringify(landed));
  assert.ok(!/^Steering/.test(landed.status), 'Steering status cleared: ' + landed.status);
  await h.settled();
  ok(`steer delivery: FLIP ${arrive.kf.slice(0, 70)}..., 200 ms, glow on ::after; landed as "${landed.label}" with no transform; tray empty; "Steering..." status cleared`);

  const clip = async (name) => { // close the recording context, keep its video, reopen
    const v = page.video(); await h.context.close();
    mkdirSync(video, { recursive: true }); renameSync(await v.path(), join(video, name));
    h = await open({ recordVideo: { dir: join(scratch, 'video'), size: { width: 1280, height: 800 } } }); page = h.page;
  };
  if (video) await clip('steer-delivery.webm');

  // ── G12 detach: the foreground card folds into its tray row, keeping its hue ──
  await h.rule({ who: 'main', when: '/fold test/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'slowpoke', task: 'Take your time.', background: false }]] });
  await h.rule({ who: 'slowpoke', gate: 'slow', reply: 'Done slowly.' });
  await h.rule({ who: 'main', when: '/background/.test(c.since)', reply: 'It continues in the background.' });
  await h.rule({ who: 'main', when: '/Done slowly/.test(c.since)', reply: 'Slowpoke reported.' });
  await h.send('fold test');
  await page.waitForSelector('.tray-row[data-kind="subagent"] .tray-bg', T);
  await page.click('.tray-row[data-kind="subagent"] .tray-bg');
  await page.waitForFunction(() => window.__anims.some((a) => a.id === 'fold'), null, T);
  const folded = await page.evaluate(() => {
    const row = document.querySelector('.tray-row[data-kind="subagent"]'), card = [...document.querySelectorAll('#log .subagent')].find((c) => /slowpoke/.test(c.textContent));
    return { row: !!row, rowSeed: row?.style.getPropertyValue('--seed'), cardSeed: card?.style.getPropertyValue('--seed'), bg: !!row?.querySelector('.tray-bg'), ghost: document.querySelectorAll('.fold-ghost').length };
  });
  assert.ok(folded.row && folded.rowSeed && folded.rowSeed === folded.cardSeed && !folded.bg, JSON.stringify(folded));
  await page.waitForTimeout(400);
  assert.equal(await page.$$eval('.fold-ghost', (n) => n.length), 0, 'ghost removed');
  await h.idle();
  await h.gate('slow');
  await page.waitForFunction(() => /Slowpoke reported/.test(document.getElementById('log').textContent), null, T);
  await h.settled();
  ok(`detach: the card folded into its tray row (animation "fold", ghost removed), row keeps seed ${folded.rowSeed}, Background gone; it reported later`);

  if (video) { await clip('detach-fold.webm'); }

  // ── Reduced motion: the same moments become a brief static highlight ──
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const n0 = (await h.anims('^arrive:')).length;
  await h.rule({ who: 'main', when: '/still test/.test(c.since)', gate: 'g2', reply: [['bash', { command: 'echo two' }]] });
  await h.rule({ who: 'main', when: '/STEER-STILL/.test(c.since)', reply: 'Noted again.' });
  await h.send('still test'); await h.busy();
  await h.send('STEER-STILL');
  await page.waitForSelector('.tray-row[data-kind="steer"]', T);
  await h.gate('g2');
  const still = await page.waitForFunction(() => [...document.querySelectorAll('#log .msg.still-mark')].find((n) => /STEER-STILL/.test(n.textContent)), null, T);
  assert.ok(still);
  assert.equal((await h.anims('^arrive:')).length, n0, 'no FLIP under reduced motion');
  await page.waitForFunction(() => !document.querySelector('#log .msg.still-mark'), null, T);
  await h.settled();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  ok('reduced motion: no FLIP; the delivered steer gets a static .still-mark highlight for about a second, then plain');

  // ── Send/Stop race: a steer that lands as the turn ends is never lost ──
  await h.rule({ who: 'main', when: '/race test/.test(c.since)', gate: 'g3', reply: 'Finished.' });
  await h.rule({ who: 'main', when: '/RACE-STEER/.test(c.since)', reply: 'Got the late one.' });
  await h.send('race test'); await h.busy();
  await h.send('RACE-STEER');
  await h.gate('g3');
  await page.waitForFunction(() => /Got the late one/.test(document.getElementById('log').textContent), null, T);
  await h.settled();
  const raced = await page.evaluate(() => window.fake.seen('main').split('RACE-STEER').length - 1);
  assert.ok(raced >= 1);
  ok(`race: a steer sent while the final reply was in flight reached main (seen in ${raced} request(s)) and got its own turn; nothing lost`);

  // ── Stop in a session stops its subagents too ──
  await h.rule({ who: 'main', when: '/stop test/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'bg-worker', task: 'Work.' }]] });
  await h.rule({ who: 'main', when: '/Started subagent "bg-worker"/.test(c.since)', gate: 'g4', reply: 'Started.' });
  await h.rule({ who: 'bg-worker', gate: 'never', reply: 'never' });
  await h.send('stop test');
  await page.waitForFunction(() => window.fake.requests['bg-worker']?.length >= 1, null, T);
  await page.click('#send');
  await page.waitForFunction(() => [...document.querySelectorAll('#log .subagent')].some((c) => /bg-worker/.test(c.textContent) && /stopped/.test(c.querySelector('.sa-status').textContent)), null, T);
  await h.idle();
  ok('Stop in the session stopped main and its running subagent bg-worker');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join('\n'));
  ok('no page errors');
} catch (e) {
  await page.screenshot({ path: join(process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots', 'batchB-fail.png') }).catch(() => {});
  console.log('errors:', errors.slice(0, 5));
  console.log('anims:', JSON.stringify(await page.evaluate(() => window.__anims.slice(-4).map((a) => a.id + ' ' + a.cls))));
  console.log('unmatched:', JSON.stringify(await page.evaluate(() => window.fake?.unmatched?.slice(-6)).catch(() => null)));
  throw e;
} finally {
  await h.context.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${passed} checks passed`);
process.exit(0);
