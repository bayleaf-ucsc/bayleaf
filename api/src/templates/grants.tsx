import type { FC } from 'hono/jsx';
import { cardStyle } from './layout';

/** Recognition metadata is rendered; issued credentials stay in a JS closure. */
export const TemporaryInferenceTokens: FC<{ model: string; maxSeconds: number }> = ({ model, maxSeconds }) => (
  <section id="temporary-inference-tokens" class={cardStyle}>
    <style>{`
      #temporary-inference-tokens { overflow-wrap: anywhere; }
      #temporary-inference-tokens label { display: block; margin-top: .8rem; font-weight: 600; }
      #temporary-inference-tokens input, #temporary-inference-tokens select { width: 100%; padding: .55rem; font: inherit; border: 1px solid #767676; border-radius: 4px; background: white; color: inherit; }
      #temporary-inference-tokens button { margin: .5rem .5rem .5rem 0; padding: .55rem .8rem; font: inherit; cursor: pointer; border: 1px solid #003c6c; border-radius: 4px; background: #003c6c; color: white; }
      #temporary-inference-tokens button:disabled { opacity: .6; cursor: default; }
      #grant-list { list-style: none; padding: 0; }
      #grant-list li { border-top: 1px solid #767676; padding: .5rem 0; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
      #grant-list .grant-identity { display: inline-flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; flex: 1; }
      #grant-list time { color: #555; font-size: .85rem; white-space: nowrap; }
      #grant-list .grant-actions { display: inline-flex; gap: .35rem; }
      #grant-list button { font-size: .85rem; padding: .35rem .5rem; margin: 0; }
    `}</style>
    <h2>Temporary inference tokens</h2>
    <p>For scripts and apps using one standard-inference model. Each token draws
      on your existing allowance and expires automatically. Its name is safe to
      share; its full credential is available only through Copy token.</p>
    <details>
      <summary>Create a token</summary>
      <form id="grant-form">
        <label for="grant-model">Model</label>
        <select id="grant-model" required disabled data-recommended={model}>
          <option value="">Loading model catalog…</option>
        </select>
        <p id="grant-model-status" role="status"></p>
        <label for="grant-seconds">Lifetime in seconds (maximum {maxSeconds})</label>
        <input id="grant-seconds" type="number" min="1" max={maxSeconds} value={Math.min(3600, maxSeconds)} required/>
        <button id="create-grant" type="submit" disabled>Create token</button>
      </form>
    </details>
    <p id="grant-status" role="status"></p>
    <ul id="grant-list" aria-label="Your temporary inference tokens"></ul>
    <p><small>Copy is available for tokens created in this page until you reload.
      You can revoke any listed token, including tokens authorized for apps.</small></p>
    <script dangerouslySetInnerHTML={{ __html: `
(() => {
  const status = document.getElementById('grant-status');
  const credentials = new Map();
  const modelSelect = document.getElementById('grant-model');
  const createButton = document.getElementById('create-grant');
  let expiryTimer;
  async function request(path, init) {
    const response = await fetch(path, init); const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'Request failed'); return body;
  }
  async function loadModels() {
    const { models, backends } = await request('/grants/models');
    modelSelect.replaceChildren();
    const recommended = modelSelect.dataset.recommended;
    const qualifiedRecommended = recommended.startsWith('openrouter:') || backends.some(b => recommended.startsWith(b.id + ':'))
      ? recommended : 'openrouter:' + recommended;
    for (const backend of backends) {
      const group = document.createElement('optgroup'); group.label = backend.label;
      if (!backend.enabled || !backend.available) {
        const unavailable = document.createElement('option'); unavailable.disabled = true; unavailable.value = '';
        unavailable.textContent = backend.label + (backend.enabled ? ' (catalog unavailable)' : ' (disabled)'); group.append(unavailable);
      } else {
        for (const model of models.filter(m => m.id.startsWith(backend.id + ':'))) {
          const option = document.createElement('option'); option.value = model.id;
          option.textContent = model.id + (model.id === qualifiedRecommended ? ' (recommended)' : '');
          group.append(option);
        }
      }
      modelSelect.append(group);
    }
    const ids = models.map(m => m.id);
    modelSelect.value = ids.includes(qualifiedRecommended) ? qualifiedRecommended : ids[0] || '';
    modelSelect.disabled = !ids.length; createButton.disabled = !ids.length;
    document.getElementById('grant-model-status').textContent = ids.length
      ? 'All listed models from enabled standard-inference backends. Sealed is separate.' : 'No model catalog is available. Reload to retry.';
  }
  async function refresh() {
    const { grants } = await request('/grants');
    clearTimeout(expiryTimer);
    if (grants.length) expiryTimer = setTimeout(() => refresh().catch(e => { status.textContent = e.message; }),
      Math.min(2147483647, Math.max(1000, Math.min(...grants.map(g => g.expires_at)) * 1000 - Date.now() + 100)));
    const list = document.getElementById('grant-list'); list.replaceChildren();
    for (const id of credentials.keys()) if (!grants.some(g => g.id === id)) credentials.delete(id);
    if (!grants.length) { const item = document.createElement('li'); item.textContent = 'No active temporary inference tokens.'; list.append(item); }
    for (const grant of grants) {
      const name = grant.name || 'Earlier token ' + grant.id.slice(0, 8);
      const item = document.createElement('li');
      const identity = document.createElement('span'); identity.className = 'grant-identity';
      const title = document.createElement('strong'); title.textContent = name; title.tabIndex = 0;
      const details = 'Standard inference only. Model: ' + grant.model + '. ' +
        (grant.redirect_uri ? (grant.client_name || 'App') + ' · ' + new URL(grant.redirect_uri).origin : 'Created directly.') +
        ' Expires ' + new Date(grant.expires_at * 1000).toLocaleString();
      title.title = details; title.setAttribute('aria-label', name + '. ' + details);
      identity.append(title);
      const expiry = document.createElement('time'); expiry.dateTime = new Date(grant.expires_at * 1000).toISOString();
      expiry.textContent = 'until ' + new Date(grant.expires_at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      expiry.title = new Date(grant.expires_at * 1000).toLocaleString(); identity.append(expiry); item.append(identity);
      const actions = document.createElement('span'); actions.className = 'grant-actions';
      if (credentials.has(grant.id)) {
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy token'; copy.setAttribute('aria-label', 'Copy token ' + name);
        copy.onclick = async () => {
          try {
            if (grant.expires_at * 1000 <= Date.now()) { credentials.delete(grant.id); await refresh(); status.textContent = name + ': token expired.'; return; }
            const credential = credentials.get(grant.id); if (!credential) return;
            await navigator.clipboard.writeText(credential); status.textContent = name + ': token copied.';
          } catch { status.textContent = 'Clipboard unavailable. The credential has not been displayed.'; }
        }; actions.append(copy);
      }
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = 'Revoke token'; revoke.setAttribute('aria-label', 'Revoke token ' + name);
      revoke.onclick = async () => {
        try { await request('/grants/' + grant.id, { method: 'DELETE' }); credentials.delete(grant.id); await refresh(); status.textContent = name + ': token revoked.'; }
        catch (e) { status.textContent = e.message; }
      }; actions.append(revoke); item.append(actions); list.append(item);
    }
  }
  document.getElementById('grant-form').onsubmit = async event => {
    event.preventDefault(); const button = document.getElementById('create-grant'); button.disabled = true;
    try {
      const result = await request('/grants', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: document.getElementById('grant-model').value, expires_in: Number(document.getElementById('grant-seconds').value) }) });
      credentials.set(result.grant_id, result.access_token);
      status.textContent = result.name + ': token created.'; await refresh();
    } catch (e) { status.textContent = e.message; }
    finally { button.disabled = false; }
  };
  refresh().catch(e => { status.textContent = e.message; });
  loadModels().catch(() => { document.getElementById('grant-model-status').textContent = 'Could not load models. Reload to retry.'; });
})();
` }}/>
  </section>
);
