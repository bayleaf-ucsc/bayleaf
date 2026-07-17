/**
 * IP Range Utilities (Campus Pass)
 */

import type { Bindings } from '../types';

/**
 * Convert an IPv4 address to a BigInt
 */
function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  
  let result = 0n;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8n) | BigInt(num);
  }
  return result;
}

/**
 * Convert an IPv6 address to a BigInt
 * Handles full and compressed formats (e.g., 2607:F5F0::1)
 */
function ipv6ToBigInt(ip: string): bigint | null {
  // Expand :: notation
  let parts = ip.split(':');
  
  const doubleColonIndex = ip.indexOf('::');
  if (doubleColonIndex !== -1) {
    const before = ip.slice(0, doubleColonIndex).split(':').filter(p => p !== '');
    const after = ip.slice(doubleColonIndex + 2).split(':').filter(p => p !== '');
    const missing = 8 - before.length - after.length;
    parts = [...before, ...Array(missing).fill('0'), ...after];
  }
  
  if (parts.length !== 8) return null;
  
  let result = 0n;
  for (const part of parts) {
    const num = parseInt(part || '0', 16);
    if (isNaN(num) || num < 0 || num > 0xFFFF) return null;
    result = (result << 16n) | BigInt(num);
  }
  return result;
}

/**
 * Check if an IP address is within a CIDR range
 * Supports both IPv4 and IPv6
 */
function isIPInCIDR(ip: string, cidr: string): boolean {
  const [rangeIP, prefixLenStr] = cidr.split('/');
  const prefixLen = parseInt(prefixLenStr, 10);
  
  // Determine IP version
  const isV6 = ip.includes(':');
  const isRangeV6 = rangeIP.includes(':');
  
  // Must be same IP version
  if (isV6 !== isRangeV6) return false;
  
  if (isV6) {
    const ipVal = ipv6ToBigInt(ip);
    const rangeVal = ipv6ToBigInt(rangeIP);
    if (ipVal === null || rangeVal === null) return false;
    if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 128) return false;
    
    const mask = prefixLen === 0 ? 0n : (~0n << BigInt(128 - prefixLen)) & ((1n << 128n) - 1n);
    return (ipVal & mask) === (rangeVal & mask);
  } else {
    const ipVal = ipv4ToBigInt(ip);
    const rangeVal = ipv4ToBigInt(rangeIP);
    if (ipVal === null || rangeVal === null) return false;
    if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;
    
    const mask = prefixLen === 0 ? 0n : (~0n << BigInt(32 - prefixLen)) & 0xFFFFFFFFn;
    return (ipVal & mask) === (rangeVal & mask);
  }
}

/**
 * Check if an IP address is on campus (matches any configured CIDR range)
 */
function isOnCampus(ip: string, rangesConfig: string): boolean {
  if (!rangesConfig || !ip) return false;
  
  const ranges = rangesConfig.split(',').map(r => r.trim()).filter(r => r);
  return ranges.some(range => isIPInCIDR(ip, range));
}

/**
 * Get the client IP for authorization decisions (Campus Pass eligibility).
 *
 * Trusts ONLY `CF-Connecting-IP` (set by Cloudflare, which strips client
 * attempts to forge it). Returns null when absent, so callers fail closed.
 *
 * Local dev (no Cloudflare edge, no CF-Connecting-IP): set DEV_LOOPBACK_AUTH="true"
 * in .dev.vars to fall back to 127.0.0.1. Never set in production — doing so
 * re-introduces the CWE-290 fail-open this function exists to prevent.
 *
 * See issue #52: getClientIP()'s softer chain (X-Forwarded-For → 127.0.0.1)
 * is spoofable and must not gate authorization, only rate-limit accounting.
 */
export function getAuthIP(request: Request, env: Bindings): string | null {
  const cfIP = request.headers.get('CF-Connecting-IP');
  if (cfIP) return cfIP;
  if (env.DEV_LOOPBACK_AUTH === 'true') return '127.0.0.1';
  return null;
}

/**
 * Best-effort client IP for non-auth purposes (rate-limit bucketing, error
 * context). NOT for authorization — the X-Forwarded-For fallback is
 * client-spoofable. For auth decisions, use getAuthIP().
 *
 * In production behind Cloudflare, CF-Connecting-IP is always present, so the
 * softer fallbacks are never reached — but correct-by-construction means we
 * don't rely on that ambient property for access control.
 */
export function getClientIP(request: Request): string {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || '127.0.0.1';
}

/**
 * Check if request qualifies for Campus Pass (keyless on-campus access).
 *
 * Uses getAuthIP() — trusts only CF-Connecting-IP, fails closed when absent.
 * Never consults X-Forwarded-For for the authorization decision.
 */
export function isCampusPassEligible(request: Request, env: Bindings): boolean {
  if (!env.CAMPUS_IP_RANGES || !env.CAMPUS_POOL_KEY) return false;
  const ip = getAuthIP(request, env);
  if (ip === null) return false;
  return isOnCampus(ip, env.CAMPUS_IP_RANGES);
}

/**
 * Bucket an IP address into a stable key for per-client rate limiting.
 *
 * IPv4: returned verbatim (one bucket per address).
 * IPv6: aggregated to /64 (the standard end-site allocation), so a single
 * device's randomized addresses within its /64 share one bucket. The bucket
 * key is the first four hextets joined with ":" (e.g. "2607:f5f0:0:0").
 *
 * Returns the input unchanged for malformed IPs; the caller is responsible
 * for not feeding garbage in.
 */
export function bucketKey(ip: string): string {
  if (!ip.includes(':')) {
    // IPv4: per address
    return ip;
  }
  // IPv6: expand and take the first 4 hextets (/64).
  const doubleColonIndex = ip.indexOf('::');
  let parts: string[];
  if (doubleColonIndex !== -1) {
    const before = ip.slice(0, doubleColonIndex).split(':').filter(p => p !== '');
    const after = ip.slice(doubleColonIndex + 2).split(':').filter(p => p !== '');
    const missing = 8 - before.length - after.length;
    parts = [...before, ...Array(missing).fill('0'), ...after];
  } else {
    parts = ip.split(':');
  }
  if (parts.length < 4) return ip;
  // Normalize each hextet by parsing and lower-casing for stable keying.
  const prefix = parts.slice(0, 4).map(p => parseInt(p || '0', 16).toString(16));
  return prefix.join(':');
}
