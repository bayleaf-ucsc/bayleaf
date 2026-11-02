// Interface state: the shared cells (credential, agent, composer), status line, frame and action sheets.

import { createSettings } from '../settings.ts';
import { createLocalImages } from '../attachments.ts';
import * as store from '../store.ts';
import { DEFAULTS, Vfs } from '../vfs.ts';
import defaults from '../defaults.ts';
import { $, el } from '../dom.ts';
import { createLayout } from '../layout.ts';
import { createLedger, createUsage, renderMeter } from '../usage.ts';
import { createFollow } from '../follow.ts';
import { dismissible, guardDialog } from '../dismiss.ts';
import type { App } from './app.ts';
import type { PouchAgent } from '../agent.ts';
import type { Composer } from '../composer.ts';
import type { Settings } from '../settings.ts';
import type { LocalImages } from '../attachments.ts';
import type { Layout } from '../layout.ts';
import type { Ledger } from '../usage.ts';
import type { Follow } from '../follow.ts';

// One button of an action sheet: label, what it does, optional class; falsy entries are skipped.
export type SheetAction = [label: string, run: () => unknown, cls?: string];
export type SheetBody = string | Node | null | undefined;

export interface StateRegion {
  get agent(): PouchAgent | null; set agent(v: PouchAgent | null);
  get composer(): Composer | null; set composer(v: Composer | null);
  follow: Follow;
  // sk-bayleaf-... or null for Campus Pass.
  get key(): string | null; set key(v: string | null);
  layout: Layout;
  ledger: ReturnType<typeof createLedger>;
  localImages: LocalImages;
  meter(): Promise<ReturnType<typeof renderMeter>>;
  settings: Settings;
  sheet(title: string, actions: (SheetAction | false | null | undefined | '')[], body?: SheetBody): void;
  status(text: string, cls?: string): void;
  STEER_LABEL: string;
  usage: ReturnType<typeof createUsage>;
  // The user's own writes, attributed 'user'.
  userFs: ReturnType<Vfs['as']>;
  vfs: Vfs;
}

export function createStateRegion(app: App): StateRegion {
  const settings = createSettings();

  Object.assign(DEFAULTS, defaults);
  const vfs = new Vfs();
  // The user's own writes (editor, uploads, drops, unpack, rename, delete):
  // attributed 'user', so file watches can tell them from the agent's (src/ns/watch.ts).
  const userFs = vfs.as('user');
  const localImages = createLocalImages(vfs);

  let key: string | null = null;        // sk-bayleaf-... or null for Campus Pass
  let agent: PouchAgent | null = null;      // from openAgent, or null if it could not open
  // How a message read mid-turn is labeled, in main's transcript and a subagent's (D25).
  const STEER_LABEL = 'You, while it worked';
  let composer: Composer | null = null;   // composer.ts: tray, autocomplete, shield popover (set below)

  function status(text: string, cls = '') { $('status').textContent = text; $('status').className = cls; }

  // ── Frame: sidebar, rail and panels (layout.ts) ─────────────────────
  const usage = createUsage({ getKey: () => key });
  // Every Sealed request of the allowance day, by session (usage.ts); the day is
  // the allowance's own (it ends at resetsAt).
  const ledger = createLedger({ get: () => store.getSetting<Ledger>('requestLedger'), set: async (v) => { await store.setSetting('requestLedger', v); } },
    () => usage.state.resetsAt?.toISOString() ?? null);
  // The allowance badge, its tooltip split into this browser's count and the allowance.
  const meter = async () => renderMeter(usage.state, await ledger.snapshot().catch(() => null));
  // Follow new content only while following (src/follow.ts, README "Scrolling").
  const follow = createFollow($('log'));
  // Deferred: the layout restores a remembered panel while the Interface's regions
  // are still being created (src/main.ts), so app.meters and the rest exist only later
  // (test/boot-browser.mjs).
  const layout = createLayout({ onPanel: (p) => { if (p === 'usage') queueMicrotask(() => app.meters.renderUsagePanel()); if (p === 'trust') queueMicrotask(() => { app.install.renderCopy(); app.tree.renderNamespaces(); }); if (p === 'terminal' && !matchMedia('(pointer: coarse)').matches) queueMicrotask(() => $('term-input').focus()); } });

  // ── Action sheet: one tap-friendly menu for every "..." button ──────
  // `body` (text or a node) explains the choice, above the buttons.
  function sheet(title: string, actions: (SheetAction | false | null | undefined | '')[], body?: SheetBody) {
    $('sheet-title').textContent = title;
    $('sheet-body').replaceChildren(...(body == null ? [] : [typeof body === 'string' ? el('p', { textContent: body }) : body]));
    $('sheet-body').hidden = body == null;
    // A tree row that opened the sheet may be rebuilt meanwhile: return focus to its successor.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    $<HTMLDialogElement>('sheet').addEventListener('close', () => {
      if (opener && !opener.isConnected && (opener.dataset?.path || opener.classList?.contains('more'))) app.tree.treeRows().find((r) => r.dataset.path === app.tree.focusPath)?.focus();
    }, { once: true });
    $('sheet-actions').replaceChildren(...actions.flatMap((a) => (a ? [a] : [])).map(([label, fn, cls]) => {
      const b = el('button', { type: 'button', textContent: label, className: cls ?? '' });
      b.onclick = async () => { $<HTMLDialogElement>('sheet').close(); try { await fn(); } catch (e) { app.tree.fail(e instanceof Error ? e.message : String(e)); } };
      return b;
    }), el('button', { type: 'button', textContent: 'Cancel', onclick: () => $<HTMLDialogElement>('sheet').close() }));
    // A field typed into and then dismissed comes back as it was (src/dismiss.ts).
    const kept = sheetDrafts.get(title);
    sheetDrafts.delete(title);
    if (kept) [...$('sheet-body').querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].forEach((f, i) => { if (kept[i] != null) f.value = kept[i]; });
    $<HTMLDialogElement>('sheet').querySelector(':scope > .keep-note')?.remove();
    $<HTMLDialogElement>('sheet').showModal();
  }
  const sheetDrafts = new Map(); // sheet title -> the values of its fields when it was dismissed
  // Every dialog, popover, menu and drawer dismisses by one rule (src/dismiss.ts).
  guardDialog($<HTMLDialogElement>('sheet')); guardDialog($<HTMLDialogElement>('claim')); guardDialog($<HTMLDialogElement>('egress'));
  dismissible({ layer: 3, isOpen: () => $<HTMLDialogElement>('sheet').open, inside: () => [$<HTMLDialogElement>('sheet')],
    keep: () => $<HTMLDialogElement>('sheet').dataset.busy ?? null,
    close: () => {
      const v = [...$('sheet-body').querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].map((f) => f.value);
      if (v.some((x) => x.trim())) sheetDrafts.set($('sheet-title').textContent, v);
      $<HTMLDialogElement>('sheet').close();
    } });
  // Waiting for approval in another tab: dismissing is Cancel (start again any time).
  dismissible({ layer: 3, isOpen: () => $<HTMLDialogElement>('claim').open, inside: () => [$<HTMLDialogElement>('claim')], close: () => $('claim-cancel').click() });
  // A request waiting to leave: dismissing answers Deny, the answer that sends nothing.
  dismissible({ layer: 3, isOpen: () => $<HTMLDialogElement>('egress').open, inside: () => [$<HTMLDialogElement>('egress')], close: () => $('egress-deny').click() });

  return {
    get agent() { return agent; }, set agent(v) { agent = v; },
    get composer() { return composer; }, set composer(v) { composer = v; },
    follow,
    get key() { return key; }, set key(v) { key = v; },
    layout,
    ledger,
    localImages,
    meter,
    settings,
    sheet,
    status,
    STEER_LABEL,
    usage,
    userFs,
    vfs,
  };
}
