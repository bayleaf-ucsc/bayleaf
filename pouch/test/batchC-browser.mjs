// Batch C regressions in the real page, on the scripted fake (test/graph-fixture.js; no
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
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-batchC-'));
const video = process.env.POUCH_VIDEO;

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
  const context = await chromium.launchPersistentContext(join(scratch, 'profile' + (++profiles)), { headless: true, viewport: { width: 1280, height: 800 }, ...ctxOpts });
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
async function section(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  errors.length = 0;
  const h = await open();
  try { await fn(h, h.page); assert.deepEqual(errors, [], 'page errors: ' + errors.join('\n')); }
  catch (e) {
    failed.push(name); console.log('FAIL', name, e.message.split('\n').slice(0, 6).join('\n'));
    await h.page.screenshot({ path: join(process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots', `batchC-${name}-fail.png`) }).catch(() => {});
    console.log('unmatched:', JSON.stringify(await h.page.evaluate(() => window.fake?.unmatched?.slice(-6)).catch(() => null)));
  } finally { await h.context.close().catch(() => {}); }
}

// ── Bug 2: run inside a subagent namespace (play-test: four harness errors) ──
await section('subrun', async (h, page) => {
  await h.rule({ who: 'main', when: '/setup/.test(c.since)', reply: [['write', { path: '/work/data/m.csv', content: 'month,amount\njan,3\nfeb,4\n' }]] });
  await h.rule({ who: 'main', when: '/Wrote|Successfully|bytes/i.test(c.since)', reply: 'ok.' });
  await h.send('setup'); await h.settled();
  await h.rule({ who: 'main', when: '/sum it/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'totals', task: 'Sum amounts.' }]] });
  await h.rule({ who: 'main', when: '/Started subagent/.test(c.since)', reply: [['subagent', { action: 'join', ids: ['s2'] }]] });
  await h.rule({ who: 'main', when: '/TOTAL/.test(c.since)', reply: 'Done.' });
  await h.rule({ who: 'totals', reply: [['read', { path: '/work/nope.txt' }], ['run', { code: 'const t = fs.readFile("data/m.csv"); print("inline", t.split("\\n").length);' }]] });
  await h.rule({ who: 'totals', when: '/inline/.test(c.since)', reply: [['write', { path: '/work/.subagents/t.js', content: 'const rows = fs.readFile("/work/data/m.csv").trim().split("\\n").slice(1); let s = 0; for (const r of rows) s += Number(r.split(",")[1]); fs.writeFile("/work/data/totals.txt", String(s)); print("sum", s);' }]] });
  await h.rule({ who: 'totals', when: '/Wrote|Successfully|bytes/i.test(c.since)', reply: [['run', { path: '/work/.subagents/t.js', files: ['/work/data'] }]] });
  await h.rule({ who: 'totals', when: '/sum 7/.test(c.since)', reply: 'TOTAL 7 written to /work/data/totals.txt' });
  await h.send('sum it'); await h.settled();
  const sub = await page.evaluate(() => window.fake.requests.totals.map((b) => b.messages.filter((m) => m.role === 'tool').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' | ')).join('\n'));
  assert.match(sub, /inline 4/, 'inline run in a subagent works: ' + sub.slice(0, 600));
  assert.match(sub, /sum 7/, 'file run in a subagent works: ' + sub.slice(0, 600));
  assert.match(sub, /created \/work\/data\/totals.txt/, 'its write landed');
  const meta = await page.textContent('#log .subagent[data-child] .sa-meta');
  assert.match(meta, /1 tool error\b/, 'card counts tool errors: ' + meta);
  ok('bug 2: run inside a subagent namespace: inline code and a script file both work, writes land');
});

// ── Bug 1: a folder watch set before the folder exists wakes on a UI upload ──
// As in the play-test: main watches /work/data (absent), the user makes the
// folder in Files, then uploads three CSVs in one picker. One wake, all three.
for (const [name, pat] of [['watchdir', '/work/data'], ['watchglob', '/work/data/*.csv']]) await section(name, async (h, page) => {
  await h.rule({ who: 'main', when: '/merge my monthly/.test(c.since)', reply: [['watch', { action: 'watch', paths: [pat], by: 'user', note: 'merge the CSVs when they arrive' }]] });
  await h.rule({ who: 'main', when: '/Watching|w1/.test(c.since)', reply: 'I will pick them up automatically.' });
  await h.send('merge my monthly CSVs; they are not uploaded yet'); await h.settled();
  await h.files();
  await page.locator('[aria-label="Actions for work"]').dispatchEvent('click');
  await page.click('#sheet-actions button >> text=New folder here');
  await page.fill('#name-input', 'data'); await page.press('#name-input', 'Enter');
  await page.waitForSelector('#tree .row[data-path="/work/data"]', { ...T, state: 'attached' });
  await page.locator('[aria-label="Actions for data"]').dispatchEvent('click');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', T), page.click('#sheet-actions button >> text=Upload files here')]);
  await chooser.setFiles(['jan', 'feb', 'mar'].map((m) => ({ name: m + '.csv', mimeType: 'text/csv', buffer: Buffer.from('date,amount\n2026-01-01,3\n') })));
  await page.waitForFunction(() => /Added 3 files in \/work\/data/.test(document.body.textContent), null, T);
  await page.waitForFunction(() => window.fake.requests.main.some((b) => b.messages.some((m) => /\[from files\]/.test(JSON.stringify(m.content)))), null, { timeout: 10000 });
  await h.settled();
  const wakes = await page.evaluate(() => window.fake.requests.main.map((b) => b.messages.filter((m) => /\[from files\]/.test(JSON.stringify(m.content))).length).filter(Boolean));
  const text = await page.evaluate(() => JSON.stringify(window.fake.requests.main.at(-1).messages.filter((m) => /\[from files\]/.test(JSON.stringify(m.content)))));
  for (const m of ['jan', 'feb', 'mar']) assert.match(text, new RegExp(`data/${m}\\.csv`), 'wake names ' + m + ': ' + text);
  assert.equal(new Set(wakes).size === 1 && wakes[0], 1, 'one wake message: ' + JSON.stringify(wakes));
  ok(`bug 1 (${pat}): watch set before the folder existed; New folder + 3-file upload in one picker woke main once, naming jan, feb and mar`);
});

// ── Bug 3: Save in the conflict diff commits the resolution, no native dialog ──
const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the essay.`);
await section('diffsave', async (h, page) => {
  await h.rule({ who: 'main', when: '/setup/.test(c.since)', reply: [['write', { path: '/work/essay.md', content: LINES.join('\n') + '\n' }]] });
  await h.rule({ who: 'main', when: '/Wrote|Successfully|bytes/i.test(c.since)', reply: 'ok.' });
  await h.send('setup'); await h.settled();
  await h.files();
  await page.click('#tree .row[data-path="/work/essay.md"]');
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Line 12'), null, T);
  // The user edits line 2 (unsaved); then Pouch edits line 10.
  await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.type(' MINE');
  await h.rule({ who: 'main', when: '/tweak/.test(c.since)', reply: [['edit', { path: '/work/essay.md', oldText: 'Line 10 of', newText: 'Line 10 (THEIRS) of' }]] });
  await h.rule({ who: 'main', when: '/Successfully|Edited|replaced/i.test(c.since)', reply: 'Tweaked.' });
  await page.evaluate(() => { const i = document.getElementById('input'); i.value = 'tweak line 10'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#send'); await h.settled();
  await page.waitForSelector('#conflict-bar:not([hidden])', T);
  await page.click('#conflict-diff');
  await page.waitForSelector('.cm-deletedChunk .cm-chunkButtons button', T);
  assert.equal(await page.locator('.cm-deletedChunk').count(), 2, 'two hunks');
  // Controls sit in a header bar above the hunk, not over its text.
  const geo = await page.evaluate(() => [...document.querySelectorAll('.cm-deletedChunk')].map((d) => {
    const b = d.querySelector('.cm-chunkButtons').getBoundingClientRect(), t = d.querySelector('.cm-deletedLine, del')?.getBoundingClientRect();
    return { pos: getComputedStyle(d.querySelector('.cm-chunkButtons')).position, overlap: !!t && b.bottom > t.top + 1 && b.top < t.bottom - 1 };
  }));
  assert.ok(geo.every((g) => g.pos !== 'absolute' && !g.overlap), 'hunk controls in a header bar: ' + JSON.stringify(geo));
  // Save with both hunks unresolved: no dialog, nothing written, the bar says what is left.
  const cat = async () => {
    await h.rule({ who: 'main', when: '/catit/.test(c.since)', reply: [['bash', { command: 'cat /work/essay.md' }]] });
    await h.rule({ who: 'main', when: '/Line 1 of/.test(c.since)', reply: 'Shown.' });
    await page.evaluate(() => { const i = document.getElementById('input'); i.value = 'catit'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#send'); await h.settled();
    return page.evaluate(() => { const b = window.fake.requests.main.at(-1); return b.messages.filter((m) => m.role === 'tool').at(-1).content; }).then((c) => typeof c === 'string' ? c : JSON.stringify(c));
  };
  await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+s');
  await page.waitForTimeout(300);
  assert.deepEqual(errors.filter((e) => /^dialog/.test(e)), [], 'no native dialog on Save in diff view');
  assert.match(await page.textContent('#review-bar'), /2 changes/, 'bar says 2 changes are unsettled: ' + await page.textContent('#review-bar'));
  let disk = await cat();
  assert.match(disk, /Line 10 \(THEIRS\)/, 'Pouch version not discarded'); assert.doesNotMatch(disk, /MINE/, 'not overwritten before settling');
  // Keep mine on line 2, take theirs on line 10, then Cmd/Ctrl+S: both land.
  await page.locator('.cm-deletedChunk').first().locator('button[name=accept]').click();
  await page.locator('.cm-deletedChunk').first().locator('button[name=reject]').click();
  assert.equal(await page.locator('.cm-deletedChunk').count(), 0, 'both settled');
  await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+s');
  await page.waitForSelector('#review-bar[hidden]', { state: 'attached', timeout: 5000 }).catch(async (e) => { throw new Error('bar still: ' + await page.textContent('#review-bar') + ' chunks ' + await page.locator('.cm-deletedChunk').count()); });
  disk = await cat();
  assert.match(disk, /Line 2 of the essay\. MINE/, 'mine kept: ' + disk.slice(0, 300));
  assert.match(disk, /Line 10 \(THEIRS\)/, 'theirs taken: ' + disk.slice(0, 400));
  assert.equal(await page.locator('#save').isDisabled(), true, 'clean after save');
  ok('bug 3: Cmd/Ctrl+S in the conflict diff raises no dialog; with hunks unsettled it writes nothing and says so; settled, it saves the merged result (mine + theirs) and leaves the diff; hunk controls in a header bar');
});

// ── Bug 4: Enter right after Stop never loses the typed text ──
// As in the play-test: main waits on a foreground subagent; the user types,
// Stop all is pressed, and Enter follows at once (real key presses).
// A Sealed request takes a while to wind down after abort: the fake's held
// requests reject 1.2 s after their signal fires, as a real stream might.
const SLOW_ABORT = `(() => { const f = window.fake.fetch; window.fake.fetch = (u, init) => {
  const ac = new AbortController();
  init.signal?.addEventListener('abort', () => setTimeout(() => ac.abort(), 1200), { once: true });
  return f(u, { ...init, signal: ac.signal });
}; })()`;
async function check(h, page, settledNow = false) {
  const st = await page.evaluate(() => ({
    input: document.getElementById('input').value,
    log: [...document.querySelectorAll('#log .msg.user')].map((n) => n.textContent).join(' | '),
    tray: document.getElementById('tray-list')?.textContent ?? '',
    sent: (window.fake.requests.main ?? []).some((b) => JSON.stringify(b.messages).includes('essay title OK')),
  }));
  // A steer still waiting for "the current step" of a run that was stopped is limbo, not kept.

  if (settledNow) assert.doesNotMatch(st.tray, /essay title OK\?Steering/, 'not left steering a stopped run: ' + st.tray);
  const kept = /essay title OK/.test(st.input) || /essay title OK/.test(st.tray) || (/essay title OK/.test(st.log) && st.sent);
  assert.ok(kept, 'text kept or committed: ' + JSON.stringify(st));
  ok(`bug 4: Enter right after Stop keeps the text (${/essay title OK/.test(st.input) ? 'box' : /essay title OK/.test(st.tray) ? 'tray: ' + st.tray.slice(0, 120) : 'sent'})`);
}
for (const [name, stopper, delay, inreq] of [['enterstop', 'tray', 0], ['enterstopesc', 'esc', 0], ['enterstopbtn', 'button', 0], ['enterstop50', 'tray', 50], ['enterstop300', 'tray', 300], ['enterstop900', 'tray', 900], ['enterstopguard', 'guard', 0], ['enterstopguard2', 'guard2', 0], ['enterinreq', 'tray', 0, true], ['enterinreq300', 'tray', 300, true], ['enterinreqesc', 'esc', 0, true]]) await section(name, async (h, page) => {
  await page.evaluate(SLOW_ABORT);
  if (inreq) { // main is in a model request (its subagent done), not blocked
    await h.rule({ who: 'main', when: '/fg job/.test(c.since)', reply: [['bash', { command: 'echo step' }]] });
    await h.rule({ who: 'main', when: '/step/.test(c.since)', gate: 'never', reply: 'never' });
    await h.rule({ who: '*', sticky: true, reply: 'ok' });
    await h.send('fg job');
    await page.waitForFunction(() => window.fake.requests.main?.length >= 2, null, T);
    await page.waitForTimeout(300);
    await page.click('#input');
    await page.keyboard.type('Meanwhile: is the essay title OK?', { delay: 5 });
    if (stopper === 'tray') await page.click('.tray-stop >> text=/Stop all/').catch(() => page.click('#send'));
    else await page.keyboard.press('Escape');
    if (delay) await page.waitForTimeout(delay);
    await page.press('#input', 'Enter');
    await page.waitForTimeout(6000); // the stopped run has wound down by now
    return check(h, page, true);
  }
  await h.rule({ who: 'main', when: '/fg job/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'summary', task: 'Summarize.', background: false }]] });
  await h.rule({ who: 'summary', gate: 'never', reply: 'never' });
  await h.rule({ who: '*', sticky: true, reply: 'ok' });
  await h.send('fg job');
  await page.waitForFunction(() => document.querySelectorAll('.tray-row[data-kind="subagent"]').length >= 1, null, T);
  await page.waitForTimeout(400);
  await page.click('#input');
  await page.keyboard.type('Meanwhile: is the essay title OK?', { delay: 5 });
  if (stopper === 'tray') await page.click('.tray-stop >> text=/Stop all/');
  else if (stopper === 'esc') await page.keyboard.press('Escape');
  else if (stopper === 'guard') { // the tester's guard: every "Stop all", then every "Stop", 500 ms each
    for (const name of [/^Stop all$/, /^Stop$/]) { const b = page.getByRole('button', { name }); const n = await b.count(); for (let i = 0; i < n; i++) await b.nth(i).click({ timeout: 500 }).catch(() => {}); }
  } else if (stopper === 'guard2') { // the same guard racing the tester's Enter
    const rows = await page.$$eval('.tray-row .tray-stop', (b) => b.length);
    await page.click('.tray-stop >> text=/Stop all/');
    await page.press('#input', 'Enter');
    for (const b of await page.getByRole('button', { name: /^Stop$/ }).all()) await b.click({ timeout: 500 }).catch(() => {});
  }
  else await page.click('#send');
  if (delay) await page.waitForTimeout(delay);
  if (stopper !== 'guard2') await page.press('#input', 'Enter'); // focus back in the box, as the tester's harness did
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({
    input: document.getElementById('input').value,
    log: [...document.querySelectorAll('#log .msg.user')].map((n) => n.textContent).join(' | '),
    tray: document.getElementById('tray-list')?.textContent ?? '',
    sent: (window.fake.requests.main ?? []).some((b) => JSON.stringify(b.messages).includes('essay title OK')),
  }));
  // A steer still waiting for "the current step" of a run that was stopped is limbo, not kept.
  const kept = /essay title OK/.test(st.input) || /essay title OK/.test(st.tray) || (/essay title OK/.test(st.log) && st.sent);
  assert.ok(kept, 'text kept or committed: ' + JSON.stringify(st));
  ok(`bug 4 (${stopper}, Enter after ${delay} ms): Enter right after Stop keeps the text in the box, the tray or the transcript (${/essay title OK/.test(st.input) ? 'box' : /essay title OK/.test(st.tray) ? 'tray' : 'sent'})`);
});

// ── Bug 6: a steer during a running bash waits for it; output and steer both reach the model ──
for (const [name, how, secs] of [['steerbash', 'enter', 4], ['steerbashnow', 'steer-now', 4], ['steerbashplay', 'play', 40]]) await section(name, async (h, page) => {
  await h.rule({ who: 'main', when: '/long one/.test(c.since)', reply: [['bash', { command: `sleep ${secs}; echo slept` }]] });
  await h.rule({ who: 'main', when: '/reply with only OK/.test(c.since)', reply: 'OK' });
  await h.send('run the long one');
  await page.waitForFunction(() => window.fake.requests.main?.length >= 1, null, T);
  await page.waitForTimeout(800);
  const t0 = Date.now();
  if (how === 'enter') await h.send('Q1: after this, reply with only OK.');
  else if (how === 'steer-now') {
    await h.send('Q1: after this, reply with only OK.', 'Alt+Enter'); // queued
    await page.click('.tray-row button[data-act="promote"]');
  } else { // the tester's sequence (LOG 3.3): queue, Edit, re-queue, Steer now, queue Q2, Cancel it
    await h.send('Q1: after this', 'Alt+Enter');
    await page.click('.tray-row button[data-act="edit"]');
    await page.fill('#input', 'Q1: after this, reply with only OK.'); await page.press('#input', 'Alt+Enter');
    await page.click('.tray-row button[data-act="promote"]');
    await h.send('Q2', 'Alt+Enter');
    await page.click('.tray-row[data-kind="queued"] .tray-stop');
  }
  await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, { timeout: (secs + 15) * 1000 });
  await h.settled();
  const req = await page.evaluate(() => JSON.stringify(window.fake.requests.main.at(-1).messages.slice(-4)));
  const took = await page.evaluate(() => window.fake.requests.main.length);
  assert.match(req, /slept/, 'the bash output reached the model: ' + req.slice(0, 500));
  assert.match(req, /reply with only OK/, 'the steer reached the model');
  assert.ok(Date.now() - t0 > secs * 1000 - 1500, 'the sleep ran its course: ' + (Date.now() - t0) + ' ms');
  assert.equal(took, 2, 'two requests: the call, then output + steer together');
  ok(`bug 6 (${how}): a steer during "sleep ${secs}; echo slept" waited for it; the next request carried the output "slept" and the steer`);
});

// ── Bug 7: one name for Stop across layouts (the tester's guard looked for "Stop"/"Stop all") ──
for (const [name, vp] of [['stopnames', { width: 1280, height: 800 }], ['stopnamesphone', { width: 390, height: 844 }]]) await section(name, async (h, page) => {
  await page.setViewportSize(vp);
  await h.rule({ who: 'main', when: '/just me/.test(c.since)', gate: 'g1', reply: 'done' });
  await h.send('just me'); await h.busy();
  const names = async () => page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent && /stop/i.test(b.getAttribute('aria-label') ?? b.textContent)).map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()));
  let n = await names();
  assert.ok(n.includes('Stop') && !n.some((x) => /Stop Pouch/.test(x)), 'main alone: "Stop": ' + JSON.stringify(n));
  assert.equal(await page.getAttribute('#send', 'aria-keyshortcuts'), 'Escape');
  await h.gate('g1'); await h.settled();
  await h.rule({ who: 'main', when: '/fg job/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'summary', task: 'Summarize.', background: false }]] });
  await h.rule({ who: 'summary', gate: 'g2', reply: 'summary done' });
  await h.rule({ who: '*', sticky: true, reply: 'ok' });
  await h.send('fg job');
  await page.waitForFunction(() => document.querySelectorAll('.tray-row[data-kind="subagent"]').length >= 1, null, T);
  await page.waitForTimeout(300);
  n = await names();
  assert.equal(await page.getAttribute('#send', 'aria-label'), 'Stop all', 'composer button with a subagent running: ' + JSON.stringify(n));
  assert.ok(await page.getByRole('button', { name: /^Stop all$/ }).count() >= 1);
  await h.gate('g2'); await h.settled();
  ok(`bug 7 (${vp.width}px): composer Stop is named "Stop" (main alone) or "Stop all" (with subagents), Esc as aria-keyshortcuts; never "Stop Pouch (Esc)"`);
});

// ── Bug 5: Usage accounts for every billed request and reconciles with the allowance ──
await section('usage', async (h, page) => {
  // The campus allowance drops by every request the fake answered (including
  // ones a Stop cut short), every title, and 3 from elsewhere on the network.
  await h.context.route('https://api.bayleaf.dev/campus-pass', async (r) => {
    const n = await page.evaluate(() => Object.values(window.fake?.requests ?? {}).reduce((a, l) => a + l.length, 0) + (window.__titles ?? 0)).catch(() => 0);
    r.fulfill({ json: { campus_network: true, enabled: true, quota: { remaining: 400 - n - (n ? 3 : 0), limit: 500, approximate: true } } });
  });
  await page.evaluate(() => document.getElementById('usage-refresh').click());
  await page.waitForTimeout(300);
  await h.rule({ who: 'main', when: '/list it/.test(c.since)', reply: [['bash', { command: 'ls /work' }]] });
  await h.rule({ who: 'main', when: '/\(no files\)|^$|work/.test(c.since)', reply: 'Listed.' });
  await h.send('list it'); await h.settled();
  // A request that is stopped mid-flight still counts.
  await h.rule({ who: 'main', when: '/slow/.test(c.since)', gate: 'never', reply: 'never' });
  await h.send('slow'); await h.busy(); await page.waitForTimeout(300);
  await page.click('#send'); await h.settled();
  // A background subagent that is stopped.
  await h.rule({ who: 'main', when: '/helper/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'helper', task: 'Help.' }]] });
  await h.rule({ who: 'main', when: '/Started subagent/.test(c.since)', reply: 'Started.' });
  await h.rule({ who: 'helper', reply: [['bash', { command: 'echo a' }]] });
  await h.rule({ who: 'helper', gate: 'never', reply: 'never' });
  await h.send('start a helper');
  await page.waitForFunction(() => window.fake.requests.helper?.length >= 2, null, T);
  await page.evaluate(() => document.querySelector('#log .subagent .sa-acts button[aria-label^="Stop"]')?.click());
  await h.settled(); await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('usage-refresh').click());
  await page.waitForTimeout(500);
  await page.click('#rail [data-panel="usage"]');
  await page.waitForSelector('#usage-body table.tokens', T);
  await page.waitForTimeout(300);
  const t = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#usage-body table.tokens tbody tr')].map((tr) => ({ cls: tr.className, cells: [...tr.cells].map((c) => c.textContent), w: tr.cells[0].getBoundingClientRect().width })),
    sent: Object.values(window.fake.requests).reduce((a, l) => a + l.length, 0), titles: window.__titles ?? 0,
  }));
  const num = (x) => Number(String(x).replace(/,/g, '')) || 0;
  const sessionRows = t.rows.filter((r) => !/total|other/.test(r.cls));
  const total = t.rows.find((r) => /total/.test(r.cls)), other = t.rows.find((r) => /other/.test(r.cls));
  const delta = t.sent + t.titles + 3;
  assert.ok(total, 'a total row: ' + JSON.stringify(t.rows));
  assert.equal(sessionRows.reduce((a, r) => a + num(r.cells[1]), 0), t.sent + t.titles, 'session rows count every request Pouch sent: ' + JSON.stringify(t));
  assert.equal(num(other?.cells[1]), 3, 'other = what the allowance lost beyond that');
  assert.equal(num(total.cells[1]), delta, 'total = allowance delta');
  assert.match(total.cells[0], new RegExp(`allowance down ${delta}\\b`));
  for (const r of sessionRows) assert.ok(r.w >= 100 && !/^\w\.$/.test(r.cells[0].trim()), 'title readable: ' + JSON.stringify(r));
  ok(`bug 5: Usage counts all ${t.sent + t.titles} requests Pouch sent (${t.sent} model incl. a stopped one and a stopped subagent's, ${t.titles} title) plus Other 3, total ${delta} = allowance delta; titles at least ${Math.min(...sessionRows.map((r) => Math.round(r.w)))} px`);
});

// ── Design: stopped-subagent wording, child view at top, overlay sidebar, D12, new-reply pill ──
await section('design', async (h, page) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await h.rule({ who: 'main', when: '/helper/.test(c.since)', reply: [['subagent', { action: 'spawn', name: 'helper', task: 'Help with a long task.' }]] });
  await h.rule({ who: 'main', when: '/Started subagent/.test(c.since)', reply: 'Started.' });
  await h.rule({ who: 'helper', reply: 'Partial thought about the task.' });
  await h.rule({ who: 'main', when: '/Partial thought/.test(c.since)', reply: [['subagent', { action: 'message', to: 's2', text: 'Keep going.' }]] });
  await h.rule({ who: 'main', when: '/Sent|sent|delivered/i.test(c.since)', reply: 'Asked it to continue.' });
  await h.rule({ who: 'helper', gate: 'never', reply: 'never' });
  await h.rule({ who: '*', sticky: true, when: '!/Partial/.test(c.since)', reply: 'ok' });
  await h.send('start a helper');
  await page.waitForFunction(() => window.fake.requests.helper?.length >= 2, null, T);
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#log .subagent .sa-acts button[aria-label^="Stop"]')?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('#log .msg.report')].some((m) => /stopped/.test(m.textContent)), null, T);
  const rep = await page.evaluate(() => [...document.querySelectorAll('#log .msg.report')].map((m) => m.getAttribute('aria-label') + ' | ' + m.textContent).join('\n'));
  assert.match(rep, /Last output before stop:/, 'stopped report labeled: ' + rep);
  await h.settled(); await h.send('and now?'); await h.settled(); // the report reaches the model with the next request
  const said = await page.evaluate(() => JSON.stringify(window.fake.requests.main.flatMap((b) => b.messages)).includes('work in progress, not a report'));
  assert.ok(said, 'the model is told it is work in progress');
  // Open its view: at the top, task header visible; the composer says it was stopped.
  await page.evaluate(() => document.querySelector('#log .subagent .sa-acts button[aria-label^="Open"]')?.click());
  await page.waitForSelector('#log.child-view .sa-view-head', T);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.getElementById('log').scrollTop), 0, 'opens at the top');
  assert.match(await page.getAttribute('#input', 'placeholder'), /helper was stopped\./);
  assert.match(await page.textContent('#log'), /helper was stopped; its last output went to/);
  await page.click('.sa-back');
  await h.settled();
  // Desktop overlay sidebar: scrim, Esc back to the composer, typing never lost.
  if ((await page.getAttribute('#app', 'data-panel')) !== 'files') await page.click('#rail [data-panel="files"]');
  if ((await page.getAttribute('#flipper', 'aria-expanded')) !== 'true') await page.click('#flipper');
  const overlaid = await page.evaluate(() => document.getElementById('app').classList.contains('side-overlay'));
  if (overlaid) {
    assert.equal(await page.isVisible('#backdrop'), true, 'scrim shown');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('backdrop')).pointerEvents), 'none', 'the scrim never eats a click');
    await page.keyboard.press('Escape');
    assert.equal(await page.getAttribute('#flipper', 'aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'input', 'focus back in the composer');
    await page.click('#flipper');
    await page.focus('#session-list [tabindex], #session-list button');
    await page.keyboard.type('hi');
    assert.equal(await page.inputValue('#input'), 'hi', 'typed into the composer');
    assert.equal(await page.getAttribute('#flipper', 'aria-expanded'), 'false', 'overlay closed by typing');
    await page.fill('#input', '');
  }
  // D12: revert to your own message: reverted to just before it, its text back in the box.
  await h.rule({ who: 'main', when: '/second message/.test(c.since)', reply: 'Second reply.' });
  await h.send('second message'); await h.settled();
  const u = page.locator('#log .msg.user', { hasText: 'second message' }).last();
  await u.hover();
  await u.locator('button[aria-label^="Revert to here"]').click();
  assert.match(await page.textContent('#sheet'), /goes back into the box/);
  await page.click('#sheet-actions button >> text=Revert');
  await page.waitForFunction(() => document.getElementById('input').value === 'second message', null, T);
  assert.equal(await page.locator('#log .msg.user:not(.branch *)', { hasText: 'second message' }).count() <= 1, true);
  // New content below while scrolled up: the pill.
  await page.fill('#input', '');
  await page.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); });
  await h.rule({ who: 'main', when: '/third/.test(c.since)', reply: 'Third reply.\n\n' + 'line\n\n'.repeat(40) });
  await page.evaluate(() => { const i = document.getElementById('input'); i.value = 'third'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => { document.getElementById('send').click(); document.getElementById('log').scrollTop = 0; });
  await h.settled();
  const below = await page.isVisible('#below');
  if (below) { await page.click('#below'); await page.waitForTimeout(600); assert.equal(await page.isVisible('#below'), false); }
  ok(`design: stopped subagent "Last output before stop" (model told work in progress), view opens at top with "was stopped"; overlay sidebar ${overlaid ? 'scrim, Esc to composer, typing lands in the box' : 'not overlaid at 900px (skipped)'}; D12 revert on a user message puts it back in the box; new-reply pill ${below ? 'shown and cleared' : 'not triggered'}`);
});

server.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} checks passed` + (failed.length ? `, FAILED: ${failed.join(', ')}` : ''));
process.exit(failed.length ? 1 : 0);
