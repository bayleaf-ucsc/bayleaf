/** Offline source integration: no credentials or provider traffic. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/telemetry.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { queueDeletionTelemetry } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const previous = globalThis.fetch;
const sandbox = { scanned: 3, candidates: 2, deleted: 1, pending: 1, skipped: 1, failed: 0, dryRun: false,
  rawReport: 'private', id: 'arbitrary-identity' };
const accounts = { mode: 'delete', candidates: 1, retired: 1, recheckSkipped: 0,
  providerPending: 0, outboxCompleted: 1, email: 'never-export@example.invalid' };
const tokens = { TELEMETRY_SANDBOX_REAPER_WRITE_TOKEN: 'synthetic-sandbox-write-token',
  TELEMETRY_API_RETENTION_WRITE_TOKEN: 'synthetic-account-write-token' };
const started = new Date().toISOString();
const pending = [], calls = [];
const ctx = { waitUntil: p => pending.push(p) };
try {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); throw new Error('collector unavailable');
  };
  queueDeletionTelemetry({}, ctx, 'sandbox-reaper', sandbox, started, 'delete');
  queueDeletionTelemetry({ TELEMETRY_ENABLED: 'true' }, ctx, 'sandbox-reaper', sandbox, started, 'delete');
  await Promise.all(pending.splice(0));
  assert.equal(calls.length, 0);
  const env = { TELEMETRY_ENABLED: 'true', ...tokens, TINFOIL_ADMIN_KEY: 'never-admin' };
  queueDeletionTelemetry(env, ctx, 'sandbox-reaper', sandbox, started, 'delete');
  queueDeletionTelemetry(env, ctx, 'api-retention', accounts, started, 'delete');
  await Promise.all(pending.splice(0));
  assert.equal(calls.length, 2);
  for (const [i, source] of ['sandbox-reaper', 'api-retention'].entries()) {
    const { url, options } = calls[i];
    const body = JSON.parse(options.body);
    assert.equal(url, 'https://telemetry.bayleaf.dev/v1/deletions');
    assert.equal(body.source, source);
    assert.equal(options.headers.Authorization, `Bearer ${Object.values(tokens)[i]}`);
    assert.equal(body.outcome, i === 0 ? 'partial' : 'success');
    for (const secret of ['private', 'arbitrary-identity', 'never-export', 'never-admin'])
      assert.ok(!options.body.includes(secret));
  }
  // Invalid or absent reports are not fabricated as zero-work success.
  queueDeletionTelemetry(env, ctx, 'api-retention', undefined, started, 'delete');
  queueDeletionTelemetry(env, ctx, 'sandbox-reaper', {}, started, 'delete');
  assert.equal(pending.length, 0);
  assert.doesNotThrow(() => queueDeletionTelemetry(env, { waitUntil(p) { pending.push(p); throw new Error('closed'); } },
    'api-retention', accounts, started, 'delete'));
  await Promise.all(pending.splice(0));
  // Exercise the real scheduled entrypoint, replacing job boundaries only.
  // Keep telemetry and all scheduler ordering/retry guards unmodified.
  const stubs = {
    './serviceSessions': 'export class SandboxManagement {}\n' +
      'export const cleanupServiceSessions = env => globalThis.__telemetryJob("sessions", env);',
    './sandboxCredentials': 'export const cleanupSandboxCredentials = env => globalThis.__telemetryJob("credentials", env);',
    './sandboxReaper': 'export const SANDBOX_REAPER_CRON = "17 8 * * *";\n' +
      'export const reapInactiveSandboxes = env => globalThis.__telemetryJob("sandbox", env);',
    './userRetention': 'export const cleanupInactiveUsers = env => globalThis.__telemetryJob("accounts", env);',
  };
  const appBundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', loader: { '.py': 'text' }, plugins: [{ name: 'job-boundaries', setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }));
      b.onResolve({ filter: /^\.\/(serviceSessions|sandboxCredentials|sandboxReaper|userRetention)$/ }, args =>
        args.importer.endsWith('/src/index.ts') ? { path: args.path, namespace: 'stub' } : undefined);
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'workers'
        ? 'export class WorkerEntrypoint {}' : stubs[args.path], loader: 'js' }));
    } }] });
  const { default: worker } = await import(
    `data:text/javascript;base64,${Buffer.from(appBundle.outputFiles[0].text).toString('base64')}`);
  const originalInfo = console.info;
  console.info = () => {};
  try {
    for (const scenario of ['success', 'sandbox-pending', 'account-pending', 'inbox-pending', 'sandbox-throws', 'accounts-throws']) {
      const order = [];
      const jobError = new Error('original job failure');
      globalThis.__telemetryJob = async name => {
        order.push(name);
        if (scenario === `${name}-throws`) throw jobError;
        if (name === 'sandbox') return { ...sandbox, pending: scenario === 'sandbox-pending' ? 1 : 0 };
        if (name === 'accounts') return { ...accounts, providerPending: scenario === 'account-pending' ? 1 : 0,
          pending: scenario === 'inbox-pending' ? 1 : 0 };
      };
      const before = calls.length;
      const run = worker.scheduled({ cron: '17 8 * * *', scheduledTime: Date.now() }, {
        ...env, SANDBOX_REAPER_MODE: 'delete', USER_RETENTION_MODE: 'delete',
      }, ctx);
      if (scenario === 'success') await run;
      else if (scenario.endsWith('throws')) await assert.rejects(run, error => error === jobError);
      else await assert.rejects(run, scenario === 'sandbox-pending'
        ? /Sandbox reaper needs retry/ : /Account resource cleanup needs retry/);
      await Promise.all(pending.splice(0));
      const stopAfterSandbox = ['sandbox-pending', 'sandbox-throws'].includes(scenario);
      assert.deepEqual(order, stopAfterSandbox ? ['sessions', 'credentials', 'sandbox']
        : ['sessions', 'credentials', 'sandbox', 'accounts']);
      assert.equal(calls.length - before, scenario === 'sandbox-throws' ? 0
        : stopAfterSandbox || scenario === 'accounts-throws' ? 1 : 2);
    }
  } finally { console.info = originalInfo; delete globalThis.__telemetryJob; }
  console.log('API telemetry source integration passed');
} finally { globalThis.fetch = previous; }
