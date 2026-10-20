import { campusAddressStatus } from '../../api/src/utils/ipRanges.js';

// Stored browser records are versioned independently of the unchanged v1 client
// payload and service records. This dimension was approved on 2026-10-20.
export const BROWSER_SCHEMA_VERSION = 2;
export const BROWSER_POLICY_VERSION = 3;
export const NETWORK_LOCATIONS = Object.freeze(['campus-network', 'other-network', 'unknown']);

export function browserNetworkLocation(request) {
  // Only the Cloudflare edge header is authoritative on this public Worker.
  // Never consult XFF, Forwarded, client JSON, or the API's dev-loopback fallback.
  const status = campusAddressStatus(request.headers.get('CF-Connecting-IP'));
  return status === null ? 'unknown' : status ? 'campus-network' : 'other-network';
}
