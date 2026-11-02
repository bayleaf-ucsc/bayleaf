// Real public-relay transfers, synthetic bytes only. No fake networking or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright';

const root = import.meta.dirname;
const engine = process.env.BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const results = join(root, 'test-results', `${new Date().toISOString().replaceAll(':', '-')}-${engine}-${process.pid}`);
await mkdir(results, { recursive: true });
const report = [{ engine, scope: 'desktop automation, not a physical phone' }];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  // Serve only the experiment's browser assets, never the repo or native tools.
  if (!['/', '/index.html', '/app.js', '/qr.js'].includes(path) && !/^\/pkg\/[a-zA-Z0-9_.]+$/.test(path)) {
    res.writeHead(404).end(); return;
  }
  try {
    const file = join(root, path === '/' ? 'index.html' : path);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await ({ chromium, webkit })[engine].launch({ headless: true });
const children = [];
const errors = [];
async function page(suffix = '') {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(base + suffix);
  await p.locator('#start').click();
  try {
    await p.waitForFunction(() => /^(Connected\.|Connection failed:)/.test(document.querySelector('#status').textContent), null, { timeout: 45000 });
    assert.match(await p.locator('#status').textContent(), /^Connected\./);
  } catch (e) {
    await p.screenshot({ path: join(results, 'connection-failure.png'), fullPage: true });
    throw new Error(`${e.message}; status: ${await p.locator('#status').textContent()}; page errors: ${errors.join('; ')}`);
  }
  return p;
}
async function receive(p, ticket) {
  await p.locator('#ticket').fill(ticket);
  await p.locator('#receive').click();
  await p.waitForFunction(() => /^(Received|Transfer stopped)/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
  assert.match(await p.locator('#status').textContent(), /^Received/);
}
async function receivedBytes(p, index = 0) {
  return Buffer.from(await p.locator('#downloads a').nth(index).evaluate(async a => [...new Uint8Array(await (await fetch(a.href)).arrayBuffer())]));
}
function cli(args, cwd) {
  const child = spawn(join(root, 'tools/bin/sendme'), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); return child;
}
async function completed(child) {
  let output = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGINT'); reject(new Error('native transfer timeout')); }, 120000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, output); return output;
}
async function ticketFrom(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`native sender timeout: ${output}`)), 45000);
    const collect = b => {
      output += b;
      const ticket = output.match(/sendme receive (blob[a-z0-9]+)/)?.[1];
      if (ticket) { clearTimeout(timer); resolve(ticket); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`sender exited ${code}: ${output}`)); });
  });
}
try {
  const sender = await page();
  const bytes = randomBytes(65537);
  await sender.locator('#files').setInputFiles({ name: 'browser-proof.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await sender.locator('#send').click();
  await sender.waitForFunction(() => document.querySelector('#out').value.startsWith('blob'));
  const ticket = await sender.locator('#out').inputValue();
  await sender.locator('#qr').waitFor({ state: 'visible' });
  const receiver = await page(`/#receive=${encodeURIComponent(ticket)}`);
  assert.equal(await receiver.locator('#ticket').inputValue(), ticket);
  assert.equal(new URL(receiver.url()).hash, '', 'ticket fragment consumed');
  await receive(receiver, ticket);
  assert.equal(hash(await receivedBytes(receiver)), hash(bytes));
  report.push({ test: 'browser → browser, independent browser contexts', bytes: bytes.length, sha256: hash(bytes), result: 'pass' });
  console.log(report.at(-1));

  const nativeDir = join(results, 'native-received'); await mkdir(nativeDir);
  const nativeOutput = await completed(cli(['receive', ticket, '--no-progress'], nativeDir));
  assert.equal(hash(await readFile(join(nativeDir, 'browser-proof.bin'))), hash(bytes));
  report.push({ test: 'browser → Sendme 0.37.1', result: 'pass', output: nativeOutput }); console.log(report.at(-1));

  const fixtureDir = join(results, 'native-fixtures'); await mkdir(fixtureDir);
  const directory = join(fixtureDir, 'parcel'); await mkdir(join(directory, 'nested'), { recursive: true });
  await writeFile(join(directory, 'hello.txt'), 'A synthetic parcel, not user content.\n');
  await writeFile(join(directory, 'nested', 'binary.bin'), bytes);
  const nativeSender = cli(['send', directory, '--ticket-type', 'relay', '--no-progress'], fixtureDir);
  const nativeTicket = await ticketFrom(nativeSender);
  await receive(receiver, nativeTicket);
  assert.equal(await receiver.locator('#downloads a').count(), 2);
  const labels = await receiver.locator('#downloads a').allTextContents();
  const index = labels.findIndex(s => s.startsWith('parcel/nested/binary.bin'));
  assert.ok(index >= 0); assert.equal(hash(await receivedBytes(receiver, index)), hash(bytes));
  const textIndex = labels.findIndex(s => s.startsWith('parcel/hello.txt'));
  assert.ok(textIndex >= 0);
  assert.equal((await receivedBytes(receiver, textIndex)).toString(), 'A synthetic parcel, not user content.\n');
  report.push({ test: 'Sendme directory → browser, nested names and binary integrity', result: 'pass' }); console.log(report.at(-1));
  nativeSender.kill('SIGINT');

  // Separate nodes isolate the interruption test from prior complete downloads.
  const resume = await receiver.evaluate(async () => {
    const { TransferNode } = await import('./pkg/pouch_sendme_experiment.js');
    const provider = await TransferNode.spawn(), consumer = await TransferNode.spawn();
    try {
      const data = new Uint8Array(8 * 1024 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i % 251;
      await provider.add_file('resume.bin', data);
      const ticket = await provider.ticket(); let paused = false, firstError, cached = 0;
      try {
        await consumer.receive(ticket, (downloaded) => {
          if (!paused && downloaded >= 16384) { paused = true; consumer.pause(); }
        });
      } catch (e) { firstError = e.message; }
      if (!firstError) throw new Error('interruption did not interrupt');
      const infos = await consumer.receive(ticket, (_n, _total, before) => { cached = before; });
      const restored = await consumer.file_bytes(0);
      if (restored.length !== data.length || restored.some((b, i) => b !== data[i])) throw new Error('resume integrity failed');
      return { paused, firstError, cached, bytes: restored.length, files: infos.length };
    } finally { await consumer.close(); consumer.free(); await provider.close(); provider.free(); }
  });
  assert.ok(resume.cached > 0, 'retry should reuse already validated bytes');
  report.push({ test: 'interrupted browser download resumes from verified memory cache', result: 'pass', ...resume }); console.log(report.at(-1));
  assert.deepEqual(errors, [], 'no unhandled page errors');
  await receiver.screenshot({ path: join(results, 'receiver.png'), fullPage: true });
  await sender.screenshot({ path: join(results, 'sender.png'), fullPage: true });
  await receiver.setViewportSize({ width: 390, height: 844 });
  assert.ok(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at phone width');
  await receiver.screenshot({ path: join(results, 'receiver-mobile.png'), fullPage: true });
} catch (e) {
  report.push({ result: 'FAIL', error: e.stack, pageErrors: errors });
  throw e;
} finally {
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  for (const child of children) if (child.exitCode === null) child.kill('SIGINT');
  await browser.close(); await new Promise(r => server.close(r));
  console.log(`Evidence: ${results}`);
}
