import type { Bindings } from './types';
import { revokeSandboxCredentials } from './sandboxCredentials';
import { getV2Sandbox, listV2Sandboxes, v2Call, v2SandboxPath } from './daytonaV2';

export const SANDBOX_REAPER_CRON = '17 8 * * *';
const INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;
// Only the exact deployment owner for the passive existence probe is exempt.
const PROBE_SANDBOX_OWNER = 'probe@bayleaf.dev';

/** Metadata only: never access Toolbox, wake compute, or refresh activity. */
export async function reapInactiveSandboxes(env: Bindings, now = Date.now()) {
  const report = { scanned: 0, candidates: 0, deleted: 0, pending: 0, skipped: 0, failed: 0,
    dryRun: env.SANDBOX_REAPER_MODE !== 'delete' || env.DAYTONA_V2_REAPER_DELETE !== 'true' };
  if (!['dry-run', 'delete'].includes(env.SANDBOX_REAPER_MODE ?? '')) return report;
  if (!env.DAYTONA_DEPLOYMENT_LABEL || !env.DAYTONA_API_KEY || !Number.isFinite(now)) {
    throw new Error('Sandbox reaper configuration invalid');
  }
  const ids = await listV2Sandboxes(env);
  const confirmedAbsent = new Set<string>();
  report.scanned = ids.length;
  for (const id of ids) {
    try {
      const candidate = await getV2Sandbox(id, env);
      if (!candidate) {
        confirmedAbsent.add(id);
        report.skipped++; continue;
      }
      const owner = candidate.labels?.[env.DAYTONA_DEPLOYMENT_LABEL];
      if (owner && candidate.state === 'deleting') {
        report.pending++; continue;
      }
      if (!owner || owner === PROBE_SANDBOX_OWNER || !['paused', 'stopped'].includes(candidate.state)) {
        report.skipped++; continue;
      }
      const observedActivity = Date.parse(candidate.lastActivityAt ?? '');
      if (!Number.isFinite(observedActivity)) { report.skipped++; continue; }
      const imported = await env.DB.prepare(
        'SELECT source_activity_ms,baseline_activity_ms FROM sandbox_import_activity WHERE sandbox_id=?',
      ).bind(id).first<{ source_activity_ms: number; baseline_activity_ms: number }>();
      const activity = imported && observedActivity <= imported.baseline_activity_ms
        ? imported.source_activity_ms : observedActivity;
      if (activity > now - INACTIVITY_MS) { report.skipped++; continue; }
      report.candidates++;
      const fresh = await getV2Sandbox(id, env);
      if (!fresh || fresh.state !== candidate.state || fresh.lastActivityAt !== candidate.lastActivityAt ||
          fresh.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== owner) {
        report.skipped++; continue;
      }
      if (report.dryRun) continue;
      await revokeSandboxCredentials(env, id);
      const response = await v2Call(env, v2SandboxPath(id), 'DELETE');
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw new Error('Deletion failed');
      if (await getV2Sandbox(id, env)) { report.pending++; continue; }
      await env.DB.batch([
        env.DB.prepare('UPDATE user_keys SET daytona_sandbox_id=NULL WHERE daytona_sandbox_id=?').bind(id),
        env.DB.prepare('DELETE FROM sandbox_import_activity WHERE sandbox_id=?').bind(id),
      ]);
      report.deleted++;
    } catch { report.failed++; }
  }
  // An async delete may leave the search index before the next run sees it.
  // Reconcile bindings separately; no cleanup is inferred from search alone.
  if (!report.dryRun) {
    const cached = await env.DB.prepare("SELECT daytona_sandbox_id AS id FROM user_keys WHERE daytona_sandbox_id GLOB 'sbx_*'").all<{ id: string }>();
    const listed = new Set(ids);
    for (const { id } of cached.results) {
      if (listed.has(id) && !confirmedAbsent.has(id)) continue;
      try {
        if (!confirmedAbsent.has(id)) {
          const current = await getV2Sandbox(id, env);
          if (current) {
            if (current.state === 'deleting' && current.labels?.[env.DAYTONA_DEPLOYMENT_LABEL]) report.pending++;
            continue;
          }
        }
        await revokeSandboxCredentials(env, id);
        await env.DB.batch([
          env.DB.prepare('UPDATE user_keys SET daytona_sandbox_id=NULL WHERE daytona_sandbox_id=?').bind(id),
          env.DB.prepare('DELETE FROM sandbox_import_activity WHERE sandbox_id=?').bind(id),
        ]);
      } catch { report.failed++; }
    }
  }
  return report;
}
