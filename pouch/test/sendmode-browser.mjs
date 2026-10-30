// Steer vs queue (JOURNEYS D25) in the real page, with the scripted fake in
// test/graph-fixture.js bundled in place of Tinfoil: every network request is
// answered locally or aborted, so no Sealed request is ever made. Gates let
// the test decide when each model step ends, so it can check which request
// a message reaches: a steer the next step's (not the one in flight), a
// queued message only the request after the final no-tool reply.
// Run: node test/sendmode-browser.mjs   (PLAYWRIGHT_MODULE overrides where playwright is)
//      POUCH_KEYS_ONLY=1 runs only the cross-browser key check.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-sendmode-'));
const shots = process.env.POUCH_SHOTS || '/tmp/pouch-qa/shots';
mkdirSync(shots, { recursive: true });

const stub = `
import { createFake } from './test/graph-fixture.js';
window.fake = createFake();
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Fake title' } }] }) } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true }; }
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = (n) => ['write', { path: `/work/n${n}.txt`, content: String(n) }];

async function open(browser, { phone = false, name = 'profile' } = {}) {
  const context = await browser.launchPersistentContext(join(scratch, name), { headless: true, viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: phone && browser.name() !== 'firefox', hasTouch: phone });
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    return r.abort();
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (e) => errors.push(`${browser.name()}: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('#badge.ok', T);
  await page.selectOption('#model', 'fake').catch(() => {});
  await page.click('#welcome button >> text=Got it', { timeout: 2000 }).catch(() => {});
  return { context, page };
}
function helpers(page) {
  const h = {
    nReq: (who = 'main') => page.evaluate((w) => window.fake.requests[w]?.length ?? 0, who),
    req: (i, who = 'main') => page.evaluate(([w, i]) => { const b = window.fake.requests[w][i]; return { all: JSON.stringify(b.messages), last: JSON.stringify(b.messages.slice(b.messages.findLastIndex((m) => m.role === 'assistant') + 1)), roles: b.messages.map((m) => m.role) }; }, [who, i]),
    rule: (r) => page.evaluate((r) => { window.fake.rule({ ...r, when: r.when ? new Function('c', 'return ' + r.when) : undefined }); }, r),
    gate: (g) => page.evaluate((g) => { window.fake.gates[g] = true; }, g),
    waitReq: (n, who = 'main') => page.waitForFunction(([w, n]) => (window.fake.requests[w]?.length ?? 0) >= n, [who, n], T),
    idle: () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send' && !document.querySelector('.tray-row[data-kind="steer"]'), null, T),
    type: async (text) => { await page.fill('#input', text); },
    rows: () => page.evaluate(() => [...document.querySelectorAll('#tray-list .tray-row')].map((r) => ({ kind: r.dataset.kind, paused: r.classList.contains('paused'), text: r.querySelector('.tray-text')?.textContent, origin: r.querySelector('.tray-origin')?.textContent, acts: [...r.querySelectorAll('button[data-act]')].map((b) => b.textContent) }))),
    live: () => page.textContent('#send-live'),
  };
  return h;
}

const only = process.env.POUCH_KEYS_ONLY;
let main;
try {
  if (!only) {
    main = await open(pw.chromium);
    const { page } = main, h = helpers(page);

    // 1. Enter steers by default: the next step's request carries it, the in-flight one does not.
    let b = await h.nReq();
    await h.rule({ who: 'main', when: `c.n === ${b + 1}`, gate: 's1a', reply: [W(1)] });
    await h.rule({ who: 'main', when: `c.n === ${b + 2}`, gate: 's1b', reply: 'Done one.' });
    await h.type('task one'); await page.press('#input', 'Enter');
    await h.waitReq(b + 1);
    assert.equal(await page.textContent('#send-label'), 'Stop');
    assert.equal(await page.isHidden('#sendmode'), true, 'no split button with an empty draft');
    await h.type('steer A');
    assert.equal(await page.isVisible('#sendmode'), true, 'split button once the draft is not empty');
    assert.equal(await page.textContent('#sendmode-label'), 'Steer');
    assert.match(await page.getAttribute('#sendmode-main', 'aria-label'), /Steer: .*\(Enter\)\. Alt\+Enter to queue instead/);
    await page.press('#input', 'Enter');
    await page.waitForSelector('.tray-row[data-kind="steer"]', T);
    let rows = await h.rows();
    assert.match(rows.find((r) => r.kind === 'steer').origin, /^Steering · after current step/);
    assert.equal(await page.inputValue('#input'), '');
    await page.waitForFunction(() => /Steering: Pouch reads this after its current step/.test(document.getElementById('send-live').textContent), null, T);
    await h.gate('s1a');
    await h.waitReq(b + 2);
    assert.doesNotMatch((await h.req(b)).all, /steer A/, 'not in the in-flight request');
    assert.match((await h.req(b + 1)).last, /steer A/, 'in the next step\'s request, after the tool result');
    assert.ok((await h.req(b + 1)).roles.includes('tool'));
    await page.waitForFunction(() => !document.querySelector('.tray-row[data-kind="steer"]'), null, T);
    await h.gate('s1b'); await h.idle();
    assert.match(await page.textContent('#log .msg.user.steer'), /You, while it worked[\s\S]*steer A/);
    assert.equal(await h.nReq(), b + 2, 'the steer started no turn of its own');
    ok('Enter steers by default: next step\'s request carries it (not the in-flight one); labeled "You, while it worked"');

    // 2. Alt+Enter queues: it arrives only after the final no-tool reply.
    b = await h.nReq();
    await h.rule({ who: 'main', when: `c.n === ${b + 1}`, gate: 's2a', reply: [W(2)] });
    await h.rule({ who: 'main', when: `c.n === ${b + 2}`, gate: 's2b', reply: [W(3)] });
    await h.rule({ who: 'main', when: `c.n === ${b + 3}`, gate: 's2c', reply: 'Done two.' });
    await h.rule({ who: 'main', when: `c.n === ${b + 4}`, reply: 'Got B.' });
    await h.type('task two'); await page.press('#input', 'Enter');
    await h.waitReq(b + 1);
    await h.type('queue B'); await page.press('#input', 'Alt+Enter');
    await page.waitForSelector('.tray-row[data-kind="queued"]', T);
    rows = await h.rows();
    assert.match(rows.find((r) => r.kind === 'queued').origin, /^Queued · after this turn/);
    assert.deepEqual(rows.find((r) => r.kind === 'queued').acts, ['Edit', 'Steer now', 'Cancel']);
    await page.waitForFunction(() => /Queued for after this turn/.test(document.getElementById('send-live').textContent), null, T);
    assert.equal(await page.inputValue('#input'), '', 'Alt+Enter inserted nothing');
    await h.gate('s2a'); await h.waitReq(b + 2);
    await h.gate('s2b'); await h.waitReq(b + 3);
    for (const i of [b, b + 1, b + 2]) assert.doesNotMatch((await h.req(i)).all, /queue B/);
    await h.gate('s2c'); await h.waitReq(b + 4);
    const q = await h.req(b + 3);
    assert.match(q.last, /queue B/); assert.match(q.all, /Done two\.[\s\S]*queue B/, 'after the final reply');
    await h.idle();
    const qMsg = page.locator('#log .msg.user', { hasText: 'queue B' });
    assert.equal(await qMsg.evaluate((m) => m.classList.contains('steer')), false, 'a queued message starts a normal turn, unlabeled');
    ok('Alt+Enter queues: arrives only in the request after the final no-tool reply, as a normal turn; aria-live announced it');

    // 3. The setting flips both keys; Stop pauses both kinds without sending; paused Send sends.
    const settings = () => page.click('#rail [data-panel="settings"]');
    await settings(); await page.selectOption('#send-mode', 'queue'); await page.locator('#settings .panel-close').click();
    b = await h.nReq();
    await h.rule({ who: 'main', when: `c.n === ${b + 1}`, gate: 'never', reply: [W(4)] });
    await h.type('task three'); await page.press('#input', 'Enter');
    await h.waitReq(b + 1);
    await h.type('x-queued');
    assert.equal(await page.textContent('#sendmode-label'), 'Queue');
    await page.press('#input', 'Enter');
    await h.type('x-steered'); await page.press('#input', 'Alt+Enter');
    await page.waitForSelector('.tray-row[data-kind="steer"]', T);
    rows = await h.rows();
    assert.ok(rows.some((r) => r.kind === 'queued' && /x-queued/.test(r.text)) && rows.some((r) => r.kind === 'steer' && /x-steered/.test(r.text)), 'setting queue: Enter queued, Alt+Enter steered');
    await page.click('#send'); // Stop
    await page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send', null, T);
    await page.waitForSelector('.tray-row.paused', T);
    rows = await h.rows();
    assert.equal(rows.filter((r) => r.kind === 'steer').length, 0);
    const paused = rows.find((r) => r.paused);
    assert.match(paused.origin, /Paused after Stop/); assert.deepEqual(paused.acts, ['Send', 'Cancel']);
    assert.match(await page.getAttribute('.tray-row.paused .tray-text', 'title'), /x-steered\n\nx-queued/);
    await sleep(800);
    assert.equal(await h.nReq(), b + 1, 'Stop sent nothing');
    await page.screenshot({ path: join(shots, 'sendmode-paused.png') });
    await h.rule({ who: 'main', when: `c.n === ${b + 2}`, reply: 'Got both.' });
    await page.click('.tray-row.paused button[data-act="send"]');
    await h.waitReq(b + 2);
    assert.match((await h.req(b + 1)).last, /x-steered[\s\S]*x-queued/);
    await h.idle();
    await settings(); await page.selectOption('#send-mode', 'steer'); await page.locator('#settings .panel-close').click();
    ok('setting Queue flips Enter and Alt+Enter; Stop pauses steer and queued without sending; paused Send sends them as one turn');

    // 4. Split button and menu, by click and keyboard; queued Edit, Alt+Up, Steer now, Cancel, append.
    b = await h.nReq();
    await h.rule({ who: 'main', when: `c.n === ${b + 1}`, gate: 's4a', reply: [W(5)] });
    await h.rule({ who: 'main', when: `c.n === ${b + 2}`, gate: 's4b', reply: 'Done four.' });
    await h.rule({ who: 'main', when: `c.n === ${b + 3}`, reply: 'Got the queue.' });
    await h.type('task four'); await page.press('#input', 'Enter');
    await h.waitReq(b + 1);
    await h.type('menu-q');
    await page.click('#sendmode-more');
    assert.equal(await page.getAttribute('#sendmode-more', 'aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.mode), 'steer', 'focus on the checked item');
    assert.equal(await page.getAttribute('#sendmode-menu [data-mode="steer"]', 'aria-checked'), 'true');
    await page.screenshot({ path: join(shots, 'sendmode-1-split-menu.png') });
    await page.click('#sendmode-menu [data-mode="queue"]');
    await page.waitForSelector('.tray-row[data-kind="queued"]', T);
    await h.type('menu-s');
    await page.focus('#sendmode-more'); await page.keyboard.press('Enter');
    await page.waitForSelector('#sendmode-menu:not([hidden])', T);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.mode), 'queue');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.mode), 'steer');
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#sendmode-menu'), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sendmode-more', 'Esc returns focus to the chevron');
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // open, choose Steer
    await page.waitForSelector('.tray-row[data-kind="steer"]', T);
    await h.type('');
    await page.screenshot({ path: join(shots, 'sendmode-2-tray-queued-steering.png') });
    await page.click('.tray-row[data-kind="queued"] button[data-act="edit"]');
    assert.equal(await page.inputValue('#input'), 'menu-q'); assert.equal((await h.rows()).filter((r) => r.kind === 'queued').length, 0);
    await page.press('#input', 'Alt+Enter');
    await page.waitForSelector('.tray-row[data-kind="queued"]', T);
    await page.focus('#input'); await page.press('#input', 'Alt+ArrowUp');
    assert.equal(await page.inputValue('#input'), 'menu-q', 'Alt+Up took it back'); assert.equal(await page.$('.tray-row[data-kind="queued"]'), null);
    await page.press('#input', 'Alt+Enter');
    await page.waitForSelector('.tray-row[data-kind="queued"]', T);
    await page.click('.tray-row[data-kind="queued"] button[data-act="promote"]');
    await page.waitForFunction(() => !document.querySelector('.tray-row[data-kind="queued"]') && document.querySelectorAll('.tray-row[data-kind="steer"]').length === 2, null, T);
    await h.type('zzz'); await page.press('#input', 'Alt+Enter');
    await page.waitForSelector('.tray-row[data-kind="queued"]', T);
    await page.click('.tray-row[data-kind="queued"] button[data-act="stop"]');
    assert.equal(await page.inputValue('#input'), 'zzz', 'Cancel put it back');
    await h.type('a1'); await page.press('#input', 'Alt+Enter');
    await h.type('a2'); await page.press('#input', 'Alt+Enter');
    await page.waitForFunction(() => /Added to the queued message/.test(document.getElementById('send-live').textContent), null, T);
    assert.equal((await h.rows()).filter((r) => r.kind === 'queued').length, 1, 'one queued slot; the second was appended');
    await h.gate('s4a'); await h.waitReq(b + 2);
    assert.match((await h.req(b + 1)).last, /menu-s[\s\S]*menu-q/, 'both steers in the next step');
    await h.gate('s4b'); await h.waitReq(b + 3);
    assert.match((await h.req(b + 2)).last, /a1\\n\\na2/);
    await h.idle();
    ok('split button and menu by click and keyboard; queued Edit, Alt+Up, Steer now, Cancel; a second queue appends');

    // 5. Behind a foreground spawn: queue shows what main waits on and detaches nothing; steer detaches.
    b = await h.nReq();
    await h.rule({ who: 'main', when: `c.n === ${b + 1}`, reply: [['subagent', { action: 'spawn', name: 'judge-evidence', task: 'Judge the evidence.', background: false }]] });
    await h.rule({ who: 'judge-evidence', gate: 'je', reply: 'Evidence is thin.' });
    await h.rule({ who: 'main', when: `c.n === ${b + 2}`, reply: 'Detached; it keeps working.' });
    await h.rule({ who: 'main', when: `c.n === ${b + 3}`, reply: 'Got the wait.' });
    await h.rule({ who: 'main', when: `c.n === ${b + 4}`, reply: 'Read the report.' });
    await h.type('judge it'); await page.press('#input', 'Enter');
    await page.waitForSelector('.tray-row[data-kind="subagent"] .tray-bg', T);
    await h.type('q-wait'); await page.press('#input', 'Alt+Enter');
    await page.waitForSelector('.tray-row[data-kind="queued"]', T);
    assert.match((await h.rows()).find((r) => r.kind === 'queued').origin, /\(main is waiting on judge-evidence\)/);
    await sleep(500);
    assert.equal(await h.nReq(), b + 1, 'queue did not detach'); assert.ok(await page.$('.tray-row[data-kind="subagent"] .tray-bg'), 'main still waits');
    await h.type('s-detach');
    assert.match(await page.getAttribute('#sendmode-main', 'aria-label'), /Steering will detach judge-evidence/);
    await page.click('#sendmode-more');
    assert.equal(await page.textContent('#sendmode-detach'), 'Steering will detach judge-evidence');
    await page.keyboard.press('Escape');
    await page.press('#input', 'Enter');
    await h.waitReq(b + 2);
    assert.match((await h.req(b + 1)).last, /detached: judge-evidence[\s\S]*s-detach/);
    await h.waitReq(b + 3);
    assert.match((await h.req(b + 2)).last, /q-wait/, 'the queued message went after the detached turn ended');
    await h.gate('je'); await h.waitReq(b + 4);
    assert.match((await h.req(b + 3)).last, /Subagent report/);
    await h.idle();
    ok('queue behind a foreground spawn names what main waits on and detaches nothing; steering detaches it ("Steering will detach")');

    // 6. The user's queued message beats a subagent report pending at the same turn end.
    b = await h.nReq();
    await h.rule({ who: 'main', when: `c.n === ${b + 1}`, reply: [['subagent', { action: 'spawn', name: 'rep', task: 'Report quickly.' }]] });
    await h.rule({ who: 'rep', gate: 'r6', reply: 'rep finished' });
    await h.rule({ who: 'main', when: `c.n === ${b + 2}`, gate: 'm6', reply: 'Main done.' });
    await h.rule({ who: 'main', when: `c.n === ${b + 3}`, reply: 'User first.' });
    await h.rule({ who: 'main', when: `c.n === ${b + 4}`, reply: 'Then the report.' });
    await h.type('spawn rep'); await page.press('#input', 'Enter');
    await h.waitReq(b + 2);
    await h.gate('r6');
    await page.waitForFunction(() => /done/.test(document.querySelector('#session-list .s-child-open .s-child-state')?.textContent ?? ''), null, T).catch(() => {});
    await sleep(400); // the report is now waiting for main
    await h.type('user first'); await page.press('#input', 'Alt+Enter');
    await h.gate('m6'); await h.waitReq(b + 4);
    assert.match((await h.req(b + 2)).last, /user first/); assert.doesNotMatch((await h.req(b + 2)).last, /Subagent report/);
    assert.match((await h.req(b + 3)).last, /Subagent report[\s\S]*rep/);
    await h.idle();
    ok('user queue beats a simultaneous subagent report; the report follows');

    // 7. A steer that lands as the turn ends becomes the next turn, said so, unlabeled.
    b = await h.nReq();
    await h.rule({ who: 'main', when: `c.n === ${b + 1}`, gate: 'm7', reply: 'Done seven.' });
    await h.rule({ who: 'main', when: `c.n === ${b + 2}`, reply: 'Got late.' });
    await h.type('task seven'); await page.press('#input', 'Enter');
    await h.waitReq(b + 1);
    await h.type('late steer'); await page.press('#input', 'Enter');
    await page.waitForSelector('.tray-row[data-kind="steer"]', T);
    await h.gate('m7'); await h.waitReq(b + 2);
    assert.match((await h.req(b + 1)).all, /Done seven\.[\s\S]*late steer/);
    await page.waitForFunction(() => /had finished its turn, so your steering message was sent as the next turn/.test(document.getElementById('send-live').textContent), null, T);
    await h.idle(); await sleep(500);
    assert.equal(await h.nReq(), b + 2, 'no extra turn');
    assert.equal(await page.locator('#log .msg.user', { hasText: 'late steer' }).evaluate((m) => m.classList.contains('steer')), false);
    ok('end-of-run steer race: sent as the next turn, announced, not labeled as mid-turn, nothing lost or doubled');

    // 8. IME composition: Enter while composing is not ours.
    b = await h.nReq();
    await h.type('にほん');
    const sent = await page.evaluate(() => {
      const i = document.getElementById('input');
      i.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const a = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
      i.dispatchEvent(a);
      const c = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      Object.defineProperty(c, 'keyCode', { get: () => 229 });
      i.dispatchEvent(c);
      i.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'にほん' }));
      return a.defaultPrevented || c.defaultPrevented;
    });
    await sleep(400);
    assert.equal(sent, false); assert.equal(await page.inputValue('#input'), 'にほん'); assert.equal(await h.nReq(), b);
    await h.type('');
    ok('IME: Enter during composition (isComposing, keyCode 229) is ignored');

    // 9. A subagent's view: steer reaches it at its next step; queue waits for its turn end.
    b = await h.nReq();
    await h.rule({ who: 'main', when: `c.n === ${b + 1}`, reply: [['subagent', { action: 'spawn', name: 'scout', task: 'Scout the files.' }]] });
    await h.rule({ who: 'main', when: `c.n === ${b + 2}`, reply: 'Scout started.' });
    await h.rule({ who: 'main', sticky: true, when: '/Subagent report/.test(c.since)', reply: 'Noted the report.' });
    await h.rule({ who: 'scout', when: 'c.n === 1', gate: 'c1', reply: [W(9)] });
    await h.rule({ who: 'scout', when: 'c.n === 2', gate: 'c2', reply: 'Scout done.' });
    await h.rule({ who: 'scout', when: 'c.n === 3', reply: 'Got your queued note.' });
    await h.type('spawn scout'); await page.press('#input', 'Enter');
    await h.waitReq(1, 'scout'); await h.idle();
    await page.click('.tray-row[data-kind="subagent"] button.tray-text >> text=scout');
    await page.waitForSelector('#log.child-view .sa-view-head', T);
    assert.equal(await page.textContent('#send-label'), 'Stop');
    await h.type('steer scout'); await page.press('#input', 'Enter');
    await page.waitForSelector('.tray-row[data-kind="steer"]', T);
    assert.match((await h.rows()).find((r) => r.kind === 'steer').origin, /Steering scout · after current step/);
    await h.type('queued for scout'); await page.press('#input', 'Alt+Enter');
    await page.waitForSelector('.tray-row[data-kind="queued"]', T);
    assert.match((await h.rows()).find((r) => r.kind === 'queued').origin, /Queued for scout · after its turn/);
    await h.gate('c1'); await h.waitReq(2, 'scout');
    assert.match((await h.req(1, 'scout')).last, /steer scout/); assert.doesNotMatch((await h.req(1, 'scout')).all, /queued for scout/);
    await h.gate('c2'); await h.waitReq(3, 'scout');
    assert.match((await h.req(2, 'scout')).last, /queued for scout/);
    assert.match(await page.textContent('#log.child-view'), /You, while it worked[\s\S]*steer scout/);
    ok('subagent view: steer reaches it at its next step; queue goes after its turn ends (it works on it)');
    await page.click('.sa-back');
    await h.idle();
    const pageErrors = errors.filter((e) => !/fake/.test(e));
    assert.deepEqual(pageErrors, [], 'no page errors');
    await main.context.close(); main = null;

    // 10. Phone, 390px: one control, every target at least 44px.
    const phone = await open(pw.chromium, { phone: true, name: 'phone' });
    const p = phone.page, ph = helpers(p);
    b = await ph.nReq();
    await ph.rule({ who: 'main', when: `c.n === ${b + 1}`, gate: 'ph', reply: [W(10)] });
    await ph.rule({ who: 'main', when: `c.n === ${b + 2}`, reply: 'Phone done.' });
    await p.fill('#input', 'phone task'); await p.click('#send');
    await ph.waitReq(b + 1);
    await p.fill('#input', 'phone queued'); await p.click('#sendmode-more'); await p.click('#sendmode-menu [data-mode="queue"]');
    await p.waitForSelector('.tray-row[data-kind="queued"]', T);
    await p.fill('#input', 'phone steer');
    const box = async (sel) => (await p.locator(sel).first().boundingBox());
    const small = [];
    for (const sel of ['#send', '#sendmode-main', '#sendmode-more', '.tray-row[data-kind="queued"] button[data-act="edit"]', '.tray-row[data-kind="queued"] button[data-act="promote"]', '.tray-row[data-kind="queued"] button[data-act="stop"]']) {
      const r = await box(sel); if (!r || r.width < 44 || r.height < 44) small.push(`${sel} ${r?.width}x${r?.height}`);
    }
    await p.click('#sendmode-more');
    for (const m of ['steer', 'queue', 'stopsend', 'settings']) { const r = await box(`#sendmode-menu [data-mode="${m}"]`); if (!r || r.height < 44) small.push(`menu ${m} ${r?.height}`); if (r && r.x + r.width > 390) small.push(`menu ${m} off-screen`); }
    const tb = await box('#composer-toolbar'); if (tb.x + tb.width > 391) small.push('toolbar overflows');
    await p.screenshot({ path: join(shots, 'sendmode-phone.png') });
    assert.deepEqual(small, []);
    await p.click('#sendmode-menu [data-mode="steer"]');
    await p.waitForSelector('.tray-row[data-kind="steer"]', T);
    await ph.gate('ph'); await ph.waitReq(b + 2);
    assert.match((await ph.req(b + 1)).last, /phone steer/);
    await phone.context.close();
    ok('390px phone: split button and menu, tray actions and Stop are >= 44px; menu items steer and queue by tap');
  }

  // 11. Alt/Option+Enter inserts no character in Chromium, WebKit and Firefox; Shift+Enter is a newline.
  const keyRes = [];
  for (const name of ['chromium', 'webkit', 'firefox']) {
    let s;
    try {
      s = await open(pw[name], { name: 'keys-' + name });
      const kp = s.page, kh = helpers(kp);
      const b0 = await kh.nReq();
      await kh.rule({ who: 'main', when: `c.n === ${b0 + 1}`, gate: 'k', reply: [W(11)] });
      await kh.rule({ who: 'main', when: `c.n === ${b0 + 2}`, reply: 'Keys done.' });
      await kp.fill('#input', 'start'); await kp.press('#input', 'Enter');
      await kh.waitReq(b0 + 1);
      await kp.fill('#input', 'line1'); await kp.press('#input', 'Shift+Enter'); await kp.keyboard.type('line2');
      const shift = await kp.inputValue('#input');
      await kp.press('#input', 'Alt+Enter');
      await kp.waitForSelector('.tray-row[data-kind="queued"]', T);
      const after = await kp.inputValue('#input');
      const title = await kp.getAttribute('.tray-row[data-kind="queued"] .tray-text', 'title');
      await kp.click('#send'); // Stop; the queued text pauses
      keyRes.push(`${name}: Shift+Enter ${JSON.stringify(shift)}, Alt+Enter left ${JSON.stringify(after)}, queued ${JSON.stringify(title)}`);
      assert.equal(shift, 'line1\nline2'); assert.equal(after, ''); assert.equal(title, 'line1\nline2');
    } catch (e) {
      // An engine that cannot start here (Firefox Nightly exits with "Could not
      // find profile folder" on this macOS) is reported as skipped, not passed.
      keyRes.push(`${name}: ${/Failed to launch/.test(e.message) ? 'SKIPPED (engine did not launch)' : 'FAILED'} ${e.message.split('\n')[0]}`);
    }
    finally { await s?.context.close().catch(() => {}); }
  }
  console.log(keyRes.join('\n'));
  assert.ok(keyRes.every((r) => !/FAILED/.test(r)), 'keys in every engine');
  ok(`Alt+Enter: no inserted character, queued as the other mode (${keyRes.filter((r) => !/SKIPPED/.test(r)).map((r) => r.split(':')[0]).join(', ')}; skipped: ${keyRes.filter((r) => /SKIPPED/.test(r)).map((r) => r.split(':')[0]).join(', ') || 'none'})`);
} finally {
  await main?.context.close().catch(() => {});
  server.close();
}
console.log(`sendmode-browser: ${passed} passed${errors.length ? `; page errors: ${errors.join(' | ')}` : ''}`);
process.exit(0);
