/** Credential-free claim header and real curl pipe-separation regressions. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';

const bundle = await build({
  stdin: {
    contents: "export { wellKnownRoutes, sealedWellKnownRoutes, sandboxWellKnownRoutes, windowsWellKnownRoutes } from './src/routes/wellknown'; export { claimRoutes } from './src/routes/claim';",
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  jsx: 'automatic', jsxImportSource: 'hono/jsx', loader: { '.py': 'text' },
});
const { claimRoutes, wellKnownRoutes, sealedWellKnownRoutes, sandboxWellKnownRoutes, windowsWellKnownRoutes } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

// Deliberately no provider credentials or auth: start only creates a pending claim.
const records = [];
const DB = {
  withSession(mode) {
    assert.equal(mode, 'first-primary');
    return this;
  },
  prepare(sql) {
    return { bind(...values) {
      return {
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO claim_codes')) {
            const [device_code, user_code, client, created_at, expires_at, initiator_ip, initiator_country, curl_platform] = values;
            records.push({ device_code, user_code, client, created_at, expires_at, initiator_ip, initiator_country, curl_platform, status: 'pending' });
          }
          return { meta: { changes: 1 } };
        },
        async first() { return records.find((row) => row.device_code === values[0]) ?? null; },
      };
    } };
  },
};
for (const mode of ['standard', 'sealed']) {
  for (const platform of ['unix', 'Windows_NT']) {
    const response = await claimRoutes.request(`https://api.example/curl/start/${mode}/${platform}`, {}, { DB });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    const record = records.at(-1);
    const url = response.headers.get('X-BayLeaf-Claim-URL');
    assert.equal(url, `https://api.example/auth/claim?c=${record.user_code}`);
    assert.ok(!url.includes(record.device_code));
    assert.ok(!url.includes('sk-bayleaf-'));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const cookie = response.headers.get('Set-Cookie');
    assert.ok(cookie.startsWith(`bayleaf_claim_device=${record.device_code};`));
    for (const attribute of ['Path=/auth/claim/curl', 'HttpOnly', 'SameSite=Strict', 'Max-Age=600', 'Secure']) {
      assert.ok(cookie.includes(attribute), attribute);
    }
    assert.equal(record.client, mode === 'sealed' ? 'OpenCode for BayLeaf Sealed' : 'OpenCode for BayLeaf');
    const instructions = await claimRoutes.request(`https://api.example/curl/instructions/${platform === 'unix' ? 'unix' : 'windows'}`, {
      headers: { Cookie: cookie.split(';')[0] },
    }, { DB });
    assert.equal(instructions.status, 200);
    assert.ok((await instructions.text()).includes(url));
    // The reused-connection URL transfer repeats the header without a new claim.
    const before = records.length;
    const repeat = await claimRoutes.request('https://api.example/curl/url', { headers: { Cookie: cookie.split(';')[0] } }, { DB });
    assert.equal(repeat.status, 204);
    assert.equal(repeat.headers.get('X-BayLeaf-Claim-URL'), url);
    assert.equal(repeat.headers.get('Cache-Control'), 'no-store');
    assert.equal(records.length, before);
    assert.equal((await claimRoutes.request('https://api.example/curl/url', {}, { DB })).status, 404);
  }
}
assert.equal((await claimRoutes.request('/curl/start/invalid/unix', {}, { DB })).status, 404);
assert.equal((await sealedWellKnownRoutes.request('/opencode', {}, { SEALED_ENABLED: 'false' })).status, 503);
assert.equal((await windowsWellKnownRoutes.request('/sealed/windows/.well-known/opencode', {}, { SEALED_ENABLED: 'false' })).status, 503);

for (const mode of ['standard', 'sealed', 'sandbox']) {
  const prefix = mode === 'standard' ? '' : `/${mode}`;
  const response = await windowsWellKnownRoutes.request(`https://api.example${prefix}/windows/.well-known/opencode`, {}, { SEALED_ENABLED: 'true' });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.auth.env, 'BAYLEAF_API_KEY');
  assert.deepEqual(document.auth.command.slice(0, 4), ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(document.auth.command.length, 5);
  const script = document.auth.command[4];
  assert.ok(script.includes("$origin='https://api.example'"));
  assert.ok(script.includes(`/start/${mode === 'sealed' ? 'sealed' : 'standard'}/Windows_NT`));
  assert.ok(script.includes('$waitMilliseconds=600000'));
  assert.ok(script.includes('System.Net.CookieContainer'));
  assert.ok(script.includes('$request.AllowAutoRedirect=$false'));
  assert.ok(script.includes('[Console]::Out.Write($credential)'));
  assert.ok(!/ExecutionPolicy|ServerCertificateValidationCallback|SecurityProtocol|Invoke-Expression|Start-Process|curl\.exe|--write-out|Set-Content|Out-File/.test(script));
  assert.deepEqual(document.remote_config, {
    url: `https://api.example${prefix}/.well-known/opencode/config`,
    headers: { Authorization: 'Bearer {env:BAYLEAF_API_KEY}' },
  });
  // The saved login URL can differ from config URL: auth.env supplies the token.
  assert.equal(document.remote_config.headers.Authorization.replace('{env:BAYLEAF_API_KEY}', 'fixture-key'), 'Bearer fixture-key');
}

// Optional exact public argv artifact for main's native Windows HTTPS runner.
const emitIndex = process.argv.indexOf('--emit-windows-commands');
if (emitIndex !== -1) {
  const path = process.argv[emitIndex + 1];
  assert.ok(path, '--emit-windows-commands requires an output path');
  const commands = {};
  for (const mode of ['standard', 'sealed', 'sandbox']) {
    const prefix = mode === 'standard' ? '' : `/${mode}`;
    const doc = await (await windowsWellKnownRoutes.request(`https://api.bayleaf.dev${prefix}/windows/.well-known/opencode`, {}, { SEALED_ENABLED: 'true' })).json();
    commands[mode] = doc.auth.command;
  }
  await writeFile(path, JSON.stringify(commands, null, 2) + '\n');
}

// Simulate the background-service launch with pipes, not an attached terminal.
// The poll response is a fixture sentinel, not a real credential or inference call.
const sentinel = 'sk-bayleaf-' + 'a'.repeat(32); // Synthetic, never a real key.
let expectedCookie;
let approvalUrl;
let scenario = 'approved';
let polls = 0;
const seen = [];
const server = createServer(async (req, res) => {
  try {
    seen.push(req.url);
    if (req.url.endsWith('/poll')) {
      assert.equal(req.headers.cookie, expectedCookie);
      polls++;
      if (scenario === 'pending' || (scenario === 'approved' && polls <= 2)) {
        res.writeHead(429, { 'Retry-After': '1' }); res.end(); return;
      }
      if (scenario === 'denied') { res.writeHead(403); res.end('private error sentinel'); return; }
      if (scenario === 'error') { res.writeHead(500); res.end('private error sentinel'); return; }
      if (scenario === 'invalid-key') { res.end('private error sentinel'); return; }
      res.end(sentinel);
      return;
    }
    const isUrl = req.url.endsWith('/curl/url');
    if (isUrl) assert.equal(req.headers.cookie, expectedCookie);
    const response = await claimRoutes.request(
      `http://localhost:${server.address().port}${req.url.replace('/auth/claim', '')}`,
      isUrl ? { headers: { Cookie: req.headers.cookie } } : {}, { DB },
    );
    if (!isUrl) expectedCookie = response.headers.get('Set-Cookie').split(';')[0];
    approvalUrl = response.headers.get('X-BayLeaf-Claim-URL');
    if (scenario === 'bad-url') response.headers.set('X-BayLeaf-Claim-URL', 'https://attacker.example/auth/claim?c=ABCD-EFGH');
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const base = `http://localhost:${server.address().port}`;
  for (const [routes, mode] of [[wellKnownRoutes, 'standard'], [sealedWellKnownRoutes, 'sealed'], [sandboxWellKnownRoutes, 'standard']]) {
    const response = await routes.request(`${base}/opencode`, {}, { SEALED_ENABLED: 'true' });
    assert.equal(response.status, 200);
    const { auth } = await response.json();
    const [executable, ...args] = auth.command;
    assert.equal(executable, 'curl');
    assert.equal(args[0], '-q');
    // start, then write-out on a reused connection, then credential-only poll.
    const nexts = args.flatMap((arg, i) => (arg === '--next' ? [i] : []));
    assert.equal(nexts.length, 2);
    assert.equal(args.filter((arg) => arg === '--write-out').length, 1);
    assert.ok(args.indexOf('--write-out') > nexts[0] && args.indexOf('--write-out') < nexts[1]);
    assert.equal(args.filter((arg) => arg === '--http1.1').length, 3);
    assert.ok(!args.some((arg) => /CON|instructions|--variable|--expand-url|\/dev\/stderr/.test(arg)));
    assert.deepEqual(args.filter((arg, i) => args[i - 1] === '-b'), ['/dev/NUL', '/dev/NUL', '/dev/NUL']);
    seen.length = 0;
    polls = 0;
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    assert.equal(stdout, sentinel);
    assert.equal(stderr, `\nOpen this URL to approve access:\n${approvalUrl}\n\n`);
    assert.equal(polls, 3, 'two pending responses must retry without terminal error noise');
    assert.ok(!stderr.includes(records.at(-1).device_code));
    assert.ok(!stderr.includes(sentinel));
    assert.equal(seen[0], `/auth/claim/curl/start/${mode}/unix`);
    assert.equal(seen[1], '/auth/claim/curl/url');
    assert.ok(seen.slice(2).every((path) => path === '/auth/claim/curl/poll'));
  }
  if (process.platform === 'win32') {
    for (const mode of ['standard', 'sealed', 'sandbox']) {
      const prefix = mode === 'standard' ? '' : `/${mode}`;
      const { auth } = await (await windowsWellKnownRoutes.request(`${base}${prefix}/windows/.well-known/opencode`, {}, { SEALED_ENABLED: 'true' })).json();
      for (scenario of ['approved', 'denied', 'error', 'invalid-key', 'bad-url', 'pending']) {
        polls = 0;
        const args = [...auth.command.slice(1)];
        // Shorten the production deadline only in this timeout fixture.
        if (scenario === 'pending') args[3] = args[3].replace('$waitMilliseconds=600000', '$waitMilliseconds=1200');
        const child = spawn(auth.command[0], args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const [code] = await once(child, 'close');
        assert.equal(code, scenario === 'approved' ? 0 : 1, stderr);
        assert.equal(stdout, scenario === 'approved' ? sentinel : '');
        if (scenario === 'bad-url') {
          assert.equal(polls, 0);
          assert.ok(!stderr.includes('attacker.example'));
        } else assert.ok(stderr.includes(approvalUrl));
        assert.ok(!stderr.includes(expectedCookie.split('=')[1]));
        assert.ok(!stderr.includes(sentinel));
        assert.ok(!stderr.includes('private error sentinel'));
        if (scenario === 'approved') assert.ok(polls >= 2);
        if (scenario === 'denied') assert.ok(stderr.includes('Access denied.'));
        if (scenario === 'pending') assert.ok(stderr.includes('Approval timed out.'));
      }
    }
    console.log('PASS: generated Windows PowerShell argv, pending/approval/denial/error/invalid-key/timeout over local HTTP');
  } else {
    console.log('SKIP: native Windows PowerShell execution unavailable; HTTPS qualification of generated argv remains an integration gate');
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log('PASS: claim header/cookies/legacy routes, Windows argv/config contract, Standard/Sealed/Sandbox piped curl stdout/stderr separation');
