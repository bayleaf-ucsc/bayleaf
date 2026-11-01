// File names with Unicode spaces and normalization, through the same write a
// drag-and-drop or upload makes (the namespace keeps the name it is given),
// then bash builtins, a glob, a custom command (tar) and the read tool.
// macOS writes U+202F NARROW NO-BREAK SPACE before "PM" in screenshot names.
// Run: node test/names-node.mjs
import assert from 'node:assert/strict';
import { InMemoryFs } from 'just-bash';
import { Type } from 'typebox';
import { Namespace } from '../src/ns/namespace.js';
import { createTools } from '../src/tools.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok', name); }
const failure = async (p) => { try { await p; } catch (e) { return e.message; } assert.fail('expected an error'); };

const SHOT = 'Screenshot 2026-10-01 at 3.04.12 PM.png';
const MOVIE = 'Movie on 10-1-26 at 2.11 PM.mov';
const NBSP = 'two words.txt';
const NFD = 'café.txt', NFC = 'café.txt';
assert.notEqual(NFD, NFC);
const RESUME_NFD = 'résumé'.normalize('NFD');

const ns = new Namespace();
ns.mount(new InMemoryFs(), '/', { label: 'memory' });
for (const d of ['/work', '/tmp']) await ns.mkdir(d, { recursive: true });
for (const [n, t] of [[SHOT, 'png'], [MOVIE, 'mov'], [NBSP, 'nbsp'], [NFD, 'cafe']]) await ns.writeFile('/work/' + n, t);
const [read, write, , bash] = createTools({ fs: ns, changed() {} }, Type, { defenseInDepth: false });
const sh = (command) => bash.execute({ command }, {});

await test('ls shows the names as stored', async () => {
  const out = await sh('ls');
  for (const n of [SHOT, MOVIE, NBSP, NFD]) assert.ok(out.includes(n), n);
});
await test('quoted exact U+202F name works for cp and cat (just-bash keeps it one word)', async () => {
  assert.equal(await sh(`cp "${SHOT}" x.png && cat x.png`), 'png');
  assert.equal(await sh(`cat '${MOVIE}'`), 'mov');
});
await test('a glob matches the real name', async () => {
  assert.equal(await sh('cat Screenshot*PM.png'), 'png');
});
await test('plain space for U+202F: No such file, with a hint that spells the real name', async () => {
  const msg = await failure(sh('cp "Screenshot 2026-10-01 at 3.04.12 PM.png" y.png'));
  assert.match(msg, /No such file or directory/);
  assert.match(msg, /U\+202F/);
  const typed = msg.match(/type it as (\$'[^']*')/)[1];
  assert.equal(typed, "$'/work/Screenshot 2026-10-01 at 3.04.12\\u202fPM.png'");
  assert.equal(await sh(`cp ${typed} y.png && cat y.png`), 'png');
});
await test('plain space for U+00A0: hinted too', async () => {
  const msg = await failure(sh('cat "two words.txt"'));
  assert.match(msg, /U\+00A0/);
});
await test('NFC typed, NFD stored: cat, cp, ls and test -f find it', async () => {
  assert.equal(await sh(`cat ${NFC}`), 'cafe');
  assert.equal(await sh(`cp "${NFC}" c2.txt && cat c2.txt`), 'cafe');
  assert.equal(await sh(`test -f ${NFC} && echo yes`), 'yes');
  assert.equal(await sh(`ls ${NFC}`), NFC);
});
await test('a write to the NFC name lands in the NFD file, not a lookalike', async () => {
  await sh(`echo more >> ${NFC}`);
  assert.equal(await ns.readFile('/work/' + NFD), 'cafemore\n');
  assert.equal((await ns.readdir('/work')).filter((n) => n.normalize('NFC') === NFC).length, 1);
});
await test('NFD stored folder, NFC path through it', async () => {
  await ns.mkdir('/work/résumé', { recursive: true });
  await ns.writeFile('/work/résumé/a.txt', 'A');
  assert.equal(await sh('cat résumé/a.txt'), 'A');
});
await test('a custom command (tar) reads both kinds of name', async () => {
  const out = await sh(`tar -cf /tmp/t.tar "${SHOT}" ${NFC} && tar -tf /tmp/t.tar`);
  assert.ok(out.includes(SHOT), out);
  assert.ok(out.split('\n').some((n) => n.normalize('NFC') === NFC), out);
});
await test('read tool: NFC finds NFD; a plain-space name gets the hint', async () => {
  assert.match(await read.execute({ path: NFC }), /cafemore/);
  assert.match(await failure(read.execute({ path: 'Movie on 10-1-26 at 2.11 PM.mov' })), /U\+202F.*\$'\/work\/Movie on 10-1-26 at 2\.11\\u202fPM\.mov'/);
});
const onlyCafe = async (dir) => (await ns.readdir(dir)).filter((n) => n.normalize('NFC') === 'café.txt');
await test('mv to the other normalization renames, and does not delete', async () => {
  await ns.mkdir('/work/mv', { recursive: true });
  await ns.writeFile('/work/mv/' + NFD, 'keep');
  await ns.mv('/work/mv/' + NFD, '/work/mv/' + NFC);
  assert.deepEqual(await onlyCafe('/work/mv'), [NFC]);
  assert.equal(await ns.readFile('/work/mv/' + NFC), 'keep');
  await ns.mv('/work/mv/' + NFC, '/work/mv/' + NFC); // onto itself
  await ns.mv('/work/mv/' + NFD, '/work/mv/' + NFD); // onto itself, through the fallback
  assert.equal(await ns.readFile('/work/mv/' + NFC), 'keep');
  // just-bash's mv sees one file under both names and leaves it alone.
  assert.equal(await sh(`cd mv && mv ${NFC} $'cafe\\u0301.txt'; cat ${NFD}`), 'keep');
  assert.equal(await ns.readFile('/work/mv/' + NFD), 'keep');
});
await test('concurrent edits through both spellings keep both changes', async () => {
  await ns.mkdir('/work/ed', { recursive: true });
  await ns.writeFile('/work/ed/' + NFD, 'one\ntwo\n');
  // Reads and writes that take a moment, as on OPFS, so unqueued edits interleave.
  const slow = new Proxy(ns, { get: (t, k) => (k === 'readFile' || k === 'writeFile'
    ? async (...a) => { await new Promise((r) => setTimeout(r, 20)); return t[k](...a); }
    : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const [, , slowEdit] = createTools({ fs: slow, changed() {} }, Type, { defenseInDepth: false });
  await Promise.all([
    slowEdit.execute({ path: 'ed/' + NFC, oldText: 'one', newText: 'ONE' }),
    slowEdit.execute({ path: 'ed/' + NFD, oldText: 'two', newText: 'TWO' }),
  ]);
  assert.equal(await ns.readFile('/work/ed/' + NFD), 'ONE\nTWO\n');
  assert.equal((await onlyCafe('/work/ed')).length, 1);
});
await test('rm -f through the other spelling removes the file', async () => {
  await ns.writeFile('/work/rmf-' + NFD, 'x');
  await sh(`rm -f rmf-${NFC}`);
  assert.equal(await ns.exists('/work/rmf-' + NFD), false);
});
await test('a new file under an NFD folder, named in NFC, lands in that folder', async () => {
  await write.execute({ path: 'résumé/new.txt', content: 'N' });
  assert.equal(await ns.readFile(`/work/${RESUME_NFD}/new.txt`), 'N\n');
  assert.equal((await ns.readdir('/work')).filter((n) => n.normalize('NFC') === 'résumé').length, 1);
});
await test('ASCII misses stay plain errors', async () => {
  const msg = await failure(sh('cat nope.txt'));
  assert.doesNotMatch(msg, /hint/);
});

console.log(`${passed} passed`);
