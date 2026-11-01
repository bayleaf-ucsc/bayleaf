// Composer card, activity tray, @/$/ autocomplete, slash commands, turn footer,
// the Send-drop fix, mobile layout. Scripted fake model (0 real requests);
// REAL=1 adds at most 3 glm-5-3 requests against POUCH_URL with BAYLEAF_API_KEY.
import { chromium } from 'playwright';
import { fixtureHtml, serveHtml, fakeNetwork } from './fixture.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = '/tmp/pouch-qa/shots';
const results = [];
const ok = (c, m) => { results.push([!!c, m]); console.log(c ? 'PASS' : 'FAIL', m); };
const srv = await serveHtml(await fixtureHtml());
const fs = await import('node:fs');

async function open({ mobile = false, dir }) {
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { headless: true,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await fakeNetwork(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) page.errors.push(m.text()); });
  page.confirms = [];
  page.on('dialog', (d) => { page.confirms.push(d.message()); return /Erase ALL/.test(d.message()) ? d.dismiss() : d.accept(); });
  await page.goto(srv.url);
  await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 20000 });
  return { ctx, page };
}
const label = (page) => page.textContent('#send');
async function idle(page, timeout = 30000) {
  const t = Date.now(); await sleep(300);
  while (Date.now() - t < timeout) {
    if ((await label(page)) === 'Send' && !(await page.$('.msg.assistant.streaming')) && !(await page.$('#egress[open]'))) return sleep(200);
    await sleep(100);
  }
  throw new Error('never idle');
}
const reqs = (page) => page.evaluate(() => window.requests.length);
const script = (page, steps) => page.evaluate((s) => window.script.push(...s), steps);
async function say(page, text) { await page.fill('#input', text); await page.click('#send'); }
const trayRows = (page) => page.$$eval('#tray-list .tray-row', (rs) => rs.map((r) => ({ kind: r.dataset.kind, text: r.querySelector('.tray-text').textContent, origin: r.querySelector('.tray-origin').textContent, time: r.querySelector('.tray-time').textContent })));

// ── Desktop ───────────────────────────────────────────────────────────
if (process.env.REAL_ONLY !== '1') {
  const { ctx, page } = await open({ dir: '/tmp/pouch-qa/cmp-t16' });

  // 1. Card structure.
  const s = await page.evaluate(() => {
    const c = document.querySelector('#composer'), r = (q) => document.querySelector(q).getBoundingClientRect();
    const inside = ['#input', '#composer-toolbar', '#attach-file', '#shield-btn', '#composer-usage', '#model', '#send'].every((q) => c.contains(document.querySelector(q)));
    return { inside, tray: c.contains(document.querySelector('#tray')), trayHidden: document.querySelector('#tray').hidden, ph: document.querySelector('#input').placeholder,
      order: ['#attach-file', '#shield-btn', '#composer-usage', '#model', '#send'].map((q) => r(q).x), radius: getComputedStyle(c).borderRadius, shadow: getComputedStyle(c).boxShadow,
      trayBeforeInput: !!(document.querySelector('#tray').compareDocumentPosition(document.querySelector('#input')) & Node.DOCUMENT_POSITION_FOLLOWING),
      sendText: document.querySelector('#send').textContent, sendVisibleText: [...document.querySelector('#send').childNodes].filter((n) => !n.classList?.contains('vh')).map((n) => n.textContent).join('').trim() };
  });
  ok(s.inside && s.tray && s.trayBeforeInput, 'one card holds tray (above), input, attach, shield, usage, model, send');
  ok(s.order.every((x, i, a) => !i || x > a[i - 1]), `left verbs then model then send, in order (${s.order.map(Math.round).join(', ')})`);
  ok(s.ph === 'Ask Pouch. @ for files, $ for skills, / for commands', 'placeholder teaches the syntax');
  ok(s.trayHidden, 'tray hidden when nothing is active');
  ok(s.sendVisibleText === '' && s.sendText === 'Send', 'Send is icon-only with an accessible name');
  ok(parseFloat(s.radius) >= 12 && s.shadow !== 'none', `card is rounded and elevated (${s.radius})`);
  await page.screenshot({ path: `${SHOTS}/composer-desktop-idle.png`, clip: await page.$eval('#chat', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.bottom - 260, width: r.width, height: 260 }; }) });

  // 2. Turn footer: model, duration, time; actions on hover.
  await page.evaluate(() => { window.titleDelay = 0; });
  await script(page, [{ text: 'Hello **there**.' }]);
  await say(page, 'hi'); await idle(page);
  const f = await page.evaluate(() => {
    const bar = [...document.querySelectorAll('.msg.assistant .msg-bar.footer')].at(-1);
    if (!bar) return null;
    return { meta: bar.querySelector('.meta').textContent, metaVis: getComputedStyle(bar.querySelector('.meta')).visibility, actsVis: getComputedStyle(bar.querySelector('.acts')).visibility,
      acts: [...bar.querySelectorAll('.acts button')].map((b) => b.dataset.act), h: bar.getBoundingClientRect().height,
      userBar: getComputedStyle(document.querySelector('.msg.user .msg-bar')).visibility, userFooter: !!document.querySelector('.msg.user .msg-bar.footer') };
  });
  ok(f && /fake/.test(f.meta) && /\d+s/.test(f.meta) && /\d:\d\d/.test(f.meta), `footer meta: "${f?.meta}"`);
  ok(f?.metaVis === 'visible' && f?.actsVis === 'hidden', 'meta always visible, actions hidden at rest');
  ok(f?.acts.join() === 'copy,revert,more', `footer actions: ${f?.acts}`);
  ok(f?.userBar === 'hidden' && !f?.userFooter, 'user-message toolbar unchanged (hidden at rest, no footer)');
  const h0 = await page.$eval('#log', (l) => l.scrollHeight);
  await page.hover('.msg.assistant .body');
  ok(await page.$eval('.msg.assistant .msg-bar.footer .acts', (a) => getComputedStyle(a).visibility) === 'visible', 'hover shows the actions');
  ok(await page.$eval('#log', (l) => l.scrollHeight) === h0, 'no layout jump on hover');
  await page.click('.msg.assistant .msg-bar.footer [data-act="more"]');
  ok(/Turn took/.test(await page.textContent('#sheet-body')), 'More shows the reply details');
  await page.keyboard.press('Escape');

  // 3. The Send-drop bug: a click during post-processing is queued, never lost.
  await page.click('#new-top'); await sleep(400);
  await page.evaluate(() => { window.titleDelay = 2500; });
  await script(page, [{ text: 'first answer' }, { text: 'second answer' }]);
  await say(page, 'first message');
  await page.waitForFunction(() => document.querySelector('#send').textContent === 'Queue', null, { timeout: 10000 });
  const q = await page.evaluate(() => ({ disabled: document.querySelector('#send').disabled, title: document.querySelector('#send').title }));
  ok(!q.disabled && /finishing/.test(q.title), `during post-processing Send says Queue, enabled, with a reason ("${q.title.slice(0, 50)}...")`);
  await say(page, 'second message');
  await sleep(150);
  const qr = await trayRows(page);
  ok(qr.some((r) => r.kind === 'queued' && /second message/.test(r.text)), `queued message shown in the tray (${JSON.stringify(qr)})`);
  ok((await page.inputValue('#input')) === '', 'input cleared into the queue');
  await page.waitForFunction(() => window.requests.some((r) => JSON.stringify(r).includes('second message')), null, { timeout: 15000 });
  await idle(page);
  const users = await page.$$eval('.msg.user .body', (b) => b.map((x) => x.textContent));
  ok(users.join('|') === 'first message|second message', `both messages delivered in order: ${users.join(' | ')}`);
  // Enter while busy queues; a second one is refused visibly and stays.
  await page.evaluate(() => { window.titleDelay = 0; });
  await script(page, [{ slow: 20 }, { text: 'third answer' }]);
  await say(page, 'slow one'); await page.waitForFunction(() => document.querySelector('#send').textContent === 'Stop');
  await page.fill('#input', 'third message'); await page.press('#input', 'Enter'); await sleep(200);
  await page.fill('#input', 'fourth message'); await page.press('#input', 'Enter'); await sleep(200);
  ok((await page.inputValue('#input')) === 'fourth message' && /already queued/.test(await page.textContent('#status')), 'second queue attempt refused with a visible reason, text kept');
  await page.screenshot({ path: `${SHOTS}/composer-desktop-queued.png`, clip: await page.$eval('#chat', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.bottom - 320, width: r.width, height: 320 }; }) });
  await page.fill('#input', '');
  await page.waitForFunction(() => window.requests.some((r) => JSON.stringify(r).includes('third message')), null, { timeout: 15000 });
  await idle(page);

  // 4. Tray: a running subagent and a running `run`; Stop all; collapse.
  await script(page, [
    { tool: 'subagent', args: { action: 'spawn', name: 'scout', task: 'Survey the files slowly and summarize them', background: true } },
    { tool: 'run', args: { code: 'while (true) {}' } },
    { text: 'parent done' },
    { when: 'You are a subagent named', slow: 200 },
  ]);
  await say(page, 'spawn and run');
  await page.waitForFunction(() => document.querySelectorAll('#tray-list .tray-row').length >= 2, null, { timeout: 10000 });
  let rows = await trayRows(page);
  ok(rows.some((r) => r.kind === 'subagent' && /scout: Survey/.test(r.text) && r.origin === 'subagent') && rows.some((r) => r.kind === 'run' && /while/.test(r.text)), `tray lists subagent and run: ${JSON.stringify(rows.map((r) => [r.kind, r.text, r.origin]))}`);
  ok(/Running: 2/.test(await page.textContent('#tray-count')) && await page.isVisible('#tray-stop-all'), 'header "Running: 2" with Stop all');
  const t1 = (await trayRows(page)).find((r) => r.kind === 'subagent').time; await sleep(2100);
  const t2 = (await trayRows(page)).find((r) => r.kind === 'subagent')?.time;
  ok(t1 !== t2 && /\d+s/.test(t2), `elapsed ticks (${t1} -> ${t2})`);
  await page.screenshot({ path: `${SHOTS}/composer-desktop-tray.png`, clip: await page.$eval('#chat', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.bottom - 330, width: r.width, height: 330 }; }) });
  await page.click('#tray-toggle');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('#tray-list')).display === 'none' && document.querySelector('#tray-toggle').getAttribute('aria-expanded') === 'false'), 'collapse hides rows, aria-expanded false');
  await page.click('#tray-toggle');
  const tStop = Date.now();
  await page.click('#tray-stop-all');
  await page.waitForFunction(() => !document.querySelector('#tray-list .tray-row[data-kind="run"]') && !document.querySelector('#tray-list .tray-row[data-kind="subagent"]'), null, { timeout: 8000 }).catch(() => {});
  rows = await trayRows(page);
  ok(!rows.some((r) => r.kind === 'run' || r.kind === 'subagent'), `Stop all cleared both in ${Date.now() - tStop} ms (run cap is 5000)`);
  await idle(page);
  ok(await page.evaluate(() => [...document.querySelectorAll('details.tool')].some((d) => /run/.test(d.textContent) && /Stopped/.test(d.textContent))), 'stopped run reports "Stopped." to the model, turn carried on');
  // A single run's own Stop.
  await script(page, [{ tool: 'run', args: { code: 'while (true) {}' } }, { text: 'after stop' }]);
  await say(page, 'run again');
  await page.waitForSelector('#tray-list .tray-row[data-kind="run"]', { timeout: 8000 });
  await page.click('#tray-list .tray-row[data-kind="run"] .tray-stop');
  await page.waitForFunction(() => !document.querySelector('#tray-list .tray-row[data-kind="run"]'), null, { timeout: 3000 }).then(() => ok(true, 'run Stop stops one call'), () => ok(false, 'run Stop stops one call'));
  await idle(page);
  ok(await page.evaluate(() => document.querySelector('#tray').hidden), 'tray hides when nothing is active');

  // 5. Pending approval in the tray; Allow for this session; grant in the shield popover.
  await script(page, [{ tool: 'bash', args: { command: 'bayleaf web search composer test' } }, { text: 'searched' }]);
  await say(page, 'search');
  await page.waitForSelector('#egress[open]', { timeout: 10000 }).catch(() => {});
  rows = await trayRows(page);
  ok(rows.some((r) => r.kind === 'approval' && r.origin === 'waiting for you' && /web search/.test(r.text)), `approval in the tray: ${JSON.stringify(rows.map((r) => [r.kind, r.text, r.origin]))}`);
  await page.screenshot({ path: `${SHOTS}/composer-desktop-approval.png` });
  if (await page.$('#egress[open]')) await page.click('#egress-session');
  await idle(page);
  await page.click('#shield-btn');
  await page.waitForFunction(() => document.querySelector('#shield-pop').textContent.length > 0, null, { timeout: 3000 }).catch(() => {});
  const pop = await page.evaluate(() => ({ vis: !document.querySelector('#shield-pop').hidden, text: document.querySelector('#shield-pop').textContent }));
  ok(pop.vis && /Sealed: encrypted to the enclave/.test(pop.text) && /web search and fetch/.test(pop.text), `shield popover: lane and the session grant (${pop.text.slice(0, 200)})`);
  await page.screenshot({ path: `${SHOTS}/composer-desktop-shield.png`, clip: await page.$eval('#chat', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.bottom - 330, width: r.width, height: 330 }; }) });
  await page.click('#shield-pop .pop-grants button');
  await sleep(300);
  ok(/None\. Pouch asks/.test(await page.textContent('#shield-pop')), 'Revoke removes the grant');
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => document.querySelector('#shield-pop').hidden && document.activeElement.id === 'shield-btn'), 'Escape closes the popover, focus back on the shield');

  // 6. @ / $ / slash autocomplete by keyboard.
  await script(page, [{ tool: 'write', args: { path: '/work/notes/alpha-plan.md', content: '# plan' } }, { text: 'wrote' }]);
  await say(page, 'make a file'); await idle(page);
  await page.click('#input'); await page.fill('#input', ''); await page.type('#input', 'look at @alph');
  await page.waitForFunction(() => [...document.querySelectorAll('#ac [role="option"]')].some((o) => /alpha-plan/.test(o.textContent)), null, { timeout: 5000 }).catch(() => {});
  const a = await page.evaluate(() => ({ role: document.querySelector('#ac').getAttribute('role'), open: !document.querySelector('#ac').hidden, ad: document.querySelector('#input').getAttribute('aria-activedescendant'),
    sel: document.querySelector('#ac [aria-selected="true"]')?.id, first: document.querySelector('#ac [role="option"]')?.textContent, exp: document.querySelector('#input').getAttribute('aria-expanded') }));
  ok(a.open && a.role === 'listbox' && a.ad && a.ad === a.sel && a.exp === 'true' && /alpha-plan/.test(a.first), `@ listbox with aria-activedescendant (${a.first})`);
  await page.screenshot({ path: `${SHOTS}/composer-desktop-ac-path.png`, clip: await page.$eval('#chat', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.bottom - 420, width: r.width, height: 420 }; }) });
  await page.press('#input', 'Enter');
  ok((await page.inputValue('#input')) === 'look at /work/notes/alpha-plan.md ' && await page.evaluate(() => document.querySelector('#ac').hidden), 'Enter inserts the path, closes the list');
  await page.type('#input', 'with $bay');
  await page.waitForSelector('#ac [role="option"]', { timeout: 3000 });
  ok(/bayleaf-cli/.test(await page.textContent('#ac [aria-selected="true"]')), '$ lists skills with descriptions');
  await page.press('#input', 'Enter');
  ok(/with Use the bayleaf-cli skill\. $/.test(await page.inputValue('#input')), `skill inserted: "${await page.inputValue('#input')}"`);
  await page.press('#input', 'Escape');
  // Slash commands.
  const before = await reqs(page);
  await page.fill('#input', ''); await page.type('#input', '/us');
  await page.waitForSelector('#ac [role="option"]');
  ok(/\/usage/.test(await page.textContent('#ac [aria-selected="true"]')), '/ lists commands');
  await page.screenshot({ path: `${SHOTS}/composer-desktop-ac-slash.png`, clip: await page.$eval('#chat', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.bottom - 400, width: r.width, height: 400 }; }) });
  await page.press('#input', 'Enter'); await sleep(200);
  ok((await page.getAttribute('#app', 'data-panel')) === 'usage' && (await page.inputValue('#input')) === '' && (await reqs(page)) === before, '/usage opens Usage, sends nothing');
  await page.fill('#input', '/files'); await page.press('#input', 'Escape'); await page.press('#input', 'Enter'); await sleep(200);
  ok((await page.getAttribute('#app', 'data-panel')) === 'files', '/files typed whole and Enter opens Files');
  await page.fill('#input', '/rename Composer check'); await page.press('#input', 'Enter'); await sleep(300);
  ok((await page.textContent('#title')) === 'Composer check', '/rename <title> renames');
  await page.fill('#input', '/help'); await page.press('#input', 'Escape'); await page.press('#input', 'Enter'); await sleep(200);
  ok(/\/compact/.test(await page.textContent('#sheet-body')), '/help lists commands'); await page.keyboard.press('Escape');
  await page.fill('#input', '/revert'); await page.press('#input', 'Escape'); await page.press('#input', 'Enter'); await sleep(300);
  ok((await page.textContent('#sheet-title')) === 'Revert to here?' && await page.$('#sheet[open]'), '/revert asks to revert the last turn'); await page.keyboard.press('Escape');
  await page.fill('#input', '/compact'); await page.press('#input', 'Escape'); await page.press('#input', 'Enter'); await sleep(800);
  ok(/compact|summarized/i.test(await page.textContent('#status')), `/compact runs (${(await page.textContent('#status')).slice(0, 60)})`);
  const nc = page.confirms.length;
  await page.fill('#input', '/erase'); await page.press('#input', 'Escape'); await page.press('#input', 'Enter'); await sleep(300);
  ok(page.confirms.length === nc + 1 && /Erase ALL/.test(page.confirms.at(-1)) && (await page.textContent('#title')) === 'Composer check', '/erase asks first (dismissed: nothing erased)');
  const ns = await page.$$eval('#session-list .session', (x) => x.length);
  await page.fill('#input', '/new'); await page.press('#input', 'Escape'); await page.press('#input', 'Enter'); await sleep(600);
  ok((await page.$$eval('#session-list .session', (x) => x.length)) === ns + 1, '/new starts a session');
  await script(page, [{ text: 'path answer' }]);
  const b2 = await reqs(page);
  await page.fill('#input', '/work/notes is a folder'); await page.press('#input', 'Enter'); await idle(page);
  ok((await reqs(page)) > b2 && /\/work\/notes is a folder/.test(await page.textContent('.msg.user .body')), 'an unknown /word is sent as text');
  ok(!page.errors.length, `no page errors (${page.errors.slice(0, 3).join(' | ')})`);
  await ctx.close();
}

// ── Mobile 390x844 ────────────────────────────────────────────────────
if (process.env.REAL_ONLY !== '1') {
  const { ctx, page } = await open({ mobile: true, dir: '/tmp/pouch-qa/cmp-t16m' });
  await script(page, [{ text: 'Mobile hello.' }]);
  await page.fill('#input', 'hi'); await page.tap('#send'); await idle(page);
  await script(page, [{ tool: 'subagent', args: { action: 'spawn', name: 'scout', task: 'A long task description for the phone layout check', background: true } },
    { tool: 'run', args: { code: 'while (true) {}' } }, { text: 'ok' }, { when: 'You are a subagent named', slow: 120 }]);
  await page.fill('#input', 'spawn'); await page.tap('#send');
  await page.waitForFunction(() => document.querySelectorAll('#tray-list .tray-row').length >= 2, null, { timeout: 10000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const sz = (q) => [...document.querySelectorAll(q)].filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [q, Math.round(r.width), Math.round(r.height)]; });
    const targets = [...sz('#attach-file'), ...sz('#shield-btn'), ...sz('#composer-usage'), ...sz('#send'), ...sz('#model'), ...sz('#tray-toggle'), ...sz('#tray-stop-all'), ...sz('.tray-stop')];
    const c = document.querySelector('#composer').getBoundingClientRect();
    return { sw: document.scrollingElement.scrollWidth, cw: innerWidth, right: c.right, small: targets.filter(([, w, h]) => w < 44 || h < 44), n: targets.length,
      rowsOver: [...document.querySelectorAll('#tray-list .tray-row, #composer-toolbar')].filter((r) => r.scrollWidth > r.clientWidth + 1).length };
  });
  ok(m.sw <= m.cw && m.right <= m.cw && !m.rowsOver, `no horizontal overflow at 390 (scrollWidth ${m.sw}, card right ${Math.round(m.right)})`);
  ok(m.n >= 7 && !m.small.length, `44px targets (${m.n} checked; small: ${JSON.stringify(m.small)})`);
  await page.screenshot({ path: `${SHOTS}/composer-mobile-tray.png` });
  await page.tap('#tray-stop-all').catch(() => {});
  await idle(page);
  const fm = await page.evaluate(() => { const b = [...document.querySelectorAll('.msg-bar.footer')].at(-1); return b && { meta: b.querySelector('.meta').textContent, acts: [...b.querySelectorAll('.acts button')].map((x) => Math.round(x.getBoundingClientRect().height)) }; });
  ok(fm && /fake/.test(fm.meta) && fm.acts.every((h) => h >= 44), `mobile footer: "${fm?.meta}", action heights ${fm?.acts}`);
  // Tap an autocomplete option.
  await page.tap('#input'); await page.fill('#input', ''); await page.type('#input', '/he');
  await page.waitForSelector('#ac [role="option"]');
  const optH = await page.$eval('#ac [role="option"]', (o) => o.getBoundingClientRect().height);
  await page.screenshot({ path: `${SHOTS}/composer-mobile-ac.png` });
  await page.tap('#ac [role="option"]');
  await sleep(300);
  ok(optH >= 44 && await page.$('#sheet[open]') && /Typing in Pouch/.test(await page.textContent('#sheet-title')), `tapping /help runs it (option ${Math.round(optH)}px)`);
  await page.keyboard.press('Escape');
  await page.fill('#input', ''); await page.type('#input', 'see @');
  await page.waitForFunction(() => [...document.querySelectorAll('#ac [role="option"]')].some((o) => /pouch/.test(o.textContent) && o.getAttribute('aria-disabled') !== 'true'), null, { timeout: 5000 });
  const pick = await page.$eval('#ac [role="option"]:not([aria-disabled])', (o) => o.querySelector('.ac-label').textContent);
  await page.tap('#ac [role="option"]:not([aria-disabled])');
  ok((await page.inputValue('#input')).startsWith('see ' + pick), `tap inserts a path (${pick})`);
  await page.fill('#input', '');
  await page.screenshot({ path: `${SHOTS}/composer-mobile-idle.png` });
  ok(!page.errors.length, `mobile: no page errors (${page.errors.slice(0, 3).join(' | ')})`);
  await ctx.close();
}

// ── Optional: real glm-5-3 (at most 3 requests) ───────────────────────
if (process.env.REAL === '1' && process.env.BAYLEAF_API_KEY && process.env.POUCH_URL) {
  const KEY = process.env.BAYLEAF_API_KEY;
  const dir = '/tmp/pouch-qa/cmp-t16-real';
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const dq = [];
  page.on('dialog', (d) => d.type() === 'prompt' ? d.accept(dq.shift()) : d.accept());
  await page.goto(process.env.POUCH_URL);
  await page.click('#auth'); dq.push(KEY);
  await page.locator('#sheet-actions button', { hasText: 'Paste a key' }).click();
  await page.waitForFunction(() => document.querySelector('#auth').getAttribute('aria-label') === 'Forget key', null, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 60000 });
  await page.selectOption('#model', 'glm-5-3').catch(() => {});
  // Turn 1 (plus its automatic title = 2 requests); during the title, a second send queues (3rd request).
  await page.fill('#input', 'Reply with exactly one word: ready'); await page.click('#send');
  await page.waitForFunction(() => ['Queue', 'Send'].includes(document.querySelector('#send').textContent) && !document.querySelector('.msg.assistant.streaming'), null, { timeout: 120000 });
  const lbl = await page.textContent('#send');
  await page.fill('#input', 'Reply with exactly one word: queued'); await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.msg.user').length === 2 && document.querySelector('#send').textContent === 'Send' && !document.querySelector('.msg.assistant.streaming') && document.querySelectorAll('.msg-bar.footer').length >= 2, null, { timeout: 180000 }).catch(() => {});
  const foot = await page.$$eval('.msg-bar.footer .meta', (m) => m.map((x) => x.textContent));
  ok(foot.length >= 2 && foot.every((t) => /GLM|glm/.test(t) && /\d+s/.test(t)), `real: footers ${JSON.stringify(foot)} (second send clicked while "${lbl}")`);
  await page.screenshot({ path: `${SHOTS}/composer-real.png` });
  await ctx.close();
}

srv.close();
const fails = results.filter(([c]) => !c);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
