#!/usr/bin/env node
/** Real workerd/D1/DO state; synthetic Daytona. Never contacts production. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, WebSocketPair, Response as WorkerResponse } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const api = 'https://api.example.test';
const email = 'owner@example.test';
const secret = 'synthetic-oidc-secret';
const previewSecret = Buffer.alloc(32, 7).toString('base64');
// Advance the fake wall clock to the real controller's recorded next alarm.
// No production due checks are bypassed by this harness.
let testNow = Date.now();
Date.now = () => testNow;
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  import { SandboxBrowser as Controller } from './src/sandboxBrowser.ts';
  export { PreviewConnections } from './src/index.ts';
  let clock=Date.now(); Date.now=()=>clock;
  let rejectCreateTransport=false;
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    if(rejectCreateTransport && typeof input==='string' && String(input)==='https://api.daytona.com/sandboxes' && init?.method==='POST') {
      rejectCreateTransport=false;return Promise.reject(new Error('synthetic connection lost'));
    }
    return nativeFetch(input,init);
  };
  export class SandboxBrowser extends Controller {
    constructor(state,env) {
      // Record alarm intent in actual DO storage; advance steps explicitly.
      const storage=new Proxy(state.storage,{get(target,key){
        if(key==='setAlarm') return async time=>target.put('__nextAlarm',time);
        if(key==='deleteAlarm') return async ()=>target.delete('__nextAlarm');
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
      }});
      super({id:state.id,storage},env); this.testStorage=state.storage;
    }
    async fetch(req) {
      clock=Number(req.headers.get('X-Test-Clock')||clock);
      const path=new URL(req.url).pathname;
      const service=new URL(req.url).searchParams.get('service')||'opencode-web';
      const key='operation/'+service;
       if(path==='/__record')return Response.json(await this.testStorage.get(key));
       if(path==='/__legacy-operation') {
         // Retired OpenChamber stored its record under the unnamed key.
         const legacy={email:req.headers.get('X-BayLeaf-Owner'),operation:'legacy-openchamber',phase:'opening',
           step:'inspect',progress:'loading_tools',nextAt:0,deadline:9999999999,setupDeadline:9999999999};
         await this.testStorage.put('operation',legacy);return Response.json(legacy);
       }
       if(path==='/__legacy-record')return Response.json(await this.testStorage.get('operation')??null);
       if(path==='/__registration-crash') {
         const op=await this.testStorage.get(key);op.phase='opening';op.step='register';op.nextAt=Date.now();delete op.url;
         await this.testStorage.put(key,op);await this.arm();return Response.json(op);
       }
      if(path==='/__delay' || path==='/__retry') {
        const op=await this.testStorage.get(key);
        op.nextAt=Date.now()+60000;
        if(path==='/__delay')op.setupDeadline=Math.floor(Date.now()/1000)+3;
        else {op.phase='failed';op.invalidated=false;op.error='setup_failed';}
        await this.testStorage.put(key,op);await this.arm();return Response.json(op);
      }
      if(path==='/__alarm-now') {await this.alarm();return Response.json(await this.testStorage.get(key));}
      if(path==='/__alarm') return Response.json(await this.testStorage.get('__nextAlarm')||null);
      if(path==='/__tick') {await this.alarm(); return Response.json(await this.testStorage.get(key));}
      if(path==='/__expire') {
        const op=await this.testStorage.get(key);op.deadline=0;await this.testStorage.put(key,op);
        await this.alarm();return Response.json(await this.testStorage.get(key));
      }
      return super.fetch(req);
    }
  }
  export default {...app,async fetch(req,env,ctx){
    clock=Number(req.headers.get('X-Test-Clock')||clock);
    if(req.headers.has('X-Test-Create-Transport'))rejectCreateTransport=true;
    const u=new URL(req.url);
    if(u.pathname.startsWith('/__test/')) {
      const owner=req.headers.get('X-Test-Owner')||'owner@example.test';
      return env.SANDBOX_BROWSER.get(env.SANDBOX_BROWSER.idFromName(owner)).fetch('https://controller/'+u.pathname.slice(8)+u.search,
        {method:req.method,headers:{'X-BayLeaf-Owner':owner,'X-Test-Clock':String(clock)}});
    }
    const headers=new Headers(req.headers);
    if(headers.has('X-Test-Origin')) {headers.set('Origin',headers.get('X-Test-Origin'));headers.delete('X-Test-Origin');}
    if(headers.has('X-Test-Mode')) {headers.set('Sec-Fetch-Mode',headers.get('X-Test-Mode'));headers.delete('X-Test-Mode');}
    return app.fetch(new Request(req,{headers}),headers.has('X-Test-Disabled')?{...env,BROWSER_SANDBOX_ENABLED:'false'}:env,ctx);
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], loader: { '.py': 'text', '.md': 'text' } });

// Harness state uses BayLeaf's normalized names; the mock speaks v2 wire status.
let state = 'stopped', lookupFails = false, exists = true, interrupted = false, memory = 4;
let creates = 0, wakes = 0, executions = 0, bootReads = 0, launches = 0, previewCalls = 0;
let incomingOperation, lastForwarded, lastForwardedUrl, toolboxFailures = 0, machineId = 'sbx_synthetic-sandbox', wrongService = false;
const credentialUploads = [];
const vault = new Map();
let failCreate = false, creationRequests = 0, createKeys = [];
let computerUse = [], desktopUp = false, desktopStartFails = false, registeredAtDesktopStop;
let jupyterAuth, ttydAuth, opencodeAuth, wrongOpencodeOrigin = false, stopFails = false, stops = 0;
let bootId = '11111111-2222-4333-8444-555555555555';
let mountedSecrets = [];
const uploads = new Map(), signedPorts = [];
const wire = () => ({ started: 'running', starting: 'booting' })[state] ?? state;
const sandbox = () => ({ id: machineId, status: wire(), labels: { 'synthetic-chat': email }, persistent: true,
  memory_max_mib: memory * 1024, toolbox_proxy_url: 'https://proxy.region.daytona.app/toolbox' });
const processResult = (output, exitCode = 0) => Response.json({ id: 'process', exitCode, logs: { frames: [{ data: output }], eof: true } });
async function guestCommand(command) {
  executions++;
  assert(!command.includes('sk-bayleaf-'), 'credential in command');
  for (const secret of [jupyterAuth, ttydAuth, opencodeAuth]) if (secret) assert(!command.includes(secret), 'app secret in command');
  if (command === 'cat /proc/sys/kernel/random/boot_id') { bootReads++; return processResult(`${bootId}\n`); }
  if (command.includes('subprocess.Popen') && command.includes('setup.py')) launches++;
  if (command.includes('/stop.py --service ')) {
    stops++;
    const operation = command.match(/--operation ([a-f0-9-]+)/)[1];
    return processResult(JSON.stringify({ stopped: !stopFails, operation }), stopFails ? 1 : 0);
  }
  // The controller always names the service; an unnamed inspect is never issued.
  assert(!command.endsWith('setup.py inspect'), 'inspect without --service');
  const appService = ['code-server', 'dufs', 'jupyter', 'ttyd', 'opencode-web'].find(id => command.endsWith('--service ' + id + ' inspect'));
  const at = Math.floor(Date.now() / 1000);
  if (appService) return processResult(JSON.stringify({
    // A retired installer reporting readiness must never satisfy another service.
    schema: 1, service: wrongService ? 'openchamber' : appService, operation: interrupted ? 'stale' : incomingOperation.operation,
    updated_at: at, phase: 'ready', ready: true,
    ...(appService === 'opencode-web' ? {
      preview_origin: wrongOpencodeOrigin ? 'https://stale.example.test' : incomingOperation.preview_origin,
    } : {}),
    port: { dufs: 8790, jupyter: 8793, ttyd: 8794, 'opencode-web': 8795 }[appService] ?? 8791,
    timeline: appService === 'opencode-web' ? [{ step: 'loading_tools', at },
      { step: 'credential-leak', at, error: 'secret' }, { step: 'connecting_bayleaf', at: 9999999999999 }]
      : [{ step: appService === 'dufs' ? 'installing_dufs' : 'installing_code_server', at }],
  }));
  return processResult('');
}
async function guestUpload(target, text) {
  uploads.set(target, text);
  if (target.endsWith('request.next.json')) {
    incomingOperation = JSON.parse(text);
    assert(incomingOperation.deadline <= Math.floor(Date.now() / 1000) + 20 * 60);
    if (target.includes('/opencode-web/')) {
      const preview = await db.prepare("SELECT hostname FROM preview_registrations WHERE slot='__opencode-web'").first();
      assert(preview, 'private origin must be registered before launching OpenCode');
      assert.equal(incomingOperation.preview_origin, `https://${preview.hostname}`);
    } else assert.equal(incomingOperation.preview_origin, undefined);
  }
  // v2 apps read their key from a mounted secret, never from an uploaded file.
  if (target.includes('/credentials/') && !target.endsWith('credentials/app-secret')) credentialUploads.push(target);
  if (target.endsWith('credentials/app-secret')) {
    assert.match(text, /^[a-f0-9]{64}$/);
    if (target.includes('/ttyd/')) ttydAuth = text;
    else if (target.includes('/jupyter/')) jupyterAuth = text;
    else if (target.includes('/opencode-web/')) opencodeAuth = text;
    else assert.fail('unexpected app-secret upload');
  }
}
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: 'browser-harness', modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2025-01-31', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  durableObjects: {
    PREVIEW_CONNECTIONS: { className: 'PreviewConnections', useSQLite: true },
    SANDBOX_BROWSER: { className: 'SandboxBrowser', useSQLite: true },
  },
  bindings: {
    BROWSER_SANDBOX_ENABLED: 'true', PREVIEWS_ENABLED: 'true', PREVIEWS_API_ORIGIN: api,
    PREVIEWS_DOMAIN: 'previews.example.test', PREVIEWS_SECRET: previewSecret,
    ALLOWED_EMAIL_DOMAIN: 'example.test',
    OIDC_CLIENT_SECRET: secret,
    SEALED_ENABLED:'true',SEALED_RPD_LIMIT:'500',
    RECOMMENDED_MODEL:'synthetic/model',OPENCODE_CURATED_MODELS:'synthetic/model',
    DAYTONA_API_KEY: 'synthetic-daytona-key', DAYTONA_DEPLOYMENT_LABEL: 'synthetic-chat',
    PREVIEWS_V2_UPSTREAM_SUFFIXES: '.preview.example.test',
    DAYTONA_V2_CREATE_ENABLED: 'true', DAYTONA_V2_IMAGE: 'synthetic-image', DAYTONA_V2_REGION: 'synthetic-region',
  },
  outboundService: async req => {
    const u = new URL(req.url);
    if (u.hostname==='openrouter.ai') return Response.json({data:u.pathname.endsWith('/models')?
      [{id:'synthetic/model',name:'Synthetic model',pricing:{prompt:'0.000001',completion:'0.000002'}}]:
      {limit:5,limit_remaining:3.75,limit_reset:'daily',usage:30,usage_daily:1.25}});
    if (u.hostname === 'api.daytona.com') {
      assert.equal(req.headers.get('Authorization'), 'Bearer synthetic-daytona-key');
      if (lookupFails && req.method === 'GET') return new Response('outage', { status: 503 });
      if (u.pathname === '/sandboxes/search') {
        const owner = JSON.parse(u.searchParams.get('labels'))['synthetic-chat'];
        return Response.json({ sandboxes: exists && owner === email ? [sandbox()] : [], next_cursor: null });
      }
      if (u.pathname === '/sandboxes' && req.method === 'POST') {
        creationRequests++;
        const body = await req.json();
        createKeys.push(body.idempotency_key);
        assert.deepEqual(body.labels, { 'synthetic-chat': email }); assert.equal(body.persistent, true);
        assert.equal(body.lifecycle_policy.on_idle_timeout, 'pause');
        if (failCreate) return new Response('ambiguous provider failure', { status: 503 });
        creates++; exists = true; state = 'started';
        return Response.json(sandbox(), { status: 201 });
      }
      if (u.pathname.startsWith('/secrets/') && req.method === 'PUT') {
        const name = u.pathname.split('/').at(-1), body = await req.json();
        assert.deepEqual(body.allowed_domains, ['api.bayleaf.dev']);
        assert.match(body.value, /^sk-bayleaf-sandbox-[a-f0-9]{64}$/);
        vault.set(name, true);
        return Response.json({ name, allowed_domains: body.allowed_domains }, { status: 201 });
      }
      const path = `/sandboxes/${machineId}`;
      if (!exists || !u.pathname.startsWith(path)) return new Response('', { status: 404 });
      if (u.pathname === path) return Response.json(sandbox());
      if (u.pathname === `${path}/resume` && req.method === 'POST') {
        assert.equal(state, 'paused'); wakes++; state = 'started';
        return new Response(null, { status: 202 });
      }
      if (u.pathname === `${path}/start` && req.method === 'POST') {
        assert.equal(state, 'stopped'); wakes++; state = 'started';
        return new Response(null, { status: 202 });
      }
      if (u.pathname === `${path}/reset-idle-timer` && req.method === 'POST') return new Response(null, { status: 204 });
      if (u.pathname === `${path}/secrets` && req.method === 'GET') {
        return Response.json({ secrets: mountedSecrets, status: 'applied' }, { headers: { ETag: '"1"' } });
      }
      if (u.pathname === `${path}/secrets` && req.method === 'PUT') {
        assert.equal(req.headers.get('If-Match'), '"1"');
        ({ secrets: mountedSecrets } = await req.json());
        assert(mountedSecrets.every(name => vault.has(name)));
        return new Response(null, { status: 202 });
      }
      const signed = u.pathname.match(new RegExp(`^${path}/ports/(\\d+)/signed-preview-urls$`));
      if (signed && req.method === 'POST') {
        assert((await req.json()).expires_in_seconds <= 86400);
        previewCalls++; signedPorts.push(Number(signed[1]));
        return Response.json({ url: `https://${signed[1]}-synthetic.preview.example.test/` });
      }
    }
    if (u.hostname === 'proxy.region.daytona.app') {
      assert.equal(state, 'started', 'Toolbox must never run on paused or stopped compute');
      if (toolboxFailures > 0) { toolboxFailures--; return new Response('not ready', { status: 503 }); }
      const path = `/toolbox/${machineId}`;
      if (u.pathname === `${path}/processes`) {
        const { argv } = await req.json();
        return guestCommand(argv[0] === 'bash' && argv[1] === '-c' ? argv[2] : argv.join(' '));
      }
      if (u.pathname === `${path}/files/upload`) {
        await guestUpload(u.searchParams.get('path'), await (await req.formData()).get('file').text());
        return Response.json({});
      }
      if (u.pathname.startsWith(`${path}/computeruse/`)) {
        const action = u.pathname.split('/').at(-1);
        computerUse.push(`${req.method} ${action}`);
        if (action === 'start') desktopUp = !desktopStartFails;
        if (action === 'stop') {
          registeredAtDesktopStop = (await db.prepare("SELECT count(*) n FROM preview_registrations WHERE slot='__desktop'").first()).n;
          desktopUp = false;
        }
        return Response.json({ status: desktopUp ? 'active' : 'inactive' });
      }
    }
    if (u.hostname.endsWith('.preview.example.test')) {
      lastForwarded = Object.fromEntries(req.headers); lastForwardedUrl = req.url;
      if(req.headers.get('upgrade')==='websocket') {
        const pair=new WebSocketPair();pair[1].accept();
        pair[1].addEventListener('message',event=>pair[1].send(event.data));
        return new WorkerResponse(null,{status:101,webSocket:pair[0]});
      }
      return new Response('synthetic application');
    }
    throw new Error('Unexpected outbound host: '+u.hostname);
  },
}] }));
const db = await mf.getD1Database('DB');
const worker = await mf.getWorker();
const jwt = (payload, key = secret) => {
  const text = [{ alg:'HS256', typ:'JWT' }, payload].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return text+'.'+createHmac('sha256',key).update(text).digest('base64url');
};
const cookie = 'bayleaf_session='+jwt({ email, name:'Synthetic', exp:Math.floor(Date.now()/1000)+3600 });
async function req(path, options = {}) {
  if (path.startsWith('/__test/__tick')) {
    const next=await (await req('/__test/__alarm')).json();
    if(next)testNow=Math.max(testNow,next);
  }
  const headers = new Headers(options.headers);
  headers.set('X-Test-Clock',String(testNow));
  if (options.owner !== false) headers.set('Cookie',cookie);
  if (options.origin !== false) headers.set('X-Test-Origin',api);
  if (options.method === 'POST') headers.set('X-BayLeaf-Action','sandbox-browser');
  return worker.fetch(api+path, { method:options.method || 'GET', headers });
}
// Managed-app lifecycle reaches the controller only with an explicit service
// (the sandbox.bayleaf.dev RPC). OpenCode Web is the primary lifecycle subject.
const PRIMARY = 'opencode-web';
const primary = (name, options) => req('/__test/'+name+'?service='+PRIMARY, options);
const action = name => primary(name,{method:'POST'});
const status = async () => (await primary('status')).json();
const tick = async () => (await req('/__test/__tick')).json();
const finish = async () => {
  let op;
  for (let i=0;i<12;i++) { op=await tick(); if(op.phase!=='opening') break; }
  return op;
};
let checks=0;
async function check(name, fn) {await fn(); console.log('PASS '+name); checks++;}
try {
  for (const file of (await readdir(root+'migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    const sql=(await readFile(root+'migrations/'+file,'utf8')).replace(/^\s*--.*$/gm,'');
    const statements=file==='0009_preview_origin_invalidation.sql'?sql.split(/;\s*(?=CREATE|$)/):sql.split(';');
    for(const s of statements.map(x=>x.trim()).filter(Boolean)) await db.prepare(s).run();
  }
  for(const [owner,token] of [[email,'sk-bayleaf-owner'],['other@example.test','sk-bayleaf-other']])
    await db.prepare('INSERT INTO user_keys(email,bayleaf_token) VALUES (?,?)').bind(owner,token).run();

  await check('sandbox remote config is native V2, owner-key gated, and separate from desktop config',async()=>{
    const path='/sandbox/.well-known/opencode';
    const discovery=await (await req(path,{owner:false})).json();
    assert.equal(discovery.remote_config.url,api+path+'/config');
    for(const token of ['', 'campus', 'invalid'])
      assert.equal((await req(path+'/config',{owner:false,headers:{Authorization:'Bearer '+token}})).status,401);
    assert.ok([401,403,503].includes((await req(path+'/config',{owner:false,
      headers:{Authorization:'Bearer sk-bayleaf-grant-synthetic'}})).status));
    const response=await req(path+'/config',{owner:false,headers:{Authorization:'Bearer sk-bayleaf-owner'}});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const {config}=await response.json();
    assert.equal(config.model,'bayleaf-remote/synthetic/model');
    assert.equal(config.providers['bayleaf-remote'].package,'@opencode/ai/providers/openai-compatible');
    assert.equal(config.providers['bayleaf-remote'].models['synthetic/model'].cost.cache.read,0);
    assert.ok(config.plugins.includes('-opencode.tool.webfetch'));
    assert.ok(config.plugins.some(p=>/^github:bayleaf-ucsc\/opencode-sandbox#[0-9a-f]{40}$/.test(p)));
    assert.equal(config.websearch.provider,'bayleaf');assert.equal(config.provider,undefined);
    const desktop=await (await req('/.well-known/opencode/config',{owner:false,headers:{Authorization:'Bearer sk-bayleaf-owner'}})).json();
    assert.ok(desktop.config.provider['bayleaf-remote']);assert.equal(desktop.config.plugins,undefined);
    assert.equal(creates+wakes+executions,0);
  });

  await check('retired service-less /sandbox/browser lifecycle routes are gone; the controller requires a service',async()=>{
    for(const [method,name] of [['GET','status'],['POST','start'],['POST','restart'],['POST','stop'],['POST','continue'],['POST','wake-existing']]) {
      for(const headers of [{},{Authorization:'Bearer sk-bayleaf-owner'}]) {
        const response=await req('/sandbox/browser/'+name,{method,headers});
        assert.equal(response.status,404,`${method} /sandbox/browser/${name}`);
      }
    }
    for(const name of ['status','start','restart','stop']) {
      const response=await req('/__test/'+name,{method:name==='status'?'GET':'POST'});
      assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_operation');
      assert.equal((await req('/__test/'+name+'?service=openchamber',{method:name==='status'?'GET':'POST'})).status,400);
    }
    assert.equal(creates+wakes+executions,0);
  });
  await check('access revoke/rotate: anonymous, CSRF, bearer and disabled feature fail closed',async()=>{
    for(const name of ['revoke','rotate']) {
      const path='/sandbox/browser/access/'+name;
      assert.equal((await req(path,{method:'POST',owner:false})).status,401);
      assert.equal((await req(path,{method:'POST',origin:false})).status,403);
      const bearer=await req(path,{method:'POST',owner:false,headers:{Authorization:'Bearer sk-bayleaf-owner'}});
      assert.equal(bearer.status,403);assert.equal((await bearer.json()).error,'browser_session_required');
      assert.equal((await req(path,{method:'POST',headers:{'X-Test-Disabled':'1'}})).status,503);
      assert.equal((await req(path)).status,404,'access changes are POST-only');
    }
    // Reaches the owner controller: no sandbox credential exists to rotate yet.
    const rotate=await req('/sandbox/browser/access/rotate',{method:'POST'});
    assert.equal(rotate.status,409);assert.equal((await rotate.json()).error,'sandbox_access_unavailable');
    assert.equal(creates+wakes+executions,0);
  });
  await check('passive dashboard/status probes never wake or contact Toolbox',async()=>{
    for(let i=0;i<4;i++) assert.equal((await status()).machine,'stopped');
    assert.equal(creates+wakes+executions,0);
  });
  await check('usage inspection reports separate units, ignores stale counters, and never provisions keys',async()=>{
    const headers={Authorization:'Bearer sk-bayleaf-owner'};
    assert.equal((await req('/usage',{owner:false})).status,401);
    const unprovisioned=await (await req('/usage',{owner:false,headers})).json();
    assert.equal(unprovisioned.budgets[0].status,'not_provisioned');
    assert.equal(unprovisioned.budgets.find(b=>b.provider==='sealed').remaining,500);
    await db.prepare('UPDATE user_keys SET or_key_secret=?,sealed_rpd_date=?,sealed_rpd_count=7 WHERE email=?')
      .bind('synthetic-provider-key',new Date().toISOString().slice(0,10),email).run();
    const result=await (await req('/usage',{owner:false,headers})).json();
    assert.equal(result.budgets[0].used,1.25);assert.equal(result.budgets[0].remaining,3.75);
    assert.equal(result.budgets.find(b=>b.provider==='sealed').remaining,493);
    assert(!JSON.stringify(result).includes('synthetic-provider-key'));
    assert.equal(creates+wakes+executions,0);
  });
  let ready;
  await check('concurrent starts converge; stopped setup completes through persisted phases',async()=>{
    const results=await Promise.all(Array.from({length:8},async()=> (await action('start')).json()));
    assert.equal(new Set(results.map(x=>x.operation)).size,1);
    ready=await finish(); assert.equal(ready.phase,'ready');
    assert(ready.deadline>Math.floor(Date.now()/1000)+23*3600);
    assert(ready.deadline<=Math.floor(Date.now()/1000)+24*3600);
    assert.equal(wakes,1);assert.equal(launches,1);assert.equal(creates,0);
    assert.match(ready.url,/owner-private-[a-f0-9]{24}/);
  });
  await check('ready reopen preserves deadline and origin after only a boot-ID check; status stays passive',async()=>{
    const before=executions, reads=bootReads;
    for(let i=0;i<3;i++) {
      const result=await (await action('start')).json();
      assert.equal(result.url,ready.url);assert.equal(result.deadline,ready.deadline);
      await status();
    }
    assert.equal(bootReads,reads+3);assert.equal(executions,before+3,'Start reads only the boot ID');
    assert.equal(previewCalls,1);
  });
  await check('another owner has independent lifecycle state; legacy continue action does not exist',async()=>{
    const headers={'X-Test-Owner':'other@example.test'};
    const other=await (await primary('status',{owner:false,headers})).json();
    assert.equal(other.phase,'idle');assert.equal(other.url,undefined);
    for (const name of ['continue']) {
      assert.equal((await primary(name,{method:'POST',owner:false,headers})).status,404);
      assert.equal((await action(name)).status,404);
    }
    assert.equal((await status()).url,ready.url);
  });
  await check('legacy shorter registrations expire honestly and deliberate start relinks',async()=>{
    await db.prepare('UPDATE preview_registrations SET expires_at=0 WHERE hostname=?').bind(new URL(ready.url).hostname).run();
    const before=executions;
    const expired=await status();assert.equal(expired.phase,'expired');assert.equal(expired.url,undefined);
    assert.equal(executions,before);
    const oldUrl=ready.url;await action('start');ready=await finish();assert.equal(ready.phase,'ready');
    assert.notEqual(ready.url,oldUrl);
  });
  await check('public previews keep the default frame policy beside an active managed app, without widening fetch or POST',async()=>{
    const exposed=await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-owner','Content-Type':'application/json'},body:JSON.stringify({port:8000,access:'public'})});
    assert.equal(exposed.status,200);const url=(await exposed.json()).url;
    const headers={'X-Test-Mode':'navigate','Sec-Fetch-Dest':'iframe','Sec-Fetch-Site':'same-site'};
    // Retired OpenChamber's __browser slot once widened frame-ancestors; no managed app does now.
    const owner=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__opencode-web'").first();
    const legacy={...owner,hostname:'legacy-browser-frame.previews.example.test',slot:'__browser'};
    const columns=Object.keys(legacy);
    await db.prepare(`INSERT INTO preview_registrations (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).bind(...Object.values(legacy)).run();
    const framed=await worker.fetch(url,{headers});assert.equal(framed.status,200);
    assert.equal(framed.headers.get('Content-Security-Policy').split(';')[0],"frame-ancestors 'self'");
    assert.equal(framed.headers.get('X-Frame-Options'),'SAMEORIGIN');
    assert.equal((await worker.fetch(url,{headers:{'Sec-Fetch-Site':'same-site','X-Test-Mode':'cors'}})).status,403);
    assert.equal((await worker.fetch(url,{method:'POST',headers})).status,403);
    await db.prepare('DELETE FROM preview_registrations WHERE hostname=?').bind(legacy.hostname).run();
    await worker.fetch(api+'/sandbox/expose/8000',{method:'DELETE',headers:{Authorization:'Bearer sk-bayleaf-owner'}});
  });
  await check('managed gateway forwards project context and survives ordinary-key rotation',async()=>{
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__opencode-web'").first();
    assert(row.owner_key_hash);assert.equal(row.expires_at,ready.deadline);
    const origin=new URL(ready.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    const headers={Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin','X-Opencode-Directory':'/home/daytona/workspace'};
    assert.equal((await worker.fetch(ready.url,{headers:{'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin'}})).status,401);
    const otherSession=jwt({aud:origin,generation:'wrong-generation',exp:row.expires_at},previewSecret);
    assert.equal((await worker.fetch(ready.url,{headers:{...headers,Cookie:'__Host-bl-preview-session='+otherSession}})).status,401);
    assert.equal((await worker.fetch(ready.url,{headers})).status,200);
    assert.equal(lastForwarded['x-opencode-directory'],'/home/daytona/workspace');
    await db.prepare('UPDATE user_keys SET bayleaf_token=? WHERE email=?').bind('sk-bayleaf-rotated',email).run();
    assert.equal((await worker.fetch(ready.url,{headers})).status,200);
    assert.equal((await status()).phase,'ready');
  });
  await check('owner-session rotate and revoke reach the controller; revoke retires managed links and setup can reauthorize',async()=>{
    const rotated=await req('/sandbox/browser/access/rotate',{method:'POST'});
    assert.equal(rotated.status,200);assert.equal((await rotated.json()).success,true);
    assert.equal((await req('/sandbox/browser/access/revoke',{method:'POST'})).status,200);
    assert.equal((await worker.fetch(ready.url)).status,404);
    assert.equal((await db.prepare("SELECT count(*) n FROM sandbox_credentials WHERE email=? AND state='active'").bind(email).first()).n,0);
    assert.equal((await db.prepare('SELECT revoked FROM user_keys WHERE email=?').bind(email).first()).revoked,0);
    state='stopped';
  });
  await check('explicit restart reauthorizes sandbox access and gets a fresh origin',async()=>{
    await action('restart'); const next=await finish(); assert.equal(next.phase,'ready');
    assert.notEqual(next.url,ready.url); ready=next;
  });
  await check('interrupted setup retries boundedly, then fails with recoverable diagnostics',async()=>{
    interrupted=true;await action('restart');const next=await finish();
    assert.equal(next.phase,'failed');assert.equal(next.error,'setup_interrupted');
    interrupted=false;await action('start');ready=await finish();assert.equal(ready.phase,'ready');
    const status=await (await primary('status')).json();
    assert.equal(status.previous_failure.error,'setup_interrupted');
    assert.ok(status.previous_failure.elapsed>=0);
    assert.ok(status.timeline.some(e=>e.step==='loading_tools'));
    assert.ok(status.timeline.some(e=>e.step==='registering_preview'));
    assert.ok(!JSON.stringify(status).includes('credential-leak'));
    assert.ok(status.timeline.every(e=>e.at<=Math.floor(Date.now()/1000)));
  });
  await check('expiry revokes access without Toolbox polling or stopping shared compute',async()=>{
    const before=executions;
    const result=await (await req('/__test/__expire')).json();assert.equal(result.phase,'expired');
    assert.equal(executions,before);assert.equal(state,'started');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM preview_registrations WHERE slot='__opencode-web'").first()).n,0);
  });
  await check('provider lookup failure never provisions a replacement sandbox',async()=>{
    lookupFails=true;await action('start');const result=await tick();
    assert.equal(result.phase,'failed');assert.equal(creates,0);lookupFails=false;
  });
  await check('small existing sandboxes fail before credential transfer or compute changes',async()=>{
    const before = executions;
    memory=1; await action('start');assert.equal((await tick()).error,'requires_2_gib');
    memory=4;assert.equal(executions,before);assert.equal(creates,0);
  });
  await check('Toolbox readiness lag retries across durable alarms',async()=>{
    toolboxFailures=2;await action('start');const op=await finish();
    assert.equal(op.phase,'ready');assert.equal(toolboxFailures,0);
  });
  await check('confirmed absence creates once; browser links need no session end',async()=>{
    exists=false;
    const absent=await status();assert.equal(absent.phase,'idle');assert.equal(absent.machine,'absent');
    assert.equal(absent.error,undefined);assert.equal(absent.deadline,undefined);assert.equal(absent.url,undefined);
    await action('start');ready=await finish();assert.equal(ready.phase,'ready');assert.equal(creates,1);
    assert.equal(state,'started');
    assert.equal((await status()).phase,'ready');
  });
  await check('login wake is private, never creates or installs, and invalidates stale app readiness',async()=>{
    const before={creates,executions,launches,previewCalls,wakes};
    assert.equal((await req('/sandbox/browser/wake-existing',{method:'POST'})).status,404);
    const wake=()=>req('/__test/wake-existing',{method:'POST'});
    state='stopped';
    assert.equal((await (await wake()).json()).state,'starting');
    assert.equal(wakes,before.wakes+1);
    assert.equal((await status()).phase,'stopped');
    assert.equal((await status()).url,undefined,'control-plane wake cannot make a dead app look ready');
    assert.deepEqual({creates,executions,launches,previewCalls},
      {creates:before.creates,executions:before.executions,launches:before.launches,previewCalls:before.previewCalls});
    assert.equal((await (await wake()).json()).state,'started');
    exists=false;
    assert.equal((await (await wake()).json()).state,'absent');
    lookupFails=true;assert.equal((await wake()).status,503);lookupFails=false;
    assert.equal(creates,before.creates);
    exists=true;
    state='starting';assert.equal((await (await wake()).json()).state,'transitioning');
    state='started';
    await action('start');
    assert.equal((await (await wake()).json()).state,'opening','wake joins ongoing setup without changing it');
    ready=await finish();assert.equal(ready.phase,'ready');
    assert.equal(launches,before.launches+1,'only deliberate setup restores the app');
  });
  await check('passive status rediscovers a machine replaced by Chat/API without inheriting application readiness',async()=>{
    const before={creates,wakes,executions,previewCalls};
    machineId='sbx_replacement-sandbox';
    const result=await status();
    assert.equal(result.machine,'started');assert.equal(result.phase,'idle');assert.equal(result.url,undefined);
    assert.deepEqual({creates,wakes,executions,previewCalls},before);
  });
  await check('code-server dispatch, busy response, readiness identity and independent status',async()=>{
    state='stopped';
    await action('restart');ready=await finish();assert.equal(ready.phase,'ready');
    const endpoint='/__test/';
    const cs=path=>endpoint+path+'?service=code-server';
    assert.equal((await req(endpoint+'start?service=unknown',{method:'POST'})).status,400);
    assert.equal((await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-rotated','Content-Type':'application/json'},body:JSON.stringify({port:8791,access:'public'})})).status,400);
    const before=executions;
    assert.equal((await (await req(cs('status'))).json()).phase,'idle');
    assert.equal(executions,before);
    assert.equal((await req(cs('start'),{method:'POST'})).status,202);
    const busy=await action('restart');assert.equal(busy.status,409);
    const denied=await busy.json();assert.equal(denied.error,'service_busy');assert.equal(denied.operation,undefined);
    wrongService=true;
    for(let i=0;i<5;i++)await req(cs('__tick'));
    assert.equal((await (await req(cs('status'))).json()).phase,'opening','wrong service cannot register readiness');
    wrongService=false;
    let editor;
    for(let i=0;i<6;i++){editor=await (await req(cs('__tick'))).json();if(editor.phase==='ready')break;}
    assert.equal(editor.phase,'ready');assert.notEqual(editor.url,ready.url);
    assert.equal((await status()).url,ready.url);
    assert.deepEqual(credentialUploads,[],'apps read the mounted sandbox secret; no credential file is uploaded');
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__code-server'").first();
    assert.equal(row.deployment,'__browser');assert(row.owner_key_hash);assert.equal(row.expires_at,editor.deadline);
    const origin=new URL(editor.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    const headers={Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin','X-Opencode-Directory':'/ignored'};
    assert.equal((await worker.fetch(editor.url,{headers})).status,200);
    // Same-origin app headers pass to every app (preview-wrapper contract §5.2), not per slot.
    assert.equal(lastForwarded['x-opencode-directory'],'/ignored');
    const oldKey=(await db.prepare('SELECT bayleaf_token FROM user_keys WHERE email=?').bind(email).first()).bayleaf_token;
    await db.prepare('UPDATE user_keys SET bayleaf_token=? WHERE email=?').bind('sk-bayleaf-isolation-test',email).run();
    assert.equal((await worker.fetch(editor.url,{headers})).status,200);
    await db.prepare('UPDATE user_keys SET bayleaf_token=? WHERE email=?').bind(oldKey,email).run();
    await req(cs('restart'),{method:'POST'});
    await req('/__test/__expire');
    assert.equal((await status()).phase,'expired');
    assert.equal((await (await req(cs('status'))).json()).phase,'opening');
    assert(await (await req('/__test/__alarm')).json(),'retiring OpenCode Web cannot erase editor setup alarm');
    for(let i=0;i<8;i++){editor=await (await req(cs('__tick'))).json();if(editor.phase==='ready')break;}
    assert.equal(editor.phase,'ready');
    assert.equal((await db.prepare("SELECT count(*) n FROM preview_registrations WHERE slot='__opencode-web'").first()).n,0);
    assert.equal(await (await req('/__test/__alarm')).json(),editor.deadline*1000);
    await action('start');ready=await finish();assert.equal(ready.phase,'ready');
    await req(cs('__expire'));
    assert.equal((await status()).url,ready.url,'editor expiry leaves OpenCode Web link alone');
    assert.equal(await (await req('/__test/__alarm')).json(),ready.deadline*1000);
    await req(cs('start'),{method:'POST'});
    for(let i=0;i<8;i++){editor=await (await req(cs('__tick'))).json();if(editor.phase==='ready')break;}
    assert.equal(editor.phase,'ready');
    state='stopped';
    await action('restart');ready=await finish();assert.equal(ready.phase,'ready');
    const sleepingEditor=await (await req(cs('status'))).json();
    assert.equal(sleepingEditor.phase,'stopped');assert.equal(sleepingEditor.url,undefined,
      'an alarm must not resurrect a sibling ready snapshot retired during wake');
  });
  await check('dufs private setup and restart coexist with both services',async()=>{
    const path=(service,action)=>'/__test/'+action+'?service='+service;
    const complete=async service=>{let op;for(let i=0;i<12;i++){op=await (await req(path(service,'__tick'))).json();if(op.phase==='ready')return op;}throw new Error(JSON.stringify(op));};
    await req(path('code-server','start'),{method:'POST'});const editor=await complete('code-server');
    memory=1;
    await req(path('dufs','start'),{method:'POST'});let files=await complete('dufs');
    memory=4;
    
    assert.equal((await status()).url,ready.url);
    assert.equal((await (await req(path('code-server','status'))).json()).url,editor.url);
    assert.equal(new Set([ready.url,editor.url,files.url]).size,3);
    const before={executions,previewCalls,wakes};
    await req(path('dufs','status'));assert.deepEqual({executions,previewCalls,wakes},before);
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__dufs'").first();
    assert.equal(row.deployment,'__browser');assert.equal(row.access,'private');assert(row.owner_key_hash);
    const origin=new URL(files.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    assert.equal((await worker.fetch(files.url,{headers:{'X-Test-Origin':origin}})).status,401);
    assert.equal((await worker.fetch(files.url,{headers:{Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin','X-Opencode-Directory':'/ignored'}})).status,200);
    // Same-origin app headers pass to every app (preview-wrapper contract §5.2), not per slot.
    assert.equal(lastForwarded['x-opencode-directory'],'/ignored');
    assert.equal((await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-rotated','Content-Type':'application/json'},body:JSON.stringify({port:8790,access:'public'})})).status,400);
    const old=files.url;
    await req(path('dufs','restart'),{method:'POST'});files=await complete('dufs');
    assert.notEqual(files.url,old);
    assert.equal((await status()).url,ready.url);
    assert.equal((await (await req(path('code-server','status'))).json()).url,editor.url);
    await req(path('dufs','__expire'));await req(path('code-server','__expire'));
  });
  for(const retired of ['openchamber','nanobot','collabmd']) await check(`retired ${retired} cannot start and legacy managed previews fail closed`,async()=>{
    const before={executions,launches,previewCalls,wakes};
    for(const name of ['start','restart','stop'])
      assert.equal((await req('/__test/'+name+'?service='+retired,{method:'POST'})).status,400);
    assert.equal((await req('/__test/status?service='+retired)).status,400);
    assert.deepEqual({executions,launches,previewCalls,wakes},before);
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__opencode-web'").first();
    const legacy={...row,hostname:'retired-private-fixture.previews.example.test',slot:retired==='openchamber'?'__browser':'__'+retired};
    const columns=Object.keys(legacy);
    await db.prepare(`INSERT INTO preview_registrations (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).bind(...Object.values(legacy)).run();
    const origin='https://'+legacy.hostname;
    const session=jwt({aud:origin,generation:legacy.generation,exp:legacy.expires_at},previewSecret);
    const forwarded=lastForwarded;
    for(const access of ['private','public']) {
      await db.prepare('UPDATE preview_registrations SET access=? WHERE hostname=?').bind(access,legacy.hostname).run();
      assert.equal((await worker.fetch(origin+'/',{headers:{Cookie:'__Host-bl-preview-session='+session,
        'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin'}})).status,404);
    }
    assert.equal(lastForwarded,forwarded,'retired slot must never reach the application');
    await db.prepare('DELETE FROM preview_registrations WHERE hostname=?').bind(legacy.hostname).run();
  });
  await check('a legacy unnamed OpenChamber controller record is never read, advanced or reported',async()=>{
    const sibling=await status(), record=await (await req('/__test/__record')).json();
    const written=await (await req('/__test/__legacy-operation',{method:'POST'})).json();
    const before={executions,launches,previewCalls,wakes};
    await req('/__test/__alarm-now');
    assert.deepEqual({executions,launches,previewCalls,wakes},before,'a due legacy record must not drive setup');
    assert.deepEqual(await (await req('/__test/__legacy-record')).json(),written);
    assert.deepEqual(await (await req('/__test/__record')).json(),record);
    assert.equal((await status()).url,sibling.url);
    // Left in place: later checks prove sibling lifecycles keep ignoring it.
  });
  await check('Jupyter keeps native token behind owner/origin gates on HTTP and WS through its relay, and coexists',async()=>{
    const jp=action=>'/__test/'+action+'?service=jupyter';
    const sibling=(await status()).url;
    const complete=async()=>{let op;for(let i=0;i<12;i++){op=await(await req(jp('__tick'))).json();if(op.phase==='ready')return op;}throw new Error('Jupyter failed: '+JSON.stringify(op));};
    await req(jp('start'),{method:'POST'});let op=await complete();
    assert.equal((await status()).url,sibling);
    assert(!JSON.stringify(op).includes(jupyterAuth));
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__jupyter'").first();
    assert.equal(row.access,'private');assert(!JSON.stringify(row).includes(jupyterAuth));
    const registeredUrl=op.url, calls=previewCalls;
    await req(jp('__registration-crash'));
    op=await complete();
    assert.equal(op.url,registeredUrl,'registration retry reuses the existing hostname');
    assert.equal(previewCalls,calls,'registration retry never requests a new signed URL');
    const reconciled=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__jupyter'").first();
    assert.equal(reconciled.generation,row.generation,'registration retry preserves the generation');
    assert.equal((await status()).url,sibling);
    const origin=new URL(op.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    const headers={Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin'};
    assert.equal((await worker.fetch(op.url+'api/status',{headers:{'X-Test-Origin':origin,Authorization:'token '+jupyterAuth}})).status,401);
    assert.equal((await worker.fetch(op.url+'api/status',{headers:{...headers,Authorization:'spoofed'}})).status,200);
    assert.equal(signedPorts.at(-1),8783,'signed preview targets the relay, not the app port');
    assert.equal(lastForwarded['x-bayleaf-app-authorization'],'token '+jupyterAuth);
    assert.equal(lastForwarded.authorization,undefined,'a non-Bearer browser Authorization is dropped');
    const previous=lastForwarded;
    assert.equal((await worker.fetch(op.url+'api/kernels',{method:'POST',headers:{...headers,'X-Test-Origin':'https://evil.test'},body:'{}'})).status,403);
    assert.equal(lastForwarded,previous,'denied mutation never receives app token');
    assert.equal((await worker.fetch(op.url+'api/kernels/fixture/channels',{headers:{Upgrade:'websocket','X-Test-Origin':origin}})).status,401);
    assert.equal((await worker.fetch(op.url+'api/kernels/fixture/channels',{headers:{...headers,Upgrade:'websocket','X-Test-Origin':'https://evil.test'}})).status,403);
    const socket=await worker.fetch(op.url+'api/kernels/fixture/channels',{headers:{...headers,Upgrade:'websocket',Authorization:'spoofed'}});
    assert.equal(socket.status,101);socket.webSocket.accept();assert.equal(lastForwarded['x-bayleaf-app-authorization'],'token '+jupyterAuth);
    const echoed=new Promise(resolve=>socket.webSocket.addEventListener('message',event=>resolve(event.data),{once:true}));
    socket.webSocket.send('synthetic kernel message');assert.equal(await echoed,'synthetic kernel message');socket.webSocket.close();
    const old=op.url;await req(jp('restart'),{method:'POST'});op=await complete();assert.notEqual(op.url,old);
    assert.equal((await status()).url,sibling);
    await req(jp('__expire'));assert.equal((await(await req(jp('status'))).json()).url,undefined);
  });
  await check('ttyd private HTTP/WS reach its app-auth relay only after owner/origin gates; independent restart',async()=>{
    assert.equal((await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-rotated','Content-Type':'application/json'},body:JSON.stringify({port:8794,access:'public'})})).status,400);
    const tt=action=>'/__test/'+action+'?service=ttyd';
    const sibling=(await status()).url;
    const complete=async()=>{for(let i=0;i<12;i++){const op=await(await req(tt('__tick'))).json();if(op.phase==='ready')return op;}throw new Error('ttyd failed');};
    await req(tt('start'),{method:'POST'});let op=await complete();
    assert.equal((await status()).url,sibling);
    assert(!JSON.stringify(op).includes(ttydAuth));assert.notEqual(ttydAuth,jupyterAuth);
    assert.equal(signedPorts.at(-1),8784,'signed preview targets the relay, not the app port');
    assert.equal(incomingOperation.app_auth_relay_port,8784);
    const ttydRoot='/home/daytona/.local/share/bayleaf/ttyd';
    assert.equal(uploads.get(ttydRoot+'/app-auth-relay.py'),await readFile(root+'scripts/app-auth-relay.py','utf8'));
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__ttyd'").first();
    assert.equal(row.access,'private');assert(!JSON.stringify(row).includes(ttydAuth));
    const origin=new URL(op.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    const headers={Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin'};
    const basic='Basic '+Buffer.from('bayleaf:'+ttydAuth).toString('base64');
    assert.equal((await worker.fetch(op.url+'token',{headers:{'X-Test-Origin':origin,Authorization:basic}})).status,401);
    assert.equal((await worker.fetch(op.url+'token',{headers:{...headers,Authorization:'Bearer spoofed',
      'X-BayLeaf-App-Authorization':'Basic spoofed'}})).status,200);
    assert.equal(new URL(lastForwardedUrl).hostname.split('-')[0],'8784');
    assert.equal(lastForwarded['x-bayleaf-app-authorization'],basic);
    assert.equal(lastForwarded.authorization,'Bearer spoofed','browser Bearer is untouched; Daytona v2 strips it');
    const previous=lastForwarded;
    assert.equal((await worker.fetch(op.url+'ws',{headers:{Upgrade:'websocket','X-Test-Origin':origin,Authorization:basic}})).status,401);
    assert.equal((await worker.fetch(op.url+'ws',{headers:{...headers,Upgrade:'websocket','X-Test-Origin':'https://evil.test'}})).status,403);
    assert.equal(lastForwarded,previous);
    const socket=await worker.fetch(op.url+'ws',{headers:{...headers,Upgrade:'websocket',Authorization:'spoofed'}});
    assert.equal(socket.status,101);socket.webSocket.accept();assert.equal(lastForwarded['x-bayleaf-app-authorization'],basic);socket.webSocket.close();
    const old=op.url;await req(tt('restart'),{method:'POST'});op=await complete();assert.notEqual(op.url,old);
    assert.equal((await status()).url,sibling);
    await req(tt('__expire'));assert.equal((await(await req(tt('status'))).json()).url,undefined);
  });
   await check('OpenCode Web configures the private origin before readiness and gates terminal traffic',async()=>{
     const path=action=>'/__test/'+action+'?service=opencode-web';
     // The primary link from earlier checks is retired so this setup starts fresh,
     // beside a ready editor sibling.
     const cs=action=>'/__test/'+action+'?service=code-server';
     await req(path('__expire'));
     await req(cs('start'),{method:'POST'});
     let editor;
     for(let i=0;i<12;i++){editor=await(await req(cs('__tick'))).json();if(editor.phase==='ready')break;}
     assert.equal(editor.phase,'ready');
     const sibling=editor.url;
     const status=async()=>(await req(cs('status'))).json();
     assert.equal((await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-rotated',
       'Content-Type':'application/json'},body:JSON.stringify({port:8795,access:'public'})})).status,400);
     await req(path('start'),{method:'POST'});
     let op;
     for(let i=0;i<14;i++){op=await(await req(path('__tick'))).json();if(op.url)break;}
     assert.equal(op.step,'prepare');
     assert.equal(op.phase,'opening');
     assert.equal((await (await req(path('status'))).json()).url,undefined);
     const pendingUrl=op.url, calls=previewCalls;
     await req(path('__registration-crash'));
     for(let i=0;i<14;i++){op=await(await req(path('__tick'))).json();if(op.phase==='ready')break;}
     assert.equal(op.url,pendingUrl,'registration replay reuses the exact origin');
     assert.equal(previewCalls,calls);
     assert.equal(op.phase,'ready');assert.equal((await status()).url,sibling);
     const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__opencode-web'").first();
     assert.equal(row.access,'private');
     assert.match(opencodeAuth,/^[a-f0-9]{64}$/);
     assert(!JSON.stringify([row,op]).includes(opencodeAuth));
     const origin=new URL(op.url).origin;
     const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
     const cookie={'Cookie':'__Host-bl-preview-session='+session,'Sec-Fetch-Site':'same-origin'};
     const post=headers=>worker.fetch(op.url+'api/session',{method:'POST',headers,body:'{}'});
     const previous=lastForwarded;
     assert.equal((await post({'X-Test-Origin':origin})).status,401);
     assert.equal((await post({...cookie,'X-Test-Origin':'https://evil.test'})).status,403);
     assert.equal(lastForwarded,previous);
     assert.equal((await post({...cookie,'X-Test-Origin':origin,Authorization:'Bearer spoofed'})).status,200);
     assert.equal(lastForwarded['x-bayleaf-app-authorization'],'Basic '+Buffer.from('opencode:'+opencodeAuth).toString('base64'));
     assert.equal(lastForwarded.cookie,undefined,'no browser cookie required by the upstream');
     const terminal=headers=>worker.fetch(op.url+'api/pty/fixture/connect',{headers:{...headers,Upgrade:'websocket'}});
     assert.equal((await terminal({'X-Test-Origin':origin})).status,401);
     assert.equal((await terminal({...cookie,'X-Test-Origin':'https://evil.test'})).status,403);
     const socket=await terminal({...cookie,'X-Test-Origin':origin});
     assert.equal(socket.status,101);socket.webSocket.accept();
     assert.equal(lastForwarded.origin,origin);
     assert.equal(lastForwarded['x-bayleaf-app-authorization'],'Basic '+Buffer.from('opencode:'+opencodeAuth).toString('base64'));
     socket.webSocket.close();
     const firstAuth=opencodeAuth, firstUrl=op.url;
     await req(path('__expire'));
     assert.equal((await (await req(path('status'))).json()).url,undefined);
     await req(path('start'),{method:'POST'});
     for(let i=0;i<14;i++){op=await(await req(path('__tick'))).json();if(op.phase==='ready')break;}
     assert.equal(op.phase,'ready');
     assert.notEqual(op.url,firstUrl,'relink creates a fresh origin');
     assert.equal(opencodeAuth,firstAuth,'relink keeps the app password');
     assert.equal(incomingOperation.preview_origin,new URL(op.url).origin,'relink configures only its replacement origin');
     const fresh=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__opencode-web'").first();
     const freshOrigin=new URL(op.url).origin;
     const freshSession=jwt({aud:freshOrigin,generation:fresh.generation,exp:fresh.expires_at},previewSecret);
     assert.equal((await worker.fetch(op.url+'api/session',{method:'POST',body:'{}',headers:{
       Cookie:'__Host-bl-preview-session='+freshSession,'Sec-Fetch-Site':'same-origin','X-Test-Origin':freshOrigin,
     }})).status,200);
     assert.equal(lastForwarded['x-bayleaf-app-authorization'],'Basic '+Buffer.from('opencode:'+firstAuth).toString('base64'));
     await req(path('__expire'));
     assert.equal((await status()).url,sibling);
     wrongOpencodeOrigin=true;
     try {
       await req(path('start'),{method:'POST'});
       for(let i=0;i<14;i++){op=await(await req(path('__tick'))).json();if(op.phase==='failed')break;}
       assert.equal(op.phase,'failed');
       assert.equal(op.error,'preview_unavailable');
       assert.equal(await db.prepare("SELECT hostname FROM preview_registrations WHERE slot='__opencode-web'").first(),null);
     } finally { wrongOpencodeOrigin=false; }
     // Restore the primary link that later sibling checks rely on.
     await req(cs('__expire'));
     await action('start');ready=await finish();assert.equal(ready.phase,'ready');
   });
   await check('Jupyter owner stop closes sockets, revokes access, and preserves siblings',async()=>{
    const jp=action=>'/__test/'+action+'?service=jupyter';
    const complete=async()=>{for(let i=0;i<14;i++){const op=await(await req(jp('__tick'))).json();if(op.phase==='ready')return op;}throw new Error('Jupyter failed');};
    const sibling=(await status()).url;
    assert.equal((await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-rotated',
      'Content-Type':'application/json'},body:JSON.stringify({port:8793,access:'public'})})).status,400);
    await req(jp('start'),{method:'POST'});
    let op=await complete();const old=op.url, token=jupyterAuth;
    assert(!JSON.stringify(op).includes(token),'no app secret in DO metadata');
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__jupyter'").first();
    assert.equal(row.access,'private');assert(row.owner_key_hash);
    assert.equal((await worker.fetch(op.url)).status,401);
    const origin=new URL(op.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    const headers={Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin'};
    const socket=await worker.fetch(op.url+'api/kernels/fixture/channels',{headers:{...headers,Upgrade:'websocket'}});
    assert.equal(socket.status,101);socket.webSocket.accept();
    assert.equal(lastForwarded['x-bayleaf-app-authorization'],'token '+token);
    const closed=new Promise(resolve=>socket.webSocket.addEventListener('close',resolve,{once:true}));
    const stopped=await req(jp('stop'),{method:'POST'});assert.equal(stopped.status,200);
    const result=await stopped.json();assert.equal(result.access_revoked,true);assert.equal(result.cleanup_pending,false);
    await closed;
    assert.equal((await worker.fetch(old)).status,404);assert.equal((await status()).url,sibling);
    assert.equal((await(await req(jp('status'))).json()).url,undefined);
    const before=stops;await req(jp('stop'),{method:'POST'});assert.equal(stops,before,'stop is idempotent');
    await req(jp('start'),{method:'POST'});op=await complete();
    assert.notEqual(op.url,old);assert.notEqual(jupyterAuth,token);
    const credential=(await db.prepare("SELECT owner_key_hash FROM preview_registrations WHERE slot='__jupyter'").first()).owner_key_hash;
    await db.prepare("UPDATE sandbox_credentials SET state='revoked' WHERE id=?").bind(credential).run();
    assert.equal((await worker.fetch(op.url)).status,404,'access depends on active owner sandbox authority');
    await db.prepare("UPDATE sandbox_credentials SET state='active' WHERE id=?").bind(credential).run();
    // A public row cannot turn an existing private service public.
    const siblingHost=new URL(sibling).hostname;
    await db.prepare("UPDATE preview_registrations SET access='public' WHERE hostname=?").bind(siblingHost).run();
    assert.equal((await worker.fetch(sibling)).status,404);
    await db.prepare("UPDATE preview_registrations SET access='private' WHERE hostname=?").bind(siblingHost).run();
    await req(jp('stop'),{method:'POST'});
  });
  await check('stop during setup cannot register later; Start waits for partial cleanup and sleeping stop never wakes',async()=>{
    const cm=action=>'/__test/'+action+'?service=jupyter';
    const registered=async()=>(await db.prepare("SELECT count(*) n FROM preview_registrations WHERE slot='__jupyter'").first()).n;
    await req(cm('start'),{method:'POST'});
    for(let i=0;i<4;i++)await req(cm('__tick'));
    stopFails=true;
    const partial=await req(cm('stop'),{method:'POST'});assert.equal(partial.status,202);
    const body=await partial.json();assert.equal(body.access_revoked,true);assert.equal(body.cleanup_pending,true);
    const relaunch=await req(cm('start'),{method:'POST'});assert.equal(relaunch.status,202);
    const {operation}=await relaunch.json();
    const probes=executions;await req(cm('status'));assert.equal(executions,probes,'status remains passive');
    const pending=await(await req(cm('__tick'))).json();
    assert.equal(pending.phase,'stopped');assert.equal(pending.cleanupPending,true,'failed cleanup holds the relaunch');
    assert.equal(pending.operation,operation);assert.equal(await registered(),0);
    stopFails=false;
    const relaunched=await(await req(cm('__tick'))).json();
    assert.equal(relaunched.phase,'opening');assert.notEqual(relaunched.operation,operation,'only finished cleanup launches anew');
    assert.equal(await registered(),0);
    await req(cm('__tick'));
    state='stopped';const before={executions,wakes};
    assert.equal((await req(cm('stop'),{method:'POST'})).status,200);
    assert.deepEqual({executions,wakes},before);state='started';
  });
  await check('Desktop uses Daytona computer use, never installs or creates, lands on noVNC; stop revokes first and never wakes',async()=>{
    const dt=action=>'/__test/'+action+'?service=desktop';
    const complete=async()=>{let op;for(let i=0;i<12;i++){op=await(await req(dt('__tick'))).json();if(op.phase!=='opening')return op;}throw new Error(JSON.stringify(op));};
    const sibling=(await status()).url, before={launches,creates,creationRequests,uploads:credentialUploads.length,stops};
    computerUse=[];
    await req(dt('start'),{method:'POST'});let op=await complete();
    assert.equal(op.phase,'ready');assert.deepEqual(computerUse,['POST start','GET status']);
    assert.deepEqual({launches,creates,creationRequests,uploads:credentialUploads.length,stops},before,'no installer, creation or credential upload');
    assert.equal(new URL(op.url).pathname+new URL(op.url).search,'/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=websockify');
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__desktop'").first();
    assert.equal(row.access,'private');assert.equal(new URL(op.url).hostname,row.hostname);
    const passive={executions,calls:computerUse.length,wakes};
    const view=await(await req(dt('status'))).json();assert.equal(view.url,op.url);
    assert.deepEqual({executions,calls:computerUse.length,wakes},passive,'status never calls Toolbox');
    assert.equal((await worker.fetch(op.url)).status,401,'private: anonymous requests are denied');
    assert.equal((await status()).url,sibling);
    // Restart is a clean session: stop and confirm inactive, then start.
    computerUse=[];
    await req(dt('restart'),{method:'POST'});op=await complete();
    assert.equal(op.phase,'ready');assert.deepEqual(computerUse,['POST stop','GET status','POST start','GET status']);
    assert.equal(registeredAtDesktopStop,0,'restart revoked the old link before stopping');
    computerUse=[];
    const stopped=await req(dt('stop'),{method:'POST'});assert.equal(stopped.status,200);
    const result=await stopped.json();
    assert.equal(result.access_revoked,true);assert.equal(result.cleanup_pending,false);assert.equal(result.processes_reaped,0);
    assert.equal(registeredAtDesktopStop,0,'access is revoked before compute is touched');
    assert.deepEqual(computerUse,['POST stop','GET status']);assert.equal(desktopUp,false);
    // A stack that never reports active fails boundedly.
    desktopStartFails=true;await req(dt('start'),{method:'POST'});op=await complete();
    assert.equal(op.error,'desktop_not_ready');assert.equal(computerUse.filter(c=>c==='POST start').length,3);
    desktopStartFails=false;
    // A sleeping machine is never woken to stop the desktop.
    await req(dt('start'),{method:'POST'});op=await complete();assert.equal(op.phase,'ready');
    state='stopped';const asleep={executions,wakes,calls:computerUse.length};
    assert.equal((await req(dt('stop'),{method:'POST'})).status,200);
    assert.deepEqual({executions,wakes,calls:computerUse.length},asleep);state='started';
    // Desktop never creates a machine.
    exists=false;const requests=creationRequests;
    await req(dt('start'),{method:'POST'});op=await complete();
    assert.equal(op.error,'sandbox_missing');assert.equal(creationRequests,requests);exists=true;
  });
  await check('central scheduler honors backoff, ready timestamps, and setup deadlines with a fake clock',async()=>{
    const cs=path=>'/__test/'+path+'?service=code-server';
    const beforeReady=await (await req('/__test/__record')).json();
    await req(cs('start'),{method:'POST'});
    await req(cs('__tick'));
    const afterReady=await (await req('/__test/__record')).json();
    assert.deepEqual(afterReady,beforeReady,'sibling setup must not rewrite ready metadata');
    const delayed=await (await req(cs('__delay'))).json();
    assert.equal(await (await req('/__test/__alarm')).json(),delayed.setupDeadline*1000);
    const before=executions;
    testNow+=1000;
    assert.deepEqual(await (await req(cs('__alarm-now'))).json(),delayed,'early alarm must leave setup untouched');
    const failed=await (await req(cs('__tick'))).json();
    assert.equal(failed.error,'setup_timeout');assert.equal(executions,before);
    const retry=await (await req(cs('__retry'))).json();
    // An independently due ready link is processed without advancing this retry.
    await req('/__test/__expire');
    assert.deepEqual(await (await req(cs('__record'))).json(),retry);
    assert.equal(await (await req('/__test/__alarm')).json(),retry.nextAt);
    testNow=retry.nextAt-1;
    assert.deepEqual(await (await req(cs('__alarm-now'))).json(),retry);
    assert.equal((await (await req(cs('__tick'))).json()).invalidated,true);
  });
  await check('failed or lost creation fails visibly and a retry replays the same idempotency key',async()=>{
    for(const outcome of ['503','transport']) {
      exists=false;failCreate=outcome==='503';createKeys=[];
      const before={creates,creationRequests};
      await primary('restart',{method:'POST',headers:outcome==='transport'?{'X-Test-Create-Transport':'1'}:{}});
      assert.equal((await tick()).error,'creation_failed');
      failCreate=false;
      await action('start');ready=await finish();assert.equal(ready.phase,'ready');
      assert.equal(creates,before.creates+1,'exactly one machine is created');
      assert.equal(createKeys.length,outcome==='transport'?1:2);
      assert.equal(new Set(createKeys).size,1,'retries reuse the owner-scoped idempotency key');
    }
  });
  {
    machineId = 'sbx_browser-fixture'; state = 'started'; exists = true;
    await db.prepare('UPDATE user_keys SET daytona_sandbox_id=? WHERE email=?').bind(machineId, email).run();
    const desktop = (name, method = 'GET') => req(`/__test/${name}?service=desktop`, { method });
    const complete = async () => {
      for (let i = 0; i < 12; i++) {
        await desktop('__tick');
        const status = await (await desktop('status')).json();
        if (status.phase !== 'opening') {
          assert.equal(status.phase, 'ready', JSON.stringify(status));
          return status;
        }
      }
      assert.fail('Desktop lifecycle did not complete');
    };
    let ready;
    const previewBase = previewCalls;
    await check('Start verifies boot generation, keeping the lease after pause', async () => {
      assert.equal((await desktop('start', 'POST')).status, 202);
      ready = await complete();
      state = 'paused';
      const before = { executions, wakes };
      assert.equal((await (await desktop('status')).json()).url, undefined);
      assert.deepEqual({ executions, wakes }, before, 'GET never probes or wakes');
      assert.equal((await desktop('start', 'POST')).status, 202);
      const resumed = await complete();
      assert.equal(wakes, before.wakes + 1);
      assert.equal(resumed.url, ready.url);
      assert.equal(resumed.operation, ready.operation);
      assert.equal(previewCalls, previewBase + 1);
    });
    await check('Start replaces a stale lease after a same-ID full reboot', async () => {
      bootId = '88888888-9999-4aaa-8bbb-cccccccccccc'; desktopUp = false;
      const before = executions;
      await desktop('status'); assert.equal(executions, before, 'GET never probes boot generation');
      assert.equal((await desktop('start', 'POST')).status, 202);
      const relaunched = await complete();
      assert.notEqual(relaunched.operation, ready.operation);
      assert.notEqual(relaunched.url, ready.url);
      assert.equal(previewCalls, previewBase + 2);
      ready = relaunched;
    });
    await check('Stop never resumes, and explicit Start or Restart finishes old cleanup before launching', async () => {
      for (const action of ['start', 'restart']) {
        state = 'paused'; computerUse = [];
        const before = wakes;
        const stopped = await desktop('stop', 'POST');
        assert.equal(stopped.status, 202);
        assert.deepEqual(await stopped.json(), { phase: 'stopped', access_revoked: true, cleanup_pending: true });
        await desktop('__tick');
        assert.equal(wakes, before);
        assert.deepEqual(computerUse, []);
        assert.equal((await desktop(action, 'POST')).status, 202);
        const reopened = await complete();
        assert.equal(wakes, before + 1);
        assert.equal(registeredAtDesktopStop, 0);
        assert.deepEqual(computerUse, ['POST stop', 'GET status', 'POST start', 'GET status']);
        assert.notEqual(reopened.url, ready.url);
        ready = reopened;
      }
    });
    await check('Stop can cancel an explicit launch before deferred cleanup wakes the machine', async () => {
      state = 'paused'; computerUse = [];
      const before = wakes;
      await desktop('stop', 'POST');
      assert.equal((await desktop('start', 'POST')).status, 202);
      assert.equal((await desktop('stop', 'POST')).status, 202);
      await desktop('__tick');
      assert.equal(wakes, before);
      assert.deepEqual(computerUse, []);
    });
  }
  console.log(checks+' lifecycle checks passed (synthetic provider; no live deployment).');
} finally {await mf.dispose();}
