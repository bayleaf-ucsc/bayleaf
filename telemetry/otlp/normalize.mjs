/** Narrow OTLP/HTTP Metrics protobuf reader. No Node imports: Worker-compatible. */
export const LIMITS = Object.freeze({ bytes: 262144, fields: 24000, points: 512, metrics: 64, buckets: 64, bodyMs: 2000, chunks: 2048 });
export const DEFAULT_ROUTES = Object.freeze(['/health', '/api/version', '/api/chat/completions', '/api/v1/chats/{id}', '/_other']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'OTHER']);
const GAUGES = new Set(['webui.users.total', 'webui.users.active', 'webui.users.active.today']);
const DESCRIPTIONS = Object.freeze({
  'http.server.requests': 'Counts the total number of inbound HTTP requests.',
  'http.server.duration': 'Measures the duration of inbound HTTP requests.',
  'webui.users.total': 'Total number of registered users',
  'webui.users.active': 'Number of currently active users',
  'webui.users.active.today': 'Number of users active since midnight today',
});
const textDecoder = new TextDecoder('utf-8', { fatal: true });
export class OtlpError extends Error {
  constructor(code = 'invalid_otlp', status = 400) { super(code); this.name = 'OtlpError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new OtlpError(code, status); };
const assert = (condition, code = 'invalid_otlp') => { if (!condition) fail(code); };

// All wire integers stay BigInt until explicitly bounded. Output uses decimal
// strings for nanoseconds, int64 values, counts and buckets, never lossy Number.
class Reader {
  constructor(bytes, budget) { this.b = bytes; this.i = 0; this.budget = budget; }
  varint() {
    let n = 0n;
    for (let j = 0; j < 10; j++) {
      assert(this.i < this.b.length);
      const b = this.b[this.i++];
      assert(j !== 9 || b <= 1);
      n |= BigInt(b & 127) << BigInt(j * 7);
      if (!(b & 128)) return n;
    }
    fail();
  }
  take(n) { assert(n >= 0 && this.i + n <= this.b.length); const v = this.b.subarray(this.i, this.i + n); this.i += n; return v; }
  fields() {
    const out = new Map();
    while (this.i < this.b.length) {
      assert(++this.budget.fields <= LIMITS.fields, 'too_many_fields');
      const tag = this.varint();
      const id = Number(tag >> 3n), wire = Number(tag & 7n);
      assert(id > 0 && id <= 536870911);
      let v;
      if (wire === 0) v = this.varint();
      else if (wire === 1) v = this.take(8);
      else if (wire === 2) { const n = this.varint(); assert(n <= BigInt(LIMITS.bytes)); v = this.take(Number(n)); }
      else if (wire === 5) v = this.take(4);
      else fail();
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ wire, v });
    }
    return out;
  }
}
function schema(bytes, allowed, budget) {
  const f = new Reader(bytes, budget).fields();
  for (const id of f.keys()) assert(allowed.includes(id), 'unsupported_field');
  return f;
}
function one(f, id, wire, required = false) {
  const a = f.get(id) ?? [];
  assert(a.length <= 1);
  if (!a.length) { assert(!required); return undefined; }
  assert(a[0].wire === wire); return a[0].v;
}
function many(f, id, wire) { const a = f.get(id) ?? []; assert(a.every(x => x.wire === wire)); return a.map(x => x.v); }
function str(v) { assert(v && v.length <= 256, 'invalid_string'); try { return textDecoder.decode(v); } catch { fail(); } }
function fixed(v) { if (!v) return 0n; return new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true); }
function double(v) { assert(v); const n = new DataView(v.buffer, v.byteOffset, 8).getFloat64(0, true); assert(Number.isFinite(n) && n >= 0, 'invalid_number'); return n; }
function packed(f, id, type) {
  const out = [];
  for (const x of f.get(id) ?? []) {
    assert(x.wire === 1 || x.wire === 2);
    assert(x.v.length % 8 === 0);
    if (x.wire === 1) assert(x.v.length === 8);
    for (let i = 0; i < x.v.length; i += 8) {
      assert(out.length < LIMITS.buckets, 'too_many_buckets');
      const b = x.v.subarray(i, i + 8); out.push(type === 'int' ? fixed(b) : double(b));
    }
  }
  return out;
}
function attributes(f, id, routes, budget) {
  const a = many(f, id, 2); assert(a.length === 3, 'unexpected_dimensions');
  const out = {};
  for (const raw of a) {
    const kv = schema(raw, [1, 2], budget), k = str(one(kv, 1, 2, true));
    assert(['http.method', 'http.route', 'http.status_code'].includes(k) && !Object.hasOwn(out, k), 'unexpected_dimensions');
    const av = schema(one(kv, 2, 2, true), k === 'http.status_code' ? [3] : [1], budget);
    out[k] = k === 'http.status_code' ? Number(one(av, 3, 0, true)) : str(one(av, 1, 2, true));
  }
  assert(METHODS.has(out['http.method']), 'unapproved_method');
  assert(routes.has(out['http.route']), 'unapproved_route');
  assert(Number.isInteger(out['http.status_code']) && out['http.status_code'] >= 100 && out['http.status_code'] <= 599, 'invalid_status');
  return { method: out['http.method'], route: out['http.route'], status: out['http.status_code'] };
}
function times(f) {
  const start = fixed(one(f, 2, 1)), time = fixed(one(f, 3, 1, true));
  assert(time > 0n && time >= start, 'invalid_time');
  return { startTimeUnixNano: start.toString(), timeUnixNano: time.toString() };
}
function numberPoint(raw, gauge, routes, budget) {
  const f = schema(raw, [2, 3, 4, 6, 7, 8], budget);
  assert((one(f, 8, 0) ?? 0n) === 0n, 'unsupported_flags');
  const int = one(f, 6, 1), dbl = one(f, 4, 1);
  assert(Boolean(int) !== Boolean(dbl));
  // Native counters and account gauges are integer-valued. Reject floats rather
  // than silently round counts, even if a different exporter happens to use them.
  assert(int && !dbl, 'unsupported_number_type');
  const n = BigInt.asIntN(64, fixed(int)); assert(n >= 0n, 'invalid_number');
  let dimensions;
  if (gauge) { assert(!f.has(7), 'unexpected_dimensions'); dimensions = {}; }
  else dimensions = attributes(f, 7, routes, budget);
  return { ...times(f), dimensions, value: n.toString() };
}
function histogramPoint(raw, routes, budget) {
  const f = schema(raw, [2, 3, 4, 5, 6, 7, 9, 10, 11, 12], budget);
  assert((one(f, 10, 0) ?? 0n) === 0n, 'unsupported_flags');
  const count = fixed(one(f, 4, 1, true));
  const buckets = packed(f, 6, 'int'), bounds = packed(f, 7, 'double');
  assert(buckets.length === bounds.length + 1 && bounds.every((x, i) => i === 0 || x > bounds[i - 1]), 'invalid_histogram');
  assert(buckets.reduce((a, b) => a + b, 0n) === count, 'invalid_histogram');
  const sumWire = one(f, 5, 1), minWire = one(f, 11, 1), maxWire = one(f, 12, 1);
  const stats = {};
  if (sumWire) stats.sum = double(sumWire);
  if (minWire) stats.min = double(minWire);
  if (maxWire) stats.max = double(maxWire);
  assert(stats.min === undefined || stats.max === undefined || stats.min <= stats.max, 'invalid_histogram');
  assert(count !== 0n || (stats.min === undefined && stats.max === undefined && (stats.sum === undefined || stats.sum === 0)), 'invalid_histogram');
  return { ...times(f), dimensions: attributes(f, 9, routes, budget), count: count.toString(), bucketCounts: buckets.map(String), explicitBounds: bounds, ...stats };
}

/**
 * normalizeOtlp(Uint8Array|ArrayBuffer|Request, {routes?: string[]} = {})
 * -> Promise<{points: NormalizedPoint[], duplicates: number}>
 * Request: POST application/x-protobuf, identity encoding only. Authentication,
 * endpoint routing, rate limits, durable dedup and storage belong to the caller.
 * Throws OtlpError with content-free code/status. No payload values in errors.
 */
export async function normalizeOtlp(input, options = {}) {
  const routesArray = options.routes ?? DEFAULT_ROUTES;
  assert(Array.isArray(routesArray) && routesArray.length <= 128 && routesArray.every(x => typeof x === 'string' && x.length <= 128 && /^\/[A-Za-z0-9_/{.}\-]*$/.test(x)), 'invalid_policy');
  const routes = new Set(routesArray);
  let bytes;
  if (input instanceof Request) {
    assert(input.method === 'POST', 'method_not_allowed');
    if (input.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-protobuf') fail('unsupported_media_type', 415);
    const encoding = input.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') fail('unsupported_encoding', 415);
    const length = input.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || BigInt(length) > BigInt(LIMITS.bytes))) fail('payload_too_large', 413);
    const reader = input.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) {
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new OtlpError('body_timeout', 408)), LIMITS.bodyMs); });
      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), deadline]);
          if (done) break;
          size += value.length;
          if (size > LIMITS.bytes) fail('payload_too_large', 413);
          if (chunks.length >= LIMITS.chunks) fail('too_many_chunks', 413);
          chunks.push(value);
        }
      } catch (e) {
        // Cancellation of an untrusted producer is not awaited: it can itself
        // stall. It never logs the input or includes stream errors in output.
        void reader.cancel().catch(() => {});
        if (e instanceof OtlpError) throw e;
        fail('invalid_body');
      } finally { clearTimeout(timer); reader.releaseLock(); }
    }
    bytes = new Uint8Array(size); let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  } else bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : fail('invalid_input');
  if (bytes.length > LIMITS.bytes) fail('payload_too_large', 413);
  assert(bytes.length > 0, 'empty_payload');
  const budget = { fields: 0 }; const points = []; let metricCount = 0;
  const root = schema(bytes, [1], budget);
  for (const raw of many(root, 1, 2)) {
    const rm = schema(raw, [1, 2, 3], budget);
    // Require source-minimized resources. Do not preserve SDK, host, process,
    // user-supplied service names, schema URLs, or any resource attribute.
    const resource = one(rm, 1, 2);
    if (resource) { const r = schema(resource, [2], budget); assert((one(r, 2, 0) ?? 0n) === 0n, 'dropped_attributes'); }
    assert(!rm.has(3), 'unsupported_schema_url');
    for (const scopeRaw of many(rm, 2, 2)) {
      const sm = schema(scopeRaw, [1, 2], budget), scope = one(sm, 1, 2);
      if (scope) { const s = schema(scope, [1], budget); assert(str(one(s, 1, 2, true)) === 'open_webui.utils.telemetry.metrics', 'unsupported_scope'); }
      for (const metricRaw of many(sm, 2, 2)) {
        assert(++metricCount <= LIMITS.metrics, 'too_many_metrics');
        const m = schema(metricRaw, [1, 2, 3, 5, 7, 9], budget);
        const name = str(one(m, 1, 2, true)), unit = str(one(m, 3, 2, true));
        const gauge = GAUGES.has(name), hist = name === 'http.server.duration';
        assert(gauge || hist || name === 'http.server.requests', 'unsupported_metric');
        const description = one(m, 2, 2);
        if (description) assert(str(description) === DESCRIPTIONS[name], 'unsupported_description');
        assert(unit === (gauge ? 'users' : hist ? 'ms' : '1'), 'invalid_unit');
        const field = gauge ? 5 : hist ? 9 : 7;
        assert([5, 7, 9].filter(x => m.has(x)).length === 1 && m.has(field), 'unsupported_metric_type');
        const data = schema(one(m, field, 2, true), gauge ? [1] : hist ? [1, 2] : [1, 2, 3], budget);
        const temporality = gauge ? 'unspecified' : Number(one(data, 2, 0) ?? 0n);
        if (!gauge) assert(temporality === 1 || temporality === 2, 'unsupported_temporality');
        if (!gauge && !hist) assert(one(data, 3, 0) === 1n, 'non_monotonic_counter');
        for (const point of many(data, 1, 2)) {
          assert(points.length < LIMITS.points, 'too_many_points');
          points.push({ metric: name, kind: gauge ? 'gauge' : hist ? 'histogram' : 'sum', unit, temporality: gauge ? 'unspecified' : temporality === 1 ? 'delta' : 'cumulative', global: gauge, ...(hist ? histogramPoint(point, routes, budget) : numberPoint(point, gauge, routes, budget)) });
        }
      }
    }
  }
  assert(points.length > 0, 'empty_payload');
  const identities = new Map(), unique = []; let duplicates = 0;
  for (const p of points) {
    const key = JSON.stringify([p.metric, p.dimensions, p.startTimeUnixNano, p.timeUnixNano]);
    const value = JSON.stringify(p);
    if (identities.has(key)) { assert(identities.get(key) === value, 'conflicting_duplicate'); duplicates++; }
    else { identities.set(key, value); unique.push(p); }
  }
  return { points: unique, duplicates };
}
