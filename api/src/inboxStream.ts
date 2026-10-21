/** Bounded SSE observation, not execution. Inbox D1 is canonical; API auth remains
 * canonical too. No content, credentials, URLs or raw failures go into frames/logs.
 * Contract: inbox/DESIGN.md. The service binding exchanges bounded JSON pages,
 * never a buffered SSE response. Reception does not depend on this connection.
 */
import type { Context } from 'hono';
import type { AppEnv } from './types';

type Arrival = { event_id: string; type: 'message.received'; message_id: string; cursor: string; created_at: number };
type Page = { events: Arrival[]; cursor: string; more: boolean; error?: string };
type Lease = { lease_id: string; expires_at: number; after: string | null; error?: string };
const encoder = new TextEncoder();
// Leave headroom below the documented five-second target for timer dispatch.
const FRESH_MS = 4500;
const CHUNK_BYTES = 65536;
const MAX_BYTES = 524288 - 512; // reserve room for the bounded terminal frame
const MAX_EVENTS = 1000;
const setting = (s: string | undefined, fallback: number, max: number) =>
  s && /^\d+$/.test(s) ? Math.max(1, Math.min(max, Number(s))) : fallback;

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('deadline')), ms);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const frame = (name: string, data: unknown, cursor?: string) =>
  `${cursor ? `id: ${cursor}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

export async function openInboxStream(c: Context<AppEnv>, inboxId: string, after: string | undefined,
  authorize: () => Promise<boolean>): Promise<Response | { error: string }> {
  const rpc = c.env.INBOXES!, who = c.get('inboxOwner')!;
  let lease: Lease;
  try {
    lease = await bounded(rpc.acquireEventStream(who, inboxId, after === undefined ? {} : { after }), 4500) as Lease;
    if (!lease || lease.error) return { error: lease?.error || 'unavailable' };
    if (!/^stm_[a-z2-7]{26}$/.test(lease.lease_id) || !Number.isSafeInteger(lease.expires_at) ||
        (lease.after !== null && typeof lease.after !== 'string')) return { error: 'unavailable' };
  } catch { return { error: 'unavailable' }; }
  const maxSeconds = setting(c.env.INBOX_STREAM_SECONDS, 300, 300);
  const pollMs = Math.max(250, setting(c.env.INBOX_STREAM_POLL_MS, 2000, 2000));
  const writeMs = setting(c.env.INBOX_STREAM_WRITE_MS, 2000, 2000);
  const deadline = Math.min(Date.now() + maxSeconds * 1000, lease.expires_at * 1000);
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let ended = false, demand = false, wake: (() => void) | undefined, cursor = lease.after ?? undefined;
  let verifiedAt = Date.now(), bytes = 0, events = 0, ready = false;
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  let watchdog: ReturnType<typeof setInterval>;
  let released: Promise<void> | undefined;
  const release = () => {
    if (!released) {
      released = rpc.releaseEventStream(who, inboxId, lease.lease_id).then(() => {}, () => {});
      c.executionCtx.waitUntil(released);
    }
    return released;
  };
  const finish = (reason: string, abrupt = false) => {
    if (ended) return;
    ended = true;
    clearInterval(watchdog);
    c.req.raw.signal.removeEventListener('abort', disconnected);
    stop(); wake?.();
    try {
      if (!abrupt) {
        controller.enqueue(encoder.encode(frame('end', { reason, ...(cursor && cursor !== 'now' ? { cursor } : {}) })));
        controller.close();
      } else controller.error(new Error('stream ended'));
    } catch { /* Transport already closed. */ }
    void release();
  };
  const disconnected = () => finish('disconnected', true);
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { demand = true; wake?.(); },
    cancel() { disconnected(); return release(); },
  }, { highWaterMark: 0 });
  const pause = async (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([stopped, new Promise<void>(r => { timer = setTimeout(r, ms); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const send = async (text: string) => {
    const chunk = encoder.encode(text);
    if (chunk.byteLength > CHUNK_BYTES - 512) { finish('unavailable', true); return false; }
    if (!demand && !ended) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([stopped, new Promise<void>(resolve => {
          wake = resolve; timer = setTimeout(resolve, writeMs);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); wake = undefined; }
    }
    if (ended) return false;
    if (!demand) { finish('slow_reader', true); return false; }
    // A watchdog can fire while an RPC or pull is awaited; never send afterward.
    if (Date.now() - verifiedAt >= FRESH_MS) { finish('unavailable'); return false; }
    demand = false;
    controller.enqueue(chunk);
    bytes += chunk.byteLength;
    return true;
  };
  watchdog = setInterval(() => {
    if (Date.now() >= deadline) finish('lifetime');
    else if (Date.now() - verifiedAt >= FRESH_MS) finish('unavailable');
  }, 50);
  c.req.raw.signal.addEventListener('abort', disconnected, { once: true });
  if (c.req.raw.signal.aborted) disconnected();

  const run = async () => {
    try {
      while (!ended) {
        const started = Date.now();
        const authorized = await Promise.race([authorize(), stopped.then(() => false)]);
        if (ended) break;
        if (!authorized) { finish('auth_revoked'); break; }
        const page = await Promise.race([
          rpc.readEventStream(who, inboxId, lease.lease_id, cursor === undefined ? {} : { after: cursor }) as Promise<Page>,
          stopped.then(() => null),
        ]);
        if (ended || !page) break;
        if (Date.now() >= deadline) { finish('lifetime'); break; }
        if (page.error) {
          finish(page.error === 'expired' ? 'cursor_expired' : page.error === 'not_found' ? 'not_found' : 'unavailable'); break;
        }
        if (Date.now() - started >= FRESH_MS) { finish('unavailable'); break; }
        verifiedAt = started;
        let text = !ready && events === 0 ? 'retry: 2000\n\n' : '';
        for (const event of page.events) {
          // Rebuild minimal references. Never copy an arbitrary RPC row into SSE.
          const data = { event_id: event.event_id, type: event.type, message_id: event.message_id,
            cursor: event.cursor, created_at: event.created_at };
          text += frame('message.received', data, event.cursor);
        }
        if (!page.more && !ready) text += frame('ready', { cursor: page.cursor }, page.cursor);
        else if (!page.events.length && page.cursor !== cursor) text += frame('checkpoint', { cursor: page.cursor }, page.cursor);
        if (!text) text = ': keepalive\n\n';
        if (bytes + encoder.encode(text).byteLength > MAX_BYTES || events + page.events.length > MAX_EVENTS) {
          finish('replay_limit'); break;
        }
        if (!(await send(text))) break;
        cursor = page.cursor;
        events += page.events.length;
        if (!page.more) ready = true;
        if (events >= MAX_EVENTS || bytes >= MAX_BYTES) { finish('replay_limit'); break; }
        if (!page.more) await pause(pollMs);
      }
    } catch { finish('unavailable'); }
    finally { await release(); }
  };
  c.executionCtx.waitUntil(run());
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate', 'Content-Encoding': 'identity',
    'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } });
}
