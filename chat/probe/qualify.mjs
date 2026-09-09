// Manual, one-off qualification. Never imported by the Worker or test runner.
// Secrets stay in memory and an exclusive, ignored mode-0600 dev-vars file.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { cleanupSynthetic, probeDetail, metrics } from './index.mjs';

const origin = 'https://chat.bayleaf.dev';
const devVars = new URL('.dev.vars', import.meta.url);
let child, token, userId, createdVars = false;
let stage = 'credentials';
let devDiagnostics = '';
const started = Date.now();
const output = value => console.log(JSON.stringify(value));
async function json(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (response.status !== 200) throw new Error('http');
  return response.json();
}

async function qualifyWorker() {
  const bootstrap = JSON.parse(await readFile(new URL('bootstrap.secrets.json', import.meta.url), 'utf8'));
  const secrets = JSON.parse(await readFile(new URL('worker.secrets.json', import.meta.url), 'utf8'));
  // Only an inference credential, never a management/provisioning key. Opt-in
  // lets the operator source the documented inference token without copying it.
  const directKey = process.argv.includes('--openrouter')
    ? (secrets.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY) : null;
  const apiKey = process.argv.includes('--bayleaf-api')
    ? (secrets.BAYLEAF_API_KEY || process.env.BAYLEAF_API_KEY) : null;
  output({ openrouter: directKey ? 'included' : 'skipped_no_opt_in_or_inference_key' });
  output({ bayleaf_api: apiKey ? 'included' : 'skipped_no_opt_in_or_api_key' });
  if (bootstrap.role !== 'user' || !bootstrap.email || !bootstrap.password ||
      !secrets.OWUI_API_KEY || !secrets.PROBE_PASSWORD) throw new Error('credentials');
  stage = 'signin';
  const identity = await json('/api/v1/auths/signin', {
    method: 'POST', body: JSON.stringify({ email: bootstrap.email, password: bootstrap.password }),
  });
  if (identity.role !== 'user' || identity.id !== bootstrap.id || !identity.token) throw new Error('identity');
  token = identity.token;
  userId = identity.id;
  stage = 'api_key_identity';
  const key = await json('/api/v1/auths/api_key');
  if (key.api_key !== secrets.OWUI_API_KEY) throw new Error('key_identity');
  output({ stage: 'identity', ordinary_user: true, same_api_key_identity: true, cilogon_tested: false });
  stage = 'dev_vars';
  await writeFile(devVars, Object.entries({
    PROBE_PASSWORD: secrets.PROBE_PASSWORD, OWUI_API_KEY: secrets.OWUI_API_KEY, OWUI_E2E_TOKEN: token,
    ...(directKey ? { OPENROUTER_API_KEY: directKey } : {}),
    ...(apiKey ? { BAYLEAF_API_KEY: apiKey } : {}),
  }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  createdVars = true;
  stage = 'wrangler_start';
  // Suppress Wrangler and browser diagnostics, which may include raw upstream
  // errors. Only the allowlisted qualification fields below leave this process.
  child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev',
    '--ip', '127.0.0.1', '--port', '8791',
    '--inspector-ip', '127.0.0.1', '--inspector-port', '8792',
    '--var', 'DEADLINE_MS:55000', '--log-level', 'info', '--show-interactive-dev-session=false'], {
    cwd: new URL('.', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  const collect = chunk => { devDiagnostics = (devDiagnostics + chunk.toString()).slice(-65536); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error('dev_exit');
    try {
      const response = await fetch('http://127.0.0.1:8791/chat/basic', { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.status === 401) { ready = true; break; }
    } catch {}
    await sleep(1000);
  }
  if (!ready) throw new Error('dev_timeout');
  stage = 'qualification';
  for (const [layer, method, path] of [
    ['browser', 'GET', '/chat/basic/e2e'], ['http', 'GET', '/chat/basic'], ['http', 'HEAD', '/chat/basic'],
    ...(directKey ? [['openrouter', 'GET', '/openrouter/basic'], ['openrouter', 'HEAD', '/openrouter/basic']] : []),
    ...(apiKey ? [['api', 'GET', '/api/recommended'], ['api', 'HEAD', '/api/recommended']] : []),
  ]) {
    const begin = performance.now();
    const response = await fetch(`http://127.0.0.1:8791${path}`, {
      method, headers: { Authorization: `Basic ${btoa(`probe:${secrets.PROBE_PASSWORD}`)}` },
      signal: AbortSignal.timeout(85000),
    });
    const elapsed = Math.round(performance.now() - begin);
    await response.body?.cancel();
    output({ layer, method, status: response.status, elapsed_ms: elapsed,
      result: response.headers.get('x-bayleaf-probe-result'),
      stage: response.headers.get('x-bayleaf-probe-stage'),
      cleanup: response.headers.get('x-bayleaf-probe-cleanup'),
      close: response.headers.get('x-bayleaf-probe-close'),
      timing: response.headers.get('server-timing'),
      events_ms: response.headers.get('x-bayleaf-probe-events'),
      metrics_version: response.headers.get('x-bayleaf-probe-metrics-version'),
      worker_location: 'local', browser_binding: layer === 'browser' ? 'remote:true' : null,
    });
    if (response.status !== 200) {
      process.exitCode = 1;
      if (layer === 'browser') break;
    }
  }
}

try {
  if (process.argv.includes('--direct-only') || process.argv.includes('--api-only')) {
    // Fallback when remote Wrangler startup is unavailable. This runs the exact
    // inference/parser code in Node, not the deployed or local HTTP handler.
    const api = process.argv.includes('--api-only');
    const apiKey = api ? process.env.BAYLEAF_API_KEY : process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('credentials');
    stage = 'direct_inference';
    const timing = metrics();
    const signal = AbortSignal.timeout(55000);
    const result = await probeDetail(apiKey, signal, fetch, { direct: !api, api, timing });
    output({ layer: api ? 'api' : 'openrouter', execution: 'node_direct', result: signal.aborted ? 'deadline' : result,
      metrics: timing.snapshot() });
    if (signal.aborted || result !== 'ok') process.exitCode = 1;
  } else await qualifyWorker();
} catch {
  output({ qualification: 'blocked', stage });
  if (stage === 'wrangler_start') output({
    startup_exit: child?.exitCode,
    diagnostic_chars: devDiagnostics.length,
    diagnostics: Object.entries({
      authentication: /authenticat|log in|login|OAuth/i,
      permission: /permission|unauthorized|forbidden/i,
      browser: /browser/i,
      remote: /remote/i,
      preview: /preview/i,
      port: /\bport\b|address.*use/i,
      module: /module|import|resolve/i,
      arguments: /unknown argument|invalid.*argument/i,
      fetch: /fetch|network|connect/i,
      certificate: /certificate|issuer|TLS/i,
      unsupported: /not supported|unsupported/i,
      node_version: /node\.js|node version/i,
      version: /version/i,
      flags: /flag|option/i,
      compatibility_date: /compatibility date/i,
      runtime: /workerd|runtime/i,
      quota: /quota|limit exceeded|too many/i,
      abort: /abort|cancel/i,
    }).filter(([, pattern]) => pattern.test(devDiagnostics)).map(([name]) => name),
    cf_codes: [...devDiagnostics.matchAll(/\[code: (\d+)\]/g)].map(match => Number(match[1])),
  });
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
  if (createdVars) await unlink(devVars);
  // Recover only this experiment's markers if the Worker/client crashed. A
  // bounded scan is not permission to remove pre-existing or unrelated chats.
  if (token && userId) {
    try {
      const rows = await json('/api/v1/chats/list?page=1&include_pinned=true&include_folders=true');
      if (!Array.isArray(rows) || rows.length > 5) throw new Error('cleanup_list');
      const own = rows.filter(row => row.created_at * 1000 >= started - 1000);
      for (const row of own) {
        const record = await json(`/api/v1/chats/${row.id}`);
        const marker = record.variables?.bayleaf_probe;
        const match = marker?.match(/^bayleaf-probe-v1:(\d{13}):[0-9a-f-]{36}$/);
        if (!match || Number(match[1]) < started) throw new Error('unmarked_new_chat');
        await cleanupSynthetic(token, userId, AbortSignal.timeout(15000), {
          marker, chatId: row.id, attempted: true,
        });
      }
      output({ final_synthetic_cleanup: 'confirmed', recovered: own.length });
    } catch {
      output({ final_synthetic_cleanup: 'failed' });
      process.exitCode = 1;
    }
  }
  output({ temporary_server: child ? 'stopped' : 'not_started', temporary_secret_file: createdVars ? 'removed' : 'not_created' });
}
