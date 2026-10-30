// The composer card, after OpenChamber's: an activity tray above the input,
// autocomplete for @ paths, $ skills and / commands in the input, and the
// shield popover (this session's lane and egress grants). main.js owns
// sending and run bookkeeping and supplies what is active; this module owns
// how the card shows it. Nodes only, never HTML strings.
//
// deps: {
//   vfs, input,
//   roots() -> top-level folders to index for @ (/work, /pouch, /tmp, mounts),
//   skills() -> Promise<[{ name, description, path, requests? }]>,
//   commands: [{ name, hint, run(arg) }],
//   activity() -> [{ key, kind, text, title?, origin, since?, stop?(), open?() }],
//   stopAll() (main too), turnSpend() -> requests this turn or null, mainBusy(), shield() -> Promise<{ lane, detail, grants: [{ label, revoke() }], trust() }>,
//   onTray(), called after the tray changes height,
// }
import { $, el, icon, seeded } from './dom.js';

const PATH_CAP = 3000; // entries indexed for @; a huge mounted folder stops here
const SKIP = new Set(['node_modules', '.git']);
const SHOWN = 8;

// "12s", "35m 41s", "6h 56m": the tray's elapsed column.
export function elapsed(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m ${t % 60}s`;
  return `${Math.floor(t / 3600)}h ${Math.floor((t % 3600) / 60)}m`;
}

// Subsequence match: contiguous runs and basename hits score higher, then
// shorter paths. null when q is not a subsequence of s.
export function fuzzy(q, s) {
  if (!q) return -s.length;
  const a = s.toLowerCase(), b = q.toLowerCase(), base = a.lastIndexOf('/', a.length - 2) + 1;
  let i = 0, score = 0, run = 0;
  for (let j = 0; j < a.length && i < b.length; j++) {
    if (a[j] !== b[i]) { run = 0; continue; }
    run++; score += run * 2 + (j >= base ? 3 : 0) + (j === base || a[j - 1] === '/' ? 4 : 0);
    i++;
  }
  return i < b.length ? null : score - s.length * 0.05;
}

export function createComposer(deps) {
  const { input } = deps;

  // ── Activity tray ─────────────────────────────────────────────────
  const tray = $('tray'), list = $('tray-list'), toggle = $('tray-toggle'), stopAll = $('tray-stop-all');
  let collapsed = false, timer = 0;
  const tick = () => { for (const t of list.querySelectorAll('[data-since]')) t.textContent = elapsed(Date.now() - Number(t.dataset.since)); };
  function renderTray() {
    const rows = deps.activity();
    const wasHidden = tray.hidden, oldH = tray.offsetHeight;
    tray.hidden = !rows.length;
    const counts = {};
    for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    const running = (counts.subagent ?? 0) + (counts.run ?? 0);
    const n = deps.turnSpend?.();
    const parts = [running ? `Running ${running}${n ? ` · ${n} request${n === 1 ? '' : 's'} this turn` : ''}` : null, counts.approval ? `Waiting for you: ${counts.approval}` : null, counts.steer ? `Steering: ${counts.steer}` : null, counts.queued ? `Queued: ${counts.queued}` : null, counts.cap ? `Message limit: ${counts.cap}` : null, counts.watch ? `Watching: ${counts.watch}` : null].filter(Boolean);
    $('tray-count').textContent = parts.join(' · ');
    // Main working counts too: Stop all stops main as well.
    stopAll.hidden = rows.filter((r) => r.stop && (r.kind === 'subagent' || r.kind === 'run')).length + (deps.mainBusy?.() ? 1 : 0) < 2;
    // Rebuilding drops focus; give it back to the same row's button.
    const f = document.activeElement, fKey = list.contains(f) ? f.closest('[data-key]')?.dataset.key : null, fAct = fKey && f.dataset.act;
    list.replaceChildren(...rows.map((r) => {
      // data-kind, not a class: .subagent already styles the transcript's cards.
      const li = el('li', { className: 'tray-row' });
      li.dataset.key = r.key; li.dataset.kind = r.kind;
      if (r.seed) seeded(li, r.seed); // the agent's color (continuity)
      if (r.paused) li.classList.add('paused');
      li.append(icon(r.kind === 'subagent' ? 'bot' : r.kind === 'run' ? 'terminal' : r.kind === 'approval' || r.kind === 'cap' ? 'shield-alert' : r.kind === 'steer' ? 'send' : r.kind === 'watch' ? 'eye' : 'clock'));
      const text = el(r.open ? 'button' : 'span', { className: 'tray-text', textContent: r.text, title: r.title ?? r.text });
      if (r.open) { text.type = 'button'; text.onclick = r.open; text.dataset.act = 'open'; }
      li.append(text, el('span', { className: 'tray-origin', textContent: r.origin }));
      const t = el('span', { className: 'tray-time' });
      if (r.since) { t.dataset.since = r.since; t.textContent = elapsed(Date.now() - r.since); }
      li.append(t);
      if (r.background) {
        // G12: main stops waiting on it; the subagent keeps running.
        const b = el('button', { type: 'button', className: 'tray-bg', textContent: 'Background', title: 'Main stops waiting; this subagent keeps running and reports later', ariaLabel: `Send ${r.text} to the background` });
        b.dataset.act = 'bg';
        b.onclick = async () => { b.disabled = true; try { await r.background(); } catch (e) { deps.fail(e.message); } };
        li.append(b);
      }
      // Pending input (D25): Edit, Steer now, Send, each a visible labeled button.
      for (const a of r.actions ?? []) {
        const b = el('button', { type: 'button', className: 'tray-bg', textContent: a.label, ariaLabel: a.ariaLabel ?? a.label, title: a.title ?? a.ariaLabel ?? a.label });
        b.dataset.act = a.act;
        b.onclick = async () => { b.disabled = true; try { await a.run(); } catch (e) { deps.fail(e.message); } };
        li.append(b);
      }
      if (r.stop) {
        const b = el('button', { type: 'button', className: 'tray-stop', textContent: r.stopLabel ?? 'Stop', ariaLabel: r.stopAria ?? `${r.stopLabel ?? 'Stop'} ${r.kind === 'queued' ? 'queued message' : r.text}` });
        b.dataset.act = 'stop';
        b.onclick = async () => { b.disabled = true; try { await r.stop(); } catch (e) { deps.fail(e.message); } };
        li.append(b);
      }
      deps.onRow?.(li, r); // continuity: a fold or morph resumes over the rebuild
      return li;
    }));
    if (fKey) list.querySelector(`[data-key="${CSS.escape(fKey)}"] [data-act="${fAct}"]`)?.focus({ preventScroll: true });
    // Elapsed ticks only while someone can see it.
    const live = !tray.hidden && !collapsed && rows.some((r) => r.since);
    if (live && !timer) timer = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 1000);
    if (!live && timer) { clearInterval(timer); timer = 0; }
    if (wasHidden !== tray.hidden || oldH !== tray.offsetHeight) deps.onTray?.();
  }
  function setCollapsed(v) {
    collapsed = v;
    tray.classList.toggle('collapsed', v);
    toggle.ariaExpanded = String(!v);
    // Where the tray goes on a click: up to open, down to fold (README "Disclosures").
    toggle.dataset.points = v ? 'up' : 'down';
    toggle.ariaLabel = v ? 'Show activity' : 'Hide activity';
    toggle.title = toggle.ariaLabel;
    renderTray();
  }
  toggle.onclick = () => setCollapsed(!collapsed);
  stopAll.onclick = async () => { stopAll.disabled = true; try { await deps.stopAll(); } finally { stopAll.disabled = false; } };

  // ── Autocomplete: @ paths, $ skills, / commands ──────────────────
  const ac = $('ac');
  let state = null; // { kind, start, end, q, items, active }
  let paths = null, scanning = null, skills = null;
  deps.vfs.addEventListener('change', () => { paths = null; skills = null; });

  async function scan() {
    const out = [];
    const queue = deps.roots().map((r) => [r, 0]);
    while (queue.length && out.length < PATH_CAP) {
      const [dir, depth] = queue.shift();
      let entries;
      try { entries = await deps.vfs.list(dir); } catch { continue; }
      for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        const p = (dir === '/' ? '' : dir) + '/' + e.name;
        out.push(e.isDirectory ? p + '/' : p);
        if (e.isDirectory && depth < 8) queue.push([p, depth + 1]);
        if (out.length >= PATH_CAP) break;
      }
    }
    return out;
  }
  const indexPaths = () => (paths ? Promise.resolve(paths) : (scanning ??= scan().then((p) => { paths = p; scanning = null; return p; })));
  const indexSkills = async () => (skills ??= await deps.skills().catch(() => []));

  // What is being typed at the caret, if it is one of the three triggers.
  function token() {
    const v = input.value, c = input.selectionStart;
    if (c !== input.selectionEnd) return null;
    const before = v.slice(0, c);
    let m;
    if ((m = /^\/([\w-]*)$/.exec(before)) && !/^\S/.test(v.slice(c))) return { kind: 'command', start: 0, end: c, q: m[1] };
    if ((m = /(?:^|\s)@(\S*)$/.exec(before))) return { kind: 'path', start: c - m[1].length - 1, end: c, q: m[1] };
    if ((m = /(?:^|\s)\$([\w.-]*)$/.exec(before))) return { kind: 'skill', start: c - m[1].length - 1, end: c, q: m[1] };
    return null;
  }
  const rank = (xs, q, key) => xs.map((x) => [x, fuzzy(q, key(x))]).filter(([, s]) => s != null).sort((a, b) => b[1] - a[1]).slice(0, SHOWN).map(([x]) => x);

  let gen = 0;
  async function update() {
    const t = token();
    if (!t) return close();
    const g = ++gen;
    let items;
    if (t.kind === 'command') items = rank(deps.commands, t.q, (c) => c.name).map((c) => ({ label: '/' + c.name, detail: c.hint, value: c }));
    else if (t.kind === 'skill') {
      const all = await indexSkills();
      // requests: the skill's declared cost (frontmatter), shown before it is used.
      items = rank(all, t.q, (s) => s.name).map((s) => ({ label: s.name, detail: s.description, value: s, ...(s.requests ? { cost: `about ${String(s.requests).replace(/-/g, '–')} requests` } : {}) }));
      if (!all.length) items = [{ label: 'No skills yet', detail: 'Skills live in /pouch/skills and /work/.agents/skills', disabled: true }];
    } else {
      if (!paths) open(t, [{ label: 'Indexing files...', disabled: true }]);
      const all = await indexPaths();
      items = rank(all, t.q, (p) => p).map((p) => ({ label: p, value: p, mono: true }));
    }
    if (g !== gen) return; // typed on meanwhile
    if (!items.length) items = [{ label: t.kind === 'command' ? 'No such command (Enter sends it as text)' : 'No match', disabled: true }];
    open(t, items);
  }
  const KIND = { path: 'Files and folders', skill: 'Skills', command: 'Commands' };
  function open(t, items) {
    const keep = state?.kind === t.kind ? Math.max(0, state.active) : 0;
    state = { ...t, items, active: Math.min(keep, items.length - 1) };
    if (items[state.active]?.disabled) state.active = items.findIndex((i) => !i.disabled);
    ac.ariaLabel = KIND[t.kind];
    ac.replaceChildren(...items.map((it, i) => {
      const o = el('div', { id: 'ac-' + i, role: 'option', className: 'ac-opt' + (it.mono ? ' mono' : ''), ariaSelected: String(i === state.active), ariaDisabled: it.disabled ? 'true' : null },
        el('span', { className: 'ac-label', textContent: it.label }), ...(it.detail ? [el('span', { className: 'ac-detail', textContent: it.detail })] : []), ...(it.cost ? [el('span', { className: 'ac-cost', textContent: it.cost })] : []));
      if (!it.disabled) {
        // pointerdown keeps focus (and the soft keyboard) in the input.
        o.onpointerdown = (e) => e.preventDefault();
        o.onclick = () => choose(i, true);
      }
      return o;
    }));
    ac.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    mark();
  }
  function mark() {
    const opts = ac.children;
    for (let i = 0; i < opts.length; i++) opts[i].ariaSelected = String(i === state.active);
    if (state.active >= 0) { input.setAttribute('aria-activedescendant', 'ac-' + state.active); opts[state.active]?.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function close() {
    gen++;
    if (!state && ac.hidden) return;
    state = null; ac.hidden = true; ac.replaceChildren();
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  function replace(start, end, text) {
    const v = input.value;
    input.value = v.slice(0, start) + text + v.slice(end);
    const c = start + text.length;
    input.setSelectionRange(c, c);
    input.dispatchEvent(new Event('input')); // autosize, and the next token check
  }
  // run: Enter or a tap runs a command; Tab only completes its name.
  function choose(i, run) {
    const it = state?.items[i];
    if (!it || it.disabled) return;
    const { kind, start, end } = state;
    close();
    if (kind === 'command') {
      if (run) { input.value = ''; input.dispatchEvent(new Event('input')); runCommand('/' + it.value.name); }
      else replace(start, end, '/' + it.value.name + ' ');
    } else if (kind === 'skill') replace(start, end, `Use the ${it.value.name} skill. `);
    else replace(start, end, it.value + (it.value.endsWith('/') ? '' : ' '));
    input.focus();
  }
  // main.js calls this first from the input's keydown; true means handled.
  function onKeydown(e) {
    if (!state || ac.hidden) return false;
    const n = state.items.length, step = (d) => {
      for (let k = 1; k <= n; k++) { const j = (state.active + d * k + n * 2) % n; if (!state.items[j].disabled) { state.active = j; break; } }
      mark();
    };
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Escape') close();
    else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && state.active >= 0 && !state.items[state.active].disabled) choose(state.active, e.key === 'Enter');
    else return false;
    e.preventDefault();
    return true;
  }
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 0));
  input.setAttribute('aria-controls', 'ac');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  // "/name rest": a known command runs (true); anything else is a message.
  function runCommand(text) {
    const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const c = m && deps.commands.find((x) => x.name === m[1]);
    if (!c) return false;
    Promise.resolve(c.run(m[2]?.trim() ?? '')).catch((e) => deps.fail(e.message));
    return true;
  }

  // ── Shield popover: lane and grants for this session ─────────────
  const shieldBtn = $('shield-btn'), pop = $('shield-pop');
  async function showShield() {
    const s = await deps.shield();
    const hadFocus = pop.contains(document.activeElement); // a Revoke rebuilds the list
    const grants = s.grants.length
      ? el('ul', { className: 'pop-grants' }, ...s.grants.map((g) => {
        const b = el('button', { type: 'button', textContent: 'Revoke', ariaLabel: `Revoke: ${g.label}` });
        b.onclick = async () => { await g.revoke(); showShield(); };
        return el('li', {}, el('span', { textContent: g.label }), b);
      }))
      : el('p', { className: 'muted', textContent: 'None. Pouch asks before every request that leaves the pouch.' });
    const trust = el('button', { type: 'button', className: 'link', textContent: 'What can BayLeaf see?' });
    trust.onclick = () => { hideShield(); s.trust(); };
    pop.replaceChildren(
      el('p', { className: 'pop-lane' }, icon('lock'), el('strong', { textContent: s.lane })),
      el('p', { className: 'muted', textContent: s.detail }),
      el('h3', { textContent: 'Allowed for this session without asking' }), grants, trust);
    pop.hidden = false;
    shieldBtn.ariaExpanded = 'true';
    if (hadFocus) pop.querySelector('button')?.focus();
  }
  function hideShield(refocus) {
    if (pop.hidden) return;
    pop.hidden = true; shieldBtn.ariaExpanded = 'false';
    if (refocus) shieldBtn.focus();
  }
  shieldBtn.onclick = () => (pop.hidden ? showShield().then(() => pop.querySelector('button')?.focus()) : hideShield());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden && (pop.contains(document.activeElement) || document.activeElement === shieldBtn || document.activeElement === document.body)) { e.stopPropagation(); hideShield(true); } });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !shieldBtn.contains(e.target)) hideShield(); });

  return { renderTray, onKeydown, runCommand, close, hideShield, refreshShield: () => { if (!pop.hidden) showShield(); } };
}
