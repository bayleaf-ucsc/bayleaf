// The `addons` command: add-ons kept in this browser (src/addons.ts), the same
// command for agents and the terminal, and the same service as Settings > Add-ons.
//
//   addons list                    every add-on: kind, size, state, what uses it
//   addons info <name>             one add-on: size, license, source, what it needs, files kept
//   addons install <name> [--wait] install as a /task entry (asked add-ons: the user approves first)
//   addons install --all [--wait]  everything this device can run (one sheet for the asked ones)
//   addons remove <name>           free the storage (an agent's request asks the user)
//   addons verify <name>           re-check every kept byte against this page's hashes (no network)
//
// Network: `info` on a model reads the gateway's public catalog (metadata, no
// content); installs carry nothing but which public files or byte ranges are
// wanted. Every byte is checked against the build's pins.
import type { defineCommand as DefineCommand } from 'just-bash';
import { GATEWAY } from './models.ts';
import { sizeText } from './addons.ts';
import type { Addons, AddonStatus, AddonWho, InstallTask } from './addons.ts';

const ok = (stdout = '', stderr = '') => ({ stdout, stderr, exitCode: 0 });
const fail = (msg: string) => ({ stdout: '', stderr: `addons: ${msg}\n`, exitCode: 1 });
const usage = (msg: string) => ({ stdout: '', stderr: `addons: ${msg}\nRun \`addons --help\` for usage.\n`, exitCode: 2 });
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const HELP = `addons: optional tools and models kept in this browser

  addons list                    every add-on: kind, size, state, what uses it
  addons info <name>             size, license, source, what it needs, files kept
  addons install <name> [--wait] install as a /task entry; stop it with:
                                 echo stop > /task/<id>/ctl (install again resumes)
  addons install --all [--wait]  everything this device can run (Make available offline)
  addons remove <name>           free the storage (an agent's request asks the user)
  addons verify <name>           re-check every kept byte (no network)

Small add-ons from Pouch's own origin (at most 10 MiB, no extra license)
install on first use and say so. Every other install asks the user first;
only the user can approve. Every byte is checked against the SHA-256 this
page was built with. Names accept unique prefixes (lfm3).
Exit codes: 0 ok, 1 error or denied, 2 usage.
`;

// A state as a list cell or info line, with the next step where there is one.
export function stateText(s: AddonStatus): string {
  if (s.state === 'not available here') return `not available here: ${s.reason}`;
  if (s.state === 'installing') return `installing ${sizeText(s.task?.progress?.done ?? s.bytes)} of ${sizeText(s.size)}${s.task ? ` (/task/${s.task.id})` : ''}`;
  if (s.state === 'partly installed') return `partly installed: ${sizeText(s.bytes)} of ${sizeText(s.size)}; \`addons install ${s.id}\` resumes`;
  if (s.state === 'installed') return 'installed';
  return `not installed${s.tier === 'asked' ? ' (asks first)' : ' (installs on first use)'}`;
}
export const usedByText = (s: Pick<AddonStatus, 'usedBy' | 'provider'>) => s.usedBy.length ? s.usedBy.join(', ') : s.provider ? `${s.provider} provider` : '-';

// Each sub and the flags it takes.
const FLAGS: Partial<Record<string, string[]>> = { list: [], info: [], install: ['--wait', '--all'], remove: [], verify: [] };

// The command, bound to who is typing: { by: 'user', via: 'terminal' } or an agent's who.
export function addonsCommands(defineCommand: typeof DefineCommand, addons: Addons | undefined, whoOf: AddonWho | (() => AddonWho)) {
  if (!addons) return [];
  return [defineCommand('addons', async (args, ctx) => {
    const [sub, ...rest] = args;
    if (!sub || sub === '--help' || sub === '-h' || sub === 'help' || rest.includes('--help')) return ok(HELP);
    const who = typeof whoOf === 'function' ? whoOf() : whoOf;
    const flags = rest.filter((a) => a.startsWith('-')), pos = rest.filter((a) => !a.startsWith('-'));
    const known = FLAGS[sub];
    if (!known) return usage(`unknown command: addons ${sub}`);
    const bad = flags.find((f) => !known.includes(f));
    if (bad) return usage(`unknown option ${bad} for addons ${sub}`);
    // --wait: until the task ends; the tool's own Stop stops the install too.
    // --all: every task this command started stops together; ones it joined are only waited for.
    async function wait(task: InstallTask, done: string, own: InstallTask[] = [task]) {
      let leave = () => {};
      const left = new Promise<never>((_, rej) => { leave = () => rej(new DOMException('Stopped.', 'AbortError')); });
      const stop = () => { for (const t of own) t.kill?.(); leave(); };
      if (ctx?.signal?.aborted) stop(); else ctx?.signal?.addEventListener('abort', stop, { once: true });
      try { await Promise.race([task.promise, left]); return null; }
      catch (e) { return e instanceof Error && e.name === 'AbortError' ? `stopped (/task/${task.id}); ${done}` : message(e); }
      finally { ctx?.signal?.removeEventListener('abort', stop); }
    }
    try {
      if (sub === 'list') {
        const rows = await addons.list();
        if (!rows.length) return ok('no add-ons in this build of Pouch\n');
        const w = Math.max(4, ...rows.map((r) => r.id.length));
        return ok([`${pad('NAME', w)}  ${pad('KIND', 5)}  ${pad('SIZE', 9)}  ${pad('STATE', 34)}  USED BY`,
          ...rows.map((r) => `${pad(r.id, w)}  ${pad(r.kind, 5)}  ${pad(sizeText(r.size), 9)}  ${pad(stateText(r), 34)}  ${usedByText(r)}`)].join('\n') + '\n');
      }
      if (sub === 'install' && flags.includes('--all')) {
        if (pos.length) return usage('addons install --all takes no name');
        const r = await addons.installAll(who);
        const lines = [...r.started.map((t) => `installing as /task/${t.id}: ${t.label}`), ...r.joined.map((t) => `already installing as /task/${t.id}: ${t.label}`),
          ...(r.denied.length ? [`denied by the user: nothing was installed (${r.denied.join(', ')})`] : [])];
        if (!r.started.length && !r.joined.length && !r.denied.length) return ok('every add-on this device can run is installed\n');
        if (flags.includes('--wait')) for (const t of [...r.started, ...r.joined]) { const e = await wait(t, '`addons install --all` resumes', r.started); if (e) return fail(e); }
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: r.denied.length ? 1 : 0 };
      }
      if (pos.length !== 1) return usage(`addons ${sub} takes one name`);
      if (sub === 'info') {
        const s = await addons.status(pos[0]), d = addons.get(s.id);
        const gw = !('origin' in d.files) ? d.files.gateway : null;
        const rel = gw ? await addons.release(s.id).catch(() => null) : null;
        const lines = [`${s.id}: ${s.label} (${s.kind}${s.hidden ? ', part of another add-on' : ''})`, `  state: ${stateText(s)}`, `  size: ${sizeText(s.size)}; ${s.tier === 'quiet' ? 'installs on first use (small, from Pouch\'s own origin)' : 'asks the user before installing'}`,
          `  used by: ${usedByText(s)}`, `  license: ${rel?.license?.name ?? d.license}`, ...(d.attribution ? [`  attribution: ${d.attribution}`] : []),
          `  source: ${gw ? `${gw.repo}@${gw.revision.slice(0, 12)} via ${GATEWAY}` : 'Pouch\'s own origin' + (d.notice ? ` (license notice: ${d.notice})` : '')}`,
          ...(rel?.qualification ? [`  qualification: ${rel.qualification.map((q) => `${q.client} ${q.status}`).join('; ')}`] : []),
          ...(s.parts.length > 1 ? s.parts.map((p) => `  ${p.complete ? 'ok  ' : p.bytes ? 'part' : '-   '} ${pad(sizeText(p.size), 9)} ${p.id === s.id ? p.label : `${p.label} (needed)`}`) : []),
          `  storage: ${s.persistent ? 'Cache Storage (kept across reloads)' : 'memory (this page load only)'}`];
        return ok(lines.join('\n') + '\n', rel ? `[read the public catalog at ${GATEWAY}/catalog; nothing about you was sent but the request]\n` : '');
      }
      if (sub === 'install') {
        const r = await addons.install(pos[0], who);
        if (r.already) return ok(`${r.status.label} is already installed and checked (${sizeText(r.status.size)}).\n`);
        const where = `/task/${r.task.id}`;
        if (!flags.includes('--wait')) return ok(`${r.joined ? 'already installing' : 'installing'} ${pos[0]} as ${where}: cat ${where}/status (progress in ${where}/log); stop with: echo stop > ${where}/ctl\n`);
        const e = await wait(r.task, `\`addons install ${pos[0]}\` resumes where it stopped`);
        if (e) return fail(e);
        const s = await addons.status(pos[0]);
        return ok(`installed ${s.label} (${sizeText(s.size)}) as ${where}, checked against this page's hashes\n`);
      }
      if (sub === 'verify') {
        const d = addons.resolve(pos[0]), r = await addons.verify(d.id);
        return ok(`verified ${r.files} files of ${d.id} (${sizeText(r.bytes)}) against the hashes kept when they matched this page's pins; no network used.\n`);
      }
      if (sub === 'remove') {
        const d = addons.resolve(pos[0]), r = await addons.remove(d.id, who);
        return ok(r.nothing ? `${d.label} is not installed; nothing to remove.\n` : `removed ${d.label}: freed ${sizeText(r.freed)}. \`addons install ${d.id}\` installs it again${addons.tier(d) === 'asked' ? ' (the user will be asked)' : ''}.\n`);
      }
      return usage(`unknown command: addons ${sub}`); // unreachable: FLAGS names every sub above
    } catch (e) {
      return fail(message(e));
    }
  })];
}
