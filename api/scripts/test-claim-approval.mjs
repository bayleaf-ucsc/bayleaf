/**
 * Claim approval phishing defences (RFC 8628 §5.4, remote phishing).
 *
 * Credential-free: an in-memory D1 fake and a locally signed session. Covers the
 * origin comparison, the neutral page heading, the server-enforced confirmation
 * for cross-network approvals, the unchanged same-network path, the post-approval
 * revoke hint and the per-IP claim-creation limit.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: "export { claimRoutes } from './src/routes/claim'; export * from './src/utils/claimOrigin'; export { sign } from 'hono/jwt';",
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', loader: { '.py': 'text' },
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { claimRoutes, compareOrigins, needsOriginConfirmation, normalizeCountry, describeOrigin, originOf, sign } = mod;

// ── Pure comparison rules ───────────────────────────────────────────
const o = (ip, country, asn, network = null) => ({ ip, country, asn, network });
assert.equal(compareOrigins(o('1.2.3.4', 'US', 7922), o('1.2.3.4', 'US', 7922)), 'same-ip');
// One machine on IPv4 for the terminal and IPv6 for the browser: same ASN.
assert.equal(compareOrigins(o('1.2.3.4', 'US', 7922), o('2001:db8::1', 'US', 7922)), 'same-network');
assert.equal(compareOrigins(o('1.2.3.4', 'US', 7922), o('5.6.7.8', 'US', 21928)), 'different-network');
// Country wins over a shared global ASN.
assert.equal(compareOrigins(o('1.2.3.4', 'RU', 13335), o('5.6.7.8', 'US', 13335)), 'different-country');
assert.equal(compareOrigins(o(null, null, null), o('5.6.7.8', 'US', 7922)), 'unknown');
assert.equal(needsOriginConfirmation('same-ip'), false);
assert.equal(needsOriginConfirmation('same-network'), false);
for (const m of ['different-network', 'different-country', 'unknown']) assert.equal(needsOriginConfirmation(m), true);
assert.equal(normalizeCountry('xx'), null);
assert.equal(normalizeCountry('T1'), null);
assert.equal(normalizeCountry(' us '), 'US');
assert.equal(describeOrigin(o(null, 'US', 1, 'Comcast Cable')), 'Comcast Cable in United States');
assert.equal(describeOrigin(o(null, null, null, null)), 'an unknown network');

// ── In-memory D1 fake ───────────────────────────────────────────────
const claims = [];
const TOKEN = 'sk-bayleaf-' + '0'.repeat(32);
const DB = {
  withSession() { return this; },
  prepare(sql) {
    return { bind(...v) {
      return {
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO claim_codes')) {
            const [device_code, user_code, client, created_at, expires_at, initiator_ip, initiator_country,
              curl_platform, initiator_asn, initiator_network] = v;
            claims.push({ device_code, user_code, client, created_at, expires_at, initiator_ip, initiator_country,
              curl_platform, initiator_asn, initiator_network, status: 'pending', approved_by: null });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('DELETE FROM claim_codes WHERE expires_at')) return { meta: { changes: 0 } };
          if (sql.includes("UPDATE claim_codes SET status = 'approved'") || sql.includes("UPDATE claim_codes SET status = 'denied'")) {
            const row = claims.find((r) => r.device_code === v[1] && r.status === 'pending');
            if (!row) return { meta: { changes: 0 } };
            row.status = sql.includes("'approved'") ? 'approved' : 'denied';
            row.approved_by = v[0];
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes('FROM claim_codes WHERE user_code')) return claims.find((r) => r.user_code === v[0]) ?? null;
          if (sql.includes('FROM claim_codes WHERE device_code')) return claims.find((r) => r.device_code === v[0]) ?? null;
          if (sql.includes('FROM user_keys')) return { email: v[0], bayleaf_token: TOKEN, revoked: 0 };
          if (sql.includes('FROM users')) return { last_active_at: Math.floor(Date.now() / 1000) };
          return null;
        },
      };
    } };
  },
};
const SECRET = 'test-oidc-secret-not-real';
const env = { DB, OIDC_CLIENT_SECRET: SECRET };
const EMAIL = 'student@ucsc.edu';
const sessionCookie = `bayleaf_session=${await sign({ email: EMAIL, name: 'Student', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}`;

/** A request carrying Cloudflare edge facts, as the Worker would see it. */
function edgeRequest(url, { ip, country, asn, network, init = {} }) {
  const headers = new Headers(init.headers ?? {});
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (country) headers.set('CF-IPCountry', country);
  const req = new Request(url, { ...init, headers });
  Object.defineProperty(req, 'cf', { value: { asn, asOrganization: network, country } });
  return req;
}
const HOME = { ip: '73.1.2.3', country: 'US', asn: 7922, network: 'Comcast Cable' };
const HOME_V6 = { ip: '2601:600::5', country: 'US', asn: 7922, network: 'Comcast Cable' };
const ATTACKER = { ip: '198.51.100.7', country: 'US', asn: 14061, network: 'DigitalOcean' };

assert.deepEqual(originOf(edgeRequest('https://api.example/', HOME)), { ip: HOME.ip, country: 'US', asn: 7922, network: 'Comcast Cable' });

async function initiate(origin, label) {
  const res = await claimRoutes.request(edgeRequest('https://api.example/initiate', {
    ...origin, init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: label }) },
  }), undefined, env);
  assert.equal(res.status, 200);
  return res.json();
}
async function page(userCode, origin) {
  const res = await claimRoutes.request(edgeRequest(`https://api.example/?c=${userCode}`, {
    ...origin, init: { headers: { Cookie: sessionCookie } },
  }), undefined, env);
  assert.equal(res.status, 200);
  return res.text();
}
const tokenFrom = (html, action) => {
  const forms = html.split('<form');
  const form = forms.find((f) => f.includes(`name="action" value="${action}"`));
  return /name="token" value="([^"]+)"/.exec(form)[1];
};
async function submit(userCode, origin, fields) {
  const body = new URLSearchParams({ code: userCode, ...fields });
  return claimRoutes.request(edgeRequest('https://api.example/approve', {
    ...origin, init: { method: 'POST', body, headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' } },
  }), undefined, env);
}

// ── Initiate records the network ────────────────────────────────────
const phish = await initiate(ATTACKER, 'CMPM 121 Autograder');
const stored = claims.find((r) => r.user_code === phish.user_code);
assert.equal(stored.initiator_asn, 14061);
assert.equal(stored.initiator_network, 'DigitalOcean');

// ── Phishing scenario: different network needs explicit confirmation ─
const phishPage = await page(phish.user_code, HOME);
assert.match(phishPage, /<h1>Approve a sign-in request\?<\/h1>/);
assert.ok(!/<h1>[^<]*CMPM 121 Autograder/.test(phishPage), 'attacker label must not head the page');
assert.match(phishPage, /calls itself <strong>CMPM 121 Autograder<\/strong>/);
assert.match(phishPage, /DigitalOcean in United States \(198\.51\.100\.7\)/);
assert.match(phishPage, /Comcast Cable in United States/);
assert.match(phishPage, /different network than the one you are on now/);
assert.match(phishPage, /name="confirm_origin" value="yes" required/);

const approveTok = tokenFrom(phishPage, 'approve');
const blocked = await submit(phish.user_code, HOME, { action: 'approve', token: approveTok });
assert.equal(blocked.status, 400);
assert.equal(stored.status, 'pending', 'unconfirmed cross-network approval must not approve');
const wrongValue = await submit(phish.user_code, HOME, { action: 'approve', token: approveTok, confirm_origin: 'on' });
assert.equal(wrongValue.status, 400);
assert.equal(stored.status, 'pending');

// Deny never needs the confirmation.
const denied = await submit(phish.user_code, HOME, { action: 'deny', token: tokenFrom(phishPage, 'deny') });
assert.equal(denied.status, 200);
assert.equal(stored.status, 'denied');

// ── Legitimate cross-device approval (Pouch QR) still works when confirmed ─
const qr = await initiate(HOME, 'BayLeaf Pouch');
const phone = { ip: '172.56.9.9', country: 'US', asn: 21928, network: 'T-Mobile USA' };
const qrPage = await page(qr.user_code, phone);
assert.match(qrPage, /confirm_origin/);
const confirmed = await submit(qr.user_code, phone, { action: 'approve', token: tokenFrom(qrPage, 'approve'), confirm_origin: 'yes' });
assert.equal(confirmed.status, 200);
assert.match(await confirmed.text(), /Revoke your key now/);
assert.equal(claims.find((r) => r.user_code === qr.user_code).status, 'approved');

// ── Same machine (IPv4 terminal, IPv6 browser): no extra step ────────
const local = await initiate(HOME, 'OpenCode for BayLeaf');
const localPage = await page(local.user_code, HOME_V6);
assert.ok(!localPage.includes('confirm_origin'), 'same network must not add a checkbox');
assert.ok(!localPage.includes('class="origin origin-mismatch"'), 'same network must not show the warning panel');
assert.match(phishPage, /class="origin origin-mismatch"/);
const quick = await submit(local.user_code, HOME_V6, { action: 'approve', token: tokenFrom(localPage, 'approve') });
assert.equal(quick.status, 200);
assert.equal(claims.find((r) => r.user_code === local.user_code).status, 'approved');

// ── Unknown origin (no edge facts) fails safe to "confirm" ───────────
const anon = await initiate({}, 'my-tool');
assert.match(await page(anon.user_code, HOME), /could not confirm that this request started on your network/);

// ── Claim creation is rate-limited per IP when the binding exists ────
const seen = [];
const limitedEnv = { ...env, CLAIM_INITIATE_LIMIT: { async limit({ key }) { seen.push(key); return { success: false }; } } };
const over = await claimRoutes.request(edgeRequest('https://api.example/initiate', {
  ...HOME_V6, init: { method: 'POST' },
}), undefined, limitedEnv);
assert.equal(over.status, 429);
assert.equal(over.headers.get('Retry-After'), '60');
assert.equal(seen[0], 'claim:2601:600:0:0', 'IPv6 keyed by /64');
const overCurl = await claimRoutes.request(edgeRequest('https://api.example/curl/start/standard/unix', HOME), undefined, limitedEnv);
assert.equal(overCurl.status, 429);

console.log('claim approval phishing defences: all assertions passed');
