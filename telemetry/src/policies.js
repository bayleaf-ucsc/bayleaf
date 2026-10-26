// Versioned collection policy, deliberately separate from physical storage.
// Changing these allowlists is a privacy review, not merely a schema migration.
import { DAYTONA_METRICS } from '../daytona/policy.js';
export const POLICY_VERSION = 4; // Daytona policy 3 plus inbox aggregate metrics.
export const SCHEMA_VERSION = 1;
export const DAY = 86_400_000;
export const LIMITS = Object.freeze({ bodyBytes: 65_536, points: 100, readRows: 500, aggregateRows: 2000,
  readWindowMs: 7 * DAY, aggregateWindowMs: 90 * DAY, futureMs: 60_000, browserPerMinute: 120,
  serviceBatchesPerMinute: 60, metricPointsPerMinute: 120, purgeRowsPerTable: 500 });
// UTC-epoch-aligned read buckets; aggregation is derived at read time, never stored.
export const METRIC_BUCKETS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000, DAY];
export const DESTINATIONS = ['landing', 'sandbox', 'chat', 'api', 'proxies', 'inboxes'];
export const ORIGINS = {
  'https://bayleaf.dev': 'landing', 'https://sandbox.bayleaf.dev': 'sandbox',
  'https://chat.bayleaf.dev': 'chat', 'https://api.bayleaf.dev': 'api',
  'https://bayleaf-proxies.dev': 'proxies', 'https://bayleaf-inboxes.dev': 'inboxes',
};
export const SOURCES = ['owui', 'chat-retention', 'api-retention', 'sandbox-reaper', 'probe', 'daytona', 'inboxes'];
export const SOURCE_CLASSES = {
  owui: ['metrics'], 'chat-retention': ['deletions'],
  'api-retention': ['deletions'], 'sandbox-reaper': ['deletions'], probe: ['probes'],
  daytona: ['metrics', 'lifecycle'],
  inboxes: ['metrics'],
};
export const JOBS = ['chat-retention', 'sandbox-reaper', 'preview-expiry', 'grant-expiry',
  'session-expiry', 'credential-cleanup', 'user-retention'];
export const SOURCE_JOBS = {
  'chat-retention': ['chat-retention'], 'sandbox-reaper': ['sandbox-reaper'],
  'api-retention': JOBS.filter(x => !['chat-retention', 'sandbox-reaper'].includes(x)),
};
export const OUTCOMES = ['success', 'partial', 'failure', 'skipped'];
export const LAYERS = ['browser', 'owui', 'openrouter', 'api', 'sealed', 'catalog'];
export const BROWSER_PHASES = ['identity', 'stale_cleanup', 'launch', 'context', 'page',
  'interception', 'setup', 'render_observer', 'navigation', 'composer', 'typed', 'submitted',
  'first_rendered', 'rendered', 'creation_response', 'persisted', 'render_validation', 'browser_close', 'chat_cleanup'];
export const PHASES = ['authentication', 'configuration', 'admission', 'response_headers',
  'header_validation', 'await_first_byte', 'await_answer', 'answer_stream', 'stop_to_done', 'done_to_eof',
  'validation', 'stream_cleanup', 'catalog_fetch', 'attestation_fetch', 'attestation_verify',
  'request_encrypt', 'response_decrypt', ...BROWSER_PHASES];
export const EVENTS = ['request_start', 'response_headers', 'first_byte', 'first_answer', 'stop', 'done', 'eof',
  'auth_request', 'navigation_request', 'creation_request', 'auth_headers', 'document_headers', 'creation_headers',
  'creation_body', 'first_rendered', 'complete_rendered', 'domcontentloaded', 'composer_ready', 'send_start',
  'send_returned', 'persistence_verified', 'render_verified'];
export const PROBE_RESULTS = ['ok', 'disabled', 'not_configured', 'rate_limited', 'deadline', 'client_aborted', 'probe_internal',
  'stream_incomplete', 'stream_invalid', 'catalog_transport', 'catalog_absence',
  'browser_deadline', 'browser_client_aborted', 'browser_cleanup_failed', 'browser_close_failed',
  ...BROWSER_PHASES.map(p => `browser_${p}`),
  ...['chat', 'openrouter', 'api'].flatMap(p => [`${p}_transport`, `${p}_protocol`]),
  ...['attestation_fetch', 'attestation_verify', 'request_encrypt', 'transport', 'protocol',
    'response_decrypt', 'stream', 'stream_incomplete'].map(p => `sealed_${p}`)];
export function probeResult(x) {
  return typeof x === 'string' && (PROBE_RESULTS.includes(x) || /^(chat|openrouter|api|sealed)_http_[1-5]\d\d$/.test(x));
}
export const DELETION_COUNTS = {
  'chat-retention': ['users_total', 'users_held', 'chats_scanned', 'chats_expired', 'chats_deleted',
    'chats_would_delete', 'users_impacted', 'files_total', 'knowledge_bases', 'chats_scanned_for_refs',
    'files_referenced', 'files_in_grace', 'files_orphan', 'files_deleted', 'files_would_delete',
    'users_invalid_activity', 'users_expired', 'users_recheck_skipped', 'users_deleted', 'users_would_delete'],
  'api-retention': ['candidates', 'retired', 'recheckSkipped', 'providerPending', 'outboxCompleted'],
  'sandbox-reaper': ['scanned', 'candidates', 'deleted', 'pending', 'skipped', 'failed'],
};
export const ROUTES = ['/', '/health', '/api/chat/completions', '/api/v1/chats/',
  '/api/v1/auths/', '/ws/socket.io/', '/api/version', '/api/v1/chats/{id}', '/_other', 'unmatched', 'other'];
export const METRICS = {
  ...DAYTONA_METRICS,
  'inbox.receipts': { source: 'inboxes', kind: 'sum', unit: '1', attributes: ['transport', 'outcome'] },
  'inbox.lifecycle': { source: 'inboxes', kind: 'sum', unit: '1', attributes: ['transport', 'outcome'] },
  'inbox.cleanup': { source: 'inboxes', kind: 'sum', unit: '1', attributes: ['outcome'] },
  'inbox.export.pages': { source: 'inboxes', kind: 'sum', unit: '1', attributes: ['transport', 'outcome'] },
  'inbox.export.bytes': { source: 'inboxes', kind: 'sum', unit: 'By', attributes: ['transport', 'outcome'] },
  'http.server.requests': { kind: 'sum', unit: '1', attributes: ['method', 'route', 'status_code', 'instance'] },
  'http.server.duration': { kind: 'histogram', unit: 'ms', attributes: ['method', 'route', 'status_code', 'instance'] },
  'webui.users.total': { kind: 'gauge', unit: 'users', attributes: ['instance'] },
  'webui.users.active': { kind: 'gauge', unit: 'users', attributes: ['instance'] },
  'webui.users.active.today': { kind: 'gauge', unit: 'users', attributes: ['instance'] },
};
export function retentionMs(env, klass) {
  const name = `${klass.toUpperCase()}_RETENTION_DAYS`;
  const days = Number(env[name] ?? env.RETENTION_DAYS ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('configuration');
  return days * DAY;
}
