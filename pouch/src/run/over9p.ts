// A run's file traffic, over 9P from inside the worker.
//
// The guest's fs API is synchronous (fs.readFile returns a string), and a
// synchronous call cannot wait for a 9P reply without SharedArrayBuffer and
// Atomics.wait (cross-origin isolation, which Pouch does not have) or an
// asyncify build of QuickJS (another wasm binary). So a run stays
// snapshot-in / diff-out, but both directions now travel over the 9P
// connection the host hands the worker: the worker walks and reads the named
// files out of its namespace, the guest runs over that snapshot, and the
// worker writes the diff back through the same connection. The host serves
// only the run's own namespace (by default /work and a scratch /tmp), so a
// path that is not bound there does not exist for the worker either.
import { normalize, sha256 } from './core.ts';
import { applyChanges } from './host.ts';
import type { Change, SnapshotFile } from './core.ts';
import type { RunFs } from './host.ts';

// The slice of a NinepFs (src/ns/9p.ts) a run reads and writes through.
export interface RunNinepFs extends RunFs {
  readdirWithFileTypes(dir: string): Promise<{ name: string; isDirectory: boolean }[]>;
  stat(p: string): Promise<{ isDirectory: boolean }>;
  mkdir(p: string, o: { recursive: boolean }): Promise<void>;
}

// The snapshot: copied into the worker, so keep it bounded.
export const SNAPSHOT = { maxFiles: 500, maxBytes: 16 << 20, maxFileBytes: 4 << 20 };

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const hasGlob = (s: string) => /[*?[]/.test(s);
function globRegex(glob: string) {
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
// The fixed part of a path with globs: where to start walking.
export const globBase = (p: string) => p.split('/').filter((x, i, a) => !a.slice(0, i + 1).some(hasGlob)).join('/') || '/';

// Expand paths, folders (recursively) and globs to file paths, stopping as
// soon as the caps are passed so a huge tree fails fast with a clear message.
export async function expand(fs: Pick<RunNinepFs, 'readdirWithFileTypes' | 'stat'>, specs: string[], abs: (p: string) => string) {
  const out = new Set<string>();
  const over = () => out.size > SNAPSHOT.maxFiles;
  async function walk(dir: string, match?: RegExp) {
    let items; try { items = await fs.readdirWithFileTypes(dir); } catch { return; }
    for (const d of items) {
      if (over()) return;
      const p = normalize(dir + '/' + d.name);
      if (d.isDirectory) await walk(p, match);
      else if (!match || match.test(p)) out.add(p);
    }
  }
  for (const spec of specs) {
    const p = abs(spec);
    if (hasGlob(p)) { await walk(globBase(p), globRegex(p)); continue; }
    const st = await fs.stat(p).catch(() => null);
    if (!st) throw new Error(`files: ${p} does not exist`);
    if (st.isDirectory) await walk(p); else out.add(p);
    if (over()) break;
  }
  if (over()) throw new Error(`the snapshot would have more than ${SNAPSHOT.maxFiles} files; name the files you need in \`files\` (paths or globs like /work/data/*.csv)`);
  return [...out].sort();
}

// Read the snapshot over 9P. Errors are the tool's own messages.
export async function load(fs: RunNinepFs, specs: string[], cwd: string) {
  const abs = (p: string) => normalize(p.startsWith('/') ? p : cwd + '/' + p);
  const files: SnapshotFile[] = [];
  let total = 0;
  for (const p of await expand(fs, specs, abs)) {
    const bytes = new Uint8Array(await fs.readFileBuffer(p));
    if (bytes.byteLength > SNAPSHOT.maxFileBytes) throw new Error(`${p} is ${kb(bytes.byteLength)}, over the ${kb(SNAPSHOT.maxFileBytes)} per-file snapshot limit; leave it out of \`files\``);
    total += bytes.byteLength;
    if (total > SNAPSHOT.maxBytes) throw new Error(`the snapshot would exceed ${kb(SNAPSHOT.maxBytes)}; name fewer files in \`files\``);
    files.push({ path: p, bytes, hash: await sha256(bytes) });
  }
  return { files, bytes: total };
}

// Write the guest's changes back over 9P, each only if the file still
// matches the snapshot (applyChanges in host.js does the checking).
export function writeBack(fs: RunNinepFs, changes: Change[]) {
  return applyChanges({
    exists: (p) => fs.exists(p), readFileBuffer: (p) => fs.readFileBuffer(p), rm: (p) => fs.rm(p),
    writeFile: async (p, b) => { await fs.mkdir(normalize(p + '/..'), { recursive: true }); await fs.writeFile(p, b); },
  }, changes);
}
