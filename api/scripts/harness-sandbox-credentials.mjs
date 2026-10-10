#!/usr/bin/env node
/** Real Worker/D1 authority and accounting, synthetic providers only. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const email = 'owner@example.test', ordinary = 'sk-bayleaf-owner';
const bundle = await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
  import app from './src/index.ts';
  import * as sc from './src/sandboxCredentials.ts';
  import {ensureBackendKey,healBackendKey} from './src/provision.ts';
  export {PreviewConnections} from './src/index.ts';
  export default {...app,async fetch(req,env,ctx){
    const path=new URL(req.url).pathname;
    if(path.startsWith('/__test/')) {
      try {
        const data=await req.json();
        if(path==='/__test/setup')return Response.json(await sc.ensureSandboxCredential(env,data.email,data.id));
        if(path==='/__test/revoke'){await sc.revokeSandboxCredentials(env,data.id);return Response.json(true);}
        if(path==='/__test/rotate'){await sc.rotateSandboxCredential(env,await sc.activeSandboxCredential(env,data.email,data.id));return Response.json(true);}
        if(path==='/__test/cleanup'){await sc.cleanupSandboxCredentials(env);return Response.json(true);}
        if(path==='/__test/backend'){
          const row=await sc.authenticateSandboxCredential(env,data.key);
          if(!row)return new Response('unauthorized',{status:401});
          const cred=data.failed ? await healBackendKey(row,data.kind,data.failed,env) : await ensureBackendKey(row,data.kind,env);
          return Response.json(cred);
        }
      }catch{return new Response('synthetic operation failed',{status:503});}
    }
    return app.fetch(req,env,ctx);
  }};
`},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],loader:{'.py':'text','.md':'text'}});
const vault = new Map(), machines = new Map();
let failAttachment = false, loseCreateResponse = false, failDeletion = false;
let minted = 0, discarded = 0, rejectInference = false;
const metadata = ({value, ...rest}) => rest;
const machine = (id, owner = email) => ({id,state:'archived',labels:{synthetic:owner},env:{}});
machines.set('one',machine('one')); machines.set('other',machine('other','other@example.test'));
const mf = new Miniflare(convertV4MiniflareOptions({workers:[{name:'credentials',modules:true,
  script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],
  d1Databases:['DB'],kvNamespaces:['MODEL_STATUS','CAMPUS_RPD'],
  durableObjects:{PREVIEW_CONNECTIONS:{className:'PreviewConnections',useSQLite:true}},
  bindings:{DAYTONA_API_URL:'https://daytona.example.test',DAYTONA_API_KEY:'synthetic-admin',DAYTONA_DEPLOYMENT_LABEL:'synthetic',
    SEALED_ENABLED:'true',SEALED_RPD_LIMIT:'2',BEDROCK_ENABLED:'true',BEDROCK_RPD_LIMIT:'2',BEDROCK_BEARER_TOKEN:'synthetic-bedrock',
    SPENDING_LIMIT_DOLLARS:'5',KEY_NAME_TEMPLATE:'Synthetic {email}',OPENROUTER_PROVISIONING_KEY:'synthetic-admin',
    TAVILY_API_KEY:'synthetic',RECOMMENDED_MODEL:'test/open',OPENCODE_CURATED_MODELS:'test/open',
    TINFOIL_ADMIN_KEY:'synthetic-admin',ALLOWED_EMAIL_DOMAIN:'example.test',GRANTS_ENABLED:'true',GRANTS_MAX_SECONDS:'3600',
    OIDC_CLIENT_SECRET:'synthetic-signing',PREVIEWS_ENABLED:'false'},
  outboundService:async req=>{
    const u=new URL(req.url);
    if(u.hostname==='daytona.example.test'){
      assert.equal(req.headers.get('Authorization'),'Bearer synthetic-admin');
      if(u.pathname==='/secret' && req.method==='POST'){
        const body=await req.json();assert.deepEqual(body.hosts,['api.bayleaf.dev']);
        assert.match(body.value,/^sk-bayleaf-sandbox-[a-f0-9]{64}$/);assert.notEqual(body.value,ordinary);
        const secret={...body,id:body.name,placeholder:'dtn_secret_'+body.name};vault.set(secret.id,secret);
        if(loseCreateResponse)return new Response('ambiguous create',{status:503});
        return Response.json(metadata(secret),{status:201});
      }
      if(u.pathname==='/secret/paginated')return Response.json({items:[...vault.values()].filter(s=>s.name.includes(u.searchParams.get('name'))).map(metadata),nextCursor:null});
      if(u.pathname.startsWith('/secret/')){
        const id=u.pathname.slice(8), secret=vault.get(id);
        if(!secret)return new Response('',{status:404});
        if(req.method==='DELETE'){if(failDeletion)return new Response('',{status:503});vault.delete(id);return new Response(null,{status:204});}
        if(req.method==='PATCH'){const body=await req.json();assert.deepEqual(body.hosts,['api.bayleaf.dev']);Object.assign(secret,body);}
        return Response.json(metadata(secret));
      }
      const id=u.pathname.split('/')[2], m=machines.get(id);
      if(!m)return new Response('',{status:404});
      if(u.pathname.endsWith('/secrets')){
        const {secrets}=await req.json();assert.equal(secrets.length,1);
        if(failAttachment)return new Response('',{status:503});
        m.env.BAYLEAF_API_KEY=vault.get(secrets[0].BAYLEAF_API_KEY).placeholder;
      }
      return Response.json(m);
    }
    if(u.hostname==='huggingface.co')return new Response('weights');
    if(u.hostname==='openrouter.ai'){
      if(u.pathname.endsWith('/models'))return Response.json({data:[{id:'test/open',name:'Synthetic',hugging_face_id:'test/open',pricing:{prompt:'0',completion:'0'}}]});
      if(u.pathname.endsWith('/keys') && req.method==='POST'){minted++;return Response.json({key:'provider-'+minted,data:{hash:'hash-'+minted}});}
      if(u.pathname.includes('/keys/') && req.method==='DELETE'){discarded++;return new Response(null,{status:204});}
      if(u.pathname.endsWith('/auth/key'))return Response.json({data:{limit:5,limit_remaining:3,limit_reset:'daily',usage_daily:2}});
      assert.match(req.headers.get('Authorization'),/^Bearer provider-/);
      if(rejectInference){rejectInference=false;return new Response('',{status:401});}
      const body=await req.json();assert.equal(body.user,email);
      return Response.json({choices:[{message:{content:'synthetic'}}]});
    }
    if(u.hostname==='bedrock-mantle.us-west-2.api.aws'){
      if(u.pathname.endsWith('/models'))return Response.json({data:[{id:'test',data_retention:{allowed_modes:['none']}}]});
      return Response.json({choices:[{message:{content:'synthetic'}}]});
    }
    if(u.hostname==='api.tavily.com')return Response.json({results:[],query:'synthetic'});
    if(u.hostname==='synthetic.tinfoil.sh'){
      assert.equal(req.headers.get('Authorization'),'Bearer tk_existing');
      assert.equal(await req.text(),'synthetic-ciphertext');
      return new Response('synthetic-encrypted-reply',{headers:{'Ehbp-Response-Nonce':'ab'.repeat(32),'Content-Type':'application/octet-stream'}});
    }
    throw new Error('Unexpected synthetic upstream '+u.hostname+u.pathname);
  },
}]}));
try{
  const db=await mf.getD1Database('DB');
  for(const file of (await readdir(root+'migrations')).filter(f=>f.endsWith('.sql')).sort()){
    const sql=(await readFile(root+'migrations/'+file,'utf8')).replace(/^\s*--.*$/gm,'');
    const statements=file==='0009_preview_origin_invalidation.sql'?sql.split(/;\s*(?=CREATE|$)/):sql.split(';');
    for(const statement of statements.map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  }
  for(const [owner,key,id] of [[email,ordinary,'one'],['other@example.test','sk-bayleaf-other','other']])
    await db.prepare('INSERT INTO user_keys(email,bayleaf_token,daytona_sandbox_id,account_generation,tinfoil_key) VALUES(?,?,?,?,?)')
      .bind(owner,key,id,owner,'tk_existing').run();
  const worker=await mf.getWorker();
  const req=(path,key,body,headers={})=>worker.fetch('https://api.bayleaf.dev'+path,{method:body===undefined?'GET':'POST',headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const op=(action,body={})=>req('/__test/'+action,null,body);
  const ok=async r=>{assert.equal(r.status,200,await r.clone().text());return r.json();};
  const setup=await ok(await op('setup',{email,id:'one'}));
  let bearer=vault.get(setup.secret_id).value;
  assert.equal(minted,0,'issuance never mints provider keys');
  assert.equal((await ok(await op('setup',{email,id:'one'}))).id,setup.id,'idempotent setup');
  assert.equal((await op('setup',{email:'other@example.test',id:'one'})).status,503,'owner mismatch fails');
  assert(!JSON.stringify(setup).includes(bearer),'metadata response excludes bearer');
  const stored=await db.prepare('SELECT * FROM sandbox_credentials').all();
  assert(!JSON.stringify(stored).includes(bearer),'D1 contains verifier only');
  assert.equal((await req('/usage',setup.placeholder)).status,401,'placeholder alone never authenticates at BayLeaf');
  for(const path of ['/usage','/v1/models','/sandbox','/sandbox/.well-known/opencode/config'])await ok(await req(path,bearer));
  await ok(await req('/web/search',bearer,{query:'synthetic'}));
  const grant=await ok(await req('/grants',ordinary,{model:'test/open',expires_in:300}));
  await db.prepare('UPDATE user_keys SET revoked=1 WHERE email=?').bind(email).run();
  assert.equal((await req('/usage',ordinary)).status,401);
  await ok(await req('/usage',bearer));
  const infer=key=>req('/v1/chat/completions',key,{model:'test/open',messages:[{role:'user',content:'synthetic'}]});
  assert.match(grant.access_token,/^sk-bayleaf-grant-/);
  assert.equal((await infer(grant.access_token)).status,401,'ordinary revoke still invalidates temporary inference tokens');
  const credentials=await Promise.all(Array.from({length:5},()=>op('backend',{key:bearer,kind:'openrouter'}).then(ok)));
  assert.equal(new Set(credentials.map(c=>c.secret)).size,1,'concurrent first use shares one credential');
  assert.equal(minted-discarded,1,'no billable race losers retained');
  await ok(await infer(bearer));rejectInference=true;await ok(await infer(bearer));
  assert.equal((await db.prepare('SELECT revoked FROM user_keys WHERE email=?').bind(email).first()).revoked,1,'healing never revives ordinary key');
  await db.prepare('UPDATE user_keys SET bedrock_rpd_date=?,bedrock_rpd_count=98 WHERE email=?').bind(new Date().toISOString().slice(0,10),email).run();
  for(let i=0;i<2;i++)await ok(await req('/v1/chat/completions',bearer,{model:'bedrock:test',messages:[{role:'user',content:'synthetic'}]}));
  assert.equal((await req('/v1/chat/completions',bearer,{model:'bedrock:test',messages:[{role:'user',content:'synthetic'}]})).status,429);
  const sealed=key=>worker.fetch('https://api.bayleaf.dev/sealed/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Ehbp-Encapsulated-Key':'ab'.repeat(32),'X-Tinfoil-Enclave-Url':'https://synthetic.tinfoil.sh','Content-Type':'application/octet-stream'},body:'synthetic-ciphertext'});
  assert.equal((await sealed(bearer)).status,200);
  await db.prepare('UPDATE user_keys SET revoked=0,bayleaf_token=? WHERE email=?').bind('sk-bayleaf-reissued',email).run();
  assert.equal((await sealed('sk-bayleaf-reissued')).status,200);
  assert.equal((await sealed(bearer)).status,429,'ordinary and sandbox credentials share Sealed accounting');
  const before=await db.prepare('SELECT * FROM user_keys WHERE email=?').bind(email).first();
  await ok(await op('rotate',{email,id:'one'}));
  assert.equal(vault.get(setup.secret_id).placeholder,setup.placeholder);
  assert.equal((await req('/usage',bearer)).status,401);
  bearer=vault.get(setup.secret_id).value;await ok(await req('/usage',bearer));
  assert.deepEqual(await db.prepare('SELECT * FROM user_keys WHERE email=?').bind(email).first(),before,'rotation leaves budgets/provider keys unchanged');
  const other=await ok(await op('setup',{email:'other@example.test',id:'other'}));
  await ok(await op('revoke',{id:'one'}));
  assert.equal((await req('/usage',bearer)).status,401);
  await ok(await req('/usage','sk-bayleaf-reissued'));
  await ok(await req('/usage',vault.get(other.secret_id).value));
  failDeletion=true;await ok(await op('cleanup'));assert(vault.has(setup.secret_id));
  failDeletion=false;await ok(await op('cleanup'));assert(!vault.has(setup.secret_id));
  machines.delete('other');
  assert.equal((await req('/usage',vault.get(other.secret_id).value)).status,401,'external deletion immediately fails authentication');
  await ok(await op('cleanup'));assert(!vault.has(other.secret_id));
  for(const ambiguous of [false,true]){
    machines.set('one',machine('one'));failAttachment=!ambiguous;loseCreateResponse=ambiguous;
    assert.equal((await op('setup',{email,id:'one'})).status,503);
    assert.equal((await db.prepare("SELECT count(*) n FROM sandbox_credentials WHERE state='active'").first()).n,0);
    failAttachment=false;loseCreateResponse=false;await ok(await op('cleanup'));assert.equal(vault.size,0,'failed/ambiguous provisioning cleans exact owned secret');
  }
  console.log('PASS sandbox credential identity, custody, revocation, shared accounting, mint/heal races, rotation, deletion and partial-provision cleanup');
}finally{await mf.dispose();}
