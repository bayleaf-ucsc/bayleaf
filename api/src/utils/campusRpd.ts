/**
 * Campus Pass RPD Counter (KV-backed)
 *
 * Provider-agnostic per-IP daily request limit for /chat/completions and
 * /responses. IPv4 keyed per address; IPv6 aggregated to /64. Resets at
 * midnight UTC.
 *
 * Storage: Workers KV. One key per (bucket, day): `campus-rpd:<bucket>:<YYYY-MM-DD>`
 * with TTL 36h (long enough that a stale read after midnight UTC still expires
 * automatically; new days get a fresh key).
 *
 * Race / consistency notes:
 * - KV get+put is not atomic. Two simultaneous requests at count=N-1 can both
 *   pass and write count=N+1, overshooting by one. Acceptable for a 100/day
 *   per-IP cap; if precision matters later, switch to a Durable Object.
 * - KV is eventually consistent globally (~60s). Brief over-cap windows are
 *   possible if a single client hops PoPs. Also acceptable.
 */

import { bucketKey } from './ip';

const KV_PREFIX = 'campus-rpd';
const TTL_SECONDS = 60 * 60 * 36; // 36h: covers post-midnight stale reads

interface CounterValue {
  count: number;
}

/** YYYY-MM-DD in UTC. */
function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

function kvKey(ip: string, date: string): string {
  return `${KV_PREFIX}:${bucketKey(ip)}:${date}`;
}

async function readCount(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key, 'json') as CounterValue | null;
  return raw?.count ?? 0;
}

async function writeCount(kv: KVNamespace, key: string, count: number): Promise<void> {
  await kv.put(key, JSON.stringify({ count }), { expirationTtl: TTL_SECONDS });
}

export interface CampusRpdStatus {
  count: number;
  limit: number;
  remaining: number;
  resetsAt: string; // ISO 8601, next midnight UTC
}

/** Compute the next midnight UTC as an ISO 8601 string. */
function nextMidnightUTC(): string {
  const t = new Date();
  t.setUTCHours(24, 0, 0, 0);
  return t.toISOString();
}

/**
 * Check the current request against the per-IP RPD limit and increment on pass.
 *
 * Returns null if the request is allowed (counter incremented).
 * Returns a CampusRpdStatus describing the over-limit state if rejected
 * (counter NOT incremented).
 */
export async function checkAndIncrement(
  kv: KVNamespace,
  ip: string,
  limit: number,
): Promise<CampusRpdStatus | null> {
  const date = todayUTC();
  const key = kvKey(ip, date);
  const current = await readCount(kv, key);

  if (current >= limit) {
    return {
      count: current,
      limit,
      remaining: 0,
      resetsAt: nextMidnightUTC(),
    };
  }

  await writeCount(kv, key, current + 1);
  return null;
}

/**
 * Read-only inspection of the current counter. Used by /v1/auth/key to report
 * remaining budget without consuming a request.
 */
export async function inspectCounter(
  kv: KVNamespace,
  ip: string,
  limit: number,
): Promise<CampusRpdStatus> {
  const date = todayUTC();
  const key = kvKey(ip, date);
  const count = await readCount(kv, key);
  return {
    count,
    limit,
    remaining: Math.max(0, limit - count),
    resetsAt: nextMidnightUTC(),
  };
}

/** Parse the configured limit from env, with a safe fallback. */
export function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}
