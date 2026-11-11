import type { FC } from 'hono/jsx';
import { cardStyle } from './layout';
import { describeSeconds, GRANT_SCOPES, SANDBOX_APPS_ROOT } from '../grants';

/** App tokens. Recognition metadata is rendered; issued credentials stay in a JS closure. */
export const TemporaryInferenceTokens: FC<{ model: string; maxSeconds: number; inboxesEnabled?: boolean }> = ({ model, maxSeconds, inboxesEnabled = false }) => (
  <section id="temporary-inference-tokens" class={cardStyle}>
    <style>{`
      #temporary-inference-tokens { overflow-wrap: anywhere; }
      #temporary-inference-tokens label { display: block; margin-top: .8rem; font-weight: 600; }
      #temporary-inference-tokens input, #temporary-inference-tokens select { width: 100%; padding: .55rem; font: inherit; border: 1px solid #767676; border-radius: 4px; background: white; color: inherit; }
      #temporary-inference-tokens fieldset { margin-top: .8rem; border: 1px solid #767676; border-radius: 4px; }
      #temporary-inference-tokens legend { font-weight: 600; }
      #temporary-inference-tokens fieldset label { font-weight: normal; margin-top: .35rem; }
      #temporary-inference-tokens input[type=checkbox] { width: auto; margin-right: .4rem; }
      #grant-model-group[hidden], #grant-inbox-group[hidden], #grant-sandbox-group[hidden] { display: none; }
      #temporary-inference-tokens button { margin: .5rem .5rem .5rem 0; padding: .55rem .8rem; font: inherit; cursor: pointer; border: 1px solid #003c6c; border-radius: 4px; background: #003c6c; color: white; }
      #temporary-inference-tokens button:disabled { opacity: .6; cursor: default; }
      #grant-list { list-style: none; padding: 0; }
      #grant-list li { border-top: 1px solid #767676; padding: .5rem 0; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
      #grant-list .grant-identity { display: inline-flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; flex: 1; }
      #grant-list time { color: #555; font-size: .85rem; white-space: nowrap; }
      #grant-list .grant-actions { display: inline-flex; gap: .35rem; }
      #grant-list button { font-size: .85rem; padding: .35rem .5rem; margin: 0; }
    `}</style>
    <h2>App tokens</h2>
    <p>For scripts and apps, limited to the scopes you choose and, for inference, up to
      16 standard-inference models. Inference draws on your existing allowance; every
      token expires automatically. Its name is safe to
      share; its full credential is available only through Copy token.</p>
    <details>
      <summary>Create a token</summary>
      <form id="grant-form">
        <fieldset id="grant-scopes">
          <legend>Scopes (select at least one)</legend>
          {Object.entries(GRANT_SCOPES).filter(([scope]) => inboxesEnabled || !scope.startsWith('inboxes.')).map(([scope, description]) => (
            <label><input type="checkbox" name="scope" value={scope} checked={scope === 'inference.chat'}/>{description} (<code>{scope}</code>)</label>
          ))}
        </fieldset>
        <div id="grant-model-group">
          <label for="grant-model">Models for inference scopes (select 1–16)</label>
          <select id="grant-model" multiple size={8} required disabled data-recommended={model} aria-describedby="grant-model-status">
            <option value="">Loading model catalog…</option>
          </select>
          <p id="grant-model-status" role="status"></p>
        </div>
        {inboxesEnabled && <fieldset id="grant-inbox-group" hidden aria-describedby="grant-inbox-status">
          <legend>Inboxes for inbox scopes (select 1–16)</legend>
          <div id="grant-inbox-choices"></div>
          <p id="grant-inbox-status" role="status"></p>
        </fieldset>}
        <div id="grant-sandbox-group" hidden>
          <label for="grant-sandbox-dirs">Sandbox folders for sandbox file scopes (1–16 names, comma or space separated)</label>
          <input id="grant-sandbox-dirs" type="text" autocomplete="off" spellcheck={false} data-root={SANDBOX_APPS_ROOT} aria-describedby="grant-sandbox-status grant-sandbox-hint"/>
          <p id="grant-sandbox-status" role="status"></p>
          <p id="grant-sandbox-hint"><small>Each name uses lowercase letters, digits and hyphens, starts with a letter or digit, and has at most 63 characters.
            Using the token wakes your sandbox, creating one if you have none.</small></p>
        </div>
        <label for="grant-seconds">Lifetime in seconds (maximum {maxSeconds}, {describeSeconds(maxSeconds)})</label>
        <input id="grant-seconds" type="number" min="1" max={maxSeconds} value={Math.min(3600, maxSeconds)} required aria-describedby="grant-seconds-hint"/>
        <p id="grant-seconds-hint"><small>86400 is one day; 604800 is one week.</small></p>
        <button id="create-grant" type="submit" disabled>Create token</button>
      </form>
    </details>
    <p id="grant-status" role="status"></p>
    <ul id="grant-list" aria-label="Your app tokens"></ul>
    <p><small>Copy is available for tokens created in this page until you reload.
      You can revoke any listed token, including tokens authorized for apps.</small></p>
    <script dangerouslySetInnerHTML={{ __html: `
(() => {
  const status = document.getElementById('grant-status');
  const credentials = new Map();
  const modelSelect = document.getElementById('grant-model');
  const createButton = document.getElementById('create-grant');
  const modelGroup = document.getElementById('grant-model-group');
  const scopeBoxes = Array.from(document.querySelectorAll('#grant-scopes input[name=scope]'));
  const inboxGroup = document.getElementById('grant-inbox-group');
  const sandboxGroup = document.getElementById('grant-sandbox-group');
  const sandboxInput = document.getElementById('grant-sandbox-dirs');
  let catalogReady = false, inboxesState = 'unloaded', expiryTimer;
  const checkedScopes = () => scopeBoxes.filter(box => box.checked).map(box => box.value);
  const wantsModels = () => checkedScopes().some(scope => scope.startsWith('inference.'));
  const wantsInboxes = () => !!inboxGroup && checkedScopes().some(scope => scope.startsWith('inboxes.'));
  const wantsSandboxDirs = () => checkedScopes().some(scope => scope.startsWith('sandbox.files.'));
  // Folder names, never paths. No backslashes here: this script sits in a TS template literal.
  const validDir = dir => /^[a-z0-9][a-z0-9-]{0,62}$/.test(dir);
  const sandboxDirs = () => [...new Set(sandboxInput.value.split(/[, ]+/).filter(Boolean))];
  const sandboxDirsValid = dirs => dirs.length >= 1 && dirs.length <= 16 && dirs.every(validDir);
  function syncSandboxDirs() {
    const dirs = sandboxDirs(), invalid = dirs.filter(dir => !validDir(dir));
    sandboxInput.setAttribute('aria-invalid', String(dirs.length > 0 && !sandboxDirsValid(dirs)));
    document.getElementById('grant-sandbox-status').textContent = !dirs.length ? 'Enter at least one folder name.'
      : invalid.length ? 'Not a valid folder name: ' + invalid.join(', ') + '.'
      : dirs.length > 16 ? 'At most 16 folders.'
      : 'The app can reach ' + dirs.map(dir => sandboxInput.dataset.root + dir + '/').join(', ') + ' and everything below.';
  }
  const checkedInboxes = () => Array.from(document.querySelectorAll('#grant-inbox-choices input[name=inbox]:checked'), box => box.value);
  function syncScopes() {
    const inference = wantsModels(); modelGroup.hidden = !inference; modelSelect.required = inference;
    const inbox = wantsInboxes(); if (inboxGroup) inboxGroup.hidden = !inbox;
    if (inbox && inboxesState === 'unloaded') loadInboxes();
    const sandbox = wantsSandboxDirs(); sandboxGroup.hidden = !sandbox; sandboxInput.required = sandbox;
    if (sandbox) syncSandboxDirs();
    if (inboxesState === 'ready') document.getElementById('grant-inbox-status').textContent = 'Select 1–16 inboxes. ' + inboxEffect();
    createButton.disabled = (inference && !catalogReady) || (inbox && (inboxesState !== 'ready' || !checkedInboxes().length))
      || (sandbox && !sandboxDirsValid(sandboxDirs()));
  }
  // Manage does not imply read: say what each checked inbox scope reveals.
  const inboxEffect = () => checkedScopes().includes('inboxes.messages.read')
    ? 'The app can read everything a chosen inbox has stored or will receive.'
    : "The app can archive or unarchive messages whose handles it already knows, seeing each one's sender and subject (or HTTP method and path), never its body.";
  // A failed load waits for the user: only an explicit scope toggle retries it.
  for (const box of scopeBoxes) box.onchange = () => { if (inboxesState === 'failed') inboxesState = 'unloaded'; syncScopes(); };
  sandboxInput.oninput = syncScopes;
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
    catalogReady = ids.length > 0; modelSelect.disabled = !catalogReady; syncScopes();
    document.getElementById('grant-model-status').textContent = ids.length
      ? 'Select 1–16 models. Use Command or Control to select multiple entries. Sealed is separate.' : 'No model catalog is available. Reload to retry.';
  }
  async function loadInboxes() {
    inboxesState = 'loading'; const inboxStatus = document.getElementById('grant-inbox-status');
    inboxStatus.textContent = 'Loading your inboxes…';
    try {
      const { inboxes } = await request('/grants/inboxes');
      const choices = document.getElementById('grant-inbox-choices'); choices.replaceChildren();
      for (const inbox of inboxes) {
        const label = document.createElement('label'); const box = document.createElement('input');
        box.type = 'checkbox'; box.name = 'inbox'; box.value = inbox.id; box.onchange = syncScopes;
        const title = document.createElement('strong'); title.textContent = inbox.label || inbox.id;
        label.append(box, title);
        const where = inbox.address || inbox.url;
        if (where) { const code = document.createElement('code'); code.textContent = where; label.append(' ', code); }
        choices.append(label);
      }
      inboxesState = inboxes.length ? 'ready' : 'empty';
      if (!inboxes.length) inboxStatus.textContent = 'You have no active inboxes. Create one, or clear the inbox scopes to create a token.';
    } catch { inboxesState = 'failed'; inboxStatus.textContent = 'Could not load your inboxes. Toggle an inbox scope to retry.'; }
    syncScopes();
  }
  async function refresh() {
    const { grants } = await request('/grants');
    clearTimeout(expiryTimer);
    if (grants.length) expiryTimer = setTimeout(() => refresh().catch(e => { status.textContent = e.message; }),
      Math.min(2147483647, Math.max(1000, Math.min(...grants.map(g => g.expires_at)) * 1000 - Date.now() + 100)));
    const list = document.getElementById('grant-list'); list.replaceChildren();
    for (const id of credentials.keys()) if (!grants.some(g => g.id === id)) credentials.delete(id);
    if (!grants.length) { const item = document.createElement('li'); item.textContent = 'No active app tokens.'; list.append(item); }
    for (const grant of grants) {
      const name = grant.name || 'Earlier token ' + grant.id.slice(0, 8);
      const item = document.createElement('li');
      const identity = document.createElement('span'); identity.className = 'grant-identity';
      const title = document.createElement('strong'); title.textContent = name; title.tabIndex = 0;
      const models = grant.models?.length ? grant.models : grant.model ? [grant.model] : [];
      const details = 'Scopes: ' + (grant.scopes?.length ? grant.scopes.join(', ') : 'none listed') + '. ' +
        (models.length ? 'Models: ' + models.join(', ') + '. ' : '') +
        (grant.inboxes?.length ? 'Inboxes: ' + grant.inboxes.join(', ') + '. ' : '') +
        (grant.sandbox_dirs?.length ? 'Sandbox folders: ' + grant.sandbox_dirs.join(', ') + '. ' : '') +
        (grant.redirect_uri ? (grant.client_name || 'App') + ' · ' + new URL(grant.redirect_uri).origin : 'Created directly.') +
        ' Expires ' + new Date(grant.expires_at * 1000).toLocaleString();
      title.title = details; title.setAttribute('aria-label', name + '. ' + details);
      identity.append(title);
      const expiry = document.createElement('time'); expiry.dateTime = new Date(grant.expires_at * 1000).toISOString();
      const expiresAt = new Date(grant.expires_at * 1000);
      expiry.textContent = 'until ' + (expiresAt.toDateString() === new Date().toDateString()
        ? expiresAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : expiresAt.toLocaleDateString([], { month: 'short', day: 'numeric' }));
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
      const scopes = checkedScopes();
      if (!scopes.length) throw new Error('Select at least one scope.');
      const payload = { scopes, expires_in: Number(document.getElementById('grant-seconds').value) };
      if (wantsModels()) {
        const models = Array.from(modelSelect.selectedOptions, option => option.value).filter(Boolean);
        if (!models.length || models.length > 16) throw new Error('Select between 1 and 16 models.');
        payload.models = models;
      }
      if (wantsInboxes()) {
        const inboxes = checkedInboxes();
        if (!inboxes.length || inboxes.length > 16) throw new Error('Select between 1 and 16 inboxes.');
        payload.inboxes = inboxes;
      }
      if (wantsSandboxDirs()) {
        const dirs = sandboxDirs();
        if (!sandboxDirsValid(dirs)) throw new Error('Enter 1–16 valid sandbox folder names.');
        payload.sandbox_dirs = dirs;
      }
      const result = await request('/grants', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
      credentials.set(result.grant_id, result.access_token);
      status.textContent = result.name + ': token created.'; await refresh();
    } catch (e) { status.textContent = e.message; }
    finally { syncScopes(); }
  };
  syncScopes();
  refresh().catch(e => { status.textContent = e.message; });
  loadModels().catch(() => { document.getElementById('grant-model-status').textContent = 'Could not load models. Reload to retry.'; });
})();
` }}/>
  </section>
);
