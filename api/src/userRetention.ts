/** Scheduled account retirement, independent of key revocation and sandbox TTL.
 * Metadata only. No content, identity or provider response is logged.
 */
import type { Bindings } from './types';
import { OPENROUTER_API, TINFOIL_ADMIN_API } from './constants';

const BATCH_SIZE = 20; // Two bounded 8-second provider calls each, below cron's wall-time limit.
export interface RetentionUser {
  email: string;
  created_at: number | null;
  last_active_at: number | null;
}

/** Same cutoff as Chat: subtract UTC calendar months, clamp to month end. */
export function accountCutoff(now: number, months = 18): number {
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(months) || months < 1)
    throw new Error('Invalid account retention clock');
  const date = new Date(now * 1000);
  const target = new Date(date);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() - months);
  if (!Number.isFinite(target.getTime()) || target.getUTCFullYear() < 1)
    throw new Error('Invalid account retention range');
  const end = new Date(target);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(date.getUTCDate(), end.getUTCDate()));
  return target.getTime() / 1000;
}

// Re-evaluated inside the atomic retirement transaction, not just discovery.
// Existing sandbox ownership blocks account retirement: the separate 90-day
// reaper must remove compute and clear credentials first. Never wake it here.
const ELIGIBLE = `u.retention_exempt = 0 AND u.retention_hold = 0
  AND typeof(u.created_at) = 'integer' AND typeof(u.last_active_at) = 'integer'
  AND u.created_at > 0 AND u.last_active_at > 0
  AND u.created_at <= ? AND u.last_active_at <= ?
  AND max(u.created_at, u.last_active_at) < ?
  AND NOT EXISTS (SELECT 1 FROM user_keys k WHERE k.email=u.email AND k.daytona_sandbox_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM user_keys k WHERE k.email=u.email
    AND k.or_key_secret IS NOT NULL AND (k.or_key_hash IS NULL OR k.or_key_hash = ''))
  AND NOT EXISTS (SELECT 1 FROM user_keys k WHERE k.email=u.email AND
    (k.account_generation IS NULL OR length(k.account_generation) < 16 OR length(k.account_generation) > 128
      OR k.account_generation GLOB '*[^A-Za-z0-9-]*'))
  AND NOT EXISTS (SELECT 1 FROM sandbox_credentials sc WHERE sc.email=u.email)
  AND NOT EXISTS (SELECT 1 FROM service_sessions s WHERE s.email=u.email AND s.expires_at > ?)
  AND NOT EXISTS (SELECT 1 FROM preview_registrations p WHERE p.email=u.email)`;

/** Atomically claim a still-inactive snapshot, invalidate local access, and
 * remove its user/key rows. The outbox survives provider failures and never
 * points at credentials minted for a later account using the same email.
 */
export async function retireInactiveUser(env: Bindings, user: RetentionUser, now: number, cutoff: number) {
  const id = crypto.randomUUID();
  const exists = 'EXISTS (SELECT 1 FROM user_retention_outbox WHERE id = ?)';
  const statements = [env.DB.prepare(`INSERT INTO user_retention_outbox (id, or_key_hash, tinfoil_key, created_at)
    SELECT ?, k.or_key_hash, k.tinfoil_key, ? FROM users u LEFT JOIN user_keys k ON k.email=u.email
    WHERE u.email = ? AND u.created_at = ? AND u.last_active_at = ? AND ${ELIGIBLE}`)
    .bind(id, now, user.email, user.created_at, user.last_active_at, now, now, cutoff, now)];
  // Capture the exact old generation while it still exists, only if the atomic
  // eligibility claim succeeded. This durable ledger never targets a later user
  // at the same email and survives provider-key outbox completion.
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO inbox_retirements(generation,retired_at)
    SELECT account_generation,? FROM user_keys WHERE email=? AND ${exists}`).bind(now, user.email, id));
  for (const [table, column] of [
    ['inference_grants', 'owner_email'], ['grant_transactions', 'owner_email'],
    ['service_sessions', 'email'], ['service_login_flows', 'email'], ['claim_codes', 'approved_by'],
    ['user_keys', 'email'], ['users', 'email'],
  ]) {
    statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND ${exists}`).bind(user.email, id));
  }
  const results = await env.DB.batch(statements);
  return results[0].meta.changes === 1;
}

/** Eventual cross-service logical revocation. Replay acknowledged fences too,
 * so inbox-only recovery can be reconciled offline from this separate ledger.
 * Neither pilot/exposure flags nor provider deletion failures gate this work.
 */
export async function cleanupRetiredInboxes(env: Bindings, now: number): Promise<number> {
  let replayFailures = 0;
  for (const pending of [true, false]) {
    const rows = (await env.DB.prepare(`SELECT generation FROM inbox_retirements
      WHERE fenced_at IS ${pending ? '' : 'NOT '}NULL ORDER BY checked_at,generation LIMIT ?`)
      .bind(BATCH_SIZE).all<{ generation: string }>()).results;
    for (const row of rows) {
      await env.DB.prepare('UPDATE inbox_retirements SET checked_at=? WHERE generation=?').bind(now, row.generation).run();
      try {
        const result = await env.INBOXES?.retireOwner(row.generation) as { retired?: boolean } | undefined;
        if (result?.retired === true) await env.DB.prepare(`UPDATE inbox_retirements
          SET fenced_at=COALESCE(fenced_at,?) WHERE generation=?`).bind(now, row.generation).run();
        else if (!pending) replayFailures++;
      } catch { if (!pending) replayFailures++; /* Retain ledger, never log identity or raw errors. */ }
    }
  }
  return replayFailures + (await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox_retirements WHERE fenced_at IS NULL')
    .first<{ n: number }>())!.n;
}

async function removeProviderKey(url: string, credential: string | undefined): Promise<boolean> {
  if (!credential) return false;
  try {
    const response = await fetch(url, {
      method: 'DELETE', headers: { Authorization: `Bearer ${credential}` },
      redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel();
    // 202 is not confirmation. 404 makes a lost successful reply retry-safe.
    return (response.ok && response.status !== 202) || response.status === 404;
  } catch { return false; }
}

export async function cleanupInactiveUsers(env: Bindings, now = Math.floor(Date.now() / 1000)) {
  const mode = env.USER_RETENTION_MODE;
  const report = { mode: mode === 'delete' || mode === 'dry-run' ? mode : 'disabled',
    candidates: 0, retired: 0, recheckSkipped: 0, providerPending: 0, outboxCompleted: 0, pending: 0 };
  if (report.mode === 'disabled') return report;
  const cutoff = accountCutoff(now);
  const { results: candidates } = await env.DB.prepare(`SELECT u.email, u.created_at, u.last_active_at
    FROM users u WHERE ${ELIGIBLE} ORDER BY u.email LIMIT ?`)
    .bind(now, now, cutoff, now, BATCH_SIZE).all<RetentionUser>();
  report.candidates = candidates.length;
  // Dry-run means no writes AND no provider requests, including outbox retries.
  if (report.mode === 'dry-run') return report;
  for (const user of candidates) {
    if (await retireInactiveUser(env, user, now, cutoff)) report.retired++;
    else report.recheckSkipped++;
  }
  // Run before provider cleanup: an upstream credential outage must not delay
  // inbox revocation. `pending` also marks aggregate deletion telemetry partial.
  report.pending = await cleanupRetiredInboxes(env, now);
  const { results: pending } = await env.DB.prepare(`SELECT * FROM user_retention_outbox
    ORDER BY created_at, id LIMIT ?`).bind(BATCH_SIZE)
    .all<{ id: string; or_key_hash: string | null; tinfoil_key: string | null }>();
  for (const row of pending) {
    if (row.or_key_hash && await removeProviderKey(`${OPENROUTER_API}/keys/${encodeURIComponent(row.or_key_hash)}`, env.OPENROUTER_PROVISIONING_KEY)) {
      await env.DB.prepare('UPDATE user_retention_outbox SET or_key_hash = NULL WHERE id = ?').bind(row.id).run();
    }
    if (row.tinfoil_key && await removeProviderKey(`${TINFOIL_ADMIN_API}/keys/${encodeURIComponent(row.tinfoil_key)}`, env.TINFOIL_ADMIN_KEY)) {
      await env.DB.prepare('UPDATE user_retention_outbox SET tinfoil_key = NULL WHERE id = ?').bind(row.id).run();
    }
    const result = await env.DB.prepare(`DELETE FROM user_retention_outbox
      WHERE id = ? AND or_key_hash IS NULL AND tinfoil_key IS NULL`).bind(row.id).run();
    if (result.meta.changes === 1) report.outboxCompleted++;
  }
  report.providerPending = (await env.DB.prepare('SELECT count(*) AS n FROM user_retention_outbox')
    .first<{ n: number }>())!.n;
  return report;
}
