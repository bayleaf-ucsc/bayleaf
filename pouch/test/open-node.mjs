// The `open` command and `cat` in the terminal (src/open-cli.ts, src/terminal.ts):
// the content type -> mode table, the flags and their misuse, folders, missing
// and binary files, the page hooks it calls (fakes here), and an agent's
// `open` refusing through the bash tool. No page, no network.
// Run: node test/open-node.mjs
import assert from 'node:assert/strict';
import { InMemoryFs } from 'just-bash';
import { Type } from 'typebox';
import { parseArgs, planOpen, AGENT_REFUSAL, SHOW_HELP, shownLines } from '../src/open-cli.ts';
import { shellFor, createTools, clip } from '../src/tools.ts';
globalThis.navigator ??= {};
const { binaryOutput } = await import('../src/terminal.ts');

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };

// 1. Defaults by content type, and what each flag does.
const table = [
  ['/work/a.md', null, 'preview', false, 'Preview'],
  ['/work/a.md', '--raw', 'raw', false, 'Raw'],
  ['/work/r.html', null, 'preview', false, 'Preview, Static'],
  ['/work/r.htm', '--preview', 'preview', false, 'Preview, Static'],
  ['/work/r.html', '--static', 'preview', false, 'Preview, Static'],
  ['/work/r.html', '--interactive', 'preview', true, 'Preview, Interactive'],
  ['/work/r.html', '--raw', 'raw', false, 'Raw'],
  ['/work/i.svg', null, 'preview', false, 'Preview'],
  ['/work/i.svg', '--raw', 'raw', false, 'Raw'],
  ['/work/p.png', null, 'preview', false, 'Preview'],
  ['/work/s.mp3', null, 'preview', false, 'Preview'],
  ['/work/v.webm', '--preview', 'preview', false, 'Preview'],
  ['/work/x.js', null, 'raw', false, 'Raw'],
  ['/work/notes.txt', '--raw', 'raw', false, 'Raw'],
  ['/work/Makefile', null, 'raw', false, 'Raw'],
];
for (const [path, flag, mode, interactive, label] of table) {
  const p = planOpen(path, flag);
  assert.deepEqual([p.mode, p.interactive, p.label], [mode, interactive, label], `${path} ${flag}`);
}
ok(`content type -> mode table (${table.length} rows): Markdown and HTML Preview (HTML Static), media Preview, text Raw; Interactive only when asked`);

// 2. Misuse: wrong flag for the type, binary with no preview.
for (const [path, flag, re] of [
  ['/work/a.md', '--interactive', /--interactive is for HTML reports; a.md is a Markdown file/],
  ['/work/p.png', '--static', /--static is for HTML reports/],
  ['/work/p.png', '--raw', /is an image file with no Raw view/],
  ['/work/x.js', '--preview', /x.js has no preview/],
]) assert.match(planOpen(path, flag).error, re, `${path} ${flag}`);
assert.match(planOpen('/work/a.zip', null, { binary: true }).error, /looks binary and has no preview.*unzip -l a.zip/);
ok('misuse: Static/Interactive on non-HTML, Raw on media, Preview on code, and binary files are refused with a next step');

// 3. Argument parsing.
assert.deepEqual(parseArgs(['a.md']), { path: 'a.md', flag: null });
assert.deepEqual(parseArgs(['--preview', '--static', 'r.html']), { path: 'r.html', flag: '--static' });
assert.deepEqual(parseArgs(['--', '--raw']), { path: '--raw', flag: null });
assert.ok(parseArgs(['-h']).help && parseArgs(['--help', 'x']).help);
assert.match(parseArgs([]).error, /which file\?/);
assert.match(parseArgs(['a', 'b']).error, /one path, got 2/);
assert.match(parseArgs(['--raw', '--interactive', 'r.html']).error, /choose one mode, not --raw and --interactive/);
assert.match(parseArgs(['--raw', '--preview', 'a.md']).error, /choose one mode/);
assert.match(parseArgs(['--static', '--interactive', 'r.html']).error, /choose one mode/);
assert.match(parseArgs(['-r', 'a.md']).error, /unknown option -r/);
ok('arguments: one path, at most one mode (--static/--interactive imply --preview), -- ends options, unknown options named');

// 4. The terminal's shell: the command calls the page's hooks with the plan.
const fs = new InMemoryFs();
await fs.mkdir('/work/docs', { recursive: true });
await fs.writeFile('/work/docs/a.md', '# Notes\n');
await fs.writeFile('/work/r.html', '<p>report</p>');
await fs.writeFile('/work/x.js', 'export {}\n');
await fs.writeFile('/work/p.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
await fs.writeFile('/work/blob.bin', new Uint8Array([1, 0, 2, 0]));
const calls = [];
let keep = false;
const sh = shellFor(fs, {
  openFile: async (req) => { calls.push(['file', req]); return keep === 'binary' ? 'binary' : !keep; },
  revealDir: async (path) => { calls.push(['dir', path]); },
});
const run = (cmd, cwd = '/work') => sh.exec(cmd, { cwd });
let r = await run('open a.md', '/work/docs');
assert.equal(r.exitCode, 0); assert.equal(r.stdout, 'opened /work/docs/a.md (Preview)\n');
r = await run('open --interactive r.html');
assert.equal(r.stdout, 'opened /work/r.html (Preview, Interactive)\n');
r = await run('open x.js && open p.png');
assert.equal(r.exitCode, 0);
assert.deepEqual(calls.splice(0), [
  ['file', { path: '/work/docs/a.md', mode: 'preview', interactive: false }],
  ['file', { path: '/work/r.html', mode: 'preview', interactive: true }],
  ['file', { path: '/work/x.js', mode: 'raw', interactive: false }],
  ['file', { path: '/work/p.png', mode: 'preview', interactive: false }],
]);
ok('terminal: open resolves paths against the cwd and asks the page for the planned mode; prints what it opened');

// 5. Folders open in Files; flags on a folder are a usage error.
r = await run('open docs');
assert.equal(r.exitCode, 0); assert.equal(r.stdout, 'showing /work/docs in Files\n');
r = await run('open .', '/work/docs');
assert.equal(r.stdout, 'showing /work/docs in Files\n');
assert.deepEqual(calls.splice(0), [['dir', '/work/docs'], ['dir', '/work/docs']]);
r = await run('open --raw docs');
assert.equal(r.exitCode, 2); assert.match(r.stderr, /--raw is for files; \/work\/docs is a folder/);
assert.equal(calls.length, 0);
ok('folders: open <folder> shows it in Files (revealDir), including "."; a mode flag on a folder is exit 2');

// 6. Errors and exit codes; nothing reaches the page on an error.
const cases = [
  ['open', 2, /which file\?.*\n.*open --help/s],
  ['open --bogus a.md', 2, /unknown option --bogus/],
  ['open nope.md', 1, /\/work\/nope.md: no such file\. List the folder with `ls \/work`/],
  ['open blob.bin', 1, /looks binary and has no preview/],
  ['open --preview x.js', 1, /no preview/],
  ['open --static docs/a.md', 1, /--static is for HTML reports/],
];
for (const [cmd, code, re] of cases) { r = await run(cmd); assert.equal(r.exitCode, code, cmd); assert.match(r.stderr, re, cmd); }
assert.equal(calls.length, 0);
r = await run('open --help');
assert.equal(r.exitCode, 0); assert.match(r.stdout, /HTML \(\.html, \.htm\)\s+Preview, Static/); assert.match(r.stdout, /--interactive.*\n.*WebRTC/s);
keep = true;
r = await run('open x.js');
assert.equal(r.exitCode, 1); assert.match(r.stderr, /kept your unsaved changes; \/work\/x.js was not opened/);
keep = 'binary';
r = await run('open x.js');
assert.equal(r.exitCode, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /\/work\/x.js was not opened \(binary\)/);
keep = false;
ok(`errors: ${cases.length} misuse cases with exit 1 or 2 and no page call; --help documents the table; kept unsaved changes or a refused binary is exit 1`);

// 7. cat: a just-bash builtin already; the terminal hides binary output on screen only.
r = await run('cat docs/a.md');
assert.equal(r.stdout, '# Notes\n');
r = await run('cat p.png');
assert.match(binaryOutput(r.stdout), /^\[binary output: 8 bytes not shown/);
r = await run('cat p.png | od -c | head -1');
assert.match(r.stdout, /211\s+P\s+N\s+G/);
assert.equal(binaryOutput(r.stdout), null);
assert.equal(binaryOutput('plain text\n'), null);
ok('cat: builtin over the files; binary output is replaced by a note on screen, while pipes keep the bytes');

// 8. An agent's open refuses (no hook is reachable from the agents' bash), naming links instead.
const afs = new InMemoryFs();
await afs.mkdir('/work', { recursive: true });
await afs.writeFile('/work/r.html', '<p>x</p>');
const [, , , bash] = createTools({ fs: afs, changed() {} }, Type, { defenseInDepth: false });
await assert.rejects(bash.execute({ command: 'open --interactive /work/r.html' }, {}), (e) => {
  assert.ok(e.message.includes(AGENT_REFUSAL), e.message); assert.match(e.message, /exit code 1/); return true;
});
assert.match(AGENT_REFUSAL, /open is the person's; use `show <path>`/);
ok('agents: `open` in the bash tool is refused with exit 1 and points to `show`');

// 9. An agent's show: open's paths, defaults and checks; the page (a fake here) opens or offers.
await afs.mkdir('/work/out', { recursive: true });
await afs.writeFile('/work/n.md', '# n');
await afs.writeFile('/work/b.bin', new Uint8Array([97, 0, 98]));
const asked = [];
let answer = { opened: true };
const [, , , sbash] = createTools({ fs: afs, changed() {} }, Type, { defenseInDepth: false }, { show: async (req, caller) => { asked.push({ ...req, caller }); return answer; } });
let o = await sbash.execute({ command: 'show n.md' }, { caller: 7 });
assert.match(o, /^shown: opened \/work\/n\.md \(Preview\)/);
assert.deepEqual(asked.pop(), { path: '/work/n.md', dir: false, mode: 'preview', label: 'Preview', caller: 7 });
o = await sbash.execute({ command: 'show /work/r.html' }, {});
assert.match(o, /shown: opened \/work\/r\.html \(Preview, Static\)/);
o = await sbash.execute({ command: 'show out' }, {});
assert.match(o, /shown: opened \/work\/out \(Files\)/);
assert.equal(asked.pop().dir, true);
answer = { opened: false, reason: 'unsaved edits' };
o = await sbash.execute({ command: 'show --raw n.md' }, {});
assert.match(o, /^shown: offered \/work\/n\.md \(Raw\); not opened \(user busy: unsaved edits\), the transcript has an Open button/);
const n0 = asked.length;
for (const [cmd, re] of [
  ['show --interactive r.html', /--interactive is the person's choice/],
  ['show nope.md', /no such file/],
  ['show b.bin', /looks binary/],
  ['show --static n.md', /--static is for HTML reports/],
  ['show --raw out', /--raw is for files/],
]) await assert.rejects(sbash.execute({ command: cmd }, {}), (e) => { assert.match(e.message, re, cmd); assert.doesNotMatch(e.message, /`open /, cmd); return true; });
assert.equal(asked.length, n0, 'misuse never reaches the page');
assert.match(SHOW_HELP, /no --interactive/);
// Without the page's hook (no Interface), show fails and says to link.
await assert.rejects(bash.execute({ command: 'show n.md' }, {}), /no Interface here/);
ok('agents: `show` opens or offers through the page (path, mode, label, caller), folders as Files; --interactive, missing, binary and wrong flags are refused before the page');

// Clipped bash output keeps `shown:` lines whole: one crossing the cap, and
// many past it, within a fixed budget, never past the cap.
{
  const SH = (i) => `shown: opened /work/f${i}.md (Preview)`;
  const cross = 'x'.repeat(49_990) + '\n' + SH(0) + '\n' + 'y'.repeat(100);
  const c = clip(cross);
  assert.match(c, /^shown: opened \/work\/f0\.md \(Preview\)$/m);
  assert.equal(c.match(/shown: /g).length, 1, 'not duplicated');
  const many = 'z'.repeat(60_000) + '\n' + Array.from({ length: 2000 }, (_, i) => SH(i)).join('\n');
  const m = clip(many);
  assert.ok(m.length < 50_100, `stays near the cap: ${m.length}`);
  assert.match(m, /^shown: opened \/work\/f0\.md/m);
  assert.match(m, /\[truncated: \d+ more characters\]$/);
  for (const l of m.split('\n').filter((l) => l.includes('shown:'))) assert.match(l, /^shown: opened \/work\/f\d+\.md \(Preview\)$/);
}
ok('clip keeps shown: lines whole across the cap, inside a fixed budget');

// Transcript cards parse only the two whole `shown:` shapes; a mode label inside a file name stays in the path.
assert.deepEqual(shownLines('x\nshown: opened /work/report (Preview).html (Preview, Static)\nshown: offered /work/a (Raw).js (Raw); not opened (user busy: typing just now), the transcript has an Open button for them\n'), [
  { how: 'opened', path: '/work/report (Preview).html', label: 'Preview, Static' },
  { how: 'offered', path: '/work/a (Raw).js', label: 'Raw', reason: 'typing just now' },
]);
assert.deepEqual(shownLines('shown: offered /work/a.md (Preview)\nshown: opened /work/a.md (Preview); not opened (user busy: x), the transcript has an Open button for them\nshown: opened /work/a.md (Preview) and more'), []);
ok('shownLines: whole shapes only, labels inside file names kept');

console.log(`\n${passed}/11 passed`);
