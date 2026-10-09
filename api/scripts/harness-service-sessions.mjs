#!/usr/bin/env node
/** Synthetic service binding + real workerd/D1: no production credentials/network. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const api = 'https://api.example.test';
const secret = 'synthetic-session-secret';
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  import { cleanupServiceSessions } from './src/serviceSessions.ts';
  export { SandboxManagement } from './src/serviceSessions.ts';
  import { DurableObject } from 'cloudflare:workers';
  export class SyntheticController extends DurableObject {
    async fetch(req) { return Response.json({owner:req.headers.get('X-BayLeaf-Owner'),path:new URL(req.url).pathname}); }
  }
  export default {...app, async fetch(req,env,ctx) {
    if(new URL(req.url).pathname==='/__cleanup') {await cleanupServiceSessions(env);return new Response('ok');}
    const headers = new Headers(req.headers);
    if(headers.has('X-Test-Origin')) {headers.set('Origin',headers.get('X-Test-Origin'));headers.delete('X-Test-Origin');}
    return app.fetch(new Request(req,{headers}),env,ctx);
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'], loader: { '.py': 'text', '.md': 'text' } });
let outbound = 0;
const homeBundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import home from '../sandbox/worker.js';
  export default {fetch(req,env,ctx){
    const headers=new Headers(req.headers);
    if(headers.has('X-Test-Origin')) {headers.set('Origin',headers.get('X-Test-Origin'));headers.delete('X-Test-Origin');}
    return home.fetch(new Request(req,{headers}),env,ctx);
  }};
` }, bundle:true, write:false, format:'esm', platform:'browser', target:'es2022' });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: 'api', modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  durableObjects: { SANDBOX_BROWSER: { className: 'SyntheticController', useSQLite: true } },
  bindings: { PREVIEWS_API_ORIGIN: api, ALLOWED_EMAIL_DOMAIN: 'example.test', OIDC_CLIENT_SECRET: secret,
    BROWSER_SANDBOX_ENABLED: 'true', PREVIEWS_ENABLED: 'true', PREVIEWS_DOMAIN: 'previews.example.test',
    PREVIEWS_SECRET: Buffer.alloc(32, 7).toString('base64') },
  outboundService: () => { outbound++; return new Response('Unexpected network', {status: 500}); },
}, {
  name: 'client', modules: true, compatibilityDate: '2026-08-01',
  serviceBindings: { MANAGEMENT: { name: 'api', entrypoint: 'SandboxManagement' } },
  script: `export default { async fetch(req,env) {
    const {method,input}=await req.json();
    return Response.json(await env.MANAGEMENT[method](input));
  } };`,
}, {
  name: 'home', modules: true, compatibilityDate: '2026-08-01',
  serviceBindings: { MANAGEMENT: { name: 'api', entrypoint: 'SandboxManagement' } },
  script: homeBundle.outputFiles[0].text,
}] }));
try {
  const db = await mf.getD1Database('DB', 'api');
  for (const file of (await readdir(root+'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(root+'migrations/'+file, 'utf8')).replace(/^\s*--.*$/gm,'');
    const statements = file === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) : sql.split(';');
    for (const statement of statements.map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const client = await mf.getWorker('client');
  const worker = await mf.getWorker('api');
  const rpc = async (method,input) => (await client.fetch('https://client/', {method:'POST',body:JSON.stringify({method,input})})).json();
  const jwt = email => {
    const head = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const body = Buffer.from(JSON.stringify({email,name:'Synthetic Owner',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
    return `${head}.${body}.${createHmac('sha256',secret).update(`${head}.${body}`).digest('base64url')}`;
  };
  const sessionCookieName = (await readFile(root+'src/constants.ts','utf8')).match(/SESSION_COOKIE\s*=\s*['"]([^'"]+)/)[1];
  const authorize = (url,cookie='') => worker.fetch(url,{headers:{Cookie:cookie,'X-Test-Origin':'https://sandbox.bayleaf.dev'},redirect:'manual'});
  const start = async () => {
    const verifier = random();
    const begun = await rpc('beginLogin',{verifierHash:hash(verifier)});
    assert(begun?.flow);
    assert.equal(await rpc('proveLogin',{flow:begun.flow,verifier}),null,'must bind API cookie first');
    const response = await authorize(begun.authorizeUrl);
    assert.equal(response.status,302);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal(new URL(response.headers.get('Location')).origin,'https://sandbox.bayleaf.dev');
    const cookie = response.headers.get('Set-Cookie').split(';')[0];
    assert(response.headers.get('Set-Cookie').includes('Secure'));
    assert(!response.headers.get('Set-Cookie').includes('Domain='));
    assert.equal(await rpc('proveLogin',{flow:begun.flow,verifier:random()}),null);
    const proved = await rpc('proveLogin',{flow:begun.flow,verifier});
    assert(proved?.authorizeUrl);
    assert.equal(await rpc('proveLogin',{flow:begun.flow,verifier}),null,'proof is single-use');
    assert.equal((await authorize(proved.authorizeUrl)).status,400,'API cookie still required');
    assert.equal((await authorize(proved.authorizeUrl,'__Host-bl-service-broker='+random())).status,400,'wrong browser rejected');
    return {...begun,verifier,cookie};
  };
  const issue = async (flow,email='owner@example.test') => {
    const response = await authorize(flow.authorizeUrl,`${flow.cookie}; ${sessionCookieName}=${jwt(email)}`);
    assert.equal(response.status,302);
    const url = new URL(response.headers.get('Location'));
    assert.equal(url.origin,'https://sandbox.bayleaf.dev');
    assert.equal(url.pathname,'/auth/callback');
    return url.searchParams.get('code');
  };
  assert.equal(await rpc('beginLogin',null),null);
  assert.equal(await rpc('beginLogin',{verifierHash:hash('x'),redirect:'https://evil.test'}),null);
  const flow = await start();
  const needsLogin = await authorize(flow.authorizeUrl,flow.cookie);
  assert.equal(needsLogin.headers.get('Location'),'/login');
  assert(needsLogin.headers.get('Set-Cookie').startsWith('__Host-bl-service-return='+flow.flow));
  const code = await issue(flow);
  assert.equal(await rpc('exchangeLogin',{flow:flow.flow,code,verifier:random()}),null);
  const exchanges = await Promise.all(Array.from({length:4},()=>rpc('exchangeLogin',{flow:flow.flow,code,verifier:flow.verifier})));
  assert.equal(exchanges.filter(Boolean).length,1,'only one concurrent exchange wins');
  const login = exchanges.find(Boolean);
  assert.equal(login.user.email,'owner@example.test');
  assert(login.expiresAt > Date.now()/1000);
  const owner = await db.prepare('SELECT * FROM user_keys WHERE email=?').bind(login.user.email).first();
  assert.equal(owner.or_key_secret,null);
  assert.equal(owner.tinfoil_key,null);
  const stored = await db.prepare('SELECT * FROM service_sessions').first();
  assert.equal(stored.session_hash,hash(login.session));
  assert(!JSON.stringify(stored).includes(login.session));
  assert.deepEqual(await rpc('readSession',{session:login.session}),{user:login.user,expiresAt:login.expiresAt});
  assert.equal((await rpc('managed',{session:login.session,service:'arbitrary',operation:'start'})).status,400);
  assert.equal((await rpc('managed',{session:login.session,service:'openchamber',operation:'start',email:'victim@example.test'})).status,400);
  for (const operation of ['status','start','restart']) {
    const result = await rpc('managed',{session:login.session,service:'openchamber',operation});
    assert.equal(result.status,200);
    assert.deepEqual(result.body,{owner:login.user.email,path:'/'+operation});
  }
  assert.equal((await rpc('managed',{session:login.session,operation:'wake-existing'})).body.path,'/wake-existing');
  await db.prepare('UPDATE user_keys SET revoked=1 WHERE email=?').bind(login.user.email).run();
  assert.equal(await rpc('readSession',{session:login.session}),null);
  assert.equal((await rpc('managed',{session:login.session,service:'openchamber',operation:'start'})).status,401);
  const revokedFlow = await start();
  const revokedCode = await issue(revokedFlow);
  assert.equal(await rpc('exchangeLogin',{flow:revokedFlow.flow,code:revokedCode,verifier:revokedFlow.verifier}),null);
  assert.equal((await db.prepare('SELECT revoked FROM user_keys WHERE email=?').bind(login.user.email).first()).revoked,1,'login never reactivates revoked owner');
  await db.prepare('UPDATE user_keys SET revoked=0,bayleaf_token=? WHERE email=?').bind('sk-bayleaf-rotated',login.user.email).run();
  assert.equal(await rpc('readSession',{session:login.session}),null,'rotation invalidates session');
  assert.equal(await rpc('logout',{session:login.session}),true);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM service_sessions').first()).n,0);
  const expired = await start();
  const expiredCode = await issue(expired);
  await db.prepare('UPDATE service_login_flows SET expires_at=0 WHERE id=?').bind(expired.flow).run();
  assert.equal(await rpc('exchangeLogin',{flow:expired.flow,code:expiredCode,verifier:expired.verifier}),null);
  const sessionFlow = await start();
  const sessionCode = await issue(sessionFlow);
  const second = await rpc('exchangeLogin',{flow:sessionFlow.flow,code:sessionCode,verifier:sessionFlow.verifier});
  await db.prepare('UPDATE service_sessions SET expires_at=0').run();
  assert.equal(await rpc('readSession',{session:second.session}),null,'expired session rejected');
  await worker.fetch(api+'/__cleanup');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM service_sessions').first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM service_login_flows').first()).n,0);
  assert.equal(outbound,0,'login does not call providers or provision keys');
  // Exercise the actual dashboard Worker across the binding, rather than only
  // the protocol RPC test client. Each origin keeps a separate cookie jar.
  const home = await mf.getWorker('home');
  const homeOrigin='https://sandbox.bayleaf.dev';
  const jars={home:new Map(),api:new Map([[sessionCookieName,jwt('integration@example.test')]])};
  async function navigate(target,path,method='GET') {
    const jar=jars[target];
    const headers={Cookie:[...jar].map(([k,v])=>k+'='+v).join(';')};
    if(method==='POST')headers['X-Test-Origin']=homeOrigin;
    const result=await (target==='home'?home:worker).fetch(path,{method,headers,redirect:'manual'});
    for(const value of result.headers.getSetCookie()) {
      const [pair]=value.split(';'),at=pair.indexOf('=');
      if(value.includes('Max-Age=0'))jar.delete(pair.slice(0,at));
      else jar.set(pair.slice(0,at),pair.slice(at+1));
    }
    return result;
  }
  let page=await navigate('home',homeOrigin+'/');
  assert.equal(page.status,200);assert((await page.text()).includes('Sign in with UCSC'));
  let bounce=await navigate('home',homeOrigin+'/login','POST');assert.equal(bounce.status,200);
  const continuation=(await bounce.text()).match(/<a href="([^"]+)"/)[1].replaceAll('&amp;','&');
  bounce=await navigate('api',continuation);assert.equal(bounce.status,302);
  bounce=await navigate('home',bounce.headers.get('Location'));assert.equal(bounce.status,303);
  bounce=await navigate('api',bounce.headers.get('Location'));assert.equal(bounce.status,302);
  const callback=bounce.headers.get('Location');
  bounce=await navigate('home',callback);assert.equal(bounce.status,303);
  assert(jars.home.has('__Host-bayleaf-sandbox-session'));
  assert(!jars.home.has('__Host-bayleaf-sandbox-transaction'));
  page=await navigate('home',homeOrigin+'/');
  assert.equal(page.status,200);assert((await page.text()).includes('integration@example.test'));
  assert.equal((await navigate('home',callback)).status,400,'completed browser callback cannot be replayed');
  const service=await navigate('home',homeOrigin+'/services/openchamber/status');
  assert.equal(service.status,200);assert.equal((await service.json()).owner,'integration@example.test');
  assert.equal((await navigate('home',homeOrigin+'/logout','POST')).status,303);
  assert(!jars.home.has('__Host-bayleaf-sandbox-session'));
  assert.equal(outbound,0,'two-Worker login only dispatches the synthetic wake controller');
  console.log('Service-session binding/protocol checks passed.');
} finally { await mf.dispose(); }
