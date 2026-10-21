#!/usr/bin/env node
// Local retirement handoff regression, preserving the pre-fence gap demonstration.
// Runs the real API retirement transaction and inbox RPC against separate D1s.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = async contents => (await build({ absWorkingDir: root, stdin: { resolveDir: root, contents },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:*'] })).outputFiles[0].text;
const api = await bundle(`
  import { retireInactiveUser, accountCutoff, cleanupRetiredInboxes } from './api/src/userRetention';
  import { inboxRoutes } from './api/src/routes/inboxes';
  export default { async fetch(req,env) {
    const p = await req.json();
    if(p.facade) {
      const r=await inboxRoutes.fetch(new Request('https://test.invalid'+p.path,{
        headers:{Authorization:'Bearer sk-bayleaf-synthetic-original'}
      }),{...env,INBOXES_ENABLED:'true'});
      return Response.json({status:r.status,...(r.status===413?{error:await r.json()}:{bytes:(await r.arrayBuffer()).byteLength})});
    }
    if(p.reconcile) {
      const binding=p.missing?undefined:p.lostAck?{retireOwner:async owner=>{
        await env.INBOXES.retireOwner(owner);throw new Error('synthetic lost acknowledgement');
      }}:env.INBOXES;
      return Response.json(await cleanupRetiredInboxes({...env,INBOXES:binding,INBOXES_ENABLED:'false'},p.now));
    }
    if(p.retire) return Response.json(await retireInactiveUser(env,p.user,p.now,accountCutoff(p.now)));
    if(p.deliver) {
      const headers = new Headers({Host:new URL(p.url).host,Authorization:'Bearer '+p.token});
      return env.RECEIVER.fetch(new Request(p.url,{method:'POST',body:'synthetic',headers}));
    }
    return Response.json(await env.INBOXES[p.method](...p.args));
  }};
`);
const inbox = await bundle(`export {default,InboxManagement} from './inbox/src/worker.js';`);
const noNet = () => { throw new Error('no outbound network'); };
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  { name: 'api', modules: true, script: api, compatibilityDate: '2026-08-01', d1Databases: { DB: 'api-db' },
    serviceBindings: { INBOXES: { name: 'inbox', entrypoint: 'InboxManagement' }, RECEIVER: 'inbox' }, outboundService: noNet },
  { name: 'inbox', modules: true, script: inbox, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'inbox-db' },
    r2Buckets: ['BLOBS'], bindings: { INBOXES_ENABLED: 'true' }, outboundService: noNet,
    ratelimits: { ACCEPT_LIMIT: { namespace_id: '1', simple: { limit: 60, period: 60 } },
      REJECT_LIMIT: { namespace_id: '2', simple: { limit: 30, period: 60 } } } },
] }));
try {
  const apiDB = await mf.getD1Database('DB', 'api');
  const inboxDB = await mf.getD1Database('DB', 'inbox');
  for (const [dir, db] of [['api', apiDB], ['inbox', inboxDB]]) {
    for (const file of (await readdir(root + dir + '/migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = (await readFile(root + dir + '/migrations/' + file, 'utf8')).replace(/^\s*--.*$/gm, '');
      const parts = sql.match(/\s*(?:CREATE TRIGGER[\s\S]*?END|[^;]+);/g) || [];
      for (const stmt of parts.map(s => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
    }
  }
  const worker = await mf.getWorker('api');
  const request = async body => (await worker.fetch('https://test.invalid/', { method: 'POST', body: JSON.stringify(body) })).json();
  const rpc = (method, ...args) => request({ method, args });
  const old = Date.parse('2024-01-01T00:00:00Z') / 1000;
  const now = Date.parse('2026-10-21T12:00:00Z') / 1000;
  const email = 'synthetic@example.test', owner = 'synthetic-original-generation', fresh = 'synthetic-recreated-generation';
  await apiDB.prepare('INSERT INTO users(email,created_at,last_active_at) VALUES (?,?,?)').bind(email, old, old).run();
  await apiDB.prepare('INSERT INTO user_keys(email,bayleaf_token,account_generation) VALUES (?,?,?)')
    .bind(email, 'sk-bayleaf-synthetic-original', owner).run();
  const box = await rpc('createInbox', owner, { type: 'http' });
  const credential = await rpc('createCredential', owner, box.id, {});
  assert.ok(credential.token);
  // Exercise the real HTTP facade too, without importing unrelated adapters or
  // manufacturing deployable generated assets in this isolated worktree.
  const mail = await rpc('createInbox', owner, { type: 'email' });
  const message = 'msg_' + 'b'.repeat(26), raw = 'Content-Type: text/plain\r\n\r\n' + '\n'.repeat(350001);
  const clock = Math.floor(Date.now()/1000);
  await inboxDB.batch([
    inboxDB.prepare(`INSERT INTO messages(id,inbox_id,state,received_at,expires_at,size,meta_json)
      VALUES (?,?,'stored',?,?,?,?)`).bind(message,mail.id,clock,clock+3600,raw.length,
        JSON.stringify({type:'email',parse_error:false,attachments:[{index:0}]})),
    inboxDB.prepare('UPDATE inboxes SET message_count=1,bytes_stored=? WHERE id=?').bind(raw.length,mail.id),
  ]);
  await (await mf.getR2Bucket('BLOBS','inbox')).put(`m/${mail.id}/${message}`,raw);
  for(const suffix of ['text','attachments/0']) {
    const r=await request({facade:true,path:`/${mail.id}/messages/${message}/${suffix}`});
    assert.equal(r.status,413);
    assert.equal(r.error.error.code,413);
  }
  const original=await request({facade:true,path:`/${mail.id}/messages/${message}/body`});
  assert.equal(original.status,200);
  assert.equal(original.bytes,raw.length);
  // Restore synthetic inactivity after the authenticated facade probes.
  await apiDB.prepare('UPDATE users SET last_active_at=? WHERE email=?').bind(old,email).run();
  const result = await request({ retire: true, user: { email, created_at: old, last_active_at: old }, now });
  assert.equal(result, true);
  assert.equal(await apiDB.prepare('SELECT email FROM user_keys WHERE email=?').bind(email).first(), null);
  assert.equal((await rpc('getInbox', owner, box.id)).state, 'active', 'retirement does not destroy the inbox');
  assert.deepEqual(await request({ deliver: true, url: box.url, token: credential.token }), { ok: true },
    'old sender credential still accepts mail after account retirement');
  assert.equal((await rpc('listMessages', owner, box.id, {})).messages.length, 1);
  assert.equal((await apiDB.prepare('SELECT generation FROM inbox_retirements').first()).generation, owner);
  assert.equal(await request({ reconcile: true, missing: true, now }), 1, 'binding outage retains pending work');
  assert.equal(await request({ reconcile: true, lostAck: true, now }), 1, 'lost ack retains pending work after fencing');
  assert.deepEqual(await rpc('getInbox', owner, box.id), { error: 'not_found' });
  assert.deepEqual(await request({ deliver: true, url: box.url, token: credential.token }), { error: 'not_found' });
  assert.equal((await inboxDB.prepare('SELECT COUNT(*) AS n FROM credentials').first()).n, 0);
  assert.equal(await request({ reconcile: true, now }), 0);
  assert.ok((await apiDB.prepare('SELECT fenced_at FROM inbox_retirements').first()).fenced_at);
  // Model the account-generation effect of provisionToken's fresh INSERT, without
  // calling providers or pretending this is an end-to-end OIDC recovery test.
  await apiDB.prepare('INSERT INTO user_keys(email,bayleaf_token,account_generation) VALUES (?,?,?)')
    .bind(email, 'synthetic-fresh-token', fresh).run();
  assert.deepEqual(await rpc('getInbox', fresh, box.id), { error: 'not_found' });
  // An API-only recovery cannot defeat the surviving inbox fence.
  await apiDB.prepare('UPDATE user_keys SET account_generation=? WHERE email=?').bind(owner, email).run();
  const restored = (await apiDB.prepare('SELECT account_generation FROM user_keys WHERE email=?').bind(email).first()).account_generation;
  assert.deepEqual(await rpc('listMessages', restored, box.id, {}), { error: 'not_found' });
  assert.deepEqual(await rpc('createInbox', owner, { type: 'http' }), { error: 'not_found' });
  assert.ok((await rpc('createInbox', fresh, { type: 'http' })).id);
  // Simulate inbox-only rollback. Never enable a real recovered service before
  // replaying this separate API ledger. Acknowledged entries must be replayable.
  await inboxDB.prepare('DELETE FROM retired_owners WHERE owner=?').bind(owner).run();
  await inboxDB.prepare("UPDATE inboxes SET state='active',destroy_requested_at=NULL WHERE id=?").bind(box.id).run();
  assert.equal(await request({ reconcile: true, now: now + 1 }), 0);
  assert.deepEqual(await rpc('getInbox', owner, box.id), { error: 'not_found' });
  assert.equal((await inboxDB.prepare('SELECT COUNT(*) AS n FROM retired_owners WHERE owner=?').bind(owner).first()).n, 1);
  assert.equal((await apiDB.prepare('SELECT COUNT(*) AS n FROM inbox_retirements').first()).n, 1, 'ledger survives acknowledgement');
  for (let i=0;i<45;i++) await apiDB.prepare('INSERT INTO inbox_retirements(generation,retired_at) VALUES (?,?)')
    .bind(`pending-retirement-${String(i).padStart(3,'0')}`,now).run();
  await request({reconcile:true,missing:true,now:now+2});
  assert.equal((await apiDB.prepare('SELECT COUNT(*) AS n FROM inbox_retirements WHERE fenced_at IS NULL AND checked_at>0').first()).n,20);
  await request({reconcile:true,missing:true,now:now+3});
  assert.equal((await apiDB.prepare('SELECT COUNT(*) AS n FROM inbox_retirements WHERE fenced_at IS NULL AND checked_at>0').first()).n,40,
    'unavailable early entries yield to later pending generations');
  for(let i=0;i<3;i++) await request({reconcile:true,now:now+4+i});
  assert.equal((await apiDB.prepare('SELECT COUNT(*) AS n FROM inbox_retirements WHERE fenced_at IS NULL').first()).n,0);
  console.log('PASS: transactional generation capture; outage/lost-ack retry; sender/read/create revocation; fresh owner isolation; API restore fence and inbox restore replay.');
} finally { await mf.dispose(); }
