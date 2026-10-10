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
    if(rejectCreateTransport && typeof input==='string' && input==='https://daytona.example.test/api/sandbox' && init?.method==='POST') {
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
      const service=new URL(req.url).searchParams.get('service')||'openchamber';
      const key=service==='openchamber'?'operation':'operation/'+service;
       if(path==='/__record')return Response.json(await this.testStorage.get(key));
       if(path==='/__registration-crash') {
         const op=await this.testStorage.get(key);op.step='register';delete op.url;
         await this.testStorage.put(key,op);return Response.json(op);
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

let state = 'archived', lookupFails = false, exists = true, interrupted = false, memory = 4, isPublic = false;
let creates = 0, wakes = 0, executions = 0, launches = 0, previewCalls = 0;
let incomingOperation, lastForwarded, toolboxFailures = 0, machineId = 'synthetic-sandbox', wrongService = false;
const credentialsUploaded=[];
let failCreate=false, creationRequests=0, rejectCreate=0;
let nanobotAuth, jupyterAuth, ttydAuth, nanobotReady=true, nanobotWrongOrigin=false;
const machine = () => ({ id: machineId, state, memory, public: isPublic, labels: { 'synthetic-chat': email } });
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
    PREVIEWS_UPSTREAM_SUFFIXES: '.preview.example.test', ALLOWED_EMAIL_DOMAIN: 'example.test',
    OIDC_CLIENT_SECRET: secret, DAYTONA_API_URL: 'https://daytona.example.test/api',
    SEALED_ENABLED:'true',SEALED_RPD_LIMIT:'500',
    RECOMMENDED_MODEL:'synthetic/model',OPENCODE_CURATED_MODELS:'synthetic/model',
    DAYTONA_PROXY_URL: 'https://toolbox.example.test', DAYTONA_API_KEY: 'synthetic-daytona-key',
    DAYTONA_DEPLOYMENT_LABEL: 'synthetic-chat', DAYTONA_AUTO_DELETE_MINUTES: '-1',
  },
  outboundService: async req => {
    const u = new URL(req.url);
    if (u.hostname==='openrouter.ai') return Response.json({data:u.pathname.endsWith('/models')?
      [{id:'synthetic/model',name:'Synthetic model',pricing:{prompt:'0.000001',completion:'0.000002'}}]:
      {limit:5,limit_remaining:3.75,limit_reset:'daily',usage:30,usage_daily:1.25}});
    if (u.hostname === 'daytona.example.test') {
      if (machineId !== 'synthetic-sandbox' && u.pathname === '/api/sandbox/synthetic-sandbox') return new Response('',{status:404});
      if (u.pathname === '/api/sandbox' && req.method === 'GET') {
        if (lookupFails) return new Response('outage', { status: 503 });
        return Response.json({ items: exists ? [machine()] : [] });
      }
      if (u.pathname === '/api/sandbox' && req.method === 'POST') {
        creationRequests++;
        if(rejectCreate)return new Response('rejected',{status:rejectCreate});
        if(failCreate)return new Response('ambiguous provider failure',{status:503});
        const body = await req.json();
        assert.equal(body.snapshot, 'daytona-medium');assert.equal(body.public, false);
        assert.equal(body.autoStopInterval,60);assert.equal(body.autoArchiveInterval,1440);
        assert.equal(body.autoDeleteInterval,-1);
        creates++; exists = true; state = 'started'; return Response.json(machine());
      }
      if (u.pathname.endsWith('/start')) { wakes++; state = 'started'; return Response.json({}); }
      if (u.pathname.endsWith('/signed-preview-url')) {
        assert(Number(u.searchParams.get('expiresInSeconds')) <= 86400);
        previewCalls++; return Response.json({ url: 'https://3100-synthetic.preview.example.test/' });
      }
      return exists ? Response.json(machine()) : new Response('', { status: 404 });
    }
    if (u.hostname === 'toolbox.example.test') {
      if (toolboxFailures > 0) { toolboxFailures--; return new Response('not ready', {status:503}); }
      if (u.pathname.endsWith('/files/upload')) {
        const form = await req.formData(); const text = await form.get('file').text();
        if (u.searchParams.get('path').endsWith('request.next.json')) {
          incomingOperation = JSON.parse(text);
          assert(incomingOperation.deadline<=Math.floor(Date.now()/1000)+20*60);
        }
        if (u.searchParams.get('path').endsWith('credentials/incoming')) {
          assert(text.startsWith('sk-bayleaf-')); credentialsUploaded.push(u.searchParams.get('path'));
        }
        if (u.searchParams.get('path').endsWith('credentials/app-secret')) {
          assert.match(text,/^[a-f0-9]{64}$/);
          if(u.searchParams.get('path').includes('/ttyd/'))ttydAuth=text;
          else if(u.searchParams.get('path').includes('/jupyter/'))jupyterAuth=text;else nanobotAuth=text;
        }
        return Response.json({});
      }
      executions++;
      const { command } = await req.json();
      assert(!command.includes('sk-bayleaf-'), 'credential in command');
      if(nanobotAuth)assert(!command.includes(nanobotAuth),'app secret in command');
      if(jupyterAuth)assert(!command.includes(jupyterAuth),'Jupyter secret in command');
      if(ttydAuth)assert(!command.includes(ttydAuth),'ttyd secret in command');
      if (command.includes('subprocess.Popen')) launches++;
      if (command.endsWith('setup.py inspect')) return Response.json({ exitCode: 0, result: JSON.stringify({
        schema: 1, operation: interrupted ? 'stale' : incomingOperation.operation,
        updated_at: Math.floor(Date.now()/1000), phase: 'ready', ready: true, port: 3100,
        timeline:[{step:'loading_tools',at:Math.floor(Date.now()/1000)},
          {step:'credential-leak',at:Math.floor(Date.now()/1000),error:'secret'},
          {step:'connecting_bayleaf',at:9999999999999}],
      }) });
      const appService = ['code-server','dufs','nanobot','jupyter','ttyd'].find(id=>command.endsWith('--service '+id+' inspect'));
      if (appService) return Response.json({exitCode:0,result:JSON.stringify({
        schema:1,service:wrongService?'openchamber':appService,operation:incomingOperation.operation,
        updated_at:Math.floor(Date.now()/1000),phase:'ready',ready:appService==='nanobot'?nanobotReady:true,
        port:appService==='dufs'?8790:appService==='nanobot'?8792:appService==='jupyter'?8793:appService==='ttyd'?8794:8791,
        ...(appService==='nanobot'?{preview_url:nanobotWrongOrigin?'https://wrong.invalid/':incomingOperation.preview_url}:{}),
        timeline:[{step:appService==='dufs'?'installing_dufs':'installing_code_server',at:Math.floor(Date.now()/1000)}],
      })});
      return Response.json({ exitCode: 0, result: '' });
    }
    if (u.hostname.endsWith('.preview.example.test')) {
      lastForwarded = Object.fromEntries(req.headers);
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
const action = name => req('/sandbox/browser/'+name,{method:'POST'});
const status = async () => (await req('/sandbox/browser/status')).json();
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

  await check('anonymous, CSRF, Campus Pass, bad keys and disabled feature fail closed',async()=>{
    assert.equal((await req('/sandbox/browser/start',{method:'POST',owner:false})).status,401);
    assert.equal((await req('/sandbox/browser/start',{method:'POST',origin:false})).status,403);
    assert.equal((await req('/sandbox/browser/start',{method:'POST',headers:{Authorization:'Bearer invalid'}})).status,401);
    assert.equal((await req('/sandbox/browser/status',{headers:{'X-Test-Disabled':'1'}})).status,503);
    assert.equal(creates+wakes+executions,0);
  });
  await check('passive dashboard/status probes never wake or contact Toolbox',async()=>{
    for(let i=0;i<4;i++) assert.equal((await status()).machine,'archived');
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
  await check('concurrent starts converge; archived setup completes through persisted phases',async()=>{
    const results=await Promise.all(Array.from({length:8},async()=> (await action('start')).json()));
    assert.equal(new Set(results.map(x=>x.operation)).size,1);
    ready=await finish(); assert.equal(ready.phase,'ready');
    assert(ready.deadline>Math.floor(Date.now()/1000)+23*3600);
    assert(ready.deadline<=Math.floor(Date.now()/1000)+24*3600);
    assert.equal(wakes,1);assert.equal(launches,1);assert.equal(creates,0);
    assert.match(ready.url,/owner-private-[a-f0-9]{24}/);
  });
  await check('ready reopen preserves deadline and origin; status stays passive',async()=>{
    const before=executions;
    for(let i=0;i<3;i++) {
      const result=await (await action('start')).json();
      assert.equal(result.url,ready.url);assert.equal(result.deadline,ready.deadline);
      await status();
    }
    assert.equal(executions,before);assert.equal(previewCalls,1);
  });
  await check('another owner has independent lifecycle state; session actions no longer exist',async()=>{
    const headers={Authorization:'Bearer sk-bayleaf-other'};
    const other=await (await req('/sandbox/browser/status',{owner:false,headers})).json();
    assert.equal(other.phase,'idle');assert.equal(other.url,undefined);
    for (const name of ['stop','continue']) {
      assert.equal((await req('/sandbox/browser/'+name,{method:'POST',owner:false,headers})).status,404);
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
  await check('public iframe navigation permits only the active owner browser in CSP, without widening fetch or POST',async()=>{
    const exposed=await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-owner','Content-Type':'application/json'},body:JSON.stringify({port:8000,access:'public'})});
    assert.equal(exposed.status,200);const url=(await exposed.json()).url;
    const headers={'X-Test-Mode':'navigate','Sec-Fetch-Dest':'iframe','Sec-Fetch-Site':'same-site'};
    const framed=await worker.fetch(url,{headers});assert.equal(framed.status,200);
    assert.equal(framed.headers.get('X-Frame-Options'),null);
    assert.equal(framed.headers.get('Content-Security-Policy').split(';')[0],"frame-ancestors 'self' "+new URL(ready.url).origin);
    assert.equal((await worker.fetch(url,{headers:{'Sec-Fetch-Site':'same-site','X-Test-Mode':'cors'}})).status,403);
    assert.equal((await worker.fetch(url,{method:'POST',headers})).status,403);
    const hostname=new URL(ready.url).hostname;
    await db.prepare('UPDATE preview_registrations SET expires_at=0 WHERE hostname=?').bind(hostname).run();
    const retired=await worker.fetch(url,{headers});
    assert.equal(retired.headers.get('Content-Security-Policy').split(';')[0],"frame-ancestors 'self'");
    assert.equal(retired.headers.get('X-Frame-Options'),'SAMEORIGIN');
    await db.prepare('UPDATE preview_registrations SET expires_at=? WHERE hostname=?').bind(ready.deadline,hostname).run();
    await worker.fetch(api+'/sandbox/expose/8000',{method:'DELETE',headers:{Authorization:'Bearer sk-bayleaf-owner'}});
  });
  await check('managed gateway forwards project context and binds current owner key',async()=>{
    const row=await db.prepare('SELECT * FROM preview_registrations WHERE deployment=?').bind('__browser').first();
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
    assert.equal((await worker.fetch(ready.url,{headers})).status,404);
    assert.equal((await status()).error,'credential_changed');
  });
  await check('explicit restart refreshes rotated credentials and gets a fresh origin',async()=>{
    await action('restart'); const next=await finish(); assert.equal(next.phase,'ready');
    assert.notEqual(next.url,ready.url); ready=next;
  });
  await check('interrupted setup retries boundedly, then fails with recoverable diagnostics',async()=>{
    interrupted=true;await action('restart');const next=await finish();
    assert.equal(next.phase,'failed');assert.equal(next.error,'setup_interrupted');
    interrupted=false;await action('start');ready=await finish();assert.equal(ready.phase,'ready');
    const status=await (await req('/sandbox/browser/status')).json();
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
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM preview_registrations WHERE deployment=?').bind('__browser').first()).n,0);
  });
  await check('provider lookup failure never provisions a replacement sandbox',async()=>{
    lookupFails=true;await action('start');const result=await tick();
    assert.equal(result.phase,'failed');assert.equal(creates,0);lookupFails=false;
  });
  await check('small or public existing sandboxes fail before credential transfer or compute changes',async()=>{
    const before = executions;
    memory=1; await action('start');assert.equal((await tick()).error,'requires_2_gib');
    memory=4; isPublic=true; await action('start');assert.equal((await tick()).error,'public_sandbox');
    isPublic=false;assert.equal(executions,before);assert.equal(creates,0);
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
    assert.equal((await action('stop')).status,404);assert.equal(state,'started');
    assert.equal((await status()).phase,'ready');
  });
  await check('login wake is private, never creates or installs, and invalidates stale app readiness',async()=>{
    const before={creates,executions,launches,previewCalls,wakes};
    assert.equal((await action('wake-existing')).status,404);
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
    exists=true;isPublic=true;assert.equal((await wake()).status,503);isPublic=false;
    state='starting';assert.equal((await (await wake()).json()).state,'transitioning');
    state='started';
    await action('start');
    assert.equal((await (await wake()).json()).state,'opening','wake joins ongoing setup without changing it');
    ready=await finish();assert.equal(ready.phase,'ready');
    assert.equal(launches,before.launches+1,'only deliberate setup restores the app');
  });
  await check('passive status rediscovers a machine replaced by Chat/API without inheriting application readiness',async()=>{
    const before={creates,wakes,executions,previewCalls};
    machineId='replacement-sandbox';
    const result=await status();
    assert.equal(result.machine,'started');assert.equal(result.phase,'idle');assert.equal(result.url,undefined);
    assert.deepEqual({creates,wakes,executions,previewCalls},before);
  });
  await check('code-server dispatch, busy response, readiness identity and independent status',async()=>{
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
    assert(credentialsUploaded.every(path=>path.includes('/browser/credentials/')),'editor receives no inference key');
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__code-server'").first();
    assert.equal(row.deployment,'__browser');assert(row.owner_key_hash);assert.equal(row.expires_at,editor.deadline);
    const origin=new URL(editor.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    const headers={Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin','X-Opencode-Directory':'/ignored'};
    assert.equal((await worker.fetch(editor.url,{headers})).status,200);
    assert.equal(lastForwarded['x-opencode-directory'],undefined);
    const oldKey=(await db.prepare('SELECT bayleaf_token FROM user_keys WHERE email=?').bind(email).first()).bayleaf_token;
    await db.prepare('UPDATE user_keys SET bayleaf_token=? WHERE email=?').bind('sk-bayleaf-isolation-test',email).run();
    assert.equal((await worker.fetch(editor.url,{headers})).status,404);
    await db.prepare('UPDATE user_keys SET bayleaf_token=? WHERE email=?').bind(oldKey,email).run();
    await req(cs('restart'),{method:'POST'});
    await req('/__test/__expire');
    assert.equal((await status()).phase,'expired');
    assert.equal((await (await req(cs('status'))).json()).phase,'opening');
    assert(await (await req('/__test/__alarm')).json(),'retiring OpenChamber cannot erase editor setup alarm');
    for(let i=0;i<8;i++){editor=await (await req(cs('__tick'))).json();if(editor.phase==='ready')break;}
    assert.equal(editor.phase,'ready');
    assert.equal((await db.prepare("SELECT count(*) n FROM preview_registrations WHERE slot='__browser'").first()).n,0);
    assert.equal(await (await req('/__test/__alarm')).json(),editor.deadline*1000);
    await action('start');ready=await finish();assert.equal(ready.phase,'ready');
    await req(cs('__expire'));
    assert.equal((await status()).url,ready.url,'editor expiry leaves OpenChamber link alone');
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
  await check('dufs private setup and restart coexist with both services without credential upload',async()=>{
    const path=(service,action)=>'/__test/'+action+'?service='+service;
    const complete=async service=>{let op;for(let i=0;i<12;i++){op=await (await req(path(service,'__tick'))).json();if(op.phase==='ready')return op;}throw new Error(JSON.stringify(op));};
    await req(path('code-server','start'),{method:'POST'});const editor=await complete('code-server');
    const uploads=credentialsUploaded.length;
    memory=1;
    await req(path('dufs','start'),{method:'POST'});let files=await complete('dufs');
    memory=4;
    assert.equal(credentialsUploaded.length,uploads);
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
    assert.equal(lastForwarded['x-opencode-directory'],undefined);
    assert.equal((await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-rotated','Content-Type':'application/json'},body:JSON.stringify({port:8790,access:'public'})})).status,400);
    const old=files.url;
    await req(path('dufs','restart'),{method:'POST'});files=await complete('dufs');
    assert.notEqual(files.url,old);assert.equal(credentialsUploaded.length,uploads);
    assert.equal((await status()).url,ready.url);
    assert.equal((await (await req(path('code-server','status'))).json()).url,editor.url);
    await req(path('dufs','__expire'));await req(path('code-server','__expire'));
  });
  await check('Nanobot finalization hides its link, retries one generation, injects only app auth, and preserves sibling services',async()=>{
    const nb=action=>'/__test/'+action+'?service=nanobot';
    const advance=async step=>{let op;for(let i=0;i<14;i++){op=await(await req(nb('__tick'))).json();if(op.step===step || op.phase!=='opening')return op;}throw new Error('Nanobot did not reach '+step);};
    const sibling=(await status()).url;
    await req(nb('start'),{method:'POST'});
    let op=await advance('finalize');assert.equal(op.phase,'opening');assert(op.url);
    assert.equal((await(await req(nb('status'))).json()).url,undefined);
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__nanobot'").first();
    assert.equal(row.access,'private');assert(!JSON.stringify(row).includes(nanobotAuth));
    assert(!JSON.stringify(op).includes(nanobotAuth));
    const count=previewCalls;
    await req(nb('__registration-crash'));
    op=await advance('finalize');assert.equal(op.url,`https://${row.hostname}/`);
    assert.equal((await db.prepare("SELECT generation FROM preview_registrations WHERE slot='__nanobot'").first()).generation,row.generation);
    toolboxFailures=1;await req(nb('__tick'));
    op=await advance('inspect_final');nanobotReady=false;
    await req(nb('__tick'));assert.equal((await(await req(nb('status'))).json()).url,undefined);
    nanobotReady=true;op=await(await req(nb('__tick'))).json();assert.equal(op.phase,'ready');
    assert.equal(previewCalls,count);assert.equal((await status()).url,sibling);
    const origin=new URL(op.url).origin;
    assert.equal((await worker.fetch(op.url,{headers:{'X-Test-Origin':origin}})).status,401);
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    assert.equal((await worker.fetch(op.url,{headers:{Cookie:'__Host-bl-preview-session='+session,
      'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin','X-Nanobot-Auth':'spoofed'}})).status,200);
    assert.equal(lastForwarded['x-nanobot-auth'],nanobotAuth);
    const old=op.url;await req(nb('__expire'));await req(nb('start'),{method:'POST'});
    op=await advance('finalize');assert.notEqual(op.url,old);
    await advance('inspect_final');op=await(await req(nb('__tick'))).json();assert.equal(op.phase,'ready');
    assert.equal(incomingOperation.preview_url,op.url);
    await req(nb('__expire'));
  });
  await check('Nanobot wrong bootstrap origin, key rotation and preview loss during finalization revoke without exposing ready',async()=>{
    const nb=action=>'/__test/'+action+'?service=nanobot';
    const toFinalize=async()=>{await req(nb('start'),{method:'POST'});for(let i=0;i<12;i++){const op=await(await req(nb('__tick'))).json();if(op.step==='finalize')return op;}throw new Error('finalize missing');};
    await toFinalize();await req(nb('__tick'));nanobotWrongOrigin=true;
    let op=await(await req(nb('__tick'))).json();nanobotWrongOrigin=false;
    assert.equal(op.phase,'failed');assert.equal(op.error,'preview_configuration_invalid');
    assert.equal((await db.prepare("SELECT count(*) n FROM preview_registrations WHERE slot='__nanobot'").first()).n,0);
    await toFinalize();
    const old=(await db.prepare('SELECT bayleaf_token FROM user_keys WHERE email=?').bind(email).first()).bayleaf_token;
    await db.prepare('UPDATE user_keys SET bayleaf_token=? WHERE email=?').bind('sk-bayleaf-rotated-during-finalize',email).run();
    op=await(await req(nb('__tick'))).json();assert.equal(op.phase,'failed');assert.equal(op.url,undefined);
    await db.prepare('UPDATE user_keys SET bayleaf_token=? WHERE email=?').bind(old,email).run();
    await toFinalize();await db.prepare("DELETE FROM preview_registrations WHERE slot='__nanobot'").run();
    op=await(await req(nb('__tick'))).json();assert.equal(op.phase,'expired');assert.equal(op.url,undefined);
  });
  await check('Jupyter keeps native token behind owner/origin gates on HTTP and WS, uploads no inference key, and coexists',async()=>{
    const jp=action=>'/__test/'+action+'?service=jupyter';
    const uploads=credentialsUploaded.length, sibling=(await status()).url;
    const complete=async()=>{let op;for(let i=0;i<12;i++){op=await(await req(jp('__tick'))).json();if(op.phase==='ready')return op;}throw new Error('Jupyter failed');};
    await req(jp('start'),{method:'POST'});let op=await complete();
    assert.equal(credentialsUploaded.length,uploads);assert.equal((await status()).url,sibling);
    assert(!JSON.stringify(op).includes(jupyterAuth));assert.notEqual(jupyterAuth,nanobotAuth);
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__jupyter'").first();
    assert.equal(row.access,'private');assert(!JSON.stringify(row).includes(jupyterAuth));
    const origin=new URL(op.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    const headers={Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin'};
    assert.equal((await worker.fetch(op.url+'api/status',{headers:{'X-Test-Origin':origin,Authorization:'token '+jupyterAuth}})).status,401);
    assert.equal((await worker.fetch(op.url+'api/status',{headers:{...headers,Authorization:'spoofed'}})).status,200);
    assert.equal(lastForwarded.authorization,'token '+jupyterAuth);
    const previous=lastForwarded;
    assert.equal((await worker.fetch(op.url+'api/kernels',{method:'POST',headers:{...headers,'X-Test-Origin':'https://evil.test'},body:'{}'})).status,403);
    assert.equal(lastForwarded,previous,'denied mutation never receives app token');
    assert.equal((await worker.fetch(op.url+'api/kernels/fixture/channels',{headers:{Upgrade:'websocket','X-Test-Origin':origin}})).status,401);
    assert.equal((await worker.fetch(op.url+'api/kernels/fixture/channels',{headers:{...headers,Upgrade:'websocket','X-Test-Origin':'https://evil.test'}})).status,403);
    const socket=await worker.fetch(op.url+'api/kernels/fixture/channels',{headers:{...headers,Upgrade:'websocket',Authorization:'spoofed'}});
    assert.equal(socket.status,101);socket.webSocket.accept();assert.equal(lastForwarded.authorization,'token '+jupyterAuth);
    const echoed=new Promise(resolve=>socket.webSocket.addEventListener('message',event=>resolve(event.data),{once:true}));
    socket.webSocket.send('synthetic kernel message');assert.equal(await echoed,'synthetic kernel message');socket.webSocket.close();
    const old=op.url;await req(jp('restart'),{method:'POST'});op=await complete();assert.notEqual(op.url,old);
    assert.equal(credentialsUploaded.length,uploads);assert.equal((await status()).url,sibling);
    await req(jp('__expire'));assert.equal((await(await req(jp('status'))).json()).url,undefined);
  });
  await check('ttyd private HTTP/WS inject Basic auth only after owner/origin gates; no inference key, independent restart',async()=>{
    assert.equal((await worker.fetch(api+'/sandbox/expose',{method:'POST',headers:{Authorization:'Bearer sk-bayleaf-rotated','Content-Type':'application/json'},body:JSON.stringify({port:8794,access:'public'})})).status,400);
    const tt=action=>'/__test/'+action+'?service=ttyd';
    const uploads=credentialsUploaded.length, sibling=(await status()).url;
    const complete=async()=>{for(let i=0;i<12;i++){const op=await(await req(tt('__tick'))).json();if(op.phase==='ready')return op;}throw new Error('ttyd failed');};
    await req(tt('start'),{method:'POST'});let op=await complete();
    assert.equal(credentialsUploaded.length,uploads);assert.equal((await status()).url,sibling);
    assert(!JSON.stringify(op).includes(ttydAuth));assert.notEqual(ttydAuth,jupyterAuth);
    const row=await db.prepare("SELECT * FROM preview_registrations WHERE slot='__ttyd'").first();
    assert.equal(row.access,'private');assert(!JSON.stringify(row).includes(ttydAuth));
    const origin=new URL(op.url).origin;
    const session=jwt({aud:origin,generation:row.generation,exp:row.expires_at},previewSecret);
    const headers={Cookie:'__Host-bl-preview-session='+session,'X-Test-Origin':origin,'Sec-Fetch-Site':'same-origin'};
    const basic='Basic '+Buffer.from('bayleaf:'+ttydAuth).toString('base64');
    assert.equal((await worker.fetch(op.url+'token',{headers:{'X-Test-Origin':origin,Authorization:basic}})).status,401);
    assert.equal((await worker.fetch(op.url+'token',{headers:{...headers,Authorization:'spoofed'}})).status,200);
    assert.equal(lastForwarded.authorization,basic);
    const previous=lastForwarded;
    assert.equal((await worker.fetch(op.url+'ws',{headers:{Upgrade:'websocket','X-Test-Origin':origin,Authorization:basic}})).status,401);
    assert.equal((await worker.fetch(op.url+'ws',{headers:{...headers,Upgrade:'websocket','X-Test-Origin':'https://evil.test'}})).status,403);
    assert.equal(lastForwarded,previous);
    const socket=await worker.fetch(op.url+'ws',{headers:{...headers,Upgrade:'websocket',Authorization:'spoofed'}});
    assert.equal(socket.status,101);socket.webSocket.accept();assert.equal(lastForwarded.authorization,basic);socket.webSocket.close();
    const old=op.url;await req(tt('restart'),{method:'POST'});op=await complete();assert.notEqual(op.url,old);
    assert.equal(credentialsUploaded.length,uploads);assert.equal((await status()).url,sibling);
    await req(tt('__expire'));assert.equal((await(await req(tt('status'))).json()).url,undefined);
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
  await check('documented authentication and permission rejections permit corrected creation retry',async()=>{
    for(const status of [401,403]) {
      exists=false;rejectCreate=status;
      const before=creationRequests;
      await action('restart');assert.equal((await tick()).error,'creation_failed');
      rejectCreate=0;await action('start');ready=await finish();
      assert.equal(ready.phase,'ready');assert.equal(creationRequests,before+2);
    }
  });
  await check('undocumented rejection, 5xx and transport loss retain owner-wide creation ambiguity',async()=>{
    for(const outcome of ['400','503','transport']) {
      exists=false;rejectCreate=outcome==='400'?400:0;failCreate=outcome==='503';
      await req('/sandbox/browser/restart',{method:'POST',headers:outcome==='transport'?{'X-Test-Create-Transport':'1'}:{}});
      assert.equal((await tick()).error,'creation_uncertain');
      const before=creationRequests;
      await req('/__test/start?service=code-server',{method:'POST'});
      assert.equal((await (await req('/__test/__tick?service=code-server')).json()).error,'creation_uncertain');
      assert.equal(creationRequests,before);
      rejectCreate=0;failCreate=false;exists=true;
      await action('start');ready=await finish();assert.equal(ready.phase,'ready');
    }
  });
  await check('ambiguous creation intent survives another service attempt',async()=>{
    exists=false;failCreate=true;
    const before=creationRequests;
    await action('restart');assert.equal((await tick()).phase,'failed');
    assert.equal(creationRequests,before+1);
    await req('/__test/start?service=code-server',{method:'POST'});
    const editor=await (await req('/__test/__tick?service=code-server')).json();
    assert.equal(editor.error,'creation_uncertain');assert.equal(creationRequests,before+1);
    failCreate=false;exists=true;
  });
  console.log(checks+' lifecycle checks passed (synthetic provider; no live deployment).');
} finally {await mf.dispose();}
