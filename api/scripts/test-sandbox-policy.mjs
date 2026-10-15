/** Automatic creation-policy/SSR checks and a synthetic server for real-browser qualification. */
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
// Loopback-only fixture controls, never imported by the application. State is
// shared within this preview process; use one qualifying browser at a time.
let scenario = 'passive', phase = 'idle', startedAt;
app.post('/__fixture/:state', c => {
  const state = c.req.param('state');
  if (!['passive','ready','failure','expired'].includes(state)) return c.json({error:'unknown_fixture'},400);
  scenario = state; phase = 'idle'; startedAt = undefined;
  return c.json({scenario});
});
for (const service of Object.keys(SERVICE_DEFS)) {
  app.get('/services/'+service+'/status', c => {
    if (service !== 'openchamber') return c.json({phase:'idle',machine:'started'});
    if (scenario === 'expired') return c.json({error:'session_expired'},401);
    if (phase === 'opening' && Date.now()/1000-startedAt >= 2) phase = scenario === 'failure' ? 'failed' : 'ready';
    return c.json({phase,machine:'started',started_at:startedAt,
      ...(phase === 'opening' ? {progress:'registering_preview'} : {}),
      ...(phase === 'failed' ? {error:'installation_failed',timeline:[{step:'failed',at:startedAt+2}]} : {}),
      ...(phase === 'ready' ? {url:'https://synthetic-private.example.test/',deadline:startedAt+86400} : {})});
  });
  for (const action of ['start','restart']) app.post('/services/'+service+'/'+action,c => {
    if (scenario === 'expired') return c.json({error:'session_expired'},401);
    if (service !== 'openchamber') return c.json({error:'service_busy'},409);
    phase = 'opening'; startedAt = Math.floor(Date.now()/1000); return c.json({phase});
  });
}
const page = await app.request('http://localhost/');
const html = await page.text();
assert.equal(page.status,200);
assert.ok(!html.includes('browser-continue') && !html.includes('browser-stop'));
assert.ok(html.includes('90 days are deleted') && html.includes('same sandbox files'));
assert.ok(!/<details[^>]*\sopen(?:\s|>)/.test(html),'SSR diagnostics start collapsed');
const scripts=[...html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length,1);
assert.ok(page.headers.get('Content-Security-Policy').includes("script-src 'nonce-"+scripts[0][1]+"'"));
for (const service of Object.keys(SERVICE_DEFS)) assert.ok(html.includes('data-endpoint="/services/'+service+'"'));
assert.doesNotMatch(html,/progressbar|aria-valuenow|requestAnimationFrame/);
console.log('PASS sandbox creation policy and SSR smoke checks (no browser executed)');
if (process.argv.includes('--serve')) {
  const port=Number(process.env.SANDBOX_PREVIEW_PORT||8790);
  createServer(async (req,res) => {
    console.log(req.method+' '+req.url);
    const response = await app.request('http://127.0.0.1:'+port+req.url, {method:req.method});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }).listen(port,'127.0.0.1',()=>console.log('Synthetic Sandboxes dashboard: http://127.0.0.1:'+port));
}
