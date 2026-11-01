// The real pdf.js runtime in a real page, under Pouch's production CSP and
// headers: built by build-pdf.mjs into a scratch dir, fetched as verified
// parts on first use, driven through the shell's pdfinfo / pdftotext /
// pdftoppm (src/pdf.js) over an in-memory filesystem. Checks outputs on
// fixture PDFs (test/pdf-fixtures.mjs, test/fixtures/pdf/encrypted.pdf), Stop
// through /task ctl, that the only requests are this origin's runtime parts,
// no CSP violation, and that a PDF's JavaScript and links do nothing.
// Run: node test/pdf-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
import { buildPdf } from '../build-pdf.mjs';
import { textPdf, scanPdf, jsPdf, EVIL } from './pdf-fixtures.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 3 minutes'); process.exit(2); }, 180_000).unref();
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-pdf-'));
process.chdir(root);
const { pin } = await buildPdf(scratch);

const entry = `
import { InMemoryFs } from 'just-bash';
import { shellFor } from './src/tools.js';
import { createPdfService } from './src/pdf.js';
import { Tasks } from './src/ns/tasks.js';
const fs = new InMemoryFs();
const tasks = new Tasks();
const pdf = createPdfService({ tasks });
const shell = shellFor(fs, { pdf });
window.violations = [];
document.addEventListener('securitypolicyviolation', (e) => window.violations.push(e.violatedDirective + ' ' + e.blockedURI));
window.pouch = {
  put: async (p, b64) => { await fs.mkdir(p.replace(/\\/[^/]*$/, ''), { recursive: true }); await fs.writeFile(p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); },
  sh: async (cmd) => { const r = await shell.exec(cmd, { cwd: '/work' }); return { out: r.stdout, err: r.stderr, code: r.exitCode }; },
  start: (cmd) => { window.pending = shell.exec(cmd, { cwd: '/work' }); },
  finish: async () => { const r = await window.pending; return { out: r.stdout, err: r.stderr, code: r.exitCode }; },
  tasks: () => tasks.list().map((t) => ({ id: t.id, kind: t.kind, label: t.label, status: t.status })),
  kill: (id) => tasks.kill(tasks.get(id)),
  // A PNG's size and the RGBA at a point (decoded by the browser).
  pixel: async (p, x, y) => { const b = await createImageBitmap(new Blob([await fs.readFileBuffer(p)])); const c = new OffscreenCanvas(b.width, b.height).getContext('2d'); c.drawImage(b, 0, 0); return { w: b.width, h: b.height, rgba: [...c.getImageData(x, y, 1, 1).data] }; },
  dark: async (p) => { const b = await createImageBitmap(new Blob([await fs.readFileBuffer(p)])); const c = new OffscreenCanvas(b.width, b.height).getContext('2d'); c.drawImage(b, 0, 0); const d = c.getImageData(0, 0, b.width, b.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n; },
};`;
const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
const app = (await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, write: false, format: 'iife', minify: true,
  define: { WORKER_SRC: JSON.stringify(worker), POUCH_PDF_RUNTIME: JSON.stringify(pin) },
  alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js') }, logLevel: 'error' })).outputFiles[0].text;
const script = app.replaceAll('</script', '<\\/script');
// Pouch's own policy (pouch.html's meta tag), with this page's one script hash.
const csp = readFileSync(join(root, 'pouch.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
  .replace('__SCRIPT_HASHES__', `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
const HEADERS = headersFile(csp, viewerCsp(root));
const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>pdf test</title><script>${script}</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/runtime/')) { try { res.writeHead(200, headersFor(HEADERS, path)); return res.end(readFileSync(join(scratch, path))); } catch { res.writeHead(404); return res.end(); } }
  if (path === '/pouch.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, '/pouch.html') }); return res.end(html); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
const ok = (name) => { pass++; console.log('ok', name); };
const browser = await pw.chromium.launch();
try {
  const page = await browser.newPage();
  const requests = [], errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(`${EVIL}/**`, (r) => r.abort());
  await page.goto(origin + '/pouch.html');
  const put = (p, bytes) => page.evaluate(([p, b]) => window.pouch.put(p, b), [p, Buffer.from(bytes).toString('base64')]);
  const sh = (cmd) => page.evaluate((c) => window.pouch.sh(c), cmd);
  await put('/work/paper.pdf', textPdf());
  await put('/work/scan.pdf', scanPdf());
  await put('/work/hostile.pdf', jsPdf());
  await put('/work/locked.pdf', readFileSync(join(root, 'test/fixtures/pdf/encrypted.pdf')));
  await put('/work/notes.txt', Buffer.from('just text\n'));

  // A non-PDF is refused before the runtime loads.
  let r = await sh('pdfinfo notes.txt');
  assert.equal(r.code, 1); assert.match(r.err, /not a PDF file/);
  assert.ok(!requests.some((u) => u.includes('/runtime/')), 'nothing fetched for a non-PDF');
  ok('non-PDF refused without loading the runtime');

  r = await sh('pdfinfo paper.pdf');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Title:\s+Pouch fixture$/m); assert.match(r.out, /^Author:\s+BayLeaf tests$/m);
  assert.match(r.out, /^Pages:\s+3$/m); assert.match(r.out, /^Encrypted:\s+no$/m);
  assert.match(r.out, /^Page size:\s+612 x 792 pts \(letter\)$/m); assert.match(r.out, /^JavaScript:\s+no$/m);
  assert.match(r.out, /^Text layer:\s+every page$/m); assert.match(r.out, /^CreationDate:\s+2026-11-01 12:00:00$/m);
  ok('pdfinfo on a text PDF');

  r = await sh('pdftotext paper.pdf -');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\f').length, 4, 'one form feed per page');
  assert.match(r.out, /^\[page 1\]\nHello page one\s*\nSecond line\n\f\[page 2\]\nDeadline: May 3\n\f\[page 3\]\nPage three ends here\n\f$/);
  r = await sh('pdftotext -f 2 -l 2 -nopgbrk paper.pdf -');
  assert.equal(r.out, '[page 2]\nDeadline: May 3\n');
  r = await sh('pdftotext -layout paper.pdf out.txt && cat out.txt');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/out\.txt \(pages 1-3 of 3\)/); assert.match(r.out, /\[page 1\]\nHello page one\nSecond line\n/);
  r = await sh('pdftotext paper.pdf && head -2 paper.txt');
  assert.match(r.out, /\[page 1\]\nHello page one/);
  r = await sh('pdftotext -f 5 paper.pdf -');
  assert.equal(r.code, 1); assert.match(r.err, /first page 5 is past the last page \(3\)/);
  ok('pdftotext: page markers, ranges, -layout, default output, out of range');

  r = await sh('pdfinfo scan.pdf');
  assert.match(r.out, /^Text layer:\s+missing on page 2; render those with pdftoppm$/m);
  r = await sh('pdftotext scan.pdf -');
  assert.match(r.out, /\[page 2\]\n\[page 2: no text layer; render it with pdftoppm -f 2 -l 2\]\n/);
  r = await sh('pdftoppm -f 2 -l 2 -r 72 -png scan.pdf pages/scan');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/pages\/scan-2\.png \(page 2, 612x792 at 72 DPI\)/);
  let px = await page.evaluate(() => window.pouch.pixel('/work/pages/scan-2.png', 300, 400));
  assert.deepEqual([px.w, px.h], [612, 792]); assert.ok(px.rgba[0] > 200 && px.rgba[1] < 60 && px.rgba[2] < 60, `red image pixel, got ${px.rgba}`);
  r = await sh('pdftoppm -r 100 -singlefile -x 50 -y 60 -W 200 -H 100 paper.pdf crop');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote \/work\/crop\.png \(page 1, 200x100 at 100 DPI\)/);
  r = await sh('pdftoppm -r 72 paper.pdf p');
  assert.match(r.out, /p-1\.png.*\n.*p-2\.png.*\n.*p-3\.png/);
  const dark = await page.evaluate(() => window.pouch.dark('/work/p-1.png'));
  assert.ok(dark > 200, `Helvetica glyphs drawn from standard_fonts (${dark} dark pixels)`);
  r = await sh('pdftoppm -jpeg -r 50 -f 3 paper.pdf j && ls j-3.jpg');
  assert.equal(r.code, 0, r.err);
  r = await sh('pdftoppm -r 600 -scale-to 100 paper.pdf x');
  assert.equal(r.code, 99); assert.match(r.err, /-scale-to: use -r/);
  ok('scan detection and pdftoppm: PNG pixels, crop, page names, JPEG, unsupported flag');

  r = await sh('pdfinfo locked.pdf');
  assert.equal(r.code, 3); assert.match(r.err, /encrypted: it needs a password to open \(try -upw PASSWORD\)/);
  r = await sh('pdftotext -upw secret locked.pdf -');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /Deadline: May 3/);
  r = await sh('pdfinfo -upw secret locked.pdf');
  assert.match(r.out, /^Encrypted:\s+yes/m);
  r = await sh('pdfinfo -upw wrong locked.pdf');
  assert.equal(r.code, 3); assert.match(r.err, /incorrect password/);
  ok('encrypted: clear error, -upw opens it');

  r = await sh('pdfinfo hostile.pdf');
  assert.match(r.out, /^JavaScript:\s+yes \(never run: Pouch has no PDF scripting\)$/m);
  r = await sh('pdftotext hostile.pdf - && pdftoppm -r 72 hostile.pdf h');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /Nothing runs here/);
  await page.waitForTimeout(300);
  ok('a PDF with JavaScript and a link: read and rendered, nothing ran');

  // Stop through the task's ctl (tasks.kill is what `echo stop > /task/N/ctl` calls).
  r = await sh('pdftoppm -r 600 paper.pdf big');
  assert.equal(r.code, 1); assert.match(r.err, /page 1 at 600 DPI is 5100x6600 pixels, over the cap of 25000000; lower -r/);
  const job = await page.evaluate(async () => {
    window.pouch.start('pdftoppm -r 400 -f 1 -l 3 paper.pdf big');
    for (let i = 0; i < 2000; i++) {
      const t = window.pouch.tasks().find((t) => t.kind === 'job' && t.label === 'pdftoppm paper.pdf' && t.status === 'running');
      if (t) { await window.pouch.kill(t.id); return t; }
      await new Promise((r) => setTimeout(r, 1));
    }
  });
  assert.ok(job, 'pdftoppm runs as a /task job');
  r = await page.evaluate(() => window.pouch.finish());
  assert.equal(r.code, 130, r.err + r.out); assert.match(r.err, /stopped \(\/task\/\d+\)/);
  r = await sh('pdfinfo paper.pdf');
  assert.equal(r.code, 0, 'the engine serves the next job after a stop');
  ok('Stop through /task ends one job; the next runs');

  const foreign = requests.filter((u) => !u.startsWith(origin + '/'));
  assert.deepEqual(foreign, [], 'no request leaves this origin');
  const own = requests.filter((u) => u !== origin + '/pouch.html');
  assert.ok(own.length && own.every((u) => u.startsWith(origin + '/runtime/pdf/')), `only runtime parts: ${own.join(', ')}`);
  assert.equal(new Set(own).size, own.length, 'each part fetched once');
  assert.deepEqual(await page.evaluate(() => window.violations), [], 'no CSP violations');
  assert.deepEqual(errors.filter((e) => !/Warning/i.test(e)), [], 'no page errors');
  ok(`network: ${own.length} same-origin runtime fetches, nothing else, no CSP violation`);

  // PD5: after one use the runtime is kept in this browser; a reload reads it with /runtime unreachable.
  await page.route(`${origin}/runtime/**`, (r) => r.abort());
  await page.reload();
  await put('/work/paper.pdf', textPdf());
  r = await sh('pdftotext -f 3 paper.pdf -');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /Page three ends here/);
  ok('after a reload, the kept runtime works with /runtime unreachable');
} finally {
  await browser.close(); server.close(); rmSync(scratch, { recursive: true, force: true });
}
console.log(`pdf-browser: ${pass} passed`);
