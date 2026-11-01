// The `open` command: show a file in the editor pane, in the mode its content
// type suggests, or a folder in Files (README "Terminal"). The terminal's
// `open` asks the page (hooks.openFile and hooks.revealDir, src/main.js
// openFile and revealDir); an agent's `open`
// refuses and says to link the file instead, so only a person decides what
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

// Parse the arguments: { path, flag } or { error } (a usage error).
export function parseArgs(args) {
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
  if (bad) return { error: `unknown option ${bad} (open takes --raw, --preview, --static or --interactive)` };
  const set = new Set(flags);
  set.delete('--preview');
  if (set.size > 1 || (set.has('--raw') && flags.includes('--preview'))) return { error: `choose one mode, not ${[...new Set(flags)].join(' and ')}` };
  if (!paths.length) return { error: 'which file? usage: open [--raw | --preview | --static | --interactive] <path>' };
  if (paths.length > 1) return { error: `open takes one path, got ${paths.length} (${paths.join(', ')})` };
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

// An agent's `open`: refused, with the way that leaves the choice to the user.
export const AGENT_REFUSAL = 'open: only the person using Pouch opens files in their editor (from the terminal or a link). To show them a file, link it in your reply, for example [report](/work/report.html); they choose when to open it, and HTML opens Static.';
export function agentOpenCommands(defineCommand) {
  return [defineCommand('open', async () => ({ stdout: '', stderr: AGENT_REFUSAL + '\n', exitCode: 1 }))];
}
