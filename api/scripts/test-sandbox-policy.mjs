/** Shared creation policy and simplified browser controls, without live providers. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
const bundle = await build({ stdin: { contents: `
  export { createPersistentSandbox, persistentSandboxParams } from './src/daytona';
  export { renderSandboxPage } from '../sandbox/page';
  export { Hono } from 'hono';`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx' });
const { createPersistentSandbox, persistentSandboxParams, renderSandboxPage, Hono } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const env = { DAYTONA_API_URL: 'https://daytona.example.test/api',
  DAYTONA_API_KEY: 'synthetic', DAYTONA_DEPLOYMENT_LABEL: 'synthetic-chat', DAYTONA_AUTO_DELETE_MINUTES: '-1' };
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
const page = await app.request('http://localhost/');
const html = await page.text();
assert.ok(!html.includes('browser-continue') && !html.includes('browser-stop'));
assert.ok(!html.includes('Extend 6 hours') && !html.includes('End browser work'));
assert.ok(html.includes('links last up to 24 hours'));
assert.ok(!html.includes('setInterval(countdown'));
// This is our own SSR output, not untrusted HTML or an HTML sanitization step.
// The page emits one nonce-bearing script. Match its nonce to the actual CSP.
const scripts=[...html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length,1);
const [,nonce,script]=scripts[0];
assert.ok(page.headers.get('Content-Security-Policy').includes("script-src 'nonce-"+nonce+"'"));
assert.ok(html.includes('data-endpoint="/services/openchamber"'));
new Function(script);
const nodes=new Map();
const node=()=>({style:{},dataset:{},textContent:'',disabled:false,append(){},replaceChildren(){},
  setAttribute(){},removeAttribute(){},addEventListener(){}});
const root={dataset:{endpoint:'/services/openchamber'},querySelector(selector){
  assert.match(selector,/^#browser-/);
  const id=selector.slice(1);
  assert.ok(html.includes('id="'+id+'"'),'selector exists in rendered page: '+selector);
  if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);
},querySelectorAll:()=>[...nodes.values(),loginButton]};
const loginButton=node();
const document={createElement:node,createTextNode:()=>node(),querySelectorAll(selector){
  assert.equal(selector,'[data-service]');return [root];
}};
const motion={matches:false};let scheduled=0,cancelled=0;
// Capture inside each service's loop scope, replacing only the initial fetch.
const captures=[];
assert.ok(script.lastIndexOf('refresh();')>=0);
const testScript=script.slice(0,script.lastIndexOf('refresh();'))+
  'captures.push({meter,render,total,signedOut,action});'+script.slice(script.lastIndexOf('refresh();')+'refresh();'.length);
new Function('document','window','setInterval','setTimeout','clearTimeout',
  'requestAnimationFrame','cancelAnimationFrame','captures','fetch',testScript)(
    document,{matchMedia:()=>motion,addEventListener(){}},()=>{},()=>{},()=>{},
    ()=>++scheduled,()=>++cancelled,captures,async()=>new Response('',{status:401}));
assert.equal(captures.length,1);
const [controls]=captures;
assert.equal(controls.total,26);
const opening={phase:'opening',operation:'synthetic',started_at:100,
  timeline:[{step:'installing_openchamber',at:104}]};
const fill=()=>Number(nodes.get('browser-fill').style.transform.match(/scaleX\((.*)\)/)[1]);
controls.meter(opening,104);assert.equal(fill(),0);
controls.meter(opening,104.016);const firstFill=fill();assert.ok(firstFill>0);
controls.meter(opening,104.032);assert.ok(fill()>firstFill,'animation advances between polling responses');
motion.matches=true;
controls.meter(opening,117);
assert.ok(Math.abs(fill()-(4+13*0.9)/26)<1e-9);
assert.equal(nodes.get('browser-track').dataset.waiting,'true');
controls.meter(opening,130);assert.ok(Math.abs(fill()-(4+13*0.9)/26)<1e-9,'overdue step stops instead of creeping');
const checking={...opening,operation:'duplicate-check',timeline:[{step:'checking',at:103},{step:'checking',at:104}]};
controls.meter(checking,104);
assert.ok(Math.abs(fill()-3.9/26)<1e-9,'duplicate step must not reset its clock');
controls.meter({...opening,operation:'new-operation',timeline:[]},100);assert.equal(fill(),0);
controls.render(opening);assert.equal(scheduled,1);
controls.render({...opening,phase:'ready',url:'https://synthetic.example.test/'});
assert.equal(cancelled,1);assert.equal(nodes.get('browser-meter').hidden,true);
controls.render(opening);assert.equal(scheduled,2);
await controls.action('start');assert.equal(cancelled,2);
assert.equal(nodes.get('browser-meter').hidden,true);
assert.equal(nodes.get('browser-login').hidden,false);
assert.equal(loginButton.disabled,false,'expired-session recovery submit stays usable after action finally');
assert.equal(nodes.get('browser-start').disabled,true,'expired service actions are disabled');
console.log('PASS 26-second calibration, frame interpolation, waiting cap, duplicate events, reduced motion and animation cleanup');
console.log('Sandbox creation policy and browser rendering checks passed');
if (process.argv.includes('--serve')) {
  const port=Number(process.env.SANDBOX_PREVIEW_PORT||8790);
  createServer(async (req,res) => {
    const response = await app.request('http://127.0.0.1:'+port+req.url, {method:req.method});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }).listen(port,'127.0.0.1',()=>console.log('Synthetic Sandboxes dashboard: http://127.0.0.1:'+port));
}
