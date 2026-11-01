// The four tools every coding harness converges on: read, write, edit, bash,
// plus `run` (src/run.js: JavaScript in a sandboxed QuickJS worker) and `look`
// (image files sent to an image-capable model).
// They run in this page against the Vfs; nothing here touches the network.
// just-bash is a TypeScript reimplementation of bash and coreutils, so `bash`
// is an interpreter over the same files, not a real process.
import { GRAPH_GLOSS } from './subagents.js';
import { UL_GLOSS } from './profiles.js';
import { Bash, InMemoryFs, defineCommand, getCommandNames } from 'just-bash';
import { normalize } from './vfs.js';
import { subset } from './ns/namespace.js';
import { serve, Client, NinepFs } from './ns/9p.js';
import { archiveCommands } from './archive.js';
import { bayleafCommands } from './bayleaf-cli.js';
import { modelsCommands } from './models-cli.js';
import { openCommands, agentOpenCommands, agentShowCommands } from './open-cli.js';
import { runTool } from './run.js';
import { WATCH_GLOSS } from './ns/watch.js';
import { FILE_CAP, rasterMime, prepareImageSized } from './attachments.js';

const MAX_LINES = 2000;
const MAX_CHARS = 50_000;
export const CWD = '/work';

// just-bash's browser build lacks these, or (gzip family) would call our
// zlib stub and throw; leave them out so the shell says "command not found".
// zip, unzip and tar come back as Pouch's own commands (archive.js).
const MISSING = new Set(['tar', 'yq', 'xan', 'sqlite3', 'python', 'python3', 'js-exec', 'node', 'gzip', 'gunzip', 'zcat', 'curl']);
export const COMMANDS = getCommandNames().filter((c) => !MISSING.has(c));

const SHOWN_BUDGET = 10_000;
export function clip(text) {
  if (text.length <= MAX_CHARS) return text;
  // `show` lines the cap would cut are kept, whole and inside it, so their cards
  // survive (main.js shownLines); together at most SHOWN_BUDGET characters.
  const from = text.lastIndexOf('\n', MAX_CHARS - SHOWN_BUDGET) + 1;
  const kept = [];
  let size = 0;
  for (const m of text.slice(from).matchAll(/^shown: .*$/gm)) {
    const line = { at: from + m.index, end: from + m.index + m[0].length, text: m[0].slice(0, 1000) };
    if (line.end <= MAX_CHARS - SHOWN_BUDGET) continue;
    if (size + line.text.length + 1 > SHOWN_BUDGET) break;
    kept.push(line);
    size += line.text.length + 1;
  }
  // Lines that still fit whole in the head stay there; a line the head would cut moves out of it.
  let cut = MAX_CHARS - size;
  const tail = kept.filter((l) => l.end > cut);
  cut = MAX_CHARS - tail.reduce((n, l) => n + l.text.length + 1, 0);
  for (const l of tail) if (l.at < cut) cut = l.at;
  const head = text.slice(0, cut).replace(/\n$/, '');
  const shown = tail.map((l) => l.text).join('\n');
  return head + (shown ? '\n' + shown : '') + `\n[truncated: ${text.length - head.length} more characters]`;
}

// Filesystem errors carry paths relative to their mount ("/NOTES.md" for
// /mnt/site/NOTES.md), which a model then copies back and loops on. Restate
// them with the path the agent used and a next step.
// writable: the places this caller may write (a subagent's namespace can make
// /work read-only), named in the EROFS error so it picks one instead of looping.
function explain(e, p, writable = [CWD, '/tmp']) {
  const code = e.code ?? e.message.match(/^(E[A-Z]+)/)?.[1];
  const dir = normalize(p + '/..');
  switch (code) {
    case 'ENOENT': return new Error(`${p} does not exist. List ${dir} with bash \`ls ${dir}\`, or search with \`find ${CWD} -name '<name>'\`.`);
    case 'EISDIR': return new Error(`${p} is a folder, not a file. List it with bash \`ls ${p}\`.`);
    case 'ENOTDIR': return new Error(`A part of ${p} is a file, not a folder.`);
    case 'EROFS': return new Error(`${p} is read-only for you. You can write under ${writable.join(', ')}; for example ${writable[0]}/${p.split('/').pop()}.`);
    case 'ENOTSUP': return new Error(`This browser cannot write ${p}. Write under ${CWD} instead.`);
    default: return e;
  }
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Native XML tool calls wrap each value in newlines, and small models get the
// trailing newline wrong: an append drops a file's last newline, or oldText
// and newText end differently (experiments/lfm3-webgpu, agent v2). So, for
// every lane and disclosed in the tool descriptions: newText ends with a line
// break exactly when oldText does (the same \n or \r\n). An empty newText (a
// deletion) is left alone. Returns the edit and whether it changed.
export function matchNewline(e) {
  if (typeof e.oldText !== 'string' || typeof e.newText !== 'string' || e.newText === '') return [e, false];
  const end = e.oldText.match(/\r?\n$/)?.[0] ?? '';
  const has = /\n$/.test(e.newText);
  if (!!end === has) return [e, false];
  return [{ ...e, newText: end ? e.newText + end : e.newText.replace(/(\r?\n)+$/, '') }, true];
}
// A written text file ends with exactly one line break (the file's own \n or \r\n).
export function oneFinalNewline(content) {
  if (typeof content !== 'string' || content === '' || content.includes('\0')) return [content, false];
  const nl = /\r\n/.test(content) ? '\r\n' : '\n';
  const fixed = content.replace(/(\r?\n)*$/, '') + nl;
  return [fixed, fixed !== content];
}

// The `bayleaf` command's hooks pass through (src/bayleaf-cli.js):
// bayleafCredential(), approveEgress(request, caller) (absent: every send is
// denied) and onEgress(event, caller). Each bash call also lists what it sent
// in its result. `caller` is the calling conversation (agent.js toTool), so
// the host can tell a subagent from the main agent; calls may run at once.
// One model message can carry several calls, and they run concurrently: two
// edits of one file would both read the original and the last write would
// win (seen in t17: a rename lost its import change). Edits and writes of
// the same path therefore take turns, page-wide: the agents' tools, `run`
// write-backs and the terminal (src/terminal.js) share this one queue.
const turns = new Map(); // path -> tail of its queue
export const oneAtATime = (p, fn) => {
  const run = (turns.get(p) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  turns.set(p, tail);
  tail.then(() => { if (turns.get(p) === tail) turns.delete(p); });
  return run;
};
// A filesystem whose writes take their path's turn (a move or copy waits on its target).
export function serialized(fs) {
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'writeFile' || prop === 'appendFile' || prop === 'rm') return (p, ...a) => oneAtATime(normalize(p), () => target[prop](p, ...a));
      if (prop === 'mv' || prop === 'cp') return (s, d, ...a) => oneAtATime(normalize(d), () => target[prop](s, d, ...a));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
// A filesystem that reports each successful change to onChange(op, path)
// ('created' | 'modified' | 'deleted'), for /session/<sid>/changes. One stat
// before a write tells created from modified; paths only, never content.
// The paths under a directory, depth first, at most MOVED_MAX ([] for a file).
const MOVED_MAX = 1000;
async function under(fs, dir, out = []) {
  let items;
  try { if (!(await fs.stat(dir)).isDirectory) return out; items = await fs.readdir(dir); } catch { return out; }
  for (const name of items) {
    if (out.length >= MOVED_MAX) break;
    out.push(dir + '/' + name);
    await under(fs, dir + '/' + name, out);
  }
  return out;
}
export function noting(fs, onChange) {
  const was = (p) => fs.stat(p).then(() => true, () => false);
  const write = (prop) => async (p, ...a) => { const had = await was(p); const r = await fs[prop](p, ...a); onChange(had ? 'modified' : 'created', normalize(p)); return r; };
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'writeFile' || prop === 'appendFile') return write(prop);
      // rm -f of a path that was never there changes nothing.
      if (prop === 'rm') return async (p, ...a) => { const had = await was(p); const r = await target.rm(p, ...a); if (had) onChange('deleted', normalize(p)); return r; };
      if (prop === 'mkdir') return async (p, ...a) => { const had = await was(p); const r = await target.mkdir(p, ...a); if (!had) onChange('created', normalize(p)); return r; };
      if (prop === 'cp') return async (s, d, ...a) => {
        const had = await was(d); const r = await target.cp(s, d, ...a);
        onChange(had ? 'modified' : 'created', normalize(d));
        if (!had) for (const p of await under(target, normalize(d))) onChange('created', p); // cp -r to a new path
        return r;
      };
      if (prop === 'mv') return async (s, d, ...a) => {
        const had = await was(d); const r = await target.mv(s, d, ...a);
        onChange('deleted', normalize(s)); onChange(had ? 'modified' : 'created', normalize(d));
        // A folder moved or copied to a new path: everything under it is new there
        // too (for mv, the ledger folds what was noted under the old path away).
        if (!had) for (const p of await under(target, normalize(d))) onChange('created', p);
        return r;
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// CP6 (story AG33). just-bash 3.6 lets a failed redirection write (`echo stop
// > /session/1/agents/a9/ctl` for an agent that does not exist, a refused
// `in`, a ctl line it rejects) escape exec() as a plain error: the script
// stops at that command, what it printed before is dropped, and nothing says
// the rest did not run. Real bash prints the error, sets status 1 and goes on.
// Its own error classes, which it does catch, are not exported, so Pouch
// cannot throw one; instead the shell's fs tags a failed write with its path
// (tagWrites) and execScript turns the escape into a result that names the
// failure and every top-level command that did not run, so a small model
// reruns them instead of reporting work that never happened. Upstream draft
// in the PR that added this; drop both once just-bash reports the write.
const WRITES = new Set(['writeFile', 'appendFile']);
export function tagWrites(fs) {
  return new Proxy(fs, {
    get(target, prop) {
      const v = target[prop];
      if (WRITES.has(prop)) return (p, ...a) => v.call(target, p, ...a).catch((e) => { if (e && typeof e === 'object') e.pouchWrite ??= normalize(p); throw e; });
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
const reason = (e) => String(e?.message ?? e).replace(/, (write|open) '[^']*'$/, '');
export async function execScript(bash, script, opts = {}) {
  try { return await bash.exec(script, opts); }
  catch (e) {
    if (!e?.pouchWrite || opts.signal?.aborted) throw e;
    return { stdout: '', stderr: stoppedAt(script, e.pouchWrite, reason(e), opts.cwd ?? CWD), exitCode: 1 };
  }
}
// A script's commands, split at unquoted ";" and line breaks (a loop body
// splits too; this only counts and quotes what did not run). The browser
// build of just-bash exports no parser.
export function commandsOf(script) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (q) { cur += ch; if (ch === '\\' && q !== "'") cur += script[++i] ?? ''; else if (ch === q) q = null; continue; }
    if (ch === '#' && !cur.trim()) { while (i < script.length && script[i] !== '\n') i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '\\') { cur += ch + (script[++i] ?? ''); continue; }
    if (ch === ';' || ch === '\n') { if (script[i + 1] === ';') cur += script[++i] + ch; else { if (cur.trim()) out.push(cur.trim()); cur = ''; } continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// "bash: <path>: <why>" and a note naming what did not run. The failed
// command is the one that writes the path (or its tail) by redirection or
// tee, named as a whole word; when that is not exactly one, or the path is
// only read, the note counts nothing rather than guess (a rerun could repeat
// a command that did run).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function stoppedAt(script, path, why, cwd = CWD) {
  const cmds = commandsOf(script);
  const rel = path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : null;
  const tail = path.split('/').slice(-2).join('/');
  const name = [path, rel].filter(Boolean).map(esc).join('|');
  const end = `(?=$|[\\s'"<>;|&)])`;
  // The tail alone only matches a target built from a variable ($dir/a9/ctl), so a
  // literal write to another path ending the same way is not taken for it.
  const writes = new RegExp(`(>>?|\\btee(\\s+-a)?)\\s*['"]?(?:${name}|[^\\s$]*\\$\\S*/${esc(tail)})${end}`);
  const hits = cmds.flatMap((c, i) => (writes.test(c) ? [i] : []));
  // In a loop the failing pass is unknown, so which commands ran is too.
  const loop = cmds.some((c) => /(?:^|(?:\bthen|\bdo|\belse|&&|\|\|)\s+)(?:for|while|until)\s/.test(c));
  const k = hits.length === 1 && !loop ? hits[0] : -1;
  const later = k < 0 ? [] : cmds.slice(k + 1);
  const list = later.slice(0, 5).map((c) => '`' + (c.length > 80 ? c.slice(0, 79) + '…' : c) + '`').join(', ') + (later.length > 5 ? `, and ${later.length - 5} more` : '');
  const before = k > 0 ? `the ${k} command${k > 1 ? 's' : ''} before it ran but ${k > 1 ? 'their' : 'its'} output is lost` : k < 0 ? 'output printed before it is lost' : '';
  const after = k < 0 ? 'commands after it did not run' : later.length ? `${later.length} later command${later.length > 1 ? 's' : ''} did not run: ${list}` : '';
  return `bash: ${path}: ${why}\n[Pouch: the script stopped at this failed write, including the rest of its line${[before, after].filter(Boolean).map((x) => '; ' + x).join('')}. Rerun what you still need.]\n`;
}

// The human's shell (src/terminal.js): the same just-bash, commands and
// `bayleaf` CLI the agents get, over whatever fs the caller passes, plus
// `open` (src/open-cli.js; hooks.openFile shows a file in the editor pane,
// hooks.revealDir a folder in Files).
export function shellFor(fs, hooks = {}) {
  return new Bash({
    fs: tagWrites(fs), cwd: CWD,
    env: { HOME: CWD, USER: 'user', PATH: '/usr/bin:/bin' },
    commands: COMMANDS,
    customCommands: [...archiveCommands(defineCommand), ...bayleafCommands(defineCommand, hooks), ...modelsCommands(defineCommand, hooks.models, { by: 'user', via: 'terminal' }), ...openCommands(defineCommand, { openFile: hooks.openFile, revealDir: hooks.revealDir })],
    executionLimits: { maxCommandCount: 100_000, maxLoopIterations: 100_000 },
  });
}

export const LOOK_MAX = 8; // paths per look call
export const LOOK_REFUSAL = 'This model cannot see images; ask the person to switch to a model marked images.';
const absPath = (p) => normalize(String(p).startsWith('/') ? String(p) : CWD + '/' + p);
// Skips an XML declaration and comments by hand: one regex for it backtracks (CodeQL).
function isSvg(p, bytes) {
  if (/\.svgz?$/i.test(p)) return true;
  let t = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().replace(/^<\?xml[^>]*>/i, '').trimStart();
  while (t.startsWith('<!--')) { const end = t.indexOf('-->'); if (end < 0) return false; t = t.slice(end + 3).trimStart(); }
  return /^<svg[\s>]/i.test(t);
}
// One text line per path, then the images in the same order. A path that is not
// a raster image is refused on its line; if none could be sent the call fails.
// Returns { text, images } (agent.js toTool turns it into text and image blocks).
// signal: Stop skips the paths not yet read or prepared.
export async function lookAt(paths, fs, prepare, signal) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Give look at least one image path in `paths`.');
  if (paths.length > LOOK_MAX) throw new Error(`look takes at most ${LOOK_MAX} paths per call (got ${paths.length}); split them into several calls.`);
  const lines = [], images = [];
  for (const p of [...new Set(paths.map(absPath))]) {
    signal?.throwIfAborted();
    const tooBig = (n) => `${p}: not sent. It is ${n.toLocaleString('en-US')} bytes; look reads files up to 20 MB.`;
    let bytes;
    try {
      const size = (await fs.stat(p)).size; // a mounted folder's file can be huge: refuse before reading it
      signal?.throwIfAborted();
      if (size > FILE_CAP) { lines.push(tooBig(size)); continue; }
      bytes = await fs.readFileBuffer(p);
      signal?.throwIfAborted();
    } catch (e) { if (signal?.aborted) throw e; lines.push(`${p}: not sent. ${explain(e, p).message}`); continue; }
    if (bytes.length > FILE_CAP) { lines.push(tooBig(bytes.length)); continue; }
    const mime = rasterMime(bytes);
    if (!mime) {
      lines.push(`${p}: not sent. ${isSvg(p, bytes) ? 'SVG is not sent as an image; it is text, so read its markup with the read tool.' : 'It is not a PNG, JPEG, GIF or WebP image; check it with bash `file ' + p + '`.'}`);
      continue;
    }
    try {
      const r = await prepare(bytes);
      signal?.throwIfAborted();
      images.push(r.image);
      const kind = mime.slice(6).toUpperCase();
      const sent = r.sentWidth === r.width && r.sentHeight === r.height ? `sent at full size as ${r.image.mimeType.slice(6).toUpperCase()}` : `sent scaled to ${r.sentWidth}x${r.sentHeight} ${r.image.mimeType.slice(6).toUpperCase()}`;
      lines.push(`${p}: image ${images.length}, ${kind} ${r.width}x${r.height}, ${sent}, ${r.bytes.toLocaleString('en-US')} bytes`);
    } catch (e) { if (signal?.aborted) throw e; lines.push(`${p}: not sent. ${e.message}`); }
  }
  if (!images.length) throw new Error(lines.join('\n'));
  lines.push(`[${images.length} image${images.length > 1 ? 's' : ''} attached in this order; they count toward this conversation's context]`);
  return { text: lines.join('\n'), images };
}

export function createTools(vfs, Type, bashOptions = {}, hooks = {}) {
  const abs = absPath;
  // A subagent works in its own namespace (hooks.namespaceFor(caller) gives
  // its mounts), reached over a 9P connection like any task across a
  // boundary: the page serves a capability view cut from the agent's tree and
  // the subagent's tools mount the far end.
  // Writes are attributed for file watches (src/ns/watch.js): the main
  // agent's tools as 'agent', its run calls as 'run', a subagent's as itself.
  // A subagent reaches its namespace over 9P; `run` needs the namespace
  // itself (it builds the run's narrower one from it), so nsFor hands that out.
  const views = new Map(); // caller -> { key, fs, ns, close }
  function viewOf(caller) {
    const specs = hooks.namespaceFor?.(caller);
    if (!specs) return null;
    const key = specs.join(',');
    const had = views.get(caller);
    if (had?.key === key) return had;
    had?.close();
    const ns = subset(vfs.as ? vfs.as(hooks.sourceOf?.(caller) ?? 'subagent') : vfs.fs, specs, { scratch: new InMemoryFs() });
    const { port1, port2 } = new MessageChannel();
    const server = serve(port1, ns);
    const client = new Client(port2);
    const ready = client.connect();
    const remote = new NinepFs(client);
    // Calls wait for the 9P handshake; resolvePath and getAllPaths stay synchronous.
    const fs = new Proxy(remote, { get(t, k) {
      const v = t[k];
      if (typeof v !== 'function' || k === 'resolvePath' || k === 'getAllPaths') return typeof v === 'function' ? v.bind(t) : v;
      return async (...a) => { await ready; return v.apply(t, a); };
    } });
    const view = { key, fs, ns, close: () => { client.close(); server.close(); } };
    views.set(caller, view);
    return view;
  }
  // The main agent's own namespace adds its session's control files
  // (hooks.mainView, src/ns/control.js); `run` never gets them (nsFor).
  function viewFor(caller, source = 'agent') {
    const base = vfs.as ? vfs.as(source) : vfs.fs;
    return viewOf(caller)?.fs ?? (caller != null && hooks.mainView ? hooks.mainView(caller, base) : base);
  }
  // hooks.onChange(caller, op, path): each change a caller makes, for
  // /session/<sid>/changes. Watch attribution (vfs.as) names the kind of
  // writer but not its session, and sees only watched paths, so the tools
  // report here, where the caller is known.
  const noted = (caller, fs) => (hooks.onChange && caller != null ? noting(fs, (op, p) => hooks.onChange(caller, op, p)) : fs);
  const nsFor = (caller, source) => noted(caller, viewOf(caller)?.ns ?? (vfs.as ? vfs.as(source) : vfs.fs));
  const writableFor = (caller) => {
    const specs = hooks.namespaceFor?.(caller);
    if (!specs) return [CWD, '/tmp'];
    const rw = specs.filter((x) => !/:ro$/.test(x)).map((x) => x.replace(/:rw$/, '')).filter((x) => !x.startsWith('/pouch'));
    return [...rw, '/tmp'];
  };
  const fsFor = (caller, source) => noted(caller, viewFor(caller, source));
  const fs = fsFor(undefined);
  // One interpreter per call, bound to its caller and its own list of what it
  // sent (the main agent and subagents run bash concurrently); the filesystem
  // underneath is shared and persistent.
  function bashFor(caller, sent) {
    const cli = bayleafCommands(defineCommand, {
      bayleafCredential: () => hooks.bayleafCredential?.() ?? null,
      approveEgress: hooks.approveEgress && ((req) => hooks.approveEgress(req, caller)),
      onEgress: (e) => { sent.push(e); hooks.onEgress?.(e, caller); },
    });
    return new Bash({
      fs: tagWrites(fsFor(caller)), cwd: CWD,
      env: { HOME: CWD, USER: 'pouch', PATH: '/usr/bin:/bin' },
      commands: COMMANDS,
      // `models` (src/models-cli.js): hooks.models is the shared service; whoOf names the asker.
      // `open` refuses for agents and points to `show`; hooks.show(req, caller)
      // opens or offers it (src/open-cli.js, main.js show).
      customCommands: [...archiveCommands(defineCommand), ...cli, ...modelsCommands(defineCommand, hooks.models, () => hooks.modelsWho?.(caller) ?? { by: 'agent', caller }), ...agentOpenCommands(defineCommand),
        ...agentShowCommands(defineCommand, { show: hooks.show && ((req) => hooks.show(req, caller)) })],
      executionLimits: { maxCommandCount: 100_000, maxLoopIterations: 100_000 },
      ...bashOptions,
    });
  }

  const read = {
    name: 'read', label: 'Read',
    description: `Read a text file. Paths are absolute or relative to ${CWD}. Returns at most ${MAX_LINES} lines; use offset (1-based line) and limit to page through longer files.`,
    parameters: Type.Object({
      path: Type.String({ description: 'File path' }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: 'First line to return, 1-based' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum lines to return' })),
    }),
    async execute({ path, offset = 1, limit = MAX_LINES }) {
      const p = abs(path);
      const bytes = await fs.readFileBuffer(p).catch((e) => { throw explain(e, p); });
      if (bytes.subarray(0, 8000).includes(0)) return `${p} is a binary file (${bytes.length} bytes); it cannot be shown as text. Use bash \`file ${p}\` or \`od -c ${p} | head\`.`;
      const lines = new TextDecoder().decode(bytes).split('\n');
      if (offset > lines.length) return `${p} has only ${lines.length} lines; offset ${offset} is past the end.`;
      const end = Math.min(lines.length, offset - 1 + Math.min(limit, MAX_LINES));
      let text = lines.slice(offset - 1, end).join('\n');
      if (end < lines.length) text += `\n[lines ${offset}-${end} of ${lines.length}; continue with offset=${end + 1}]`;
      return clip(text) || '(empty file)';
    },
  };

  const write = {
    name: 'write', label: 'Write',
    description: 'Create or overwrite a file with the given content. Parent folders are created as needed. A non-empty file is saved ending with exactly one newline.',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute({ path, content }, opts = {}) { return oneAtATime(abs(path), () => writeOne({ path, content }, opts)); },
  };
  async function writeOne({ path, content }, { caller } = {}) {
      const p = abs(path), fs = fsFor(caller);
      const [text, fixed] = oneFinalNewline(content);
      try {
        await fs.mkdir(normalize(p + '/..'), { recursive: true });
        await fs.writeFile(p, text);
      } catch (e) { throw explain(e, p, writableFor(caller)); }
      vfs.changed();
      return `Wrote ${text.split('\n').length} lines (${text.length} characters) to ${p}${fixed ? ' (saved ending with exactly one newline)' : ''}`;
  }

  // One replacement, or several in order via `edits` (one call instead of one
  // per change, which small models otherwise burn their turn budget on).
  // All replacements are checked before anything is written.
  const edit = {
    name: 'edit', label: 'Edit',
    description: 'Replace exact text in a file. Each oldText must match exactly once (including whitespace and indentation) unless replaceAll is true. Read the file first. For several changes in one file, pass `edits` (applied in order, all or nothing) instead of oldText/newText. newText is made to end with a newline exactly when oldText does. The result shows the edited lines so you can check them.',
    parameters: Type.Object({
      path: Type.String(),
      oldText: Type.Optional(Type.String({ description: 'Exact text to find' })),
      newText: Type.Optional(Type.String({ description: 'Replacement text' })),
      replaceAll: Type.Optional(Type.Boolean()),
      edits: Type.Optional(Type.Array(Type.Object({
        oldText: Type.String(), newText: Type.String(), replaceAll: Type.Optional(Type.Boolean()),
      }), { description: 'Several replacements, applied in order' })),
    }),
    execute(args, opts = {}) { return oneAtATime(abs(args.path), () => editOne(args, opts)); },
  };
  async function editOne({ path, oldText, newText, replaceAll = false, edits }, { caller } = {}) {
      const p = abs(path), fs = fsFor(caller);
      let matched = 0;
      const list = (edits?.length ? edits : [{ oldText, newText, replaceAll }]).map((e) => { const [x, c] = matchNewline(e); matched += c; return x; });
      let text = await fs.readFile(p).catch((e) => { throw explain(e, p); });
      const starts = [];
      for (const [n, e] of list.entries()) {
        const which = list.length > 1 ? ` (edit ${n + 1} of ${list.length}; nothing was written)` : '';
        if (!e.oldText) throw new Error(`oldText is empty${which}; use write to create a file`);
        if (e.newText === undefined) throw new Error(`newText is missing${which}`);
        const count = text.split(e.oldText).length - 1;
        if (count === 0) {
          const hint = text.includes(e.oldText.trim()) ? ' It matches if you ignore leading/trailing whitespace: copy the exact indentation.' : ' Read the file again and copy the text exactly.';
          throw new Error(`oldText was not found in ${p}${which}.${hint}`);
        }
        if (count > 1 && !e.replaceAll) {
          const at = []; for (let i = text.indexOf(e.oldText); i >= 0 && at.length < 5; i = text.indexOf(e.oldText, i + 1)) at.push(lineOf(text, i));
          throw new Error(`oldText matches ${count} times in ${p} (lines ${at.join(', ')})${which}; include neighboring lines to make it unique, or set replaceAll.`);
        }
        starts.push([lineOf(text, text.indexOf(e.oldText)), e.newText.split('\n').length]);
        text = e.replaceAll ? text.split(e.oldText).join(e.newText) : text.replace(e.oldText, () => e.newText);
      }
      try { await fs.writeFile(p, text); } catch (e) { throw explain(e, p, writableFor(caller)); }
      vfs.changed();
      // Show each edited region with a line of context, numbered.
      const lines = text.split('\n');
      const shown = starts.slice(0, 5).map(([start, len]) => {
        const from = Math.max(1, start - 1), to = Math.min(lines.length, start + len);
        return lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
      }).join('\n...\n');
      const note = matched ? ` (newText's final newline was matched to oldText's${list.length > 1 ? ` in ${matched}` : ''})` : '';
      return `Applied ${list.length} edit${list.length > 1 ? 's' : ''} to ${p}${note}. Edited lines now read:\n${clip(shown)}`;
  }

  const bashTool = {
    name: 'bash', label: 'Bash',
    description: `Run a bash script in a simulated shell (just-bash) over the same files, starting in ${CWD}. ` +
      'Has coreutils, grep, rg, sed, awk, find, jq, diff, sort, xargs, and zip/unzip/tar (no compression flags). ' +
      `There is no network, no python, node, git or package manager, and no real processes (for real parsing or computation use the run tool). Each call starts fresh in ${CWD}; use \`cd dir && ...\` within one call. \`ls /bin\` lists every command. ` +
      '`bayleaf --help` for BayLeaf web search/fetch, sandbox VM and inboxes (these leave the pouch and ask the user).',
    parameters: Type.Object({ command: Type.String({ description: 'Bash script to run' }) }),
    async execute({ command }, { signal, caller } = {}) {
      const sent = [];
      const r = await execScript(bashFor(caller, sent), command, { cwd: CWD, signal });
      vfs.changed();
      // Marker the model and the UI both see: this call sent data outside the pouch.
      const egress = sent.length ? `\n[this call sent data outside the pouch: ${[...new Set(sent.map((e) => e.command.replace(/^bayleaf /, '')))].join(', ')}]` : '';
      let out = r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '');
      // Library-facing messages, restated for the agent.
      out = out.replace(/command not available in browser environments\. Exclude '[^']+' from your commands or use the Node\.js bundle\./g, 'command not available in Pouch.');
      if (/EROFS/.test(out)) out += `\n[hint: that folder is read-only for you; you can write under ${writableFor(caller).join(', ')}]`;
      // A silent failure ("exit 1" and nothing else) reads as an error with no
      // cause; small models then retry blindly (grep with no match is the usual one).
      if (r.exitCode !== 0 && !out.trim()) {
        throw new Error(`no output, exit ${r.exitCode}${/(^|[|;&(\s])(e?grep|rg)\s/.test(command) ? ` (for grep this means no matches; paths are relative to ${CWD})` : ''}${egress}`);
      }
      out = (clip(out.trimEnd()) || '(no output)') + egress;
      if (r.exitCode !== 0) throw new Error(`${out}\n[exit code ${r.exitCode}]`);
      return out;
    },
  };

  // Pixels reach the model only through this tool, never from read: sending an
  // image is an explicit, countable act the transcript shows (JOURNEYS AG1).
  // opts.seesImages is false for a text-only model (agent.js toTool): a plain
  // refusal, never a silent send or a silent drop.
  const prepare = hooks.prepareImage ?? prepareImageSized;
  const look = {
    name: 'look', label: 'Look', images: true,
    description: `See image files: each PNG, JPEG, GIF (first frame) or WebP is sent to you as an image, scaled to at most 2000px and 4 MB (the file is unchanged). At most ${LOOK_MAX} paths per call. Images count toward the conversation's context; look only when seeing the pixels matters.`,
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: LOOK_MAX, description: `Image files, absolute or relative to ${CWD} (at most ${LOOK_MAX})` }),
      note: Type.Optional(Type.String({ description: 'What you are looking for (shown to the user)' })),
    }),
    async execute({ paths }, { caller, seesImages, signal } = {}) {
      if (seesImages === false) throw new Error(LOOK_REFUSAL);
      return lookAt(paths, fsFor(caller), prepare, signal);
    },
  };

  const run = runTool({ vfs, Type, CWD, abs, fsFor: (caller) => nsFor(caller, 'run'), sidOf: (caller) => hooks.sessionOf?.(caller) ?? null, oneAtATime, ...(hooks.makeWorker ? { makeWorker: hooks.makeWorker } : {}) });
  // closeView(caller): drop a finished subagent's 9P connection.
  return Object.assign([read, write, edit, bashTool, run, look], { closeView: (caller) => { views.get(caller)?.close(); views.delete(caller); } });
}

// ── Context: AGENTS.md files and skills ─────────────────────────────
// Instructions load from the shared /pouch tree and from the workspace; skills
// are advertised by name and description only, and the model reads SKILL.md
// with the read tool when one applies (progressive disclosure). A skill whose
// frontmatter says `listed: false` is unlisted: left out of the prompt's list
// but still loadable by name or path (another skill or the user names it).
const AGENTS_FILES = ['/pouch/AGENTS.md', '/work/AGENTS.md'];
const SKILL_ROOTS = ['/pouch/skills', '/work/.agents/skills'];

function frontmatter(text) {
  const m = text.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  for (const line of m?.[1].split('\n') ?? []) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    // Only a YAML boolean false unlists; "false" (quoted), absent or junk stays listed.
    if (kv?.[1] === 'listed') out.listed = !/^(false|False|FALSE)$/.test(kv[2].replace(/\s+#.*$/, '').trim());
  }
  return out;
}

export async function loadContext(vfs) {
  const agents = [];
  for (const p of AGENTS_FILES) {
    try { agents.push({ path: p, text: await vfs.fs.readFile(p) }); } catch {}
  }
  const skills = [];
  for (const root of SKILL_ROOTS) {
    let names = [];
    try { names = await vfs.fs.readdir(root); } catch { continue; }
    for (const name of names) {
      const path = `${root}/${name}/SKILL.md`;
      try {
        const fm = frontmatter(await vfs.fs.readFile(path));
        skills.push({ name: fm.name || name, description: fm.description || '', path, ...(fm.requests ? { requests: fm.requests } : {}), ...(fm.listed === false ? { unlisted: true } : {}) });
      } catch {}
    }
  }
  return { agents, skills };
}

// What a subagent sees unless its spawn says otherwise: the workspace,
// instructions and skills read-only, the folders the user mounted (as
// mounted), and a private /tmp. Not /task: it cannot stop its siblings.
export function defaultSubagentNs(vfs) {
  return ['/work', '/pouch:ro', ...[...vfs.mounts].filter(([, m]) => m.live).map(([n, m]) => `/mnt/${n}${m.readOnly ? ':ro' : ''}`)];
}
// Mount lines for a list of specs, as /task/<id>/ns and the trust panel show them.
export function describeSpecs(vfs, specs) { return subset(vfs.fs, specs, { scratch: new InMemoryFs() }).describe(); }

export async function systemPrompt(vfs) {
  const { agents, skills } = await loadContext(vfs);
  const mounts = [...vfs.mounts].filter(([, m]) => m.live)
    .map(([n, m]) => `/mnt/${n}${m.readOnly ? ' (read-only)' : ''}`);
  let s = `You are BayLeaf Pouch, a coding agent running entirely inside the user's web browser.
You work on files through the read, write, edit, bash, run and look tools. Filesystem:
- ${CWD}: the user's workspace (browser-private storage). Default working directory.
- /pouch: shared instructions (AGENTS.md) and skills (skills/<name>/SKILL.md).
- /tmp: scratch, lost on reload.
- /task: this session's running and recent run calls and subagents as files: \`cat /task/<id>/status\`, \`cat /task/<id>/ns\` (what it can see), \`echo kill > /task/<id>/ctl\`.
- /session/current: your session's agents as files: \`cat /session/current/status\`, \`cat /session/current/agents/a2/status\`, \`echo stop > /session/current/agents/a2/ctl\` (message agents with the agents tool, not files). \`cat /session/current/usage\` shows your remaining allowance and requests this turn; \`cat /session/current/changes\` lists the paths you and your subagents changed since the user's message (check your summary against it).
${vfs.seedLayer ? `- ${CWD} is stacked over the read-only seed archive ${vfs.seedLayer.name}: your files win, edits land in ${CWD}, removing a seed file hides it.\n` : ''}${mounts.length ? '- Folders the user mounted from their device: ' + mounts.join(', ') + '\n' : ''}The bash tool is a simulated shell with coreutils-like commands plus zip/unzip/tar: no network, no installs, no python/node/git.
The run tool executes JavaScript (QuickJS) over a copy of the files you name, with no network: use it instead of awk/sed/jq for anything that needs real parsing (quoted CSV, nested JSON) or arithmetic, and to test JavaScript; save reusable scripts in ${CWD} and run them by path. Its file writes are applied to the workspace when it finishes.
The one exception is the \`bayleaf\` command (web search/fetch, a remote sandbox VM, inboxes): it leaves the pouch and asks the user each time; see the bayleaf-cli skill.
The look tool shows you image files (PNG, JPEG, GIF, WebP; at most ${LOOK_MAX} per call): use it when the user points at an image, or to check a chart or picture you made, not for text files. Images count toward context; it fails on models without images.
The subagent tool runs a self-contained task (web research, exploring a codebase) in a background subagent while you keep talking with the user: use it when the user asks for background work or when such a task would take many steps. Each subagent step costs a request from the same daily allowance; its report arrives later as a message, so do not poll for it.
${GRAPH_GLOSS} You are main (a1); only you spawn and stop subagents.
${WATCH_GLOSS}
${UL_GLOSS}
The user can open any file in the editor and download any file or folder (as .zip) from the file browser. Markdown, HTML, SVG, images, audio and video files also have a preview.
When a result is worth seeing (a report, a file you changed, a folder of outputs), show it: bash \`show <path>\` puts it in front of the user (\`open\` is theirs). It opens now, or waits in the transcript with an Open button if they are busy; the one line it prints says which.
When a visual report would help, write one self-contained .html file (inline CSS and JS, images as data: URLs; nothing loads from the network, and scripts are off unless the user turns them on), then show it or link it: it opens in the preview.
Keep changes minimal: prefer edit over rewriting files, and do not reformat or restyle existing code unless asked (conventions apply to code you write). Be concise. Say what you changed.
Replies render as markdown. Refer to files as markdown links like [app.js](/work/app.js) or [app.js:12](/work/app.js:12): they open in the user's editor.`;
  for (const a of agents) s += `\n\n<instructions source="${a.path}">\n${a.text.trim()}\n</instructions>`;
  if (skills.length) {
    s += '\n\n<skills>\nRead a skill\'s SKILL.md before acting on a task it covers. Skills not listed here can still be named: read /pouch/skills/<name>/SKILL.md or /work/.agents/skills/<name>/SKILL.md.\n';
    for (const k of skills) if (!k.unlisted) s += `- ${k.name}: ${k.description} (${k.path})\n`;
    s += '</skills>';
  }
  return s;
}
