// The `run` tool (story D18): JavaScript in QuickJS (WebAssembly) inside a
// throwaway worker. No network, credentials or storage: the guest's whole
// world is src/run/core.js and a snapshot of the files it names.
//
// Namespaces: each run gets its own namespace (src/ns/namespace.js), by
// default /work plus the roots of the files it names and a private scratch
// /tmp (or what the call declares in `ns`), and the worker reaches it only as
// a 9P connection (src/ns/9p.js) over a MessagePort. It reads its snapshot
// through that connection and writes the guest's changes back through it
// (src/run/over9p.js says why it is still snapshot-in / diff-out). Every
// write lands through the same recording fs as every other tool, one path at
// a time, so it shows under the turn (Diff, Undo). Stop or `echo kill >
// /task/<id>/ctl` flushes the 9P server first, so nothing lands after it.
// The engine is behind runInWorker's message protocol, so another runtime
// (Pyodide) could sit behind the same tool later.
import { InMemoryFs } from 'just-bash';
import { DEFAULT_LIMITS, normalize } from './run/core.js';
import { runInWorker } from './run/host.js';
import { SNAPSHOT, globBase } from './run/over9p.js';
import { serve } from './ns/9p.js';
import { parseSpecs, subset, within } from './ns/namespace.js';

export { SNAPSHOT };

// What the agent may ask for; it can lower these, never raise them.
const CAPS = { timeMs: 5000, memoryMB: 64, outputKB: 64 };

// WORKER_SRC is the bundled src/run/worker-browser.js (build.mjs defines it).
// A blob: worker inherits the page CSP: connect-src api.bayleaf.dev only, and
// no eval; the worker also drops fetch and storage after loading the engine.
function browserWorker() {
  if (typeof WORKER_SRC === 'undefined') throw new Error('this build has no run engine');
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  try { return new Worker(url); } finally { URL.revokeObjectURL(url); }
}

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

// The mount a path belongs to in the agent's namespace: /work, /pouch,
// /mnt/<name>, or the top folder of the in-memory root (/tmp, /home).
function rootOf(fs, p) {
  const { point } = fs.layers(p);
  return point === '/' ? '/' + (p.split('/')[1] ?? '') : point;
}

// tools.js passes its helpers so `run` shares path rules, errors and recording.
export function runTool({ vfs, Type, CWD, abs, fsFor, oneAtATime = (_p, fn) => fn(), makeWorker = browserWorker }) {
  return {
    name: 'run', label: 'Run',
    description: 'Run JavaScript (QuickJS, ES2023, no Node or browser APIs) when bash/awk is not enough: real parsing (CSV with quotes, JSON), arithmetic, data transforms. ' +
      'Give `code`, or `path` of a .js file in the workspace. The script sees only a copy of the files in `files` (paths, folders or globs; default: the script\'s folder, or ' + CWD + ' for inline code). ' +
      `It can reach only its namespace: ${CWD} plus the folders \`files\` names, and a private scratch /tmp; \`ns\` narrows it (e.g. ["${CWD}/data:ro"]). ` +
      `Guest API: console.log/print, args, stdin, exit(code), fs.readFile/readBytes/writeFile/exists/rm/readdir (relative paths start at ${CWD}). ` +
      'No network, no imports, no timers. Files it writes are applied afterwards (shown to the user as changes); a file changed meanwhile is reported as a conflict and left alone. ' +
      `Limits: ${CAPS.timeMs} ms, ${CAPS.memoryMB} MB, ${CAPS.outputKB} KB output (you may lower them).`,
    parameters: Type.Object({
      code: Type.Optional(Type.String({ description: 'JavaScript source to run' })),
      path: Type.Optional(Type.String({ description: 'A .js file to run instead of code' })),
      files: Type.Optional(Type.Array(Type.String(), { description: 'Paths, folders or globs to copy in' })),
      ns: Type.Optional(Type.Array(Type.String(), { description: 'Folders the run may reach, each "path" or "path:ro" (default: /work and the folders of `files`)' })),
      args: Type.Optional(Type.Array(Type.String())),
      stdin: Type.Optional(Type.String()),
      limits: Type.Optional(Type.Object({
        timeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: CAPS.timeMs })),
        memoryMB: Type.Optional(Type.Integer({ minimum: 1, maximum: CAPS.memoryMB })),
        outputKB: Type.Optional(Type.Integer({ minimum: 1, maximum: CAPS.outputKB })),
      })),
    }),
    async execute({ code, path, files, ns, args = [], stdin = '', limits = {} }, { signal, caller, callId } = {}) {
      if ((code == null) === (path == null)) throw new Error('give exactly one of `code` or `path`');
      const fs = fsFor(caller);
      let filename = CWD + '/main.js', home = CWD;
      if (path != null) {
        filename = abs(path);
        code = await fs.readFile(filename).catch(() => { throw new Error(`${filename} does not exist; write the script first, or pass it as \`code\``); });
        home = normalize(filename + '/..');
      }
      const specs = files?.length ? files : [home];
      const bases = specs.map((f) => globBase(abs(f)));
      // The run's namespace: declared, or /work plus the mounts its files live in.
      const declared = ns?.length ? parseSpecs(ns).map((d) => d.path + (d.readOnly ? ':ro' : ''))
        : [...new Set([CWD, ...bases.map((b) => rootOf(fs, b))])].filter((p) => p !== '/');
      const paths = parseSpecs(declared).map((d) => d.path);
      for (const b of bases) if (!paths.some((d) => within(b, d))) throw new Error(`files: ${b} is outside this run's namespace (${paths.join(', ')}); add its folder to \`ns\`, or leave \`ns\` out`);
      const scratch = paths.some((d) => within(d, '/tmp')) ? null : new InMemoryFs();
      const runNs = subset(fs, declared, { scratch });
      const clamp = (v, cap) => Math.max(1, Math.min(cap, v ?? cap));
      const request = {
        code, filename, cwd: CWD, args: args.map(String), stdin: String(stdin), specs,
        limits: { ...DEFAULT_LIMITS, maxFiles: SNAPSHOT.maxFiles, maxFileBytes: SNAPSHOT.maxFileBytes,
          timeMs: clamp(limits.timeMs, CAPS.timeMs), memoryBytes: clamp(limits.memoryMB, CAPS.memoryMB) << 20,
          maxOutputBytes: clamp(limits.outputKB, CAPS.outputKB) << 10 },
      };
      // Serve the namespace over 9P; writes take their turn per path and are recorded.
      const landed = [];
      const { port1, port2 } = new MessageChannel();
      const server = serve(port1, runNs, {
        commit: (p, b, op) => oneAtATime(p, () => (op === 'remove' ? runNs.rm(p) : runNs.writeFile(p, b))),
        onCommit: (p, op) => landed.push({ path: p, op }),
      });
      const ac = new AbortController();
      let killed = false;
      const stop = () => ac.abort();
      signal?.addEventListener('abort', stop, { once: true });
      const task = vfs.tasks.add({ kind: 'run', key: callId, label: path != null ? filename : (code.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 60),
        ns: runNs.describe(), kill: () => { killed = true; ac.abort(); } });
      let r;
      try {
        r = await runInWorker(makeWorker, request, { signal: ac.signal, ns: port2,
          onPhase: (phase, m) => task.note(phase === 'loaded' ? `read ${m.files} file(s), ${kb(m.bytes)}, over 9P` : 'guest finished; writing changes back'),
          onStop: () => server.flushAll(`EINTR: the run was ${killed ? 'killed' : 'stopped'}`) });
      } finally { signal?.removeEventListener('abort', stop); server.close(); }
      const outside = landed.filter((c) => !(scratch && within(c.path, '/tmp')));
      if (outside.length) vfs.changed();
      const listOf = (xs) => xs.slice(0, 20).map((c) => `${c.op === 'remove' ? 'deleted' : 'wrote'} ${c.path}`).join(', ') + (xs.length > 20 ? `, and ${xs.length - 20} more` : '');
      if (r.phase === 'load') { task.end('failed', r.message); throw new Error(r.message); }
      if (r.status === 'cancelled') {
        task.end(killed ? 'killed' : 'stopped');
        const already = outside.length ? ` ${outside.length} change(s) had already been written: ${listOf(outside)}.` : '';
        if (killed) throw new Error(`Killed through /task/${task.id}/ctl.${already}`);
        if (signal?.aborted) throw new Error('Stopped.' + already);
      }
      task.end(r.status === 'ok' || (r.status === 'exit' && r.exitCode === 0) ? 'done' : r.status, `exit ${r.exitCode}`);

      // The worker wrote back what the guest changed, unless the run was cut off.
      const cut = ['timeout', 'oom', 'cancelled'].includes(r.status);
      const dropScratch = (xs = []) => xs.filter((c) => !(scratch && within(c.path, '/tmp')));
      const applied = dropScratch(r.applied), conflicts = dropScratch(r.conflicts);
      const scratchWrites = (r.applied ?? []).length - applied.length;
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
      if (scratchWrites) text += `\n(${scratchWrites} scratch file(s) under /tmp, discarded with the run)`;
      if (cut && r.changes.length) text += `\n${r.changes.length} proposed change(s) discarded because the run did not finish.`;
      if (r.exitCode !== 0) throw new Error(text);
      return text;
    },
  };
}
