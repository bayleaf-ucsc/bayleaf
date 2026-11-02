// The duckdb command without a browser (src/duckdb.ts): argument parsing, the
// SQL scanner (statements, quoted paths, COPY targets, dot commands), planning
// against the caller's view (inputs, globs, relative paths, caps, refusals),
// output formats, error hints, the add-on step (not installed: nothing
// downloaded), jobs with a fake worker (Stop, a trap), the commands in both
// shells, and the build's pins and containment (build-duckdb.mjs).
// The real runtime: test/duckdb-browser.mjs.
// Run: node test/duckdb-node.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryFs } from 'just-bash';
import { parseArgs, scan, plan, expandGlob, formatResult, duckType, explain, plainError, isQuiet, moreNote, createDuckdbService, duckdbWorker,
  HELP, DUCKDB_VERSION, DUCKDB_PACKAGE, MAX_INPUT_BYTES, MAX_ROWS, MAX_CELL_WIDTH, MAX_STDOUT_BYTES } from '../src/duckdb.ts';
import { Tasks } from '../src/ns/tasks.ts';
import { shellFor } from '../src/tools.ts';
import { DUCKDB, EXTENSIONS } from '../build-duckdb.mjs';
import { messyExpected, parseCsv } from './duckdb-fixtures.mjs';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('ok', name); };
const root = resolve(import.meta.dirname, '..');

await t('parseArgs: the CLI\'s flags, SQL sources, refusals', () => {
  assert.deepEqual(parseArgs(['-csv', '-c', 'SELECT 1']).opts, { mode: 'csv', sql: 'SELECT 1', header: null, nullvalue: '', maxRows: 40, echo: false, version: false });
  assert.equal(parseArgs(['--json', '-f', 'q.sql']).opts.file, 'q.sql');
  assert.equal(parseArgs([':memory:', 'SELECT 2']).opts.sql, 'SELECT 2');
  assert.equal(parseArgs(['-noheader', '-separator', '\\t', '-list']).opts.separator, '\t');
  assert.equal(parseArgs(['-maxrows', '500']).opts.maxRows, 500);
  assert.deepEqual(parseArgs(['-help']), { help: true });
  assert.match(parseArgs(['-maxrows', String(MAX_ROWS + 1)]).error, /MAX_ROWS[\s\S]*COPY/);
  assert.match(parseArgs(['-maxrows', 'x']).error, /whole number/);
  assert.match(parseArgs(['-c', 'a', '-f', 'b']).error, /not both/);
  assert.match(parseArgs(['-c']).error, /needs a value/);
  assert.match(parseArgs(['-zz']).error, /unknown option -zz/);
  assert.match(parseArgs(['SELECT 1']).error, /database file's place; put SQL after -c/);
  assert.match(parseArgs(['/work/t.duckdb', '-c', 'SELECT 1']).error, /database files are not supported[\s\S]*FORMAT parquet/);
  assert.match(parseArgs(['-readonly']).error, /database files are not supported/);
});

await t('scan: statements split outside quotes and comments; literals know the keyword before them', () => {
  const s = scan(`-- a comment; with a semicolon\nSELECT 'a;b' AS "x;y" FROM '/work/f.csv'; /* ; */ COPY (SELECT 1) TO 'out.csv' (HEADER);\n\n`);
  assert.deepEqual(s.statements, [`-- a comment; with a semicolon\nSELECT 'a;b' AS "x;y" FROM '/work/f.csv'`, '/* ; */ COPY (SELECT 1) TO \'out.csv\' (HEADER)']);
  assert.deepEqual(s.literals.map((l) => [l.value, l.after]), [['a;b', 'SELECT'], ['/work/f.csv', 'FROM'], ['out.csv', 'TO']]);
  assert.deepEqual(scan("SELECT 'it''s'").literals.map((l) => l.value), ["it's"]);
  assert.equal(scan('.mode csv\nSELECT 1').dot, '.mode csv');
  assert.equal(scan('SELECT 1.5, a.b FROM t').dot, null);
  assert.deepEqual(scan('SELECT $$a;b$$; SELECT 2').statements, ['SELECT $$a;b$$', 'SELECT 2']);
  assert.deepEqual(scan('-- only a comment\n').statements, []);
});

const fsWith = async (files) => { const fs = new InMemoryFs(); for (const [p, b] of Object.entries(files)) { await fs.mkdir(p.replace(/\/[^/]*$/, '') || '/', { recursive: true }); await fs.writeFile(p, b); } return fs; };
await t('plan: quoted paths become inputs, relative ones absolute; COPY targets are outputs; globs expand', async () => {
  const fs = await fsWith({ '/work/a.csv': 'x\n1\n', '/work/data/2024-01.csv': 'x\n2\n', '/work/data/2024-02.csv': 'x\n3\n', '/work/data/notes.txt': 'n', '/work/sub/deep/z.parquet': 'PAR1' });
  const p = await plan(fs, '/work', "SELECT * FROM 'a.csv' WHERE x <> 'CM'; COPY (FROM 'data/2024-*.csv') TO 'out/sum.csv' (HEADER)");
  assert.deepEqual(p.inputs, ['/work/a.csv', '/work/data/2024-01.csv', '/work/data/2024-02.csv']);
  assert.deepEqual(p.outputs, ['/work/out/sum.csv']);
  assert.deepEqual(p.statements, ["SELECT * FROM '/work/a.csv' WHERE x <> 'CM'", "COPY (FROM '/work/data/2024-*.csv') TO '/work/out/sum.csv' (HEADER)"]);
  assert.deepEqual(p.allowed.sort(), ['/work/', '/work/data/', '/work/out/']);
  assert.deepEqual(await expandGlob(fs, '/work/**/*.parquet'), ['/work/sub/deep/z.parquet']);
  const u = await plan(fs, '/work', "SELECT * FROM 'https://example.com/x.csv' WHERE note = 'a.csv'");
  assert.deepEqual(u.inputs, ['/work/a.csv'], 'a URL is never a file; a literal naming a file is handed over');
});

await t('plan: caps and refusals before anything loads', async () => {
  const fs = await fsWith({ '/work/big.csv': 'x' });
  const big = { ...fs, readdir: (p) => fs.readdir(p), stat: async (p) => ({ ...(await fs.stat(p)), size: MAX_INPUT_BYTES + 1 }) };
  assert.match((await plan(big, '/work', "FROM '/work/big.csv'")).error, /MAX_INPUT_BYTES/);
  assert.match((await plan(fs, '/work', ".tables")).error, /dot commands are not supported/);
  assert.match((await plan(fs, '/work', "ATTACH '/work/x.duckdb'")).error, /ATTACH: database files are not supported/);
  assert.match((await plan(fs, '/work', "COPY t TO '/work/o' (FORMAT parquet, PARTITION_BY (y))")).error, /PARTITION_BY/);
});

const res = (columns, rows, more = false) => ({ columns: columns.map(([name, type, numeric = false]) => ({ name, type, numeric })), rows, more });
const R = res([['name', 'Utf8'], ['n', 'Decimal[38e0]', true], ['when', 'Date32<DAY>']], [['Di, Jr', '12345678901234567890', '2026-01-05'], ['a "q"', '7', null]]);
await t('formatResult: box, csv, list, json, jsonlines, markdown, line', () => {
  const o = (mode, x = {}) => formatResult(R, { mode, header: null, nullvalue: '', ...x });
  assert.equal(o('csv'), 'name,n,when\n"Di, Jr",12345678901234567890,2026-01-05\n"a ""q""",7,\n');
  assert.equal(o('csv', { header: false, nullvalue: 'NULL' }), '"Di, Jr",12345678901234567890,2026-01-05\n"a ""q""",7,NULL\n');
  assert.equal(o('list'), 'name|n|when\nDi, Jr|12345678901234567890|2026-01-05\na "q"|7|\n');
  assert.equal(o('json'), '[{"name":"Di, Jr","n":12345678901234567890,"when":"2026-01-05"},\n{"name":"a \\"q\\"","n":7,"when":null}]\n');
  assert.equal(o('jsonlines').split('\n').length, 3);
  assert.equal(o('markdown'), '| name | n | when |\n|---|---:|---|\n| Di, Jr | 12345678901234567890 | 2026-01-05 |\n| a "q" | 7 |  |\n');
  assert.equal(o('line'), 'name = Di, Jr\n   n = 12345678901234567890\nwhen = 2026-01-05\n\nname = a "q"\n   n = 7\nwhen = NULL\n');
  const box = o('box');
  assert.match(box, /^┌─+┬─+┬─+┐\n│ +name +│ +n +│ +when +│\n│ varchar │ +decimal\(38,0\) +│ +date +│\n├/);
  assert.match(box, /│ Di, Jr +│ 12345678901234567890 │ 2026-01-05 │/);
  assert.match(box, /│ a "q" +│ +7 │ NULL +│\n└/);
  assert.match(formatResult(res([['x', 'Int32', true]], []), { mode: 'box', header: null, nullvalue: '' }), /0 rows\n$/);
  const wide = formatResult(res([['s', 'Utf8']], [['y'.repeat(200)]]), { mode: 'box', header: null, nullvalue: '' });
  assert.ok(wide.includes('y'.repeat(MAX_CELL_WIDTH - 1) + '…'));
  assert.equal(formatResult(res([['s', 'Utf8']], [['y'.repeat(200)]]), { mode: 'csv', header: false, nullvalue: '' }), 'y'.repeat(200) + '\n', 'csv is never cut');
  assert.match(moreNote(40), /40 rows shown; there are more[\s\S]*COPY/);
});

await t('duckType, isQuiet, plainError, explain', () => {
  assert.equal(duckType('Int64'), 'bigint'); assert.equal(duckType('Decimal[14e+2]'), 'decimal(14,2)'); assert.equal(duckType('Timestamp<MICROSECOND>'), 'timestamp');
  assert.ok(isQuiet('COPY t TO x', res([['Count', 'Int64']], [[3]])));
  assert.ok(isQuiet('-- c\nSET x=1', res([['Success', 'Bool']], [])));
  assert.ok(!isQuiet('SELECT count(*) AS Count FROM t', res([['Count', 'Int64']], [[3]])));
  assert.equal(plainError('{"exception_type":"Parser","exception_message":"syntax error at or near \\"SELEC\\""}'), 'Parser Error: syntax error at or near "SELEC"');
  assert.match(explain('Permission Error: Cannot access file "/work/x.csv" - file system operations are disabled by configuration'), /^\/work\/x\.csv: no such file in your files \(ls \/work\/ to check/);
  assert.match(explain('Permission Error: Cannot access file "https://e.com/x.csv" - file system operations are disabled'), /has no network[\s\S]*put the file in \/work/);
  assert.match(explain('Permission Error: Loading external extensions is disabled through configuration'), /no network and loads no other extensions/);
  assert.match(explain('Invalid Input Error: CSV Error on Line: 3'), /all_varchar=true/);
});

// A fake worker: answers 'load', then each 'run' with a scripted reply.
function fakeSpawn(script, log) {
  return () => {
    const w = { terminated: false, onmessage: null, onerror: null,
      postMessage(msg) {
        log.push(msg.action);
        if (msg.action === 'load') return queueMicrotask(() => w.onmessage({ data: { id: msg.id, result: { version: 'v1.4.3', extensions: ['parquet', 'json'] } } }));
        const step = script.shift();
        if (step === 'hang') return;
        queueMicrotask(() => w.onmessage({ data: { id: msg.id, ...step(msg) } }));
      },
      terminate() { w.terminated = true; log.push('terminate'); } };
    return w;
  };
}
const files = { 'worker.js': new Blob(['']), 'duckdb-eh.wasm': new Blob([new Uint8Array(8)]), 'extensions.pack': new Blob([new Uint8Array(8)]) };
// An add-on's assets (addons.assets('duckdb')): installed, or the asked tier's standard refusal.
const NOT_INSTALLED = 'not installed: DuckDB (38 MiB). Run `addons install duckdb`; the user will be asked.';
const installed = { obtain: async () => ({ files }) };
const absent = { obtain: async () => { throw Object.assign(new Error(NOT_INSTALLED), { code: 'ENOTINSTALLED' }); } };

await t('add-on: not installed returns the standard sentence, starts no worker; a build without the pin says not available', async () => {
  const tasks = new Tasks(), log = [];
  const service = createDuckdbService({ tasks, worker: duckdbWorker({ assets: absent, spawn: fakeSpawn([], log) }) });
  const shell = shellFor(await fsWith({ '/work/a.csv': 'x\n1\n' }), { duckdb: service });
  const r = await shell.exec(`duckdb -c "FROM 'a.csv'"`, { cwd: '/work' });
  assert.equal(r.exitCode, 1); assert.equal(r.stderr, `duckdb: ${NOT_INSTALLED}\n`);
  assert.deepEqual(log, [], 'no worker started');
  const none = shellFor(await fsWith({}), { duckdb: createDuckdbService({ tasks }) });
  assert.match((await none.exec('duckdb -c "SELECT 1"')).stderr, /not available here: this build of Pouch leaves DuckDB out/);
});

await t('jobs: a run is a /task job; outputs are written back; Stop ends the worker; a trap restarts it', async () => {
  const tasks = new Tasks(), log = [];
  const script = [
    (m) => ({ result: { version: 'v1.4.3', results: [res([['Count', 'Int64']], [[2]])], error: null, outputs: [{ name: m.outputs[0], bytes: new TextEncoder().encode('x\n1\n') }] } }),
    'hang',
    () => ({ error: 'the DuckDB engine failed (unreachable); it restarts on the next command', code: 'ETRAP' }),
    () => ({ result: { version: 'v1.4.3', results: [res([['answer', 'Int32', true]], [[42]])], error: null, outputs: [] } }),
  ];
  const service = createDuckdbService({ tasks, worker: duckdbWorker({ assets: installed, spawn: fakeSpawn(script, log) }) });
  const fs = await fsWith({ '/work/a.csv': 'x\n1\n' });
  const shell = shellFor(fs, { duckdb: service });
  let r = await shell.exec(`duckdb -c "COPY (FROM 'a.csv') TO 'b.csv' (HEADER)"`, { cwd: '/work' });
  assert.equal(r.exitCode, 0, r.stderr); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'wrote /work/b.csv (4 bytes)\n');
  assert.equal(await fs.readFile('/work/b.csv'), 'x\n1\n');
  assert.ok(tasks.list().some((t) => t.kind === 'job' && t.label.startsWith('duckdb COPY') && t.status === 'done'));
  const pending = shell.exec(`duckdb -c "SELECT 1"`, { cwd: '/work' });
  await new Promise((r) => setTimeout(r, 20));
  const job = tasks.list().find((t) => t.status === 'running');
  await tasks.kill(job);
  r = await pending;
  assert.equal(r.exitCode, 130); assert.match(r.stderr, /stopped \(\/task\//);
  r = await shell.exec(`duckdb -c "SELECT 1"`, { cwd: '/work' });
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /restarts on the next command/);
  r = await shell.exec(`duckdb -csv -noheader -c "SELECT 42"`, { cwd: '/work' });
  assert.equal(r.stdout, '42\n');
  assert.deepEqual(log, ['load', 'run', 'run', 'terminate', 'load', 'run', 'terminate', 'load', 'run']);
});

await t('remove unloads: a running job ends with a reason, never hangs; the next run loads again', async () => {
  const tasks = new Tasks(), log = [];
  const service = createDuckdbService({ tasks, worker: duckdbWorker({ assets: installed, spawn: fakeSpawn(['hang', () => ({ result: { version: 'v1.4.3', results: [res([['answer', 'Int32', true]], [[1]])], error: null, outputs: [] } })], log) }) });
  const shell = shellFor(await fsWith({}), { duckdb: service });
  const pending = shell.exec('duckdb -c "SELECT 1"');
  await new Promise((r) => setTimeout(r, 20));
  await service.jobs.unload('duckdb'); // what session-list's beforeRemove does for DUCKDB
  const r = await pending;
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /DuckDB was removed while this job ran/);
  assert.equal((await shell.exec('duckdb -csv -noheader -c "SELECT 1"')).stdout, '1\n');
  assert.deepEqual(log, ['load', 'run', 'terminate', 'load', 'run']);
});

await t('the command: help, version, SQL from -f and stdin, -o, output cap, errors by statement', async () => {
  const tasks = new Tasks(), log = [], seen = [];
  const big = 'z'.repeat(1000);
  const reply = (m) => { seen.push(m.statements); return { result: { version: 'v1.4.3', results: m.statements.map(() => res([['s', 'Utf8']], Array.from({ length: 400 }, () => [big]))), error: null, outputs: [] } }; };
  const service = createDuckdbService({ tasks, worker: duckdbWorker({ assets: installed, spawn: fakeSpawn([reply, reply, reply, reply, (m) => ({ result: { version: 'v1.4.3', results: [res([['a', 'Int32', true]], [[1]])], error: { message: 'Binder Error: Referenced column "nope" not found', statement: 1 }, outputs: [] } })], log) }) });
  const fs = await fsWith({ '/work/q.sql': 'SELECT 1;\nSELECT 2;\n' });
  const shell = shellFor(fs, { duckdb: service });
  assert.equal((await shell.exec('duckdb -help')).stdout, HELP);
  assert.match((await shell.exec('duckdb -version')).stdout, new RegExp(`${DUCKDB_VERSION.replaceAll('.', '\\.')} \\(DuckDB-Wasm ${DUCKDB_PACKAGE}`));
  assert.match((await shell.exec('duckdb', { cwd: '/work' })).stderr, /no SQL: give -c/);
  await shell.exec('duckdb -csv -f q.sql', { cwd: '/work' });
  await shell.exec('duckdb -csv < q.sql', { cwd: '/work' });
  assert.deepEqual(seen.slice(0, 2), [['SELECT 1', 'SELECT 2'], ['SELECT 1', 'SELECT 2']]);
  let r = await shell.exec(`duckdb -csv -c "SELECT s"`, { cwd: '/work' });
  assert.ok(r.stdout.length <= MAX_STDOUT_BYTES + 200); assert.match(r.stdout, /\[output cut at 256 KiB \(MAX_STDOUT_BYTES\)/);
  r = await shell.exec(`duckdb -o out.txt -csv -c "SELECT s"`, { cwd: '/work' });
  assert.equal(r.stdout, ''); assert.match(r.stderr, /wrote \/work\/out\.txt \(printed output\)/);
  r = await shell.exec(`duckdb -c "SELECT 1 AS a; SELECT nope"`, { cwd: '/work' });
  assert.equal(r.exitCode, 1); assert.match(r.stdout, /│ +1 │/); assert.match(r.stderr, /Error \(statement 2 of 2: SELECT nope\): Binder Error/);
});

await t('the agents\' bash has duckdb too; the skill names the recipe and the caps', async () => {
  const defaultFiles = (await import('../src/defaults.ts')).default;
  const all = JSON.stringify(defaultFiles);
  assert.match(all, /name: duckdb/); assert.match(all, /DESCRIBE FROM/); assert.match(all, /SUMMARIZE FROM/); assert.match(all, /duckdb -f \/work\/<name>\.sql/);
  assert.match(all, /addons install duckdb/); assert.match(all, /256 MiB of input/);
  assert.match(readFileSync(join(root, 'src/tools.ts'), 'utf8'), /duckdbCommands\(defineCommand, hooks\.duckdb, \(\) => hooks\.addonsWho/);
});

await t('DB2 fixture: the independent computation has the expected shape', () => {
  assert.deepEqual(messyExpected(), [['EAST', '2026-01', null, null, 1], ['EAST', '2026-02', 2300, 1150, 2], ['NORTH, UPPER', '2026-02', 12000.25, 12000.25, 1], ['WEST', '2026-01', 86250.5, 43125.25, 2], ['WEST', '2026-02', 450, 450, 1]]);
  assert.equal(parseCsv('a,b\n"x\ny","z ""q"""\n')[0].a, 'x\ny');
});

await t('build pins: package version, engine version, extension hashes, constants agree', async () => {
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies['@duckdb/duckdb-wasm'], DUCKDB.version);
  assert.equal(DUCKDB.version, DUCKDB_PACKAGE); assert.equal(DUCKDB.engine, DUCKDB_VERSION);
  assert.deepEqual(EXTENSIONS.map(([n]) => n), ['parquet', 'json']);
  for (const [, url, hash] of EXTENSIONS) { assert.match(url, new RegExp(`^https://extensions\\.duckdb\\.org/${DUCKDB.engine}/wasm_eh/`)); assert.match(hash, /^[0-9a-f]{64}$/); }
  if (process.env.SKIP_BUILD) return;
  const { buildDuckdb } = await import('../build-duckdb.mjs');
  const out = mkdtempSync(join(process.env.POUCH_TEST_TMP || tmpdir(), 'pouch-duckdb-node-'));
  try {
    process.chdir(root);
    const { pin, sums } = await buildDuckdb(out);
    const manifest = JSON.parse(readFileSync(join(out, pin.dir, pin.manifest), 'utf8'));
    assert.deepEqual(manifest.files.map((f) => f.name), ['worker.js', 'duckdb-eh.wasm', 'extensions.pack', 'NOTICE.txt']);
    assert.ok(manifest.files.find((f) => f.name === 'duckdb-eh.wasm').parts.length === 2);
    assert.ok(sums.every(([, p]) => p.startsWith('runtime/duckdb/')));
    const worker = readFileSync(join(out, pin.dir, manifest.files[0].parts[0].path), 'utf8');
    assert.doesNotMatch(worker, /cdn\.jsdelivr/); assert.match(worker, /Pouch's DuckDB has no network/); assert.match(worker, /enable_external_access=false/);
    const wasm = Buffer.concat(manifest.files[1].parts.map((p) => readFileSync(join(out, pin.dir, p.path)))).toString('latin1');
    assert.ok(!wasm.includes('unpkg.com') && wasm.includes('href="data:text/css,/*'), 'the engine\'s one CDN string is rewritten');
    assert.match(readFileSync(join(out, pin.dir, manifest.files[3].parts[0].path), 'utf8'), /Stichting DuckDB Foundation[\s\S]*Apache License/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

console.log(`duckdb-node: ${pass} passed`);
