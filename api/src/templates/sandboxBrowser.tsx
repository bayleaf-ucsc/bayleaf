import type { FC } from 'hono/jsx';
import { css } from 'hono/css';
import { btnStyle } from './layout';

const controlsStyle = css`
  [hidden] { display: none !important; }
  summary { cursor: pointer; color: #006aad; }
  .browser-secondary { background: transparent; border: 1px solid #767676;
    border-radius: 4px; padding: 0.45rem 0.7rem; font: inherit; cursor: pointer; }
  .browser-actions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .browser-note { color: #555; font-size: 0.9rem; }
  .browser-status-box { display: flex; align-items: center; gap: 0.75rem;
    background: #f0f6f2; border: 1px solid #b7cebe; border-radius: 6px;
    padding: 0.65rem 0.85rem; margin: 0 0 1rem; }
  .browser-status-box p { margin: 0; flex: 1; font-size: 0.9rem; }
  .browser-refresh { display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; flex-shrink: 0; background: transparent;
    border: none; border-radius: 4px; color: #365a43; cursor: pointer; }
  .browser-refresh:hover { background: #dcebe1; }
`;

/** Progressive enhancement: the rest of the sandbox/API card remains usable. */
export const SandboxBrowserControls: FC = () => <section class={controlsStyle} id="sandbox" aria-label="Browser access">
  <div class="browser-status-box">
    <p id="browser-status" role="status" aria-live="polite">Checking status…</p>
    <button type="button" class="browser-refresh" id="browser-refresh" aria-label="Refresh status" title="Refresh status">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17" />
      </svg>
    </button>
  </div>
  <div class="browser-actions">
    <button type="button" class={btnStyle} id="browser-start" hidden>Set up sandbox</button>
    <a class={btnStyle} id="browser-open" hidden target="_blank" rel="noopener noreferrer">Open sandbox</a>
    <span class="browser-note" id="browser-deadline"></span>
    <button type="button" class="browser-secondary" id="browser-continue" hidden>Extend 6 hours</button>
  </div>
  <p id="browser-intro" class="browser-note" hidden>Opens OpenChamber with BayLeaf and your files. First setup takes a few minutes.</p>
  <details style="margin-top:1rem"><summary>Browser options &amp; help</summary>
    <div class="browser-actions" style="margin-top:0.75rem">
      <button type="button" class="browser-secondary" id="browser-restart" hidden>Restart interface</button>
      <button type="button" class="browser-secondary" id="browser-stop" hidden>End browser work</button>
    </div>
    <p class="browser-note">Browser access lasts six hours. You can extend it during the last hour.
      Idle sleep may happen sooner. Files and history persist; running tasks stop when the sandbox sleeps.</p>
    <p class="browser-note">This is the same sandbox used by Chat and the API. Setup stores your BayLeaf key inside it,
      where programs you run can access it. Use Chat or the file API to export files and history.</p>
  </details>
  <noscript>Enable JavaScript for browser setup, or use the ordinary-key /sandbox/browser API.</noscript>
  <script dangerouslySetInnerHTML={{ __html: `(() => {
    const el = id => document.getElementById('browser-' + id);
    const labels = { locating_sandbox:'Locating your sandbox', creating_sandbox:'Creating your sandbox',
      starting_sandbox:'Starting or restoring your sandbox', preparing_setup:'Preparing browser setup',
      checking:'Checking the managed installation', installing:'Installing pinned browser tools',
      configuring:'Configuring BayLeaf', starting:'Starting OpenChamber', ready:'Ready' };
    const errors = { node_22_required:'Your sandbox’s software needs an update. Contact BayLeaf support.',
      insufficient_disk:'Your sandbox needs more free storage. Free up space or contact BayLeaf support.', requires_2_gib:'Your sandbox needs more memory. Contact BayLeaf support to upgrade it and keep your files.',
      public_sandbox:'Your sandbox’s privacy settings need attention. Contact BayLeaf support.',
      port_in_use:'The browser interface could not restart. Try again, or contact BayLeaf support.',
      credential_changed:'Your BayLeaf key changed. Resume to refresh browser configuration.',
      setup_interrupted:'Setup was interrupted. Resume to retry.', setup_timeout:'Setup timed out. Resume to retry.',
      installation_failed:'Setup could not finish. Try again, or contact BayLeaf support.',
      provider_configuration_unavailable:'Could not connect your sandbox to BayLeaf. Try again.',
      application_not_ready:'The browser interface did not start. Try again, or contact BayLeaf support.',
      personal_key_required:'Create your personal BayLeaf key first.', sandbox_missing:'The shared sandbox is missing. Resume to locate or create it.' };
    let timer, deadline, busy = false, ready = false, requestVersion = 0;
    function render(s) {
      clearTimeout(timer);
      deadline = s.deadline > Math.floor(Date.now()/1000) ? s.deadline : null;
      ready = s.phase === 'ready' && !!s.url;
      const opening = s.phase === 'opening';
      el('status').textContent = s.error ? (errors[s.error] || 'Could not open your sandbox. Try again, or contact BayLeaf support.')
        : opening ? (labels[s.progress] || 'Preparing your sandbox') + '…'
        : ready ? 'Ready'
        : s.phase === 'expired' ? 'Browser access ended. Your files are saved.'
        : s.machine === 'absent' ? 'Ready to set up.'
        : 'Your sandbox is ' + (s.machine || 'not open') + '.';
      el('start').hidden = ready || opening;
      el('start').textContent = s.phase === 'failed' ? 'Retry setup' : s.machine === 'absent' ? 'Set up sandbox' : 'Resume sandbox';
      el('intro').hidden = s.machine !== 'absent';
      el('open').hidden = !ready;
      if (ready) el('open').href = s.url; else el('open').removeAttribute('href');
      el('restart').hidden = !ready;
      el('stop').hidden = !(ready || opening);
      if (opening) timer = setTimeout(refresh, 5000);
      countdown();
    }
    function countdown() {
      const remaining = deadline ? Math.max(0, deadline - Math.floor(Date.now()/1000)) : 0;
      const minutes = Math.ceil(remaining/60);
      el('deadline').textContent = ready && remaining ? (minutes >= 60 ? Math.floor(minutes/60) + 'h ' + minutes%60 + 'm' : minutes + 'm') + ' remaining' : '';
      el('continue').hidden = !ready || !remaining || remaining > 3600;
      if (deadline && remaining === 0) { deadline = null; refresh(); }
    }
    async function refresh() {
      const version = ++requestVersion;
      try { const r = await fetch('/sandbox/browser/status', { cache:'no-store' }); const result = await r.json();
        if (version === requestVersion) render(result); }
      catch { if (version === requestVersion) el('status').textContent = 'Could not check status. Try refreshing.'; }
    }
    async function action(name) {
      if (busy) return;
      if (name === 'stop' && !confirm('End browser work and stop its managed tasks? Shared sandbox files are preserved.')) return;
      busy = true;
      ++requestVersion;
      clearTimeout(timer);
      document.querySelectorAll('#sandbox button').forEach(b => b.disabled = true);
      try {
        const r = await fetch('/sandbox/browser/' + name, { method:'POST', headers:{ 'X-BayLeaf-Action':'sandbox-browser' } });
        const result = await r.json();
        if (!r.ok) render(result); else await refresh();
      } catch { el('status').textContent = 'Could not submit the action. Refresh status before retrying.'; }
      finally { busy=false; document.querySelectorAll('#sandbox button').forEach(b => b.disabled = false); }
    }
    ['start','continue','restart','stop'].forEach(name => el(name).addEventListener('click', () => action(name)));
    el('refresh').addEventListener('click', refresh);
    window.addEventListener('focus', () => { if (!busy) refresh(); });
    setInterval(countdown, 30000);
    refresh();
  })();` }} />
</section>;
