import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';
import LightningFS from '@isomorphic-git/lightning-fs';
import { Workspace, reviewMessages } from './workspace.js';
import { apiOrigin, authorize, callback, infer, json } from './auth.js';
import { renderReview, reviewPlaceholder } from './review-view.js';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './style.css';

const $ = id => document.getElementById(id);
const ACTIVE = 'bayleaf-checkpoint-workspace';
let workspace, auth = null, entries = [], selected = null, busy = false;
let draftEditor, policyEditor, saveTimer, queue = Promise.resolve();
let generation = 0, savedGeneration = 0;
let reviewController;
let activeReviewId = null;
let navigating = false;
const say = text => { $('notice').textContent = text; };
const report = error => say(error?.message || 'Something went wrong. Your checkpoint history has not been rewritten.');
function serial(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
function updateControls() {
  for (const id of ['checkpoint', 'import', 'export', 'connect', 'recommend']) $(id).disabled = busy;
  $('model').disabled = !!auth || busy;
  $('recommend').disabled = !!auth || busy;
  $('api-origin').disabled = !!auth || busy;
  $('connect').hidden = !!auth;
  $('disconnect').hidden = !auth;
  $('connection').textContent = auth
    ? `Connected until ${new Date(auth.expiresAt).toLocaleTimeString()}. Model: ${auth.model}. Uses your BayLeaf allowance.`
    : 'Not connected. Writing and checkpoints never need the network.';
  $('critic-state').textContent = auth ? 'on' : 'off';
  $('critic-state').classList.toggle('on', !!auth);
  $('checkpoint-hint').textContent = auth
    ? 'Records this draft and policy as a version, then asks your critic to read it.'
    : 'Records this draft and policy as a version. Connect a critic to ask for feedback too.';
}
async function flush() {
  clearTimeout(saveTimer);
  const currentGeneration = generation;
  const draft = draftEditor.getMarkdown(), policy = policyEditor.getMarkdown();
  return serial(async () => {
    await workspace.write('draft.md', draft);
    await workspace.write('review-policy.md', policy);
    await workspace.sync();
    savedGeneration = currentGeneration;
    $('save-status').textContent = generation === savedGeneration ? 'Saved locally' : 'Saving…';
  });
}
function changed() {
  generation++;
  $('save-status').textContent = 'Unsaved changes';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush().catch(error => { $('save-status').textContent = 'Save failed: export a copy'; report(error); }), 600);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function textSection(title, text) {
  const details = element('details');
  details.append(element('summary', title), element('pre', text));
  return details;
}
async function refreshHistory() {
  entries = await workspace.history();
  $('history-count').textContent = String(entries.length);
  $('history').replaceChildren();
  for (const entry of entries) {
    const button = element('button');
    const when = new Date(entry.commit.author.timestamp * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    button.append(element('strong', entry.commit.message.trim()), element('span', when, 'when'), element('code', entry.oid.slice(0, 7)));
    button.setAttribute('aria-current', String(entry.oid === selected));
    button.onclick = () => inspect(entry.oid).catch(report);
    $('history').append(button);
  }
}
async function inspect(oid) {
  selected = oid;
  const entry = entries.find(item => item.oid === oid);
  const snapshot = await workspace.snapshot(oid);
  const records = await workspace.reviews(oid);
  // Ignore a slower read if the user selected another checkpoint meanwhile.
  if (selected !== oid) return;
  for (const button of $('history').children) button.setAttribute('aria-current', String(button.textContent.includes(oid.slice(0, 7))));
  const panel = $('inspection');
  panel.replaceChildren(element('h3', entry.commit.message.trim()), element('p', oid, 'oid'));
  const controls = element('div', undefined, 'actions');
  const review = element('button', records.length ? 'Review again' : 'Request feedback');
  review.disabled = busy || !auth;
  review.onclick = () => runReview(oid).catch(report);
  const restore = element('button', 'Copy this draft into editor');
  restore.disabled = busy;
  restore.onclick = async () => {
    try {
      if (!confirm('Replace the current working draft with this version? The feedback policy stays unchanged. Export first if you want a separate copy of uncheckpointed work.')) return;
      draftEditor.editor.action(replaceAll(snapshot['draft.md']));
      changed(); await flush();
      say('Earlier draft copied into the editor. Existing checkpoints and your current policy are unchanged.');
    } catch (error) { report(error); }
  };
  controls.append(review, restore); panel.append(controls);
  for (const record of records.toReversed()) {
    const card = element('section', undefined, 'review');
    const incoming = record.status === 'pending' && record.id === activeReviewId;
    card.setAttribute('aria-busy', String(incoming));
    card.append(element('h4', record.status === 'complete' || incoming ? 'Feedback' : record.status === 'pending' ? 'Review unfinished' : 'Review failed'),
      element('p', `${record.model} · ${new Date(record.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`));
    if (incoming) card.append(reviewPlaceholder());
    else if (record.status === 'complete' && record.response) {
      const body = element('div', undefined, 'review-body');
      body.innerHTML = renderReview(record.response);
      card.append(body);
    } else card.append(element('pre', record.error || 'This tab closed before the review finished. Reconnect and retry if needed.'));
    const remove = element('button', 'Delete review');
    remove.className = 'delete-review';
    // Wait for in-flight writes so deletion cannot race review completion or import.
    remove.disabled = busy;
    remove.onclick = async () => {
      if (busy || !confirm('Delete this review from this browser workspace? The checkpoint and draft will stay. Exported copies are unchanged.')) return;
      busy = true; updateControls();
      remove.disabled = true;
      try {
        await serial(async () => {
          const existing = await workspace.reviews(oid);
          await workspace.saveReviews(oid, existing.filter(item => item.id !== record.id));
        });
        say('Review deleted. The checkpoint, draft, and policy are unchanged.');
      } catch (error) { report(error); }
      finally {
        busy = false; updateControls();
        if (selected) await inspect(selected).catch(report);
      }
    };
    card.append(remove);
    panel.append(card);
  }
  panel.append(textSection('Draft at this checkpoint', snapshot['draft.md']), textSection('Policy at this checkpoint', snapshot['review-policy.md']));
  if (entry.commit.parent[0]) {
    const previous = await workspace.snapshot(entry.commit.parent[0]);
    if (selected === oid) panel.append(textSection('Previous draft for comparison', previous['draft.md']));
  }
}
async function runReview(oid) {
  if (busy) return;
  if (!auth || auth.expiresAt <= Date.now()) { auth = null; updateControls(); throw new Error('Connect BayLeaf to request feedback.'); }
  busy = true; updateControls();
  const connection = auth; // Bind this request to its approved model and origin.
  let record;
  try {
    const entry = entries.find(item => item.oid === oid);
    const current = await workspace.snapshot(oid);
    const previous = entry.commit.parent[0] ? await workspace.snapshot(entry.commit.parent[0]) : null;
    const messages = reviewMessages(current, previous, entry.commit.message.trim());
    record = { id: crypto.randomUUID(), oid, status: 'pending', model: connection.model, apiOrigin: connection.origin,
      createdAt: new Date().toISOString(), messages };
    activeReviewId = record.id;
    await serial(async () => workspace.saveReviews(oid, [...await workspace.reviews(oid), record]));
    await inspect(oid);
    say('Checkpoint saved. Asking your critic… You can keep writing.');
    reviewController = new AbortController();
    const timeout = setTimeout(() => reviewController?.abort(), 120000);
    try {
      record.response = await infer(connection, messages, reviewController.signal);
      record.status = 'complete';
    } finally { clearTimeout(timeout); }
    say('Feedback attached to its checkpoint. Your current draft was not changed.');
  } catch (error) {
    if (record) {
      record.status = 'error';
      record.error = error.name === 'AbortError' ? 'Review cancelled or timed out. You can retry.' : error.message;
    }
    if (/Authorization expired/.test(error.message)) auth = null;
    report(error);
  } finally {
    reviewController = null;
    activeReviewId = null;
    try {
      if (record) await serial(async () => {
        const records = await workspace.reviews(oid);
        await workspace.saveReviews(oid, records.map(item => item.id === record.id ? record : item));
      });
    } finally {
      busy = false; updateControls();
      if (selected) await inspect(selected);
    }
  }
}

async function start() {
  let name = localStorage.getItem(ACTIVE);
  if (!name) { name = `checkpoint-${crypto.randomUUID()}`; localStorage.setItem(ACTIVE, name); }
  workspace = new Workspace(new LightningFS(name));
  await workspace.init();
  const features = { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false };
  draftEditor = new Crepe({ root: $('editor'), defaultValue: await workspace.read('draft.md'), features });
  policyEditor = new Crepe({ root: $('policy-editor'), defaultValue: await workspace.read('review-policy.md'), features });
  draftEditor.on(listener => listener.markdownUpdated(changed));
  policyEditor.on(listener => listener.markdownUpdated(changed));
  await draftEditor.create(); await policyEditor.create();
  await flush();
  say('Your workspace lives in this browser. Export a copy to keep it safe.');
  await refreshHistory();
  if (entries.length) await inspect(entries[0].oid);
  try {
    auth = await callback();
    if (auth) { $('model').value = auth.model; $('api-origin').value = auth.origin; say('BayLeaf connected. Your writing remains local until you request feedback.'); }
  } catch (error) { report(error); }
  updateControls();
  if (selected) await inspect(selected);

  for (const [id, policy] of [['draft-tab', false], ['policy-tab', true]]) $(id).onclick = () => {
    $('editor').hidden = policy; $('policy-editor').hidden = !policy;
    $('draft-tab').setAttribute('aria-pressed', String(!policy)); $('policy-tab').setAttribute('aria-pressed', String(policy));
    $('editor-help').textContent = policy ? 'Instructions your critic reads at each checkpoint. Decide what it attends to, what it asks, and where it stops.' : 'Autosaves to this browser. Saving never asks for feedback.';
  };
  $('checkpoint').onclick = async () => {
    if (busy) return;
    busy = true; updateControls();
    let oid;
    try {
      await flush();
      oid = await serial(() => workspace.commit($('checkpoint-note').value.trim()));
      $('checkpoint-note').value = '';
      selected = oid; await refreshHistory();
      say('Checkpoint saved locally. Connect BayLeaf when you want feedback.');
    } catch (error) { report(error); }
    finally { busy = false; updateControls(); }
    if (oid) {
      if (auth) await runReview(oid).catch(report);
      else await inspect(oid).catch(report);
    }
  };
  $('recommend').onclick = async () => {
    try {
      const result = await json(apiOrigin($('api-origin').value) + '/recommended-model');
      $('model').value = /^(openrouter|vertex|bedrock):/.test(result.model) ? result.model : `openrouter:${result.model}`;
    } catch (error) { report(error); }
  };
  $('connect').onclick = async () => {
    if (busy) return;
    busy = true; updateControls();
    try {
      await flush(); navigating = true;
      await authorize(apiOrigin($('api-origin').value), $('model').value.trim());
    }
    catch (error) { navigating = false; report(error); busy = false; updateControls(); }
  };
  $('disconnect').onclick = () => {
    auth = null; reviewController?.abort(); updateControls();
    if (selected) inspect(selected).catch(report);
    say('Token forgotten by this tab. Revoke it on the BayLeaf dashboard to invalidate other copies.');
  };
  $('persist').onclick = async () => {
    try {
      const granted = await navigator.storage?.persist?.();
      say(granted ? 'Persistent storage granted. Export is still your backup against site-data clearing or device loss.' : 'This browser did not grant persistent storage. Export regularly.');
    } catch (error) { report(error); }
  };
  $('export').onclick = async () => {
    if (busy) return;
    busy = true; updateControls();
    try {
      await flush();
      const archive = await serial(() => workspace.export());
      const blob = new Blob([JSON.stringify(archive)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = element('a'); link.href = url; link.download = `checkpoint-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      say('Workspace exported, including uncheckpointed work, Git history, and reviews. No inference credential is included.');
    } catch (error) { report(error); }
    finally { busy = false; updateControls(); }
  };
  $('import').onclick = () => $('import-file').click();
  $('import-file').onchange = async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file || busy) return;
    busy = true; updateControls();
    draftEditor.setReadonly(true); policyEditor.setReadonly(true);
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error('Import exceeds the 40 MB prototype limit.');
      await flush();
      const archive = JSON.parse(await file.text());
      const nextName = `checkpoint-${crypto.randomUUID()}`;
      const imported = new Workspace(new LightningFS(nextName));
      await imported.import(archive);
      localStorage.setItem(ACTIVE, nextName);
      savedGeneration = generation;
      navigating = true;
      location.replace(location.pathname);
    } catch (error) {
      report(error); busy = false; updateControls();
      draftEditor.setReadonly(false); policyEditor.setReadonly(false);
    }
  };
  window.addEventListener('beforeunload', event => {
    if (!navigating && (generation !== savedGeneration || busy)) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && generation !== savedGeneration) flush().catch(report); });
  document.addEventListener('click', event => {
    for (const menu of document.querySelectorAll('details.menu[open]')) if (!menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    for (const menu of document.querySelectorAll('details.menu[open]')) { menu.open = false; menu.querySelector('summary').focus(); }
  });
  $('app').hidden = false;
}

// One writer across all workspace tabs, including during archive switches.
if (!navigator.locks) {
  say('This prototype needs Web Locks: use a current browser on localhost or HTTPS.');
} else {
  navigator.locks.request('bayleaf-checkpoint-writer', { ifAvailable: true }, async lock => {
    if (!lock) { say('This workspace is open in another tab. Close that tab and reload here to avoid conflicting saves.'); return; }
    try { await start(); }
    catch (error) { report(error); }
    await new Promise(() => {});
  }).catch(report);
}
