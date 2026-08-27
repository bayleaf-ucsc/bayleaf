/**
 * Integration harness for the consolidated key lifecycle (src/provision.ts).
 *
 * Runs against `wrangler dev --local` on :8799 (local D1, real OpenRouter
 * secrets), minting a session JWT directly so we don't need a browser OIDC
 * round trip. Creates real OpenRouter keys for a .invalid test address and
 * deletes them at the end.
 */
import { readFileSync } from 'node:fs';
import { sign } from 'hono/jwt';
import { execFileSync } from 'node:child_process';

const BASE = 'http://localhost:8799';
const EMAIL = 'refactor-test@example.invalid';
const EMAIL2 = 'refactor-test2@example.invalid';
const OR = 'https://openrouter.ai/api/v1';

const parseEnv = (path) => Object.fromEntries(
  readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
);
// .dev.vars supplies OIDC_CLIENT_SECRET (for minting the session JWT). Its
// OPENROUTER_PROVISIONING_KEY is stale, so OpenRouter admin calls here use the
// working management key from .env — the same one scripts/spend-limits.mjs uses.
// Getting this wrong makes every orGet() 401 -> null, which silently turns the
// upstream assertions AND the cleanup check into false greens. Verify the key
// works before trusting any of them.
const env = parseEnv('.dev.vars');
const ADMIN = parseEnv('.env').OPENROUTER_MAINTENANCE_KEY;

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const cookie = async () =>
  `bayleaf_session=${await sign(
    { email: EMAIL, name: 'Refactor Test', exp: Math.floor(Date.now() / 1000) + 3600 },
    env.OIDC_CLIENT_SECRET,
  )}`;

const call = async (method, path, c) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Cookie: c } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};

/** Hit the canonical agent-facing budget endpoint with a bayleaf token. */
const authKey = async (token) => {
  const res = await fetch(`${BASE}/v1/auth/key`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};

const d1 = (sql) => {
  const out = execFileSync('npx',
    ['wrangler', 'd1', 'execute', 'bayleaf-keys', '--local', '--json', '--command', sql],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].results;
};

const orGet = async (hash) => {
  const r = await fetch(`${OR}/keys/${hash}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  return r.ok ? (await r.json()).data : null;
};
const orDelete = (hash) =>
  fetch(`${OR}/keys/${hash}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } });
const orListByName = async (name) => {
  const found = [];
  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`${OR}/keys?offset=${offset}&limit=100`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    if (!r.ok) throw new Error(`OpenRouter key listing failed: ${r.status} ${await r.text()}`);
    const batch = (await r.json()).data ?? [];
    found.push(...batch.filter((key) => key.name === name));
    if (batch.length < 100) return found;
  }
};

const created = new Set();
const row = () => d1(`SELECT * FROM user_keys WHERE email='${EMAIL}'`)[0] ?? null;

async function preflight() {
  const r = await fetch(`${OR}/keys?limit=1`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  if (!r.ok) {
    console.error(`Admin key rejected by OpenRouter (${r.status}). Upstream assertions would be`);
    console.error('false greens and the cleanup would silently leak keys. Aborting.');
    process.exit(2);
  }
  console.log('Preflight: OpenRouter admin key accepted.');
}

async function main() {
  await preflight();
  const c = await cookie();
  for (const email of [EMAIL, EMAIL2]) {
    for (const key of await orListByName(`BayLeaf API for ${email}`)) await orDelete(key.hash);
  }
  d1(`DELETE FROM user_keys WHERE email IN ('${EMAIL}','${EMAIL2}')`);

  console.log('\n1. DELETE /key with no row → 404');
  check('404', (await call('DELETE', '/key', c)).status === 404);

  console.log('\n2. POST /key → fresh token-only provision (INSERT path)');
  let r = await call('POST', '/key', c);
  check('200', r.status === 200, `got ${r.status}`);
  const token1 = r.json?.key;
  check('token shape sk-bayleaf-+32hex', /^sk-bayleaf-[0-9a-f]{32}$/.test(token1 ?? ''));
  let db = row();
  check('D1 row inserted, revoked=0', db && db.revoked === 0);
  check('D1 token matches response', db?.bayleaf_token === token1);
  check('OR key remains absent until first use', db?.or_key_hash === null && db?.or_key_secret === null);

  console.log('\n3. POST /key again → 409 (one active row per email)');
  check('409', (await call('POST', '/key', c)).status === 409);

  console.log('\n4. GET /v1/auth/key → lazy OR mint, budget, no secret leak');
  r = await authKey(token1);
  check('200', r.status === 200, `got ${r.status}`);
  db = row();
  if (db?.or_key_hash) created.add(db.or_key_hash);
  let live = db?.or_key_hash && (await orGet(db.or_key_hash));
  check('OR key minted on first use', !!live);
  check('OR key named from template', live?.name === `BayLeaf API for ${EMAIL}`, live?.name);
  check('OR limit = global default (5)', live?.limit === 5, `limit=${live?.limit}`);
  check('data.limit is a number', typeof r.json?.data?.limit === 'number');
  check('data.bayleaf.openrouter present', !!r.json?.data?.bayleaf?.openrouter);
  // Only *enabled* alternate backends may appear. Advertising a budget for a
  // backend that answers 503 makes an agent plan around a capability it lacks;
  // /v1/models and the routing block already gate on this, and this surface
  // used to not. Read the flags from wrangler.jsonc so the check tracks config.
  const wrangler = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  for (const [name, flag] of [['vertex', 'VERTEX_ENABLED'], ['bedrock', 'BEDROCK_ENABLED']]) {
    const enabled = wrangler.vars[flag] === 'true';
    const present = !!r.json?.data?.bayleaf?.[name];
    check(`bayleaf.${name} present iff ${flag}=true`, present === enabled,
      `${flag}=${wrangler.vars[flag]} present=${present}`);
  }
  // OpenRouter echoes an *elided* label ("sk-or-v1-9fa...4a4") for the caller's
  // own key. That's safe by upstream design. What must never appear is a whole
  // secret, so require every sk-or- occurrence to carry the "..." elision — this
  // fires if OR starts returning raw keys or if we ever inject or_key_secret.
  const orRefs = [...r.text.matchAll(/sk-or-[A-Za-z0-9.\-_]*/g)].map((m) => m[0]);
  check('every sk-or- reference is elided, none is a whole secret',
    orRefs.length > 0 && orRefs.every((v) => v.includes('...')), orRefs.join(' '));

  console.log('\n5. GET /dashboard → renders, no secret in HTML');
  r = await call('GET', '/dashboard', c);
  check('200', r.status === 200);
  check('no sk-or- in HTML', !r.text.includes('sk-or-'));
  check('mentions the signed-in email', r.text.includes(EMAIL));

  console.log('\n6. Self-heal: delete the OR key upstream, then reload dashboard');
  const deadHash = row().or_key_hash;
  await orDelete(deadHash);
  check('upstream key really gone', (await orGet(deadHash)) === null);
  r = await call('GET', '/dashboard', c);
  check('dashboard still 200', r.status === 200);
  db = row();
  created.add(db.or_key_hash);
  check('D1 or_key_hash rotated', db.or_key_hash !== deadHash);
  check('bayleaf token PRESERVED across self-heal', db.bayleaf_token === token1);
  check('new OR key alive', !!(await orGet(db.or_key_hash)));

  console.log('\n7. Same token still authenticates after self-heal');
  check('/v1/auth/key 200', (await authKey(token1)).status === 200);

  console.log('\n8. DELETE /key → revoke');
  check('200', (await call('DELETE', '/key', c)).status === 200);
  check('D1 revoked=1', row().revoked === 1);
  check('revoked token no longer authenticates', (await authKey(token1)).status === 401);

  console.log('\n9. POST /key after revoke → reuses the still-alive OR key, mints NEW token');
  const revokedHash = row().or_key_hash;
  r = await call('POST', '/key', c);
  check('200', r.status === 200);
  const token2 = r.json?.key;
  check('new bayleaf token minted', token2 && token2 !== token1);
  db = row();
  check('revoked cleared', db.revoked === 0);
  check('OR key REUSED, not orphaned', db.or_key_hash === revokedHash, `${revokedHash} -> ${db.or_key_hash}`);

  console.log('\n10. Revoke + kill OR key → POST retains it; first use heals it');
  await call('DELETE', '/key', c);
  await orDelete(revokedHash);
  check('missing OR key confirmed on management plane', (await orGet(revokedHash)) === null);
  r = await call('POST', '/key', c);
  check('200', r.status === 200);
  const token3 = r.json?.key;
  db = row();
  check('POST retains the missing OR hash without eager minting', db.or_key_hash === revokedHash);
  check('token rotated again', token3 && token3 !== token2);
  check('dashboard heals the missing OR key', (await call('GET', '/dashboard', c)).status === 200);
  db = row();
  created.add(db.or_key_hash);
  check('new OR key created', db.or_key_hash !== revokedHash);
  check('new OR key alive', !!(await orGet(db.or_key_hash)));
  check('bayleaf token preserved across heal', db.bayleaf_token === token3);
  check('new token authenticates through healed key', (await authKey(token3)).status === 200);

  console.log('\n11. Claim device flow → hands back the SAME existing token');
  const init = await (await fetch(`${BASE}/auth/claim/initiate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'HarnessTest' }),
  })).json();
  check('initiate returns codes', /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(init.user_code) && /^[0-9a-f]{32}$/.test(init.device_code));
  const poll1 = await fetch(`${BASE}/auth/claim/poll?d=${init.device_code}`);
  check('poll pending = 202', poll1.status === 202);
  // Approve requires the CSRF token that the GET page embeds; scrape it.
  const page = await (await fetch(`${BASE}/auth/claim?c=${init.user_code}`, { headers: { Cookie: c } })).text();
  const csrf = /name="token" value="([^"]+)"[\s\S]*?class="approve"/.exec(page)
    ?? /value="approve"[\s\S]*?name="token" value="([^"]+)"/.exec(page)
    ?? /name="token" value="([^"]+)"/.exec(page);
  check('approval page embeds CSRF token', !!csrf);
  const appr = await fetch(`${BASE}/auth/claim/approve`, {
    method: 'POST', headers: { Cookie: c, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: init.user_code, action: 'approve', token: csrf[1] }),
  });
  check('approve 200', appr.status === 200);
  const poll2 = await fetch(`${BASE}/auth/claim/poll?d=${init.device_code}`);
  const claimed = await poll2.json();
  check('poll approved = 200', poll2.status === 200);
  check('claim returned the EXISTING token (no new key)', claimed.key === row().bayleaf_token, claimed.status);
  check('D1 still one row', d1(`SELECT count(*) n FROM user_keys WHERE email='${EMAIL}'`)[0].n === 1);
  const poll3 = await fetch(`${BASE}/auth/claim/poll?d=${init.device_code}`);
  check('one-shot: second poll 404', poll3.status === 404);

  console.log('\n12. Claim flow for a user with NO row → provisions one');
  const c2 = `bayleaf_session=${await sign({ email: EMAIL2, name: 'T2', exp: Math.floor(Date.now() / 1000) + 3600 }, env.OIDC_CLIENT_SECRET)}`;
  const init2 = await (await fetch(`${BASE}/auth/claim/initiate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'HarnessTest2' }),
  })).json();
  const page2 = await (await fetch(`${BASE}/auth/claim?c=${init2.user_code}`, { headers: { Cookie: c2 } })).text();
  const csrf2 = /name="token" value="([^"]+)"/.exec(page2);
  await fetch(`${BASE}/auth/claim/approve`, {
    method: 'POST', headers: { Cookie: c2, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: init2.user_code, action: 'approve', token: csrf2[1] }),
  });
  const got2 = await (await fetch(`${BASE}/auth/claim/poll?d=${init2.device_code}`)).json();
  let db2 = d1(`SELECT * FROM user_keys WHERE email='${EMAIL2}'`)[0];
  check('row created for new user', !!db2);
  check('claim token matches the new row', got2.key === db2?.bayleaf_token);
  check('claim does not eagerly mint an OR key', db2?.or_key_hash === null);

  console.log('\n13. Eight concurrent first uses → one surviving OR key');
  const firstUses = await Promise.all(Array.from({ length: 8 }, () => authKey(got2.key)));
  check('all concurrent requests succeed', firstUses.every((response) => response.status === 200));
  db2 = d1(`SELECT * FROM user_keys WHERE email='${EMAIL2}'`)[0];
  if (db2?.or_key_hash) created.add(db2.or_key_hash);
  const raceKeys = await orListByName(`BayLeaf API for ${EMAIL2}`);
  for (const key of raceKeys) created.add(key.hash);
  check('exactly one OR key survives the mint race', raceKeys.length === 1, `${raceKeys.length} found`);
  check('surviving key is the one stored in D1', raceKeys[0]?.hash === db2?.or_key_hash);

  // ── cleanup ────────────────────────────────────────────────────
  console.log('\nCleanup: deleting test OR keys + local D1 rows');
  for (const h of created) await orDelete(h);
  d1(`DELETE FROM user_keys WHERE email IN ('${EMAIL}','${EMAIL2}')`);
  let leaked = 0;
  for (const h of created) if (await orGet(h)) leaked++;
  check('all test OR keys deleted upstream', leaked === 0, `${leaked} leaked`);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
