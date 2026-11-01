// The control plane: everything in Pouch that acts, as files (README "Control plane").
//
//   /session/events                     read: recent state changes, one per line
//                                       (a 9P read of an open fid blocks for the next one)
//   /session/current                    the session open in the Interface (an agent: its own)
//   /session/<sid>/title                read
//   /session/<sid>/status               read: "<state> agents=<n> running=<k>"
//   /session/<sid>/ctl                  write: stop (everything in the session), detach
//   /session/<sid>/agents/a<n>/status   read: "<state> <seconds> <kind> <name>[: task]"
//   /session/<sid>/agents/a<n>/ctl      write: stop (alias kill); a1 also "stop all"; detach
//   /session/<sid>/agents/a<n>/in       write: a message (see parseIn)
//   /session/<sid>/agents/a<n>/last     read: its latest answer
//   /session/<sid>/agents/a<n>/ns       read: its mount table
//
// The Interface is one client among several (Plan 9's rio /dev/wsys, acme
// /mnt/acme): its Stop, Background, Steer and Follow-up buttons write these
// files, the terminal writes them with `echo`, and the main agent writes ctl
// from bash. What happens on a write is the harness side, registered once
// with drive(): the same code runs whoever wrote, so the tray, the terminal
// and the agent always agree.
//
// Authority is which view you were handed, never what you claim in a header:
// - view({ by: 'user' })        the Interface and the terminal: every session,
//                               ctl and in writable.
// - view({ by: 'agent', sid })  the main agent: only its own session; ctl
//                               writable (the authority /task/<id>/ctl already
//                               gives), in refused (agents message each other
//                               with the agents tool, which applies the
//                               session's message caps and says who wrote).
// Subagents and `run` get no view at all (like /task), and /session is not in
// the shared namespace, so a capability view cut from it cannot name it.
//
// Events never carry message content: who did what to which agent, and sizes.
import { BaseFs, fsError, normalize, parts } from './namespace.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const KEEP_EVENTS = 200, SHOW_EVENTS = 50;
const AGENT_FILES = ['ctl', 'in', 'last', 'ns', 'status'];
const SESSION_FILES = ['agents', 'ctl', 'status', 'title'];
const WRITABLE = new Set(['ctl', 'in']);
export const MODES = ['steer', 'followup', 'message'];
const LAST_CHARS = 4000;

// ── Grammar ─────────────────────────────────────────────────────────
// ctl: one command per line, blank lines ignored, all lines checked before
// any runs. Session ctl: stop | detach. a1: stop | stop all | detach.
// aN: stop | detach. "kill" is accepted for stop (as /task/<id>/ctl says).
export function parseCtl(text, { main = false, session = false } = {}) {
  const allowed = session ? ['stop', 'detach'] : main ? ['stop', 'stop all', 'detach'] : ['stop', 'detach'];
  const cmds = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    const cmd = line === 'kill' ? 'stop' : line;
    if (!allowed.includes(cmd)) throw Object.assign(new Error(`ctl accepts: ${allowed.join(', ')} (got "${line.slice(0, 30)}")`), { code: 'EINVAL' });
    cmds.push(cmd);
  }
  return cmds;
}
// in: a header line ("steer", "followup", "message") and the text below it,
// or the header as the first word ("steer use tabs"), or plain text, which is
// a message. A message joins a working agent's turn (like a steer) and starts
// an idle one. There is no "from" header: who wrote is the view's identity.
export function parseIn(text) {
  const s = String(text).replace(/\r\n/g, '\n');
  const m = s.match(/^\s*(steer|followup|follow-up|message)(?:[ \t]*\n|[ \t]+)([\s\S]*)$/) ?? s.match(/^\s*(steer|followup|follow-up|message)\s*$/);
  const mode = m ? (m[1] === 'follow-up' ? 'followup' : m[1]) : 'message';
  const body = (m ? m[2] ?? '' : s).trim();
  return { mode, text: body };
}
// An error from a control write, in the words the Interface shows a person.
export const why = (e) => String(e?.message ?? e).replace(/^E[A-Z]+: /, '').replace(/, (write|open|stat|scandir) '[^']*'$/, '');

// ── The registry and the event log ──────────────────────────────────
// deps (all may be async):
//   sessions()          [{ id, title }]
//   current()           the session id open in the Interface, or null
//   agents(sid)         [{ ref, name, kind: 'main'|'subagent', state, since?, ended?, task?, ns? }]
//   last(sid, ref)      that agent's latest answer
export function createControl(deps) {
  const log = []; // { seq, line }
  let seq = 0, driver = null;
  const waiters = new Set();
  const states = new Map(); // `${sid} ${ref}` -> last state reported

  const ctl = {
    deps,
    // The harness side: { stop(sid, ref, { all, by }), detach(sid, ref, { by }), send(sid, ref, mode, text, { by }) }.
    drive(d) { driver = d; },
    emit(sid, ref, what) {
      const line = `${++seq} ${sid ?? '-'} ${ref ?? '-'} ${what}`;
      log.push({ seq, sid: sid == null ? null : String(sid), line });
      log.splice(0, log.length - KEEP_EVENTS);
      for (const w of [...waiters]) w();
      return seq;
    },
    // Report an agent's state; an event only when it changed.
    state(sid, ref, state) {
      const k = `${sid} ${ref}`;
      if (states.get(k) === state) return;
      states.set(k, state);
      ctl.emit(sid, ref, `state ${state}`);
    },
    forget(sid) { for (const k of states.keys()) if (k.startsWith(`${sid} `)) states.delete(k); },
    // Events after `after` (a seq), for sid or all; blocks until there is one.
    async next(after = seq, { sid = null, signal } = {}) {
      for (;;) {
        const got = log.filter((e) => e.seq > after && (sid == null || e.sid === String(sid)));
        if (got.length) return got;
        if (signal?.aborted) throw fsError('EINTR', 'read', '/session/events', 'interrupted');
        await new Promise((resolve) => {
          const w = () => { waiters.delete(w); signal?.removeEventListener('abort', w); resolve(); };
          waiters.add(w); signal?.addEventListener('abort', w);
        });
      }
    },
    // A blocking-read loop over the events, as an async iterator (the Interface's tail).
    async *tail({ sid = null, signal, from = seq } = {}) {
      let at = from;
      while (!signal?.aborted) {
        let got;
        try { got = await ctl.next(at, { sid, signal }); } catch { return; }
        at = got.at(-1).seq;
        yield got;
      }
    },
    get seq() { return seq; },
    recent(sid = null) { return log.filter((e) => sid == null || e.sid === String(sid)).slice(-SHOW_EVENTS).map((e) => e.line); },
    async act(op, sid, ref, args, by) {
      if (!driver) throw fsError('EAGAIN', 'write', `/session/${sid}`, 'the agent is not ready yet; try again');
      return driver[op](sid, ref, ...args, { by });
    },
    view(opts) { return new SessionFs(ctl, opts); },
  };
  return ctl;
}

const secs = (a) => (a.since ? `${(((a.ended ?? Date.now()) - a.since) / 1000).toFixed(1)}s` : '-');
const oneLine = (t, n) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
export const agentStatus = (a) => `${a.state} ${secs(a)} ${a.kind} ${a.name}${a.task ? ': ' + oneLine(a.task, 80) : ''}\n`;
export function sessionStatus(list) {
  const main = list.find((a) => a.kind === 'main');
  const running = list.filter((a) => a.kind === 'subagent' && a.state === 'running').length;
  return `${main?.state ?? 'idle'} agents=${list.length} running=${running}\n`;
}

// The /session tree as one writer sees it.
export class SessionFs extends BaseFs {
  // by: 'user' | 'agent'; sid: an agent's own session (its only one);
  // label: which client of the user's, for events ("you (terminal)")
  constructor(ctl, { by = 'user', sid = null, label = '' } = {}) { super(); this.ctl = ctl; this.by = by; this.label = label; this.sid = sid == null ? null : String(sid); }
  get d() { return this.ctl.deps; }
  P(path) { return normalize('/session/' + path); } // errors name the path the writer used
  async sids() {
    if (this.sid != null) return [this.sid];
    return (await this.d.sessions()).map((s) => String(s.id));
  }
  async resolveSid(name, op, path) {
    if (name === 'current') {
      const cur = this.sid ?? (this.d.current() == null ? null : String(this.d.current()));
      if (cur == null) throw fsError('ENOENT', op, this.P(path), 'no session is open');
      return cur;
    }
    if (!(await this.sids()).includes(name)) throw fsError('ENOENT', op, this.P(path));
    return name;
  }
  // { root } | { events } | { sid, file? } | { sid, agentsDir } | { sid, a, file? }
  async find(path, op) {
    const [s, f, ref, file, ...rest] = parts(path);
    if (!s) return { root: true };
    if (s === 'events') { if (f) throw fsError('ENOTDIR', op, this.P(path)); return { events: true }; }
    const sid = await this.resolveSid(s, op, path);
    if (!f) return { sid };
    if (!SESSION_FILES.includes(f)) throw fsError('ENOENT', op, this.P(path));
    if (f !== 'agents') { if (ref) throw fsError('ENOTDIR', op, this.P(path)); return { sid, file: f }; }
    if (!ref) return { sid, agentsDir: true };
    const a = (await this.d.agents(sid)).find((x) => x.ref === ref);
    if (!a || rest.length || (file && !AGENT_FILES.includes(file))) throw fsError('ENOENT', op, this.P(path));
    return { sid, a, file };
  }
  async text(n) {
    if (n.events) return this.ctl.recent(this.sid).map((l) => l + '\n').join('');
    if (n.a) {
      if (n.file === 'status') return agentStatus(n.a);
      if (n.file === 'ns') return (n.a.ns ?? []).map((l) => l + '\n').join('');
      if (n.file === 'last') { const t = String((await this.d.last?.(n.sid, n.a.ref)) ?? ''); return t ? t.slice(-LAST_CHARS).replace(/\n?$/, '\n') : ''; }
      return ''; // ctl and in read empty
    }
    if (n.file === 'title') return `${(await this.d.sessions()).find((s) => String(s.id) === n.sid)?.title || 'Untitled'}\n`;
    if (n.file === 'status') return sessionStatus(await this.d.agents(n.sid));
    return '';
  }
  async stat(path) {
    const n = await this.find(path, 'stat');
    const isFile = !!(n.events || n.file);
    if (!isFile) return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o555, size: 0, mtime: new Date(n.a?.since ?? 0) };
    const w = WRITABLE.has(n.file);
    return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: w ? 0o200 : 0o444, size: w ? 0 : enc.encode(await this.text(n)).length, mtime: new Date(n.a?.ended ?? n.a?.since ?? Date.now()) };
  }
  async readFileBuffer(path) {
    const n = await this.find(path, 'open');
    if (!(n.events || n.file) || n.file === 'agents') throw fsError('EISDIR', 'read', this.P(path));
    return enc.encode(await this.text(n));
  }
  async readdirWithFileTypes(path) {
    const n = await this.find(path, 'scandir');
    if (n.events || (n.file && n.file !== 'agents')) throw fsError('ENOTDIR', 'scandir', this.P(path));
    const dir = (name) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false });
    const file = (name) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false });
    if (n.root) return [file('events'), ...((this.sid ?? this.d.current()) != null ? [dir('current')] : []), ...(await this.sids()).map(dir)];
    if (n.a) return AGENT_FILES.map(file);
    if (n.agentsDir) return (await this.d.agents(n.sid)).map((a) => dir(a.ref));
    return SESSION_FILES.map((f) => (f === 'agents' ? dir(f) : file(f)));
  }
  async readdir(path) { return (await this.readdirWithFileTypes(path)).map((d) => d.name); }
  // Same-page writers get the harness's receipt back (a steer's id, so the
  // tray can follow it); over 9P a write answers with its count, as usual.
  async writeFile(path, content) {
    const n = await this.find(path, 'open');
    if (!WRITABLE.has(n.file)) throw fsError(n.file || n.events ? 'EROFS' : 'EISDIR', 'open', this.P(path));
    const text = typeof content === 'string' ? content : dec.decode(content);
    const who = this.by === 'user' ? (this.label ? `you (${this.label})` : 'you') : 'main (a1)';
    const fail = (e) => { throw fsError(e.code ?? 'EINVAL', 'write', this.P(path), e.message); };
    if (n.file === 'ctl') {
      let cmds;
      try { cmds = parseCtl(text, { main: n.a?.ref === 'a1', session: !n.a }); } catch (e) { fail(e); }
      let out;
      for (const cmd of cmds) {
        const ref = n.a?.ref ?? 'a1', all = !n.a ? cmd === 'stop' : cmd === 'stop all';
        this.ctl.emit(n.sid, ref, `ctl ${n.a ? cmd : cmd === 'stop' ? 'stop all' : cmd} by ${who}`);
        try { out = await this.ctl.act(cmd === 'detach' ? 'detach' : 'stop', n.sid, ref, cmd === 'detach' ? [] : [{ all }], this.by); } catch (e) { fail(e); }
      }
      return out;
    }
    // in
    if (this.by !== 'user') throw fsError('EPERM', 'write', this.P(path), 'agents message each other with the agents tool (it applies the message caps); in is for people');
    const { mode, text: body } = parseIn(text);
    if (!body) return; // a shell redirection truncates first: nothing to do
    this.ctl.emit(n.sid, n.a.ref, `in ${mode} by ${who} (${body.length} chars)`);
    try { return await this.ctl.act('send', n.sid, n.a.ref, [mode, body], this.by); } catch (e) { fail(e); }
  }
  async appendFile(path, content) { return this.writeFile(path, content); }
  // A 9P open of /session/events reads like acme's event file: each read
  // waits for events after the last one this fid saw (the first: after the open).
  openStream(path) {
    if (normalize(path) !== '/events') return null;
    let at = this.ctl.seq;
    return { read: async (signal) => {
      const got = await this.ctl.next(at, { sid: this.sid, signal });
      at = got.at(-1).seq;
      return enc.encode(got.map((e) => e.line + '\n').join(''));
    } };
  }
  async mkdir(path) { throw fsError('EROFS', 'mkdir', this.P(path)); }
  async rm(path) { throw fsError('EROFS', 'rm', this.P(path)); }
}
