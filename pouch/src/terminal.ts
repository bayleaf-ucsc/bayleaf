// A terminal for humans: just-bash over the user's whole view of the
// Workspace (/work, /pouch, /tmp, /task, mounts), so a person can do what the
// agents do. Nothing here leaves the page except the `bayleaf` command, which
// asks on the same approval sheet as an agent's, every use (the terminal
// belongs to no session, so no "Allow for this session" grant applies).
//
// Writes go through vfs.as('user') (file watches see them as the user's, like
// editor saves) and through the page-wide per-path write queue (tools.ts
// serialized), so a terminal write waits for an agent's edit of the same file.
//
// Each command is a /task entry (kind "terminal"). Ctrl+C does not call the
// abort directly: it writes "kill" to /task/<id>/ctl, the same control file an
// agent or the user can write with `echo kill > /task/<id>/ctl`. This is the
// first caller of the control-plane seam; see README "Terminal".
//
// just-bash 3.6 returns a command's output when it ends, so output appears
// per command (a live elapsed time shows meanwhile); it is not streamed.
import { $, el } from './dom.ts';
import { normalize } from './vfs.ts';
import { shellFor, serialized, execScript, CWD } from './tools.ts';
import type { EgressRequest } from './trust.ts';
import type { Namespace } from './ns/namespace.ts';
import type { Task } from './ns/tasks.ts';
import type { OpenHooks } from './open-cli.ts';
import type { ShellHooks } from './tools-types.ts';
import type { Vfs } from './vfs.ts';

const HISTORY_KEY = 'pouch.terminal.history';
const HISTORY_CAP = 200;
const OUT_LINES = 2000, OUT_CHARS = 200_000; // per command
const KEEP_BLOCKS = 300; // commands kept on screen

export interface CappedOutput { text: string; note: string }
export function capOutput(text: unknown): CappedOutput {
  let t = String(text ?? ''), note = '';
  const lines = t.replace(/\n$/, '').split('\n');
  if (lines.length > OUT_LINES) { note = `[output capped: ${lines.length - OUT_LINES} more lines not shown]`; t = lines.slice(0, OUT_LINES).join('\n'); }
  if (t.length > OUT_CHARS) { note = `[output capped: ${t.length - OUT_CHARS} more characters not shown]`; t = t.slice(0, OUT_CHARS); }
  return { text: t, note };
}
// Binary bytes on screen are noise (and control characters in a log region);
// pipes still get them (`cat x.png | od -c | head`). Display only.
export function binaryOutput(text: unknown): string | null {
  const t = String(text ?? '');
  if (!t.slice(0, 8000).includes('\0')) return null;
  return `[binary output: ${t.length} bytes not shown. Try \`od -c FILE | head\`, \`file FILE\`, or \`open FILE\` for images, audio and video]`;
}
const errText = (e: unknown) => String((e && typeof e === 'object' && 'message' in e ? e.message : null) ?? e);
const commonPrefix = (xs: string[]) => xs.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); });

// addons, pdf, media, duckdb, transcribe: the src/addons-cli.ts, src/pdf.ts, src/media.ts,
// src/duckdb.ts and src/parakeet.ts services, passed through to shellFor. openFile and
// revealDir back the `open` command (src/open-cli.ts).
export interface TerminalHooks extends Pick<ShellHooks, 'addons' | 'pdf' | 'media' | 'duckdb' | 'transcribe'>, Pick<OpenHooks, 'openFile' | 'revealDir'> {
  bayleafCredential?(): string | null | undefined;
  approveEgress?(req: EgressRequest): Promise<boolean>;
}
// Just what the terminal uses of the page's Vfs and its /task table.
export type TerminalTask = Task;
export type TerminalVfs = Pick<Vfs, 'as' | 'fs' | 'tasks' | 'describe' | 'changed'>;
// fs: the user's namespace, with /session.
export interface TerminalOptions { vfs: TerminalVfs; fs?: Namespace; hooks?: TerminalHooks; onChange?(): void }
interface ShellResult { stdout: string; stderr: string; exitCode: number; env?: Record<string, string> }
export interface Terminal {
  run(cmd: string): Promise<void>;
  interrupt(): Promise<void>;
  clear(): void;
  focus(): void;
  readonly running: TerminalTask | null;
  readonly cwd: string;
  history(): string[];
}
export function createTerminal({ vfs, fs: userFs, hooks = {}, onChange }: TerminalOptions): Terminal {
  const fs = serialized(userFs ?? vfs.as('user'));
  const shell = shellFor(fs, {
    bayleafCredential: () => hooks.bayleafCredential?.() ?? null,
    approveEgress: hooks.approveEgress && ((req: EgressRequest) => hooks.approveEgress?.(req) ?? Promise.resolve(false)),
    addons: hooks.addons,
    pdf: hooks.pdf,
    media: hooks.media,
    duckdb: hooks.duckdb,
    transcribe: hooks.transcribe,
    openFile: hooks.openFile,
    revealDir: hooks.revealDir,
  });
  let cwd: string = CWD, env: Record<string, string> | null = null, running: { task: TerminalTask } | null = null;
  let history: string[] = [];
  try { const h: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? 'null'); if (Array.isArray(h)) history = h.filter((x) => typeof x === 'string'); } catch {}
  let at = history.length, draft = '';
  const log = $('term-log'), input = $<HTMLInputElement>('term-input'), prompt = $('term-prompt');
  const setPrompt = () => { prompt.textContent = (cwd === CWD ? '~' : cwd.replace(/^\/work\//, '~/')) + ' $'; };
  setPrompt();

  function remember(cmd: string) {
    if (history.at(-1) !== cmd) history.push(cmd);
    history = history.slice(-HISTORY_CAP);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
    at = history.length; draft = '';
  }
  function block(cmd: string) {
    const b = el('div', { className: 'term-block' }, el('div', { className: 'term-cmd' }, el('span', { className: 'term-ps', textContent: prompt.textContent + ' ' }), cmd));
    log.append(b);
    while (log.children.length > KEEP_BLOCKS) log.firstElementChild?.remove();
    return b;
  }
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  function print(b: Element, text: string, cls = 'term-out') { if (text) b.append(el('pre', { className: cls, textContent: text })); }

  async function run(cmd: string) {
    const line = cmd.trim();
    if (!line) { block(''); scroll(); return; }
    remember(line);
    if (line === 'clear') return clear();
    if (line === 'history') { print(block(line), history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n')); scroll(); return; }
    const b = block(line);
    const ac = new AbortController();
    let killed = false;
    const task = vfs.tasks.add({ kind: 'terminal', label: line.slice(0, 60), ns: () => vfs.describe(), kill: () => { killed = true; ac.abort(); } });
    const live = el('div', { className: 'term-live muted', role: 'status' });
    b.append(live);
    const t0 = Date.now();
    const tick = () => { live.textContent = `running ${((Date.now() - t0) / 1000).toFixed(0)} s · /task/${task.id} · Ctrl+C stops`; };
    tick(); const timer = setInterval(tick, 1000);
    running = { task };
    input.setAttribute('aria-busy', 'true');
    scroll();
    let r: ShellResult;
    try { r = await execScript(shell, line, { cwd, ...(env ? { env, replaceEnv: true } : {}), signal: ac.signal }); }
    catch (e) { r = { stdout: '', stderr: errText(e) + '\n', exitCode: 1 }; }
    finally { clearInterval(timer); live.remove(); running = null; input.removeAttribute('aria-busy'); }
    if (!killed && r.env) { env = r.env; cwd = normalize(r.env.PWD || cwd); setPrompt(); }
    const screen = (t: string) => { const bin = binaryOutput(t); return bin ? { text: '', note: bin } : capOutput(t); };
    const out = screen(r.stdout), err = screen(killed ? '' : r.stderr);
    print(b, out.text); print(b, err.text, 'term-err');
    for (const n of [out.note, err.note]) if (n) print(b, n, 'term-note muted');
    const code = killed ? 130 : r.exitCode;
    if (killed) print(b, `^C killed through /task/${task.id}/ctl`, 'term-note muted');
    if (code !== 0) b.append(el('div', { className: 'term-exit', textContent: `exit ${code}`, title: 'Exit status' }));
    task.end(killed ? 'killed' : code === 0 ? 'done' : 'failed', `exit ${code}`);
    vfs.changed(); onChange?.();
    scroll();
  }

  // Ctrl+C: the control file, not the AbortController.
  async function interrupt() {
    if (!running) { block(input.value + '^C'); input.value = ''; scroll(); return; }
    try { await vfs.fs.writeFile(`/task/${running.task.id}/ctl`, 'kill'); }
    catch (e) { print(log.lastElementChild ?? log, errText(e), 'term-err'); }
  }
  function clear() { log.replaceChildren(); }

  // Tab: complete the last word as a path; several matches are listed.
  async function complete() {
    const v = input.value, start = v.search(/\S*$/), word = v.slice(start);
    const slash = word.lastIndexOf('/');
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '', stem = word.slice(slash + 1);
    const dir = normalize(dirPart.startsWith('/') ? dirPart || '/' : cwd + '/' + dirPart);
    const items: { name: string; isDirectory: boolean }[] = await fs.readdirWithFileTypes(dir).catch(() => []);
    const hits = items.filter((i) => i.name.startsWith(stem) && (stem.startsWith('.') || !i.name.startsWith('.')));
    if (!hits.length) return;
    if (hits.length === 1) { const h = hits[0]; input.value = v.slice(0, start) + dirPart + h.name + (h.isDirectory ? '/' : ' '); return; }
    const p = commonPrefix(hits.map((h) => h.name));
    if (p.length > stem.length) input.value = v.slice(0, start) + dirPart + p;
    else { print(block(v), hits.map((h) => h.name + (h.isDirectory ? '/' : '')).join('  '), 'term-out muted'); scroll(); }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (running) { print(log.lastElementChild ?? log, 'A command is running; Ctrl+C stops it.', 'term-note muted'); return; }
      const cmd = input.value; input.value = ''; run(cmd); return;
    }
    // Ctrl+C interrupts unless text is selected in the field (then it copies).
    if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) { e.preventDefault(); interrupt(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); clear(); return; }
    if (e.key === 'Tab' && !e.shiftKey && input.value.trim()) { e.preventDefault(); complete(); return; }
    if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault(); if (at === history.length) draft = input.value;
      at = Math.max(0, at - 1); input.value = history[at] ?? '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); at = Math.min(history.length, at + 1);
      input.value = at === history.length ? draft : history[at];
    }
  });
  $('term-form').onsubmit = (e) => e.preventDefault(); // Enter is handled above; the CSP forbids inline handlers
  $('term-clear').onclick = () => { clear(); input.focus(); };
  $('term-stop').onclick = () => interrupt();
  $('term-copy').onclick = async () => {
    const last = [...log.querySelectorAll('.term-block')].at(-1);
    const text = last ? [...last.querySelectorAll('pre')].map((p) => p.textContent).join('\n') : '';
    try { await navigator.clipboard.writeText(text); } catch {}
  };
  log.addEventListener('click', () => { if (!getSelection()?.toString()) input.focus(); });

  return { run, interrupt, clear, focus: () => input.focus(), get running() { return running?.task ?? null; }, get cwd() { return cwd; }, history: () => history.slice() };
}
