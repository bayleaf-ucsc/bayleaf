// Batch B, node side: color math stays in CSS (no JS-computed colors), the
// change-review store is deleted on upgrade, change review is gone from the
// source, and bundled defaults (the panel skill) reseed: an unedited copy
// updates in place, an edited one is offered.
// Run: node test/batchB-node.mjs   (uses fake-indexeddb from /tmp/pouch-scratch/fidb)
import '/tmp/pouch-scratch/fidb/node_modules/fake-indexeddb/auto/index.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };

// ── 1. No JS-computed colors: JS sets --seed (a number) and nothing else ──
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk(join(root, 'src'));
const COLOR = [
  /\b(?:hsla?|rgba?|oklch|oklab|lab|lch|hwb)\(/,             // color functions in strings
  /\.style\.(?:color|background(?:Color)?|borderColor|borderLeftColor|fill|stroke|outlineColor)\s*=/,
  /setProperty\(\s*['"]--(?!seed['"])[\w-]*(?:color|hue|agent|tint)[\w-]*['"]/i,
  /['"`]#[0-9a-f]{3,8}['"`]/i,
];
const hits = [];
for (const f of files) {
  if (f.includes('/local/')) continue; // model runtime, no UI
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const re of COLOR) if (re.test(line)) hits.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}
// The editor's palette and theme bridge read CSS variables; they compute no color.
const allowed = hits.filter((h) => !/var\(--/.test(h));
assert.deepEqual(allowed, [], 'inline color computation in src:\n' + allowed.join('\n'));
const seeds = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/setProperty\('--seed'/g)].map(() => f.slice(root.length + 1)));
assert.ok(seeds.includes('src/dom.js'), 'dom.js seeded() sets --seed');
ok(`no JS-computed colors in ${files.length} source files; --seed set only in ${[...new Set(seeds)].join(', ')}`);

// ── 2. Change review is gone ──
assert.ok(!existsSync(join(root, 'src/review.js')), 'src/review.js removed');
const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
for (const re of [/createReview|review\.(?:begin|end|undo|describe|hide|unhide|since|unseen)/, /addChange|changesFor|pruneChanges/, /changed-dot|Changed \$\{n\} file/, /the user undid your/, /Also undo changes/, /function recording\(/]) {
  assert.ok(!re.test(src), 'still in src: ' + re);
}
const html = readFileSync(join(root, 'pouch.html'), 'utf8');
assert.ok(!/review-restore|\.changes \.change|revert-files/.test(html), 'review UI in pouch.html');
ok('change review removed: review.js, the recording proxy, change rows, tree dots, undo notes, revert file checkbox');

// ── 3. The `changes` store is deleted on upgrade (v3 -> v4) ──
await new Promise((res, rej) => {
  const r = indexedDB.open('bayleaf-pouch', 3);
  r.onupgradeneeded = () => {
    for (const s of ['sessions', 'settings', 'mounts', 'shared']) r.result.createObjectStore(s);
    r.result.createObjectStore('changes', { keyPath: 'seq', autoIncrement: true }).createIndex('session', 'session');
  };
  r.onsuccess = () => { const t = r.result.transaction('changes', 'readwrite'); t.objectStore('changes').add({ session: '1', path: '/work/a', before: { kind: 'file', data: new Uint8Array(4) } }); t.oncomplete = () => { r.result.close(); res(); }; };
  r.onerror = () => rej(r.error);
});
const store = await import('../src/store.js');
await store.setSetting('probe', 1);
const names = await new Promise((res) => { const r = indexedDB.open('bayleaf-pouch'); r.onsuccess = () => { const n = [...r.result.objectStoreNames]; r.result.close(); res(n); }; });
assert.ok(!names.includes('changes'), 'changes store remains: ' + names);
assert.equal(await store.getSetting('probe'), 1);
ok(`upgrade to v4 deleted the changes store and its before-copies; stores now ${names.join(', ')}`);

// ── 4. Reseed bundled defaults ──
const { Vfs, DEFAULTS } = await import('../src/vfs.js');
const defaults = (await import('../src/defaults.js')).default;
globalThis.navigator ??= {};
Object.assign(DEFAULTS, defaults);
const PANEL = '/skills/panel/SKILL.md';
const vfs = new Vfs();
await vfs.init();
const read = () => vfs.fs.readFile('/pouch' + PANEL);
assert.equal(await read(), DEFAULTS[PANEL]);
// A new build ships a changed panel skill; the user never edited theirs: updated in place.
DEFAULTS[PANEL] = defaults[PANEL] + '\nv2\n';
await vfs.seed();
assert.equal(await read(), DEFAULTS[PANEL], 'unedited copy updated');
assert.deepEqual(vfs.defaultUpdates, []);
// The user edits it; the next build changes it again: offered, not overwritten.
await vfs.fs.writeFile('/pouch' + PANEL, DEFAULTS[PANEL] + 'my note\n');
DEFAULTS[PANEL] = defaults[PANEL] + '\nv3\n';
await vfs.seed();
assert.match(await read(), /my note/, 'edited copy kept');
assert.deepEqual(vfs.defaultUpdates, [PANEL]);
await vfs.resolveDefault(PANEL, false);
await vfs.seed();
assert.deepEqual(vfs.defaultUpdates, [], 'asked once per bundled version');
assert.match(await read(), /my note/);
// Taking the new one replaces it.
DEFAULTS[PANEL] = defaults[PANEL] + '\nv4\n';
await vfs.seed();
assert.deepEqual(vfs.defaultUpdates, [PANEL]);
await vfs.resolveDefault(PANEL, true);
assert.equal(await read(), DEFAULTS[PANEL]);
// A deleted default stays deleted, even when it changes.
await vfs.fs.rm('/pouch' + PANEL);
DEFAULTS[PANEL] = defaults[PANEL] + '\nv5\n';
await vfs.seed();
assert.ok(!(await vfs.fs.exists('/pouch' + PANEL)) && !vfs.defaultUpdates.length, 'deleted stays deleted');
ok('reseed: unedited copy updated in place; edited copy offered once (keep or take); deleted stays deleted');

console.log(`\n${passed} checks passed`);
process.exit(0);
