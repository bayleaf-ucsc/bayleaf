// D19 Analyst journey, live against Sealed glm-5-3. Budget: < 15 model requests.
// Attach a messy CSV export and a nested JSON lookup by dropping them on the composer,
// ask for the report, then check it against an independent answer (Python's csv module).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, instrument, sheetClick, rowMore, ensurePanel, waitSignedIn, sleep, URL } from './lib.mjs';
const KEY = process.env.BAYLEAF_API_KEY;
const log = (...a) => console.log(...a.map((x) => (typeof x === 'string' && KEY ? x.replaceAll(KEY, '[key]') : x)));
const results = [];
const ok = (c, m) => { results.push([!!c, m]); log(c ? 'PASS' : 'FAIL', m); };

// ── Fixture: 200 rows, deterministic ──
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const codes = ['CS', 'cmpm', ' ECE', 'math ', 'LING', 'Hist', 'PSYC'];
const first = ['Ana', 'bo', 'CHEN', 'Dee', 'eli', "O'Neil", 'Fatima', 'José', 'kim', 'Lee'];
const last = ['Garcia', 'NGUYEN', 'smith', 'Okafor', 'de la Cruz', 'Lee-Park', 'Müller', 'chen'];
const q = (s) => (/[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s);
const rows = [['employee_id', 'name', 'dept', 'salary', 'notes']];
for (let i = 1; i <= 200; i++) {
  const f = pick(first), l = pick(last);
  const name = rnd() < 0.5 ? `  ${l}, ${f} ` : `${f}   ${l}`;
  let dept = pick(codes);
  let sal = String(50000 + Math.floor(rnd() * 900) * 100);
  if (rnd() < 0.3) sal = '$' + Number(sal).toLocaleString('en-US');
  if (i % 41 === 0) sal = 'n/a';
  if (i % 53 === 0) sal = '';
  if (i % 67 === 0) dept = 'ZZ';
  const notes = pick(['', 'remote', 'says "hi", often', 'line one\nline two', 'joined 2024, rehired', 'he said ""ok""']);
  rows.push([`E${String(i).padStart(4, '0')}`, name, dept, sal, notes]);
}
const csv = rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
const lookup = { exported: '2026-10-01', departments: [
  { code: 'CS', name: 'Computer Science', division: { name: 'Engineering' } },
  { code: 'CMPM', name: 'Computational Media', division: { name: 'Engineering' } },
  { code: 'ECE', name: 'Electrical and Computer Engineering', division: { name: 'Engineering' } },
  { code: 'MATH', name: 'Mathematics', division: { name: 'Physical and Biological Sciences' } },
  { code: 'LING', name: 'Linguistics', division: { name: 'Humanities' } },
  { code: 'HIST', name: 'History', division: { name: 'Humanities' } },
  { code: 'PSYC', name: 'Psychology', division: { name: 'Social Sciences' } },
] };
const fx = '/tmp/pouch-qa/ro-d19'; mkdirSync(fx, { recursive: true });
writeFileSync(fx + '/staff_export.csv', csv); writeFileSync(fx + '/departments.json', JSON.stringify(lookup, null, 2));

// ── Independent expected answer ──
const PY = `
import csv, json, sys, statistics
look = {d['code'].upper(): d['name'] for d in json.load(open(sys.argv[2]))['departments']}
out = {}
for r in csv.DictReader(open(sys.argv[1], newline='', encoding='utf-8')):
    code = r['dept'].strip().upper(); s = r['salary'].strip().replace('$', '').replace(',', '')
    try: v = float(s)
    except ValueError: continue
    if code not in look: continue
    out.setdefault(look[code], []).append(v)
print(json.dumps({k: [len(v), statistics.median(v)] for k, v in out.items()}))`;
const expected = JSON.parse(execFileSync('python3', ['-c', PY, fx + '/staff_export.csv', fx + '/departments.json']).toString());
log('expected', JSON.stringify(expected));

// Parse whatever report.csv the model wrote (header names vary): find the department, count and median columns.
function parseReport(text) {
  const py = `
import csv, sys, json
rows = list(csv.reader(sys.stdin))
print(json.dumps(rows))`;
  const rows = JSON.parse(execFileSync('python3', ['-c', py], { input: text }).toString()).filter((r) => r.length > 1);
  const h = rows[0].map((x) => x.toLowerCase());
  const di = h.findIndex((x) => /dep|name/.test(x) && !/code/.test(x));
  const ci = h.findIndex((x) => /count|^n$|employees|headcount/.test(x));
  const mi = h.findIndex((x) => /median/.test(x));
  return { header: rows[0], map: Object.fromEntries(rows.slice(1).map((r) => [r[di], [Number(r[ci]), Number(String(r[mi]).replace(/[$,]/g, ''))]])) };
}
const compare = (got) => Object.keys(expected).length === Object.keys(got).length &&
  Object.entries(expected).every(([k, [n, m]]) => got[k] && got[k][0] === n && Math.abs(got[k][1] - m) < 0.51);

// ── Run ──
const RERUN = !!process.env.RERUN; // reuse the profile, skip the model turn
const ctx = await launch({ userDataDir: '/tmp/pouch-qa/ro-t14', fresh: !RERUN });
let modelReqs = 0;
ctx.on('request', (r) => { if (/chat\/completions/.test(r.url()) && r.method() === 'POST') modelReqs++; });
const page = await ctx.newPage();
const errors = instrument(page);
await page.goto(URL);
if (!RERUN) {
await page.click('#auth'); page.dialogQueue.push(KEY); await sheetClick(page, 'Paste a key'); await waitSignedIn(page);
await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 60000 });
const glm = await page.$$eval('#model option', (os) => os.map((o) => o.value).find((v) => /glm-5/.test(v)));
await page.selectOption('#model', glm);
if (await page.isVisible('#welcome-dismiss')) await page.click('#welcome-dismiss');
// Drop both files on the composer, the way a user drags them from the desktop.
await page.evaluate(({ csv, json }) => {
  const dt = new DataTransfer();
  dt.items.add(new File([csv], 'staff_export.csv', { type: 'text/csv' }));
  dt.items.add(new File([json], 'departments.json', { type: 'application/json' }));
  document.getElementById('composer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}, { csv, json: JSON.stringify(lookup, null, 2) });
await page.waitForFunction(() => document.querySelectorAll('.attachment').length === 2, null, { timeout: 10000 });
ok(true, 'attached 2 files by drop: ' + (await page.$$eval('.attachment', (a) => a.map((x) => x.textContent).join(' | '))));
const t0 = Date.now();
await page.fill('#input', 'Join these, normalize names, compute per-department median and count, write report.csv, and save the script you used. (report.csv columns: department name, count, median salary. Department codes may have stray spaces or case; skip rows with an unknown department or an unusable salary and tell me how many.)');
await page.click('#send');
await sleep(1500);
for (let t = Date.now(); Date.now() - t < 400_000;) {
  if ((await page.textContent('#send')) === 'Send' && !(await page.$('.msg.assistant.streaming'))) break;
  if (modelReqs >= 14) { log('budget reached: stopping'); await page.click('#send'); break; }
  await sleep(1000);
}
await sleep(1500);
log(`turn took ${Math.round((Date.now() - t0) / 1000)} s, ${modelReqs} model requests`);
const toolPills = await page.$$eval('details.tool summary .what', (s) => s.map((x) => x.textContent));
const bashCmds = await page.$$eval('details.tool pre.cmd', (s) => s.map((x) => x.textContent));
log('tools:', JSON.stringify(toolPills).slice(0, 900));
ok(toolPills.some((t) => /^run:/.test(t)), 'the model used run');
ok(!bashCmds.some((c) => /awk|cut -d|IFS=,/.test(c) && /csv/.test(c)), 'no awk/cut CSV parsing in bash: ' + JSON.stringify(bashCmds).slice(0, 300));

}
// files in /work
const listWork = () => page.evaluate(async () => { const out = []; async function walk(d, pre) { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, pre + n + '/'); else out.push(pre + n); } } await walk(await navigator.storage.getDirectory(), '/work/'); return out; });
const readWork = (p) => page.evaluate(async (p) => { let d = await navigator.storage.getDirectory(); const parts = p.replace(/^\/work\//, '').split('/'); try { for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x); return await (await (await d.getFileHandle(parts.at(-1))).getFile()).text(); } catch { return null; } }, p);
const files = await listWork();
log('work files:', files.join(', '));
const reportPath = files.find((f) => /report\.csv$/.test(f) && !/\.attachments/.test(f)) ?? (RERUN ? '/work/report.csv' : undefined);
const report = reportPath && (await readWork(reportPath));
log('report.csv:\n' + report);
let got = null;
try { got = report && parseReport(report).map; } catch (e) { log('parse error', e.message); }
ok(got && compare(got), 'report.csv is correct (counts exact, medians within 0.5): got ' + JSON.stringify(got));
const scripts = files.filter((f) => /\.m?js$/.test(f) && !/\.attachments/.test(f));
ok(scripts.length > 0, 'a script is saved in /work: ' + scripts.join(', '));
// changes listed under the turn
await page.waitForSelector('.changes .change', { timeout: 10000 }).catch(() => {});
const changeRows = await page.$$eval('.changes .change .p', (rs) => rs.map((r) => r.textContent));
ok(changeRows.some((p) => /report\.csv/.test(p)) && changeRows.some((p) => /\.js$/.test(p)), 'changes under the turn: ' + changeRows.join(', '));
// rerun the saved script from the file browser: report.csv must come out the same
if (scripts.length && reportPath) {
  if (report) await page.evaluate(async (p) => { let d = await navigator.storage.getDirectory(); const parts = p.replace(/^\/work\//, '').split('/'); for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x); await d.removeEntry(parts.at(-1)); }, reportPath);
  await ensurePanel(page, 'files');
  const script = scripts[0];
  await page.click('#refresh'); await sleep(800);
  await page.waitForSelector(`#tree .row:has(.name[title="${script}"])`, { timeout: 5000 }).catch(async () => {
    log('tree rows:', JSON.stringify(await page.$$eval('#tree .row .name', (r) => r.map((x) => x.title)))); });
  await rowMore(page, script); await sheetClick(page, 'Run script');
  await page.waitForSelector('#sheet[open] pre.run-out', { timeout: 15000 });
  const out = await page.textContent('pre.run-out');
  log('rerun:', out.slice(0, 300));
  await page.locator('#sheet-actions button', { hasText: 'Cancel' }).click();
  const again = await readWork(reportPath);
  if (report) ok(again === report, 'rerunning the saved script (Run script) reproduces report.csv byte for byte');
  ok(again && compare(parseReport(again).map), 'the rerun\'s report.csv matches the independent answer');
}
const finalReply = await page.$$eval('.msg.assistant', (m) => m.at(-1)?.textContent ?? '');
log('final reply:', finalReply.slice(0, 600));
log(`model requests: ${modelReqs}`);
log('errors:', errors.slice(0, 5));
await ctx.close();
log(`${results.filter((r) => r[0]).length}/${results.length} passed`);
