// Source-side policy v1: intentionally small, explicit and revisable.
export const POLICY_VERSION = 1;
export const MAX_BYTES = 16384;
export const MAX_DELIVERY_MS = 2000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
export const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3600000;

export function envelope(source, run) {
  if (!run || !UUID.test(run.run_id) || !['ok', 'partial', 'failed', 'disabled'].includes(run.outcome)) return null;
  const validTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!validTime(run.started_at) || !validTime(run.ended_at) || run.ended_at < run.started_at) return null;
  if (!duration(Date.parse(run.ended_at) - Date.parse(run.started_at))) return null;
  return { schema_version: 1, source, batch_id: run.run_id, observed_at: Date.parse(run.ended_at),
    duration_ms: Date.parse(run.ended_at) - Date.parse(run.started_at),
    outcome: { ok: 'success', partial: 'partial', failed: 'failure', disabled: 'skipped' }[run.outcome] };
}

export const runTimes = run => ({ started_at: Date.parse(run.started_at), ended_at: Date.parse(run.ended_at) });

export function selectCounts(input, names) {
  if (!input || typeof input !== 'object') return null;
  const output = {};
  for (const name of names) {
    if (!Object.hasOwn(input, name)) continue; // Missing is unknown, not zero.
    if (!count(input[name])) return null;
    output[name] = input[name];
  }
  return output;
}

export function endpointURL(endpoint, route) {
  try {
    const url = new URL(endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password
      || url.pathname !== route || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

/** Internal transport: headers are constructed here, never copied from config. */
async function attemptDelivery(payload, route, config, serviceToken, state) {
  let timer;
  try {
    if (config.enabled !== true || !payload) return false;
    if (state?.active) return false;
    const endpoint = endpointURL(config.endpoint, route);
    if (!endpoint) return false;
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_BYTES) return false;
    const budget = config.deadline_ms ?? 1000;
    if (!Number.isInteger(budget) || budget < 1 || budget > MAX_DELIVERY_MS) return false;
    const controller = new AbortController();
    const expired = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(false); }, budget);
    });
    const headers = { 'Content-Type': 'application/json' };
    if (serviceToken !== undefined) headers.Authorization = `Bearer ${serviceToken}`;
    const attempt = Promise.resolve().then(() => (config.fetcher ?? globalThis.fetch)(endpoint, {
      method: 'POST', headers, body,
      credentials: 'omit', referrerPolicy: 'no-referrer', referrer: '',
      redirect: 'manual', cache: 'no-store', keepalive: true, signal: controller.signal,
    })).then(async response => {
      // Never consume reply content. Cancellation shares the caller deadline;
      // an ignored cancellation retains a service sender's sole operation slot.
      try { await response.body?.cancel(); } catch { /* No source impact. */ }
      return response.status >= 200 && response.status < 300;
    }).catch(() => false).finally(() => { if (state) state.active = false; });
    if (state) state.active = true;
    return await Promise.race([attempt, expired]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/** Browser-only: even accidental service_token/headers/auth configuration is
 * ignored. It is impossible to use this entrypoint for service ingestion.
 */
export async function deliver(payload, route, config = {}) {
  if (route !== '/v1/browser') return false;
  return attemptDelivery(payload, route, config, undefined);
}

const SERVICE_ROUTES = Object.freeze({
  'chat-retention': '/v1/deletions', 'api-retention': '/v1/deletions',
  'sandbox-reaper': '/v1/deletions', probe: '/v1/probes',
});

export const serviceTokenValid = token => typeof token === 'string' && /^[\x21-\x7e]{24,512}$/.test(token);

/** One sender per source for the lifetime of the job runner/Worker isolate.
 * The token is collector-specific, explicitly supplied in memory, and bound to
 * this source. No environment lookups, arbitrary headers, cookies or credentials.
 * A timed-out fetch that ignores abort retains the sole slot until it settles.
 */
export function createServiceSender(config = {}) {
  const state = { active: false };
  // Capture approved primitive configuration; never retain an upstream client.
  const { source, service_token: token } = config;
  const route = Object.hasOwn(SERVICE_ROUTES, source) ? SERVICE_ROUTES[source] : null;
  const transport = { enabled: config.enabled, endpoint: config.endpoint,
    deadline_ms: config.deadline_ms, fetcher: config.fetcher };
  return async payload => {
    try {
      if (!route || !serviceTokenValid(token) || payload?.source !== source) return false;
      return await attemptDelivery(payload, route, transport, token, state);
    } catch { return false; }
  };
}
