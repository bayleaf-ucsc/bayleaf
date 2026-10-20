/** Trusted bridge: protobuf -> first-party normalized metric envelope.
 * Requires exact-nanosecond fields and native units in core's validation/storage.
 * This is not an OTLP JSON serializer. See README.md for integration gates.
 */
import { normalizeOtlp, OtlpError } from './normalize.mjs';

function safeNumber(decimal) {
  const n = BigInt(decimal);
  if (n < 0n || n > 1_000_000_000_000n) throw new OtlpError('count_outside_storage_policy', 422);
  return Number(n);
}
function epochMs(decimal) {
  const n = BigInt(decimal) / 1_000_000n;
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new OtlpError('time_outside_storage_policy', 422);
  return Number(n);
}
const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : x && typeof x === 'object'
  ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);

/** Deterministic content receipt matching core's UUIDv4-shaped validation.
 * Not a random ID or identity hash. Digest contains ONLY already-minimized points.
 * Same semantic export, different wire ordering -> same ID, no receipt-time drift.
 */
async function receiptId(semantic) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(semantic))));
  const id = digest.slice(0, 16); id[6] = (id[6] & 15) | 64; id[8] = (id[8] & 63) | 128;
  const s = Array.from(id, b => b.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function createOtlpHook({ instance = 'single', routes, minimumWindowMs = 10_000, maxPoints = 100 } = {}) {
  if (!['single', 'worker-1', 'worker-2', 'worker-3', 'worker-4'].includes(instance) ||
      !Number.isSafeInteger(minimumWindowMs) || minimumWindowMs < 10_000 ||
      !Number.isSafeInteger(maxPoints) || maxPoints < 1 || maxPoints > 512) throw new OtlpError('invalid_policy');
  return async function otlp(request, { source, now } = {}) {
    if (source !== 'owui' || !Number.isSafeInteger(now)) throw new OtlpError('invalid_authenticated_source', 403);
    const normalized = await normalizeOtlp(request, routes ? { routes } : {});
    const points = [];
    for (const p of normalized.points) {
      if (p.kind !== 'gauge') {
        if (p.startTimeUnixNano === '0') throw new OtlpError('unknown_start_time', 422);
        // New native series start at the first measurement, not process start.
        // Skip these transiently, do not stretch/forge their aggregation interval.
        if (BigInt(p.timeUnixNano) - BigInt(p.startTimeUnixNano) < BigInt(minimumWindowMs) * 1_000_000n) continue;
      }
      const point = { name: p.metric, kind: p.kind, unit: p.unit,
        observed_at: epochMs(p.timeUnixNano), time_unix_nano: p.timeUnixNano,
        attributes: p.global ? {} : { method: p.dimensions.method, route: p.dimensions.route, status_code: p.dimensions.status, instance } };
      if (p.kind === 'gauge') point.value = safeNumber(p.value);
      else {
        point.start_at = epochMs(p.startTimeUnixNano);
        point.start_time_unix_nano = p.startTimeUnixNano;
        point.temporality = p.temporality;
        if (p.kind === 'sum') { point.monotonic = true; point.value = safeNumber(p.value); }
        else {
          point.count = safeNumber(p.count);
          point.bounds = p.explicitBounds;
          point.bucket_counts = p.bucketCounts.map(safeNumber);
          for (const key of ['sum', 'min', 'max']) if (Object.hasOwn(p, key)) point[key] = p[key];
        }
      }
      points.push(point);
    }
    if (!points.length) throw new OtlpError('no_aggregate_points', 422);
    if (points.length > maxPoints) throw new OtlpError('too_many_points', 413);
    // Gauges never carry worker identity. Each is a global DB snapshot, not a
    // disjoint per-worker population. Reporting must select one authoritative
    // gauge sample, never sum snapshots from different workers/collect times.
    points.sort((a, b) => { const x = canonical(a), y = canonical(b); return x < y ? -1 : x > y ? 1 : 0; });
    const observed_at = Math.max(...points.map(p => p.observed_at));
    const semantic = { schema_version: 1, source, observed_at, points };
    return { ...semantic, batch_id: await receiptId(semantic) };
  };
}
export const otlpHook = createOtlpHook();
