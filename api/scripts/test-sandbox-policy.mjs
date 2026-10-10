/** Shared creation policy and simplified browser controls, without live providers. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
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
assert.ok(html.includes('same sandbox and files'));
assert.ok(!/<details[^>]*\sopen(?:\s|>)/.test(html),'diagnostics start collapsed');
assert.ok(!html.includes('setInterval(countdown'));
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
assert.ok(html.includes('repeat(2,minmax(0,1fr))'));
new Function(script);
assert.ok(html.includes('Your sandbox can run several managed apps, but it falls asleep once you disconnect from it.'));
assert.doesNotMatch(html,/browser-(?:meter|estimate|milestone|track|fill|pip)|progressbar|aria-valuenow|requestAnimationFrame|cancelAnimationFrame|"plan":|"milestones":|remaining|Allow a few minutes/);
assert.equal((html.match(/class="service-activity" aria-hidden="true"/g)||[]).length,6);
assert.match(html,/\.service-activity \{ display:none;/);
assert.match(html,/\.service\[data-phase=opening\] \.service-activity \{ display:inline-block; animation:service-working 1\.2s linear infinite; \}/);
assert.match(html,/@media \(prefers-reduced-motion:reduce\) \{ \.service\[data-phase=opening\] \.service-activity \{ animation:none; \} \}/);
const node=()=>({dataset:{},textContent:'',disabled:false,replaceChildren(...children){this.children=children;},
  setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];},addEventListener(){}});
const roots=['openchamber','nanobot','code-server','jupyter','ttyd','dufs'].map(service=>({
  dataset:{service,endpoint:'/services/'+service},nodes:new Map(),querySelector(selector){
    assert.ok(selector.startsWith('#'+service+'-'));
    assert.ok(html.includes('id="'+selector.slice(1)+'"'),'selector exists: '+selector);
    if(!this.nodes.has(selector))this.nodes.set(selector,node());return this.nodes.get(selector);
  }
}));
const document={createElement:node,querySelectorAll(selector){
  if(selector==='[data-access-action]')return [];
  assert.equal(selector,'[data-service]');return roots;
}};
// Capture inside each service's loop scope, replacing only the initial fetch.
const captures=[];
assert.ok(script.lastIndexOf('refresh();')>=0);
const testScript=script.slice(0,script.lastIndexOf('refresh();'))+
  'captures.push({render,signedOut,action});'+script.slice(script.lastIndexOf('refresh();')+'refresh();'.length);
new Function('document','window','setInterval','setTimeout','clearTimeout',
  'captures','fetch',testScript)(
    document,{addEventListener(){}},()=>{},()=>{},()=>{},captures,async()=>new Response('',{status:401}));
assert.equal(captures.length,6);
for(const [i,controls] of captures.entries()) {
  const root=roots[i],service=root.dataset.service;
  const el=id=>root.querySelector('#'+service+'-'+id);
  assert.ok(html.includes('id="'+service+'-status" role="status" aria-live="polite"'));
  controls.render({phase:'idle',machine:'absent'});
  assert.equal(root.dataset.phase,'idle');assert.equal(el('start').hidden,false);
  // Opening without timestamps must still show the shared activity indicator.
  controls.render({phase:'opening',progress:'registering_preview'});
  assert.equal(root.dataset.phase,'opening');
  assert.equal(el('status').textContent,'Creating private browser access…');
  assert.equal(el('start').hidden,true);assert.equal(el('open').hidden,true);
  controls.render({phase:'failed',error:'installation_failed',timeline:[{step:'failed',at:100}]});
  assert.equal(root.dataset.phase,'failed','failure removes the CSS animation selector');
  assert.equal(el('start').hidden,false);assert.equal(el('start').textContent,'Try again');
  assert.notEqual(el('progress').open,true,'failure must not force diagnostics open');
  controls.render({phase:'ready',url:'https://synthetic.example.test/',previous_failure:{at:100,elapsed:5,error:'installation_failed'}});
  assert.equal(root.dataset.phase,'ready','ready removes the CSS animation selector');
  assert.equal(el('status').textContent,'','successful setup needs no status duplicating the Open button');
  assert.equal(el('open').hidden,false);assert.equal(el('restart').hidden,false);
  for(const unsafe of ['javascript:alert(1)','http://example.test','https://user:secret@example.test']) {
    controls.render({phase:'ready',url:unsafe});
    assert.equal(el('open').hidden,true);assert.equal(el('open').href,undefined);
  }
  controls.render({phase:'opening'});
}
captures[0].render({phase:'failed',error:'installation_failed'});
assert.ok(roots.slice(1).every(root=>root.dataset.phase==='opening'),'each service owns independent state');
assert.ok(html.indexOf('<details><summary>App help')<html.indexOf('id="openchamber-previous"'),'previous failure stays inside help');
await captures[1].action('start');
assert.equal(roots[1].dataset.phase,'signed-out','session expiry stops activity');
assert.equal(roots[1].querySelector('#nanobot-login').hidden,false);
assert.equal(roots[1].querySelector('#nanobot-start').disabled,true,'expired service actions are disabled');
assert.equal(roots[2].dataset.phase,'opening','session handling stays scoped to its service');
console.log('PASS shared activity states, reduced-motion CSS, no predictions, independent services, safe links and session expiry');
console.log('Sandbox creation policy and browser rendering checks passed');
if (process.argv.includes('--serve')) {
  const port=Number(process.env.SANDBOX_PREVIEW_PORT||8790);
  createServer(async (req,res) => {
    const response = await app.request('http://127.0.0.1:'+port+req.url, {method:req.method});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }).listen(port,'127.0.0.1',()=>console.log('Synthetic Sandboxes dashboard: http://127.0.0.1:'+port));
}
