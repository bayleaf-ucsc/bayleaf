import { SCHEMA_VERSION, POLICY_VERSION, LIMITS, DESTINATIONS, SOURCES, SOURCE_CLASSES,
  SOURCE_JOBS, OUTCOMES, LAYERS, PHASES, EVENTS, METRICS, ROUTES, ORIGINS, DELETION_COUNTS, probeResult, retentionMs } from './policies.js';
import { STATES, REGIONS, CLASSES, BUCKET_MS } from '../daytona/policy.js';

export class Invalid extends Error {}
const fail = () => { throw new Invalid('invalid_payload'); };
export const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function keys(x, allowed, required = []) {
  if (!object(x) || Object.keys(x).some(k => !allowed.includes(k)) || required.some(k => !(k in x))) fail();
}
function choice(x, list) { if (!list.includes(x)) fail(); return x; }
function number(x, max = 1e12) { if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > max) fail(); return x; }
function integer(x, max = 1e12) { number(x, max); if (!Number.isSafeInteger(x)) fail(); return x; }
function timestamp(x, now, ttl) { integer(x, 1e15); if (x > now + LIMITS.futureMs || x <= now - ttl) fail(); return x; }
function uuid(x) { if (typeof x !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x)) fail(); return x.toLowerCase(); }
function nanos(x, ms) {
  if (typeof x !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(x) || BigInt(x) > 18446744073709551615n ||
      BigInt(x) / 1_000_000n !== BigInt(ms)) fail();
  return x;
}
function numericMap(x, allowed, max = 1e9) {
  keys(x, allowed);
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, number(v, max)]));
}
function runTimes(extensions, observed, now, ttl) {
  for (const k of ['started_at', 'ended_at']) if (k in extensions) timestamp(extensions[k], now, ttl + 86_400_000);
  if (('started_at' in extensions) !== ('ended_at' in extensions)) fail();
  if ('started_at' in extensions && (extensions.started_at > extensions.ended_at || extensions.ended_at !== observed)) fail();
}

// Only a hostname crosses this seam. Never accept a URL and silently retain it.
export function hostname(x) {
  if (x === null) return null;
  if (typeof x !== 'string' || x.length > 253 || !x.includes('.') ||
      !/^[a-z0-9.-]+$/i.test(x)) fail();
  const h = x.toLowerCase().replace(/\.$/, '');
  // WHATWG URL canonicalizes short/octal/hex IPv4 forms as well as trailing dots.
  // A numeric-looking address rejected by URL parsing is not an accepted DNS name.
  let parsed;
  try { parsed = new URL(`https://${h}/`).hostname; } catch { fail(); }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed) || parsed.includes(':')) fail();
  if (h.split('.').some(p => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p) ||
      p.length > 48 || /^[0-9a-f]{16,}$/i.test(p) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(p)) ||
      /(^|\.)(localhost|local|internal|invalid|test)$/.test(h) ||
      h.endsWith('.bayleaf-proxies.dev') || h.endsWith('.bayleaf-inboxes.dev') ||
      (h.endsWith('.bayleaf.dev') && !Object.hasOwn(ORIGINS, `https://${h}`))) fail();
  return h;
}

function metric(p, now, ttl, source) {
  keys(p, ['name', 'kind', 'unit', 'observed_at', 'start_at', 'temporality', 'monotonic',
    'value', 'count', 'sum', 'min', 'max', 'bounds', 'bucket_counts', 'attributes', 'time_unix_nano', 'start_time_unix_nano'],
  ['name', 'kind', 'unit', 'observed_at', 'attributes']);
  const spec = METRICS[p.name];
  if (!spec || p.kind !== spec.kind || p.unit !== spec.unit) fail();
  if ((spec.source ?? 'owui') !== source) fail();
  const inboxMetric = ['inbox.receipts', 'inbox.lifecycle', 'inbox.cleanup'].includes(p.name);
  if ((source === 'inboxes') !== inboxMetric) fail();
  if (inboxMetric) {
    keys(p, ['name', 'kind', 'unit', 'observed_at', 'start_at', 'temporality', 'monotonic', 'value', 'attributes'],
      ['name', 'kind', 'unit', 'observed_at', 'start_at', 'temporality', 'monotonic', 'value', 'attributes']);
    keys(p.attributes, spec.attributes, spec.attributes);
    if (p.start_at % 900000 !== 0 || p.observed_at !== p.start_at + 900000 || p.temporality !== 'delta') fail();
    if (p.name !== 'inbox.cleanup') choice(p.attributes.transport, ['http', 'email']);
    choice(p.attributes.outcome, p.name === 'inbox.receipts'
      ? ['accepted', 'auth', 'rate', 'quota', 'size', 'unknown_address', 'failure']
      : p.name === 'inbox.lifecycle' ? ['created', 'destroy_requested', 'destroyed']
        : ['expired', 'stale', 'retried', 'destroyed_messages', 'reconciled', 'success', 'failure']);
  }
  timestamp(p.observed_at, now, ttl);
  keys(p.attributes, spec.attributes);
  for (const [k, v] of Object.entries(p.attributes)) {
    if (k === 'route') choice(v, ROUTES);
    if (k === 'method') choice(v, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER']);
    if (k === 'status_code') integer(v, 599), v < 100 && fail();
    if (k === 'instance') choice(v, ['worker-1', 'worker-2', 'worker-3', 'worker-4', 'single']);
    if (k === 'region') choice(v, REGIONS);
    if (k === 'sandbox_class') choice(v, CLASSES);
  }
  if (source === 'daytona') keys(p.attributes, spec.attributes, spec.attributes);
  const attributes = inboxMetric ? { ...(p.name === 'inbox.cleanup' ? {} : { transport: p.attributes.transport }),
    outcome: p.attributes.outcome } : p.attributes;
  const base = { name: p.name, kind: p.kind, unit: p.unit, observed_at: p.observed_at, attributes,
    ...('time_unix_nano' in p ? { time_unix_nano: nanos(p.time_unix_nano, p.observed_at) } : {}) };
  if (p.kind === 'gauge') {
    if (Object.keys(p).some(k => !['name', 'kind', 'unit', 'observed_at', 'attributes', 'value', 'time_unix_nano'].includes(k))) fail();
    return { ...base, value: spec.fractional ? number(p.value) : integer(p.value) };
  }
  choice(p.temporality, ['delta', 'cumulative']);
  // A reset may predate warehouse retention. It is metadata, not an old event.
  integer(p.start_at, 1e15);
  if (p.start_at > p.observed_at) fail();
  // Native metrics must describe aggregate windows, not individual request sequences.
  if (p.observed_at - p.start_at < 10_000) fail();
  const timed = { ...base, start_at: p.start_at, temporality: p.temporality,
    ...('start_time_unix_nano' in p ? { start_time_unix_nano: nanos(p.start_time_unix_nano, p.start_at) } : {}) };
  if (p.kind === 'sum') {
    if (p.monotonic !== true || ['count', 'sum', 'min', 'max', 'bounds', 'bucket_counts'].some(k => k in p)) fail();
    return { ...timed, monotonic: true, value: integer(p.value) };
  }
  if ('value' in p || 'monotonic' in p) fail();
  integer(p.count); if ('sum' in p) number(p.sum);
  if (!Array.isArray(p.bounds) || p.bounds.length > 64 || !Array.isArray(p.bucket_counts) ||
      p.bucket_counts.length !== p.bounds.length + 1) fail();
  p.bounds.forEach((v, i) => { number(v); if (i && v <= p.bounds[i - 1]) fail(); });
  p.bucket_counts.forEach(v => integer(v));
  if (p.bucket_counts.reduce((a, b) => a + b, 0) !== p.count) fail();
  if ('min' in p) number(p.min);
  if ('max' in p) number(p.max);
  if (p.count === 0 && (('sum' in p && p.sum !== 0) || 'min' in p || 'max' in p)) fail();
  if ('min' in p && 'max' in p && p.min > p.max) fail();
  return { ...timed, count: p.count, ...('sum' in p ? { sum: p.sum } : {}), bounds: p.bounds, bucket_counts: p.bucket_counts,
    ...('min' in p ? { min: p.min } : {}), ...('max' in p ? { max: p.max } : {}) };
}

export function validate(klass, input, env, now = Date.now()) {
  const ttl = retentionMs(env, klass);
  const common = ['schema_version', 'source', 'batch_id', 'observed_at'];
  const fields = { browser: ['destination', 'referring_hostname'], metrics: ['points'],
    lifecycle: ['event', 'old_state', 'new_state'],
    deletions: ['job', 'outcome', 'duration_ms', 'deleted', 'extensions'],
    probes: ['layer', 'outcome', 'duration_ms', 'phases_ms', 'events_ms', 'extensions'] };
  if (!fields[klass]) fail();
  keys(input, klass === 'browser' ? ['schema_version', ...fields.browser] : [...common, ...fields[klass]],
    klass === 'browser' ? ['schema_version', ...fields.browser] : [...common, ...fields[klass]]);
  if (input.schema_version !== SCHEMA_VERSION) fail();
  const observed = klass === 'browser' ? now : timestamp(input.observed_at, now, ttl);
  const base = { schema_version: SCHEMA_VERSION, policy_version: POLICY_VERSION,
    observed_at: observed, expires_at: observed + ttl };
  if (klass === 'browser') return { ...base, destination: choice(input.destination, DESTINATIONS),
    referring_hostname: hostname(input.referring_hostname) };
  choice(input.source, SOURCES);
  if (!SOURCE_CLASSES[input.source].includes(klass)) fail();
  Object.assign(base, { source: input.source, batch_id: uuid(input.batch_id) });
  if (klass === 'lifecycle') {
    if (observed % BUCKET_MS !== 0) fail();
    choice(input.event, ['sandbox.created', 'sandbox.state.updated']);
    if (input.event === 'sandbox.created' ? input.old_state !== null : !STATES.includes(input.old_state)) fail();
    return { ...base, event: input.event, old_state: input.old_state, new_state: choice(input.new_state, STATES) };
  }
  if (klass === 'metrics') {
    if (!Array.isArray(input.points) || !input.points.length || input.points.length > LIMITS.points) fail();
    const points = input.points.map(p => metric(p, now, ttl, input.source));
    if (input.source === 'inboxes' && (points.length > 27 || points.some(p => p.observed_at !== observed) ||
        new Set(points.map(p => canonical([p.name, p.attributes]))).size !== points.length)) fail();
    // Envelope expiry cannot retire a point before its own observation window.
    if (points.some(p => p.observed_at > observed)) fail();
    return { ...base, points };
  }
  choice(input.outcome, OUTCOMES); number(input.duration_ms, 3_600_000);
  Object.assign(base, { outcome: input.outcome, duration_ms: input.duration_ms });
  if (klass === 'deletions') {
    choice(input.job, SOURCE_JOBS[input.source]); integer(input.deleted);
    keys(input.extensions, ['dry_run', 'scanned', 'eligible', 'pending', 'failed', 'started_at', 'ended_at',
      'counts', 'mode', 'retention_days', 'orphan_grace_seconds', 'user_retention_months', 'file_sweep']);
    runTimes(input.extensions, observed, now, ttl);
    if ('dry_run' in input.extensions && typeof input.extensions.dry_run !== 'boolean') fail();
    for (const [k, v] of Object.entries(input.extensions)) {
      if (k === 'mode') choice(v, ['delete', 'dry-run', 'disabled']);
      else if (k === 'file_sweep') choice(v, ['skipped_no_eligible_files']);
      else if (k === 'counts') {
        keys(v, DELETION_COUNTS[input.source]);
        Object.values(v).forEach(n => integer(n));
      } else if (!['dry_run', 'started_at', 'ended_at'].includes(k)) integer(v);
    }
    if ((input.extensions.dry_run || ['dry-run', 'disabled'].includes(input.extensions.mode)) && input.deleted !== 0) fail();
    return { ...base, job: input.job, deleted: input.deleted, extensions: input.extensions };
  }
  choice(input.layer, LAYERS);
  const phases = numericMap(input.phases_ms, PHASES, 3_600_000);
  const events = numericMap(input.events_ms, EVENTS, 3_600_000);
  if (Object.values(phases).reduce((a, b) => a + b, 0) > input.duration_ms + 1 ||
      Object.values(events).some(v => v > input.duration_ms + 1)) fail();
  keys(input.extensions, ['failed_phase', 'cleanup', 'close', 'http_status', 'accounted_ms', 'unaccounted_ms',
    'started_at', 'ended_at', 'result', 'work_result']);
  runTimes(input.extensions, observed, now, ttl);
  for (const [k, v] of Object.entries(input.extensions)) {
    if (k === 'failed_phase') choice(v, [...PHASES, 'gates']);
    else if (k === 'cleanup') choice(v, ['confirmed', 'failed', 'not_needed']);
    else if (k === 'close') choice(v, ['not_started', 'unconfirmed', 'confirmed', 'failed']);
    else if (k === 'result' || k === 'work_result') { if (!probeResult(v)) fail(); }
    else if (k === 'http_status') { integer(v, 599); if (v < 100) fail(); }
    else if (k === 'started_at' || k === 'ended_at') continue;
    else number(v, 3_600_000);
  }
  const accounted = input.extensions.accounted_ms;
  const unaccounted = input.extensions.unaccounted_ms;
  if (accounted !== undefined && Math.abs(accounted - Object.values(phases).reduce((a, b) => a + b, 0)) > 1) fail();
  if (unaccounted !== undefined && unaccounted > input.duration_ms + 1) fail();
  if (accounted !== undefined && unaccounted !== undefined && Math.abs(accounted + unaccounted - input.duration_ms) > 1) fail();
  return { ...base, layer: input.layer, phases_ms: phases, events_ms: events, extensions: input.extensions };
}

export function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (object(x)) return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
