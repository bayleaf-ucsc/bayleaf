#!/usr/bin/env node
/** Code-owned documentation contracts in real workerd, with synthetic metadata. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import worker from './src/index';
  export { PreviewConnections, SandboxBrowser, SandboxManagement } from './src/index';
  export default { ...worker, fetch(request, env, ctx) {
    const alternate = request.headers.get('X-Test-Deployment') === 'alternate';
    return worker.fetch(request, alternate ? { ...env, GRANTS_ENABLED: 'false', SEALED_ENABLED: 'false',
      BEDROCK_ENABLED: 'true', VERTEX_ENABLED: 'true', RECOMMENDED_MODEL: 'test/alternate' } : env, ctx);
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'], loader: { '.py': 'text', '.md': 'text' } });
const mf = new Miniflare(convertV4MiniflareOptions({
  port: process.argv.includes('--serve') ? 8806 : 0,
  workers: [{ name: 'docs-harness', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-01-31', compatibilityFlags: ['nodejs_compat'],
    bindings: { RECOMMENDED_MODEL: 'test/model', GRANTS_ENABLED: 'true', GRANTS_MAX_SECONDS: '900',
       SEALED_ENABLED: 'true', SEALED_RECOMMENDED_MODEL: 'test-sealed', SEALED_CURATED_MODELS: '',
       TINFOIL_API_KEY: 'synthetic-tinfoil-key',
       BEDROCK_ENABLED: 'false', VERTEX_ENABLED: 'false',
       CAMPUS_IP_RANGES: '192.0.2.0/24', CAMPUS_POOL_KEY: 'synthetic-campus-key',
      GWS_CLIENT_ID: 'synthetic-client', GWS_CLIENT_SECRET: 'synthetic-secret', GWS_PROJECT_ID: 'synthetic-project' },
    durableObjects: { PREVIEW_CONNECTIONS: { className: 'PreviewConnections', useSQLite: true },
      SANDBOX_BROWSER: { className: 'SandboxBrowser', useSQLite: true } },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/models')) return Response.json({ data: [
        { id: 'test/model', name: 'Synthetic model', pricing: { prompt: '0', completion: '0' } },
        { id: 'test/alternate', name: 'Alternate model', pricing: { prompt: '0', completion: '0' } },
      ] });
       if (url.hostname === 'inference.tinfoil.sh' && url.pathname === '/v1/models') {
         return Response.json({ data: [{ id: 'test-sealed', type: 'chat', endpoints: ['/v1/chat/completions'] }] });
       }
       throw new Error('Documentation must not invoke another provider or infer');
    },
  }],
}));
const get = (path, headers = {}) => mf.dispatchFetch(`http://localhost:8806${path}`, { headers, redirect: 'manual' });
try {
  const spec = await (await get('/docs/openapi.json')).json();
  const schemas = spec.components.schemas;
  const grants = spec.tags.find(t => t.name === 'Grants').description;
  assert.ok(grants.includes('Verify state') && grants.includes('not origin-bound'));
  assert.equal(spec.externalDocs.url, 'https://api.bayleaf.dev/llms.txt');
  assert.ok(spec.info.description.includes('maximum lifetime is 900 seconds'));
  assert.ok(!spec.info.description.includes('Include `Authorization: Bearer <key>` on all requests'));
  assert.equal(spec.components.securitySchemes.BrowserSession.in, 'cookie');
  assert.equal(spec.components.securitySchemes.BrowserSession.name, 'bayleaf_session');
  for (const [schema, fields] of Object.entries({
    GrantRequest: ['model', 'expires_in'], GrantToken: ['grant_id', 'name', 'key', 'access_token', 'model', 'expires_at', 'expires_in', 'base_url'],
    ClientDescriptorRequest: ['client_name', 'redirect_uri'], ClientDescriptor: ['client_id', 'expires_at'],
    GrantExchange: ['code', 'client_id', 'redirect_uri', 'code_verifier'],
  })) for (const field of fields) assert.ok(schemas[schema].properties[field].description, `${schema}.${field} needs a contract description`);
  assert.ok(schemas.GrantList.properties.grants.items.properties.id.description.includes('grant_id'));
  assert.ok(schemas.GrantModels.properties.backends.items.properties.available.description.includes('not a model-health'));
  assert.ok(spec.info.description.includes('Dedicated sandbox credential'));
  for (const [path, method] of [['/grants', 'get'], ['/grants', 'post'], ['/grants/models', 'get'], ['/grants/{id}', 'delete']]) {
    assert.deepEqual(spec.paths[path][method].security, [{ Bearer: [] }, { BrowserSession: [] }]);
  }
  for (const [path, method] of [['/v1/decisions', 'post'], ['/v1/chat/completions', 'post'], ['/v1/responses', 'post'], ['/v1/models', 'get'], ['/web/search', 'post'], ['/web/fetch', 'post']]) {
    assert.deepEqual(spec.paths[path][method].security, [{ Bearer: [] }, {}]);
  }
  assert.deepEqual(spec.paths['/usage'].get.security, [{ Bearer: [] }]);
  assert.deepEqual(spec.paths['/sandbox/exec'].post.security, [{ Bearer: [] }]);
  const authorize = spec.paths['/grants/authorize'].get;
  assert.equal(authorize.operationId, 'authorizeInferenceClient');
  assert.deepEqual(authorize.security, []);
  assert.deepEqual(authorize.parameters.map(p => p.name).sort(), ['client_id', 'response_type', 'model', 'models', 'expires_in', 'state', 'code_challenge', 'code_challenge_method'].sort());
  assert.equal(authorize.parameters.find(p => p.name === 'models').required, false);
  assert.equal(authorize.parameters.find(p => p.name === 'model').required, false);
  assert.ok(authorize.responses['303'].headers.Location);
  assert.ok(authorize.responses['200'].content['text/html']);
  assert.equal(spec.paths['/grants/authorize'].post, undefined, 'Internal consent form stays private');
  const continuation = await get('/grants/authorize?request=nonexistent');
  assert.equal(continuation.status, 400);
  assert.ok((await continuation.json()).error.message.includes('different browser'), 'Registry must not install public-query validation');
  const shell = await (await get('/docs')).text();
  assert.ok(shell.includes('data-url="/docs/openapi.json"'));
  assert.ok(!shell.includes('<header') && !shell.includes('docs-navigation'), 'Keep the original plain Scalar shell');
  assert.ok(shell.includes('lang="en"'));
  const legacy = await get('/docs/SKILL.md');
   assert.equal(legacy.status, 301); assert.equal(legacy.headers.get('Location'), '/llms.txt');
   const catalogBase = '/docs/opencode/skills/';
   const catalogResponse = await get(catalogBase + 'index.json');
   assert.equal(catalogResponse.status, 200, 'Catalog is public');
   const catalog = await catalogResponse.json();
   assert.deepEqual(catalog.skills, [{ name: 'bayleaf-platform', version: '1', files: ['bayleaf-platform.md'] }]);
   const skillResponse = await get(catalogBase + 'bayleaf-platform/bayleaf-platform.md');
   assert.equal(skillResponse.status, 200, 'Skill is public');
   assert.match(skillResponse.headers.get('content-type'), /text\/markdown/);
   const skill = await skillResponse.text();
   assert.match(skill, /^---\nname: bayleaf-platform\ndescription: .+\n---\n/);
   assert.ok(skill.length < 1800, 'Keep discovery slim');
   for (const phrase of ['https://api.bayleaf.dev/llms.txt', 'Google Workspace', 'Canvas LMS',
     'Sandbox', 'switching providers', 'not a claim that tools are installed']) assert.ok(skill.includes(phrase));
   for (const prefix of ['', '/sealed']) {
     const response = await get(prefix + '/.well-known/opencode/config', { 'CF-Connecting-IP': '192.0.2.1' });
     assert.equal(response.status, 200);
     const { config } = await response.json();
     assert.deepEqual(config.skills, ['http://localhost:8806' + catalogBase]);
     assert.equal(config.websearch, undefined, 'Desktop skill must not replace search');
     assert.equal(config.instructions, undefined, 'Do not inject the full reference');
     assert.equal(config.plugins, undefined, 'No additional desktop plugin');
     if (prefix === '/sealed') {
       assert.equal(config.model, 'bayleaf-sealed-remote/test-sealed');
       assert.equal(config.plugin.length, 1, 'Preserve only the existing Sealed transport');
     } else {
       assert.equal(config.model, 'bayleaf-remote/test/model');
       assert.equal(config.plugin, undefined);
     }
   }
  const llms = await (await get('/llms.txt')).text();
  assert.ok(llms.includes('Documentation ownership') && llms.includes('## HTTP API overview'));
  assert.ok(llms.includes('not BayLeaf inference API endpoints'));
  assert.ok(llms.includes('docs#tag/grants') && llms.includes('authorizeInferenceClient'));
  assert.ok(!llms.includes('#### Direct issuance and model discovery'), 'No duplicate exhaustive grant contract');
  const operations = new Set(Object.values(spec.paths).flatMap(path => Object.values(path).map(op => op.operationId)));
  for (const id of ['createTemporaryInferenceToken', 'describeInferenceClient', 'authorizeInferenceClient', 'exchangeInferenceCode', 'inspectCampusPass']) {
    assert.ok(llms.includes(id) && operations.has(id), `Guide must link an existing operation: ${id}`);
  }
  const guide = llms.replace(/```[\s\S]*?```/g, '');
  const headings = new Set([...guide.matchAll(/^#+ (.+)$/gm)].map(m => m[1].toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-')));
  for (const match of guide.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(headings.has(match[1]), `Missing Markdown heading: ${match[1]}`);
  const alternate = await (await get('/docs/openapi.json', { 'X-Test-Deployment': 'alternate' })).json();
  assert.ok(alternate.info.description.includes('tokens are disabled'));
  assert.ok(alternate.info.description.includes('Sealed is disabled'));
  assert.ok(alternate.info.description.includes('Google Vertex AI: enabled'));
  const alternateLlms = await (await get('/llms.txt', { 'X-Test-Deployment': 'alternate' })).text();
  assert.ok(alternateLlms.includes('test/alternate'));
  assert.ok(alternateLlms.includes('Status: not enabled on this deployment'));
  assert.ok(!alternateLlms.includes('### Sealed LLM inference'));
  console.log('PASS: workerd documentation ownership, grant contracts/navigation, security alternatives, links and deployment-aware prose');
  if (process.argv.includes('--serve')) {
    console.log(`Synthetic local docs preview: ${await mf.ready}/docs`);
    await new Promise(() => {});
  }
} finally { await mf.dispose(); }
