// Data leaving the pouch (D10): the approval sheet for the `bayleaf` command
// (src/bayleaf-cli.ts asks approveEgress before every request) and the
// per-session grants behind "Allow for this session".
//
// A grant is (session id, service), kept in settings under grantsKey(sid) as
// a list of services; sessions.js deletes it with the session. Approvals
// queue: one sheet at a time, in the order the requests asked.
//
// Tool output carries two durable traces (tools.js, bayleaf-cli.js):
//   [left the pouch: <audience>; <audience>]        one per request, stderr
//   [this call sent data outside the pouch: <cmds>] the bash result's last line
// egressOf(output) reads them back, so a badge survives reload.
import * as store from './store.ts';
import { $, el } from './dom.ts';
import { grantsKey } from './sessions.ts';
import type { ApproveEgress, EgressAnswer, EgressPending, EgressRequest, EgressService, EgressSid, EgressTrace } from './trust.ts';

const SERVICE: Record<EgressService, string> = { web: 'web search and fetch', sandbox: 'your sandbox VM', inbox: 'your inboxes', account: 'your BayLeaf account status' };
export const serviceName = (s: EgressService): string => SERVICE[s] ?? s;

// A session's grants, as data: the services it may use without asking.
export type Grants = EgressService[];
// The id as sessions.ts types it: pi-durable brands the numeric ids, which plain data cannot.
type SessionKey = Parameters<typeof grantsKey>[0];
export const grantsFor = async (sid: EgressSid): Promise<Grants> => (sid == null ? [] : ((await store.getSetting(grantsKey(sid as SessionKey))) as Grants | undefined) ?? []);
async function grant(sid: EgressSid, service: EgressService) {
  const list = await grantsFor(sid);
  if (!list.includes(service)) await store.setSetting(grantsKey(sid as SessionKey), [...list, service]);
}
export async function revoke(sid: EgressSid, service: EgressService) {
  const list = (await grantsFor(sid)).filter((s) => s !== service);
  await store.setSetting(grantsKey(sid as SessionKey), list.length ? list : undefined);
}

const MARKER = /\n?\[this call sent data outside the pouch: ([^\]\n]*)\](?=(?:\n\[exit code \d+\])?\s*$)/;
const LEFT = /^\[left the pouch: ([^\]\n]*)\]$/gm;
// Audiences are joined with '; ', which some also contain inside parentheses.
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth = Math.max(0, depth - 1);
    else if (!depth && s.startsWith('; ', i)) { out.push(s.slice(from, i)); from = i + 2; }
  }
  return [...out, s.slice(from)].filter(Boolean);
}
// null when the call sent nothing.
export function egressOf(output: unknown): EgressTrace | null {
  const s = String(output ?? '');
  const m = s.match(MARKER);
  if (!m) return null;
  const audiences = [...new Set([...s.matchAll(LEFT)].flatMap((x) => splitTop(x[1])))];
  return { commands: m[1].split(', '), audiences, text: s.slice(0, m.index) + s.slice(m.index! + m[0].length) };
}

export interface EgressDeps { sessionTitle?(sid: EgressSid): Promise<string>; onGrant?(): void; onPending?(pending: EgressPending[]): void }
export interface Egress { approve: ApproveEgress; focus(): void; readonly pending: EgressPending[] }
export function createEgress(deps: EgressDeps = {}): Egress {
  let queue: Promise<unknown> = Promise.resolve();
  // Requests waiting for an answer, oldest first, for the composer tray
  // (deps.onPending). The first is the one whose sheet is open.
  let pending: EgressPending[] = [], seq = 0;
  const changed = () => deps.onPending?.(pending);

  function ask(req: EgressRequest, sid: EgressSid, title: string, agentName?: string, asker?: string) {
    return new Promise<EgressAnswer>((resolve) => {
      const d = $<HTMLDialogElement>('egress');
      let answer: EgressAnswer = false;
      const choose = (v: EgressAnswer) => { answer = v; d.close(); };
      // A subagent's request says so: it runs unattended, so name who asks.
      $('egress-h').textContent = asker ? 'Send this outside the pouch from the terminal?' : agentName ? `Subagent "${agentName}" wants to send this outside the pouch` : 'Send this outside the pouch?';
      $('egress-summary').textContent = req.summary ?? req.command;
      // Outside its session's view an agent is named with the session title first
      // (LANGUAGE.md "Handles"): "Essay review › judge-evidence".
      $('egress-meta').textContent = `${req.command} · ${asker ?? (agentName ? `${title} › ${agentName} (subagent)` : `session: ${title}`)}`;
      $('egress-detail').textContent = req.detail ?? '';
      $('egress-audiences').replaceChildren(...(req.audiences ?? []).map((a) => el('li', { textContent: a })));
      $('egress-session').textContent = `Allow ${serviceName(req.service)} for this session`;
      $('egress-session').hidden = sid == null; // the terminal belongs to no session: every use asks
      $('egress-deny').onclick = () => choose(false);
      $('egress-once').onclick = () => choose('once');
      $('egress-session').onclick = () => choose('session');
      // A press on the backdrop or Esc answers Deny (src/dismiss.ts, registered in src/interface/state.ts).
      d.addEventListener('close', () => resolve(answer), { once: true }); // Esc lands here too: false
      d.showModal();
      d.scrollTop = 0; $('egress-detail').scrollTop = 0;
      $('egress-deny').focus();
    });
  }

  // The hook bayleaf-cli.js awaits. Resolves true only on an explicit allow.
  // agentName: the subagent asking, or none for the main agent. A session
  // grant covers the session's subagents too. asker: who else asks, named on
  // the sheet instead of a session (the terminal: sid null, so no grant applies).
  function approve(req: EgressRequest, sid: EgressSid, agentName?: string, asker?: string): Promise<boolean> {
    const row: EgressPending = { id: ++seq, sid: sid == null ? null : String(sid), command: req.command, agentName: agentName ?? asker, since: Date.now() };
    pending = [...pending, row]; changed();
    const turn = queue.then(async () => {
      if ((await grantsFor(sid)).includes(req.service)) return true;
      const v = await ask(req, sid, await deps.sessionTitle?.(sid) ?? 'this session', agentName, asker);
      if (v === 'session' && sid != null) { await grant(sid, req.service); deps.onGrant?.(); }
      return v === 'once' || v === 'session';
    }).finally(() => { pending = pending.filter((p) => p !== row); changed(); });
    queue = turn.catch(() => false);
    return turn.catch(() => false);
  }

  // Bring the open sheet forward (a click on its tray row).
  const focus = () => { const d = $<HTMLDialogElement>('egress'); if (d.open) $('egress-deny').focus(); };

  return { approve, focus, get pending() { return pending; } };
}
