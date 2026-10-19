#!/usr/bin/env node
/** Credential-free real D1 retirement transactions and synthetic provider failures. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const now = Date.parse('2026-10-19T12:34:56Z')/1000;
const bundle = await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
  import { cleanupInactiveUsers, retireInactiveUser, accountCutoff } from './src/userRetention';
  export default {async fetch(req,env) {
    const {mode,now,user} = await req.json();
    if(user) {
      try { return Response.json(await retireInactiveUser(env,user,now,accountCutoff(now))); }
      catch { return Response.json({transactionFailed:true}); }
    }
    return Response.json(await cleanupInactiveUsers({...env,USER_RETENTION_MODE:mode},now));
  }};
`},bundle:true,write:false,format:'esm',platform:'browser'});
let providerCalls = [], failTinfoil = true;
const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,
  compatibilityDate:'2026-08-01',d1Databases:['DB'],
  bindings:{OPENROUTER_PROVISIONING_KEY:'synthetic-or-admin',TINFOIL_ADMIN_KEY:'synthetic-tf-admin'},
  outboundService: async req => {
    providerCalls.push({url:req.url,method:req.method});
    assert.equal(req.method,'DELETE');
    const tinfoil = req.url.includes('tinfoil');
    assert.equal(req.headers.get('Authorization'),tinfoil?'Bearer synthetic-tf-admin':'Bearer synthetic-or-admin');
    return new Response(null,{status:tinfoil&&failTinfoil?503:404});
  },
}));
try {
  const db=await mf.getD1Database('DB');
  for(const file of (await readdir(root+'migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    const sql=(await readFile(root+'migrations/'+file,'utf8')).replace(/^\s*--.*$/gm,'');
    const parts=file.startsWith('0009')?sql.split(/;\s*(?=CREATE|$)/):sql.split(';');
    for(const statement of parts.map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const request = async body => (await mf.dispatchFetch('https://retention.test/',{method:'POST',body:JSON.stringify({now,...body})})).json();
  const query = (sql,...args)=>db.prepare(sql).bind(...args).first();
  const old = Date.parse('2024-01-01T00:00:00Z')/1000;
  const seed=async(name,created=old,last=old)=>{
    const email=name+'@example.test';
    await db.prepare('INSERT INTO users(email,created_at,last_active_at) VALUES (?,?,?)').bind(email,created,last).run();
    await db.prepare('INSERT INTO user_keys(email,bayleaf_token,account_generation) VALUES (?,?,?)')
      .bind(email,'sk-bayleaf-'+name,'generation-'+name).run();
    return email;
  };
  const expired=await seed('expired');
  await db.prepare('UPDATE user_keys SET revoked=1,or_key_hash=?,tinfoil_key=? WHERE email=?')
    .bind('old-or-hash','tk_old-tinfoil',expired).run();
  await seed('recent-creation',now,old);
  await seed('recent-activity',old,now);
  await seed('unknown',old,null);
  await seed('future',old,now+1);
  await seed('invalid',old,-1);
  await seed('boundary',old,Date.parse('2025-04-19T12:34:56Z')/1000);
  const held=await seed('held');
  await db.prepare('UPDATE users SET retention_hold=1 WHERE email=?').bind(held).run();
  const exempt=await seed('exempt');
  await db.prepare('UPDATE users SET retention_exempt=1 WHERE email=?').bind(exempt).run();
  const sandbox=await seed('sandbox');
  await db.prepare('UPDATE user_keys SET daytona_sandbox_id=? WHERE email=?').bind('existing-machine',sandbox).run();
  const credential=await seed('sandbox-credential');
  await db.prepare(`INSERT INTO sandbox_credentials(id,email,sandbox_id,token_hash,secret_name,state,created_at,updated_at)
    VALUES ('sc',?,'machine','digest','secret','revoked',?,?)`).bind(credential,old,old).run();
  const session=await seed('session');
  await db.prepare('INSERT INTO service_sessions VALUES (?,?,?,?,?)').bind('active-session',session,'Name','generation',now+1).run();
  const preview=await seed('preview');
  await db.prepare('INSERT INTO preview_owners VALUES (?,?)').bind(preview,'reserved-preview').run();
  await db.prepare(`INSERT INTO preview_registrations
    (hostname,email,deployment,slot,generation,upstream_encrypted,expires_at,access) VALUES (?,?,?,?,?,?,?,?)`)
    .bind('host',preview,'deployment','slot','generation','encrypted',now+1,'private').run();
  // Inactive users' expired associated metadata is removed transactionally.
  await db.prepare('INSERT INTO service_sessions VALUES (?,?,?,?,?)').bind('expired-session',expired,'Name','generation',old).run();
  await db.prepare('INSERT INTO inference_grants(id,owner_email,owner_token_hash,models_json,expires_at,created_at) VALUES (?,?,?,?,?,?)')
    .bind('grant',expired,'digest','["openrouter:test/model"]',old,old).run();
  await db.prepare('INSERT INTO preview_owners VALUES (?,?)').bind(expired,'permanent-reservation').run();
  let report=await request({mode:'disabled'});
  assert.equal(report.mode,'disabled');
  report=await request({mode:'dry-run'});
  assert.equal(report.candidates,1,JSON.stringify(report));
  assert.equal(report.retired,0);
  assert.ok(await query('SELECT * FROM users WHERE email=?',expired));
  assert.equal(providerCalls.length,0,'dry-run never calls providers');

  // Snapshot guards reject new activity or a hold before the atomic claim.
  const race=await seed('race');
  const snapshot=await query('SELECT email,created_at,last_active_at FROM users WHERE email=?',race);
  await db.prepare('UPDATE users SET last_active_at=? WHERE email=?').bind(now,race).run();
  assert.equal(await request({user:snapshot}),false);
  await db.prepare('UPDATE users SET last_active_at=?,retention_hold=1 WHERE email=?').bind(old,race).run();
  assert.equal(await request({user:snapshot}),false);
  assert.ok(await query('SELECT * FROM user_keys WHERE email=?',race));

  const rollback=await seed('rollback');
  const rollbackSnapshot=await query('SELECT email,created_at,last_active_at FROM users WHERE email=?',rollback);
  await db.prepare(`CREATE TRIGGER fail_retirement BEFORE DELETE ON users
    WHEN OLD.email='rollback@example.test' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END`).run();
  assert.deepEqual(await request({user:rollbackSnapshot}),{transactionFailed:true});
  assert.ok(await query('SELECT * FROM users WHERE email=?',rollback));
  assert.ok(await query('SELECT * FROM user_keys WHERE email=?',rollback));
  assert.equal((await query('SELECT count(*) AS n FROM user_retention_outbox')).n,0,'failed batch rolls back detach and deletes');
  await db.prepare('DROP TRIGGER fail_retirement').run();
  await db.prepare('UPDATE users SET retention_hold=1 WHERE email=?').bind(rollback).run();
  await db.prepare('INSERT INTO users(email,created_at,last_active_at) VALUES (?,?,?)')
    .bind('browser-only@example.test',old,old).run();

  report=await request({mode:'delete'});
  assert.equal(report.retired,2,'user with no ordinary key can also retire');
  assert.equal(report.providerPending,1,'provider failure keeps recoverable outbox');
  assert.equal(await query('SELECT * FROM users WHERE email=?',expired),null);
  assert.equal(await query('SELECT * FROM user_keys WHERE email=?',expired),null);
  assert.equal(await query('SELECT * FROM inference_grants WHERE owner_email=?',expired),null);
  assert.equal(await query('SELECT * FROM service_sessions WHERE email=?',expired),null);
  assert.ok(await query('SELECT * FROM preview_owners WHERE email=?',expired),'origin reservations survive');
  const outbox=await query('SELECT * FROM user_retention_outbox');
  assert.equal(outbox.or_key_hash,null,'confirmed provider removal scrubbed immediately');
  assert.equal(outbox.tinfoil_key,'tk_old-tinfoil');
  assert.ok(!JSON.stringify(outbox).includes(expired),'outbox holds no account identity');
  const calls=providerCalls.length;
  report=await request({mode:'dry-run'});
  assert.equal(providerCalls.length,calls,'dry-run also pauses pending revocations');

  // Returning identity gets a fresh account and fresh keys; old outbox cannot touch them.
  await seed('expired',now,now);
  await db.prepare('UPDATE user_keys SET or_key_hash=?,tinfoil_key=? WHERE email=?').bind('new-or','tk_new',expired).run();
  failTinfoil=false;
  report=await request({mode:'delete'});
  assert.equal(report.retired,0);
  assert.equal(report.providerPending,0);
  assert.equal(report.outboxCompleted,1);
  assert.equal((await query('SELECT tinfoil_key FROM user_keys WHERE email=?',expired)).tinfoil_key,'tk_new');
  assert.ok(providerCalls.every(c=>!c.url.includes('tk_new')&&!c.url.includes('new-or')));
  assert.equal((await query('SELECT count(*) AS n FROM users')).n,15,'only eligible accounts removed, one recreated');
  console.log('PASS account retention: timestamps, cutoff, exemptions, sandbox/session dependencies, atomic fresh checks, dry-run, provider outbox retries and returning identities');
} finally {await mf.dispose();}

const unit=await build({absWorkingDir:root,entryPoints:['src/userRetention.ts'],bundle:true,write:false,format:'esm'});
const {accountCutoff,cleanupInactiveUsers}=await import('data:text/javascript;base64,'+Buffer.from(unit.outputFiles[0].text).toString('base64'));
assert.equal(new Date(accountCutoff(Date.parse('2026-08-31T12:34:56Z')/1000)*1000).toISOString(),'2025-02-28T12:34:56.000Z');
assert.equal(new Date(accountCutoff(Date.parse('2025-08-31T12:34:56Z')/1000)*1000).toISOString(),'2024-02-29T12:34:56.000Z');
assert.throws(()=>accountCutoff(NaN));
assert.equal((await cleanupInactiveUsers({DB:{prepare(){throw new Error('Disabled cleanup must not query');}}})).mode,'disabled');
