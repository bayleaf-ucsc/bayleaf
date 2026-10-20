// Synthetic, non-identifying copies of actual report structures, not prod data.
export const run = Object.freeze({ run_id: 'd7360235-dd1a-4e94-a41e-e03b96046ff0',
  started_at: '2026-10-20T12:00:00.000Z', ended_at: '2026-10-20T12:00:01.000Z', outcome: 'ok' });

// api/src/userRetention.ts: outboxCompleted may exceed retired because it also
// handles old outbox entries; providerPending is a backlog, not this run's failure count.
export const apiRetention = Object.freeze({ mode: 'delete', candidates: 3, retired: 2,
  recheckSkipped: 1, providerPending: 4, outboxCompleted: 5 });
export const sandboxReaper = Object.freeze({ scanned: 7, candidates: 3, deleted: 1,
  pending: 1, skipped: 4, failed: 1, dryRun: false });

// chat/probe/index.mjs finish(): offsets overlap phases, never sum them together.
export const browserProbe = Object.freeze({ version: 2, layer: 'browser', result: 'ok',
  stage: 'render_validation', work_result: 'ok', cleanup: 'confirmed', close: 'confirmed',
  metrics: { unit: 'ms', total: 1000, accounted: 900, unaccounted: 100,
    phases: { navigation: 200, first_rendered: 300, rendered: 300, persisted: 50,
      browser_close: 20, chat_cleanup: 30 },
    events: { first_rendered: 500, complete_rendered: 800, persistence_verified: 850 } } });
