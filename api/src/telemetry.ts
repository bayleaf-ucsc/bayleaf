// Policy builders are shared source, bundled by Wrangler, not runtime imports.
// @ts-expect-error Shared dependency-free JS adapter has no TypeScript declarations.
import { createServiceSender } from '../../telemetry/adapters/common.mjs';
// @ts-expect-error Shared dependency-free JS adapter has no TypeScript declarations.
import { apiSandboxDeletion, apiUserDeletion } from '../../telemetry/adapters/deletions.mjs';

export interface TelemetryBindings {
  TELEMETRY_ENABLED?: string;
  TELEMETRY_API_RETENTION_WRITE_TOKEN?: string;
  TELEMETRY_SANDBOX_REAPER_WRITE_TOKEN?: string;
}

type Source = 'sandbox-reaper' | 'api-retention';
const senders = new WeakMap<object, Map<Source, (payload: unknown) => Promise<boolean>>>();

/** Project returned aggregate counters, never rows/errors or invented zero counts.
 * A throwing job has no returned report and is deliberately not exported here.
 */
export function queueDeletionTelemetry(env: TelemetryBindings, ctx: ExecutionContext | undefined,
  source: Source, report: unknown, startedAt: string, configuredMode?: string) {
  try {
    if (env.TELEMETRY_ENABLED !== 'true' || !ctx?.waitUntil) return;
    const mode = ['delete', 'dry-run'].includes(configuredMode ?? '') ? configuredMode : 'disabled';
    const counts = report as { failed?: number; pending?: number; providerPending?: number };
    const run = { run_id: crypto.randomUUID(), started_at: startedAt, ended_at: new Date().toISOString(),
      outcome: mode === 'disabled' ? 'disabled'
        : counts.failed || counts.pending || counts.providerPending ? 'partial' : 'ok' };
    const payload = source === 'sandbox-reaper'
      ? apiSandboxDeletion(report, run, mode) : apiUserDeletion(report, run);
    if (!payload) return;
    let sources = senders.get(env);
    if (!sources) { sources = new Map(); senders.set(env, sources); }
    let sender = sources.get(source);
    if (!sender) {
      sender = createServiceSender({ source, enabled: true,
        endpoint: 'https://telemetry.bayleaf.dev/v1/deletions',
        service_token: source === 'sandbox-reaper' ? env.TELEMETRY_SANDBOX_REAPER_WRITE_TOKEN
          : env.TELEMETRY_API_RETENTION_WRITE_TOKEN });
      sources.set(source, sender!);
    }
    ctx.waitUntil(sender!(payload).catch(() => false));
  } catch { /* Never replace the scheduled job's original outcome. */ }
}
