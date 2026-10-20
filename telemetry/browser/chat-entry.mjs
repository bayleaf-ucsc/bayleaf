import { createArrivalClient } from '../adapters/browser.mjs';

function signedOutCard() {
  try {
    return location.origin === 'https://chat.bayleaf.dev' && location.pathname === '/auth'
      && !Object.hasOwn(localStorage, 'token') && !/(?:^|;\s*)token=/.test(document.cookie)
      && !!document.getElementById('auth-login-card');
  } catch { return false; }
}
const arrival = createArrivalClient({ enabled: true, destination: 'chat', readReferrer: () => '',
  endpoint: 'https://telemetry.bayleaf.dev/v1/browser', deadline_ms: 1000,
  fetcher: (url, options) => signedOutCard() ? fetch(url, options) : Promise.resolve(new Response(null, { status: 204 })) });

// Chat is intentionally not admitted by publicArrival's generic root helper.
// Recheck after dynamic import AND immediately before fetch: login may have
// completed in the meantime. Module-scoped once-only state is document-local.
export function resolvedChatArrival() {
  if (signedOutCard()) arrival();
}
