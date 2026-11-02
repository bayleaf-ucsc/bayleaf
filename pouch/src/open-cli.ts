// The `open` command: show a file in the editor pane, in the mode its content
// type suggests, or a folder in Files (README "Terminal"). The terminal's
// `open` asks the page (hooks.openFile and hooks.revealDir: openFile in
// src/interface/editing.ts, revealDir in src/interface/transcript.ts); an agent's `open`
// refuses and points to `show` (below), so only a person decides what
// takes over their editor and whether a report's scripts run.
//
//   open <path>               the default for its type (table below)
//   open <folder>             Files, scrolled to the folder, expanded
//   open --raw <path>         the text, in the editor
//   open --preview <path>     the preview (HTML: Static)
//   open --static <path>      HTML only: Preview, no script runs
//   open --interactive <path> HTML only: Preview with its scripts running
//
// Defaults depend only on the content type, never on the mode remembered for
// clicks (pouch.view): a command should do what its arguments say, the same
// every time. `open` does not change the remembered mode either.
import type { defineCommand as DefineCommand, FsStat } from 'just-bash';
import { previewOf } from './preview.ts';
import { normalize } from './vfs.ts';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const fail = (msg: string) => ({ stdout: '', stderr: `open: ${msg}\n`, exitCode: 1 });
const usage = (msg: string) => ({ stdout: '', stderr: `open: ${msg}\nRun \`open --help\` for usage.\n`, exitCode: 2 });

export const HELP = `open: show a file in the editor pane, in the mode its type suggests,
or a folder in Files

  open <folder>                Files, with the folder expanded and in view

  open <path>                  the default for its type:
                                 Markdown (.md)            Preview
                                 HTML (.html, .htm)        Preview, Static (no script runs)
                                 SVG                       Preview (drawn as an image)
                                 images, audio, video      Preview (they have no Raw view)
                                 other text and code       Raw, in the editor
  open --raw <path>            the text, in the editor (Markdown, HTML, SVG, text)
  open --preview <path>        the preview (HTML opens Static)
  open --static <path>         HTML: Preview with no script running
  open --interactive <path>    HTML: Preview with its scripts running. They cannot
                               read Pouch or your files, but can reach the network
                               over WebRTC: only for reports you trust

One path, and at most one mode (--static and --interactive imply --preview;
a folder takes none).
\`--\` ends the options. Binary files with no preview are refused (try \`file\`,
\`unzip -l\`, or Download in Files). \`open\` does not change the mode the editor
remembers for clicks. Exit codes: 0 opened, 1 error or kept unsaved changes, 2 usage.
`;

export type OpenMode = 'raw' | 'preview';
export type OpenArgs = { help: true; error?: undefined; path?: undefined; flag?: undefined }
  | { help?: undefined; error: string; path?: undefined; flag?: undefined }
  | { help?: undefined; error?: undefined; path: string; flag: string | null };
export type OpenPlan = { error: string; mode?: undefined; interactive?: undefined; kind?: undefined; label?: undefined; dir?: undefined }
  | { error?: undefined; mode: OpenMode; interactive: boolean; kind: string; label: string; dir?: undefined };
// openFile resolves true, false (the person kept unsaved changes) or a reason it was not opened.
export interface OpenHooks { openFile?(req: { path: string; mode: OpenMode; interactive: boolean }): Promise<boolean | string | undefined>; revealDir?(path: string): unknown }
export interface ShowRequest { path: string; dir: boolean; mode: OpenMode | null | undefined; label: string | undefined }
export interface ShowHooks { show?(req: ShowRequest): Promise<{ opened?: boolean; reason?: string } | null | undefined> }
export interface ShownLine { how: 'opened' | 'offered'; path: string; label: string; reason?: string }

// A usage error is { error }. name: the command the messages speak for
// (`open`, or an agent's `show`). Error strings are never empty.
export function parseArgs(args: string[], name = 'open'): OpenArgs {
  const flags: string[] = [], paths: string[] = [];
  let opts = true;
  for (const a of args) {
    if (opts && a === '--') { opts = false; continue; }
    if (opts && a.startsWith('-') && a !== '-') flags.push(a);
    else paths.push(a);
  }
  if (flags.includes('--help') || flags.includes('-h')) return { help: true };
  const known = ['--raw', '--preview', '--static', '--interactive'];
  const bad = flags.find((f) => !known.includes(f));
  if (bad) return { error: `unknown option ${bad} (${name} takes --raw, --preview, --static${name === 'open' ? ' or --interactive' : ''})` };
  const set = new Set(flags);
  set.delete('--preview');
  if (set.size > 1 || (set.has('--raw') && flags.includes('--preview'))) return { error: `choose one mode, not ${[...new Set(flags)].join(' and ')}` };
  if (!paths.length) return { error: `which file? usage: ${name} [--raw | --preview | --static${name === 'open' ? ' | --interactive' : ''}] <path>` };
  if (paths.length > 1) return { error: `${name} takes one path, got ${paths.length} (${paths.join(', ')})` };
  const flag = [...set][0] ?? (flags.includes('--preview') ? '--preview' : null);
  return { path: paths[0], flag };
}

// binary: the file has a NUL byte in its first 8,000 (only asked when it has no preview).
export function planOpen(path: string, flag: string | null | undefined, { binary = false }: { binary?: boolean } = {}): OpenPlan {
  const p = previewOf(path);
  const kind = p?.kind ?? (binary ? 'binary' : 'text');
  const name = path.split('/').pop();
  if (kind === 'binary') return { error: `${path} looks binary and has no preview. Try \`file ${name}\`, \`od -c ${name} | head\`, \`unzip -l ${name}\`, or Download it from Files.` };
  if ((flag === '--static' || flag === '--interactive') && kind !== 'html') return { error: `${flag} is for HTML reports; ${name} is ${article(kind)}. Use --raw or --preview.` };
  if (flag === '--raw' && p && !p.raw) return { error: `${name} is ${article(kind)} with no Raw view (it is not text). \`open ${name}\` previews it.` };
  if (flag === '--preview' && !p) return { error: `${name} has no preview (Preview covers Markdown, HTML, SVG, images, audio and video). \`open ${name}\` shows it Raw.` };
  const mode = flag === '--raw' ? 'raw' : flag || p ? 'preview' : 'raw';
  const interactive = kind === 'html' && flag === '--interactive';
  const label = mode === 'raw' ? 'Raw' : kind === 'html' ? (interactive ? 'Preview, Interactive' : 'Preview, Static') : 'Preview';
  return { mode, interactive, kind, label };
}
const ARTICLE: Partial<Record<string, string>> = { markdown: 'a Markdown', svg: 'an SVG', image: 'an image', audio: 'an audio', video: 'a video', text: 'a text' };
const article = (kind: string) => (ARTICLE[kind] ?? 'a ' + kind) + ' file';

// The terminal's command. revealDir(path): show the folder in Files.
export function openCommands(defineCommand: typeof DefineCommand, { openFile, revealDir }: OpenHooks = {}) {
  if (!openFile) return [];
  return [defineCommand('open', async (args, ctx) => {
    const a = parseArgs(args);
    if (a.help) return ok(HELP);
    if (a.error !== undefined) return usage(a.error);
    const path = normalize(a.path.startsWith('/') ? a.path : ctx.cwd + '/' + a.path);
    let st: FsStat;
    try { st = await ctx.fs.stat(path); } catch { return fail(`${path}: no such file. List the folder with \`ls ${normalize(path + '/..')}\`.`); }
    if (st.isDirectory) {
      if (a.flag) return usage(`${a.flag} is for files; ${path} is a folder (\`open ${a.path}\` shows it in Files)`);
      if (!revealDir) return fail(`${path} is a folder; list it with \`ls ${path}\`.`);
      try { await revealDir(path); } catch (e) { return fail(`${path}: ${e instanceof Error ? e.message : e}`); }
      return ok(`showing ${path} in Files\n`);
    }
    let binary = false;
    if (!previewOf(path)) {
      const bytes = await ctx.fs.readFileBuffer(path).catch(() => new Uint8Array());
      binary = bytes.subarray(0, 8000).includes(0);
    }
    const plan = planOpen(path, a.flag, { binary });
    if (plan.error !== undefined) return fail(plan.error);
    let opened: boolean | string | undefined;
    try { opened = await openFile({ path, mode: plan.mode, interactive: plan.interactive }); }
    catch (e) { return fail(`${path}: ${e instanceof Error ? e.message : e}`); }
    if (opened === false) return fail(`kept your unsaved changes; ${path} was not opened.`);
    if (opened !== true && opened !== undefined) return fail(`${path} was not opened (${opened}).`);
    return ok(`opened ${path} (${plan.label})\n`);
  })];
}

// An agent's `open`: refused, pointing to `show` (the agent's act; LANGUAGE.md "Show").
export const AGENT_REFUSAL = 'open: open is the person\'s; use `show <path>` to put a file or folder in front of them (or link it in your reply, for example [report](/work/report.html)).';
export function agentOpenCommands(defineCommand: typeof DefineCommand) {
  return [defineCommand('open', async () => ({ stdout: '', stderr: AGENT_REFUSAL + '\n', exitCode: 1 }))];
}

// An agent's `show` (LANGUAGE.md "Show"): the same paths, defaults and checks
// as `open`, but the page decides whether to open it now or offer it in the
// transcript, so an agent never takes over a busy person's pane.
// show: src/interface/editing.ts show.
// Both outcomes exit 0, since either way the person has it; the one line says which.
// A transcript card is drawn from that line (src/interface/transcript.ts shownLines), so keep its shape:
//   shown: opened <path> (<label>)
//   shown: offered <path> (<label>); not opened (user busy: <reason>), ...
export const SHOW_HELP = `show: put a file or folder in front of the person using Pouch

  show <path>                  the default for its type, as \`open\` (Markdown Preview,
                               HTML Preview Static, media Preview, text Raw)
  show <folder>                Files, with the folder expanded
  show --raw | --preview | --static <path>

It opens at once unless that would get in the user's way (unsaved edits, they are
typing or pointing, a dialog is open, or you are a subagent); then the transcript
offers it with an Open button. Either way it is recorded there. Scripts in an HTML
report never run from show (no --interactive: that is the person's choice).
Exit codes: 0 opened or offered (the line says which), 1 error, 2 usage.
`;
const sfail = (msg: string) => ({ stdout: '', stderr: `show: ${msg}\n`, exitCode: 1 });
const susage = (msg: string) => ({ stdout: '', stderr: `show: ${msg}\nRun \`show --help\` for usage.\n`, exitCode: 2 });
export function agentShowCommands(defineCommand: typeof DefineCommand, { show }: ShowHooks = {}) {
  return [defineCommand('show', async (args, ctx) => {
    if (args.includes('--interactive')) return sfail('--interactive is the person\'s choice: show opens HTML Static, and they can switch it to Interactive.');
    const a = parseArgs(args, 'show');
    if (a.help) return ok(SHOW_HELP);
    if (a.error !== undefined) return susage(a.error);
    const path = normalize(a.path.startsWith('/') ? a.path : ctx.cwd + '/' + a.path);
    let st: FsStat;
    try { st = await ctx.fs.stat(path); } catch { return sfail(`${path}: no such file. List the folder with \`ls ${normalize(path + '/..')}\`.`); }
    let plan: OpenPlan | { dir: true; mode: null; label: string; error?: undefined };
    if (st.isDirectory) {
      if (a.flag) return susage(`${a.flag} is for files; ${path} is a folder (\`show ${a.path}\` shows it in Files)`);
      plan = { dir: true, mode: null, label: 'Files' };
    } else {
      let binary = false;
      if (!previewOf(path)) {
        const bytes = await ctx.fs.readFileBuffer(path).catch(() => new Uint8Array());
        binary = bytes.subarray(0, 8000).includes(0);
      }
      plan = planOpen(path, a.flag, { binary });
      if (plan.error !== undefined) return sfail(plan.error.replaceAll('`open ', '`show '));
    }
    if (!show) return sfail('there is no Interface here to show it in; link it in your reply instead.');
    let r: { opened?: boolean; reason?: string } | null | undefined;
    try { r = await show({ path, dir: !!plan.dir, mode: plan.mode, label: plan.label }); }
    catch (e) { return sfail(`${path}: ${e instanceof Error ? e.message : e}`); }
    if (r?.opened) return ok(`shown: opened ${path} (${plan.label})\n`);
    return ok(`shown: offered ${path} (${plan.label}); not opened (user busy: ${r?.reason ?? 'unknown'}), the transcript has an Open button for them\n`);
  })];
}

// The parser for those lines, kept beside the producer. Only the two whole shapes
// match, so a file named "a (Preview).html" keeps its path and a stray line makes no card.
const SHOWN = /^shown: (?:opened (.+) \((Raw|Preview|Preview, Static|Files)\)|offered (.+) \((Raw|Preview|Preview, Static|Files)\); not opened \(user busy: ([^)]*)\), the transcript has an Open button for them)$/gm;
export const shownLines = (output: unknown): ShownLine[] => (typeof output === 'string' ? [...output.matchAll(SHOWN)] : [])
  .map(([, op, ol, fp, fl, reason]): ShownLine => (op ? { how: 'opened', path: op, label: ol } : { how: 'offered', path: fp, label: fl, reason }));
