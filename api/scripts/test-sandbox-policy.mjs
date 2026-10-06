/** Shared creation policy and simplified browser controls, without live providers. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
const bundle = await build({ stdin: { contents: `
  export { createPersistentSandbox, persistentSandboxParams } from './src/daytona';
  export { SandboxBrowserControls } from './src/templates/sandboxBrowser';
  export { renderPage, BaseLayout } from './src/templates/layout';
  export { Hono } from 'hono';`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx' });
const { createPersistentSandbox, persistentSandboxParams, SandboxBrowserControls, renderPage, BaseLayout, Hono } = await import(
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
app.get('/', c => renderPage(c, BaseLayout({title:'Browser controls (synthetic)',children:SandboxBrowserControls({})})));
let phase = 'idle', startedAt;
const observed=[['locating_sandbox',0],['creating_sandbox',0],['starting_sandbox',0],
  ['preparing_setup',1],['checking',3],['checking',4],['installing_openchamber',4],
  ['configuring',17],['installing_opencode',17],['starting_openchamber',20],
  ['waiting_for_opencode',20],['connecting_bayleaf',22],['loading_tools',23],
  ['checking_readiness',24],['ready',24],['registering_preview',24],['ready',26]];
app.get('/sandbox/browser/status', c => {
  const elapsed=Date.now()/1000-startedAt;
  if(phase==='opening'&&elapsed>=26)phase='ready';
  const timeline=startedAt?observed.filter(([,at])=>at<=elapsed).map(([step,at])=>({step,at:startedAt+at})):[];
  return c.json({phase,machine:'started',operation:String(startedAt),started_at:startedAt,
    timeline,progress:timeline.at(-1)?.step,
    ...(phase==='ready'?{url:'https://synthetic-private.example.test/',deadline:startedAt+86400}:{})});
});
for(const action of ['start','restart'])app.post('/sandbox/browser/'+action,c=>{
  phase='opening';startedAt=Math.floor(Date.now()/1000);return c.json({phase});
});
const html = await (await app.request('http://localhost/')).text();
assert.ok(!html.includes('browser-continue') && !html.includes('browser-stop'));
assert.ok(!html.includes('Extend 6 hours') && !html.includes('End browser work'));
assert.ok(html.includes('links last up to 24 hours'));
assert.ok(!html.includes('setInterval(countdown'));
// This is our own SSR output, not untrusted HTML or an HTML sanitization step.
// The component emits exactly one fixed script element. Parse its JS directly.
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.indexOf('</script>', scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart);
assert.equal(html.indexOf('<script>', scriptStart + 1), -1);
new Function(html.slice(scriptStart + '<script>'.length, scriptEnd));
const script=html.slice(scriptStart + '<script>'.length, scriptEnd);
const nodes=new Map();
const node=()=>({style:{},dataset:{},textContent:'',append(){},replaceChildren(){},
  setAttribute(){},removeAttribute(){},addEventListener(){}});
const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},
  createElement:node,createTextNode:()=>node(),querySelectorAll:()=>[]};
const motion={matches:false};let scheduled=0,cancelled=0;
const testScript=script.slice(0,script.lastIndexOf('refresh();'))+
  'return {meter,render,total};'+script.slice(script.lastIndexOf('refresh();')+'refresh();'.length);
const controls=new Function('document','window','setInterval','setTimeout','clearTimeout',
  'requestAnimationFrame','cancelAnimationFrame',testScript.replace('(() => {','return (() => {'))(
    document,{matchMedia:()=>motion,addEventListener(){}},()=>{},()=>{},()=>{},
    ()=>++scheduled,()=>++cancelled);
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
console.log('PASS 26-second calibration, frame interpolation, waiting cap, duplicate events, reduced motion and animation cleanup');
console.log('Sandbox creation policy and browser rendering checks passed');
if (process.argv.includes('--serve')) {
  createServer(async (req,res) => {
    const response = await app.request('http://127.0.0.1:8790'+req.url, {method:req.method});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }).listen(8790,'127.0.0.1',()=>console.log('Synthetic browser controls: http://127.0.0.1:8790'));
}
