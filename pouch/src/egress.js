// Data leaving the pouch (D10): the approval sheet for the `bayleaf` command
// (src/bayleaf-cli.js asks approveEgress before every request) and the
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
import * as store from './store.js';
import { $, el } from './dom.js';
import { grantsKey } from './sessions.js';

const SERVICE = { web: 'web search and fetch', sandbox: 'your sandbox VM', inbox: 'your inboxes', account: 'your BayLeaf account status' };
export const serviceName = (s) => SERVICE[s] ?? s;

export const grantsFor = async (sid) => (sid == null ? [] : (await store.getSetting(grantsKey(sid))) ?? []);
async function grant(sid, service) {
  const list = await grantsFor(sid);
  if (!list.includes(service)) await store.setSetting(grantsKey(sid), [...list, service]);
}
export async function revoke(sid, service) {
  const list = (await grantsFor(sid)).filter((s) => s !== service);
  await store.setSetting(grantsKey(sid), list.length ? list : undefined);
}

const MARKER = /\n?\[this call sent data outside the pouch: ([^\]\n]*)\](?=(?:\n\[exit code \d+\])?\s*$)/;
const LEFT = /^\[left the pouch: ([^\]\n]*)\]$/gm;
// Audiences are joined with '; ', which some also contain inside parentheses.
function splitTop(s) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth = Math.max(0, depth - 1);
    else if (!depth && s.startsWith('; ', i)) { out.push(s.slice(from, i)); from = i + 2; }
  }
  return [...out, s.slice(from)].filter(Boolean);
}
// { commands, audiences, text } where text is the output without the marker
// line; null when the call sent nothing.
export function egressOf(output) {
  const s = String(output ?? '');
  const m = s.match(MARKER);
  if (!m) return null;
  const audiences = [...new Set([...s.matchAll(LEFT)].flatMap((x) => splitTop(x[1])))];
  return { commands: m[1].split(', '), audiences, text: s.slice(0, m.index) + s.slice(m.index + m[0].length) };
}

// deps: { sessionTitle(sid) -> Promise<string>, onGrant() }
export function createEgress(deps = {}) {
  let queue = Promise.resolve();

  function ask(req, sid, title, agentName) {
    return new Promise((resolve) => {
      const d = $('egress');
      let answer = false;
      const choose = (v) => { answer = v; d.close(); };
      // A subagent's request says so: it runs unattended, so name who asks.
      $('egress-h').textContent = agentName ? `Subagent "${agentName}" wants to send this outside the pouch` : 'Send this outside the pouch?';
      $('egress-summary').textContent = req.summary ?? req.command;
      $('egress-meta').textContent = `${req.command} · ${agentName ? `subagent ${agentName} · ` : ''}session: ${title}`;
      $('egress-detail').textContent = req.detail ?? '';
      $('egress-audiences').replaceChildren(...(req.audiences ?? []).map((a) => el('li', { textContent: a })));
      $('egress-session').textContent = `Allow ${serviceName(req.service)} for this session`;
      $('egress-deny').onclick = () => choose(false);
      $('egress-once').onclick = () => choose('once');
      $('egress-session').onclick = () => choose('session');
      // The backdrop is the dialog box itself, outside its content rectangle.
      d.onclick = (e) => {
        if (e.target !== d) return;
        const r = d.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) choose(false);
      };
      d.addEventListener('close', () => resolve(answer), { once: true }); // Esc lands here too: false
      d.showModal();
      d.scrollTop = 0; $('egress-detail').scrollTop = 0;
      $('egress-deny').focus();
    });
  }

  // The hook bayleaf-cli.js awaits. Resolves true only on an explicit allow.
  // agentName: the subagent asking, or none for the main agent. A session
  // grant covers the session's subagents too.
  function approve(req, sid, agentName) {
    const turn = queue.then(async () => {
      if ((await grantsFor(sid)).includes(req.service)) return true;
      const v = await ask(req, sid, await deps.sessionTitle?.(sid) ?? 'this session', agentName);
      if (v === 'session' && sid != null) { await grant(sid, req.service); deps.onGrant?.(); }
      return v === 'once' || v === 'session';
    });
    queue = turn.catch(() => false);
    return turn.catch(() => false);
  }

  return { approve };
}
