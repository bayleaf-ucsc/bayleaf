/** Synthetic v2 control-plane checks. No real sandbox mutations or credentials. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const bundle = await build({ entryPoints: ['src/sandboxReaper.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { reapInactiveSandboxes, SANDBOX_REAPER_CRON } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const now = Date.parse('2026-10-06T08:17:00Z');
const cutoff = now - 30 * 86400000;
const id = 'sbx_imported';
const ownerLabel = 'chat.bayleaf.dev';
const fixture = { id, status: 'paused', labels: { [ownerLabel]: 'synthetic@ucsc.edu' },
  lifecycle_policy: { last_activity_at: new Date(now - 1000).toISOString() } };
const originalFetch = globalThis.fetch;
let pages, detail, cached, baseline, requests, mutations, cleared, deleteStatus;
const env = { SANDBOX_REAPER_MODE: 'delete', DAYTONA_API_KEY: 'synthetic',
  DAYTONA_DEPLOYMENT_LABEL: ownerLabel,
  DB: {
    prepare(sql) {
      if (sql.startsWith('SELECT daytona_sandbox_id')) return { all: async () => ({ results: cached }) };
      return { bind(...values) {
        const value = values.at(-1);
        assert.equal(value, id);
        return { first: async () => baseline, run: async () => ({}), sql, value };
      } };
    },
    batch: async statements => {
      assert.match(statements[0].sql, /^UPDATE user_keys/);
      assert.match(statements[1].sql, /^DELETE FROM sandbox_import_activity/);
      cleared++;
    },
  } };
const enabled = { ...env, DAYTONA_V2_REAPER_DELETE: 'true' };
function reset() {
  pages = [{ sandboxes: [{ id }], next_cursor: null }];
  detail = () => fixture;
  cached = [];
  baseline = { source_activity_ms: cutoff, baseline_activity_ms: now - 1000 };
  requests = 0;
  mutations = 0;
  cleared = 0;
  deleteStatus = 202;
}

try {
  assert.equal(SANDBOX_REAPER_CRON, '17 8 * * *');
  assert.ok(readFileSync('wrangler.jsonc', 'utf8').includes('"0 * * * *", "17 8 * * *"'));
  assert.ok(readFileSync('src/index.ts', 'utf8').includes('event.cron === SANDBOX_REAPER_CRON'));
  globalThis.fetch = async (url, options) => {
    requests++;
    const u = new URL(url);
    assert.equal(u.host, 'api.daytona.com');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic');
    assert.equal(options.redirect, 'manual');
    if (u.pathname === '/sandboxes/search') return Response.json(pages[u.searchParams.has('cursor') ? 1 : 0]);
    assert.equal(u.pathname, `/sandboxes/${id}`);
    if (options.method === 'DELETE') {
      mutations++;
      return new Response(null, { status: deleteStatus });
    }
    const body = detail();
    return body === null ? new Response(null, { status: 404 }) : Response.json(body);
  };
  reset();
  await reapInactiveSandboxes({ ...enabled, SANDBOX_REAPER_MODE: undefined }, now);
  assert.equal(requests, 0);
  pages[0].next_cursor = 'next';
  pages.push({ sandboxes: [], next_cursor: null });
  let report = await reapInactiveSandboxes(env, now);
  assert.equal(report.candidates, 1);
  assert.equal(report.dryRun, true);
  assert.equal(mutations, 0);
  report = await reapInactiveSandboxes({ ...enabled, SANDBOX_REAPER_MODE: 'dry-run' }, now);
  assert.equal(report.dryRun, true);
  assert.equal(report.candidates, 1);
  assert.equal(mutations, 0);

  detail = () => ({ ...fixture, lifecycle_policy: { last_activity_at: new Date(now).toISOString() } });
  assert.equal((await reapInactiveSandboxes(enabled, now)).candidates, 0);
  detail = () => ({ ...fixture, labels: { [ownerLabel]: 'probe@bayleaf.dev' } });
  assert.equal((await reapInactiveSandboxes(enabled, now)).candidates, 0);
  detail = () => ({ ...fixture, labels: { [ownerLabel]: 'probe+test@bayleaf.dev' } });
  assert.equal((await reapInactiveSandboxes(env, now)).candidates, 1);
  for (const ineligible of [
    { ...fixture, status: 'running' },
    { ...fixture, status: 'starting' },
    { ...fixture, lifecycle_policy: {} },
    { ...fixture, lifecycle_policy: { last_activity_at: 'invalid' } },
  ]) {
    detail = () => ineligible;
    assert.equal((await reapInactiveSandboxes(enabled, now)).candidates, 0);
  }
  assert.equal(mutations, 0);

  reset();
  let reads = 0;
  detail = () => ++reads === 1 ? fixture : { ...fixture, status: 'running' };
  report = await reapInactiveSandboxes(enabled, now);
  assert.equal(report.candidates, 1);
  assert.equal(report.skipped, 1);
  assert.equal(mutations, 0);

  reset();
  cached = [{ id }];
  deleteStatus = 503;
  report = await reapInactiveSandboxes(enabled, now);
  assert.equal(report.failed, 1);
  assert.equal(report.deleted, 0);
  assert.equal(mutations, 1);
  assert.equal(cleared, 0);

  reset();
  detail = () => mutations ? null : fixture;
  report = await reapInactiveSandboxes(enabled, now);
  assert.equal(report.deleted, 1);
  assert.equal(cleared, 1);

  // An accepted asynchronous delete may remain search-listed.
  reset();
  cached = [{ id }];
  detail = () => ({ ...fixture, status: 'deleting' });
  report = await reapInactiveSandboxes(enabled, now);
  assert.equal(report.pending, 1);
  assert.equal(cleared, 0);
  detail = () => null;
  report = await reapInactiveSandboxes(enabled, now);
  assert.equal(report.pending, 0);
  assert.equal(cleared, 1);

  reset();
  pages[0].next_cursor = 'repeated';
  pages.push({ sandboxes: [], next_cursor: 'repeated' });
  await assert.rejects(reapInactiveSandboxes(enabled, now));
  assert.equal(mutations, 0);
  console.log('Sandbox reaper checks passed');
} finally { globalThis.fetch = originalFetch; }
