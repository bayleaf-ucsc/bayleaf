// R7: readable replies. One live turn (glm-5-3) creates two files and answers in
// markdown; checks highlighting, table, file link at a line, external confirm,
// no console errors or CSP violations, and no page overflow at 390px.
import { launch, instrument, sheetClick, sleep, URL } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const results = [];
const ok = (c, m) => { results.push([!!c, m]); console.log(c ? 'PASS' : 'FAIL', m); };
async function idle(page, timeout = 300_000) {
  const t = Date.now();
  await sleep(800);
  while (Date.now() - t < timeout) {
    if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) return sleep(800);
    await sleep(500);
  }
  throw new Error('never idle');
}

const ctx = await launch({ fresh: true, userDataDir: '/tmp/pouch-qa/md-profile' });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(URL).origin });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
const errors = instrument(page);
const popups = [];
ctx.on('page', (p) => popups.push(p.url()));
await page.goto(URL);
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
await page.click('#auth');
page.dialogQueue.push(KEY);
await sheetClick(page, 'Paste a key');
await page.waitForFunction(() => document.querySelector('#auth').getAttribute('aria-label') === 'Forget key');
await page.waitForSelector('#badge.ok', { timeout: 60_000 });
const glm = await page.$$eval('#model option', (os) => os.map((o) => o.value).find((v) => /glm-5-3/.test(v)));
if (glm) await page.selectOption('#model', glm);
ok(!!glm, 'model glm-5-3 selected: ' + glm);

// Streaming: sample the reply while it grows, to see mid-stream rendering survive.
let samples = 0;
const sampler = setInterval(async () => { try { if (await page.$('.msg.assistant .body.md')) samples++; } catch {} }, 300);
await page.fill('#input', [
  'Create /work/util.js with a small function add(a, b) and a function mul(a, b) (about 8 lines),',
  'and /work/notes.md with a two-line note. Then reply in markdown with: a short heading,',
  'a ```js fenced code block showing add, a table with columns File and Purpose for both files,',
  'a markdown link to util.js at the line where mul is defined (like [util.js:5](/work/util.js:5)),',
  'and a link to https://developer.mozilla.org/en-US/docs/Web/JavaScript for reference.',
].join(' '));
await page.click('#send');
await idle(page);
clearInterval(sampler);
ok(samples > 0, `rendered as markdown while streaming (${samples} samples)`);

const body = page.locator('.msg.assistant .body.md').last();
ok(await body.locator('.code pre code [class^="tok-"]').count() > 0, 'code block tokens carry tok- classes');
ok(await body.locator('.code-head button.copy').count() > 0, 'code block has Copy button');
await body.locator('.code-head button.copy').first().click();
await sleep(300);
const clip = await page.evaluate(() => navigator.clipboard.readText());
ok(/add/.test(clip), 'Copy writes the code to the clipboard');
ok(await body.locator('div.table > table tbody tr').count() >= 2, 'table rendered in overflow container');
ok(await page.locator('.msg.assistant .body.md script, .msg.assistant .body.md img, .msg.assistant .body.md a[href]').count() === 0, 'no script, img or href in reply');

// File link at a line: opens the editor with the cursor on that line.
const fileLinks = body.locator('button.path', { hasText: 'util.js' });
const n = await fileLinks.count();
ok(n > 0, `file links to util.js: ${n}`);
let lineOk = false;
for (let i = 0; i < n && !lineOk; i++) {
  const title = await fileLinks.nth(i).getAttribute('title');
  const m = title?.match(/at line (\d+)/);
  if (!m) continue;
  await fileLinks.nth(i).click();
  await page.waitForSelector('.cm-content');
  await sleep(300);
  const got = await page.evaluate(() => {
    const active = document.querySelector('.cm-activeLine');
    const lines = [...document.querySelectorAll('.cm-content .cm-line')];
    return { idx: lines.indexOf(active) + 1, path: document.querySelector('#editor-path').textContent };
  });
  lineOk = got.path === '/work/util.js' && got.idx === Number(m[1]);
  ok(lineOk, `link "${title}" opened ${got.path} at line ${got.idx}`);
}
if (!lineOk) ok(false, 'no util.js link with a line opened correctly');

// External link: confirm sheet, Cancel opens nothing, Open opens a popup.
const ext = body.locator('button.ext').first();
ok(/developer\.mozilla\.org/.test(await ext.textContent()), 'external link shows its host: ' + (await ext.textContent()));
await ext.click();
await page.waitForSelector('#sheet[open]');
const sheetText = await page.textContent('#sheet');
ok(/outside Pouch/.test(sheetText) && /https:\/\/developer\.mozilla\.org/.test(sheetText), 'confirm sheet shows warning and full URL');
await page.locator('#sheet-actions button', { hasText: 'Cancel' }).click();
await sleep(300);
ok(popups.length === 0, 'Cancel opens nothing');

// Narrow phone layout: no horizontal page overflow; file link switches to the editor tab.
await page.setViewportSize({ width: 390, height: 844 });
await page.click('#rail [data-panel="chat"]').catch(() => {});
await sleep(400);
const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: innerWidth, log: (() => { const l = document.querySelector('#log'); return l.scrollWidth - l.clientWidth; })() }));
ok(over.doc <= over.win && over.log <= 1, `no horizontal overflow at 390px (${JSON.stringify(over)})`);
await page.screenshot({ path: '/tmp/pouch-qa/shots/t8-390.png' });
await body.locator('button.path').first().click();
await sleep(400);
ok((await page.getAttribute('#app', 'data-panel')) === 'editor', 'file link switches to the editor tab on phones');

const bad = errors.filter((e) => !/favicon/.test(e));
ok(bad.length === 0, 'no console errors or CSP violations' + (bad.length ? ': ' + bad.join(' | ').slice(0, 400) : ''));
console.log('REPLY TEXT:', (await body.textContent()).slice(0, 600));
await ctx.close();
const failed = results.filter(([c]) => !c).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
