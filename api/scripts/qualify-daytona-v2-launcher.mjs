#!/usr/bin/env node
/** Local Worker + real disposable Daytona v2. No production BayLeaf traffic. */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

if (process.argv[2] !== '--live' || !process.env.DAYTONA_API_KEY || !process.env.DAYTONA_V2_IMAGE) {
  console.error('Use --live with DAYTONA_API_KEY and a named DAYTONA_V2_IMAGE in the BayLeaf Daytona project.');
  process.exit(2);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const label = 'bayleaf-172-launcher-' + randomBytes(8).toString('hex');
const email = 'owner@example.test', other = 'other@example.test', api = 'https://api.example.test';
const ownerKey = 'sk-bayleaf-' + randomBytes(32).toString('hex');
const oidc = randomBytes(32).toString('hex');
const previewSecret = randomBytes(32);
const installationKey = randomBytes(32).toString('hex');
const daytonaKey = process.env.DAYTONA_API_KEY;
const coldOpenChamber = process.argv.includes('--cold-openchamber');
const openChamberProbe = `import importlib.util, pathlib, re, subprocess, time, uuid
spec = importlib.util.spec_from_file_location('setup', '/home/daytona/workspace/setup-fixture.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
setup.select_service('openchamber')
(setup.ROOT / 'credentials').mkdir(parents=True)
(setup.ROOT / 'credentials/owner-key').write_text('dtns_synthetic_package_fixture')
operation = str(uuid.uuid4())
setup.atomic('request.json', {'operation': operation, 'deadline': int(time.time()) + 360})
original_command = setup.command
def command_with_install_diagnostics(argv, timeout=30, env=None):
    if argv[:3] != ['node', '--input-type=module', '-e']:
        return original_command(argv, timeout, env)
    result = subprocess.run(argv, env=env, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        lines = [line.strip() for line in result.stderr.splitlines()
                 if 'Error:' in line or 'code:' in line]
        diagnostic = re.sub(r'https?://\\S+', '[URL]', '; '.join(lines))[:300]
        print('upstream installer diagnostic: ' + diagnostic)
        raise setup.Failure('command_failed')
setup.command = command_with_install_diagnostics
try:
    setup.install(setup.Progress(operation))
    setup.ensure_opencode(operation)
    subprocess.run([str(pathlib.Path.home() / '.opencode/bin/opencode'), '--version'],
                   capture_output=True, check=True, timeout=20)
    print('cold-install-pass')
except setup.Failure as error:
    print('cold-install-failure:' + str(error))
`;
const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
  import app from './src/index.ts';
  export { SandboxBrowser, PreviewConnections } from './src/index.ts';
  export default { ...app, async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.hostname === 'controller.invalid') {
      // Test-only entry point for the same private owner RPC used by Sandboxes.
      const id = env.SANDBOX_BROWSER.idFromName('owner@example.test');
      return env.SANDBOX_BROWSER.get(id).fetch('https://controller' + url.pathname + url.search,
        { method: req.method, headers: { 'X-BayLeaf-Owner': 'owner@example.test' } });
    }
    const headers = new Headers(req.headers);
    if (headers.has('X-Test-Fetch-Mode')) {
      headers.set('Sec-Fetch-Mode', headers.get('X-Test-Fetch-Mode'));
      headers.delete('X-Test-Fetch-Mode');
    }
    if (headers.has('X-Test-Origin')) {
      headers.set('Origin', headers.get('X-Test-Origin'));
      headers.delete('X-Test-Origin');
    }
    return app.fetch(new Request(req, {headers}), env, ctx);
  }};
` }, format: 'esm', platform: 'browser', bundle: true, write: false,
external: ['cloudflare:workers'], loader: { '.py': 'text', '.md': 'text' } });

const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: 'v2-qualification', modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  durableObjects: { SANDBOX_BROWSER: { className: 'SandboxBrowser', useSQLite: true },
    PREVIEW_CONNECTIONS: { className: 'PreviewConnections', useSQLite: true } },
  bindings: { BROWSER_SANDBOX_ENABLED: 'true', PREVIEWS_ENABLED: 'true', PREVIEWS_API_ORIGIN: api,
    PREVIEWS_DOMAIN: 'previews.example.test', PREVIEWS_SECRET: previewSecret.toString('base64'),
    PREVIEWS_INSTALLATION_KEY: installationKey,
    PREVIEWS_V2_UPSTREAM_SUFFIXES: '.ash-1.daytonaproxy03.net',
    OIDC_CLIENT_SECRET: oidc, ALLOWED_EMAIL_DOMAIN: 'example.test',
    DAYTONA_API_VERSION: '2', DAYTONA_API_KEY: daytonaKey, DAYTONA_DEPLOYMENT_LABEL: label,
    DAYTONA_V2_IMAGE: process.env.DAYTONA_V2_IMAGE, DAYTONA_V2_REGION: 'us-east-ash-1',
    DAYTONA_V2_CREATE_ENABLED: 'true' },
}]}));

function provider(path, init = {}) {
  return fetch('https://api.daytona.com' + path, {
    ...init, headers: { Authorization: `Bearer ${daytonaKey}`, ...init.headers },
    redirect: 'manual', signal: AbortSignal.timeout(30_000),
  });
}

async function waitFor(check, description, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(2000);
  }
  throw new Error(`Timed out: ${description}`);
}

const identity = email => {
  const data = [{ alg: 'HS256', typ: 'JWT' }, { email, name: 'Synthetic', exp: Date.now() / 1000 + 3600 }]
    .map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return data + '.' + createHmac('sha256', oidc).update(data).digest('base64url');
};

function browser(worker, viewer) {
  const cookies = new Map([[new URL(api).host, new Map([['bayleaf_session', identity(viewer)]])]]);
  return async (url, options = {}) => {
    const { host } = new URL(url);
    const jar = cookies.get(host) ?? new Map();
    const headers = { 'Sec-Fetch-Site': 'none', 'X-Test-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
      ...options.headers };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await worker.fetch(url, { headers, redirect: 'manual' });
    for (const cookie of r.headers.getSetCookie()) {
      const [name, ...value] = cookie.split(';')[0].split('=');
      if (/Max-Age=0/i.test(cookie)) jar.delete(name);
      else jar.set(name, value.join('='));
    }
    cookies.set(host, jar);
    return r;
  };
}

async function handoff(visit, url) {
  for (let i = 0; i < 8; i++) {
    const r = await visit(url);
    if (r.status !== 302) return r;
    url = new URL(r.headers.get('Location'), url).href;
  }
  throw new Error('Preview handoff loop');
}

async function directWebSocketEvidence(db, origin) {
  const hostname = new URL(origin).hostname;
  const row = await db.prepare('SELECT upstream_encrypted FROM preview_registrations WHERE hostname=?').bind(hostname).first();
  const bytes = Buffer.from(row.upstream_encrypted, 'base64');
  const key = await crypto.subtle.importKey('raw', previewSecret, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12),
    additionalData: new TextEncoder().encode(hostname) }, key, bytes.subarray(12));
  let target = new TextDecoder().decode(plain);
  if (target.startsWith('{')) target = JSON.parse(target).upstream_url;
  const url = new URL('/websockify', target);
  url.protocol = 'wss:';
  const socket = new WebSocket(url, ['binary']);
  socket.binaryType = 'arraybuffer';
  try {
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 10000);
      socket.addEventListener('message', event => {
        clearTimeout(timer);
        resolve(Buffer.from(event.data).subarray(0, 4).toString('hex'));
      }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); resolve('rejected'); }, { once: true });
    });
  } finally { socket.close(); }
}

let db, worker;
try {
  db = await mf.getD1Database('DB');
  for (const name of (await readdir(root + 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
    const sql = (await readFile(root + 'migrations/' + name, 'utf8')).replace(/^\s*--.*$/gm, '');
    const statements = name === '0009_preview_origin_invalidation.sql' ? sql.split(/;\s*(?=CREATE|$)/) : sql.split(';');
    for (const statement of statements.map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare('INSERT INTO user_keys(email,bayleaf_token,account_generation) VALUES (?,?,?)').bind(email, ownerKey, label).run();
  worker = await mf.getWorker();
  const call = (path, body) => worker.fetch(api + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const exec = await call('/sandbox/exec', { command: 'printf bayleaf-v2-launcher' });
  assert.equal(exec.status, 200, 'API provisioning and exec');
  assert.equal((await exec.json()).output, 'bayleaf-v2-launcher');
  const status = await (await call('/sandbox')).json();
  assert.deepEqual([status.reservedCpu, status.cpu, status.memory, status.disk], [1, 2, 2, 10]);
  const filePath = '/sandbox/files/home/daytona/workspace/launcher-canary';
  const put = await worker.fetch(api + filePath, { method: 'PUT',
    headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/octet-stream' }, body: 'v2-canary' });
  assert.equal(put.status, 200, 'API v2 file upload');
  const download = await worker.fetch(api + filePath, { headers: { Authorization: `Bearer ${ownerKey}` } });
  assert.equal(download.status, 200, 'API v2 file download');
  assert.equal(await download.text(), 'v2-canary');
  if (coldOpenChamber) {
    const upload = await worker.fetch(api + '/sandbox/files/home/daytona/workspace/setup-fixture.py', {
      method: 'PUT', headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/octet-stream' },
      body: await readFile(root + 'scripts/browser-setup.py'),
    });
    assert.equal(upload.status, 200, 'installer source upload');
    const machine = await (await provider(`/sandboxes/${encodeURIComponent(status.id)}`)).json();
    const proxy = new URL(machine.toolbox_proxy_url);
    assert.equal(proxy.origin, 'https://proxy.ash-1.us-east.daytona.app');
    const install = await fetch(`${proxy.origin}/toolbox/${encodeURIComponent(status.id)}/processes?waitMs=330000&logs=text`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(345_000),
      headers: { Authorization: `Bearer ${daytonaKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ argv: ['python3', '-c', openChamberProbe], timeoutMs: 320_000 }),
    });
    assert.equal(install.status, 201, 'OpenChamber install process');
    const result = await install.json();
    const report = result.logs?.frames?.filter(f => f.channel === 'stdout').map(f => f.data).join('').trim();
    assert.equal(report, 'cold-install-pass', `OpenChamber package qualification: ${report ?? 'no report'}`);
    console.log('OpenChamber and its managed OpenCode cold install passed on the agreed shape.');
  }
  const controller = (action, method = 'GET') => worker.fetch(`https://controller.invalid/${action}?service=desktop`, { method });
  assert.equal((await controller('start', 'POST')).status, 202);
  const desk = await waitFor(async () => {
    const response = await controller('status');
    assert.equal(response.status, 200);
    const state = await response.json();
    if (state.phase === 'failed') throw new Error(`Managed Desktop setup: ${state.error}`);
    return state.phase === 'ready' && state.url && state;
  }, 'managed Desktop', 120);
  const session = await call('/sandbox/computer/session', {});
  assert.equal(session.status, 200, 'managed Computer Use generation');
  const visit = browser(worker, email);
  const page = await handoff(visit, desk.url);
  assert.equal(page.status, 200, 'authorized owner can see noVNC');
  assert.match(await page.text(), /noVNC/);
  assert.notEqual((await handoff(browser(worker, other), desk.url)).status, 200, 'signed-in non-owner denied');
  // Lathe's installation-authorized contract is distinct from the managed
  // launcher slot. Register a second signed URL for the same existing process
  // so this check exercises the real v2 destination on that independent path.
  const signed = await provider(`/sandboxes/${encodeURIComponent(status.id)}/ports/6080/signed-preview-urls`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_in_seconds: 120 }),
  });
  assert.ok(signed.ok, 'sign the fixture desktop port');
  const target = (await signed.json()).url;
  const registered = await worker.fetch(api + '/previews/registrations', {
    method: 'POST', headers: { Authorization: `Bearer ${installationKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: { subject: 'owui-fixture-owner', email }, access: 'private', upstream_url: target }),
  });
  assert.ok(registered.ok, 'Lathe installation can register v2 preview');
  const lease = await registered.json();
  assert.equal(new URL(lease.url).hostname.endsWith('.previews.example.test'), true, 'return a BayLeaf origin');
  assert.equal(lease.url.includes(new URL(target).hostname), false, 'never return the Daytona bearer origin');
  assert.equal((await handoff(browser(worker, email), new URL('/vnc.html', lease.url).href)).status, 200,
    'installation-registered v2 preview serves its owner');
  assert.notEqual((await handoff(browser(worker, other), lease.url)).status, 200,
    'installation-registered preview rejects a signed-in non-owner');
  const latheLabel = new URL(lease.url).hostname.split('.')[0];
  const revoked = await worker.fetch(api + '/previews/registrations/' + latheLabel,
    { method: 'DELETE', headers: { Authorization: `Bearer ${installationKey}` } });
  assert.ok(revoked.ok, 'revoke the installation registration');
  const origin = new URL(desk.url).origin;
  console.log('Direct provider RFB signature:', await directWebSocketEvidence(db, origin));
  const response = await visit(origin + '/websockify', { headers: {
    Upgrade: 'websocket', 'X-Test-Origin': origin, 'X-Test-Fetch-Mode': 'websocket',
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty', 'Sec-WebSocket-Protocol': 'binary',
  } });
  assert.equal(response.status, 101, 'owner WebSocket through the real provider');
  const socket = response.webSocket;
  try {
    const greeting = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('RFB greeting timeout')), 10000);
      const chunks = [];
      socket.addEventListener('message', async e => {
        try {
          const bytes = e.data instanceof Blob ? Buffer.from(await e.data.arrayBuffer())
            : typeof e.data === 'string' && /^UkZC[A-Za-z0-9+/=\r\n]*$/.test(e.data) ? Buffer.from(e.data, 'base64')
            : Buffer.from(e.data);
          chunks.push(bytes);
          const prefix = Buffer.concat(chunks);
          if (prefix.length < 4) return;
          clearTimeout(timeout);
          resolve(prefix.subarray(0, 4).toString('hex'));
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
      socket.accept();
    });
    assert.equal(greeting, '52464220', `RFB greeting signature differs (received hex ${greeting})`);
  } finally { socket.close(); }
  const sandboxPath = `/sandboxes/${encodeURIComponent(status.id)}`;
  assert.ok((await provider(sandboxPath + '/pause', { method: 'POST' })).ok, 'explicit fixture pause');
  await waitFor(async () => (await (await provider(sandboxPath)).json()).status === 'paused', 'fixture pause');
  assert.equal((await controller('start', 'POST')).status, 202, 'resume through owner launcher');
  const reopened = await waitFor(async () => {
    const state = await (await controller('status')).json();
    if (state.phase === 'failed') throw new Error(`Managed Desktop resume: ${state.error}`);
    return state.url;
  }, 'existing link after resume');
  assert.equal(reopened, desk.url, 'pause/resume keeps the managed URL');
  assert.equal((await visit(reopened)).status, 200, 'existing owner session after resume');
  console.log('Verified v2 provisioning, file I/O, managed and Lathe-style private previews, RFB, non-owner denial, revocation and link reuse after pause/resume.');
} catch (error) {
  // Assertions use fixed test descriptions; avoid printing bearer URLs or bodies.
  console.error('Launcher qualification failed:', error.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  try {
    const ids = await provider(`/sandboxes/search?${new URLSearchParams({ labels: JSON.stringify({ [label]: email }), limit: '100' })}`);
    assert.ok(ids.ok, 'fixture cleanup search');
    const candidates = await ids.json();
    assert.equal(candidates.next_cursor, null, 'fixture cleanup pagination');
    const cached = db && await db.prepare('SELECT daytona_sandbox_id AS id FROM user_keys WHERE email=?').bind(email).first();
    const owned = new Set(candidates.sandboxes.map(m => m.id));
    if (cached?.id) owned.add(cached.id);
    for (const id of owned) {
      const path = `/sandboxes/${encodeURIComponent(id)}`;
      const r = await provider(path);
      if (r.status === 404) continue;
      assert.ok(r.ok && (await r.json()).labels?.[label] === email, 'fixture cleanup ownership');
      const deleted = await provider(path, { method: 'DELETE' });
      assert.ok(deleted.ok || deleted.status === 404, 'fixture deletion request');
      await waitFor(async () => {
        const state = await provider(path);
        return state.status === 404 || (state.ok && (await state.json()).status === 'deleted');
      }, 'fixture deletion');
    }
    if (db) {
      const rows = await db.prepare('SELECT secret_name FROM sandbox_credentials WHERE email=?').bind(email).all();
      for (const { secret_name } of rows.results) {
        assert.match(secret_name, /^BAYLEAF_SANDBOX_[A-F0-9]{32}$/);
        const path = `/secrets/${secret_name}`;
        const deleted = await provider(path, { method: 'DELETE' });
        assert.ok(deleted.ok || deleted.status === 404, 'fixture secret deletion');
        assert.equal((await provider(path)).status, 404, 'fixture secret absence');
      }
    }
    console.log('Disposable Daytona resources cleaned up.');
  } finally { await mf.dispose(); }
}
