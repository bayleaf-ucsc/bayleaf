// The `run` tool (story D18): JavaScript in QuickJS (WebAssembly) inside a
// throwaway worker that sees only a snapshot of the files it names. No
// network, credentials or storage: the guest's whole world is src/run/core.js.
// Its writes come back as proposed changes and are applied through the same
// recording fs as every other tool, so they show under the turn (Diff, Undo).
// The engine is behind runInWorker's message protocol, so another runtime
// (Pyodide) could sit behind the same tool later.
import { DEFAULT_LIMITS, normalize, sha256 } from './run/core.js';
import { runInWorker, applyChanges } from './run/host.js';

// What the agent may ask for; it can lower these, never raise them.
const CAPS = { timeMs: 5000, memoryMB: 64, outputKB: 64 };
// The snapshot: copied into the worker, so keep it bounded.
export const SNAPSHOT = { maxFiles: 500, maxBytes: 16 << 20, maxFileBytes: 4 << 20 };

// WORKER_SRC is the bundled src/run/worker-browser.js (build.mjs defines it).
// A blob: worker inherits the page CSP: connect-src api.bayleaf.dev only, and
// no eval; the worker also drops fetch and storage after loading the engine.
function browserWorker() {
  if (typeof WORKER_SRC === 'undefined') throw new Error('this build has no run engine');
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  try { return new Worker(url); } finally { URL.revokeObjectURL(url); }
}

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const hasGlob = (s) => /[*?[]/.test(s);
function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// Expand paths, folders (recursively) and globs to file paths, stopping as
// soon as the caps are passed so a huge tree fails fast with a clear message.
async function expand(fs, specs, abs) {
  const out = new Set();
  const over = () => out.size > SNAPSHOT.maxFiles;
  async function walk(dir, match) {
    let names; try { names = await fs.readdir(dir); } catch { return; }
    for (const n of names) {
      if (over()) return;
      const p = normalize(dir + '/' + n);
      const st = await fs.stat(p).catch(() => null);
      if (st?.isDirectory) await walk(p, match);
      else if (st && (!match || match.test(p))) out.add(p);
    }
  }
  for (const spec of specs) {
    const p = abs(spec);
    if (hasGlob(p)) {
      const base = p.split('/').filter((x, i, a) => !a.slice(0, i + 1).some(hasGlob)).join('/') || '/';
      await walk(base, globRegex(p));
      continue;
    }
    const st = await fs.stat(p).catch(() => null);
    if (!st) throw new Error(`files: ${p} does not exist`);
    if (st.isDirectory) await walk(p); else out.add(p);
    if (over()) break;
  }
  if (over()) throw new Error(`the snapshot would have more than ${SNAPSHOT.maxFiles} files; name the files you need in \`files\` (paths or globs like /work/data/*.csv)`);
  return [...out].sort();
}

// tools.js passes its helpers so `run` shares path rules, errors and recording.
export function runTool({ vfs, Type, CWD, abs, fsFor, makeWorker = browserWorker }) {
  return {
    name: 'run', label: 'Run',
    description: 'Run JavaScript (QuickJS, ES2023, no Node or browser APIs) when bash/awk is not enough: real parsing (CSV with quotes, JSON), arithmetic, data transforms. ' +
      'Give `code`, or `path` of a .js file in the workspace. The script sees only a copy of the files in `files` (paths, folders or globs; default: the script\'s folder, or ' + CWD + ' for inline code). ' +
      `Guest API: console.log/print, args, stdin, exit(code), fs.readFile/readBytes/writeFile/exists/rm/readdir (relative paths start at ${CWD}). ` +
      'No network, no imports, no timers. Files it writes are applied afterwards (shown to the user as changes); a file changed meanwhile is reported as a conflict and left alone. ' +
      `Limits: ${CAPS.timeMs} ms, ${CAPS.memoryMB} MB, ${CAPS.outputKB} KB output (you may lower them).`,
    parameters: Type.Object({
      code: Type.Optional(Type.String({ description: 'JavaScript source to run' })),
      path: Type.Optional(Type.String({ description: 'A .js file to run instead of code' })),
      files: Type.Optional(Type.Array(Type.String(), { description: 'Paths, folders or globs to copy in' })),
      args: Type.Optional(Type.Array(Type.String())),
      stdin: Type.Optional(Type.String()),
      limits: Type.Optional(Type.Object({
        timeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: CAPS.timeMs })),
        memoryMB: Type.Optional(Type.Integer({ minimum: 1, maximum: CAPS.memoryMB })),
        outputKB: Type.Optional(Type.Integer({ minimum: 1, maximum: CAPS.outputKB })),
      })),
    }),
    async execute({ code, path, files, args = [], stdin = '', limits = {} }, { signal, caller } = {}) {
      if ((code == null) === (path == null)) throw new Error('give exactly one of `code` or `path`');
      const fs = fsFor(caller);
      let filename = CWD + '/main.js', home = CWD;
      if (path != null) {
        filename = abs(path);
        code = await fs.readFile(filename).catch(() => { throw new Error(`${filename} does not exist; write the script first, or pass it as \`code\``); });
        home = normalize(filename + '/..');
      }
      const paths = await expand(fs, files?.length ? files : [home], abs);
      const snap = [];
      let total = 0;
      for (const p of paths) {
        const bytes = new Uint8Array(await fs.readFileBuffer(p));
        if (bytes.byteLength > SNAPSHOT.maxFileBytes) throw new Error(`${p} is ${kb(bytes.byteLength)}, over the ${kb(SNAPSHOT.maxFileBytes)} per-file snapshot limit; leave it out of \`files\``);
        total += bytes.byteLength;
        if (total > SNAPSHOT.maxBytes) throw new Error(`the snapshot would exceed ${kb(SNAPSHOT.maxBytes)}; name fewer files in \`files\``);
        snap.push({ path: p, bytes, hash: await sha256(bytes) });
      }
      const clamp = (v, cap) => Math.max(1, Math.min(cap, v ?? cap));
      const request = {
        code, filename, cwd: CWD, args: args.map(String), stdin: String(stdin), files: snap,
        limits: { ...DEFAULT_LIMITS, maxFiles: SNAPSHOT.maxFiles, maxFileBytes: SNAPSHOT.maxFileBytes,
          timeMs: clamp(limits.timeMs, CAPS.timeMs), memoryBytes: clamp(limits.memoryMB, CAPS.memoryMB) << 20,
          maxOutputBytes: clamp(limits.outputKB, CAPS.outputKB) << 10 },
      };
      const r = await runInWorker(makeWorker, request, { signal });
      if (r.status === 'cancelled' && signal?.aborted) throw new Error('Stopped.');

      // Apply what the guest wrote, unless the run was cut off mid-way.
      const cut = ['timeout', 'oom', 'cancelled'].includes(r.status);
      let applied = [], conflicts = [];
      if (!cut && r.changes.length) {
        const target = { exists: (p) => fs.exists(p), readFileBuffer: (p) => fs.readFileBuffer(p), rm: (p) => fs.rm(p),
          writeFile: async (p, b) => { await fs.mkdir(normalize(p + '/..'), { recursive: true }); await fs.writeFile(p, b); } };
        ({ applied, conflicts } = await applyChanges(target, r.changes));
        vfs.changed();
      }
      const sizes = new Map(r.changes.map((c) => [c.path, c.bytes?.byteLength]));
      const verb = { create: 'created', modify: 'modified', delete: 'deleted' };
      let text = `status: ${r.status}, exit code ${r.exitCode}, ${r.ms} ms${r.message ? `\n${r.message}` : ''}`;
      if (r.stdout) text += `\nstdout:\n${r.stdout.trimEnd()}`;
      if (r.stderr) text += `\nstderr:\n${r.stderr.trimEnd()}`;
      if (r.truncated) text += `\n[output truncated at ${request.limits.maxOutputBytes >> 10} KB]`;
      if (!r.stdout && !r.stderr && !r.message) text += '\n(no output)';
      // At most 20 names per list, so a script that writes hundreds of files stays readable.
      const list = (xs, f) => xs.slice(0, 20).map(f).join(', ') + (xs.length > 20 ? `, and ${xs.length - 20} more` : '');
      if (applied.length) text += `\nchanges applied (${applied.length}): ` + list(applied, (c) => `${verb[c.op]} ${c.path}${sizes.get(c.path) != null ? ` (${kb(sizes.get(c.path))})` : ''}`);
      if (conflicts.length) text += `\nconflicts, not applied (${conflicts.length}): ` + list(conflicts, (c) => `${c.path} (${c.reason}${c.error ? ': ' + c.error : ''})`) + '. Read the file again and rerun.';
      if (cut && r.changes.length) text += `\n${r.changes.length} proposed change(s) discarded because the run did not finish.`;
      if (r.exitCode !== 0) throw new Error(text);
      return text;
    },
  };
}
