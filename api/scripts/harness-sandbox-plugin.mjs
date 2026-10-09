#!/usr/bin/env node
/** Real isolated V2 server, synthetic BayLeaf. No live credentials or inference. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tempBase = process.env.OPENCODE_TEST_TMP || '/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode';
const root = await mkdtemp(join(tempBase, 'bayleaf-plugin-'));
const plugin = fileURLToPath(new URL('../sandbox-plugin/index.mjs', import.meta.url));
const binary = process.env.OPENCODE_TEST_BINARY || 'opencode';
const headers = { authorization:'Basic '+Buffer.from('opencode:synthetic-password').toString('base64'),
  'content-type':'application/json', 'X-Opencode-Directory':join(root,'workspace') };
let config, webCalls = 0, configCalls = 0, child;
let exposeAck;
const exposeCalls = [];
const archives = new Map();
const packageName = '@bayleaf-ucsc/sandbox-fixture';
const fixture = createServer(async (req,res) => {
  const path = req.url.split('?')[0];
  if (decodeURIComponent(path) === '/'+packageName) {
    const versions = Object.fromEntries(['0.1.0','0.1.1'].map(version => [version,
      {name:packageName,version,type:'module',exports:{'.':'./index.mjs'},
        dist:{tarball:origin+'/package-'+version+'.tgz'}}]));
    res.setHeader('Content-Type','application/json');
    return res.end(JSON.stringify({name:packageName,'dist-tags':{latest:'0.1.1'},versions}));
  }
  if (archives.has(path)) return res.end(archives.get(path));
  if (path === '/usage') return res.end(JSON.stringify({observed_at:'fixture',budgets:[]}));
  if (path === '/sandbox') return res.end(JSON.stringify({state:'started'}));
  if (path === '/sandbox/browser/status') return res.end(JSON.stringify({phase:'ready'}));
  if (path === '/sandbox/expose') {
    assert.equal(req.method,'POST');
    assert.equal(req.headers.authorization,'Bearer sk-bayleaf-synthetic');
    let body='';for await(const chunk of req) body+=chunk;
    exposeCalls.push({body:JSON.parse(body),headers:req.headers});
    return res.end(JSON.stringify({url:'https://fixture.bayleaf-proxies.dev/',expires_at:'2026-10-07T00:00:00Z',
      ...(exposeAck===undefined?{}:{upstream_headers_applied:exposeAck})}));
  }
  if (path === '/sandbox/expose/8000') {res.statusCode=204;return res.end();}
  if (path === '/.well-known/opencode') return res.end(JSON.stringify({
    auth:{command:['false'],env:'BAYLEAF_API_KEY'},
    remote_config:{url:origin+'/config',headers:{Authorization:'Bearer {env:BAYLEAF_API_KEY}'}} }));
  if (path === '/config') {
    assert.equal(req.headers.authorization,'Bearer sk-bayleaf-synthetic');
    configCalls++; return res.end(JSON.stringify({config}));
  }
  if (path === '/web/search' || path === '/web/fetch') {
    assert.equal(req.headers.authorization,'Bearer sk-bayleaf-synthetic');
    webCalls++; return res.end(JSON.stringify({results:path.endsWith('search') ?
      [{title:'Synthetic source',url:'https://example.test/page',snippet:'Synthetic evidence'}] :
      [{url:'https://example.test/page',content:'# Synthetic page'}]}));
  }
  res.statusCode=404;res.end();
});
fixture.listen(0,'127.0.0.1'); await once(fixture,'listening');
const origin = `http://127.0.0.1:${fixture.address().port}`;
const portProbe=createServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
const endpoint=`http://127.0.0.1:${port}`;

async function api(path, body, method) {
  const r=await fetch(endpoint+path,{headers,method:method||(body===undefined?'GET':'POST'),
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const text=await r.text();
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}: ${text.slice(0,500)}`);
  return text?JSON.parse(text):undefined;
}
async function wait(fn, timeout=30000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end) {
    try {const result=await fn();if(result)return result;}catch(error){last=error;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw last || new Error('Fixture readiness timeout');
}
const rpc=(name,input={})=>api('/api/rpc/bayleaf.fixture/'+name,{input});

try {
  for(const dir of ['config/opencode','data','cache','state','workspace','plugin-a','plugin-b']) await mkdir(join(root,dir),{recursive:true});
  await writeFile(join(root,'config/opencode/opencode.json'),JSON.stringify({update:'disable'}));
  for(const revision of ['a','b']) {
    await writeFile(join(root,'plugin-'+revision,'package.json'),JSON.stringify({type:'module',exports:{'.':'./index.mjs'}}));
    await writeFile(join(root,'plugin-'+revision,'index.mjs'),`
      import real from ${JSON.stringify(pathToFileURL(plugin).href)};
      const original=globalThis.fetch;
      globalThis.fetch=(url,options)=>String(url).startsWith('https://api.bayleaf.dev/')?
        original(${JSON.stringify(origin)}+new URL(url).pathname,options):original(url,options);
      export default {id:real.id,async setup(ctx){
        await real.setup(ctx);
        await ctx.skill.transform(editor=>editor.add({id:'bayleaf-fixture',name:'bayleaf-fixture',
          description:'Synthetic update qualification',path:${JSON.stringify(join(root,'fixture-SKILL.md'))},content:'Revision ${revision}',autoinvoke:true}));
        ${revision==='b' ? `await ctx.tool.transform(editor=>editor.add({name:'bayleaf_fixture_new',description:'Synthetic new capability',input:{type:'object'},execute:async()=>({content:'revision b'})}));` : ''}
        await ctx.rpc.register({id:'bayleaf.fixture',events:{},methods:{
          inspect:{input:{type:'object'},output:{}},fetch:{input:{type:'object'},output:{}},
          validateExpose:{input:(await ctx.tool.list()).find(t=>t.id==='bayleaf_expose').input,output:{}}
        }},{
          inspect:async()=>JSON.parse(JSON.stringify({revision:${JSON.stringify(revision)},tools:(await ctx.tool.list()).map(t=>({id:t.id,input:t.input})),skills:await ctx.skill.list()})),
          validateExpose:async args=>args,
          fetch:async({sessionID,url,name='webfetch',args},{signal})=>{
            const tool=(await ctx.tool.list()).find(t=>t.id===name);
            try{return await tool.execute(args??{url},{sessionID,agent:'build',messageID:'msg_fixture',id:'call_fixture',signal,progress:async()=>{}});}
            catch(error){return {error:error.message};}
          }
        });
      }};
    `);
    if(process.argv.includes('--packages')) {
      const version=revision==='a'?'0.1.0':'0.1.1';
      const stage=join(root,'pack-'+revision);await mkdir(join(stage,'package'),{recursive:true});
      await writeFile(join(stage,'package/package.json'),JSON.stringify({name:packageName,version,type:'module',exports:{'.':'./index.mjs'}}));
      await writeFile(join(stage,'package/index.mjs'),await readFile(join(root,'plugin-'+revision,'index.mjs')));
      const archive=join(root,'package-'+version+'.tgz');
      const tar=spawn('tar',['-czf',archive,'-C',stage,'package']);
      const [code]=await once(tar,'exit');assert.equal(code,0);
      archives.set('/package-'+version+'.tgz',await readFile(archive));
    }
  }
  const target=revision=>process.argv.includes('--packages')?
    packageName+'@'+(revision==='a'?'0.1.0':'0.1.1'):join(root,'plugin-'+revision);
  config={plugins:['-opencode.tool.webfetch',target('a')],websearch:{provider:'bayleaf'}};
  // Exercise installation of the production Git target through the real loader.
  if(process.env.OPENCODE_TEST_GIT_PLUGIN) {
    config.plugins.splice(1,0,process.env.OPENCODE_TEST_GIT_PLUGIN);
    for(const revision of ['a','b']) {
      const path=join(root,'plugin-'+revision,'index.mjs');
      const source=await readFile(path,'utf8');
      await writeFile(path,source.replace('await real.setup(ctx);','')
        .replace('id:real.id','id:"bayleaf.fixture"'));
    }
  }
  child=spawn(binary,['serve','--hostname','127.0.0.1','--port',String(port)],{
    cwd:root,env:{...process.env,HOME:root,
      XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),
      XDG_CACHE_HOME:join(root,'cache'),XDG_STATE_HOME:join(root,'state'),
      npm_config_registry:origin,
      OPENCODE_PASSWORD:'synthetic-password',BAYLEAF_API_KEY:'sk-bayleaf-synthetic',BAYLEAF_OPENCODE_URL:endpoint},
    stdio:['ignore','pipe','pipe'],
  });
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  await wait(()=>api('/api/info').catch(error=>{if(child.exitCode!==null)throw new Error(logs.slice(-2000));throw error;}));
  await mkdir(join(root,'credentials'),{recursive:true});
  await writeFile(join(root,'credentials/owner-key'),'sk-bayleaf-synthetic');
  await writeFile(join(root,'credentials/opencode-password.json'),JSON.stringify('synthetic-password'));
  const operation='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await writeFile(join(root,'request.json'),JSON.stringify({operation,deadline:Math.floor(Date.now()/1000)+1200}));
  const installer=fileURLToPath(new URL('./browser-setup.py',import.meta.url));
  const bootstrap=async()=>{
    const process=spawn('python3',['-c',`
import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('installer',${JSON.stringify(installer)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.ROOT=Path(${JSON.stringify(root)})
m.Path.home=lambda:Path(${JSON.stringify(root)})
m.bootstrap(${port},${JSON.stringify(operation)},${JSON.stringify(origin)})
`],{stdio:['ignore','pipe','pipe']});
    let output='';process.stderr.on('data',d=>output+=d);
    const [code]=await once(process,'exit');assert.equal(code,0,output);
  };
  // OpenChamber can discover the workspace before bootstrap connects BayLeaf.
  assert.ok(!(await api('/api/plugin')).data.some(p=>p.id==='bayleaf.sandbox'));
  await bootstrap();await bootstrap();
  assert.equal((await api('/api/credential')).data.length,1,'repeated bootstrap duplicated credentials');
  assert.ok((await api('/api/plugin')).data.some(p=>p.id==='bayleaf.sandbox'&&p.state.status==='active'));
  const first=await wait(async()=>{const r=await rpc('inspect');return r.output.revision==='a'&&r;});
  assert.equal(first.output.tools.filter(t=>t.id==='webfetch').length,1);
  const skillData=first.output.skills.data??first.output.skills;
  assert.ok(skillData.some(s=>s.id==='bayleaf-sandboxes'));
  assert.ok(skillData.some(s=>s.id==='bayleaf-scheduling'&&s.description.includes('schedule.*')),
    'scheduling guidance must be discoverable from the installed plugin');
  assert.equal(skillData.find(s=>s.id==='bayleaf-fixture').content,'Revision a');
  assert.ok(!first.output.tools.some(t=>t.id==='bayleaf_fixture_new'));
  console.log('PASS real V2 bootstrap and tool/skill registration');
  const another=join(root,'another-project');await mkdir(another);
  await wait(async()=>{
    const plugins=await fetch(endpoint+'/api/plugin',{
      headers:{...headers,'X-Opencode-Directory':another},signal:AbortSignal.timeout(30000)}).then(r=>r.json());
    return plugins.data.some(p=>p.id==='bayleaf.sandbox'&&p.state.status==='active');
  });
  console.log('PASS distinct server default, pre-opened workspace and new-project registration');
  const search=await api('/api/websearch',{query:'synthetic query'});
  assert.ok(JSON.stringify(search).includes('Synthetic evidence'));
  console.log('PASS real V2 BayLeaf search provider');
  const create=permissions=>api('/api/session',{permissions});
  const allow=await create([{action:'webfetch',resource:'*',effect:'allow'}]);
  const allowID=allow.id??allow.data.id;
  assert.equal((await rpc('fetch',{sessionID:allowID,url:'https://example.test/page'})).output.content,'# Synthetic page');
  const deny=await create([{action:'webfetch',resource:'*',effect:'deny'}]);
  const before=webCalls;
  assert.match((await rpc('fetch',{sessionID:deny.id??deny.data.id,url:'https://example.test/page'})).output.error,/denied/);
  assert.equal(webCalls,before);
  for(const decision of ['once','reject']) {
    const session=await create([{action:'webfetch',resource:'*',effect:'ask'}]);
    const sessionID=session.id??session.data.id;
    const pending=rpc('fetch',{sessionID,url:'https://example.test/page'});
    const request=await wait(async()=>{const r=await api('/api/session/'+sessionID+'/permission');return r.data[0];});
    await api(`/api/session/${sessionID}/permission/${request.id}/reply`,{decision});
    const result=await pending;
    if(decision==='once')assert.equal(result.output.content,'# Synthetic page');
    else assert.match(result.output.error,/denied/);
  }
  console.log('PASS real V2 bootstrap, tool/skill registration, BayLeaf search, fetch allow/deny/ask/reject');
  if(first.output.tools.some(t=>t.id==='bayleaf_usage')) {
    for(const name of ['bayleaf_usage']) {
      const r=await rpc('fetch',{sessionID:allowID,name,args:{}});
      assert.ok(r.output.content);assert.ok(!r.output.error);
    }
    for(const name of ['bayleaf_expose','bayleaf_unexpose']) {
      const session=await create([{action:name,resource:'*',effect:'ask'}]);
      const sessionID=session.id??session.data.id;
      const pending=rpc('fetch',{sessionID,name,args:{port:8000}});
      const request=await wait(async()=>{const r=await api('/api/session/'+sessionID+'/permission');return r.data[0];});
      await api(`/api/session/${sessionID}/permission/${request.id}/reply`,{decision:'once'});
      const output=(await pending).output;
      assert.ok(output.content);assert.ok(!output.error);
    }
    console.log('PASS native usage and preview creation/revocation with real V2 permission approval');
    const schema=first.output.tools.find(t=>t.id==='bayleaf_expose').input;
    assert.equal(schema.properties.upstream_headers.type,'object');
    assert.equal(schema.properties.upstream_headers.additionalProperties.type,'string');
    const upstream_headers={Authorization:'Basic c3ludGhldGljOm9ubHk=','X-App-Key':'synthetic-app-key'};
    for(const access of ['private','public']) {
      const args={port:8000,access,upstream_headers};
      assert.deepEqual((await rpc('validateExpose',args)).output,args);
      for(const decision of ['once','reject']) {
        const session=await create([{action:'bayleaf_expose',resource:'*',effect:'ask'}]);
        const sessionID=session.id??session.data.id;
        const count=exposeCalls.length;
        exposeAck=true;
        const pending=rpc('fetch',{sessionID,name:'bayleaf_expose',args});
        const request=await wait(async()=>{const r=await api('/api/session/'+sessionID+'/permission');return r.data[0];});
        assert.equal(request.action,'bayleaf_expose');
        assert.deepEqual(request.resources,[`${access}:8000`]);
        assert.deepEqual(request.save,[`${access}:8000`]);
        assert.equal(exposeCalls.length,count,'preview sent before permission approval');
        assert.ok(!JSON.stringify(request).includes(upstream_headers.Authorization));
        await api(`/api/session/${sessionID}/permission/${request.id}/reply`,{decision});
        const output=(await pending).output;
        if(decision==='reject') {
          assert.match(output.error,/denied/);assert.equal(exposeCalls.length,count);
        } else {
          assert.equal(exposeCalls.length,count+1);
          assert.deepEqual(exposeCalls.at(-1).body,args);
          assert.equal(exposeCalls.at(-1).headers['x-app-key'],undefined,'application headers belong in the JSON body');
          assert.deepEqual(JSON.parse(output.content),{url:'https://fixture.bayleaf-proxies.dev/',
            expires_at:'2026-10-07T00:00:00Z',access,upstream_headers_applied:true});
          assert.ok(!output.content.includes(upstream_headers.Authorization));
        }
      }
    }
    await assert.rejects(()=>rpc('validateExpose',{port:8000,upstream_headers:{Authorization:123}}));
    await assert.rejects(()=>rpc('validateExpose',{port:8000,upstream_headers:[]}));
    console.log('PASS real V2 registered upstream_headers schema and private/public permission resources, approval/rejection, HTTP JSON body');
    const session=await create([{action:'bayleaf_expose',resource:'private:8000',effect:'allow'}]);
    const sessionID=session.id??session.data.id;
    for(const ack of [undefined,false,'true',1,null,{},[]]) {
      exposeAck=ack;
      const count=exposeCalls.length;
      const output=(await rpc('fetch',{sessionID,name:'bayleaf_expose',args:{port:8000,upstream_headers}})).output;
      assert.equal(exposeCalls.length,count+1);
      assert.equal(output.error,'Preview did not acknowledge upstream headers');
      assert.equal(output.content,undefined,'unacknowledged preview URL must not escape');
    }
    exposeAck=undefined;
    for(const args of [{port:8000},{port:8000,upstream_headers:{}}]) {
      const output=(await rpc('fetch',{sessionID,name:'bayleaf_expose',args})).output;
      assert.ok(output.content);assert.ok(!output.error);
      assert.deepEqual(exposeCalls.at(-1).body,{port:8000,access:'private'});
    }
    console.log('PASS real V2 exact-boolean upstream header acknowledgement fails closed; omitted/empty headers remain compatible');
  }
  const callsBefore=configCalls;
  config={...config,plugins:['-opencode.tool.webfetch',...(process.env.OPENCODE_TEST_GIT_PLUGIN?[process.env.OPENCODE_TEST_GIT_PLUGIN]:[]),target('b')]};
  if(process.argv.includes('--refresh')) {
    console.log('Waiting for the real 10-minute remote-config refresh, without restart');
    await wait(async()=>{const r=await rpc('inspect');return r.output.revision==='b';},660000);
  } else {
    await api('/api/location/reload',{});
    await wait(async()=>{const r=await rpc('inspect');return r.output.revision==='b';});
  }
  assert.ok(configCalls>callsBefore);
  const updated=(await rpc('inspect')).output;
  assert.ok(updated.tools.some(t=>t.id==='bayleaf_fixture_new'));
  assert.equal((updated.skills.data??updated.skills).find(s=>s.id==='bayleaf-fixture').content,'Revision b');
  assert.equal((await rpc('fetch',{sessionID:allowID,url:'https://example.test/page'})).output.content,'# Synthetic page');
  console.log('PASS remote revision swap and existing-session fetch after '+(process.argv.includes('--refresh')?'automatic refresh':'explicit reload'));
} finally {
  if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  await new Promise(resolve=>fixture.close(resolve));
  await rm(root,{recursive:true,force:true});
}
