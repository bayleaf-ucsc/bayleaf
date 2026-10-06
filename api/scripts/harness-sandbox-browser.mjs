#!/usr/bin/env node
/** Real workerd/D1/DO state; synthetic Daytona. Never contacts production. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const api = 'https://api.example.test';
const email = 'owner@example.test';
const secret = 'synthetic-oidc-secret';
const previewSecret = Buffer.alloc(32, 7).toString('base64');
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  import { SandboxBrowser as Controller } from './src/sandboxBrowser.ts';
  export { PreviewConnections } from './src/index.ts';
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
      const path=new URL(req.url).pathname;
      if(path==='/__tick') {await this.alarm(); return Response.json(await this.testStorage.get('operation'));}
      if(path==='/__expire') {
        const op=await this.testStorage.get('operation');op.deadline=0;await this.testStorage.put('operation',op);
        await this.alarm();return Response.json(await this.testStorage.get('operation'));
      }
      return super.fetch(req);
    }
  }
  export default {...app,async fetch(req,env,ctx){
    const u=new URL(req.url);
    if(u.pathname.startsWith('/__test/')) {
      const owner=req.headers.get('X-Test-Owner')||'owner@example.test';
      return env.SANDBOX_BROWSER.get(env.SANDBOX_BROWSER.idFromName(owner)).fetch('https://controller/'+u.pathname.slice(8));
    }
    const headers=new Headers(req.headers);
    if(headers.has('X-Test-Origin')) {headers.set('Origin',headers.get('X-Test-Origin'));headers.delete('X-Test-Origin');}
    if(headers.has('X-Test-Mode')) {headers.set('Sec-Fetch-Mode',headers.get('X-Test-Mode'));headers.delete('X-Test-Mode');}
    return app.fetch(new Request(req,{headers}),headers.has('X-Test-Disabled')?{...env,BROWSER_SANDBOX_ENABLED:'false'}:env,ctx);
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', loader: { '.py': 'text', '.md': 'text' } });

let state = 'archived', lookupFails = false, exists = true, interrupted = false, memory = 4, isPublic = false;
let creates = 0, wakes = 0, executions = 0, launches = 0, previewCalls = 0;
let incomingOperation, lastForwarded, toolboxFailures = 0;
const machine = () => ({ id: 'synthetic-sandbox', state, memory, public: isPublic, labels: { 'synthetic-chat': email } });
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
      if (u.pathname === '/api/sandbox' && req.method === 'GET') {
        if (lookupFails) return new Response('outage', { status: 503 });
        return Response.json({ items: exists ? [machine()] : [] });
      }
      if (u.pathname === '/api/sandbox' && req.method === 'POST') {
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
        if (u.searchParams.get('path').endsWith('credentials/incoming')) assert(text.startsWith('sk-bayleaf-'));
        return Response.json({});
      }
      executions++;
      const { command } = await req.json();
      assert(!command.includes('sk-bayleaf-'), 'credential in command');
      if (command.includes('subprocess.Popen')) launches++;
      if (command.endsWith('setup.py inspect')) return Response.json({ exitCode: 0, result: JSON.stringify({
        schema: 1, operation: interrupted ? 'stale' : incomingOperation.operation,
        updated_at: Math.floor(Date.now()/1000), phase: 'ready', ready: true, port: 3100,
        timeline:[{step:'loading_tools',at:Math.floor(Date.now()/1000)},
          {step:'credential-leak',at:Math.floor(Date.now()/1000),error:'secret'},
          {step:'connecting_bayleaf',at:9999999999999}],
      }) });
      return Response.json({ exitCode: 0, result: '' });
    }
    if (u.hostname.endsWith('.preview.example.test')) {
      lastForwarded = Object.fromEntries(req.headers);
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
  const headers = new Headers(options.headers);
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
  console.log(checks+' lifecycle checks passed (synthetic provider; no live deployment).');
} finally {await mf.dispose();}
