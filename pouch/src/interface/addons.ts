// Settings > Add-ons: one row per add-on (src/addons.ts), the same service as
// the `addons` command. A row says what it is, what uses it, its size and its
// state (or "not available here" with the reason) and offers Install, Stop and
// Remove; model rows also install from a saved folder or picked files, checked
// like any install. Make available offline installs everything this device
// can run (one sheet for the asked ones); the footer shows the site's storage.

import * as store from '../store.ts';
import { $, el } from '../dom.ts';
import { LFM3 } from '../addons-registry.ts';
import { sizeText } from '../addons.ts';
import { stateText, usedByText } from '../addons-cli.ts';
import type { AddonStatus } from '../addons.ts';
import type { App } from './app.ts';

export interface AddonsRegion {
  // A one-line notice kept above the storage footer until the page reloads.
  notice(line: string): void;
  render(): Promise<void>;
  // Coalesced: install progress calls this many times a second.
  renderSoon(): void;
}

export function createAddonsRegion(app: App): AddonsRegion {
  const you = { by: 'user' as const, via: 'Settings' };
  const fieldOf = (e: unknown, k: string) => String(typeof e === 'object' && e !== null ? Reflect.get(e, k) ?? '' : k === 'message' ? e : '');
  let picking: string | null = null; // the model row whose folder or files are being picked
  let noticeLine = '';

  async function install(id: string) {
    // LFM3 through the provider: it installs, then starts the model on the GPU.
    if (id === LFM3) { await app.providers.ensureLocal(); return render(); }
    try {
      const r = await app.sessionList.addons.install(id, you);
      render();
      if (!r.already) { await r.promise; app.state.status(`Installed ${app.sessionList.addons.get(id).label}.`); }
    } catch (e) {
      const code = fieldOf(e, 'code'), stop = fieldOf(e, 'name') === 'AbortError';
      app.state.status(code === 'EDENIED' ? 'Nothing was installed.' : stop ? 'Install stopped; Install resumes where it stopped.' : fieldOf(e, 'message'), code === 'EDENIED' || stop ? '' : 'bad');
    }
    render();
  }
  // Stop is the install's /task ctl, as `echo stop > /task/<id>/ctl` in the terminal.
  function stop(s: AddonStatus) {
    if (s.task?.status === 'running') app.namespaces.ctl(`/task/${s.task.id}/ctl`, 'stop').catch((e: Error) => app.state.status(e.message, 'bad'));
  }
  async function remove(s: AddonStatus) {
    if (s.id === LFM3 && app.providers.localRuns.size) return app.state.status('Stop the Transformers.js turn before removing LFM3.', 'bad');
    if (!(await app.tree.ask(`Remove ${s.label} from this browser? Sessions and files stay. Installing it again takes ${sizeText(s.size)}.`, 'Remove', 'danger', `Remove ${s.label}?`))) return;
    const r = await app.sessionList.addons.remove(s.id, you); // the same service as `addons remove`
    if (s.id === LFM3 && app.providers.localPicked()) {
      $<HTMLSelectElement>('model').value = (await store.getSetting('sealedModel')) ?? app.connection.models[0]?.id ?? '';
      await store.setSetting('model', $<HTMLSelectElement>('model').value); app.providers.pickerProvider(); app.queues.updateSend();
    }
    const est = await navigator.storage?.estimate?.().catch(() => null);
    app.state.status(`${s.label} removed${r.freed ? ` (${sizeText(r.freed)} freed)` : ''}.${est?.usage != null ? ` This site now uses ${sizeText(est.usage)} of storage.` : ''}`);
    render();
  }

  // el() assigns properties; dataset is read-only, so its entries are set on it.
  const data = <T extends HTMLElement>(n: T, d: Record<string, string>) => { Object.assign(n.dataset, d); return n; };
  function row(s: AddonStatus) {
    const busy = s.state === 'installing', can = s.state !== 'not available here';
    const btn = (text: string, act: string, on: () => unknown, cls = '') => data(el('button', { type: 'button', textContent: text, className: cls, onclick: on }), { act });
    const progress = el('progress', { hidden: !busy, max: s.size || 1, value: s.task?.progress?.done ?? s.bytes });
    return data(el('li', { className: 'addon' },
      el('div', { className: 'addon-head' }, el('strong', { textContent: s.kind === 'model' && s.provider ? `${s.label} (for ${s.provider})` : s.label }),
        el('span', { className: 'muted', textContent: ` ${sizeText(s.size)}, used by ${usedByText(s)}` })),
      el('p', { className: 'addon-state muted', textContent: busy && s.task ? `Installing as /task/${s.task.id}: ${sizeText(s.task.progress?.done ?? s.bytes)} of ${sizeText(s.size)}. Every file is checked against this page's hashes.` : stateText(s) }),
      progress,
      el('p', { className: 'local-actions' },
        ...(can && !s.installed && !busy ? [btn(s.bytes ? 'Resume install' : 'Install', 'install', () => install(s.id))] : []),
        ...(busy ? [btn('Stop', 'stop', () => stop(s))] : []),
        ...(s.kind === 'model' && can && !s.installed && !busy ? [btn('Install from folder', 'folder', () => { picking = s.id; $('addon-folder').click(); }),
          btn('Install from files', 'files', () => { picking = s.id; $('addon-files').click(); })] : []),
        ...(s.bytes && !busy ? [btn('Remove', 'remove', () => remove(s), 'danger')] : []))), { addon: s.id, state: s.state });
  }

  let rendering: Promise<void> | null = null, again = false;
  async function render(): Promise<void> {
    if (rendering) { again = true; return rendering; }
    rendering = (async () => {
      const list = $('addons-rows');
      if (!list) return;
      const rows = await app.sessionList.addons.list();
      list.replaceChildren(...(rows.length ? rows.map(row) : [el('li', { className: 'muted', textContent: 'This build of Pouch carries no add-ons.' })]));
      const missing = rows.filter((s) => !s.installed && s.state !== 'not available here');
      const offline = $<HTMLButtonElement>('addons-offline');
      offline.hidden = !missing.length;
      offline.textContent = `Make available offline (${sizeText(missing.reduce((n, s) => n + s.size - s.bytes, 0))})`;
      const stale = await app.sessionList.addons.sweep({ dry: true }).catch(() => null), sweepBtn = $<HTMLButtonElement>('addons-sweep');
      sweepBtn.hidden = !stale?.bytes;
      if (stale?.bytes) sweepBtn.textContent = `Free ${sizeText(stale.bytes)} from older versions`;
      const est = await navigator.storage?.estimate?.().catch(() => null);
      $('addons-storage').textContent = (noticeLine ? noticeLine + ' ' : '') + (est?.usage != null ? `This site uses ${sizeText(est.usage)} of storage${est.quota ? ` (the browser allows about ${sizeText(est.quota)})` : ''}. Erase all removes every add-on.` : 'Erase all removes every add-on.');
    })().finally(() => { rendering = null; if (again) { again = false; render(); } });
    return rendering;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const renderSoon = () => { if (!timer) timer = setTimeout(() => { timer = null; render(); }, 250); };

  $('addons-offline').onclick = async () => {
    try {
      const r = await app.sessionList.addons.installAll(you);
      render();
      app.state.status(r.started.length ? `Installing ${r.started.length} add-on${r.started.length > 1 ? 's' : ''}; progress in Settings > Add-ons and /task.${r.denied.length ? ` Not installed: ${r.denied.join(', ')}.` : ''}` : r.denied.length ? 'Nothing was installed.' : 'Every add-on this device can run is installed.');
      await Promise.allSettled(r.started.map((t) => t.promise));
    } catch (e) { app.state.status(fieldOf(e, 'message'), 'bad'); }
    render();
  };
  // Parts and files only older builds named (src/addons.ts sweep); boot runs it too.
  $('addons-sweep').onclick = async () => {
    const r = await app.sessionList.addons.sweep().catch((e: Error) => { app.state.status(e.message, 'bad'); return null; });
    if (r) app.state.status(r.skipped ? 'An install is running; try again when it ends.' : `Freed ${sizeText(r.bytes)} from older versions of add-ons.`);
    render();
  };
  for (const id of ['addon-folder', 'addon-files']) {
    $(id).onchange = async () => {
      const files = $<HTMLInputElement>(id).files, which = picking ?? LFM3; // a pick without a row: the model
      if (!files?.length || !which) return;
      app.state.status('Checking the picked files against this page\'s hashes...');
      try {
        const r = await app.sessionList.addons.importFiles(which, files);
        $<HTMLInputElement>(id).value = '';
        app.state.status(r.status.installed ? `${r.status.label} installed from your files (${r.added} files checked${r.refused.length ? `, refused: ${r.refused.join(', ')}` : ''}).`
          : `${r.added} files checked${r.refused.length ? `, refused (wrong bytes): ${r.refused.join(', ')}` : ''}; ${sizeText(r.status.size - r.status.bytes)} still missing.`, r.refused.length ? 'bad' : '');
      } catch (e) { app.state.status(fieldOf(e, 'message'), 'bad'); }
      render();
    };
  }

  return { notice: (line) => { noticeLine = line; app.state.status(line); render(); }, render, renderSoon };
}
