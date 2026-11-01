// The `open` command: show a file in the editor pane, in the mode its content
// type suggests, or a folder in Files (README "Terminal"). The terminal's
// `open` asks the page (hooks.openFile and hooks.revealDir, src/main.js
// openFile and revealDir); an agent's `open`
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
import { previewOf } from './preview.js';
import { normalize } from './vfs.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const fail = (msg) => ({ stdout: '', stderr: `open: ${msg}\n`, exitCode: 1 });
const usage = (msg) => ({ stdout: '', stderr: `open: ${msg}\nRun \`open --help\` for usage.\n`, exitCode: 2 });

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

// Parse the arguments: { path, flag } or { error } (a usage error). name: the
// command the messages speak for (`open`, or an agent's `show`).
export function parseArgs(args, name = 'open') {
  const flags = [], paths = [];
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

// What opening path with flag means: { mode: 'raw' | 'preview', interactive, kind, label } or { error }.
// binary: the file has a NUL byte in its first 8,000 (only asked when it has no preview).
export function planOpen(path, flag, { binary = false } = {}) {
  const p = previewOf(path);
  const kind = p?.kind ?? (binary ? 'binary' : 'text');
  const name = path.split('/').pop();
  if (kind === 'binary') return { error: `${path} looks binary and has no preview. Try \`file ${name}\`, \`od -c ${name} | head\`, \`unzip -l ${name}\`, or Download it from Files.` };
  if ((flag === '--static' || flag === '--interactive') && kind !== 'html') return { error: `${flag} is for HTML reports; ${name} is ${article(kind)}. Use --raw or --preview.` };
  if (flag === '--raw' && p && !p.raw) return { error: `${name} is ${article(kind)} file with no Raw view (it is not text). \`open ${name}\` previews it.` };
  if (flag === '--preview' && !p) return { error: `${name} has no preview (Preview covers Markdown, HTML, SVG, images, audio and video). \`open ${name}\` shows it Raw.` };
  const mode = flag === '--raw' ? 'raw' : flag || p ? 'preview' : 'raw';
  const interactive = kind === 'html' && flag === '--interactive';
  const label = mode === 'raw' ? 'Raw' : kind === 'html' ? (interactive ? 'Preview, Interactive' : 'Preview, Static') : 'Preview';
  return { mode, interactive, kind, label };
}
const article = (kind) => ({ markdown: 'a Markdown', svg: 'an SVG', image: 'an image', audio: 'an audio', video: 'a video', text: 'a text' }[kind] ?? 'a ' + kind) + ' file';

// The terminal's command. openFile({ path, mode, interactive }) -> Promise<boolean>:
// false when the person kept unsaved changes to the file already open.
// revealDir(path): show the folder in Files.
export function openCommands(defineCommand, { openFile, revealDir } = {}) {
  if (!openFile) return [];
  return [defineCommand('open', async (args, ctx) => {
    const a = parseArgs(args);
    if (a.help) return ok(HELP);
    if (a.error) return usage(a.error);
    const path = normalize(a.path.startsWith('/') ? a.path : ctx.cwd + '/' + a.path);
    let st;
    try { st = await ctx.fs.stat(path); } catch { return fail(`${path}: no such file. List the folder with \`ls ${normalize(path + '/..')}\`.`); }
    if (st.isDirectory) {
      if (a.flag) return usage(`${a.flag} is for files; ${path} is a folder (\`open ${a.path}\` shows it in Files)`);
      if (!revealDir) return fail(`${path} is a folder; list it with \`ls ${path}\`.`);
      try { await revealDir(path); } catch (e) { return fail(`${path}: ${e?.message ?? e}`); }
      return ok(`showing ${path} in Files\n`);
    }
    let binary = false;
    if (!previewOf(path)) {
      const bytes = await ctx.fs.readFileBuffer(path).catch(() => new Uint8Array());
      binary = bytes.subarray(0, 8000).includes(0);
    }
    const plan = planOpen(path, a.flag, { binary });
    if (plan.error) return fail(plan.error);
    let opened;
    try { opened = await openFile({ path, mode: plan.mode, interactive: plan.interactive }); }
    catch (e) { return fail(`${path}: ${e?.message ?? e}`); }
    if (opened === false) return fail(`kept your unsaved changes; ${path} was not opened.`);
    return ok(`opened ${path} (${plan.label})\n`);
  })];
}

// An agent's `open`: refused, pointing to `show` (the agent's act; LANGUAGE.md "Show").
export const AGENT_REFUSAL = 'open: open is the person\'s; use `show <path>` to put a file or folder in front of them (or link it in your reply, for example [report](/work/report.html)).';
export function agentOpenCommands(defineCommand) {
  return [defineCommand('open', async () => ({ stdout: '', stderr: AGENT_REFUSAL + '\n', exitCode: 1 }))];
}

// An agent's `show` (LANGUAGE.md "Show"): the same paths, defaults and checks
// as `open`, but the page decides whether to open it now or offer it in the
// transcript, so an agent never takes over a busy person's pane.
// show({ path, dir, mode, label }) -> { opened, reason? } (src/main.js show).
// Both outcomes exit 0, since either way the person has it; the one line says which.
// A transcript card is drawn from that line (main.js shownLines), so keep its shape:
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
const sfail = (msg) => ({ stdout: '', stderr: `show: ${msg}\n`, exitCode: 1 });
const susage = (msg) => ({ stdout: '', stderr: `show: ${msg}\nRun \`show --help\` for usage.\n`, exitCode: 2 });
export function agentShowCommands(defineCommand, { show } = {}) {
  return [defineCommand('show', async (args, ctx) => {
    if (args.includes('--interactive')) return sfail('--interactive is the person\'s choice: show opens HTML Static, and they can switch it to Interactive.');
    const a = parseArgs(args, 'show');
    if (a.help) return ok(SHOW_HELP);
    if (a.error) return susage(a.error);
    const path = normalize(a.path.startsWith('/') ? a.path : ctx.cwd + '/' + a.path);
    let st;
    try { st = await ctx.fs.stat(path); } catch { return sfail(`${path}: no such file. List the folder with \`ls ${normalize(path + '/..')}\`.`); }
    let plan;
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
      if (plan.error) return sfail(plan.error.replaceAll('`open ', '`show '));
    }
    if (!show) return sfail('there is no Interface here to show it in; link it in your reply instead.');
    let r;
    try { r = await show({ path, dir: !!plan.dir, mode: plan.mode, label: plan.label }); }
    catch (e) { return sfail(`${path}: ${e?.message ?? e}`); }
    if (r?.opened) return ok(`shown: opened ${path} (${plan.label})\n`);
    return ok(`shown: offered ${path} (${plan.label}); not opened (user busy: ${r?.reason ?? 'unknown'}), the transcript has an Open button for them\n`);
  })];
}
