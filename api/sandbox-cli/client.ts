import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import { tools, fullComputerSchema } from './contracts';
import { ComputerSessionResponseSchema } from '../src/schemas';

export class Failure extends Error {
  constructor(public code: string, public status?: number) { super(code); }
}
const fail = (code: string): never => { throw new Failure(code); };
const privateFile = async (path: string) => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o077) || st.size > 8192) fail('private_file_unsafe');
    return await file.readFile('utf8');
  } finally { await file.close(); }
};
export async function credential(env = process.env, home = homedir()): Promise<string> {
  let value = env.BAYLEAF_API_KEY;
  if (value === undefined) {
    // Fixed managed locations only, not a desktop credential store. MCP children
    // may receive proxy/CA settings but no owner credential environment.
    for (const service of ['browser', 'nanobot', 'ttyd', 'jupyter', 'code-server', 'dufs', 'collabmd']) {
      try { value = (await privateFile(join(home, '.local/share/bayleaf', service, 'credentials/owner-key'))).trim(); break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fail('credential_unavailable'); }
    }
  }
  if (!value || !/^(?:dtn_secret_[A-Za-z0-9_-]+|sk-bayleaf-(?:sandbox-)?[A-Za-z0-9_-]+)$/.test(value)) fail('credential_missing_or_invalid');
  return value!;
}
export function redact(value: unknown, key: string): string {
  const text = JSON.stringify(value);
  if (text.includes(key) || /(?:sk-bayleaf-|dtn_secret_)[A-Za-z0-9_-]+/.test(text)) fail('credential_in_response');
  return text;
}
type Session = { session: string; expires_at: number; binding: string };
export class SessionStore {
  readonly path: string;
  constructor(readonly dir = join(homedir(), '.local/state/bayleaf/computer')) { this.path = join(dir, 'session.json'); }
  async directory() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const s = await lstat(this.dir);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077)) fail('session_store_unsafe');
  }
  async get(binding: string): Promise<Session> {
    await this.directory();
    let s: Session;
    try { s = JSON.parse(await privateFile(this.path)); }
    catch { return fail('session_required'); }
    if (!ComputerSessionResponseSchema.safeParse({ session: s.session, expires_at: s.expires_at }).success ||
        s.binding !== binding || s.expires_at <= Date.now() / 1000 || s.expires_at > Date.now() / 1000 + 86401) {
      await this.clear(); return fail('session_ended');
    }
    return s;
  }
  async put(s: Session) {
    await this.directory();
    const temp = `${this.path}.${randomUUID()}`;
    const f = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await f.writeFile(JSON.stringify(s)); await f.sync(); } finally { await f.close(); }
    await rename(temp, this.path);
  }
  async clear() {
    await this.directory();
    await unlink(this.path).catch(e => { if (e.code !== 'ENOENT') fail('session_store_unsafe'); });
  }
}
export async function bounded(response: Response, max = 2 * 1024 * 1024): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) fail('response_too_large'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export function image(bytes: Uint8Array, type: string): { data: string; mimeType: string } {
  let b = Buffer.from(bytes);
  if (type === 'application/json') {
    let parsed;
    try { parsed = JSON.parse(b.toString('utf8')); } catch { return fail('invalid_image'); }
    const value = parsed?.screenshot ?? parsed?.Screenshot;
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value) fail('invalid_image');
    b = Buffer.from(value, 'base64');
  }
  const detected = b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
    b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255 ? 'image/jpeg' :
    b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!detected || (type !== 'application/json' && type !== detected)) fail('invalid_image');
  return { data: b.toString('base64'), mimeType: detected! };
}
export class Client {
  private binding: string;
  constructor(private key: string, readonly store = new SessionStore(), private transport: typeof fetch = fetch) {
    this.binding = createHash('sha256').update(key).digest('hex');
  }
  async call(name: string, args: unknown = {}) {
    const tool = tools.find(t => t.name === name);
    if (!tool) fail('unknown_tool');
    const parsed = tool!.schema.safeParse(args);
    if (!parsed.success) fail('invalid_arguments');
    let body = parsed.data as Record<string, unknown>;
    if (name === 'expose' && body.upstream_headers) {
      for (const value of Object.values(body.upstream_headers as Record<string, string>)) {
        const decoded = /^Basic\s+/i.test(value) ? Buffer.from(value.replace(/^Basic\s+/i, ''), 'base64').toString('utf8') : '';
        if ([value, decoded].some(v => v.includes(this.key) || /(?:sk-bayleaf-|dtn_secret_|sk-or-|tk_|admin_|eyJ)[A-Za-z0-9_-]+/.test(v))) fail('platform_credential_forbidden');
      }
    }
    const computer = tool!.group === 'computer', opening = name === 'open_session';
    if (computer && !opening) {
      const s = await this.store.get(this.binding);
      const p = fullComputerSchema(tool!.path).safeParse({ ...body, session: s.session });
      if (!p.success) fail('invalid_arguments'); body = p.data as Record<string, unknown>;
    }
    if (name === 'inbox_create' || name === 'inbox_lifetime') {
      if (body.ttl_seconds !== undefined && body.preset !== undefined) fail('invalid_arguments');
      if (name === 'inbox_lifetime' && body.ttl_seconds === undefined && body.preset === undefined) fail('invalid_arguments');
      if (name === 'inbox_create' && (body.type === 'http' ? body.access === undefined || body.email_auth != null : body.access !== undefined)) fail('invalid_arguments');
    }
    let path = tool!.path;
    body = { ...body };
    for (const param of tool!.params ?? []) { path = path.replace(`{${param}}`, encodeURIComponent(String(body[param]))); delete body[param]; }
    if (tool!.query) path += '?' + new URLSearchParams(Object.entries(body).map(([k,v]) => [k,String(v)]));
    // Fixed HTTPS origin, manual redirect rejection. Never retry, including GET.
    // Future floor-control location: central API owns serialization, not this client.
    try {
      const r = await this.transport(`https://api.bayleaf.dev${path}`, { method: tool!.method,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: tool!.method === 'GET' || tool!.method === 'DELETE' ? undefined : JSON.stringify(body),
        redirect: 'manual', signal: AbortSignal.timeout(30000), cache: 'no-store' });
      if (!r.ok) {
        await r.body?.cancel();
        // Never copy upstream error strings into output. Unknown failures may have applied input.
        throw new Failure(r.status === 410 && computer ? 'session_ended' : `http_${r.status}`, r.status);
      }
      if (name === 'unexpose') {
        await r.body?.cancel();
        if (r.status !== 204) fail('invalid_response');
        return { data: { revoked: true } };
      }
      const bytes = await bounded(r, tool!.image ? 16 * 1024 * 1024 : 2 * 1024 * 1024);
      if (tool!.image) return { image: image(bytes, r.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '') };
      let data;
      try { data = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return fail('invalid_response'); }
      redact(data, this.key);
      if (name === 'expose') {
        const url = new URL(data.url);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.bayleaf-proxies.dev') || url.username || url.password ||
            !Number.isFinite(Date.parse(data.expires_at)) ||
            (Object.keys((body.upstream_headers ?? {}) as object).length > 0 && data.upstream_headers_applied !== true)) fail('invalid_response');
        return { data: { url: data.url, expires_at: data.expires_at,
          ...(data.upstream_headers_applied === true ? { upstream_headers_applied: true } : {}) } };
      }
      if (opening) {
        const p = ComputerSessionResponseSchema.safeParse(data);
        if (!p.success) return fail('invalid_response');
        if (p.data.expires_at <= Date.now()/1000 || p.data.expires_at > Date.now()/1000+86401) fail('invalid_response');
        await this.store.put({ ...p.data, binding: this.binding });
        return { data: { opened: true, expires_at: p.data.expires_at } };
      }
      if (computer && !tool!.read && data?.success !== true) fail('invalid_response');
      return { data, untrusted: tool!.group === 'inboxes' || name === 'windows' };
    } catch (e) {
      if (computer) await this.store.clear();
      if (e instanceof Failure) throw e;
      throw new Failure('transport_or_response_failed');
    }
  }
}
export function networkFetch(env = process.env): typeof fetch {
  // Node fetch otherwise ignores Daytona's HTTPS proxy on older supported Node.
  // EnvHttpProxyAgent preserves TLS verification and NODE_EXTRA_CA_CERTS.
  const dispatcher = new EnvHttpProxyAgent({ httpProxy: env.http_proxy ?? env.HTTP_PROXY,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY, noProxy: env.no_proxy ?? env.NO_PROXY });
  return ((url, init) => proxyFetch(url as string, { ...init, dispatcher } as any)) as typeof fetch;
}
export async function saveOutput(path: string, bytes: Uint8Array) {
  const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(bytes); } finally { await f.close(); }
}
