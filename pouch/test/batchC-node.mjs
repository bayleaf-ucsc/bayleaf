// Batch C, node side: no native dialogs anywhere in the app (play-test: a
// confirm() on Save in the conflict diff), and the folder-watch matching the
// play-test missed (a watch on a folder that did not exist yet).
// Run: node test/batchC-node.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InMemoryFs } from 'just-bash';
import { createWatches, expand } from '../src/ns/watch.js';

const root = resolve(import.meta.dirname, '..');
let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };

const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk(join(root, 'src'));
const hits = [];
for (const f of files) readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
  if (/^\s*\/\//.test(line)) return;
  if (/(?<![\w.])(?:window\.)?(?:alert|confirm|prompt)\(/.test(line)) hits.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 100)}`);
});
assert.deepEqual(hits, [], 'native dialogs:\n' + hits.join('\n'));
ok(`no alert/confirm/prompt in ${files.length} source files`);

// A plain-path watch set before its folder exists covers files later made under it.
const fs = new InMemoryFs();
await fs.mkdir('/work', { recursive: true });
const seen = [];
const w = createWatches({ fs, settleMs: 5, load: async () => [], save: () => {}, sessions: async () => [], scopeOf: () => null,
  userQueued: () => false, userSending: () => false, busy: async () => false, ready: Promise.resolve(),
  deliver: async (sid, owner, m) => { seen.push(m.content); return {}; } });
await w.add('1', 'main', 'main', { paths: ['/work/data'] });
assert.ok(w.wants('/work/data/jan.csv'), 'a file under the not-yet-folder is wanted');
await fs.mkdir('/work/data');
for (const m of ['jan', 'feb', 'mar']) { await fs.writeFile(`/work/data/${m}.csv`, 'a,b\n'); w.observe({ path: `/work/data/${m}.csv`, source: 'user', before: null, after: new TextEncoder().encode('a,b\n') }); }
assert.deepEqual(await expand(fs, '/work/data'), ['/work/data/feb.csv', '/work/data/jan.csv', '/work/data/mar.csv'], 'expand lists the folder made later');
for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
const text = JSON.stringify(seen);
assert.equal(seen.length, 1, 'one wake: ' + text);
for (const m of ['jan', 'feb', 'mar']) assert.match(text, new RegExp(m + '\\.csv'));
ok('watch on /work/data set before it existed: three later files are wanted, expanded, and delivered as one wake');

console.log(`\n${passed} checks passed`);
