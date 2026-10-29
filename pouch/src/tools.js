// The four tools every coding harness converges on: read, write, edit, bash.
// They run in this page against the Vfs; nothing here touches the network.
// just-bash is a TypeScript reimplementation of bash and coreutils, so `bash`
// is an interpreter over the same files, not a real process.
import { Bash, defineCommand, getCommandNames } from 'just-bash';
import { normalize } from './vfs.js';
import { archiveCommands } from './archive.js';
import { bayleafCommands } from './bayleaf-cli.js';

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
function explain(e, p) {
  const code = e.code ?? e.message.match(/^(E[A-Z]+)/)?.[1];
  const dir = normalize(p + '/..');
  switch (code) {
    case 'ENOENT': return new Error(`${p} does not exist. List ${dir} with bash \`ls ${dir}\`, or search with \`find ${CWD} -name '<name>'\`.`);
    case 'EISDIR': return new Error(`${p} is a folder, not a file. List it with bash \`ls ${p}\`.`);
    case 'ENOTDIR': return new Error(`A part of ${p} is a file, not a folder.`);
    case 'EROFS': return new Error(`${p} is in a read-only folder. Write your result under ${CWD} instead, e.g. ${CWD}/${p.split('/').pop()}.`);
    case 'ENOTSUP': return new Error(`This browser cannot write ${p}. Write under ${CWD} instead.`);
    default: return e;
  }
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Every change any tool makes passes through here first, so the UI can list
// changed files, show diffs and undo (story map R2, R3, R5). `before(path)`
// receives the absolute path and the operation name before the first write;
// the host reads the old bytes itself. Paths are absolute because Bash always
// resolves them. The op lets the host tell a move from a delete plus a create.
function recording(fs, before) {
  const wrap = (op, ...idx) => async (...a) => { for (const i of idx) await before(normalize(a[i]), op); return fs[op](...a); };
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'writeFile' || prop === 'appendFile' || prop === 'rm') return wrap(prop, 0);
      if (prop === 'mv') return wrap('mv', 0, 1);
      if (prop === 'cp') return wrap('cp', 1);
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// hooks.beforeChange(path, op, caller) is optional; see recording() above.
// The `bayleaf` command's hooks pass through (src/bayleaf-cli.js):
// bayleafCredential(), approveEgress(request, caller) (absent: every send is
// denied) and onEgress(event, caller). Each bash call also lists what it sent
// in its result. `caller` is the calling conversation (agent.js toTool), so
// the host can tell a subagent from the main agent; calls may run at once.
export function createTools(vfs, Type, bashOptions = {}, hooks = {}) {
  const abs = (p) => normalize(p.startsWith('/') ? p : CWD + '/' + p);
  const fsFor = (caller) => recording(vfs.fs, async (p, op) => { await hooks.beforeChange?.(p, op, caller); });
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
    description: 'Create or overwrite a file with the given content. Parent folders are created as needed.',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute({ path, content }, { caller } = {}) {
      const p = abs(path), fs = fsFor(caller);
      try {
        await fs.mkdir(normalize(p + '/..'), { recursive: true });
        await fs.writeFile(p, content);
      } catch (e) { throw explain(e, p); }
      vfs.changed();
      return `Wrote ${content.split('\n').length} lines (${content.length} characters) to ${p}`;
    },
  };

  // One replacement, or several in order via `edits` (one call instead of one
  // per change, which small models otherwise burn their turn budget on).
  // All replacements are checked before anything is written.
  const edit = {
    name: 'edit', label: 'Edit',
    description: 'Replace exact text in a file. Each oldText must match exactly once (including whitespace and indentation) unless replaceAll is true. Read the file first. For several changes in one file, pass `edits` (applied in order, all or nothing) instead of oldText/newText. The result shows the edited lines so you can check them.',
    parameters: Type.Object({
      path: Type.String(),
      oldText: Type.Optional(Type.String({ description: 'Exact text to find' })),
      newText: Type.Optional(Type.String({ description: 'Replacement text' })),
      replaceAll: Type.Optional(Type.Boolean()),
      edits: Type.Optional(Type.Array(Type.Object({
        oldText: Type.String(), newText: Type.String(), replaceAll: Type.Optional(Type.Boolean()),
      }), { description: 'Several replacements, applied in order' })),
    }),
    async execute({ path, oldText, newText, replaceAll = false, edits }, { caller } = {}) {
      const p = abs(path), fs = fsFor(caller);
      const list = edits?.length ? edits : [{ oldText, newText, replaceAll }];
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
      try { await fs.writeFile(p, text); } catch (e) { throw explain(e, p); }
      vfs.changed();
      // Show each edited region with a line of context, numbered.
      const lines = text.split('\n');
      const shown = starts.slice(0, 5).map(([start, len]) => {
        const from = Math.max(1, start - 1), to = Math.min(lines.length, start + len);
        return lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
      }).join('\n...\n');
      return `Applied ${list.length} edit${list.length > 1 ? 's' : ''} to ${p}. Edited lines now read:\n${clip(shown)}`;
    },
  };

  const bashTool = {
    name: 'bash', label: 'Bash',
    description: `Run a bash script in a simulated shell (just-bash) over the same files, starting in ${CWD}. ` +
      'Has coreutils, grep, rg, sed, awk, find, jq, diff, sort, xargs, and zip/unzip/tar (no compression flags). ' +
      `There is no network, no python, node, git or package manager, and no real processes. Each call starts fresh in ${CWD}; use \`cd dir && ...\` within one call. \`ls /bin\` lists every command. ` +
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
      if (/EROFS/.test(out)) out += `\n[hint: that folder is mounted read-only; write under ${CWD} instead]`;
      out = (clip(out.trimEnd()) || '(no output)') + egress;
      if (r.exitCode !== 0) throw new Error(`${out}\n[exit code ${r.exitCode}]`);
      return out;
    },
  };

  return [read, write, edit, bashTool];
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
        skills.push({ name: fm.name || name, description: fm.description || '', path });
      } catch {}
    }
  }
  return { agents, skills };
}

export async function systemPrompt(vfs) {
  const { agents, skills } = await loadContext(vfs);
  const mounts = [...vfs.mounts].filter(([, m]) => m.live)
    .map(([n, m]) => `/mnt/${n}${m.readOnly ? ' (read-only)' : ''}`);
  let s = `You are BayLeaf Pouch, a coding agent running entirely inside the user's web browser.
You work on files through the read, write, edit and bash tools. Filesystem:
- ${CWD}: the user's workspace (browser-private storage). Default working directory.
- /pouch: shared instructions (AGENTS.md) and skills (skills/<name>/SKILL.md).
- /tmp: scratch, lost on reload.
${mounts.length ? '- Folders the user mounted from their device: ' + mounts.join(', ') + '\n' : ''}The bash tool is a simulated shell with coreutils-like commands plus zip/unzip/tar: no network, no installs, no python/node/git, so you cannot run or test code here; say so when it matters.
The one exception is the \`bayleaf\` command (web search/fetch, a remote sandbox VM, inboxes): it leaves the pouch and asks the user each time; see the bayleaf-cli skill.
The subagent tool runs a self-contained task (web research, exploring a codebase) in a background subagent while you keep talking with the user: use it when the user asks for background work or when such a task would take many steps. Each subagent step costs a request from the same daily allowance; its report arrives later as a message, so do not wait or poll for it.
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
