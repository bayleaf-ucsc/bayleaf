#!/usr/bin/env node
/** Real isolated OpenCode V2, genuine stdio MCP, synthetic API. No inference. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = await mkdtemp('/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/shared-mcp-');
let child, logs='';
const probe = createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening');
const port = probe.address().port; await new Promise(resolve=>probe.close(resolve));
const url = `http://127.0.0.1:${port}`;
const headers = {authorization:'Basic '+Buffer.from('opencode:fixture-password').toString('base64'),
  'content-type':'application/json','X-Opencode-Directory':root};
const api = async (path, body) => {
  const r = await fetch(url+path,{headers,method:body===undefined?'GET':'POST',
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if (!r.ok) throw new Error(`HTTP ${r.status} at ${path}: ${(await r.text()).slice(0,1000)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : undefined;
};
async function wait(fn) {
  const until=Date.now()+45000; let error;
  while(Date.now()<until) {
    try { const value=await fn(); if(value)return value; } catch(e) { error=e; }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw error??new Error('runtime timeout');
}
const rpc=(method,input={})=>api('/api/rpc/shared.fixture/'+method,{input});
try {
  for (const folder of ['config/opencode','data','state','cache','plugin']) await mkdir(join(root,folder),{recursive:true});
  const fixture=join(root,'stdio.mjs');
  await build({entryPoints:['sandbox-cli/stdio-fixture.ts'],outfile:fixture,bundle:true,platform:'node',format:'esm',target:'node22',
    banner:{js:'import { createRequire } from "node:module";const require=createRequire(import.meta.url);'}});
  const plugin=fileURLToPath(new URL('../sandbox-plugin/index.mjs',import.meta.url));
  await writeFile(join(root,'plugin/package.json'),JSON.stringify({type:'module',exports:{'.':'./index.mjs'}}));
  await writeFile(join(root,'plugin/index.mjs'),`
    import real from ${JSON.stringify(pathToFileURL(plugin).href)};
    export default {id:'shared.fixture',async setup(ctx){
      await real.setup(ctx);
      await ctx.rpc.register({id:'shared.fixture',events:{},methods:{inspect:{input:{type:'object'},output:{}},call:{input:{type:'object'},output:{}}}}, {
        inspect:async()=>JSON.parse(JSON.stringify({tools:(await ctx.tool.list()).map(t=>({id:t.id,description:t.description,input:t.input})),skills:await ctx.skill.list(),version:ctx.app.version})),
        call:async({name,args={},sessionID},{signal})=>{
          const tool=(await ctx.tool.list()).find(t=>t.id===name);
          return JSON.parse(JSON.stringify(await tool.execute(args,{sessionID,agent:'build',messageID:'msg_fixture',id:'call_fixture',signal,progress:async()=>{}})));
        }
      });
    }};
  `);
  const skill=fileURLToPath(new URL('../sandbox-cli/',import.meta.url));
  await writeFile(join(root,'config/opencode/opencode.json'),JSON.stringify({update:'disable',
    plugins:['-opencode.tool.webfetch',join(root,'plugin')],skills:[skill],
    mcp:{servers:{sandbox:{type:'local',command:[process.execPath,fixture,join(root,'computer-state')],codemode:false,
      environment:{BAYLEAF_TEST_GROUPS:'computer,inboxes,previews'}}}},
    permissions:[{action:'sandbox_*',resource:'*',effect:'ask'},
      ...['open_session','screenshot'].map(name=>({action:'sandbox_'+name,resource:'*',effect:'allow'}))]}));
  child=spawn(process.env.OPENCODE_TEST_BINARY??'opencode',['serve','--hostname','127.0.0.1','--port',String(port)],{
    cwd:root,env:{...process.env,HOME:root,XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),
      XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_PASSWORD:'fixture-password',
      BAYLEAF_SHARED_MCP:'true',BAYLEAF_INBOXES_ENABLED:'true',BAYLEAF_API_KEY:'dtn_secret_fixture'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  await wait(()=>api('/api/info'));
  const inventory=(await wait(async()=>{const r=await rpc('inspect');return r.output.tools.some(t=>t.id==='sandbox_click')&&r;})).output;
  assert.equal(inventory.tools.filter(t=>t.id.startsWith('sandbox_')).length,28);
  for(const name of ['bayleaf_expose','bayleaf_unexpose','bayleaf_inboxes','bayleaf_inbox_read'])assert(!inventory.tools.some(t=>t.id===name));
  for(const name of ['bayleaf_usage','bayleaf_inbox_save','bayleaf_inbox_delete_message','bayleaf_inbox_destroy','webfetch'])assert(inventory.tools.some(t=>t.id===name));
  const skills=inventory.skills.data??inventory.skills;
  assert(skills.some(s=>s.id==='bayleaf-scheduling'));
  assert(skills.some(s=>s.name==='bayleaf-sandbox-orientation'));
  assert(!skills.some(s=>['bayleaf-sandboxes','bayleaf-inboxes'].includes(s.id)));
  console.log('PASS shared tool/skill inventory and duplicate suppression');
  // AX structural scenario: an agent asked to inspect and click a dialog sees
  // self-contained screenshot/click descriptions, without loading curl recipes.
  for(const name of ['sandbox_screenshot','sandbox_click'])assert.match(inventory.tools.find(t=>t.id===name).description,/Desktop|desktop/);
  const session=await api('/api/session',{}),sessionID=session.id??session.data.id;
  await rpc('call',{name:'sandbox_open_session',sessionID});
  const screen=(await rpc('call',{name:'sandbox_screenshot',sessionID})).output;
  assert.match(JSON.stringify(screen),/image\/png|"type":"image"/);
  console.log('PASS real stdio open-session and native image conversion');
  // Execute via the real MCP tool definition, not a hand-made permission shim.
  const pending=rpc('call',{name:'sandbox_click',args:{x:1,y:1},sessionID});
  pending.catch(()=>{}); // Cleanup may close a still-waiting RPC after assertion failure.
  const approval=await wait(async()=>{const r=await api(`/api/session/${sessionID}/permission`);return r.data[0];});
  assert.equal(approval.action??approval.permission,'sandbox_click',JSON.stringify(approval));
  await api(`/api/session/${sessionID}/permission/${approval.id}/reply`,{decision:'once'});
  await pending;
  assert(!logs.includes('dtn_secret_fixture'));
  console.log(`PASS OpenCode ${inventory.version}: 28 shared tools, retained native extras, one orientation + scheduling, native image conversion and click approval; AX discovery structure only`);
} catch(error) {
  console.error(logs.replaceAll('dtn_secret_fixture','[redacted]').slice(-4000));
  throw error;
} finally {
  if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  await rm(root,{recursive:true,force:true});
}
