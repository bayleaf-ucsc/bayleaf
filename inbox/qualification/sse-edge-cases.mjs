#!/usr/bin/env node
// Live SSE edge-case AX qualification against the operator pilot (2026-10-21).
// Consolidated single-inbox run: the shared per-owner inbox pool was 10/10 full
// during this window, so one disposable short-TTL HTTP inbox serves every phase
// and the TTL observation reuses the documented shorten-only PATCH. Bounded: one
// inbox, two synthetic self-posts, at most four concurrent subscribers (the
// documented cap) plus refused attempts, creation retried on 409 with a hard
// twelve-minute ceiling. The owner key is read from the environment only; output
// carries statuses, timings and frame ids, never tokens, addresses or content.
// Contract: inbox/DESIGN.md "Arrival events and live SSE". Qualification only.
import assert from 'node:assert/strict';

const key = process.env.BAYLEAF_API_KEY;
if (!key) throw new Error('Set BAYLEAF_API_KEY privately through the launcher environment, never as an argument.');
const base = process.env.BAYLEAF_API_BASE || 'https://api.bayleaf.dev';
assert.equal(new URL(base).protocol, 'https:');

const OVERALL_MS = 14 * 60_000; // includes bounded waiting for a free inbox slot
const t0 = Date.now();
const left = () => Math.max(1, OVERALL_MS - (Date.now() - t0));
const out = (phase, result) => console.log(JSON.stringify({ phase, ...result }, null, 0));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let inboxA, senderA, secondEventId;
const request = async (path, init = {}, bearer = key) => {
  const { headers: extra, ...rest } = init;
  const r = await fetch(base + path, { ...rest, redirect: 'manual',
    signal: AbortSignal.timeout(Math.min(15_000, left())),
    headers: bearer === null ? extra : { Authorization: `Bearer ${bearer}`, ...extra } });
  return r;
};
const ownerApi = async (path, init) => {
  const r = await request(path, init);
  const body = r.status === 202 && init?.method === 'DELETE' ? null : await r.json().catch(() => null);
  return { status: r.status, body };
};
const deliver = async (inbox, n) => {
  const r = await fetch(inbox.url, { method: 'POST', redirect: 'manual',
    signal: AbortSignal.timeout(12_000),
    headers: { Authorization: `Bearer ${senderA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ qualification: 'synthetic sse edge case', sequence: n }) });
  const status = r.status; await r.body?.cancel();
  return status;
};

// A real streaming consumer: manual reader, SSE block parser, bounded waits.
// read-after-read keeps downstream demand true; deliberately NOT reading is the
// slow-reader condition, observed through reader.closed.
class Sse {
  constructor(after, lastEventId) {
    this.after = after; this.lastEventId = lastEventId;
    this.controller = new AbortController();
    this.cursor = undefined; this.firstChunkHadRetry = false;
  }
  async open(bearer = key) {
    const url = new URL(`${base}/inboxes/${inboxA.id}/events/stream`);
    if (this.after !== undefined) url.searchParams.set('after', this.after);
    const headers = {};
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
    if (this.lastEventId !== undefined) headers['Last-Event-ID'] = this.lastEventId;
    const timer = setTimeout(() => this.controller.abort(), Math.min(15_000, left()));
    const at = Date.now();
    try {
      this.response = await fetch(url, { redirect: 'manual', signal: this.controller.signal, headers });
      this.status = this.response.status;
      this.headers = Object.fromEntries([...this.response.headers.entries()]);
    } finally { clearTimeout(timer); }
    this.openMs = Date.now() - at;
    if (this.status !== 200) { await this.response.body?.cancel(); return this; }
    this.reader = this.response.body.getReader();
    this.decoder = new TextDecoder(); this.buffer = ''; this.done = false;
    return this;
  }
  async next(ms = Math.min(20_000, left())) {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
        const fields = {};
        for (const line of block.split('\n')) {
          const colon = line.indexOf(':');
          if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trimStart();
          else if (line.startsWith(':')) fields.comment = line.slice(1).trim();
        }
        if (fields.data !== undefined) fields.data = JSON.parse(fields.data);
        if (fields.id) this.cursor = fields.id;
        return fields;
      }
      assert.ok(this.buffer.length < 131072, 'bounded client buffer');
      if (this.done) return null;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('bounded read timed out')), ms);
      });
      timeout.catch(() => {}); // losing race must not surface as an unhandled rejection
      const chunk = await Promise.race([this.reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (chunk.done) { this.done = true; return null; }
      const text = this.decoder.decode(chunk.value, { stream: true });
      if (!this.firstChunkHadRetry) this.firstChunkHadRetry = text.includes('retry: 2000');
      this.buffer += text;
    }
  }
  async event(name, ms = Math.min(20_000, left())) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (Date.now() >= deadline) throw new Error(`bounded wait for ${name} expired`);
      const f = await this.next(Math.max(1, deadline - Date.now()));
      if (f === null) throw new Error(`EOF before ${name}`);
      if (f.event === name) return f;
    }
  }
  /** Stop issuing reads; observe how the connection ends (slow-reader probe). */
  async closeObservation(ms) {
    this.done = true; // parser stops consuming; no further reader.read() calls
    const at = Date.now();
    let outcome;
    try {
      await Promise.race([
        this.reader.closed.then(() => { outcome = 'clean_close'; },
          e => { outcome = `error:${e?.name ?? 'unknown'}`; }),
        sleep(ms).then(() => { outcome = 'still_open'; }),
      ]);
    } catch (e) { outcome = `error:${e?.name ?? 'unknown'}`; }
    return { atMs: Date.now() - at, outcome };
  }
  abort() { this.controller.abort(); return this.response?.body?.cancel().catch(() => {}); }
}

try {
  // ── Setup: one disposable HTTP inbox; bounded 409 backoff on a contended pool ──
  for (let attempt = 1; !inboxA; attempt++) {
    const created = await ownerApi('/inboxes', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'http', access: 'open', ttl_seconds: 900, label: 'sse-edge-cases' }) });
    assert.ok(created.status === 201 || created.status === 409, `inbox create returned ${created.status}`);
    if (created.status === 201) { inboxA = created.body; out('setup', { attempt, inboxExpiresAt: inboxA.expires_at }); }
    else {
      if (attempt > 12 || Date.now() - t0 > OVERALL_MS - 3 * 60_000) { out('blocked', { reason: 'per-owner inbox pool full (destroying rows count); no slot within the bounded wait', attempts: attempt }); process.exit(0); }
      out('waiting', { reason: 409, attempt });
      await sleep(60_000);
    }
  }
  const cred = await ownerApi(`/inboxes/${inboxA.id}/credentials`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'edge-case sender', expires_at: inboxA.expires_at }) });
  assert.equal(cred.status, 201, `credential create returned ${cred.status}`);
  senderA = cred.body.token;

  // ── Role separation (sender token vs reader authority, both directions) ──
  {
    const at = Date.now();
    const streamAsSender = await request(`/inboxes/${inboxA.id}/events/stream`, {}, senderA);
    const streamStatus = streamAsSender.status; await streamAsSender.body?.cancel();
    const eventsAsSender = await request(`/inboxes/${inboxA.id}/events`, {}, senderA);
    const eventsStatus = eventsAsSender.status; await eventsAsSender.body?.cancel();
    const ownerAsSender = await fetch(inboxA.url, { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(12_000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner-bearer-on-receiving-url' }) });
    const ownerAsSenderStatus = ownerAsSender.status;
    const wwwAuth = ownerAsSender.headers.get('www-authenticate'); await ownerAsSender.body?.cancel();
    out('role_separation', { streamAsSender: streamStatus, eventsAsSender: eventsStatus,
      ownerBearerOnInboxUrl: ownerAsSenderStatus, wwwAuthenticate: wwwAuth, ms: Date.now() - at });
  }

  // ── Cursor semantics at acquire time (synthetic cursors, no D1 mutation) ──
  const posted1 = await deliver(inboxA, 1);
  assert.equal(posted1, 200);
  const page = await ownerApi(`/inboxes/${inboxA.id}/events`);
  assert.equal(page.status, 200);
  const firstEvent = page.body.events[0];
  const decode = c => Buffer.from(c, 'base64url').toString();
  const [epoch] = decode(firstEvent.cursor).split(':');
  const craft = s => Buffer.from(s).toString('base64url');
  {
    const bad = new Sse('not-a-cursor'); await bad.open();
    const badStatus = bad.status; await bad.abort();
    const foreign = new Sse(craft(`${epoch}:ibx_${'a'.repeat(26)}:0`)); await foreign.open();
    const foreignStatus = foreign.status; await foreign.abort();
    const beyond = new Sse(craft(`${epoch}:${inboxA.id}:999999999`)); await beyond.open();
    const beyondStatus = beyond.status; await beyond.abort();
    out('cursor_acquire', { post1: posted1, garbageCursor: badStatus,
      foreignInboxCursor: foreignStatus, beyondHeadCursor: beyondStatus });
  }

  // ── Four-subscriber cap, 429 shape, disconnect releasing a slot ──
  {
    const four = [];
    for (let i = 0; i < 4; i++) {
      const s = new Sse('now'); const opened = Date.now();
      await s.open();
      assert.equal(s.status, 200, `subscriber ${i + 1} got ${s.status}`);
      await s.event('ready');
      four.push({ s, readyMs: Date.now() - opened, retryFirstChunk: s.firstChunkHadRetry });
    }
    const fifth = new Sse('now');
    await fifth.open();
    const fifthStatus = fifth.status, retryAfterValue = fifth.headers?.['retry-after'] ?? null;
    await fifth.abort();
    const releaseAt = Date.now();
    await four[0].s.abort();
    await sleep(1500); // settle any connection-reuse effects before re-admission
    let admitted = null, attempts = 0;
    while (Date.now() - releaseAt < 15_000 && attempts < 20) {
      attempts++;
      const probe = new Sse('now'); await probe.open();
      if (probe.status === 200) { await probe.event('ready'); await probe.abort(); admitted = Date.now() - releaseAt; break; }
      await probe.abort(); await sleep(500);
    }
    for (const f of four.slice(1)) await f.s.abort();
    out('subscriber_cap', { fourReadyMs: four.map(f => f.readyMs), retryLineOnConnect: four[0].retryFirstChunk,
      fifthStatus: fifthStatus, retryAfter: retryAfterValue, releaseMs: admitted, releaseAttempts: attempts });
    await sleep(1500);
  }

  // ── Live delivery, then rewind/resume/precedence (before any stalled reader) ──
  {
    const s = new Sse('now'); const opened = Date.now();
    await s.open(); assert.equal(s.status, 200);
    await s.event('ready');
    const readyMs = Date.now() - opened;
    const postAt = Date.now();
    const postStatus = await deliver(inboxA, 2);
    const frame = await s.event('message.received');
    const postToFrameMs = Date.now() - postAt;
    secondEventId = frame.data.event_id;
    const streamHeaders = s.headers;
    await s.abort(); await sleep(1500);
    const fromZero = new Sse(craft(`${epoch}:${inboxA.id}:0`));
    await fromZero.open();
    const zeroStatus = fromZero.status;
    const replayedAll = [];
    for (;;) {
      const f = await fromZero.event('message.received');
      replayedAll.push(f.data.event_id);
      if (f.data.event_id === secondEventId) break;
    }
    await fromZero.abort();
    const rewind = new Sse(undefined, firstEvent.cursor); await rewind.open();
    const f2 = await rewind.event('message.received');
    const readyF = await rewind.event('ready');
    const resumedCursor = rewind.cursor;
    await rewind.abort();
    const precedence = new Sse('now', firstEvent.cursor); await precedence.open();
    const firstFrame = await precedence.next();
    await precedence.abort();
    out('live_and_rewind', { readyMs, post2: postStatus, postToFrameMs, secondEventId,
      streamHeaders, fromZeroStatus: zeroStatus, replayedFromZero: replayedAll,
      resumedAfterEvt1: f2.data.event_id, cursorStable: readyF.data.cursor === resumedCursor,
      precedenceFirstFrame: firstFrame?.event ?? null, replayedOldEvents: firstFrame?.event === 'message.received' });
    await sleep(1500);
  }

  // ── Slow-reader observation on its own connection (last, to isolate transport) ──
  {
    const s = new Sse('now');
    await s.open(); assert.equal(s.status, 200);
    await s.event('ready');
    const slow = await s.closeObservation(25_000);
    const closedOutcome = slow.outcome === 'still_open' ? 'still_open_at_25s' : slow.outcome;
    await s.abort();
    out('slow_reader', { ...slow, outcome: closedOutcome });
    await sleep(1500);
  }

  // ── TTL expiry while connected: documented shorten-only PATCH, then expiry ──
  {
    const shortened = await ownerApi(`/inboxes/${inboxA.id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl_seconds: 60 }) });
    assert.equal(shortened.status, 200, `shorten PATCH returned ${shortened.status}`);
    inboxA = shortened.body;
    const s = new Sse('now'); const afterPatch = Date.now();
    await s.open(); assert.equal(s.status, 200);
    await s.event('ready');
    const patchToOpenMs = Date.now() - afterPatch;
    const waitMs = Math.max(0, inboxA.expires_at * 1000 - Date.now()) + 15_000;
    const end = await s.event('end', waitMs);
    const expiryToEndMs = Date.now() - inboxA.expires_at * 1000;
    await s.abort();
    const reconnect = new Sse(undefined); await reconnect.open();
    const reconnectStatus = reconnect.status; await reconnect.abort();
    out('ttl_while_connected', { shortenStatus: shortened.status, patchToOpenMs,
      endReason: end.data.reason, expiryToEndMs, reconnectAfterExpiry: reconnectStatus });
  }
} finally {
  if (inboxA?.id) {
    try {
      const r = await fetch(`${base}/inboxes/${inboxA.id}`, { method: 'DELETE', redirect: 'manual',
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000) });
      await r.body?.cancel();
      if (![202, 404].includes(r.status)) console.error(`cleanup warning: delete returned HTTP ${r.status}`);
      else out('cleanup', { status: r.status });
    } catch (e) { console.error(`cleanup warning: delete failed: ${e.message}`); }
  }
}
