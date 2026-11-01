// The Localhost provider (LANGUAGE.md "Provider", trust root: the user's own
// machine): an OpenAI-compatible server on loopback (oMLX, Ollama, LM Studio, or a
// proxy the user runs). Pouch sends that server the context of each step (messages,
// files the model read, tool results); what the server does with them is the
// user's responsibility. No allowance is used and BayLeaf sees nothing.
//
// Boundary (do not loosen): only http://localhost and http://127.0.0.1 (any port)
// are accepted, here in code and again by the page's CSP (connect-src). Not [::1]:
// CSP host sources cannot name IPv6 literals (Chromium ignores 'http://[::1]:*' as
// invalid), so an IPv6-only server is reached as localhost. Every request goes through guardedFetch(), which refuses any other
// origin than the one configured.
//
// Two transports, both pi-ai's own: OpenAI Chat Completions and OpenAI Responses.
// detectTransport() probes POST /responses with an empty body (a 4xx validation
// error means the route exists; 404/405 means it does not), and the user can override.
// Pure module: no DOM, no storage, so node tests import it directly.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { LOCALHOST_STEP_CAP, LOCALHOST_DROP_TOOLS, LOCALHOST_NOTE } from './profiles.ts';

export const LOCALHOST_PROVIDER = 'pouch-localhost';
export const PREFIX = 'localhost:';
export { isLocalhost } from './profiles.ts';
export const LOOPBACK = ['localhost', '127.0.0.1'];
// Hints only; the field's default is oMLX's port.
export const PORT_HINTS = [['oMLX', 12348], ['Ollama', 11434], ['LM Studio', 1234], ['llama.cpp', 8080]];
export const DEFAULT_URL = 'http://127.0.0.1:12348/v1';

// User input -> { ok, base, origin } or { ok: false, error }. base never ends in '/'.
// A bare path ('' or '/') becomes /v1; other paths are kept (a proxy may use one).
export function parseLocalhostUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter the address of a server on this computer, like ' + DEFAULT_URL + '.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw;
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: `"${String(input).trim()}" is not a valid address.` }; }
  if (u.protocol === 'https:') return { ok: false, error: 'Use http:// for a server on this computer. Browsers treat loopback http as secure, and the page only allows http loopback addresses.' };
  if (u.protocol !== 'http:') return { ok: false, error: 'Only http:// addresses on this computer are allowed.' };
  if (u.username || u.password) return { ok: false, error: 'Addresses with a user name or password (user@host) are not allowed. Put a key in the key field instead.' };
  if (u.hostname === '[::1]') return { ok: false, error: 'Use http://localhost instead of [::1]: the page\'s security policy cannot name IPv6 addresses, and localhost reaches the same server.' };
  if (!LOOPBACK.includes(u.hostname)) return { ok: false, error: `${u.hostname} is not this computer. Pouch only talks to localhost or 127.0.0.1; anything else must go through a proxy you run on this computer.` };
  if (u.search || u.hash) return { ok: false, error: 'Leave out ? and # parts: give the server address and path only.' };
  const path = u.pathname.replace(/\/+$/, '');
  const base = u.origin + (path || '/v1');
  return { ok: true, base, origin: u.origin };
}

// The only fetch the Localhost provider uses. It refuses anything but the configured
// loopback origin, sets the user's key (or none), and drops the OpenAI SDK's
// x-stainless-* headers so a preflight only asks for authorization and content-type.
export function guardedFetch(getConfig, { fetchImpl = (...a) => fetch(...a) } = {}) {
  return async (input, init = {}) => {
    const cfg = getConfig();
    const ok = cfg && parseLocalhostUrl(cfg.base);
    if (!ok?.ok) throw new LocalhostError('setup', 'Localhost is not set up: Settings > Providers > Localhost.');
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== ok.origin || !LOOPBACK.includes(url.hostname)) throw new LocalhostError('refused', `Refusing to send to ${url.origin}: Localhost only talks to ${ok.origin}.`);
    const headers = new Headers(init.headers);
    for (const k of [...headers.keys()]) if (k.startsWith('x-stainless')) headers.delete(k);
    if (cfg.key) headers.set('authorization', `Bearer ${cfg.key}`); else headers.delete('authorization');
    try { return await fetchImpl(url.href, { ...init, headers }); }
    catch (e) {
      if (init.signal?.aborted || e?.name === 'AbortError') throw e;
      throw await diagnose(ok, fetchImpl, e);
    }
  };
}

export class LocalhostError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
const pageOrigin = () => (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : null);

// Local Network Access (Chrome): a permission the user grants or denies per site.
// The permission name changed during rollout, so both are asked.
async function lnaState() {
  if (typeof navigator === 'undefined' || !navigator.permissions) return null;
  for (const name of ['loopback-network', 'local-network-access', 'local-network']) {
    try { return (await navigator.permissions.query({ name })).state; } catch {}
  }
  return null;
}

// A failed fetch says nothing about why. A no-cors request reaches the server
// without asking it for CORS: if it resolves, the server is up and the real request
// was blocked by CORS; if it fails too, the server is unreachable (or the browser's
// local network permission was denied).
export async function diagnose(ok, fetchImpl, cause) {
  const origin = pageOrigin();
  if ((await lnaState()) === 'denied') return new LocalhostError('lna', `Your browser blocked this page from reaching servers on this computer (local network access is denied for ${origin ?? 'this page'}). Allow it in the site settings (the icon left of the address), then press Test connection again.`);
  let reachable = false;
  try { await fetchImpl(ok.origin + '/', { mode: 'no-cors', cache: 'no-store' }); reachable = true; } catch {}
  if (reachable) return new LocalhostError('cors', `Your server at ${ok.origin} answered but did not allow this page (CORS). Add ${origin ?? 'this page\'s origin'} to its allowed origins${origin ? '' : ' (a page opened from a file has origin "null"; serve Pouch over http instead)'}, restart it, and test again. ${CORS_HOWTO}`);
  return new LocalhostError('unreachable', `Nothing answered at ${ok.origin}. Is the server running and listening on that port? (${String(cause?.message ?? cause)})`);
}
export const CORS_HOWTO = 'oMLX: server.cors_origins in ~/.omlx/settings.json. Ollama: OLLAMA_ORIGINS. LM Studio: Developer > Settings > Enable CORS.';

// One readable sentence for an HTTP failure or a pi-ai error message.
export function explain(status, body = '', modelId = '') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (status === 401 || status === 403 || /authentication_error|invalid api key|api key required/i.test(text)) return { kind: 'auth', message: /required/i.test(text) ? 'Your server needs an API key: add it in Settings > Providers > Localhost.' : 'Your server refused the API key (401). Check the key in Settings > Providers > Localhost.' };
  if (/context_length_exceeded|too long|maximum context|context window|context length/i.test(text)) return { kind: 'context', message: `The conversation is longer than ${modelId || 'this model'}'s context on your server. Compact the session (/compact), start a new one, or pick a model with a longer context.` };
  if (status === 404 && /model/i.test(text)) return { kind: 'model', message: `Your server has no model named ${modelId || 'that'} (any more). Press Test connection to refresh the list, or pick another model.` };
  if (status === 404) return { kind: 'route', message: 'Your server does not have this endpoint (404). Try the other transport in Settings > Providers > Localhost.' };
  if (status >= 500) return { kind: 'server', message: `Your server failed (${status}): ${text.slice(0, 200)}` };
  return { kind: 'http', message: `Your server answered ${status}: ${text.slice(0, 200)}` };
}
// For display: pi-ai renders HTTP errors as "401: {...}" or "<provider> API error (401): {...}",
// and pi-durable may prefix "model_error: ". Errors the guarded fetch wrote pass through.
export function explainMessage(msg, modelId) {
  const s = String(msg ?? '').replace(/^\w+_error:\s*/, '');
  if (/^(Your server|Your browser|Nothing answered|Refusing|Localhost)/.test(s)) return s;
  const m = /^(?:[\w -]+ API error \()?(\d{3})\)?(?::|\s)\s*([\s\S]*)$/.exec(s);
  return m ? explain(Number(m[1]), m[2], modelId).message : null;
}

const readBody = async (r) => { try { return await r.text(); } catch { return ''; } };

// Test connection: reachability, auth, CORS, models, transport. Never generates.
// Returns { ok, base, models: [{ id, contextWindow }], transport, steps: [{ name, ok, text }], error? }.
export async function testConnection({ url, key, transport = 'auto' }, { fetchImpl } = {}) {
  const parsed = parseLocalhostUrl(url);
  if (!parsed.ok) return { ok: false, error: parsed.error, steps: [{ name: 'address', ok: false, text: parsed.error }] };
  const cfg = { base: parsed.base, key };
  const f = guardedFetch(() => cfg, { fetchImpl });
  const steps = [{ name: 'address', ok: true, text: `Only ${parsed.origin} (this computer).` }];
  const fail = (name, text, kind) => ({ ok: false, base: parsed.base, error: text, kind, steps: [...steps, { name, ok: false, text }] });
  let r;
  try { r = await f(parsed.base + '/models', { headers: { accept: 'application/json' } }); }
  catch (e) { return fail(e.kind === 'cors' ? 'cors' : e.kind === 'lna' ? 'permission' : 'reach', e.message, e.kind); }
  steps.push({ name: 'reach', ok: true, text: `Your server answered${r.headers.get('server') ? ` (${r.headers.get('server')})` : ''}.` });
  steps.push({ name: 'cors', ok: true, text: 'It allows this page (CORS).' });
  if (!r.ok) { const ex = explain(r.status, await readBody(r)); return fail(ex.kind === 'auth' ? 'auth' : 'models', ex.message, ex.kind); }
  steps.push({ name: 'auth', ok: true, text: key ? 'Your key was accepted.' : 'No key needed.' });
  let list;
  try { list = (await r.json()).data; } catch { list = null; }
  if (!Array.isArray(list)) return fail('models', 'Your server answered /models without an OpenAI-style model list.');
  const models = list.filter((m) => m && typeof m.id === 'string' && !/embed|rerank|whisper|tts/i.test(m.id))
    .map((m) => ({ id: m.id, contextWindow: num(m.max_model_len ?? m.context_length ?? m.max_context_length ?? m.loaded_context_length) }));
  if (!models.length) return fail('models', 'Your server lists no chat models. Load or download one there, then test again.');
  steps.push({ name: 'models', ok: true, text: `${models.length} model${models.length === 1 ? '' : 's'}: ${models.map((m) => m.id).join(', ')}.` });
  const detected = await detectTransport(f, parsed.base);
  const chosen = transport === 'auto' ? detected : transport;
  steps.push({ name: 'transport', ok: true, text: `${TRANSPORTS[chosen]}${transport === 'auto' ? ' (detected)' : ` (chosen; detected ${TRANSPORTS[detected]})`}.` });
  return { ok: true, base: parsed.base, models, transport: chosen, detected, steps };
}
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
export const TRANSPORTS = { completions: 'OpenAI Chat Completions', responses: 'OpenAI Responses' };

export async function detectTransport(f, base) {
  try {
    const r = await f(base + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await readBody(r);
    return r.status === 400 || r.status === 422 ? 'responses' : 'completions';
  } catch { return 'completions'; }
}

// pi-ai model records. reasoning: false keeps pi-ai from sending reasoning
// controls a local server may reject; thinking still streams (reasoning_content,
// reasoning summary events). Text only: /models does not say which models see images.
export function localhostModel(m, cfg) {
  const ctxWindow = m.contextWindow ?? 32_768;
  const api = cfg.transport === 'responses' ? 'openai-responses' : 'openai-completions';
  return {
    id: PREFIX + m.id, name: `${m.id} (Localhost)`, api, provider: LOCALHOST_PROVIDER, baseUrl: cfg.base,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctxWindow, maxTokens: Math.min(16_384, Math.floor(ctxWindow / 4)),
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
}

// The localhost profile, applied at the provider seam (like transformersjs): the
// subagent and agents tools are taken out of what the model sees, a short note
// says so, and a step cap ends runaway loops. The model id on the wire loses PREFIX.
export function applyProfile(context) {
  const messages = context.messages.map((m) => m.role === 'system' && m.toolsAdded?.length
    ? { ...m, toolsAdded: m.toolsAdded.filter((t) => !LOCALHOST_DROP_TOOLS.includes(t.name)) } : m);
  const first = messages.findIndex((m) => m.role === 'system');
  if (first >= 0 && messages.some((m) => m.role === 'system' && m.toolsAdded?.length)) messages[first] = { ...messages[first], content: messages[first].content + '\n\n' + LOCALHOST_NOTE };
  return { ...context, messages };
}
export function stepsThisTurn(messages) {
  const last = messages.findLastIndex((m) => m.role === 'user');
  return messages.slice(last + 1).filter((m) => m.role === 'assistant').length;
}

const SLOW_MS = 4000;
// apis: { completions, responses } (pi-ai ProviderStreams). getConfig() -> { base, key }.
// onWait(kind, model): 'slow' when no token has come for SLOW_MS (the server may be
// loading the model), 'flowing' when tokens start after that.
export function localhostApi(apis, getConfig, { fetchImpl, onWait } = {}) {
  const fetch = guardedFetch(getConfig, { fetchImpl });
  function stream(model, context, options = {}) {
    const out = createAssistantMessageEventStream();
    const wire = { ...model, id: model.id.slice(PREFIX.length), baseUrl: getConfig()?.base ?? model.baseUrl };
    const withTools = context.messages.some((m) => m.role === 'system' && m.toolsAdded?.length);
    if (withTools && stepsThisTurn(context.messages) >= LOCALHOST_STEP_CAP) {
      const text = `[Localhost: stopped after ${LOCALHOST_STEP_CAP} steps, its cap for one message. Send "continue" to go on.]`;
      const msg = { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: 'stop', timestamp: Date.now() };
      queueMicrotask(() => { out.push({ type: 'start', partial: msg }); out.push({ type: 'text_start', contentIndex: 0, partial: msg }); out.push({ type: 'text_end', contentIndex: 0, content: text, partial: msg }); out.push({ type: 'done', reason: 'stop', message: msg }); out.end(msg); });
      return out;
    }
    const api = model.api === 'openai-responses' ? apis.responses : apis.completions;
    (async () => {
      let slow = false;
      const timer = setTimeout(() => { slow = true; onWait?.('slow', model); }, SLOW_MS);
      const settle = () => { clearTimeout(timer); if (slow) { slow = false; onWait?.('flowing', model); } };
      try {
        const inner = api.stream(wire, applyProfile(context), { ...options, apiKey: getConfig()?.key || 'none', fetch: tracked });
        for await (const e of inner) {
          if (e.type !== 'start') settle();
          if (e.type === 'error') e.error.errorMessage = rewrite(e.error.errorMessage);
          out.push(e);
        }
        const msg = await inner.result();
        if (msg.stopReason === 'error') msg.errorMessage = rewrite(msg.errorMessage); // idempotent
        out.end(msg);
      } catch (e) { out.end(failMessage(model, String(e?.message ?? e))); }
      finally { settle(); }
    })();
    return out;
  }
  // pi-ai hides fetch failures behind "Connection error."; the guarded fetch's own
  // diagnosis (unreachable, CORS, permission) is the message worth showing. HTTP
  // errors stay as pi-ai wrote them: pi-durable reads them (a context overflow
  // compacts and retries); explainMessage() words them for display.
  let lastFailure = null;
  const tracked = async (...a) => { try { lastFailure = null; return await fetch(...a); } catch (e) { lastFailure = e; throw e; } };
  const rewrite = (msg) => (/^connection error/i.test(msg ?? '') && lastFailure?.message ? lastFailure.message : msg);
  return { stream, streamSimple: stream };
}
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const failMessage = (model, message) => ({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: 'error', errorMessage: message, timestamp: Date.now() });
