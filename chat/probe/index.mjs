const MAX_BYTES = 1024 * 1024;
const MAX_EVENT_CHARS = 64 * 1024;

// The no-ID OWUI path forwards OpenAI SSE, not browser Socket.IO events.
// Require an answer, a successful finish reason, and the terminal sentinel.
export async function checkStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let trailingCR = '';
  let bytes = 0;
  let answer = '';
  let stopped = false;
  let done = false;

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
      }
      if (choice.finish_reason != null) {
        // OpenRouter may repeat stop in its final, empty-delta usage chunk.
        if (choice.finish_reason !== 'stop') throw new Error('finish');
        stopped = true;
      }
    }
  }

  try {
    while (true) {
      const { value, done: eof } = await reader.read();
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
    // Incomplete SSE framing is not proof of a completed transaction.
    if (pending.trim() || !stopped || !done) return false;
    // Some providers put reasoning tags in content instead of a separate field.
    const visible = answer.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, '');
    return visible.trim().length > 0;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function probe(apiKey, signal, fetcher = fetch) {
  // Uses Chat's existing ZDR inference connection. No parent/chat/session IDs:
  // OWUI does not create a conversation record on this direct HTTP path.
  const response = await fetcher('https://chat.bayleaf.dev/api/chat/completions', {
    method: 'POST',
    redirect: 'manual',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: 'basic',
      messages: [{ role: 'user', content: "What's BayLeaf?" }],
      stream: true,
    }),
  });
  if (response.status !== 200 ||
      response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream' ||
      !response.body) {
    await response.body?.cancel();
    return false;
  }
  return checkStream(response.body);
}

export default {
  async fetch(request, env) {
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
    if (url.pathname !== '/chat/basic' || url.search) return respond(404, 'Not found');
    if (!['HEAD', 'GET'].includes(request.method)) {
      return respond(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    if (!env.PROBE_PASSWORD || !env.OWUI_API_KEY) return respond(503, 'Not configured');
    const expected = `Basic ${btoa(`probe:${env.PROBE_PASSWORD}`)}`;
    const provided = request.headers.get('Authorization') ?? '';
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([expected, provided].map(async value =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))));
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    if (difference) {
      return respond(401, 'Unauthorized', { 'WWW-Authenticate': 'Basic realm="probe"' });
    }
    if (env.ENABLED !== 'true') return respond(503, 'Disabled');
    const deadline = Number(env.DEADLINE_MS);
    if (!Number.isInteger(deadline) || deadline < 1000 || deadline > 55000 || !env.LIMITER) {
      return respond(503, 'Not configured');
    }
    const controller = new AbortController();
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const cancel = () => controller.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) controller.abort();
    const timer = setTimeout(cancel, deadline);
    try {
      return await Promise.race([aborted, (async () => {
        // Per-location guard, not a global spend cap. OWUI's own per-user limits
        // remain in effect. No caching: every green check represents new work.
        const { success: allowed } = await env.LIMITER.limit({ key: 'chat-basic' });
        controller.signal.throwIfAborted();
        if (!allowed) return respond(429, 'Rate limited');
        const success = await probe(env.OWUI_API_KEY, controller.signal);
        // Crucially, HEAD also waits: no headers go to UptimeRobot before this.
        return respond(success ? 200 : 503, success ? 'OK' : 'Chat probe failed');
      })()]);
    } catch {
      return respond(503, 'Chat probe failed');
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
      controller.abort();
    }
  },
};
