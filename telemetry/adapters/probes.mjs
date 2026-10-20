import { duration, envelope, runTimes } from './common.mjs';

export const LAYERS = Object.freeze(['owui', 'browser', 'openrouter', 'api', 'sealed', 'catalog']);
export const BROWSER_PHASES = Object.freeze(['identity', 'stale_cleanup', 'launch', 'context', 'page',
  'interception', 'setup', 'render_observer', 'navigation', 'composer', 'typed', 'submitted',
  'first_rendered', 'rendered', 'creation_response', 'persisted', 'render_validation', 'browser_close', 'chat_cleanup']);
export const PHASES = Object.freeze(['authentication', 'configuration', 'admission', 'response_headers',
  'header_validation', 'await_first_byte', 'await_answer', 'answer_stream', 'stop_to_done', 'done_to_eof',
  'validation', 'stream_cleanup', 'catalog_fetch', 'attestation_fetch', 'attestation_verify',
  'request_encrypt', 'response_decrypt', ...BROWSER_PHASES]);
export const EVENTS = Object.freeze(['request_start', 'response_headers', 'first_byte', 'first_answer', 'stop', 'done', 'eof',
  'auth_request', 'navigation_request', 'creation_request', 'auth_headers', 'document_headers', 'creation_headers',
  'creation_body', 'first_rendered', 'complete_rendered', 'domcontentloaded', 'composer_ready', 'send_start',
  'send_returned', 'persistence_verified', 'render_verified']);
const RESULTS = new Set(['ok', 'disabled', 'not_configured', 'rate_limited', 'deadline', 'client_aborted', 'probe_internal',
  'stream_incomplete', 'stream_invalid', 'catalog_transport', 'catalog_absence',
  'browser_deadline', 'browser_client_aborted', 'browser_cleanup_failed', 'browser_close_failed',
  ...BROWSER_PHASES.map(phase => `browser_${phase}`),
  ...['chat', 'openrouter', 'api'].flatMap(prefix => [`${prefix}_transport`, `${prefix}_protocol`]),
  ...['attestation_fetch', 'attestation_verify', 'request_encrypt', 'transport', 'protocol',
    'response_decrypt', 'stream', 'stream_incomplete'].map(name => `sealed_${name}`)]);

export function resultCode(value) {
  return typeof value === 'string' && (RESULTS.has(value) || /^(chat|openrouter|api|sealed)_http_[1-5]\d\d$/.test(value));
}

function measurements(input, allow) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const output = {};
  for (const key of allow) {
    if (!Object.hasOwn(input, key)) continue;
    if (!duration(input[key])) return null;
    output[key] = input[key];
  }
  return output;
}

/** Accepts metrics-v2's assembled finish() object, not an HTTP request/response.
 * A whitelist projection: reports, raw diagnostics, synthetic IDs and bodies
 * never leave the source. New measurements require a deliberate policy revision.
 */
export function probeSummary(report, run) {
  const base = envelope('probe', run);
  if (!base || report?.version !== 2 || !LAYERS.includes(report.layer) || !resultCode(report.result)) return null;
  if ((report.result === 'ok') !== (run.outcome === 'ok')
    || ((report.result === 'disabled') !== (run.outcome === 'disabled'))) return null;
  if (report.layer === 'browser' && report.result === 'ok'
    && (report.cleanup !== 'confirmed' || report.close !== 'confirmed')) return null;
  const m = report.metrics;
  if (m?.unit !== 'ms' || !['total', 'accounted', 'unaccounted'].every(k => duration(m[k]))) return null;
  const phases = measurements(m.phases, PHASES), events = measurements(m.events, EVENTS);
  if (!phases || !events) return null;
  if (Object.values(phases).reduce((a, b) => a + b, 0) > m.total + 1
    || Object.values(events).some(value => value > m.total + 1)
    || m.accounted > m.total + 1 || Math.abs(m.accounted + m.unaccounted - m.total) > 1) return null;
  const extensions = { ...runTimes(run), result: report.result, accounted_ms: m.accounted, unaccounted_ms: m.unaccounted };
  if (m.failed_phase !== undefined) {
    if (![...PHASES, 'gates'].includes(m.failed_phase)) return null;
    extensions.failed_phase = m.failed_phase;
  }
  for (const [key, allow] of Object.entries({ cleanup: ['not_needed', 'confirmed', 'failed'],
    close: ['not_started', 'unconfirmed', 'confirmed', 'failed'] })) {
    if (report[key] === undefined) continue;
    if (!allow.includes(report[key])) return null;
    extensions[key] = report[key];
  }
  if (report.work_result !== undefined) {
    if (!resultCode(report.work_result)) return null;
    extensions.work_result = report.work_result;
  }
  // Probe duration comes from the Worker's monotonic clock, not wall-clock span.
  return { ...base, duration_ms: m.total, layer: report.layer, phases_ms: phases, events_ms: events, extensions };
}

export async function emitProbe(report, run, sender) {
  try { return await sender(probeSummary(report, run)); }
  catch { return false; }
}
