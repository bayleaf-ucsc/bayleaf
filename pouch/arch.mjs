// Pouch's architecture, checked at build time (README "Architecture").
//
//   node arch.mjs          check the tree; build.mjs runs the same checks
//
// Pouch is meant for highly sensitive data, so its trust claims are rules the
// build enforces, not conventions a reviewer has to remember. Each rule names
// the boundary it keeps and why; each allowance names the module and the one
// reason it may cross. An allowance no module uses any more is itself an error,
// so the lists below stay an exact inventory of where Pouch can reach out.
//
// Trust rules (they fail the build):
//   egress    only the modules in NETWORK may use network APIs
//   html      only viewer.html turns a string into HTML (agent-written reports)
//   sealed    only src/sealed.js touches the encrypting client (the Tinfoil SDK)
//   cdn       no third-party CDN in the page (assertNoCdn, build-runtime.mjs)
// Structure rules:
//   layers    the core never imports UI; nothing imports the Interface but main.js
//   seams     a region is imported only through its entry modules
//   size      every module stays within its line budget
//
// The parser is TypeScript's (no type checking): the scan sees code, not
// comments or strings, and tells a local `fetch` parameter from the global.
// It covers first-party code (src/, sw.js, the pages' inline scripts); bundled
// packages are checked by what imports them (checkMetafile) and by the CSP.
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { assertNoCdn } from './build-runtime.mjs';

// ── Egress: who may use the network ─────────────────────────────────
// Network APIs, as globals or properties (navigator.sendBeacon, x.fetch).
// `import()` counts unless its argument is a relative path the build bundles.
const NETWORK_APIS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'RTCPeerConnection',
  'sendBeacon', 'importScripts', 'Worker', 'SharedWorker', 'import()'];
export const NETWORK = {
  'src/bayleaf-api.js': { apis: ['fetch'], why: 'the account plane: device claim, a key\'s allowance, Campus Pass, the Sealed model list (metadata only, never content)' },
  'src/sealed.js': { apis: ['fetch'], why: 'the encrypting fetch: EHBP ciphertext to the attested enclave' },
  'src/bayleaf-cli.js': { apis: ['fetch'], why: 'the agent\'s `bayleaf` command to api.bayleaf.dev, each request approved through egress.js' },
  'src/localhost.js': { apis: ['fetch'], why: 'the Localhost provider: a model server on this computer, behind guardedFetch\'s origin check' },
  'src/models.js': { apis: ['fetch'], why: 'model weights from the BayLeaf HF gateway, hash-checked against models.lock.json' },
  'src/assets.js': { apis: ['fetch'], why: 'pinned runtimes and weights by range, hash-checked against the build\'s pins' },
  'src/offline.js': { apis: ['fetch'], why: 'the offline copy: SHA256SUMS and the app shell from this origin' },
  'sw.js': { apis: ['fetch'], why: 'the service worker: serves the offline copy, else passes the request to this origin' },
  'src/run.js': { apis: ['Worker'], why: 'starts the bundled QuickJS worker from a blob: URL; the worker drops its network APIs' },
  'src/pdf.js': { apis: ['Worker'], why: 'starts the hash-checked pdf.js worker from a blob: URL; the worker drops its network APIs' },
  'src/media.js': { apis: ['Worker'], why: 'starts the hash-checked libav.js worker from a blob: URL; the worker drops its network APIs' },
  'src/local/engine.js': { apis: ['Worker'], why: 'starts the hash-checked Transformers.js worker from a blob: URL' },
};
const WHY_EGRESS = 'Plaintext must leave Pouch only through modules whose every request is known: '
  + 'add the module to NETWORK in arch.mjs with its reason, or route the request through one that is there';

// ── HTML: who may render a string as HTML ───────────────────────────
// Agent-written HTML runs only in viewer.html: a separate page with its own
// network-less CSP, framed with an opaque origin (README "HTML reports").
// Everything else builds DOM nodes (dom.js el()), never parses markup.
const HTML_SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'parseFromString',
  'createContextualFragment', 'setHTMLUnsafe', 'parseHTMLUnsafe', 'document.write', 'document.writeln'];
export const HTML = {
  'viewer.html': { why: 'the report viewer: parses the agent\'s HTML and renders it in its sandboxed srcdoc frame' },
};
const WHY_HTML = 'Agent-written HTML could carry script or exfiltrate through the page\'s origin; '
  + 'only viewer.html, under its network-less CSP, may render markup';

// ── Sealed: who may touch the encrypting client ─────────────────────
export const SEALED = {
  'src/sealed.js': { why: 'the Sealed provider: builds the Tinfoil client and its encrypting fetch' },
};
const SEALED_TOUCH = ['secureClient', 'openAIOptions'];
const WHY_SEALED = 'The encrypting client holds the credential and decides what is encrypted to whom; '
  + 'one module wraps it so every request passes its attestation and origin checks';

// ── Layers ──────────────────────────────────────────────────────────
// The core: files, namespaces, storage, providers and sandboxed runtimes. It
// works without a page, so it imports only itself (and packages).
export const CORE = ['src/vfs.js', 'src/store.js', 'src/archive.js', 'src/graph.js', 'src/ns/', 'src/run.js', 'src/run/',
  'src/local/', 'src/localhost.js', 'src/sealed.js', 'src/bayleaf-api.js', 'src/profiles.js', 'src/models.js',
  'src/assets.js', 'src/sha256.js', 'src/pdf/', 'src/media/', 'src/shims/'];
// The Interface (LANGUAGE.md): the page's wiring, composed by main.js from
// src/interface/ regions.
const INTERFACE = ['src/main.js', 'src/interface/'];
const WHY_LAYERS = 'The core must stay testable and portable without a page (and replaceable by the trusted core of #143); '
  + 'UI depends on the core, never the reverse';

// ── Seams: regions and their entry modules ──────────────────────────
// A region's other modules are its implementation: outside code imports
// only the entries. src/interface/ regions reach each other through `app`.
export const REGIONS = {
  'src/interface/': { entries: [], importers: ['src/main.js'], why: 'Interface regions are composed only by main.js and reach each other through app.<region>' },
  'src/run/': { entries: ['src/run.js'], why: 'run.js is the run tool\'s one door: the worker and its 9P bridge are its implementation' },
  'src/pdf/': { entries: ['src/pdf.js'], why: 'pdf.js owns the pdf.js worker and its pin' },
  'src/media/': { entries: ['src/media.js'], why: 'media.js owns the libav.js worker and its pins' },
  'src/local/': { entries: ['src/local/engine.js', 'src/local/provider.js'], why: 'the engine (weights, worker) and the provider adapter are the Transformers.js doors; the worker is private' },
};

// ── Size budgets (lines) ────────────────────────────────────────────
export const BUDGET = { default: 700, 'src/main.js': 60 };

// ─────────────────────────────────────────────────────────────────────
const inside = (path, prefixes) => prefixes.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
const fmt = (rule, path, line, what, why) => `[${rule}] ${path}${line ? ':' + line : ''}: ${what}. ${why}.`;

// files: Map of path relative to pouch/ -> source text. .html files
// contribute their inline scripts (pouch.html's /*APP*/ placeholder is the bundle).
function sources(files) {
  const out = [];
  for (const [path, text] of files) {
    if (path.endsWith('.html')) {
      let k = 0;
      // Any case and any attributes: a script the scan missed would be a way around it.
      for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
        if (m[1].trim() === '/*APP*/') continue;
        const line = text.slice(0, m.index).split('\n').length - 1;
        out.push({ path, name: `${path}#script${k++}.js`, text: '\n'.repeat(line) + m[1] });
      }
    } else if (path.endsWith('.js') || path.endsWith('.mjs')) out.push({ path, name: path, text });
  }
  return out;
}

function parse(list) {
  const byName = new Map(list.map((s) => [s.name, s]));
  const host = {
    getSourceFile: (n) => (byName.has(n) ? ts.createSourceFile(n, byName.get(n).text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS) : undefined),
    fileExists: (n) => byName.has(n), readFile: (n) => byName.get(n)?.text, writeFile() {},
    getDefaultLibFileName: () => 'lib.d.ts', getCurrentDirectory: () => '/', getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n', resolveModuleNames: (ns) => ns.map(() => undefined),
  };
  // noLib: a global (fetch, Worker) has no symbol; a local one does.
  const program = ts.createProgram([...byName.keys()], { allowJs: true, noLib: true, noResolve: true, types: [] }, host);
  return { program, checker: program.getTypeChecker() };
}

// Every network use, HTML sink, Sealed touch and import in one source.
function scan(sf, checker) {
  const found = [];
  const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const isGlobal = (id) => !checker.getSymbolAtLocation(id);
  const imports = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) imports.push({ spec: n.moduleSpecifier.text, line: at(n) });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteralLike(a)) imports.push({ spec: a.text, line: at(n) });
      if (!(a && ts.isStringLiteralLike(a) && a.text.startsWith('.'))) found.push({ kind: 'network', api: 'import()', line: at(n) });
    } else if (ts.isIdentifier(n)) {
      const p = n.parent, name = n.text;
      const member = p && ts.isPropertyAccessExpression(p) && p.name === n;
      const key = p && (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)) && p.name === n
        && ts.isObjectLiteralExpression(p.parent);
      const declared = p && (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)
        || ts.isImportSpecifier(p) || ts.isPropertyDeclaration(p)) && p.name === n;
      // Overwriting one (self.fetch = refuse) removes it; the new value is scanned on its own.
      const replaced = member && ts.isBinaryExpression(p.parent) && p.parent.left === p && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (NETWORK_APIS.includes(name) && !declared && !key && !replaced && (member || isGlobal(n))) found.push({ kind: 'network', api: name, line: at(n) });
      if (HTML_SINKS.includes(name) && (member || (key && !ts.isShorthandPropertyAssignment(p)))) found.push({ kind: 'html', api: name, line: at(n) });
      if (member && (name === 'write' || name === 'writeln') && p.expression.getText(sf) === 'document') found.push({ kind: 'html', api: 'document.' + name, line: at(n) });
      if (SEALED_TOUCH.includes(name) && (member || key)) found.push({ kind: 'sealed', api: name, line: at(n) });
    } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      const name = n.argumentExpression.text; // x['innerHTML'], self['fetch']
      if (NETWORK_APIS.includes(name)) found.push({ kind: 'network', api: name, line: at(n) });
      if (HTML_SINKS.includes(name)) found.push({ kind: 'html', api: name, line: at(n) });
      if (SEALED_TOUCH.includes(name)) found.push({ kind: 'sealed', api: name, line: at(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { found, imports };
}

const resolve = (from, spec) => {
  if (!spec.startsWith('.')) return spec;
  const parts = from.split('/').slice(0, -1);
  for (const s of spec.split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); }
  return parts.join('/');
};

// The checks over a set of files; returns violation messages (empty: it holds).
export function checkArchitecture(files) {
  const list = sources(files);
  const { program, checker } = parse(list);
  const errors = [];
  const usedNet = new Map(), usedHtml = new Set(), usedSealed = new Set();
  const graph = []; // { from, to, line }
  for (const s of list) {
    const { found, imports } = scan(program.getSourceFile(s.name), checker);
    for (const f of found) {
      if (f.kind === 'network') {
        const allow = NETWORK[s.path];
        if (allow?.apis.includes(f.api)) { if (!usedNet.has(s.path)) usedNet.set(s.path, new Set()); usedNet.get(s.path).add(f.api); }
        else errors.push(fmt('egress', s.path, f.line, `uses ${f.api}, but it is not an egress module for ${f.api}`, WHY_EGRESS));
      } else if (f.kind === 'html') {
        if (HTML[s.path]) usedHtml.add(s.path);
        else errors.push(fmt('html', s.path, f.line, `uses ${f.api}, an HTML sink`, WHY_HTML));
      } else if (f.kind === 'sealed') {
        if (SEALED[s.path]) usedSealed.add(s.path);
        else errors.push(fmt('sealed', s.path, f.line, `reaches into the Tinfoil client (${f.api})`, WHY_SEALED));
      }
    }
    for (const im of imports) {
      if (/^tinfoil(\/|$)/.test(im.spec)) {
        if (SEALED[s.path]) usedSealed.add(s.path);
        else errors.push(fmt('sealed', s.path, im.line, `imports ${im.spec}`, WHY_SEALED));
      }
      if (im.spec.startsWith('.')) graph.push({ from: s.path, to: resolve(s.path, im.spec), line: im.line });
    }
  }
  // Allowances nobody uses any more: the inventory must stay exact.
  for (const [path, { apis }] of Object.entries(NETWORK)) {
    if (!files.has(path)) continue;
    for (const api of apis) if (!usedNet.get(path)?.has(api)) errors.push(fmt('egress', path, 0, `is allowed ${api} in NETWORK but no longer uses it`, 'Remove the allowance so the list stays an exact inventory'));
  }
  for (const [rule, table, used] of [['html', HTML, usedHtml], ['sealed', SEALED, usedSealed]]) {
    for (const path of Object.keys(table)) if (files.has(path) && !used.has(path)) errors.push(fmt(rule, path, 0, `is allowed in ${rule.toUpperCase()} but no longer needs it`, 'Remove the allowance so the list stays an exact inventory'));
  }
  // Layers: the core imports only the core; only main.js imports the Interface.
  for (const { from, to, line } of graph) {
    if (inside(from, CORE) && to.startsWith('src/') && !inside(to, CORE)) errors.push(fmt('layers', from, line, `is core but imports ${to}`, WHY_LAYERS));
    if (inside(to, INTERFACE) && !inside(from, INTERFACE)) errors.push(fmt('layers', from, line, `imports the Interface (${to})`, WHY_LAYERS));
  }
  // Seams: from outside a region, only its entries (and listed importers).
  for (const { from, to, line } of graph) {
    for (const [dir, r] of Object.entries(REGIONS)) {
      const within = from.startsWith(dir) || r.entries.includes(from); // the entries are the region too
      if (!to.startsWith(dir) || (within && dir !== 'src/interface/')) continue;
      if (r.importers?.includes(from) || r.entries.includes(to)) continue;
      errors.push(fmt('seams', from, line, `imports ${to}, inside ${dir}`, `Import ${r.entries.length ? r.entries.join(' or ') : 'nothing from it'} instead: ${r.why}`));
    }
  }
  // Size budgets.
  for (const [path, text] of files) {
    if (!path.startsWith('src/') || !path.endsWith('.js')) continue;
    const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0), max = BUDGET[path] ?? BUDGET.default;
    if (n > max) errors.push(fmt('size', path, 0, `has ${n} lines, over its budget of ${max}`, 'Split it along a seam (README "Architecture"); a module this size is where unrelated changes collide'));
  }
  return errors;
}

// esbuild's metafile: which modules really import the Tinfoil SDK into the
// bundle (catches a re-export the source scan cannot follow).
export function checkMetafile(metafile) {
  const errors = [];
  for (const [path, input] of Object.entries(metafile.inputs)) {
    for (const im of input.imports ?? []) {
      if (/node_modules\/tinfoil\//.test(im.path) && !path.includes('node_modules/tinfoil/') && !SEALED[path.replace(/^.*?\bsrc\//, 'src/')]) {
        errors.push(fmt('sealed', path, 0, `brings ${im.path} into the bundle`, WHY_SEALED));
      }
    }
  }
  return errors;
}

// The no-CDN rule over the assembled page (runtimes are checked as they are
// built). NOT_FETCHED: URLs the bundle compares against but never requests
// (connect-src would refuse them anyway), each with its reason.
export const NOT_FETCHED = {
  'https://token.actions.githubusercontent.com': 'the Sigstore OIDC issuer the Tinfoil SDK expects in an enclave release\'s signing certificate',
};
export function checkNoCdn(html, name) {
  for (const url of Object.keys(NOT_FETCHED)) html = html.replaceAll(`"${url}"`, '""');
  try { assertNoCdn(html, name); return []; } catch (e) { return [`[cdn] ${e.message}. Everything Pouch runs is in its own artifact, hash-listed in SHA256SUMS.`]; }
}

// The real tree: src/**, sw.js and the two pages.
export function loadTree(root = import.meta.dirname) {
  const files = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.set(relative(root, p), readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, 'src'));
  for (const f of ['sw.js', 'viewer.html', 'pouch.html']) files.set(f, readFileSync(join(root, f), 'utf8'));
  return files;
}

export function assertArchitecture(errors) {
  if (errors.length) throw new Error(`Pouch architecture check failed (arch.mjs):\n  ${errors.join('\n  ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = checkArchitecture(loadTree());
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('arch: trust, layer, seam and size rules hold');
}
