/**
 * Network origin of a claim, for the approval page's phishing defence.
 *
 * The claim flow hands over the account's ordinary API key. Its documented
 * defence (two codes) stops someone who only *watches* the user code, but not
 * an attacker who *starts* the claim: they hold the device code and only need
 * the victim to approve a link they sent (RFC 8628 §5.4, "remote phishing").
 *
 * BayLeaf cannot tell a phished approval from a legitimate one on another
 * device (Pouch shows a QR code for phones; remote machines are common), so
 * this does not block anything. It compares where the claim started with
 * where it is being approved and, when they differ, makes the approver see it
 * and confirm it. Same IP or same autonomous system (one ISP or campus
 * network, which also covers IPv4/IPv6 on one machine) needs no extra step.
 *
 * Inputs are Cloudflare edge facts (CF-Connecting-IP, request.cf), never
 * client-supplied headers. An attacker on the same network as the victim
 * (for example the same campus NAT) is not distinguished; that residual risk
 * is documented in llms.txt.
 */

export interface NetworkOrigin {
  ip: string | null;
  country: string | null;
  asn: number | null;
  network: string | null;
}

export type OriginMatch = 'same-ip' | 'same-network' | 'different-network' | 'different-country' | 'unknown';

const NETWORK_MAX_LEN = 80;

/** Origin of the current request, from Cloudflare's edge only. */
export function originOf(request: Request): NetworkOrigin {
  const cf = (request as Request & { cf?: { asn?: unknown; asOrganization?: unknown; country?: unknown } }).cf;
  const asn = typeof cf?.asn === 'number' && Number.isInteger(cf.asn) && cf.asn > 0 ? cf.asn : null;
  const network = typeof cf?.asOrganization === 'string' && cf.asOrganization.trim()
    ? cf.asOrganization.trim().slice(0, NETWORK_MAX_LEN)
    : null;
  const headerCountry = request.headers.get('CF-IPCountry');
  const cfCountry = typeof cf?.country === 'string' ? cf.country : null;
  return {
    ip: request.headers.get('CF-Connecting-IP'),
    country: normalizeCountry(headerCountry ?? cfCountry),
    asn,
    network,
  };
}

/** Two-letter country code, or null for absent/unknown/Tor markers (XX, T1). */
export function normalizeCountry(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

/**
 * Compare where a claim started with where it is being approved.
 * Country is checked before network so a cross-border approval is never
 * softened by a shared global provider.
 */
export function compareOrigins(initiator: NetworkOrigin, approver: NetworkOrigin): OriginMatch {
  if (initiator.ip && approver.ip && initiator.ip === approver.ip) return 'same-ip';
  if (initiator.country && approver.country && initiator.country !== approver.country) return 'different-country';
  if (initiator.asn && approver.asn) {
    return initiator.asn === approver.asn ? 'same-network' : 'different-network';
  }
  return 'unknown';
}

/** Whether approving must carry an explicit "I started this" confirmation. */
export function needsOriginConfirmation(match: OriginMatch): boolean {
  return match !== 'same-ip' && match !== 'same-network';
}

/** "Comcast Cable in United States", "an unknown network in Canada", ... */
export function describeOrigin(origin: NetworkOrigin): string {
  const where = countryName(origin.country);
  const network = origin.network ?? 'an unknown network';
  return where ? `${network} in ${where}` : network;
}

function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
