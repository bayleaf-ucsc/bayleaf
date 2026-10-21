import { organizationEnvelope, webhookEnvelope } from './receiver.js';
import { readOtlpBytes } from '../otlp/normalize.mjs';
import { canonical } from '../src/validate.js';
import { shapes } from './shapes.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
// Use a fresh actor when changing this receiver: a live timer can keep the prior
// actor's code resident during rollout. Never mistake a deploy ID for readback.
const REVISION = 'qualification-r3';
async function authenticated(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const hash = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([hash(request.headers.get('Authorization') ?? ''), hash(`Bearer ${secret}`)]);
  const x = new Uint8Array(a), y = new Uint8Array(b); let different = 0;
  for (let i = 0; i < x.length; i++) different |= x[i] ^ y[i];
  return different === 0;
}
export default {
  async fetch(request, env) {
    if (!Number.isSafeInteger(Number(env.QUALIFICATION_END_MS)) || Date.now() >= Number(env.QUALIFICATION_END_MS))
      return reply(410, { error: 'qualification_closed' });
    const path = new URL(request.url).pathname;
    const webhook = path === '/webhook';
    if (!webhook && !await authenticated(request,
      path === '/report' ? env.QUALIFICATION_READ_SECRET : env.QUALIFICATION_WRITE_SECRET))
      return reply(401, { error: 'unauthorized' });
    if (new URL(request.url).search) return reply(400, { error: 'invalid_request' });
    if (path === '/report' && request.method !== 'GET') return reply(405, { error: 'method' });
    if (path !== '/report' && request.method !== 'POST') return reply(405, { error: 'method' });
    if (!['/report', '/webhook', '/v1/metrics', '/v1/logs', '/v1/traces'].includes(path)) return reply(404, { error: 'not_found' });
    if (path !== '/report' && !(await env.QUALIFICATION_LIMITER.limit({ key: 'qualification' })).success)
      return reply(429, { error: 'rate_limited' });
    return env.RESULTS.get(env.RESULTS.idFromName(REVISION)).fetch(request);
  },
};

export class QualificationResults {
  constructor(_ctx, env) {
    this.env = env;
    // Deliberately no storage API: these results disappear on actor eviction.
    this.receipts = new Map();
    // Keep this test actor awake for its bounded window. Without a timer,
    // eviction may clear in-memory results between the minute-spaced exports.
    const keepAlive = setInterval(() => {}, 1000);
    setTimeout(() => clearInterval(keepAlive), Math.max(0, Math.min(20 * 60_000,
      Number(env.QUALIFICATION_END_MS) - Date.now())));
    this.stats = { webhook: { accepted: 0, rejected: 0, retries: 0, conflicts: 0, header_family: null, buckets: [] },
      metrics: { accepted: 0, rejected: 0, empty: 0, shapes: [], points: [], transport: null, last_error: null },
      discarded: { logs: 0, traces: 0 } };
  }
  async fetch(request) {
    const path = new URL(request.url).pathname, stats = this.stats;
    if (path === '/report') return reply(200, { revision: REVISION, ...stats });
    if (path === '/v1/logs' || path === '/v1/traces') {
      stats.discarded[path.slice(4)]++;
      void request.body?.cancel().catch(() => {});
      return new Response(null, { headers: { 'Content-Type': 'application/x-protobuf' } });
    }
    if (path === '/webhook') {
      try {
        const input = await webhookEnvelope(request, this.env, Date.now());
        const { batch_id, ...bucket } = input, semantic = canonical(bucket);
        const previous = this.receipts.get(batch_id);
        if (previous && previous !== semantic) { stats.webhook.conflicts++; return reply(409, { error: 'conflict' }); }
        if (previous) stats.webhook.retries++;
        else {
          if (this.receipts.size >= 256) return reply(429, { error: 'budget' });
          this.receipts.set(batch_id, semantic); stats.webhook.accepted++;
          if (stats.webhook.buckets.length < 32) stats.webhook.buckets.push(bucket);
        }
        stats.webhook.header_family = request.headers.has('svix-id') ? 'svix' : 'webhook';
        return reply(202, { accepted: true });
      } catch { stats.webhook.rejected++; return reply(400, { error: 'invalid_webhook' }); }
    }
    try {
      stats.metrics.transport = { content_type: request.headers.get('content-type') === 'application/x-protobuf' ? 'protobuf' : 'other',
        encoding: ['gzip', 'identity', null].includes(request.headers.get('content-encoding'))
          ? request.headers.get('content-encoding') ?? 'identity' : 'other' };
      const bytes = await readOtlpBytes(request);
      const inspected = shapes(bytes);
      if (inspected.length) stats.metrics.shapes = inspected;
      const result = await organizationEnvelope(bytes, this.env);
      if (result) { stats.metrics.accepted++; stats.metrics.points = result.points; } else stats.metrics.empty++;
      return new Response(null, { headers: { 'Content-Type': 'application/x-protobuf' } });
    } catch (error) {
      stats.metrics.rejected++;
      const codes = ['unapproved_unit', 'point_budget', 'unsupported_flags', 'unapproved_dimensions',
        'unsupported_field', 'invalid_otlp', 'invalid_payload'];
      stats.metrics.last_error = codes.includes(error.message) ? error.message : 'other';
      return reply(400, { error: 'invalid_metrics' });
    }
  }
}
