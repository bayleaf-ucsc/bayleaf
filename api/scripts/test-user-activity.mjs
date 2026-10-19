#!/usr/bin/env node
/** Real SQLite/workerd, synthetic identities, no credentials or provider calls. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import { Hono } from 'hono';
  import { recordUserActivity } from './src/userActivity';
  import { resolveAuth } from './src/utils/auth';
  import { getSession, setSessionCookie } from './src/utils/session';
  import { provisionToken } from './src/provision';
  import { issueGrant } from './src/grants';
  const app = new Hono();
  app.post('/touch', async c => {
    const {email, last, now} = await c.req.json();
    await recordUserActivity(email, c.env, last, now); return c.json(true);
  });
  app.get('/auth', async c => {
    const auth = await resolveAuth(c);
    return auth instanceof Response ? auth : c.json({email:auth.userEmail});
  });
  app.post('/provision', async c => c.json(await provisionToken('legacy@example.test', c.env)));
  app.get('/cookie', async c => { await setSessionCookie(c, {email:'browser@example.test',name:'Browser'}); return c.text('ok'); });
  app.get('/session', async c => c.json(await getSession(c)));
  app.post('/grant', async c => {
    const row = await c.env.DB.prepare('SELECT * FROM user_keys WHERE email=?').bind('legacy@example.test').first();
    return c.json(await issueGrant(c.env, row, 'https://api.test', ['openrouter:test/model'], Math.floor(Date.now()/1000)+3600));
  });
  app.post('/v1/chat/completions', async c => {
    const auth = await resolveAuth(c);
    return auth instanceof Response ? auth : c.json({email:auth.userEmail});
  });
  export default app;
` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-08-01', d1Databases: ['DB'],
  bindings: { OIDC_CLIENT_SECRET:'synthetic-session-secret', GRANTS_ENABLED:'true',
    GRANT_MAX_SECONDS:'3600', CAMPUS_IP_RANGES:'128.114.0.0/16' },
  outboundService: () => { throw new Error('No provider calls permitted'); },
}));
try {
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(root+'migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    if (file.startsWith('0017')) {
      await db.prepare(`INSERT INTO user_keys(email,bayleaf_token,created_at,revoked)
        VALUES ('legacy@example.test','sk-bayleaf-legacy','2024-01-02 03:04:05',1)`).run();
    }
    const sql = (await readFile(root+'migrations/'+file,'utf8')).replace(/^\s*--.*$/gm,'');
    const statements = file.startsWith('0009') ? sql.split(/;\s*(?=CREATE|$)/) : sql.split(';');
    for (const statement of statements.map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const user = email => db.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
  const legacy = await user('legacy@example.test');
  assert.equal(legacy.created_at, Date.parse('2024-01-02T03:04:05Z')/1000);
  assert.equal(legacy.last_active_at, null, 'migration must not fabricate activity');
  const post = (path, body) => mf.dispatchFetch('https://api.test'+path, {method:'POST',body:JSON.stringify(body)});
  const touch = (email,last,now) => post('/touch',{email,last,now});
  const now = Math.floor(Date.now()/1000), day = Math.floor(now/86400)*86400;
  await touch('legacy@example.test',null,day+1);
  assert.equal((await user('legacy@example.test')).created_at,legacy.created_at);
  await Promise.all([touch('legacy@example.test',null,day+2),touch('legacy@example.test',null,day+3)]);
  assert.equal((await user('legacy@example.test')).last_active_at,day+1,'SQL coalesces concurrent stale reads');
  await touch('legacy@example.test',day+1,day+86401);
  assert.equal((await user('legacy@example.test')).last_active_at,day+86401,'next UTC day refreshes');
  await touch('legacy@example.test',null,day+4);
  assert.equal((await user('legacy@example.test')).last_active_at,day+86401,'older requests cannot rewind');
  await db.prepare('UPDATE users SET last_active_at=NULL WHERE email=?').bind(legacy.email).run();
  const auth = token => mf.dispatchFetch('https://api.test/auth', {headers:{Authorization:'Bearer '+token}});
  assert.equal((await auth('sk-bayleaf-legacy')).status,401);
  assert.equal((await user(legacy.email)).last_active_at,null,'revoked key does not count');
  const provisioned = await (await post('/provision',{})).json();
  assert.equal(provisioned.created_at,'2024-01-02 03:04:05','key reissue preserves legacy age too');
  assert.equal((await user(legacy.email)).created_at,legacy.created_at);
  await db.prepare('UPDATE users SET last_active_at=NULL WHERE email=?').bind(legacy.email).run();
  assert.equal((await auth(provisioned.bayleaf_token)).status,200);
  assert.ok((await user(legacy.email)).last_active_at>=now,'ordinary key updates user');
  const response = await mf.dispatchFetch('https://api.test/cookie');
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  assert.ok(await user('browser@example.test'),'browser account needs no key');
  assert.equal(await db.prepare('SELECT email FROM user_keys WHERE email=?').bind('browser@example.test').first(),null);
  await db.prepare('UPDATE users SET last_active_at=NULL WHERE email=?').bind('browser@example.test').run();
  await mf.dispatchFetch('https://api.test/session',{headers:{Cookie:cookie}});
  assert.ok((await user('browser@example.test')).last_active_at>=now,'verified session counts');
  await db.prepare('UPDATE users SET last_active_at=NULL WHERE email=?').bind('browser@example.test').run();
  await mf.dispatchFetch('https://api.test/session',{headers:{Cookie:cookie+'invalid'}});
  assert.equal((await user('browser@example.test')).last_active_at,null,'invalid cookie does not count');
  const grant = await (await post('/grant',{})).json();
  assert.ok(grant?.access_token,JSON.stringify(grant));
  await db.prepare('UPDATE users SET last_active_at=NULL WHERE email=?').bind(legacy.email).run();
  assert.equal((await mf.dispatchFetch('https://api.test/v1/chat/completions',{
    method:'POST',headers:{Authorization:'Bearer '+grant.access_token},body:'{}',
  })).status,200);
  assert.ok((await user(legacy.email)).last_active_at>=now,'temporary token updates same user');
  const count = (await db.prepare('SELECT count(*) AS n FROM users').first()).n;
  await auth('sk-bayleaf-invalid');
  await mf.dispatchFetch('https://api.test/auth',{headers:{'CF-Connecting-IP':'128.114.1.2'}});
  assert.equal((await db.prepare('SELECT count(*) AS n FROM users').first()).n,count,'anonymous/invalid auth creates no user');
  console.log('User activity migration, monotonic daily clock, ordinary/grant/browser auth and independent key lifetime passed');
} finally { await mf.dispose(); }

// Fresh authentication rows must skip even attempting a database operation.
const unit = await build({absWorkingDir:root,entryPoints:['src/userActivity.ts'],bundle:true,write:false,format:'esm'});
const {recordUserActivity} = await import('data:text/javascript;base64,'+Buffer.from(unit.outputFiles[0].text).toString('base64'));
await recordUserActivity('fresh@example.test',{DB:{prepare(){throw new Error('Unexpected DB access');}}},Math.floor(Date.now()/1000));
let writes=0;
await recordUserActivity('fresh@example.test',{DB:{prepare(){writes++; throw new Error('Synthetic outage');}}},Math.floor(Date.now()/1000));
assert.equal(writes,0,'fresh row skips D1 entirely');
