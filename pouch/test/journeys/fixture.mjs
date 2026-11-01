import { fileURLToPath } from 'node:url';
// Pouch with a scripted fake Sealed client (no model requests): the page's
// window.script is a queue of steps; each model request takes one:
//   { tool: 'run', args: {...} } -> a tool call;  { text } -> a final reply.
// An empty queue answers 'done'. Optional when: '<substring>' targets a request. window.requests records each request body.
// window.netDown = true makes the fake fetch fail like a dropped network.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const { build } = await import('esbuild');
const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const stub = `
const wait = ms => new Promise(r => setTimeout(r,ms));
window.requests=[]; window.script=window.script||[]; window.netDown=false;
const chunk=(delta,finish=null)=>({id:'fake',object:'chat.completion.chunk',created:0,model:'fake',choices:[{index:0,delta,finish_reason:finish}]});
function sse(deltas, slowMs=0) { const enc=new TextEncoder(); return new Response(new ReadableStream({async start(c){
  for(const d of deltas){ if(slowMs) await wait(slowMs); if(window.netDown){c.error(new TypeError('network error'));return;} c.enqueue(enc.encode('data: '+JSON.stringify(d)+'\\n\\n')); }
  c.enqueue(enc.encode('data: [DONE]\\n\\n'));c.close();
}}),{headers:{'content-type':'text/event-stream'}}); }
let n=0;
export class TinfoilAI {
  constructor(){ this.openAIOptions={apiKey:'fake'};
    this.chat={completions:{create:async b=>{ if(window.titleDelay) await wait(window.titleDelay); return {choices:[{message:{content:'Fake title'}}]}; }}};
    this.secureClient={fetch:async (url,init)=>{
      if(window.netDown||!navigator.onLine) throw new TypeError('Failed to fetch');
      const b=JSON.parse(init.body);window.requests.push(b);
      // A step with when: '<substring>' answers only a request whose body has it (subagent vs parent).
      const body=init.body; let at=window.script.findIndex(x=>x&&x.when&&body.includes(x.when)); if(at<0) at=window.script.findIndex(x=>!x||!x.when);
      const s=at<0?undefined:window.script.splice(at,1)[0];
      if(s&&s.tool) return sse([chunk({role:'assistant',tool_calls:[{index:0,id:'call_'+(++n),type:'function',function:{name:s.tool,arguments:JSON.stringify(s.args)}}]}),chunk({},'tool_calls')]);
      const text=(s&&s.text)||'done';
      if(s&&s.slow) return sse([chunk({role:'assistant',content:''}),...Array.from({length:s.slow},(_, i)=>chunk({content:'word'+i+' '})),chunk({},'stop')],100);
      return sse([chunk({role:'assistant',content:text}),chunk({},'stop')]);
    }};
  }
  async ready(){ if(!navigator.onLine) throw new TypeError('Failed to fetch'); } async getVerificationDocument(){return {securityVerified:true};}
}
`;
export async function fixtureHtml() {
  const worker = (await build({ entryPoints: [root + '/src/run/worker-browser.js'], bundle: true, minify: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning' })).outputFiles[0].text;
  const bundled = await build({ entryPoints: [root + '/src/main.js'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
    define: { WORKER_SRC: JSON.stringify(worker) },
    alias: { 'node:zlib': root + '/src/shims/zlib.js', zlib: root + '/src/shims/zlib.js', 'decode-named-character-reference': root + '/node_modules/decode-named-character-reference/index.js' },
    plugins: [{ name: 'fake-tinfoil', setup(b) { b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js' })); } }] });
  let html = readFileSync(root + '/pouch.html', 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`);
  return html.replace('__SCRIPT_HASHES__', hashes.join(' ')).replaceAll('__BUILD_ID__', 'fixture');
}
export async function serveHtml(html) {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/pouch.html`, close: () => server.close() };
}
// Route api.bayleaf.dev: models list and usage answered locally, all else aborted.
export async function fakeNetwork(ctx, log = []) {
  await ctx.route('https://**/*', (r) => {
    const u = new URL(r.request().url()); log.push(u.href);
    if (u.pathname.endsWith('/models')) return r.fulfill({ json: { data: [{ id: 'fake', name: 'fake', tool_calling: true, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    return r.abort();
  });
  return log;
}
