/** Computer-use transport and stateless generation handles. No lifecycle calls,
 * request/response logging, content storage, or retries of possibly applied input.
 */
import { sign, verify } from 'hono/jwt';
import type { Bindings, UserKeyRow } from './types';
import { credentialHash } from './sandboxCredentials';
import { DAYTONA_DEFAULT_PROXY_URL } from './constants';

// Constant, read-only probe. No shell arguments, paths or code come from callers.
// Read stat after the last ')' because comm can itself contain parentheses.
const GENERATION_CODE = `import json, pathlib, signal
signal.alarm(3)
p = pathlib.Path("/proc")
boot = (p / "sys/kernel/random/boot_id").read_text().strip()
found = []
for d in p.iterdir():
    if not d.name.isdecimal(): continue
    try:
        if (d / "comm").read_text().strip() != "Xvfb": continue
        args = (d / "cmdline").read_bytes().split(b"\\0")
        if len(args) < 2 or args[1] != b":0": continue
        stat = (d / "stat").read_text()
        start = stat[stat.rfind(")") + 2:].split()[19]
        found.append([boot, d.name, start])
    except (FileNotFoundError, ProcessLookupError): pass
print(json.dumps(found, separators=(",", ":")))`;
export const COMPUTER_GENERATION_COMMAND = `python3 -c '${GENERATION_CODE}'`;

export function computerError(status: 400 | 401 | 403 | 409 | 410 | 423 | 502, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
}
export const sessionEnded = () => computerError(410, 'session_ended',
  'Desktop generation changed or Toolbox failed. Discard this session. Start the sandbox or Desktop deliberately if needed, then open a new session.');

/** proxy is trusted provider metadata only, never a caller-selected destination. */
export async function computerToolbox(env: Bindings, id: string, path: string, body?: unknown, proxy?: string): Promise<Response | null> {
  try {
    return await fetch(`${(proxy || env.DAYTONA_PROXY_URL || DAYTONA_DEFAULT_PROXY_URL).replace(/\/+$/, '')}/${encodeURIComponent(id)}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${env.DAYTONA_API_KEY}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(8000), cache: 'no-store',
    });
  } catch { return null; }
}

/** Accept PascalCase and lowercase without recursively rewriting user strings. */
export function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const key = Object.keys(value).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : (value as Record<string, unknown>)[key];
}

export async function desktopGeneration(env: Bindings, id: string, proxy?: string): Promise<string | Response> {
  const r = await computerToolbox(env, id, '/process/execute', { command: COMPUTER_GENERATION_COMMAND, timeout: 5000 }, proxy);
  if (!r?.ok) {
    const status = r?.status;
    await r?.body?.cancel();
    return computerError(status === 404 || status === 410 ? 410 : 409,
      'sandbox_not_running', 'Toolbox unavailable. Start the sandbox or Desktop deliberately, then open a new session.');
  }
  try {
    const data: unknown = await r.json();
    const output = field(data, 'result') ?? field(data, 'output');
    if (field(data, 'exitCode') !== 0 || typeof output !== 'string' || output.length > 512) return desktopMissing();
    const triples: unknown = JSON.parse(output);
    if (!Array.isArray(triples) || triples.length !== 1 || !Array.isArray(triples[0]) || triples[0].length !== 3) return desktopMissing();
    const [boot, pid, start] = triples[0];
    if (typeof boot !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot) ||
        typeof pid !== 'string' || !/^[1-9][0-9]{0,9}$/.test(pid) ||
        typeof start !== 'string' || !/^[1-9][0-9]{0,19}$/.test(start)) return desktopMissing();
    return credentialHash(JSON.stringify([boot, pid, start]));
  } catch { return desktopMissing(); }
}
const desktopMissing = () => computerError(409, 'desktop_not_running',
  'Cannot identify exactly one Xvfb on display :0. Start Desktop deliberately, then open a new session.');

const purpose = 'bayleaf-computer-session-v1';
const ownerHash = (row: UserKeyRow) => credentialHash(`${purpose}:${row.account_generation}:${row.email}`);
export async function openComputerSession(env: Bindings, row: UserKeyRow, id: string, generation: string) {
  if (!env.OIDC_CLIENT_SECRET) return null;
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const session = await sign({ purpose, owner: await ownerHash(row), sandbox: id, generation,
    nonce: crypto.randomUUID(), exp }, `${purpose}:${env.OIDC_CLIENT_SECRET}`, 'HS256');
  return { session, expires_at: exp };
}
export async function verifyComputerSession(env: Bindings, row: UserKeyRow, id: string, token: string): Promise<string | null> {
  if (!env.OIDC_CLIENT_SECRET) return null;
  try {
    const p = await verify(token, `${purpose}:${env.OIDC_CLIENT_SECRET}`, 'HS256');
    if (p.purpose !== purpose || p.owner !== await ownerHash(row) || p.sandbox !== id ||
        typeof p.exp !== 'number' || typeof p.nonce !== 'string' ||
        typeof p.generation !== 'string' || !/^[a-f0-9]{64}$/.test(p.generation)) return null;
    return p.generation;
  } catch { return null; }
}

/** Future hook: ask the owner's SandboxBrowser DO before forwarding any input.
 * Replace with an owner-serialized floor check returning 423 human_has_floor.
 * This no-op is deliberately not a lock or a claim of human/agent exclusion:
 * for now anyone (owner, agents, the Desktop viewer) may send events at any time.
 *
 * Floor-control sketch (2026-10-24, not built): the DO holds
 * { holder: 'human' | 'agent' | 'none', agentLabel, since, note }. Agents are
 * enforced here (423 for input, and screenshots refused while a human holds the
 * floor, as a privacy screen for logins). The human side is soft: noVNC loads
 * view-only while an agent holds the floor and a dashboard "Take over" pill
 * flips it. A human floor lapses to 'none' after ~30 s with no open viewer
 * WebSockets (the gateway's PreviewConnections already counts them), unless the
 * human took over in answer to an agent's own handoff request. Direct X11 inside
 * the sandbox stays outside this by design: coordination, not a security boundary.
 */
export async function checkComputerFloor(_env: Bindings, _owner: string): Promise<Response | null> { return null; }
