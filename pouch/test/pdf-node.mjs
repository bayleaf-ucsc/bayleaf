// The pdf commands without a browser (src/pdf.js): argument parsing, caps,
// error messages, output formats, the commands in the terminal's shell and
// the agents' bash, jobs with a fake engine, and the build's pins and
// containment (build-pdf.mjs). The real runtime: test/pdf-browser.mjs.
// Run: node test/pdf-node.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryFs } from 'just-bash';
import { parseArgs, pageRange, formatInfo, formatText, createPdfService, pdfCommands, HELP,
  RENDER_MAX_PAGES, TEXT_MAX_PAGES, MAX_DPI, MAX_PDF_BYTES } from '../src/pdf.js';
import { Tasks } from '../src/ns/tasks.js';
import { shellFor } from '../src/tools.js';
import { buildPdf, pack } from '../build-pdf.mjs';
import { assertNoCdn } from '../build-runtime.mjs';
import { textPdf } from './pdf-fixtures.mjs';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('ok', name); };

await t('parseArgs: poppler flags, values, positional counts', () => {
  assert.deepEqual(parseArgs('pdftotext', ['-f', '2', '-l', '4', '-layout', 'a.pdf', '-']), { opts: { f: 2, l: 4, layout: true }, files: ['a.pdf', '-'] });
  assert.deepEqual(parseArgs('pdftoppm', ['-r', '300', '-png', 'a.pdf', 'out/pg']).opts, { r: 300, png: true });
  assert.deepEqual(parseArgs('pdfinfo', ['--help']), { help: true });
  assert.equal(parseArgs('pdfinfo', []).code, 99);
  assert.match(parseArgs('pdftoppm', ['a.pdf']).error, /needs FILE\.pdf and an output PREFIX/);
  assert.match(parseArgs('pdftotext', ['-zz', 'a.pdf']).error, /unknown option -zz/);
  assert.match(parseArgs('pdftoppm', ['-scale-to', '800', 'a.pdf', 'p']).error, /-scale-to: use -r/);
  assert.match(parseArgs('pdftoppm', ['-tiff', 'a.pdf', 'p']).error, /PNG or JPEG only/);
  assert.match(parseArgs('pdftotext', ['-f', 'x', 'a.pdf']).error, /-f needs a whole number/);
  assert.match(parseArgs('pdftotext', ['-f', '0', 'a.pdf']).error, /counts pages from 1/);
  assert.match(parseArgs('pdftotext', ['-f', '5', '-l', '2', 'a.pdf']).error, /-l 2 is before -f 5/);
  assert.match(parseArgs('pdftotext', ['-l']).error, /-l needs a value/);
  assert.match(parseArgs('pdftoppm', ['-r', String(MAX_DPI + 1), 'a.pdf', 'p']).error, /outside 18-600 DPI/);
  assert.match(parseArgs('pdftoppm', ['-png', '-jpeg', 'a.pdf', 'p']).error, /choose one/);
  assert.match(parseArgs('pdftotext', ['-enc', 'Latin1', 'a.pdf']).error, /always UTF-8/);
  assert.equal(parseArgs('pdftotext', ['-enc', 'UTF-8', 'a.pdf']).error, undefined);
});

await t('pageRange: caps refuse instead of cutting', () => {
  assert.deepEqual(pageRange({}, RENDER_MAX_PAGES, 'pdftoppm'), { first: 1, last: null });
  assert.deepEqual(pageRange({ f: 3, singlefile: true }, RENDER_MAX_PAGES, 'pdftoppm'), { first: 3, last: 3 });
  assert.deepEqual(pageRange({ f: 1, l: 3, singlefile: true }, RENDER_MAX_PAGES, 'pdftoppm'), { first: 1, last: 1 }, '-singlefile wins over -l');
  assert.match(pageRange({ f: 1, l: RENDER_MAX_PAGES + 1 }, RENDER_MAX_PAGES, 'pdftoppm').error, /at most 50 per call/);
  assert.equal(pageRange({ f: 1, l: TEXT_MAX_PAGES }, TEXT_MAX_PAGES, 'pdftotext').error, undefined);
});

await t('formatInfo and formatText', () => {
  const info = formatInfo({ pages: 4, info: { Title: 'T', PDFFormatVersion: '1.7', EncryptFilterName: 'Standard', CreationDate: 'D:20260102030405Z' }, javascript: true, size: [595.28, 841.89], rotate: 0, noText: [2, 3], scanned: 4 });
  assert.match(info, /^Title:\s+T$/m); assert.match(info, /^Encrypted:\s+yes \(Standard; opened without a password\)$/m);
  assert.match(formatInfo({ pages: 1, info: { EncryptFilterName: 'Standard' }, size: [612, 792], rotate: 0, noText: [], scanned: 0 }, { password: true }), /^Encrypted:\s+yes \(Standard; opened with the password given\)$/m);
  assert.match(info, /^Page size:\s+595.28 x 841.89 pts \(A4\)$/m); assert.match(info, /^JavaScript:\s+yes \(never run/m);
  assert.match(info, /^Text layer:\s+missing on pages 2-3; render those with pdftoppm$/m); assert.match(info, /^CreationDate:\s+2026-01-02 03:04:05$/m);
  assert.match(formatInfo({ pages: 900, info: {}, size: [612, 792], rotate: 0, noText: Array.from({ length: 500 }, (_, i) => i + 1), scanned: 500 }), /^Text layer:\s+none \(checked pages 1-500 of 900\): a scan/m);
  const pages = { pages: [{ n: 1, text: 'One\n', empty: false }, { n: 2, text: '', empty: true }] };
  assert.equal(formatText(pages), '[page 1]\nOne\n\f[page 2]\n[page 2: no text layer; render it with pdftoppm -f 2 -l 2]\n\f');
  assert.equal(formatText(pages, { nopgbrk: true, nomarkers: true }), 'One\n');
});

// A fake engine: answers like the worker, records what it was asked.
const asked = [];
const fake = { label: 'fake pdf', memory: 1, create: () => ({ async run(input, { signal }) {
  asked.push(input);
  if (fake.hang) await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('Stopped.', 'AbortError'))));
  if (input.password === 'enc') throw Object.assign(new Error('encrypted: it needs a password to open'), { code: 'EENCRYPTED' });
  if (input.action === 'info') return { pages: 3, info: { Title: 'Fake' }, size: [612, 792], rotate: 0, noText: [], scanned: 3 };
  if (input.action === 'text') return { numPages: fake.numPages ?? 3, pages: [{ n: input.first, text: 'Hi', empty: false }] };
  return { numPages: fake.numPages ?? 12, pages: [{ n: input.first, width: 10, height: 20, bytes: new Uint8Array([137, 80, 78, 71]) }] };
} }) };

await t('the commands in the terminal shell: caps, errors, outputs, /task jobs', async () => {
  const fs = new InMemoryFs(), tasks = new Tasks();
  await fs.mkdir('/work', { recursive: true });
  await fs.writeFile('/work/a.pdf', textPdf());
  await fs.writeFile('/work/n.txt', 'not a pdf');
  const shell = shellFor(fs, { pdf: createPdfService({ tasks, engine: fake }) });
  const sh = async (c) => shell.exec(c, { cwd: '/work' });
  let r = await sh('pdfinfo --help');
  assert.equal(r.exitCode, 0); assert.equal(r.stdout, HELP.pdfinfo);
  r = await sh('pdfinfo n.txt'); assert.equal(r.exitCode, 1); assert.match(r.stderr, /not a PDF file \(no %PDF- header\)/);
  r = await sh('pdfinfo nope.pdf'); assert.match(r.stderr, /no such file/);
  r = await sh('pdfinfo a.pdf'); assert.equal(r.exitCode, 0, r.stderr); assert.match(r.stdout, /^Title:\s+Fake$/m);
  r = await sh('pdftotext -f 2 a.pdf'); assert.match(r.stdout, /wrote \/work\/a\.txt/); assert.equal(await fs.readFile('/work/a.txt'), '[page 2]\nHi\n\f');
  assert.equal(asked.at(-1).last, 2 + TEXT_MAX_PAGES - 1, 'an open range asks for at most TEXT_MAX_PAGES');
  r = await sh('pdftoppm -f 9 a.pdf out/p'); assert.match(r.stdout, /wrote \/work\/out\/p-09\.png \(page 9, 10x20 at 150 DPI\)/, 'poppler pads to the page count');
  // Stopping at a cap without -l: exit 0, and the note on stdout as well as stderr.
  fake.numPages = 312;
  r = await sh('pdftoppm a.pdf big/p'); assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /\n\[stopped at page 50 of 312: pass -f 51 -l 100 for more\]\n$/); assert.match(r.stderr, /pdftoppm: stopped at page 50 of 312 \(RENDER_MAX_PAGES\); continue with -f 51/);
  r = await sh('pdftoppm -q -f 263 a.pdf big/p'); assert.equal(r.stdout, '', 'a range that reaches the end says nothing');
  r = await sh('pdftoppm -q -f 262 a.pdf big/p'); assert.equal(r.stdout, '[stopped at page 311 of 312: pass -f 312 -l 312 for more]\n', '-q keeps the note');
  r = await sh('pdftoppm -f 1 -l 50 a.pdf big/p'); assert.doesNotMatch(r.stdout + r.stderr, /stopped at/, 'an explicit -l is never a cut');
  fake.numPages = 2500;
  r = await sh('pdftotext a.pdf -'); assert.equal(r.exitCode, 0); assert.match(r.stdout, /\[stopped at page 2000 of 2500: pass -f 2001 -l 2500 for more\]\n$/);
  r = await sh('pdftotext a.pdf'); assert.match(r.stdout, /^wrote \/work\/a\.txt .*\n\[stopped at page 2000 of 2500: pass -f 2001 -l 2500 for more\]\n$/);
  assert.doesNotMatch(await fs.readFile('/work/a.txt'), /stopped at/, 'the written text has no note');
  delete fake.numPages;
  r = await sh('pdftoppm -f 1 -l 60 a.pdf p'); assert.equal(r.exitCode, 99); assert.match(r.stderr, /at most 50 per call/);
  r = await sh('pdfinfo -upw enc a.pdf'); assert.equal(r.exitCode, 3); assert.match(r.stderr, /encrypted/);
  assert.ok(tasks.list().every((x) => x.kind === 'job') && tasks.list().length >= 4, 'each run is a /task job');
  assert.match(tasks.list()[0].label, /^pdfinfo a\.pdf$/);
  // Stop through the task.
  fake.hang = true;
  const run = shell.exec('pdfinfo a.pdf', { cwd: '/work' });
  let live;
  for (let i = 0; i < 200 && !live; i++) { await new Promise((r) => setTimeout(r, 1)); live = tasks.list().find((x) => x.status === 'running'); }
  assert.ok(live); await tasks.kill(live);
  r = await run; assert.equal(r.exitCode, 130); assert.match(r.stderr, /stopped \(\/task\/\d+\)/);
  fake.hang = false;
});

await t('size cap before anything loads', async () => {
  const fs = new InMemoryFs();
  await fs.mkdir('/work', { recursive: true });
  await fs.writeFile('/work/big.pdf', '%PDF-1.7\n');
  const big = new Proxy(fs, { get: (t, k) => (k === 'stat' ? async (p) => ({ ...(await t.stat(p)), size: MAX_PDF_BYTES + 1 }) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const [info] = pdfCommands((name, fn) => ({ name, fn }), createPdfService({ tasks: new Tasks(), engine: fake }));
  const r = await info.fn(['big.pdf'], { fs: big, cwd: '/work' });
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /the cap is 256 MiB \(MAX_PDF_BYTES\)/);
});

await t('no service and no runtime: clear errors', async () => {
  const fs = new InMemoryFs();
  await fs.mkdir('/work', { recursive: true }); await fs.writeFile('/work/a.pdf', textPdf());
  let r = await shellFor(fs, {}).exec('pdfinfo a.pdf', { cwd: '/work' });
  assert.match(r.stderr, /the pdf runtime is not available here/);
  r = await shellFor(fs, { pdf: createPdfService({ tasks: new Tasks() }) }).exec('pdfinfo a.pdf', { cwd: '/work' });
  assert.match(r.stderr, /no pdf runtime/);
});

await t('agents get the same commands (createTools bash)', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/tools.js'), 'utf8');
  assert.equal((src.match(/\.\.\.pdfCommands\(defineCommand, hooks\.pdf/g) ?? []).length, 2, 'terminal shellFor and agent bashFor');
});

await t('build: pinned pdf.js, no CDN, no scripting, packed data', async () => {
  const out = mkdtempSync(join(tmpdir(), 'pouch-pdf-node-'));
  try {
    const { pin } = await buildPdf(out);
    const m = JSON.parse(readFileSync(join(out, pin.dir, pin.manifest), 'utf8'));
    assert.deepEqual(m.files.map((f) => f.name), ['worker.js', 'data.pack', 'NOTICE.txt']);
    const file = (name) => Buffer.concat(m.files.find((f) => f.name === name).parts.map((p) => readFileSync(join(out, pin.dir, p.path))));
    const w = file('worker.js').toString();
    assertNoCdn(w, 'pdf worker');
    assert.ok(!/quickjs/i.test(w) && !/new Function\(|\beval\(/.test(w), 'no scripting sandbox, no eval');
    assert.ok(w.includes('pouchFile'), 'pdf.js fetches go to data.pack');
    const d = file('data.pack'), n = d.readUInt32LE(0), idx = JSON.parse(d.subarray(4, 4 + n));
    for (const k of ['wasm/openjpeg.wasm', 'wasm/jbig2.wasm', 'wasm/qcms_bg.wasm', 'standard_fonts/LiberationSans-Regular.ttf', 'cmaps/UniJIS-UTF16-H.bcmap', 'iccs/CGATS001Compat-v2-micro.icc']) assert.ok(idx[k], k);
    assert.ok(!Object.keys(idx).some((k) => /quickjs|nowasm/.test(k)));
    const notice = file('NOTICE.txt').toString();
    for (const k of ['Apache License', 'OpenJPEG', 'JBIG2', 'qcms', 'Foxit', 'Liberation']) assert.match(notice, new RegExp(k, 'i'));
    assert.ok(pin.bytes < 6 * 2 ** 20, `runtime is ${pin.bytes} bytes`);
    assert.deepEqual([...pack([['a', Buffer.from('xy')]])].slice(0, 4), [11, 0, 0, 0]); // {"a":[0,2]}
  } finally { rmSync(out, { recursive: true, force: true }); }
});

console.log(`pdf-node: ${pass} passed`);
