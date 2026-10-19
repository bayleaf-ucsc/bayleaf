/** Account activity, not a request history or a credential-lifetime clock.
 * No content, paths, IPs, provider polling, or background cleanup enters this signal.
 */
import type { Bindings } from './types';

// Include activity in account/key reads we already perform for authentication.
export const USER_ACTIVITY_COLUMNS = `user_keys.*,
  (SELECT last_active_at FROM users WHERE users.email = user_keys.email) AS user_last_active_at`;

/** A successful identity check counts even if subsequent work fails or hits quota.
 * At most one stored update per UTC day. Fresh authentication rows avoid a write
 * attempt altogether; the SQL condition coalesces concurrent stale reads too.
 * Failure must not turn a valid credential/session into an authentication error.
 */
export async function recordUserActivity(
  email: string, env: Bindings, knownLastActive?: number | null, now = Math.floor(Date.now() / 1000),
): Promise<void> {
  try {
    let lastActive = knownLastActive;
    if (lastActive === undefined) {
      const user = await env.DB.prepare('SELECT last_active_at FROM users WHERE email = ?')
        .bind(email).first<{ last_active_at: number | null }>();
      lastActive = user?.last_active_at ?? null;
    }
    const dayStart = Math.floor(now / 86400) * 86400;
    if (lastActive !== null && lastActive >= dayStart) return;
    // A verified browser login may establish an account without issuing any key.
    // Existing creation times survive every activity update and key reissuance.
    await env.DB.prepare(`INSERT INTO users (email, created_at, last_active_at) VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET last_active_at = excluded.last_active_at
      WHERE users.last_active_at IS NULL OR users.last_active_at < ?`)
      .bind(email, now, now, dayStart).run();
  } catch {
    console.error('Account activity update failed'); // No identity, credential or content.
  }
}
