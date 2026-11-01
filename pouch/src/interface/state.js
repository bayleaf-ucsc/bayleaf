// Interface state: the shared cells (credential, client, agent, models, view), status line, frame and action sheets.

import { createSettings } from '../settings.js';
import { createLocalImages } from '../attachments.js';
import * as store from '../store.js';
import { DEFAULTS, Vfs } from '../vfs.js';
import defaults from '../defaults.js';
import { $, el } from '../dom.js';
import { createLayout } from '../layout.js';
import { createLedger, createUsage, renderMeter } from '../usage.js';
import { createFollow } from '../follow.js';
import { dismissible, guardDialog } from '../dismiss.js';

export function createStateRegion(app) {
  const settings = createSettings();

  Object.assign(DEFAULTS, defaults);
  const vfs = new Vfs();
  // The user's own writes (editor, uploads, drops, unpack, rename, delete):
  // attributed 'user', so file watches can tell them from the agent's (src/ns/watch.js).
  const userFs = vfs.as('user');
  const localImages = createLocalImages(vfs);

  let key = null;        // sk-bayleaf-... or null for Campus Pass
  let client = null;     // Sealed client (src/sealed.js), verified once per credential
  let verified = false;
  let agent = null;      // from openAgent, or null if it could not open
  let models = [];       // Sealed chat models with tool calling
  // How a message read mid-turn is labeled, in main's transcript and a subagent's (D25).
  const STEER_LABEL = 'You, while it worked';
  let view = null;       // last normalized view of the current session
  let composer = null;   // composer.js: tray, autocomplete, shield popover (set below)
  let unwatch = null;

  function status(text, cls = '') { $('status').textContent = text; $('status').className = cls; }

  // ── Frame: sidebar, rail and panels (layout.js) ─────────────────────
  const usage = createUsage({ getKey: () => key });
  // Every Sealed request of the allowance day, by session (usage.js); the day is
  // the allowance's own (it ends at resetsAt).
  const ledger = createLedger({ get: () => store.getSetting('requestLedger'), set: (v) => store.setSetting('requestLedger', v) },
    () => usage.state.resetsAt?.toISOString() ?? null);
  // The allowance badge, its tooltip split into this browser's count and the allowance.
  const meter = async () => renderMeter(usage.state, await ledger.snapshot().catch(() => null));
  // Follow new content only while following (src/follow.js, README "Scrolling").
  const follow = createFollow($('log'));
  // Deferred: the layout restores a remembered panel while the Interface's regions
  // are still being created (src/main.js), so app.meters and the rest exist only later
  // (test/boot-browser.mjs).
  const layout = createLayout({ onPanel: (p) => { if (p === 'usage') queueMicrotask(() => app.meters.renderUsagePanel()); if (p === 'trust') queueMicrotask(() => { app.install.renderCopy(); app.tree.renderNamespaces(); }); if (p === 'terminal' && !matchMedia('(pointer: coarse)').matches) queueMicrotask(() => $('term-input').focus()); } });

  // ── Action sheet: one tap-friendly menu for every "..." button ──────
  // `body` (text or a node) explains the choice, above the buttons.
  function sheet(title, actions, body) {
    $('sheet-title').textContent = title;
    $('sheet-body').replaceChildren(...(body == null ? [] : [typeof body === 'string' ? el('p', { textContent: body }) : body]));
    $('sheet-body').hidden = body == null;
    // A tree row that opened the sheet may be rebuilt meanwhile: return focus to its successor.
    const opener = document.activeElement;
    $('sheet').addEventListener('close', () => {
      if (opener && !opener.isConnected && (opener.dataset?.path || opener.classList?.contains('more'))) app.tree.treeRows().find((r) => r.dataset.path === app.tree.focusPath)?.focus();
    }, { once: true });
    $('sheet-actions').replaceChildren(...actions.filter(Boolean).map(([label, fn, cls]) => {
      const b = el('button', { type: 'button', textContent: label, className: cls ?? '' });
      b.onclick = async () => { $('sheet').close(); try { await fn(); } catch (e) { app.tree.fail(e.message); } };
      return b;
    }), el('button', { type: 'button', textContent: 'Cancel', onclick: () => $('sheet').close() }));
    // A field typed into and then dismissed comes back as it was (src/dismiss.js).
    const kept = sheetDrafts.get(title);
    sheetDrafts.delete(title);
    if (kept) [...$('sheet-body').querySelectorAll('input, textarea')].forEach((f, i) => { if (kept[i] != null) f.value = kept[i]; });
    $('sheet').querySelector(':scope > .keep-note')?.remove();
    $('sheet').showModal();
  }
  const sheetDrafts = new Map(); // sheet title -> the values of its fields when it was dismissed
  // Every dialog, popover, menu and drawer dismisses by one rule (src/dismiss.js).
  guardDialog($('sheet')); guardDialog($('claim')); guardDialog($('egress'));
  dismissible({ layer: 3, isOpen: () => $('sheet').open, inside: () => [$('sheet')],
    keep: () => $('sheet').dataset.busy ?? null,
    close: () => {
      const v = [...$('sheet-body').querySelectorAll('input, textarea')].map((f) => f.value);
      if (v.some((x) => x.trim())) sheetDrafts.set($('sheet-title').textContent, v);
      $('sheet').close();
    } });
  // Waiting for approval in another tab: dismissing is Cancel (start again any time).
  dismissible({ layer: 3, isOpen: () => $('claim').open, inside: () => [$('claim')], close: () => $('claim-cancel').click() });
  // A request waiting to leave: dismissing answers Deny, the answer that sends nothing.
  dismissible({ layer: 3, isOpen: () => $('egress').open, inside: () => [$('egress')], close: () => $('egress-deny').click() });

  return {
    get agent() { return agent; }, set agent(v) { agent = v; },
    get client() { return client; }, set client(v) { client = v; },
    get composer() { return composer; }, set composer(v) { composer = v; },
    follow,
    get key() { return key; }, set key(v) { key = v; },
    layout,
    ledger,
    localImages,
    meter,
    get models() { return models; }, set models(v) { models = v; },
    settings,
    sheet,
    status,
    STEER_LABEL,
    get unwatch() { return unwatch; }, set unwatch(v) { unwatch = v; },
    usage,
    userFs,
    get verified() { return verified; }, set verified(v) { verified = v; },
    vfs,
    get view() { return view; }, set view(v) { view = v; },
  };
}
