/** Synthetic dashboard status preview; no production credentials or compute. */
import {build} from 'esbuild';
import {createServer} from 'node:http';
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
  import {SandboxBrowserControls} from './src/templates/sandboxBrowser';
  import {Style} from 'hono/css';
  import {Hono} from 'hono';
  const app=new Hono();
  app.get('/',c=>c.html(<html><head><meta name="viewport" content="width=device-width, initial-scale=1"/><Style /></head><body style="font-family:system-ui;max-width:650px;margin:2rem auto;padding:1rem"><h1>BayLeaf Sandbox</h1><SandboxBrowserControls /></body></html>));
  export const html=async()=>await (await app.request('/')).text();
`},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',jsxImportSource:'hono/jsx'});
const {html}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const start=Math.floor(Date.now()/1000)-50;
let failed=false;
createServer(async(req,res)=>{
  if(req.url.startsWith('/sandbox/browser/')) {
    if(req.method==='POST')failed=!failed;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({phase:failed?'failed':'opening',machine:'started',progress:'loading_tools',
      started_at:start,updated_at:start+48,heartbeat_at:Math.floor(Date.now()/1000)-2,
      error:failed?'provider_configuration_unavailable':undefined,
      previous_failure:{at:start-60,error:'application_not_ready',elapsed:230},
      timeline:[{step:'locating_sandbox',at:start},{step:'installing_openchamber',at:start+2},
        {step:'installing_opencode',at:start+15},{step:'connecting_bayleaf',at:start+28},
        {step:'loading_tools',at:start+30},...(failed?[{step:'failed',at:start+48,error:'provider_configuration_unavailable'}]:[])]}));
  }else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await html());}
}).listen(8766,'127.0.0.1',()=>console.log('Synthetic Sandbox status: http://127.0.0.1:8766'));
