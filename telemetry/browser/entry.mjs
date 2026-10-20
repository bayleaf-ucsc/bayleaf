import { createArrivalClient } from '../adapters/browser.mjs';

const ORIGINS = Object.freeze({ landing: 'https://bayleaf.dev', api: 'https://api.bayleaf.dev',
  sandbox: 'https://sandbox.bayleaf.dev' });

/** Server/render gating is authoritative. This exact-origin/root guard is an
 * additional backstop, not a way to infer authentication in a shared shell. */
export function publicArrival(destination, enabled = false) {
  try {
    if (enabled !== true || !Object.hasOwn(ORIGINS, destination)
      || globalThis.location?.origin !== ORIGINS[destination]
      || globalThis.location?.pathname !== '/') return;
    createArrivalClient({ enabled: true, destination,
      endpoint: 'https://telemetry.bayleaf.dev/v1/browser', deadline_ms: 1000 })();
  } catch { /* Page functionality is independent of telemetry. */ }
}
