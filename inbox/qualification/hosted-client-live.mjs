#!/usr/bin/env node
// Explicit opt-in: exact published Nanobot MCP against the production owner API.
// One synthetic HTTP inbox. No mail, inference, existing-content reads or hosted VM.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
if(!process.argv.includes('--live')||!process.env.BAYLEAF_API_KEY)throw new Error('Requires --live and private BAYLEAF_API_KEY environment');
const key=process.env.BAYLEAF_API_KEY, base='https://api.bayleaf.dev';
const pin='16ee3c3ba44f6ae64d6847e64a79fa7949c18c2a';
const candidate=process.env.HOSTED_ADAPTER_ROOT;
const root=await mkdtemp('/private/var/folders/qj/gyqbn5y57956rrqd_g6yfqwr0000gn/T/opencode/hosted-client-live-');
let inbox,client,sequence=0;
async function request(path,method='GET',body,credential=key){return fetch(base+path,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
async function owner(path,method='GET',body){const r=await request(path,method,body);assert.ok(r.ok,`owner HTTP ${r.status}`);return r.json();}
async function stop(){if(client&&client.exitCode===null&&client.signalCode===null){client.kill('SIGTERM');await once(client,'exit');}}
function start(){client=spawn('node',[join(root,'managed/adapter/nanobot-mcp.mjs')],{env:{...process.env,HOME:root},stdio:['pipe','pipe','ignore']});let buffer='',id=0;const pending=new Map();client.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),r=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(r.id)?.(r.result);pending.delete(r.id);}});return (method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('MCP timeout'));},40000);pending.set(n,r=>{clearTimeout(timer);resolve(r)});client.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});}
try{
  for(const d of ['managed/adapter','managed/credentials','workspace'])await mkdir(join(root,d),{recursive:true});
  const source=fileURLToPath(new URL('../../api/nanobot-sandbox',import.meta.url));
  await writeFile(join(root,'managed/adapter/nanobot-mcp.mjs'),candidate?await readFile(join(candidate,'nanobot-sandbox/nanobot-mcp.mjs')):execFileSync('git',['-C',source,'show',pin+':nanobot-mcp.mjs']));
  await writeFile(join(root,'managed/credentials/owner-key'),key,{mode:0o600});
  let rpc=start();await rpc('initialize');const tools=(await rpc('tools/list')).tools;
  assert.equal(tools.filter(t=>t.name.startsWith('inbox')).length,candidate?9:6);
  const call=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});assert.ok(!r.isError,`MCP ${name} failed: ${r.isError?r.content.map(c=>c.text).join(' '):''}`);return r.content.map(c=>c.text).join('\n');};
  if(candidate){const limits=JSON.parse(await call('inbox_limits',{}));assert.equal(limits.owner.max_inboxes,100);assert.ok(limits.owner.remaining_inboxes>0);console.log('PASS native MCP authoritative limits and available capacity');}
  inbox=JSON.parse(await call('inbox_create',{type:'http',label:'Hosted-client bounded qualification',...(candidate?{ttl_seconds:120}:{})}));
  assert.match(inbox.id,/^ibx_[a-z2-7]{26}$/);
  if(candidate)assert.ok(Number.isSafeInteger(inbox.expires_at));
  const timed=candidate?JSON.parse(await call('inbox_lifetime',{inbox_id:inbox.id,ttl_seconds:60})):await owner('/inboxes/'+inbox.id,'PATCH',{ttl_seconds:60});
  const checkpoint=candidate?JSON.parse(await call('inbox_events',{inbox_id:inbox.id,after:'now'})):null;
  if(candidate){assert.equal(checkpoint.events.length,0);assert.equal(checkpoint.more,false);}
  const minted=await owner('/inboxes/'+inbox.id+'/credentials','POST',{name:'synthetic qualification',expires_at:timed.expires_at});
  const sender=minted.token;
  const wrongOwner=await request('/inboxes/'+inbox.id,'GET',undefined,sender);assert.equal(wrongOwner.status,401);await wrongOwner.body?.cancel();
  async function send(token=sender){const body=JSON.stringify({synthetic:'hosted adapter qualification',sequence:++sequence});const r=await fetch(inbox.url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});const status=r.status;await r.body?.cancel();return {status,body};}
  assert.equal((await send(key)).status,401);
  const first=await send();assert.equal(first.status,200);
  if(candidate){const page=JSON.parse(await call('inbox_events',{inbox_id:inbox.id,after:checkpoint.cursor,limit:1}));assert.equal(page.events.length,1);assert.equal(page.events[0].type,'message.received');checkpoint.cursor=page.cursor;}
  const messages=await owner('/inboxes/'+inbox.id+'/messages');const mid=messages.messages[0].id;
  assert.ok((await call('inbox_read',{inbox_id:inbox.id,message_id:mid})).includes('untrusted_inbox_content'));
  const raw=await request('/inboxes/'+inbox.id+'/messages/'+mid+'/body');
  assert.match(raw.headers.get('content-disposition'),/^attachment/);assert.equal(raw.headers.get('x-content-type-options'),'nosniff');assert.equal(raw.headers.get('content-security-policy'),'sandbox');await raw.body?.cancel();
  await call('inbox_save',{inbox_id:inbox.id,message_id:mid,path:'receipt.json'});
  assert.equal(await readFile(join(root,'workspace/inbox-downloads/receipt.json'),'utf8'),first.body);
  assert.equal((await stat(join(root,'workspace/inbox-downloads/receipt.json'))).mode&0o777,0o600);
  await call('inbox_archive',{inbox_id:inbox.id,message_id:mid,archived:true});
  assert.equal((await owner('/inboxes/'+inbox.id+'/messages')).messages.length,0);
  console.log(`PASS ${candidate?'candidate':'published'} Nanobot MCP live create/read/archive/quarantine; sender-owner separation; inert HTTP download headers`);
  await stop();assert.equal((await send()).status,200);rpc=start();await rpc('initialize');
  assert.ok((await call('inbox_messages',{inbox_id:inbox.id})).includes('untrusted_inbox_content'));
  assert.equal((await owner('/inboxes/'+inbox.id+'/messages')).messages.length,1);
  if(candidate){const resumed=JSON.parse(await call('inbox_events',{inbox_id:inbox.id,after:checkpoint.cursor}));assert.equal(resumed.events.length,1);assert.notEqual(resumed.events[0].message_id,mid);console.log('PASS native adapter TTL creation/shortening, expiry readback and finite-event cursor resume across process shutdown');}
  console.log('PASS receipt while MCP process is off; fresh MCP restart can retrieve it (not hosted-machine sleep)');
  await new Promise(r=>setTimeout(r,Math.max(0,timed.expires_at*1000-Date.now()+1100)));
  const expired=await rpc('tools/call',{name:'inbox_read',arguments:{inbox_id:inbox.id,message_id:mid}});assert.ok(expired.isError);
  assert.equal((await send()).status,404);
  console.log(`PASS actual 60-second TTL denies adapter content and sender delivery; TTL set by ${candidate?'adapter':'direct API'}`);
  console.log(JSON.stringify({pin:candidate?(process.env.HOSTED_ADAPTER_REVISION||'unpublished candidate source'):pin,platform:process.platform,liveAPI:true,hostedClient:false,inference:false}));
}finally{
  try{
    await stop();
    if(inbox){const r=await request('/inboxes/'+inbox.id,'DELETE');assert.ok([200,202,404].includes(r.status),`cleanup HTTP ${r.status}`);await r.body?.cancel();console.log('CLEANUP exact synthetic inbox destruction acknowledged; physical finalization asynchronous');}
  }finally{
    await rm(root,{recursive:true,force:true});console.log('CLEANUP private local credentials, downloaded bytes and MCP runtime removed');
  }
}
