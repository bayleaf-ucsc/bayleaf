/** Shared creation policy and simplified browser controls, without live providers. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
// Minimal DOM for this dashboard's own SSR, not a browser/layout engine.
// Native EventTarget preserves listener names; missing HTML controls stay missing.
function sandboxDocument(html) {
  const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity =>
    ({'&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&#39;':"'"}[entity]));
  class Element extends EventTarget {
    constructor(tag, attributes = {}) {
      super(); this.tagName = tag.toUpperCase(); this.attributes = attributes;
      this.children = []; this.dataset = {}; this.text = '';
      for (const [name, value] of Object.entries(attributes)) {
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.text = String(value); this.children = []; }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get open() { return this.hasAttribute('open'); }
    get href() { return this.getAttribute('href') || ''; }
    set href(value) { this.setAttribute('href', value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    contains(element) { return this.children.some(child => child === element || child.contains(element)); }
    querySelectorAll(selector) {
      assert.match(selector, /^(?:#[\w-]+|\.[\w-]+|\[[\w-]+\]|[a-z]+)$/i, 'fixture selector support');
      const matches = element => selector[0] === '#' ? element.getAttribute('id') === selector.slice(1)
        : selector[0] === '.' ? (element.getAttribute('class') || '').split(/\s+/).includes(selector.slice(1))
        : selector[0] === '[' ? element.hasAttribute(selector.slice(1, -1))
        : element.tagName === selector.toUpperCase();
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  const document = new Element('document'), stack = [document];
  // Deliberately limited to our balanced SSR fixture. No sanitization or general
  // HTML conformance claim; script/style bodies are not parsed as HTML.
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  for (const token of markup.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      assert.equal(stack.pop().tagName, token.slice(2, -1).trim().toUpperCase(), 'balanced SSR fixture');
    } else if (token.startsWith('<')) {
      const [, tag, source] = token.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/);
      const attributes = {};
      for (const [, rawName, double, single, bare] of source.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
        const name = rawName.toLowerCase();
        // Browsers retain the first duplicate. Reject ambiguous fixture markup
        // rather than silently wiring a different control from the real page.
        assert.ok(!Object.hasOwn(attributes, name), 'duplicate fixture attribute: '+name);
        attributes[name] = decode(double ?? single ?? bare ?? '');
      }
      const element = new Element(tag, attributes);
      stack.at(-1).children.push(element);
      if (!['meta','link','input','br','hr','img'].includes(tag)) stack.push(element);
    } else stack.at(-1).text += decode(token);
  }
  assert.equal(stack.length, 1);
  document.createElement = tag => new Element(tag);
  return document;
}
for (const markup of ['<button id="wrong" id="start"></button>', '<button ID="wrong" id="start"></button>']) {
  assert.throws(() => sandboxDocument(markup), /duplicate fixture attribute: id/);
}
const bundle = await build({ stdin: { contents: `
  export { createPersistentSandbox, persistentSandboxParams } from './src/daytona';
  export { renderSandboxPage } from '../sandbox/page';
  export { SERVICE_DEFS, managedSlot } from './src/serviceDefs';
   export { Hono } from 'hono';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx' });
const { createPersistentSandbox, persistentSandboxParams, renderSandboxPage, Hono, SERVICE_DEFS, managedSlot } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const env = { DAYTONA_API_URL: 'https://daytona.example.test/api',
  DAYTONA_API_KEY: 'synthetic', DAYTONA_DEPLOYMENT_LABEL: 'synthetic-chat', DAYTONA_AUTO_DELETE_MINUTES: '-1' };
for (const key of ['port','root','slot']) assert.equal(new Set(Object.values(SERVICE_DEFS).map(def=>def[key])).size,Object.keys(SERVICE_DEFS).length);
assert.equal(SERVICE_DEFS.ttyd.port,8794);
assert.equal(SERVICE_DEFS.ttyd.credential,true);
assert.ok(managedSlot('__ttyd'));
const expected = { language: 'python', snapshot: 'daytona-medium', public: false,
  name: 'synthetic-chat/owner@example.test', labels: { 'synthetic-chat': 'owner@example.test' },
  autoStopInterval: 60, autoArchiveInterval: 1440, autoDeleteInterval: -1 };
assert.deepEqual(persistentSandboxParams('owner@example.test', env), expected);
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, env.DAYTONA_API_URL + '/sandbox'); assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), expected);
    return Response.json({ id: 'synthetic', state: 'started' });
  };
  assert.equal((await createPersistentSandbox('owner@example.test', env)).id, 'synthetic');
} finally { globalThis.fetch = originalFetch; }
const app = new Hono();
app.get('/', () => renderSandboxPage({email:'owner@example.test',name:'Synthetic owner'}));
app.get('/public', () => renderSandboxPage(null));
let phase = 'idle', startedAt;
const observed=[['locating_sandbox',0],['creating_sandbox',0],['starting_sandbox',0],
  ['preparing_setup',1],['checking',3],['checking',4],['installing_openchamber',4],
  ['configuring',17],['installing_opencode',17],['starting_openchamber',20],
  ['waiting_for_opencode',20],['connecting_bayleaf',22],['loading_tools',23],
  ['checking_readiness',24],['ready',24],['registering_preview',24],['ready',26]];
app.get('/services/openchamber/status', c => {
  const elapsed=Date.now()/1000-startedAt;
  if(phase==='opening'&&elapsed>=26)phase='ready';
  const timeline=startedAt?observed.filter(([,at])=>at<=elapsed).map(([step,at])=>({step,at:startedAt+at})):[];
  return c.json({phase,machine:'started',operation:String(startedAt),started_at:startedAt,
    timeline,progress:timeline.at(-1)?.step,
    ...(phase==='ready'?{url:'https://synthetic-private.example.test/',deadline:startedAt+86400}:{})});
});
for(const action of ['start','restart'])app.post('/services/openchamber/'+action,c=>{
  phase='opening';startedAt=Math.floor(Date.now()/1000);return c.json({phase});
});
for(const service of ['code-server','dufs','nanobot','jupyter','ttyd']) {
  app.get('/services/'+service+'/status',c=>c.json({phase:'idle',machine:'started'}));
  for(const action of ['start','restart'])app.post('/services/'+service+'/'+action,c=>c.json({error:'service_busy'},409));
}
const page = await app.request('http://localhost/');
const html = await page.text();
assert.ok(!html.includes('browser-continue') && !html.includes('browser-stop'));
assert.ok(!html.includes('Extend 6 hours') && !html.includes('End browser work'));
assert.ok(!html.includes('links last up to 24 hours'));
assert.ok(!html.includes('Signing in starts waking'));
assert.ok(html.includes('90 days are deleted'));
assert.ok(html.includes('same sandbox files'));
assert.ok(!/<details[^>]*\sopen(?:\s|>)/.test(html),'diagnostics start collapsed');
// This is our own SSR output, not untrusted HTML or an HTML sanitization step.
// The page emits one nonce-bearing script. Match its nonce to the actual CSP.
const scripts=[...html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length,1);
const [,nonce,script]=scripts[0];
assert.ok(page.headers.get('Content-Security-Policy').includes("script-src 'nonce-"+nonce+"'"));
assert.ok(html.includes('data-endpoint="/services/openchamber"'));
assert.ok(html.includes('data-endpoint="/services/nanobot"'));
assert.ok(html.includes('data-endpoint="/services/jupyter"'));
assert.ok(html.includes('data-endpoint="/services/ttyd"'));
assert.ok(html.includes('Shell (ttyd)'));
new Function(script);
assert.ok(html.includes('A small computer in the cloud for trying things out'));
assert.doesNotMatch(html,/browser-(?:meter|estimate|milestone|track|fill|pip)|progressbar|aria-valuenow|requestAnimationFrame|cancelAnimationFrame|"plan":|"milestones":|remaining|Allow a few minutes/);
// Inspect declarations, not whitespace, animation names, durations or grid layout.
// This checks the reduced-motion stylesheet contract, not computed browser styles.
const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
const declaration = (source, selector, property) => {
  const rule = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => selectors.trim() === selector);
  assert.ok(rule, 'CSS rule: '+selector);
  return rule[2].split(';').map(part => part.split(':').map(value => value.trim()))
    .find(([name]) => name === property)?.[1];
};
const activity = '.service[data-phase=opening] .service-activity';
assert.equal(declaration(css, '.service-activity', 'display'), 'none');
assert.ok(['inline','inline-block','block','flex','inline-flex'].includes(declaration(css, activity, 'display')),
  'opening activity is displayed');
assert.match(declaration(css, activity, 'animation'), /\binfinite\b/);
const reduced = css.match(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([\s\S]*?\}\s*)\}/);
assert.ok(reduced, 'reduced-motion override exists');
assert.equal(declaration(reduced[1], activity, 'animation'), 'none');

async function checkDashboard(emittedScript) {
  const document = sandboxDocument(html), window = new EventTarget();
  assert.equal(document.querySelectorAll('[aria-valuenow]').length, 0, 'no predicted numeric progress');
  assert.ok(document.querySelectorAll('[role]').every(element => element.getAttribute('role') !== 'progressbar'));
  const roots = document.querySelectorAll('[data-service]');
  assert.equal(roots.length, 6);
  const states = new Map(roots.map(root => [root.dataset.service, {phase:'idle',machine:'absent'}]));
  const calls = [], timeouts = new Map(), intervals = [];
  let nextTimer = 0, expired;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const fetch = async (url, options = {}) => {
    calls.push({url, ...options, method:options.method || 'GET'});
    const [, service, operation] = url.match(/^\/services\/([^/]+)\/(status|start|restart)$/) || [];
    assert.ok(states.has(service), 'known service endpoint: '+url);
    if (service === expired) return new Response('', {status:401});
    if (operation !== 'status') states.set(service, {phase:'opening',progress:'registering_preview'});
    return Response.json(states.get(service));
  };
  const focus = async () => { window.dispatchEvent(new Event('focus')); await settle(); };
  const poll = async () => {
    const due = [...timeouts.values()]; timeouts.clear();
    due.forEach(callback => callback()); await settle();
  };
  // Execute exactly the emitted script: no closure captures or source replacement.
  new Function('document','window','setInterval','setTimeout','clearTimeout','fetch',emittedScript)(
    document, window, callback => { intervals.push(callback); return intervals.length; },
    callback => { const id = ++nextTimer; timeouts.set(id, callback); return id; },
    id => timeouts.delete(id), fetch);
  await settle();
  assert.deepEqual(calls.map(call => call.url).sort(), roots.map(root => root.dataset.endpoint+'/status').sort());
  const assertPassive = requests => requests.forEach(call => {
    assert.equal(call.method, 'GET', 'status/focus/polling stays passive');
    assert.ok(call.url.endsWith('/status'));
    assert.equal(call.cache, 'no-store');
    assert.equal(call.credentials, 'same-origin');
    assert.equal(call.redirect, 'error');
  });
  assertPassive(calls);
  for (const root of roots) {
    const service = root.dataset.service, el = id => root.querySelector('#'+service+'-'+id);
    assert.equal(root.dataset.phase, 'idle');
    assert.equal(el('start').hidden, false);
    assert.equal(el('status').getAttribute('role'), 'status');
    assert.equal(el('status').getAttribute('aria-live'), 'polite');
    assert.equal(root.querySelector('.service-activity').getAttribute('aria-hidden'), 'true');
    assert.ok(el('start').getAttribute('aria-label'));
    assert.equal(el('troubleshoot').open, false);
    assert.ok(el('troubleshoot').contains(el('previous')), 'previous failure belongs in troubleshooting');
    const siblings = roots.filter(other => other !== root).map(other => other.dataset.phase);
    async function click(action) {
      assert.equal(el(action).hidden, false, 'action is available');
      assert.equal(el(action).disabled, false);
      const before = calls.length;
      el(action).click(); await settle();
      const issued = calls.slice(before), writes = issued.filter(call => call.method !== 'GET');
      assert.deepEqual(writes.map(call => [call.method,call.url]), [
        ['POST',root.dataset.endpoint+'/'+action],
      ], 'click dispatches explicit action for its service');
      assertPassive(issued.filter(call => call.method === 'GET'));
      assert.equal(writes[0].headers['X-BayLeaf-Action'], 'managed-service');
      assert.equal(writes[0].credentials, 'same-origin');
      assert.equal(writes[0].redirect, 'error');
      assert.equal(el(action).disabled, false);
    }
    await click('start');
    assert.equal(root.dataset.phase, 'opening');
    assert.equal(el('status').textContent, 'Creating private browser access…');
    assert.equal(el('start').hidden, true); assert.equal(el('open').hidden, true);
    assert.equal(el('troubleshoot').hidden, false);
    assert.equal(el('repair-label').textContent, 'Setup details');
    assert.deepEqual(roots.filter(other => other !== root).map(other => other.dataset.phase), siblings,
      'each service owns independent state');
    states.set(service, {phase:'failed',error:'installation_failed',timeline:[{step:'failed',at:100}]});
    const beforePoll = calls.length; await poll(); assertPassive(calls.slice(beforePoll));
    assert.equal(root.dataset.phase, 'failed');
    assert.equal(el('start').textContent, 'Try again');
    assert.equal(el('repair-label').textContent, 'Troubleshooting & repair');
    assert.equal(el('progress').open, false, 'failure does not force diagnostics open');
    assert.equal(el('timeline').children.length, 1);
    await click('start');
    states.set(service, {phase:'ready',url:'https://synthetic.example.test/',
      previous_failure:{at:100,elapsed:5,error:'installation_failed'}});
    await poll();
    assert.equal(root.dataset.phase, 'ready');
    assert.equal(el('status').textContent, 'Running');
    assert.equal(el('open').hidden, false); assert.equal(el('restart').hidden, false);
    assert.equal(el('open').href, 'https://synthetic.example.test/');
    assert.equal(el('open').getAttribute('target'), '_blank');
    assert.ok(el('open').getAttribute('rel').split(/\s+/).includes('noopener'));
    assert.ok(el('open').getAttribute('rel').split(/\s+/).includes('noreferrer'));
    await click('restart');
    async function focusService() {
      const before = calls.length; await focus();
      const issued = calls.slice(before);
      assertPassive(issued);
      assert.ok(issued.some(call => call.url === root.dataset.endpoint+'/status'),
        'focus requests target-service status');
    }
    for (const unsafe of ['javascript:alert(1)','http://example.test','https://user:secret@example.test']) {
      // Establish a visible safe link before each invalid response, rather than
      // accepting a stale hidden link left by restart or a previous invalid URL.
      states.set(service, {phase:'ready',url:'https://synthetic.example.test/'});
      await focusService();
      assert.equal(root.dataset.phase, 'ready');
      assert.equal(el('open').hidden, false);
      assert.equal(el('open').href, 'https://synthetic.example.test/');
      states.set(service, {phase:'ready',url:unsafe});
      await focusService();
      assert.equal(el('open').hidden, true); assert.equal(el('open').getAttribute('href'), null);
    }
  }
  // Keep a sibling opening to ensure expiry neither stops nor signs out other services.
  states.set(roots[1].dataset.service, {phase:'opening'});
  states.set(roots[0].dataset.service, {phase:'idle'}); await focus();
  expired = roots[0].dataset.service;
  roots[0].querySelector('#'+expired+'-start').click(); await settle();
  assert.equal(roots[0].dataset.phase, 'signed-out');
  for (const action of ['start','restart']) {
    const button = roots[0].querySelector('#'+expired+'-'+action);
    assert.equal(button.hidden, true); assert.equal(button.disabled, true);
  }
  assert.equal(roots[0].querySelector('#'+expired+'-login').hidden, false);
  assert.match(roots[0].querySelector('#'+expired+'-status').textContent, /session has expired.*Sign in again/);
  assert.equal(roots[0].querySelector('#'+expired+'-open').getAttribute('href'), null);
  const afterExpiry = calls.length;
  await focus(); await poll(); intervals.forEach(callback => callback()); await settle();
  assert.ok(calls.slice(afterExpiry).every(call => !call.url.startsWith('/services/'+expired+'/')),
    'expired service stops all refreshes');
  assert.equal(roots[1].dataset.phase, 'opening', 'session handling stays scoped');
  expired = roots[1].dataset.service; await poll();
  assert.equal(roots[1].dataset.phase, 'signed-out', 'passive status also handles expiry');
}
await checkDashboard(script);
// Source-specific calibration is opt-in: normal tests depend only on behavior,
// not today's event-registration spelling or private helper names.
if (process.argv.includes('--test-browser-fixture-mutations')) {
  const hoverMutation = script.replaceAll("addEventListener('click'", "addEventListener('mouseenter'");
  assert.notEqual(hoverMutation, script, 'click mutation was applied');
  await assert.rejects(() => checkDashboard(hoverMutation), /click dispatches explicit action/);
  const noFocusMutation = script.replaceAll("addEventListener('focus'", "addEventListener('blur'");
  assert.notEqual(noFocusMutation, script, 'focus mutation was applied');
  await assert.rejects(() => checkDashboard(noFocusMutation), /focus requests target-service status/);
  const renamed = script.replace(/\bsignedOut(?=\s*\()/g, 'private_signedOut');
  assert.notEqual(renamed, script, 'private helper rename was applied');
  await checkDashboard(renamed);
  console.log('PASS click-to-mouseenter and missing-focus mutations rejected; private helper rename accepted');
}
console.log('PASS unmodified script: passive startup, clicks/retry/restart, polling, independent states, safe links and expiry');
console.log('Sandbox creation policy and browser rendering checks passed');
if (process.argv.includes('--serve')) {
  const port=Number(process.env.SANDBOX_PREVIEW_PORT||8790);
  createServer(async (req,res) => {
    const response = await app.request('http://127.0.0.1:'+port+req.url, {method:req.method});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }).listen(port,'127.0.0.1',()=>console.log('Synthetic Sandboxes dashboard: http://127.0.0.1:'+port));
}
