import { envelope, runTimes, selectCounts } from './common.mjs';

export const API_USER_COUNTS = Object.freeze(['candidates', 'retired', 'recheckSkipped', 'providerPending', 'outboxCompleted']);
export const SANDBOX_COUNTS = Object.freeze(['scanned', 'candidates', 'deleted', 'pending', 'skipped', 'failed']);

/** Maps the return value of api/src/userRetention.ts, never its D1 rows. */
export function apiUserDeletion(report, run) {
  const base = envelope('api-retention', run);
  const counts = selectCounts(report, API_USER_COUNTS);
  if (!base || !counts || !API_USER_COUNTS.every(k => Object.hasOwn(counts, k))
    || !['delete', 'dry-run', 'disabled'].includes(report.mode)) return null;
  if ((report.mode === 'disabled') !== (run.outcome === 'disabled')) return null;
  if (report.mode !== 'delete' && report.retired !== 0) return null;
  return { ...base, job: 'user-retention', deleted: report.retired,
    extensions: { ...runTimes(run), mode: report.mode, counts } };
}

/** Caller must supply the actual configured mode: dryRun=true alone also means
 * disabled in sandboxReaper.ts and must not be interpreted as an executed run.
 */
export function apiSandboxDeletion(report, run, mode) {
  const base = envelope('sandbox-reaper', run);
  const counts = selectCounts(report, SANDBOX_COUNTS);
  if (!base || !counts || !SANDBOX_COUNTS.every(k => Object.hasOwn(counts, k))
    || !['delete', 'dry-run', 'disabled'].includes(mode) || report.dryRun !== (mode !== 'delete')
    || ((mode === 'disabled') !== (run.outcome === 'disabled'))) return null;
  if (mode !== 'delete' && report.deleted !== 0) return null;
  return { ...base, job: 'sandbox-reaper', deleted: report.deleted,
    extensions: { ...runTimes(run), mode, counts } };
}

export async function emitDeletion(build, sender) {
  try { return await sender(build()); }
  catch { return false; }
}
