// v0.12.3 loader addition. No telemetry client is loaded until resolved sign-out.
// __BAYLEAF_CHAT_CLIENT__ is replaced by the guarded image startup.
(() => {
  try {
    if (location.origin !== 'https://chat.bayleaf.dev' || location.pathname !== '/') return;
    const sessionMarked = () => Object.hasOwn(localStorage, 'token') || /(?:^|;\s*)token=/.test(document.cookie);
    if (sessionMarked()) return;
    let observer, timer, stopped = false;
    const stop = () => {
      stopped = true;
      observer?.disconnect();
      clearTimeout(timer);
      window.removeEventListener('pagehide', stop);
    };
    const check = () => {
      try {
        if (stopped) return;
        if (sessionMarked() || !['/', '/auth'].includes(location.pathname)) return stop();
        // This card is absent until both root session resolution and auth
        // OAuth callback resolution complete. MFA/pending/auto-login have no card.
        if (location.pathname !== '/auth' || !document.getElementById('auth-login-card')) return;
        stop();
        // No referrer, query, DOM text, token value or storage crosses this seam.
        let timely = true;
        const loadingDeadline = setTimeout(() => { timely = false; }, 1000);
        import('__BAYLEAF_CHAT_CLIENT__').then(client => {
          if (timely) client.resolvedChatArrival();
        }).catch(() => {}).finally(() => { timely = false; clearTimeout(loadingDeadline); });
      } catch { stop(); }
    };
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    timer = setTimeout(stop, 15000);
    window.addEventListener('pagehide', stop, { once: true });
    check();
  } catch { /* Telemetry is never required for sign-in. */ }
})();
