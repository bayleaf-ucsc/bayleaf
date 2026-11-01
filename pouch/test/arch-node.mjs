// The architecture checks (arch.mjs): the real tree passes, and a deliberate
// violation of each rule fails with a message naming its boundary.
//   node test/arch-node.mjs
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { checkArchitecture, checkMetafile, checkNoCdn, loadTree, NETWORK } from '../arch.mjs';

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
  const msg = fails(withFile('src/interface/tree.js', "fetch('https://example.com/?' + document.title);"), 'egress', 'src/interface/tree.js', /uses fetch/);
  assert.match(msg, /Plaintext must leave Pouch only through modules/);
  fails(withFile('src/vfs.js', 'navigator.sendBeacon("/x", "y");'), 'egress', 'src/vfs.js', /sendBeacon/);
  fails(withFile('src/editor.js', 'const ws = new WebSocket("wss://example.com");'), 'egress', 'src/editor.js', /WebSocket/);
  fails(withFile('src/markdown.js', 'const m = await import(location.hash.slice(1));'), 'egress', 'src/markdown.js', /import\(\)/);
  fails(withFile('src/tools.js', "const w = new Worker('https://example.com/w.js');"), 'egress', 'src/tools.js', /Worker/);
  fails(withFile('src/agent.js', "globalThis['fetch']('https://example.com');"), 'egress', 'src/agent.js', /fetch/);
  // An allowed module may use only the APIs it is allowed.
  fails(withFile('src/models.js', 'new EventSource("/x");'), 'egress', 'src/models.js', /EventSource/);
  // A local named fetch is not the network; overwriting the global removes it.
  assert.deepEqual(checkArchitecture(withFile('src/graph.js', 'export const viaFetch = (fetch) => fetch("/x"); self.fetch = () => { throw new Error("no network"); };')), []);
  // Comments and strings are not code.
  assert.deepEqual(checkArchitecture(withFile('src/graph.js', '// fetch(url)\nexport const note = "new WebSocket(url)";')), []);
});

await test('egress: an allowance nobody uses fails, so the list stays exact', () => {
  assert.ok(NETWORK['src/offline.js']);
  fails(withFile('src/offline.js', (t) => t.replaceAll('fetch(', 'Promise.reject(')), 'egress', 'src/offline.js', /no longer uses it/);
});

await test('html: an HTML sink outside viewer.html fails', () => {
  const msg = fails(withFile('src/preview.js', 'export const put = (node, s) => { node.innerHTML = s; };'), 'html', 'src/preview.js', /innerHTML/);
  assert.match(msg, /only viewer.html/);
  fails(withFile('src/interface/transcript.js', "const card = el('div', { innerHTML: '<b>x</b>' });"), 'html', 'src/interface/transcript.js', /innerHTML/);
  fails(withFile('src/viewer.js', "const f = document.createElement('iframe'); f.srcdoc = '<p>';"), 'html', 'src/viewer.js', /srcdoc/);
  fails(withFile('src/dom.js', "document.write('<p>');"), 'html', 'src/dom.js', /document.write/);
  fails(withFile('src/markdown.js', "new DOMParser().parseFromString('<p>', 'text/html');"), 'html', 'src/markdown.js', /parseFromString/);
  fails(withFile('pouch.html', (t) => t.replace('</body>', "<script>document.body.insertAdjacentHTML('beforeend', location.hash);</script></body>")), 'html', 'pouch.html', /insertAdjacentHTML/);
});

await test('sealed: only src/sealed.js imports tinfoil or reaches into its client', () => {
  const msg = fails(withFile('src/agent.js', "import { TinfoilAI } from 'tinfoil';"), 'sealed', 'src/agent.js', /imports tinfoil/);
  assert.match(msg, /attestation and origin checks/);
  fails(withFile('src/interface/connection.js', 'const leak = (c) => c.secureClient.fetch;'), 'sealed', 'src/interface/connection.js', /secureClient/);
  fails(withFile('src/naming.js', 'const k = (c) => c.openAIOptions.apiKey;'), 'sealed', 'src/naming.js', /openAIOptions/);
  // The metafile: what really imports the SDK into the bundle.
  const meta = (from) => ({ inputs: { [from]: { imports: [{ path: 'node_modules/tinfoil/dist/index.browser.js' }] }, 'node_modules/tinfoil/dist/index.browser.js': { imports: [{ path: 'node_modules/tinfoil/dist/secure.js' }] } } });
  assert.deepEqual(checkMetafile(meta('src/sealed.js')), []);
  assert.match(checkMetafile(meta('src/interface/connection.js'))[0], /^\[sealed\] src\/interface\/connection.js/);
});

await test('cdn: a third-party CDN in the page fails; a URL only compared against does not', () => {
  assert.match(checkNoCdn('<script>import("https://cdn.jsdelivr.net/npm/x")</script>', 'pouch.html')[0], /^\[cdn\].*third-party/);
  assert.deepEqual(checkNoCdn('const issuer="https://token.actions.githubusercontent.com"', 'pouch.html'), []);
});

await test('layers: the core imports no UI, and only main.js imports the Interface', () => {
  const msg = fails(withFile('src/vfs.js', "import { $ } from './dom.js';"), 'layers', 'src/vfs.js', /is core but imports src\/dom.js/);
  assert.match(msg, /UI depends on the core, never the reverse/);
  fails(withFile('src/ns/watch.js', "import { createUsage } from '../usage.js';"), 'layers', 'src/ns/watch.js', /imports src\/usage.js/);
  fails(withFile('src/tools.js', "import { createTreeRegion } from './interface/tree.js';"), 'layers', 'src/tools.js', /imports the Interface/);
});

await test('seams: a region is imported only through its entry modules', () => {
  const msg = fails(withFile('src/tools.js', "import { RunHost } from './run/host.js';"), 'seams', 'src/tools.js', /inside src\/run\//);
  assert.match(msg, /Import src\/run.js instead/);
  fails(withFile('src/agent.js', "import './local/worker.js';"), 'seams', 'src/agent.js', /inside src\/local\//);
  // Interface regions reach each other through app, never by import.
  fails(withFile('src/interface/tree.js', "import { createEditingRegion } from './editing.js';"), 'seams', 'src/interface/tree.js', /inside src\/interface\//);
});

await test('size: a module over its budget fails; main.js stays thin', () => {
  fails(withFile('src/graph.js', (t) => t + '\n'.repeat(800)), 'size', 'src/graph.js', /over its budget of 700/);
  fails(withFile('src/main.js', (t) => t + '// x\n'.repeat(60)), 'size', 'src/main.js', /over its budget of 60/);
});

await test('the pre-split main.js (2974dda) fails egress, sealed and size', () => {
  let old;
  try { old = execSync('git show 2974dda:pouch/src/main.js', { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch { console.log('  (skipped: commit 2974dda not in this clone)'); return; }
  const errors = checkArchitecture(withFile('src/main.js', () => old));
  for (const rule of ['egress', 'sealed', 'size']) assert.ok(errors.some((e) => e.startsWith(`[${rule}] src/main.js`)), rule);
});

console.log(`${passed} passed`);
