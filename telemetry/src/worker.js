import { LIMITS, ORIGINS, SOURCE_CLASSES, POLICY_VERSION, SCHEMA_VERSION } from './policies.js';
import { Invalid, validate, object } from './validate.js';
import { ingest, takeBudget, readRows, purge, TABLES } from './store.js';
import { OtlpError } from '../otlp/normalize.mjs';
import { otlpHook } from '../otlp/worker-adapter.mjs';

const response = (data, status = 200, headers = {}) => Response.json(data, { status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
async function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length < 24 || b.length < 24) return false;
  const hash = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  const aa = new Uint8Array(x), bb = new Uint8Array(y);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}
const bearer = request => request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
function credentials(env) {
  let configured;
  try { configured = JSON.parse(env.WRITE_KEYS_JSON ?? '{}'); } catch { return null; }
  if (!object(configured)) return null;
  const secrets = Object.values(configured);
  if (typeof env.READ_SECRET !== 'string' || env.READ_SECRET.length < 24 || /\s/.test(env.READ_SECRET) ||
      Object.keys(configured).some(source => !Object.hasOwn(SOURCE_CLASSES, source)) ||
      secrets.some(secret => typeof secret !== 'string' || secret.length < 24 || /\s/.test(secret)) ||
      new Set(secrets).size !== secrets.length || secrets.includes(env.READ_SECRET)) return null;
  return configured;
}
async function writer(request, configured, klass) {
  for (const [source, secret] of Object.entries(configured)) {
    if (SOURCE_CLASSES[source]?.includes(klass) && await equal(bearer(request), secret)) return source;
  }
  return null;
}
export async function boundedJson(request) {
  if (request.headers.get('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity') throw new Invalid();
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw new Invalid();
  if (Number(request.headers.get('Content-Length')) > LIMITS.bodyBytes) throw new Invalid();
  if (!request.body) throw new Invalid();
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Invalid()); }, 2000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > LIMITS.bodyBytes || chunks.length >= 2048) { void reader.cancel().catch(() => {}); throw new Invalid(); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Invalid(); } finally { clearTimeout(timer); reader.releaseLock(); }
}

// The hook is a trusted, separately qualified OTLP decoder. It returns this
// receiver's normalized JSON envelope, never arbitrary OTLP resource attributes.
export function createWorker({ otlp, clock = Date.now } = {}) {
  return {
    async fetch(request, env) {
      if (env.TELEMETRY_ENABLED !== 'true') return response({ error: 'disabled' }, 503);
      const now = clock();
      let actualOtlp = false;
      try {
        const url = new URL(request.url);
        if (url.search && !url.pathname.startsWith('/v1/read/')) return response({ error: 'invalid_request' }, 400);
        if (url.pathname.startsWith('/v1/read/') && request.method === 'GET') {
          if (!credentials(env)) return response({ error: 'configuration' }, 503);
          if (!await equal(bearer(request), env.READ_SECRET)) return response({ error: 'unauthorized' }, 401);
          const klass = url.pathname.slice('/v1/read/'.length);
          if (!Object.hasOwn(TABLES, klass)) return response({ error: 'not_found' }, 404);
          const q = url.searchParams;
          if ([...q.keys()].some(k => !['from', 'to', 'limit'].includes(k)) ||
              ['from', 'to', 'limit'].some(k => q.getAll(k).length !== 1 || !/^\d+$/.test(q.get(k)))) throw new Invalid();
          const [from, to, limit] = ['from', 'to', 'limit'].map(k => Number(q.get(k)));
          if (![from, to, limit].every(Number.isSafeInteger) || from >= to || to > now + LIMITS.futureMs ||
              to - from > LIMITS.readWindowMs || limit < 1 || limit > LIMITS.readRows) throw new Invalid();
          const rows = await readRows(env.TELEMETRY_DB, klass, { from, to, limit }, now, env);
          return response({ schema_version: SCHEMA_VERSION, policy_version: POLICY_VERSION,
            as_of: now, from, to, limit, truncated: rows.length === limit, rows });
        }
        const route = url.pathname.match(/^\/v1\/(browser|deletions|probes|metrics)$/);
        const isOtlp = url.pathname === '/v1/otlp/metrics' && typeof otlp === 'function';
        actualOtlp = isOtlp;
        const klass = isOtlp ? 'metrics' : route?.[1];
        if (!klass) return response({ error: 'not_found' }, 404);
        const origin = request.headers.get('Origin');
        const cors = klass === 'browser' && Object.hasOwn(ORIGINS, origin ?? '')
          ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
        if (klass === 'browser' && env.BROWSER_ENABLED !== 'true') return response({ error: 'disabled' }, 503);
        if (request.method === 'OPTIONS' && klass === 'browser' && cors.Vary) return new Response(null,
          { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' } });
        if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
        let source;
        if (klass === 'browser') {
          if (!cors.Vary) return response({ error: 'forbidden' }, 403);
          // Shared edge-local cap before D1 work; no visitor/IP-derived key.
          if (env.BROWSER_EDGE_LIMITER && !(await env.BROWSER_EDGE_LIMITER.limit({ key: 'browser' })).success)
            return response({ error: 'rate_limited' }, 429, cors);
          source = 'browser';
        } else {
          const configured = credentials(env);
          if (!configured) return response({ error: 'configuration' }, 503);
          source = await writer(request, configured, klass);
          if (!source) return response({ error: 'unauthorized' }, 401);
        }
        if (!await takeBudget(env.TELEMETRY_DB, source, klass, now)) return response({ error: 'rate_limited' }, isOtlp ? 503 : 429, cors);
        const payload = isOtlp ? await otlp(request, { source, now }) : await boundedJson(request);
        const data = validate(klass, payload, env, now);
        if (klass === 'browser' ? ORIGINS[origin] !== data.destination : data.source !== source) throw new Invalid();
        if (klass === 'metrics' && !await takeBudget(env.TELEMETRY_DB, source, klass, now, data.points.length))
          return response({ error: 'rate_limited' }, isOtlp ? 503 : 429);
        const result = await ingest(env.TELEMETRY_DB, klass, data, now, env);
        if (result.conflict) return response({ error: 'batch_conflict' }, 409, cors);
        if (isOtlp) return new Response(null, { status: 200,
          headers: { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-store' } });
        return response({ accepted: true, duplicate: result.duplicate }, 202, cors);
      } catch (error) {
        // Never log request, headers, payload, SQL errors or adapter exceptions.
        const invalid = error instanceof Invalid || (actualOtlp && error instanceof OtlpError);
        const status = actualOtlp && error instanceof OtlpError && [400, 408, 413, 415, 422].includes(error.status)
          ? error.status : invalid ? 400 : 503;
        return response({ error: invalid ? 'invalid_payload' : 'unavailable' }, status);
      }
    },
    async scheduled(_event, env, ctx) {
      // Stopping collection must not stop expiry of already retained records.
      if (!env.TELEMETRY_DB) return;
      const work = purge(env.TELEMETRY_DB, clock(), env).catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(work);
      else await work;
    },
  };
}
export default createWorker({ otlp: otlpHook });
