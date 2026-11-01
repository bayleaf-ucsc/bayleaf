import { launch, instrument, URL, sleep, rows, rowMore, sheetClick, waitRow } from './lib.mjs';
import { readFileSync } from 'node:fs';

const ctx = await launch({ fresh: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = instrument(page);
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

await page.goto(URL);
await page.waitForFunction(() => document.getElementById('badge').textContent !== 'verifying enclave...', null, { timeout: 30000 });
ok('badge', (await page.textContent('#badge')) === 'sealed: enclave verified', await page.textContent('#badge'));
ok('status off-campus', true, await page.textContent('#status'));
const r0 = await rows(page);
ok('roots', ['/work', '/pouch', '/tmp'].every((p) => r0.includes(p)), r0.join(','));
await page.click('#tree .row:has(.name[title="/pouch"])');
await waitRow(page, '/pouch/AGENTS.md');
await page.click('#tree .row:has(.name[title="/pouch/skills"])');
await waitRow(page, '/pouch/skills/pouch-environment');
ok('pouch seeded', true, (await rows(page)).filter((r) => r.startsWith('/pouch')).join(','));
ok('models', (await page.$$eval('#model option', (o) => o.length)) > 0, await page.$eval('#model', (s) => s.value));

// New file via row "..." sheet
page.dialogQueue.push('hello.js');
await rowMore(page, '/work');
await sheetClick(page, 'New file here');
await waitRow(page, '/work/hello.js');
await page.waitForFunction(() => document.getElementById('editor-path').textContent === '/work/hello.js');
ok('new file opens in editor', true);
await page.click('.cm-content');
await page.keyboard.type('const x = "hi"; // comment\nfunction f() { return 42; }\n');
await sleep(200);
const spans = await page.$$eval('.cm-content span', (s) => s.map((x) => x.className).filter(Boolean));
ok('syntax highlighting', spans.length > 3, [...new Set(spans)].slice(0, 6).join(' '));
ok('dirty', await page.$eval('#save', (b) => !b.disabled) && (await page.getAttribute('#editor-path', 'class'))?.includes('dirty'));
await page.click('#save');
await sleep(300);
ok('saved via button', await page.$eval('#save', (b) => b.disabled));
await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('// more\n');
await page.keyboard.press('ControlOrMeta+s');
await sleep(300);
ok('saved via Mod-S', await page.$eval('#save', (b) => b.disabled));
const content = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  return (await (await root.getFileHandle('hello.js')).getFile()).text();
});
ok('content on OPFS', content.includes('// more') && content.includes('return 42'), JSON.stringify(content));

// Rename
page.dialogQueue.push('renamed.js');
await rowMore(page, '/work/hello.js');
await sheetClick(page, 'Rename');
await waitRow(page, '/work/renamed.js');
await waitRow(page, '/work/hello.js', false);
ok('rename + editor path', (await page.textContent('#editor-path')) === '/work/renamed.js', await page.textContent('#editor-path'));
// editing after rename then save should write the new path
await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('//after\n');
await page.keyboard.press('ControlOrMeta+s'); await sleep(300);
const rr = await rows(page);
ok('save after rename does not resurrect old name', !rr.includes('/work/hello.js'), rr.filter((x) => x.startsWith('/work')).join(','));

// Upload via hidden input
page.dialogQueue.push('sub');
await rowMore(page, '/work');
await sheetClick(page, 'New folder here');
await waitRow(page, '/work/sub');
await rowMore(page, '/work/sub');
const chooserP = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
await sheetClick(page, 'Upload files here');
const chooser = await chooserP;
if (chooser) await chooser.setFiles([{ name: 'up.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded\n') }]);
else await page.setInputFiles('#upload', [{ name: 'up.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded\n') }]);
await page.click('#tree .row:has(.name[title="/work/sub"])').catch(() => {});
await sleep(400);
let rs = await rows(page);
if (!rs.includes('/work/sub/up.txt')) { await page.click('#tree .row:has(.name[title="/work/sub"])'); await sleep(300); rs = await rows(page); }
ok('upload', rs.includes('/work/sub/up.txt'), 'chooser=' + !!chooser);

// Drag-and-drop a file onto a folder row
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['dropped!'], 'drop.md', { type: 'text/markdown' }));
  const row = [...document.querySelectorAll('#tree .row')].find((r) => r.querySelector('.name')?.title === '/work/sub');
  row.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  row.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await sleep(600);
rs = await rows(page);
ok('drop onto folder', rs.includes('/work/sub/drop.md'), rs.filter((x) => x.startsWith('/work')).join(','));

// Download a file
await rowMore(page, '/work/renamed.js');
let dl = page.waitForEvent('download');
await sheetClick(page, 'Download');
let d = await dl;
const bytes = readFileSync(await d.path(), 'utf8');
ok('download file', d.suggestedFilename() === 'renamed.js' && bytes.includes('//after'), d.suggestedFilename());

// Download dir as tar
await rowMore(page, '/work/sub');
dl = page.waitForEvent('download');
await sheetClick(page, 'Download as .tar');
d = await dl;
const tar = readFileSync(await d.path()); console.log((await import('node:child_process')).execSync('tar -tvf '+await d.path()).toString());
const names = [];
for (let off = 0; off + 512 <= tar.length; off += 512) {
  const name = tar.subarray(off, off + 100).toString().replace(/\0.*$/s, '');
  if (!name) break;
  const size = parseInt(tar.subarray(off + 124, off + 136).toString().replace(/\0/g, '').trim() || '0', 8);
  names.push(`${name}(${size})`);
  off += Math.ceil(size / 512) * 512;
}
ok('tar download', d.suggestedFilename() === 'sub.tar' && names.some((n) => n.includes('up.txt')) && names.some((n) => n.includes('drop.md')), `${d.suggestedFilename()} ${tar.length}B ${names.join(' ')}`);
rs = await rows(page);
ok('tar temp cleaned', !rs.some((r) => r.startsWith('/tmp/') && r.endsWith('.tar')));

// Delete
page.dialogQueue.push(true);
await rowMore(page, '/work/sub/drop.md');
await sheetClick(page, 'Delete');
await waitRow(page, '/work/sub/drop.md', false);
ok('delete file', true);
// Delete open file: editor should close
page.dialogQueue.push(true);
await rowMore(page, '/work/renamed.js');
await sheetClick(page, 'Delete');
await waitRow(page, '/work/renamed.js', false);
await sleep(400);
ok('deleting open file closes editor', await page.$eval('#main', (m) => m.classList.contains('no-editor')), await page.textContent('#editor-path'));

// Mention
await rowMore(page, '/work/sub/up.txt');
await sheetClick(page, 'Mention in chat');
ok('mention', (await page.inputValue('#input')).includes('/work/sub/up.txt'), JSON.stringify(await page.inputValue('#input')));

// Binary file
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const w = await (await root.getFileHandle('bin.dat', { create: true })).createWritable();
  await w.write(new Uint8Array([0, 1, 2, 255])); await w.close();
});
await page.click('#refresh'); await waitRow(page, '/work/bin.dat');
await page.click('#tree .row:has(.name[title="/work/bin.dat"])');
await sleep(300);
ok('binary shows sheet', await page.$eval('#sheet', (s) => s.open), await page.textContent('#sheet-title'));
await sheetClick(page, 'Cancel');

await page.screenshot({ path: '/tmp/pouch-qa/shots/desktop-files.png' });
console.log('dialogs:', page.dialogLog);
console.log('errors:', errors);
await ctx.close();
