import type { Bindings } from './types';
import { revokeSandboxCredentials } from './sandboxCredentials';
import { DAYTONA_DEFAULT_API_URL } from './constants';

export const SANDBOX_REAPER_CRON = '17 8 * * *';
const INACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;
type Machine = {
  id: string;
  labels?: Record<string, string>;
  state?: string;
  desiredState?: string;
  lastActivityAt?: string;
};

/** Metadata only: never access Toolbox, wake compute, or refresh activity. */
export async function reapInactiveSandboxes(env: Bindings, now = Date.now()) {
  const report = { scanned: 0, candidates: 0, deleted: 0, pending: 0, skipped: 0, failed: 0,
    dryRun: env.SANDBOX_REAPER_MODE !== 'delete' };
  if (!['dry-run', 'delete'].includes(env.SANDBOX_REAPER_MODE ?? '')) return report;
  if (!env.DAYTONA_DEPLOYMENT_LABEL || !env.DAYTONA_API_KEY || !Number.isFinite(now)) {
    throw new Error('Sandbox reaper configuration invalid');
  }
  const root = (env.DAYTONA_API_URL || DAYTONA_DEFAULT_API_URL).replace(/\/$/, '');
  const call = (path: string, method = 'GET') => fetch(root + path, {
    method, headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}` },
    redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  const eligible = (m: Machine): boolean => {
    const activity = typeof m.lastActivityAt === 'string' ? Date.parse(m.lastActivityAt) : NaN;
    return typeof m.id === 'string' && !!m.id &&
      typeof m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] === 'string' &&
      !!m.labels[env.DAYTONA_DEPLOYMENT_LABEL] &&
      ['stopped', 'archived'].includes(m.state ?? '') && m.desiredState === m.state &&
      Number.isFinite(activity) && activity <= now - INACTIVITY_MS;
  };

  // Complete discovery before any deletion. Malformed/repeated pagination fails closed.
  const inventory: Machine[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= 100) throw new Error('Sandbox reaper inventory limit exceeded');
    const r = await call('/sandbox' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
    if (!r.ok) throw new Error('Sandbox reaper inventory unavailable');
    const body = await r.json() as { items?: Machine[]; nextCursor?: string | null };
    if (!body || !Array.isArray(body.items)) throw new Error('Sandbox reaper inventory invalid');
    for (const m of body.items) {
      if (!m || typeof m.id !== 'string' || !m.id || ids.has(m.id)) {
        throw new Error('Sandbox reaper inventory invalid');
      }
      ids.add(m.id); inventory.push(m);
    }
    if (body.nextCursor == null) break;
    if (typeof body.nextCursor !== 'string' || !body.nextCursor || cursors.has(body.nextCursor)) {
      throw new Error('Sandbox reaper pagination invalid');
    }
    cursor = body.nextCursor; cursors.add(cursor);
  }
  report.scanned = inventory.length;
  for (const m of inventory) {
    if (!eligible(m)) { report.skipped++; continue; }
    report.candidates++;
    try {
      const path = `/sandbox/${encodeURIComponent(m.id)}`;
      const r = await call(path);
      if (r.status === 404) { report.skipped++; continue; }
      if (!r.ok) throw new Error('Candidate unavailable');
      const fresh = await r.json() as Machine;
      if (!fresh || fresh.id !== m.id || !eligible(fresh) ||
          fresh.labels?.[env.DAYTONA_DEPLOYMENT_LABEL] !== m.labels?.[env.DAYTONA_DEPLOYMENT_LABEL]) {
        report.skipped++; continue;
      }
      if (report.dryRun) continue;
      await revokeSandboxCredentials(env, m.id);
      // Daytona offers no conditional DELETE: a residual read/delete race remains.
      const deleted = await call(path, 'DELETE');
      if (!deleted.ok && deleted.status !== 404) throw new Error('Deletion failed');
      const verification = await call(path);
      let gone = verification.status === 404;
      if (!gone) {
        if (!verification.ok) throw new Error('Deletion verification unavailable');
        const result = await verification.json() as Machine;
        gone = result?.id === m.id && ['destroyed', 'deleted'].includes(result.state ?? '');
      }
      if (!gone) { report.pending++; continue; }
      // Compare by ID: never clear a replacement sandbox's cache.
      await env.DB.prepare('UPDATE user_keys SET daytona_sandbox_id = NULL WHERE daytona_sandbox_id = ?')
        .bind(m.id).run();
      report.deleted++;
    } catch {
      // Never log provider response bodies, credentials, sandbox names, or owners.
      report.failed++;
    }
  }
  return report;
}
