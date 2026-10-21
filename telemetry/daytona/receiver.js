import { Invalid, keys, canonical } from '../src/validate.js';
import { receiptId } from '../otlp/worker-adapter.mjs';
import { readOtlpBytes, schema, one, many, str, fixed, double, OtlpError } from '../otlp/normalize.mjs';
import { DAYTONA_METRICS, BUCKET_MS, STATES, REGIONS, CLASSES } from './policy.js';

const encoder = new TextEncoder();
const check = (condition, code = 'invalid_payload') => { if (!condition) throw new Invalid(code); };
const reply = (status, error) => Response.json(error ? { error } : { accepted: true },
  { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const protobuf = () => new Response(null, { status: 200,
  headers: { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-store' } });

async function webhookBody(request) {
  check(/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''));
  check(!request.headers.get('content-encoding') || request.headers.get('content-encoding') === 'identity');
  check(Number(request.headers.get('content-length') ?? 0) <= 16_384);
  // Reuse the qualified bounded stream reader, with a stricter webhook size cap.
  const headers = new Headers(request.headers); headers.set('content-type', 'application/x-protobuf');
  const bytes = await readOtlpBytes(new Request(request, { headers }), { maxBytes: 16_384 });
  check(bytes.length <= 16_384);
  return bytes;
}

function base64(value) {
  check(typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9+/]+={0,2}$/.test(value));
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

/** Standard Webhooks candidate verifier. Live Daytona compatibility is a rollout
 * gate, not inferred from their documentation's dashboard appearance.
 */
export async function webhookEnvelope(request, env, now) {
  check(env.DAYTONA_WEBHOOK_PROTOCOL === 'standard-webhooks');
  check(typeof env.DAYTONA_ORGANIZATION_ID === 'string' && env.DAYTONA_ORGANIZATION_ID.length > 0);
  check(typeof env.DAYTONA_RECEIPT_SECRET === 'string' && env.DAYTONA_RECEIPT_SECRET.length >= 32);
  const family = request.headers.has('webhook-id') ? 'webhook' : 'svix';
  // Mixed header families are ambiguous and must not be interpreted differently.
  check(!(['id', 'timestamp', 'signature'].some(k => request.headers.has(`webhook-${k}`)) &&
    ['id', 'timestamp', 'signature'].some(k => request.headers.has(`svix-${k}`))));
  const id = request.headers.get(`${family}-id`);
  const timestamp = request.headers.get(`${family}-timestamp`);
  const signatures = request.headers.get(`${family}-signature`);
  check(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id));
  check(/^\d{1,12}$/.test(timestamp ?? '') && Math.abs(Number(timestamp) * 1000 - now) <= 300_000);
  check(typeof signatures === 'string' && signatures.length <= 1024);
  const secret = env.DAYTONA_WEBHOOK_SECRET;
  check(typeof secret === 'string' && secret.startsWith('whsec_'));
  const keyBytes = base64(secret.slice(6)); check(keyBytes.length >= 24);
  const raw = await webhookBody(request);
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + raw.length); signed.set(prefix); signed.set(raw, prefix.length);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let valid = false;
  for (const part of signatures.split(' ').slice(0, 8)) {
    if (!part.startsWith('v1,')) continue;
    try { valid = await crypto.subtle.verify('HMAC', key, base64(part.slice(3)), signed) || valid; } catch { /* no raw diagnostics */ }
  }
  check(valid);
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  check(['sandbox.created', 'sandbox.state.updated'].includes(input?.event));
  const created = input.event === 'sandbox.created';
  const fields = created ? ['event', 'timestamp', 'id', 'organizationId', 'state', 'sandboxClass', 'createdAt']
    : ['event', 'timestamp', 'id', 'organizationId', 'oldState', 'newState', 'updatedAt'];
  keys(input, fields, fields);
  check(input.organizationId === env.DAYTONA_ORGANIZATION_ID);
  check(typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 256);
  const newState = created ? input.state : input.newState;
  check(STATES.includes(newState) && (created || STATES.includes(input.oldState)));
  if (created) check(CLASSES.includes(input.sandboxClass));
  check(typeof input.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(input.timestamp));
  const time = Date.parse(input.timestamp);
  check(Number.isSafeInteger(time) && time <= now + 60_000);
  // A keyed delivery receipt identifies an event retry, never a sandbox.
  // Do not use the raw payload or sandbox ID as the durable receipt identity.
  const receiptKey = await crypto.subtle.importKey('raw', encoder.encode(env.DAYTONA_RECEIPT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', receiptKey, encoder.encode(id)));
  const batch_id = await receiptId([...digest]);
  return { schema_version: 1, source: 'daytona', batch_id,
    observed_at: Math.floor(time / BUCKET_MS) * BUCKET_MS,
    event: input.event, old_state: created ? null : input.oldState, new_state: newState };
}

function stringAttributes(raws, budget) {
  const out = new Map();
  for (const raw of raws) {
    const kv = schema(raw, [1, 2], budget), name = str(one(kv, 1, 2, true));
    check(!out.has(name));
    // Do not decode arbitrary attribute values, including sandbox names/IDs.
    if (!['organization.id', 'region.id', 'sandbox.class'].includes(name)) { out.set(name, null); continue; }
    const av = schema(one(kv, 2, 2, true), [1], budget);
    out.set(name, str(one(av, 1, 2, true)));
  }
  return out;
}

/** Filter mixed Daytona exports before storage. Only organization resources with
 * exactly the reviewed resource/dimension keys are eligible. Unknown names are
 * dropped, never auto-added to the collection policy.
 */
export async function organizationEnvelope(request, env) {
  check(typeof env.DAYTONA_ORGANIZATION_ID === 'string' && env.DAYTONA_ORGANIZATION_ID.length > 0);
  const bytes = await readOtlpBytes(request), budget = { fields: 0 };
  const root = schema(bytes, [1], budget), points = [], identities = new Map();
  let metrics = 0, scanned = 0;
  for (const raw of many(root, 1, 2)) {
    const rm = schema(raw, [1, 2, 3], budget);
    const resource = one(rm, 1, 2);
    if (!resource) continue;
    const r = schema(resource, [1, 2], budget);
    const attributes = stringAttributes(many(r, 1, 2), budget);
    // Per-sandbox resources have daytona_organization_id/service.instance.id,
    // not the approved organization.id-only resource. Drop them wholesale.
    if (attributes.size !== 1 || attributes.get('organization.id') !== env.DAYTONA_ORGANIZATION_ID) continue;
    check((one(r, 2, 0) ?? 0n) === 0n);
    for (const scopeRaw of many(rm, 2, 2)) {
      const scope = schema(scopeRaw, [1, 2, 3], budget);
      for (const metricRaw of many(scope, 2, 2)) {
        check(++metrics <= 64);
        const m = schema(metricRaw, [1, 2, 3, 5, 7, 9, 10, 11, 12], budget);
        const name = str(one(m, 1, 2, true)), spec = DAYTONA_METRICS[name];
        if (!spec) continue;
        // Units are deliberately strict pending real-export qualification.
        const unit = str(one(m, 3, 2, true));
        const allowedUnits = spec.unit === 'GiBy' ? ['GiBy', 'GiB'] : spec.unit === 'cores' ? ['cores', '{core}', '{cpu}'] : ['1', '{gpu}'];
        check(allowedUnits.includes(unit), 'unapproved_unit');
        check(m.has(5) && ![7, 9, 10, 11].some(k => m.has(k)));
        const gauge = schema(one(m, 5, 2, true), [1], budget);
        for (const rawPoint of many(gauge, 1, 2)) {
          check(++scanned <= 100, 'point_budget');
          const p = schema(rawPoint, [2, 3, 4, 6, 7, 8], budget);
          check((one(p, 8, 0) ?? 0n) === 0n, 'unsupported_flags');
          const dims = stringAttributes(many(p, 7, 2), budget);
          check(dims.size === 2 && REGIONS.includes(dims.get('region.id')) && CLASSES.includes(dims.get('sandbox.class')), 'unapproved_dimensions');
          const int = one(p, 6, 1), dbl = one(p, 4, 1);
          check(Boolean(int) !== Boolean(dbl));
          const value = int ? Number(BigInt.asIntN(64, fixed(int))) : double(dbl);
          check(Number.isFinite(value) && value >= 0 && value <= 1e12);
          const ns = fixed(one(p, 3, 1, true)); check(ns > 0n);
          const point = { name, kind: 'gauge', unit: spec.unit, value,
            observed_at: Number(ns / 1_000_000n),
            attributes: { region: dims.get('region.id'), sandbox_class: dims.get('sandbox.class') } };
          const identity = canonical([name, point.observed_at, point.attributes]);
          const semantic = canonical(point);
          if (identities.has(identity)) { check(identities.get(identity) === semantic); continue; }
          identities.set(identity, semantic); points.push(point);
        }
      }
    }
  }
  // A legitimate export containing only excluded sandbox metrics is acknowledged
  // without creating a receipt, source-status row, or fake zero sample.
  if (!points.length) return null;
  points.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const envelope = { schema_version: 1, source: 'daytona',
    observed_at: Math.max(...points.map(p => p.observed_at)), points };
  return { ...envelope, batch_id: await receiptId(envelope) };
}

export async function daytonaReceiver(request, env, { now, authenticate, submit }) {
  const path = new URL(request.url).pathname;
  const webhook = path === '/v1/daytona/webhooks';
  // OTLP base URLs append /v1/{signal}; keep the short signal routes as aliases
  // for callers configured with explicit per-signal endpoint URLs.
  const otlp = path.match(/^\/v1\/daytona\/otlp\/(?:v1\/)?(metrics|logs|traces)$/);
  if (!webhook && !otlp) return reply(404, 'not_found');
  if (new URL(request.url).search) return reply(400, 'invalid_request');
  if (request.method !== 'POST') return reply(405, 'method_not_allowed');
  if (env[webhook ? 'DAYTONA_WEBHOOKS_ENABLED' : 'DAYTONA_OTLP_ENABLED'] !== 'true') return reply(503, 'disabled');
  try {
    if (env.DAYTONA_EDGE_LIMITER && !(await env.DAYTONA_EDGE_LIMITER.limit({ key: 'daytona' })).success)
      return reply(429, 'rate_limited');
    if (webhook) {
      if (env.DAYTONA_WEBHOOK_PROTOCOL !== 'standard-webhooks' || !env.DAYTONA_WEBHOOK_SECRET ||
          !env.DAYTONA_RECEIPT_SECRET || !env.DAYTONA_ORGANIZATION_ID) return reply(503, 'configuration');
      let payload;
      try { payload = await webhookEnvelope(request, env, now); } catch { return reply(400, 'invalid_webhook'); }
      return await submit('lifecycle', payload, false);
    }
    if (!await authenticate()) return reply(401, 'unauthorized');
    if (!env.DAYTONA_ORGANIZATION_ID) return reply(503, 'configuration');
    if (otlp[1] !== 'metrics') {
      // Do not buffer or decode log/trace bodies. Cancel without awaiting an
      // untrusted producer; acknowledge to avoid pointless exporter retries.
      // Cloudflare's transport can still receive data before cancellation.
      void request.body?.cancel().catch(() => {});
      return protobuf();
    }
    const payload = await organizationEnvelope(request, env);
    return payload ? await submit('metrics', payload, true) : protobuf();
  } catch (error) {
    // A bounded body-read timeout is transport failure, not a permanent schema
    // rejection. OTLP exporters can retry 503 without duplicating stored exports.
    if (error instanceof OtlpError && error.status === 408) return reply(503, 'unavailable');
    const invalid = error instanceof Invalid || error instanceof OtlpError;
    return reply(invalid ? 400 : 503, invalid ? 'invalid_payload' : 'unavailable');
  }
}
