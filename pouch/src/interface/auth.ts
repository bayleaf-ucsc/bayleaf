// Credential: device claim, the key form and Erase everything.

import * as store from '../store.ts';
import { $, el } from '../dom.ts';
import { extractKey } from '../usage.ts';
import { claimInitiate, claimPoll, usageOf } from '../bayleaf-api.ts';
import { engine as localEngine } from '../local/engine.ts';
import type { App } from './app.ts';
import type { Allowance } from '../usage.ts';
import type { ClaimPollReply, ClaimStart } from '../trust.ts';

export interface AuthRegion {
  // The status line while not signed in: what Campus Pass can do from here.
  campusLine(st: Allowance): string;
  eraseAll(): Promise<void>;
  renderAuth(): void;
}

export function createAuthRegion(app: App): AuthRegion {
  // ── Device claim (RFC 8628 shape). One poll loop, its own controller. ─
  async function claim() {
    const r = await claimInitiate();
    if (!r.ok) return app.state.status('Could not start sign-in (HTTP ' + r.status + ').', 'bad');
    const c = await r.json() as ClaimStart;
    $('claim-code').textContent = c.user_code;
    $('claim-url').textContent = c.claim_url;
    $('claim-state').textContent = 'Waiting for approval...'; $('claim-state').className = 'pending';
    $<HTMLDialogElement>('claim').showModal();
    window.open(c.claim_url, '_blank', 'noopener');
    const stop = new AbortController();
    $('claim-cancel').onclick = () => { stop.abort(); $<HTMLDialogElement>('claim').close(); };
    const deadline = Date.now() + c.expires_in * 1000;
    while (!stop.signal.aborted && Date.now() < deadline) {
      await new Promise<void>((res) => setTimeout(res, (c.poll_interval || 3) * 1000));
      if (stop.signal.aborted) return;
      let p;
      try { p = await claimPoll(c.device_code, stop.signal); }
      catch { continue; } // transient network error: keep polling
      if (p.status === 202) continue;
      const body: ClaimPollReply = await p.json().catch(() => ({}));
      if (p.status === 200 && body.key) {
        // The poll is one-shot: the server deletes the claim as it answers.
        $<HTMLDialogElement>('claim').close(); await useKey(body.key);
        return;
      }
      $('claim-state').textContent = body.status === 'denied' ? 'Denied.' : 'This code expired. Close and try again.';
      $('claim-state').className = 'bad';
      return;
    }
  }
  function renderAuth() {
    const b = $('auth');
    b.ariaLabel = app.state.key ? 'Forget key' : 'Sign in';
    b.title = app.state.key ? 'Signed in with your BayLeaf key. Click to forget it in this browser.' : 'Sign in (without a key, Campus Pass works on the UCSC network)';
    b.classList.toggle('on', !!app.state.key);
  }
  // Not signed in: what Campus Pass can do from here (the check says whether
  // this network is on campus; unknown until it answers).
  function campusLine(st: Allowance) {
    if (st.mode === 'campus' && st.offCampus) return 'Not signed in, and this network is off campus, where Campus Pass does not work: sign in to send.';
    if (st.mode === 'campus' && st.remaining != null) return `Not signed in: using Campus Pass on this campus network (about ${st.remaining} of ${st.limit} shared requests left today).`;
    return 'Not signed in: using Campus Pass, which works only on the UCSC network.';
  }
  async function useKey(k: string) {
    app.state.key = k; await store.setSetting('key', app.state.key); renderAuth(); app.state.usage.refresh(); await app.connection.connect();
  }
  // BayLeaf's verdict on a key before it is kept: true, or the reason it is not.
  async function checkKey(k: string) {
    try {
      const r = await usageOf(k);
      if (r.status === 401 || r.status === 403) return `BayLeaf rejected this key (HTTP ${r.status}): it may be mistyped, revoked or expired. Get a new one at api.bayleaf.dev.`;
      return true; // other failures are not about the key: keep it, as before
    } catch { return true; } // offline: keep it; requests will say if it is wrong
  }
  // The sign-in sheet's inline key field (no native prompt): paste, Save, and an
  // inline reason when the key is refused.
  function keyForm() {
    const input = el('input', { type: 'password', id: 'key-input', className: 'key-input', placeholder: 'sk-bayleaf-...', autocomplete: 'off', spellcheck: false });
    const why = el('p', { id: 'key-why', className: 'key-why', role: 'status' });
    const save = el('button', { type: 'submit', className: 'primary', textContent: 'Save key' });
    const form = el('form', { className: 'key-form' },
      el('label', { htmlFor: 'key-input', textContent: 'Paste a key you already have (kept only in this browser), or approve below' }), el('div', { className: 'key-row' }, input, save), why);
    input.onpaste = (e) => { const k = extractKey(e.clipboardData?.getData('text')); if (k) { e.preventDefault(); input.value = k; why.textContent = ''; } };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const k = extractKey(input.value);
      if (!k) { why.textContent = input.value.trim() ? 'That does not contain an sk-bayleaf- key: it starts with sk-bayleaf- followed by letters, digits, - or _.' : 'Paste your key first.'; why.className = 'key-why bad'; input.focus(); return; }
      save.disabled = true; why.className = 'key-why'; why.textContent = 'Checking the key with BayLeaf...';
      // A check in flight keeps the sheet open (src/dismiss.ts): it would sign in after it closed.
      $('sheet').dataset.busy = 'Checking the key with BayLeaf: this closes by itself once it answers.';
      const ok = await checkKey(k).finally(() => delete $('sheet').dataset.busy);
      if (ok !== true) { why.textContent = ok; why.className = 'key-why bad'; save.disabled = false; input.focus(); return; }
      $<HTMLDialogElement>('sheet').close(); await useKey(k);
    };
    return form;
  }
  $('auth').onclick = async () => {
    if (!app.state.key) { app.state.sheet('Sign in to BayLeaf', [['Approve on a device where you are signed in (recommended)', claim]], keyForm()); return; }
    if (!(await app.tree.ask('Remove your BayLeaf key from this browser? Files and sessions stay.', 'Remove key', 'danger'))) return;
    app.state.key = null; await store.setSetting('key', undefined); renderAuth(); app.state.usage.refresh(); app.connection.connect();
  };

  // ── Erase everything ────────────────────────────────────────────────
  async function eraseAll() {
    if (!(await app.tree.ask('Erase ALL Pouch data in this browser: files in /work, /pouch, sessions, your key and folder permissions? Folders you mounted from this device are not touched. This cannot be undone. (To keep /work, press Cancel, then Download all.)', 'Erase all', 'danger', 'Erase all?'))) return;
    app.state.status('Erasing...');
    try { await app.state.agent?.close(); } catch {}
    app.state.agent = null;
    await localEngine.dispose().catch(() => {});
    await app.install.shellCopy.uninstall({ remember: false }).catch(() => {}); // the next visit keeps a fresh copy
    await store.eraseEverything(); // includes the Local model's and the offline copy's Cache Storage
    location.hash = 'erased'; // the reloaded page says it worked (L1)
    location.reload();
  }
  $('erase').onclick = eraseAll;
  // Phones: the bottom bar has no room for Trust and Erase all, so More holds them.
  $('more').onclick = () => app.state.sheet('More', [
    ['Settings', () => app.state.layout.open('settings')],
    ['What can BayLeaf see?', () => app.state.layout.open('trust')],
    ['Download all of /work as .zip', () => $('download-all').click()],
    ['Erase all Pouch data in this browser', eraseAll, 'danger'],
  ]);

  return {
    campusLine,
    eraseAll,
    renderAuth,
  };
}
