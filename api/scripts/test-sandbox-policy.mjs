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
let phase = 'idle';
app.get('/sandbox/browser/status', c => c.json({ phase, machine: 'started',
  ...(phase === 'ready' ? { url: 'https://synthetic-private.example.test/', deadline: Math.floor(Date.now()/1000)+86400 } : {}) }));
app.post('/sandbox/browser/start', c => { phase = 'ready'; return c.json({phase}); });
app.post('/sandbox/browser/restart', c => { phase = 'ready'; return c.json({phase}); });
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
console.log('Sandbox creation policy and browser rendering checks passed');
if (process.argv.includes('--serve')) {
  createServer(async (req,res) => {
    const response = await app.request('http://127.0.0.1:8790'+req.url, {method:req.method});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }).listen(8790,'127.0.0.1',()=>console.log('Synthetic browser controls: http://127.0.0.1:8790'));
}
