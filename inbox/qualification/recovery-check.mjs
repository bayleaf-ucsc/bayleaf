#!/usr/bin/env node
// Local-only recovery drill. No Wrangler, credentials, persistent store or remote target.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

assert.equal(process.argv.length, 2, 'This drill accepts no remote target or arguments');
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = async contents => (await build({ absWorkingDir: root, stdin: { resolveDir: root, contents },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:*'] })).outputFiles[0].text;
const api = await bundle(`
  import { inboxRoutes } from './api/src/routes/inboxes';
  import { cleanupRetiredInboxes } from './api/src/userRetention';
  export default { async fetch(req,env,ctx) {
    const p=new URL(req.url).pathname;
    if(p==='/__rpc') { const {method,args}=await req.json(); return Response.json(await env.INBOXES[method](...args)); }
    if(p==='/__reconcile') {
      const {lostAck}=await req.json();
      const binding=lostAck?{retireOwner:async owner=>{await env.INBOXES.retireOwner(owner);throw Error('lost ack');}}:env.INBOXES;
      return Response.json(await cleanupRetiredInboxes({...env,INBOXES:binding},Math.floor(Date.now()/1000)));
    }
    return inboxRoutes.fetch(req,env,ctx);
  }};
`);
const receiver = await bundle(`
  import worker from './inbox/src/worker.js';
  export { InboxManagement } from './inbox/src/worker.js';
  export default {...worker, async fetch(req,env,ctx) {
    const blobs=new Proxy(env.BLOBS,{get(target,key){
      if(key==='put') return async (...args)=>{await env.PUT_GATE.fetch('https://gate.invalid/');return target.put(...args);};
      const value=target[key]; return typeof value==='function'?value.bind(target):value;
    }});
    return worker.fetch(req,{...env,BLOBS:blobs},ctx);
  }};
`);
let gate;
const noNet = () => { throw Error('Outbound network forbidden'); };
const options = enabled => convertV4MiniflareOptions({ workers: [
  { name:'api', modules:true, script:api, compatibilityDate:'2026-08-01', d1Databases:{DB:'recovery-api'},
    bindings:{INBOXES_ENABLED:String(enabled),INBOX_STREAM_POLL_MS:'50'}, outboundService:noNet,
    serviceBindings:{INBOXES:{name:'inbox',entrypoint:'InboxManagement'}} },
  { name:'inbox', modules:true, script:receiver, compatibilityDate:'2026-08-01', compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'recovery-inbox'}, r2Buckets:['BLOBS'], bindings:{INBOXES_ENABLED:String(enabled)}, outboundService:noNet,
    serviceBindings:{PUT_GATE:async()=>{if(gate){gate.started();await gate.wait;}return new Response('ok');}},
    ratelimits:{ACCEPT_LIMIT:{namespace_id:'1',simple:{limit:60,period:60}},REJECT_LIMIT:{namespace_id:'2',simple:{limit:30,period:60}}} },
] });
const mf = new Miniflare(options(true));
const token='sk-bayleaf-synthetic-recovery', owner=randomUUID();
let db, inboxDB, blobs;
const call = async (path, init={}) => (await mf.getWorker('api')).fetch('https://recovery.invalid'+path,
  {...init,headers:{Authorization:'Bearer '+token,...init.headers}});
const control = async (path,body) => (await call(path,{method:'POST',body:JSON.stringify(body)})).json();
const rpc = (method,...args) => control('/__rpc',{method,args});
const send = async box => (await mf.getWorker('inbox')).fetch(box.url,{method:'POST',body:'synthetic raw recovery payload'});
const snapshot = async target => {
  const {results:tables}=await target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
  return Promise.all(tables.map(async ({name})=>({name,rows:(await target.prepare(`SELECT * FROM "${name}"`).all()).results})));
};
const restore = async (target,snap) => {
  // Real D1 rows, including credentials, metadata, event epoch and both ledgers.
  const statements=snap.map(({name})=>target.prepare(`DELETE FROM "${name}"`));
  for(const {name,rows} of snap) for(const row of rows) statements.push(target.prepare(
    `INSERT INTO "${name}" (${Object.keys(row).map(k=>'"'+k+'"').join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)));
  await target.batch(statements);
};
const status = async (path,expected) => {const r=await call(path);assert.equal(r.status,expected,await r.text());};
try {
  db=await mf.getD1Database('DB','api'); inboxDB=await mf.getD1Database('DB','inbox'); blobs=await mf.getR2Bucket('BLOBS','inbox');
  for(const [dir,target] of [['api',db],['inbox',inboxDB]]) for(const file of (await readdir(root+dir+'/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    const sql=(await readFile(root+dir+'/migrations/'+file,'utf8')).replace(/^\s*--.*$/gm,'');
    for(const stmt of sql.match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g)||[]) await target.prepare(stmt.trim()).run();
  }
  await db.prepare('INSERT INTO user_keys(email,bayleaf_token,account_generation) VALUES (?,?,?)').bind('recovery@example.test',token,owner).run();
  const box=await rpc('createInbox',owner,{type:'http'});
  const orphan=randomUUID(), orphanBox=await rpc('createInbox',orphan,{type:'http'});
  assert.ok(orphanBox.id);
  assert.ok(box.id); assert.equal((await send(box)).status,200);
  const mid=(await rpc('listMessages',owner,box.id,{})).messages[0].id;
  const paths=[`/${box.id}/messages`,...['','/body','/text','/har'].map(s=>`/${box.id}/messages/${mid}${s}`),`/${box.id}/export`,`/${box.id}/events`];
  for(const path of paths) await status(path,200);
  const apiBefore=await snapshot(db), inboxBefore=await snapshot(inboxDB);
  const objectKey=`m/${box.id}/${mid}`, raw=await (await blobs.get(objectKey)).arrayBuffer();
  const denied=async()=>{for(const path of paths) await status(path,404);assert.equal((await send(box)).status,404);};
  const offline=async()=>{for(const path of paths) await status(path,404);assert.equal((await send(box)).status,503);};
  const configure=async enabled=>{await mf.setOptions(options(enabled));
    db=await mf.getD1Database('DB','api');inboxDB=await mf.getD1Database('DB','inbox');blobs=await mf.getR2Bucket('BLOBS','inbox');};
  const disable=async()=>{await configure(false);await offline();};
  const enable=async()=>{await configure(true);};

  // An already open SSE observes the real fence, even with restored API identity.
  const stream=await call(`/${box.id}/events/stream?after=now`);
  assert.equal(stream.status,200);
  const reader=stream.body.getReader(); const decoder=new TextDecoder();
  let frames=''; while(!frames.includes('event: ready')) frames+=decoder.decode((await reader.read()).value);
  await db.prepare('INSERT INTO inbox_retirements(generation,retired_at) VALUES (?,unixepoch())').bind(owner).run();
  assert.equal(await control('/__reconcile',{lostAck:true}),1);
  assert.equal((await db.prepare('SELECT fenced_at FROM inbox_retirements').first()).fenced_at,null);
  const timeout=setTimeout(()=>reader.cancel(),6000);
  try {for(;;){const chunk=await reader.read();if(chunk.done)break;frames+=decoder.decode(chunk.value);}}
  finally {clearTimeout(timeout);}
  assert.match(frames,/event: end/);assert.match(frames,/not_found|auth_revoked/);
  assert.equal(await control('/__reconcile',{}),0); await denied();
  console.log('PASS lost acknowledgement retry; HTTP read/text/HAR/export/events and active SSE fence');

  await disable(); await restore(db,apiBefore); await offline(); await enable(); await denied();
  console.log('PASS API-only rollback restores old credential/generation but surviving receiver fence denies access');
  // Reconstitute the surviving API ledger for the independent inbox-only drill.
  await db.prepare('INSERT INTO inbox_retirements(generation,retired_at,fenced_at) VALUES (?,unixepoch(),unixepoch())').bind(owner).run();
  await disable(); await restore(inboxDB,inboxBefore); await offline();
  // Explicit complete enumeration, not pending=0 or checked_at.
  for(const {generation} of (await db.prepare('SELECT generation FROM inbox_retirements ORDER BY generation').all()).results)
    assert.deepEqual(await rpc('retireOwner',generation),{retired:true});
  await enable(); await denied();
  console.log('PASS inbox-only rollback: disabled replay of every surviving acknowledged ledger entry');

  await disable(); await restore(db,apiBefore); await restore(inboxDB,inboxBefore); await offline();
  // Deliberate negative control in this disposable simulation only.
  await enable(); await status(`/${box.id}/messages/${mid}/body`,200);
  assert.equal((await send(box)).status,200);
  console.log('PASS negative control: reopening both rolled-back ledgers really resurrects content and reception');
  await disable();
  // No external deletion ledger: invalidate ALL restored owner generations,
  // including orphan inbox owners, before assigning fresh API identities.
  const generations=new Set([
    ...(await db.prepare('SELECT account_generation AS generation FROM user_keys').all()).results.map(r=>r.generation),
    ...(await inboxDB.prepare('SELECT DISTINCT owner AS generation FROM inboxes').all()).results.map(r=>r.generation),
    ...(await db.prepare('SELECT generation FROM inbox_retirements').all()).results.map(r=>r.generation),
    ...(await inboxDB.prepare('SELECT owner AS generation FROM retired_owners').all()).results.map(r=>r.generation),
  ]);
  for(const generation of generations) {
    assert.match(generation,/^[A-Za-z0-9-]{16,128}$/);
    await db.prepare('INSERT OR IGNORE INTO inbox_retirements(generation,retired_at) VALUES (?,unixepoch())').bind(generation).run();
    assert.deepEqual(await rpc('retireOwner',generation),{retired:true});
  }
  const fresh=randomUUID();
  const rotated=await db.prepare('UPDATE user_keys SET account_generation=? WHERE account_generation=?').bind(fresh,owner).run();
  assert.equal(rotated.meta.changes,1);
  await enable(); await denied();
  assert.deepEqual(await rpc('getInbox',orphan,orphanBox.id),{error:'not_found'});
  assert.equal((await send(orphanBox)).status,404);
  const newBox=await rpc('createInbox',fresh,{type:'http'}); assert.ok(newBox.id);
  assert.equal((await send(newBox)).status,200);
  await blobs.delete(objectKey); await blobs.put(objectKey,raw);
  assert.ok(await blobs.head(objectKey)); await denied();
  await db.prepare('UPDATE user_keys SET account_generation=?').bind(owner).run();
  await denied();
  console.log('PASS both-ledger recovery: fence union, fresh identity, raw-blob reappearance, stale generation reintroduced');

  // Pause a real receiver after reservation, before its real R2 put completes.
  let started,release;const entered=new Promise(r=>started=r),wait=new Promise(r=>release=r);
  gate={started,wait};const inflight=send(newBox);await entered;
  assert.deepEqual(await rpc('retireOwner',fresh),{retired:true});release();
  assert.equal((await inflight).status,404);gate=null;
  assert.equal((await rpc('listMessages',fresh,newBox.id,{})).error,'not_found');
  assert.equal((await blobs.list({prefix:`m/${newBox.id}/`})).objects.length,1,'only earlier committed object remains for asynchronous cleanup');
  console.log('PASS actual reserved write crossing retirement cannot commit stored receipt or retain its late object');
} finally { gate?.started(); await mf.dispose(); }
