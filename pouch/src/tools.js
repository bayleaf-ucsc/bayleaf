// The four tools every coding harness converges on: read, write, edit, bash,
// plus `run` (src/run.js: JavaScript in a sandboxed QuickJS worker).
// They run in this page against the Vfs; nothing here touches the network.
// just-bash is a TypeScript reimplementation of bash and coreutils, so `bash`
// is an interpreter over the same files, not a real process.
import { GRAPH_GLOSS } from './subagents.js';
import { Bash, InMemoryFs, defineCommand, getCommandNames } from 'just-bash';
import { normalize } from './vfs.js';
import { subset } from './ns/namespace.js';
import { serve, Client, NinepFs } from './ns/9p.js';
import { archiveCommands } from './archive.js';
import { bayleafCommands } from './bayleaf-cli.js';
import { runTool } from './run.js';
import { WATCH_GLOSS } from './ns/watch.js';

const MAX_LINES = 2000;
const MAX_CHARS = 50_000;
export const CWD = '/work';

// just-bash's browser build lacks these, or (gzip family) would call our
// zlib stub and throw; leave them out so the shell says "command not found".
// zip, unzip and tar come back as Pouch's own commands (archive.js).
const MISSING = new Set(['tar', 'yq', 'xan', 'sqlite3', 'python', 'python3', 'js-exec', 'node', 'gzip', 'gunzip', 'zcat', 'curl']);
export const COMMANDS = getCommandNames().filter((c) => !MISSING.has(c));

function clip(text) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + `\n[truncated: ${text.length - MAX_CHARS} more characters]`;
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
export function createTools(vfs, Type, bashOptions = {}, hooks = {}) {
  const abs = (p) => normalize(p.startsWith('/') ? p : CWD + '/' + p);
  // One model message can carry several calls, and they run concurrently: two
  // edits of one file would both read the original and the last write would
  // win (seen in t17: a rename lost its import change). Edits and writes of
  // the same path therefore take turns.
  const turns = new Map(); // path -> tail of its queue
  const oneAtATime = (p, fn) => {
    const run = (turns.get(p) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    turns.set(p, tail);
    tail.then(() => { if (turns.get(p) === tail) turns.delete(p); });
    return run;
  };
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
  function viewFor(caller, source = 'agent') {
    return viewOf(caller)?.fs ?? (vfs.as ? vfs.as(source) : vfs.fs);
  }
  const nsFor = (caller, source) => viewOf(caller)?.ns ?? (vfs.as ? vfs.as(source) : vfs.fs);
  const writableFor = (caller) => {
    const specs = hooks.namespaceFor?.(caller);
    if (!specs) return [CWD, '/tmp'];
    const rw = specs.filter((x) => !/:ro$/.test(x)).map((x) => x.replace(/:rw$/, '')).filter((x) => !x.startsWith('/pouch'));
    return [...rw, '/tmp'];
  };
  const fsFor = (caller, source) => viewFor(caller, source);
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
      fs: fsFor(caller), cwd: CWD,
      env: { HOME: CWD, USER: 'pouch', PATH: '/usr/bin:/bin' },
      commands: COMMANDS,
      customCommands: [...archiveCommands(defineCommand), ...cli],
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
      const r = await bashFor(caller, sent).exec(command, { cwd: CWD, signal });
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

  const run = runTool({ vfs, Type, CWD, abs, fsFor: (caller) => nsFor(caller, 'run'), oneAtATime, ...(hooks.makeWorker ? { makeWorker: hooks.makeWorker } : {}) });
  // closeView(caller): drop a finished subagent's 9P connection.
  return Object.assign([read, write, edit, bashTool, run], { closeView: (caller) => { views.get(caller)?.close(); views.delete(caller); } });
}

// ── Context: AGENTS.md files and skills ─────────────────────────────
// Instructions load from the shared /pouch tree and from the workspace; skills
// are advertised by name and description only, and the model reads SKILL.md
// with the read tool when one applies (progressive disclosure).
const AGENTS_FILES = ['/pouch/AGENTS.md', '/work/AGENTS.md'];
const SKILL_ROOTS = ['/pouch/skills', '/work/.agents/skills'];

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  for (const line of m?.[1].split('\n') ?? []) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
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
        skills.push({ name: fm.name || name, description: fm.description || '', path, ...(fm.requests ? { requests: fm.requests } : {}) });
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
You work on files through the read, write, edit, bash and run tools. Filesystem:
- ${CWD}: the user's workspace (browser-private storage). Default working directory.
- /pouch: shared instructions (AGENTS.md) and skills (skills/<name>/SKILL.md).
- /tmp: scratch, lost on reload.
- /task: running and recent run calls and subagents as files: \`cat /task/<id>/status\`, \`cat /task/<id>/ns\` (what it can see), \`echo kill > /task/<id>/ctl\`.
${vfs.seedLayer ? `- ${CWD} is stacked over the read-only seed archive ${vfs.seedLayer.name}: your files win, edits land in ${CWD}, removing a seed file hides it.\n` : ''}${mounts.length ? '- Folders the user mounted from their device: ' + mounts.join(', ') + '\n' : ''}The bash tool is a simulated shell with coreutils-like commands plus zip/unzip/tar: no network, no installs, no python/node/git.
The run tool executes JavaScript (QuickJS) over a copy of the files you name, with no network: use it instead of awk/sed/jq for anything that needs real parsing (quoted CSV, nested JSON) or arithmetic, and to test JavaScript; save reusable scripts in ${CWD} and run them by path. Its file writes come back as reviewable changes.
The one exception is the \`bayleaf\` command (web search/fetch, a remote sandbox VM, inboxes): it leaves the pouch and asks the user each time; see the bayleaf-cli skill.
The subagent tool runs a self-contained task (web research, exploring a codebase) in a background subagent while you keep talking with the user: use it when the user asks for background work or when such a task would take many steps. Each subagent step costs a request from the same daily allowance; its report arrives later as a message, so do not poll for it.
${GRAPH_GLOSS} You are main (s1); only you spawn and stop subagents.
${WATCH_GLOSS}
The user sees your file changes in the chat, can review a diff of each and undo it, and can download any file or folder (as .zip) from the file browser.
Keep changes minimal: prefer edit over rewriting files, and do not reformat or restyle existing code unless asked (conventions apply to code you write). Be concise. Say what you changed.
Replies render as markdown. Refer to files as markdown links like [app.js](/work/app.js) or [app.js:12](/work/app.js:12): they open in the user's editor.`;
  for (const a of agents) s += `\n\n<instructions source="${a.path}">\n${a.text.trim()}\n</instructions>`;
  if (skills.length) {
    s += '\n\n<skills>\nRead a skill\'s SKILL.md before acting on a task it covers.\n';
    for (const k of skills) s += `- ${k.name}: ${k.description} (${k.path})\n`;
    s += '</skills>';
  }
  return s;
}
