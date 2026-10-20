import { deliver } from './common.mjs';

export const DESTINATIONS = Object.freeze(['landing', 'chat', 'api', 'sandbox']);
const BAYLEAF_HOSTS = new Set(['bayleaf.dev', 'chat.bayleaf.dev', 'api.bayleaf.dev', 'sandbox.bayleaf.dev']);

/** Only a hostname survives, never credentials, port, path, query or fragment. */
export function referrerHostname(referrer) {
  try {
    if (typeof referrer !== 'string' || referrer.length > 8192) return null;
    const url = new URL(referrer);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // IPs, local names, known individualized BayLeaf preview origins, and common
    // opaque identifier labels are excluded at source, not hashed into linkage.
    if (host.length > 253 || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
      || (host.endsWith('.bayleaf.dev') && !BAYLEAF_HOSTS.has(host))) return null;
    const labels = host.split('.');
    if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
      || label.length > 48 || /^[0-9a-f]{16,}$/i.test(label)
      || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(label))) return null;
    return host;
  } catch { return null; }
}

export function browserArrival({ destination, referrer = '' } = {}) {
  if (!DESTINATIONS.includes(destination)) return null;
  return { schema_version: 1, destination, referring_hostname: referrerHostname(referrer) };
}

/** Call once at initial document arrival, not on SPA navigation or user actions.
 * No timers/listeners/storage are installed. Disabled unless explicitly enabled.
 */
export function createArrivalClient(config = {}) {
  let attempted = false;
  return function arrival() {
    try {
      if (config.enabled !== true || attempted) return;
      attempted = true;
      const referrer = config.readReferrer ? config.readReferrer() : globalThis.document?.referrer;
      void deliver(browserArrival({ destination: config.destination, referrer }), '/v1/browser', config).catch(() => {});
    } catch { /* Telemetry must never prevent the page from loading. */ }
  };
}
