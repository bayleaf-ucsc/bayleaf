import puppeteer from '@cloudflare/puppeteer';

const MAX_BYTES = 1024 * 1024;
const MAX_EVENT_CHARS = 64 * 1024;
export const DIRECT_MODEL = 'z-ai/glm-5.3-flash';

// One Worker monotonic clock. Phases are serial awaits; events may overlap them.
export function metrics(now = () => performance.now()) {
  const start = now();
  const phases = {}, events = {};
  let active, frozen, failedPhase, stage = 'gates';
  const elapsed = () => now() - start;
  const end = () => {
    if (!active) return;
    phases[active.name] = elapsed() - active.start;
    active = undefined;
  };
  return {
    begin(name) {
      if (frozen) return;
      end();
      stage = name;
      active = { name, start: elapsed() };
    },
    end,
    stage: () => failedPhase ?? stage,
    fail() { failedPhase ??= stage; },
    mark(name) { if (!frozen && events[name] === undefined) events[name] = elapsed(); },
    async phase(name, operation) {
      this.begin(name);
      try { return await operation(); }
      catch (error) { this.fail(); throw error; }
      finally { end(); }
    },
    snapshot() {
      if (frozen) return frozen;
      end();
      const total = elapsed();
      const accounted = Object.values(phases).reduce((a, b) => a + b, 0);
      frozen = { unit: 'ms', phases, events, total, accounted, unaccounted: Math.max(0, total - accounted),
        ...(failedPhase ? { failed_phase: failedPhase } : {}) };
      return frozen;
    },
  };
}

// Suppress partial opening tags too: '<thi' is not first visible answer text.
function visibleAnswer(answer) {
  return answer.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, '')
    .replace(/<(?:t|th|thi|thin|think|thinki|thinkin|thinking)?$/i, '').trim();
}

// The no-ID OWUI path forwards OpenAI SSE, not browser Socket.IO events.
// Require an answer, a successful finish reason, and the terminal sentinel.
export async function checkStream(body, { timing = metrics(), signal = new AbortController().signal } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let trailingCR = '';
  let bytes = 0;
  let answer = '';
  let stopped = false;
  let done = false;
  let firstAnswer = false;
  let firstByte = false;
  timing.begin('await_first_byte');

  function event(frame) {
    if (frame.length > MAX_EVENT_CHARS) throw new Error('limit');
    const lines = frame.split('\n');
    if (lines.some(line => /^event:\s*error\s*$/.test(line))) throw new Error('stream');
    const data = lines.filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (done) throw new Error('stream');
    if (data === '[DONE]') {
      done = true;
      timing.mark('done');
      timing.begin('done_to_eof');
      return;
    }
    const value = JSON.parse(data);
    if (!value || typeof value !== 'object' || value.error || value.type === 'error') {
      throw new Error('stream');
    }
    if (value.choices === undefined) return; // OWUI metadata, never answer text.
    if (!Array.isArray(value.choices)) throw new Error('stream');
    for (const choice of value.choices) {
      if (choice.index !== 0) throw new Error('stream');
      const delta = choice.delta ?? {};
      if (delta.tool_calls || delta.function_call) throw new Error('tool_call');
      if (delta.content != null) {
        if (typeof delta.content !== 'string' || (stopped && delta.content)) {
          throw new Error('stream');
        }
        answer += delta.content;
        if (!firstAnswer && visibleAnswer(answer)) {
          firstAnswer = true;
          timing.mark('first_answer');
          timing.begin('answer_stream');
        }
      }
      if (choice.finish_reason != null) {
        // OpenRouter may repeat stop in its final, empty-delta usage chunk.
        if (choice.finish_reason !== 'stop') throw new Error('finish');
        if (!stopped) timing.begin('stop_to_done');
        stopped = true;
        timing.mark('stop');
      }
    }
  }

  try {
    while (true) {
      const { value, done: eof } = await bounded(() => reader.read(), signal);
      if (!firstByte && value?.byteLength) {
        firstByte = true;
        timing.mark('first_byte');
        timing.begin('await_answer');
      }
      if (eof) timing.mark('eof');
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_BYTES) throw new Error('limit');
      let text = trailingCR + decoder.decode(value, { stream: !eof });
      trailingCR = !eof && text.endsWith('\r') ? '\r' : '';
      if (trailingCR) text = text.slice(0, -1);
      pending += text.replace(/\r\n?/g, '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        event(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
      }
      if (pending.length > MAX_EVENT_CHARS) throw new Error('limit');
      if (eof) break;
    }
    timing.begin('validation');
    // Incomplete SSE framing is not proof of a completed transaction.
    if (pending.trim() || !stopped || !done || !visibleAnswer(answer)) {
      timing.fail();
      return false;
    }
    return true;
  } catch (error) {
    timing.fail();
    throw error;
  } finally {
    timing.end();
    await timing.phase('stream_cleanup', async () => {
      try { await bounded(() => reader.cancel(), AbortSignal.timeout(1000)); }
      finally { reader.releaseLock(); }
    });
  }
}

export async function probeDetail(apiKey, signal, fetcher = fetch, {
  direct = false, timing = metrics(),
} = {}) {
  signal ??= new AbortController().signal;
  const prefix = direct ? 'openrouter' : 'chat';
  // Uses Chat's existing ZDR inference connection. No parent/chat/session IDs:
  // OWUI does not create a conversation record on this direct HTTP path.
  let response;
  try {
    response = await timing.phase('response_headers', () => bounded(() => {
      timing.mark('request_start');
      return fetcher(direct
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://chat.bayleaf.dev/api/chat/completions', {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: direct ? DIRECT_MODEL : 'basic',
          messages: [{ role: 'user', content: "What's BayLeaf?" }],
          stream: true,
          // Direct inference enforces ZDR at routing, independently of Chat config.
          ...(direct ? { provider: { zdr: true, sort: 'throughput' },
            reasoning: { effort: 'low' }, max_tokens: 2048 } : {}),
        }),
      });
    }, signal));
    timing.mark('response_headers');
  } catch {
    return `${prefix}_transport`;
  }
  timing.begin('header_validation');
  const protocol = response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream' && response.body;
  if (response.status !== 200 || !protocol) timing.fail();
  timing.end();
  if (response.status !== 200) {
    await timing.phase('stream_cleanup', () => bounded(() => response.body?.cancel(), AbortSignal.timeout(1000)));
    return `${prefix}_http_${response.status}`;
  }
  if (!protocol) {
    await timing.phase('stream_cleanup', () => bounded(() => response.body?.cancel(), AbortSignal.timeout(1000)));
    return `${prefix}_protocol`;
  }
  try {
    return await checkStream(response.body, { timing, signal }) ? 'ok' : 'stream_incomplete';
  } catch {
    return 'stream_invalid';
  }
}

export async function probe(apiKey, signal, fetcher = fetch) {
  return (await probeDetail(apiKey, signal, fetcher)) === 'ok';
}

const ORIGIN = 'https://chat.bayleaf.dev';
const MARKER = /^bayleaf-probe-v1:(\d{13}):[0-9a-f-]{36}$/;
const UUID = /^[0-9a-f-]{36}$/;
const CLEANUP_MS = 15000;
const CLOSE_MS = 5000;

// Race each operation, not the whole browser lifecycle: finally must finish
// before headers are returned. Callers also cancel fetches / close the browser.
export async function bounded(operation, signal) {
  signal.throwIfAborted();
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(new Error('aborted'));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }), aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function chatAPI(token, path, signal, method = 'GET', fetcher = fetch) {
  return bounded(async () => {
    const response = await fetcher(`${ORIGIN}/api/v1/${path}`, {
      method, signal, redirect: 'manual', headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status };
    }
    return { status: 200, data: await response.json() };
  }, signal);
}

// v0.11.3 creates opening chats inside /api/chat/completions. Its chat_variables
// are stored atomically with the new record, before the creation reply. Titles
// may change, so recovery checks metadata in this dedicated account only.
export async function cleanupSynthetic(token, userId, signal, {
  marker = null, chatId = null, attempted = false, fetcher = fetch,
} = {}) {
  const listPath = 'chats/list?page=1&include_pinned=true&include_folders=true';
  const listing = await chatAPI(token, listPath, signal, 'GET', fetcher);
  // This account is exclusively synthetic. Stop rather than broaden a scan if
  // it accumulates history. At most five records can be inspected or deleted.
  if (listing.status !== 200 || !Array.isArray(listing.data) || listing.data.length > 5) {
    throw new Error('cleanup_list');
  }
  const candidates = chatId ? listing.data.filter(row => row.id === chatId) : listing.data;
  if (chatId && !candidates.some(row => row.id === chatId)) {
    candidates.push({ id: chatId });
  }
  let deleted = 0;
  const deletedIds = [];
  for (const row of candidates) {
    if (!UUID.test(row.id)) throw new Error('cleanup_id');
    const record = await chatAPI(token, `chats/${row.id}`, signal, 'GET', fetcher);
    const chat = record.data?.chat;
    if (record.status !== 200 || record.data.user_id !== userId) throw new Error('cleanup_identity');
    const tag = record.data.variables?.bayleaf_probe;
    const match = typeof tag === 'string' && tag.match(MARKER);
    if (!match || (marker ? tag !== marker : Number(match[1]) >= Date.now() - 600000)) {
      if (row.id === chatId) throw new Error('cleanup_marker');
      continue;
    }
    if (chat.models?.length !== 1 || chat.models[0] !== 'basic') throw new Error('cleanup_model');
    const users = Object.values(chat.history?.messages ?? {}).filter(m => m.role === 'user');
    if (users.length !== 1 || users[0].content !== "What's BayLeaf?") throw new Error('cleanup_prompt');
    const removed = await chatAPI(token, `chats/${row.id}`, signal, 'DELETE', fetcher);
    if (removed.status !== 200 || removed.data !== true) throw new Error('cleanup_delete');
    // v0.11.3 uses 401 for an absent GET, not 404. A successful list request
    // below distinguishes disappearance from a now-invalid session.
    const absent = await chatAPI(token, `chats/${row.id}`, signal, 'GET', fetcher);
    if (absent.status !== 401) throw new Error('cleanup_verify');
    deleted++;
    deletedIds.push(row.id);
  }
  if (attempted && !deleted) throw new Error('cleanup_unconfirmed');
  const verify = await chatAPI(token, listPath, signal, 'GET', fetcher);
  if (verify.status !== 200 || !Array.isArray(verify.data) ||
      verify.data.some(row => deletedIds.includes(row.id))) {
    throw new Error('cleanup_verify');
  }
  return deleted;
}

// Runs in the page. Details include OWUI reasoning/tool blocks, not the answer.
export function renderedAnswer(complete = false, id = null, observe = false) {
  if (observe) {
    if (location.origin !== 'https://chat.bayleaf.dev') return;
    let first = false, finished = false;
    const observer = new MutationObserver(() => {
      if (!first && renderedAnswer()) {
        first = true;
        void window.__bayleafProbeEvent('first_rendered').catch(() => {});
      }
      if (!finished && renderedAnswer(true)) {
        finished = true;
        void window.__bayleafProbeEvent('complete_rendered').catch(() => {});
      }
      if (first && finished) observer.disconnect();
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    return;
  }
  const message = id ? document.getElementById(`message-${id}`)
    : document.querySelector('#response-content-container')?.closest('[id^="message-"]');
  const content = message?.querySelector('#response-content-container');
  if (!content || !content.getClientRects().length ||
      (complete && !message.querySelector('button.copy-response-button'))) return false;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || node.parentElement.closest('details, button, script, style, svg, think, thinking, [hidden], [aria-hidden="true"]')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    let visible = true;
    for (let element = node.parentElement; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible' || style.opacity === '0') visible = false;
      if (element === content) break;
    }
    if (visible && range.getClientRects().length) return true;
  }
  return false;
}

export async function probeBrowser(sessionToken, browserBinding, signal, {
  driver = puppeteer, fetcher = fetch, timing = metrics(),
} = {}) {
  const started = Date.now();
  const marker = `bayleaf-probe-v1:${started}:${crypto.randomUUID()}`;
  const report = { result: 'browser_identity', cleanup: 'not_needed', close: 'not_started' };
  let browser, userId, chatId, attempted = false, ended = false;
  let stage = 'identity';
  const step = async (name, operation) => {
    stage = name;
    return timing.phase(name, () => bounded(operation, signal));
  };
  const close = async value => {
    // The SDK's browser.close() swallows and console.logs raw CDP errors.
    // Use CDP directly so close failure stays bounded and content-free.
    try {
      await bounded(async () => {
        const cdp = await value.target().createCDPSession();
        await cdp.send('Browser.close');
      }, AbortSignal.timeout(CLOSE_MS));
    } finally {
      await bounded(() => value.disconnect(), AbortSignal.timeout(1000));
    }
  };
  try {
    const identity = await step('identity', () => chatAPI(sessionToken, 'auths/', signal, 'GET', fetcher));
    if (identity.status !== 200 || identity.data?.role !== 'user' || !UUID.test(identity.data.id)) {
      throw new Error('identity');
    }
    userId = identity.data.id;
    await step('stale_cleanup', () => cleanupSynthetic(sessionToken, userId, signal, { fetcher }));
    report.close = 'unconfirmed';
    browser = await step('launch', async () => {
      const value = await driver.launch({ fetch: (url, options) =>
        browserBinding.fetch(url, { ...options, signal }) }, { keep_alive: 60000 });
      if (ended) { await close(value).catch(() => {}); throw new Error('aborted'); }
      browser = value;
      return value;
    });
    const context = await step('context', () => browser.createBrowserContext());
    const page = await step('page', () => context.newPage());
    page.setDefaultTimeout(25000);
    let creationRequest, resolveCreation;
    const creation = new Promise(resolve => { resolveCreation = resolve; });
    await step('interception', () => page.setRequestInterception(true));
    page.on('request', request => {
      void (async () => {
        if (ended || signal.aborted) return request.abort();
        if (request.url() === `${ORIGIN}/api/v1/auths/`) timing.mark('auth_request');
        if (request.url() === `${ORIGIN}/?model=basic`) timing.mark('navigation_request');
        if (request.url() === `${ORIGIN}/api/chat/completions` && request.method() === 'POST') {
          const body = JSON.parse(request.postData());
          if (attempted || body.model !== 'basic' || body.chat_id || body.parent_id !== null ||
              !body.session_id || body.user_message?.content !== "What's BayLeaf?") return request.abort();
          body.chat_variables = { ...body.chat_variables, bayleaf_probe: marker };
          creationRequest = request;
          attempted = true;
          timing.mark('creation_request');
          return request.continue({ postData: JSON.stringify(body) });
        }
        // Fail closed if a later OWUI version changes the creation path again.
        if (request.method() === 'POST' && request.url() === `${ORIGIN}/api/v1/chats/new`) return request.abort();
        return request.continue();
      })().catch(() => { void request.abort().catch(() => {}); });
    });
    page.on('response', response => {
      if (ended) return;
      if (response.url?.() === `${ORIGIN}/api/v1/auths/`) timing.mark('auth_headers');
      if (response.url?.() === `${ORIGIN}/?model=basic`) timing.mark('document_headers');
      if (response.request() === creationRequest) {
        timing.mark('creation_headers');
        if (response.status() !== 200) { resolveCreation(false); return; }
        // Capture immediately, not from the URL after inference. Lost replies
        // are recovered by the exact synthetic marker in finally / next run.
        void response.json().then(data => {
          if (ended) return;
          timing.mark('creation_body');
          if (UUID.test(data?.chat_id)) {
            chatId = data.chat_id;
          }
          resolveCreation(!!chatId);
        }).catch(() => { resolveCreation(false); });
      }
    });
    await step('setup', () => page.evaluateOnNewDocument((origin, token) => {
      if (location.origin !== origin) return;
      localStorage.setItem('token', token);
    }, ORIGIN, sessionToken));
    await step('render_observer', async () => {
      await bounded(() => page.exposeFunction('__bayleafProbeEvent', name => {
        if (ended || !attempted || !['first_rendered', 'complete_rendered'].includes(name)) return;
        // Receipt on the Worker's clock includes the remote CDP transit. Never
        // mix browser performance.now() with Worker timestamps.
        timing.mark('first_rendered');
        if (name === 'complete_rendered') timing.mark(name);
      }), signal);
      await bounded(() => page.evaluateOnNewDocument(renderedAnswer, false, null, true), signal);
    });
    await step('navigation', () => page.goto(`${ORIGIN}/?model=basic`, { waitUntil: 'domcontentloaded', timeout: 25000 }));
    timing.mark('domcontentloaded');
    await step('composer', () => page.waitForSelector('#chat-input', { visible: true }));
    timing.mark('composer_ready');
    await step('typed', async () => {
      await bounded(() => page.focus('#chat-input'), signal);
      // Use the editor's paste handler, not typing/input rules (smart quotes).
      await bounded(() => page.$eval('#chat-input', input => {
        const data = new DataTransfer();
        data.setData('text/plain', "What's BayLeaf?");
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }), signal);
      const exact = await bounded(() => page.$eval('#chat-input', input => input.textContent === "What's BayLeaf?"), signal);
      if (!exact) throw new Error('composer_text');
    });
    timing.mark('send_start');
    await step('submitted', () => page.click('#send-message-button'));
    timing.mark('send_returned');
    await step('first_rendered', () => page.waitForFunction(renderedAnswer));
    timing.mark('first_rendered');
    await step('rendered', () => page.waitForFunction(renderedAnswer, {}, true));
    timing.mark('complete_rendered');
    await step('creation_response', async () => {
      if (!await creation) throw new Error('creation');
    });
    const answerId = await step('persisted', async () => {
      if (!chatId) throw new Error('chat_missing');
      const record = await chatAPI(sessionToken, `chats/${chatId}`, signal, 'GET', fetcher);
      const history = record.data?.chat?.history;
      const answer = history?.messages?.[history.currentId];
      if (record.status !== 200 || record.data.user_id !== userId ||
          record.data.variables?.bayleaf_probe !== marker || record.data.chat.models?.length !== 1 ||
          record.data.chat.models[0] !== 'basic' || answer?.role !== 'assistant' ||
          answer.done !== true || answer.error || typeof answer.content !== 'string' ||
          typeof answer.id !== 'string' || !answer.id || answer.id !== history.currentId ||
          !visibleAnswer(answer.content)) {
        throw new Error('persisted');
      }
      return answer.id;
    });
    timing.mark('persistence_verified');
    await step('render_validation', () => page.waitForFunction(renderedAnswer, {}, true, answerId));
    timing.mark('render_verified');
    report.result = 'ok';
  } catch {
    report.result = signal.aborted ? 'browser_deadline' : `browser_${stage}`;
  } finally {
    ended = true;
    report.stage = stage;
    report.work_result = report.result;
    if (browser) {
      try { await timing.phase('browser_close', () => close(browser)); report.close = 'confirmed'; }
      catch { report.close = 'failed'; }
    }
    if (userId && attempted) {
      report.cleanup = 'failed';
      try {
        await timing.phase('chat_cleanup', () => cleanupSynthetic(sessionToken, userId, AbortSignal.timeout(CLEANUP_MS),
          { marker, chatId, attempted, fetcher }));
        report.cleanup = 'confirmed';
      } catch { /* Failure is part of the result, never a green probe. */ }
    }
    if (report.cleanup === 'failed') report.result = 'browser_cleanup_failed';
    else if (!['confirmed', 'not_started'].includes(report.close)) report.result = 'browser_close_failed';
  }
  report.metrics = timing.snapshot();
  return report;
}

export default {
  async fetch(request, env, ctx) {
    const timing = metrics();
    const respond = (status, text, extra = {}) => new Response(
      request.method === 'HEAD' ? null : `${text}\n`, {
        status,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
          ...extra,
        },
      },
    );
    const url = new URL(request.url);
    const layer = { '/chat/basic': 'owui', '/chat/basic/e2e': 'browser', '/openrouter/basic': 'openrouter' }[url.pathname];
    if (!layer || url.search) return respond(404, 'Not found');
    if (!['HEAD', 'GET'].includes(request.method)) {
      return respond(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    if (!env.PROBE_PASSWORD) return respond(503, 'Not configured');
    const expected = `Basic ${btoa(`probe:${env.PROBE_PASSWORD}`)}`;
    const provided = request.headers.get('Authorization') ?? '';
    const encoder = new TextEncoder();
    const [a, b] = await timing.phase('authentication', () => Promise.all([expected, provided].map(async value =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))));
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    if (difference) {
      return respond(401, 'Unauthorized', { 'WWW-Authenticate': 'Basic realm="probe"' });
    }
    const finish = (status, result, report = {}) => {
      const measurement = timing.snapshot();
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
        'X-BayLeaf-Probe-Result': result,
        'X-BayLeaf-Probe-Stage': report.stage ?? timing.stage(),
        'X-BayLeaf-Probe-Metrics-Version': '2',
        'Server-Timing': [...Object.entries(measurement.phases).map(([name, ms]) => `p_${name};dur=${ms.toFixed(3)}`),
          ...['total', 'accounted', 'unaccounted'].map(name => `${name};dur=${measurement[name].toFixed(3)}`)].join(', '),
        'X-BayLeaf-Probe-Events': Object.entries(measurement.events)
          .map(([name, ms]) => `${name}=${ms.toFixed(3)}`).join(', '),
      };
      if (report.cleanup) headers['X-BayLeaf-Probe-Cleanup'] = report.cleanup;
      if (report.close) headers['X-BayLeaf-Probe-Close'] = report.close;
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({
        version: 2, layer, ...report, result, metrics: measurement,
      }) + '\n', { status, headers });
    };
    timing.begin('configuration');
    if (env.ENABLED !== 'true') { timing.fail(); return finish(503, 'disabled'); }
    const deadline = Number(layer === 'browser' ? (env.BROWSER_DEADLINE_MS ?? env.DEADLINE_MS) : env.DEADLINE_MS);
    if (!Number.isInteger(deadline) || deadline < 1000 || deadline > 55000 || !env.LIMITER) {
      timing.fail();
      return finish(503, 'not_configured');
    }
    if ((layer === 'owui' && !env.OWUI_API_KEY) ||
        (layer === 'openrouter' && !env.OPENROUTER_API_KEY) ||
        (layer === 'browser' && (!env.OWUI_E2E_TOKEN || !env.BROWSER))) {
      timing.fail();
      return finish(503, 'not_configured');
    }
    timing.end();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, deadline);
    try {
      // Independent fixed per-route keys, never caller-controlled. Per-location,
      // not a global spend/concurrency cap. No cached success or inference retry.
      const { success: allowed } = await timing.phase('admission', () => bounded(
        () => env.LIMITER.limit({ key: layer }), controller.signal));
      controller.signal.throwIfAborted();
      if (!allowed) { timing.fail(); return finish(429, 'rate_limited'); }
      if (layer === 'browser') {
        const running = probeBrowser(env.OWUI_E2E_TOKEN, env.BROWSER, controller.signal, { timing });
        // Allow finally to finish after a caller disconnects. A hard runtime
        // crash still needs the next run's bounded stale-marker recovery.
        ctx?.waitUntil(running.catch(() => {}));
        const report = await running;
        const result = report.result === 'browser_deadline' && request.signal.aborted
          ? 'browser_client_aborted' : report.result;
        return finish(result === 'ok' ? 200 : 503, result, report);
      }
      const running = probeDetail(layer === 'openrouter' ? env.OPENROUTER_API_KEY : env.OWUI_API_KEY,
        controller.signal, fetch, { direct: layer === 'openrouter', timing });
      ctx?.waitUntil(running.catch(() => {}));
      const outcome = await running;
      const result = timedOut ? 'deadline' : request.signal.aborted ? 'client_aborted' : outcome;
      return finish(result === 'ok' ? 200 : 503, result);
    } catch {
      const result = timedOut ? 'deadline' : request.signal.aborted ? 'client_aborted' : 'probe_internal';
      return finish(503, result);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
      controller.abort();
    }
  },
};
