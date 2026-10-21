#!/usr/bin/env node
// Explicit opt-in production qualification, never run by npm test or on import.
// Only a disposable synthetic HTTP inbox. No inference, agents, secrets in files,
// credential rotation, existing inbox access, or receipt addresses in output.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function qualify() {
  if (!process.argv.includes('--live')) throw new Error('Requires explicit --live and BAYLEAF_API_KEY; --wait-ttl observes the 15-minute preset.');
  const key = process.env.BAYLEAF_API_KEY;
  if (!key) throw new Error('Set BAYLEAF_API_KEY privately, never as a command argument.');
  const base = process.env.BAYLEAF_API_BASE || 'https://api.bayleaf.dev';
  assert.equal(new URL(base).protocol, 'https:');
  const waitTtl = process.argv.includes('--wait-ttl');
  const overall = Date.now() + (waitTtl ? 20 * 60_000 : 90_000);
  let inbox, sender, cursor, received = 0;
  const request = async (path, init = {}) => {
    const r = await fetch(base + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers } });
    if (!r.ok) { await r.body?.cancel(); throw new Error(`Owner operation returned HTTP ${r.status}`); }
    return r.json();
  };
  const deliver = async n => {
    const r = await fetch(inbox.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${sender}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ qualification: 'synthetic SSE self-post', sequence: n }) });
    assert.equal(r.status, 200); await r.body?.cancel();
  };
  // A bounded stream reader. Last-Event-ID resumes without putting auth in the URL.
  const watch = async (after, onFrame) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.max(1, Math.min(310_000, overall - Date.now())));
    let r;
    try {
      r = await fetch(`${base}/inboxes/${inbox.id}/events/stream`, { signal: abort.signal, redirect: 'manual',
        headers: { Authorization: `Bearer ${key}`, ...(after ? { 'Last-Event-ID': after } : {}) } });
      if (r.status === 404 && waitTtl && Date.now() >= inbox.expires_at * 1000) return 'not_found';
      assert.equal(r.status, 200, `Stream returned HTTP ${r.status}`);
      assert.match(r.headers.get('content-type') || '', /^text\/event-stream/);
      const decoder = new TextDecoder(); let buffer = '';
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        assert.ok(buffer.length < 131072, 'bounded client buffer');
        for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1], raw = /^data: (.+)$/m.exec(block)?.[1];
          if (!name || !raw) continue;
          const data = JSON.parse(raw);
          if (data.cursor) cursor = data.cursor;
          if (await onFrame(name, data)) return 'observed';
          if (name === 'end') return data.reason;
        }
      }
      throw new Error('Unexpected EOF without end frame');
    } finally { clearTimeout(timer); abort.abort(); await r?.body?.cancel().catch(() => {}); }
  };
  try {
    inbox = await request('/inboxes', { method: 'POST', body: JSON.stringify({ type: 'http', preset: 'experiment', label: 'Disposable SSE qualification' }) });
    assert.match(inbox.id, /^ibx_[a-z2-7]{26}$/);
    assert.match(inbox.url, /^https:\/\/[a-z2-7]{26}\.bayleaf-inboxes\.dev\/$/);
    assert.ok(Number.isSafeInteger(inbox.expires_at), 'TTL revision must be integrated before qualification');
    const credential = await request(`/inboxes/${inbox.id}/credentials`, { method: 'POST',
      body: JSON.stringify({ name: 'synthetic sender', expires_at: inbox.expires_at }) });
    sender = credential.token;
    await deliver(1);
    let selfPosted = false;
    await watch(undefined, async (name, data) => {
      if (name === 'ready' && !selfPosted) { selfPosted = true; await deliver(2); }
      if (name === 'message.received') {
        assert.equal(data.event_id, `evt_${++received}`);
        return received === 2;
      }
      return false;
    });
    assert.equal(received, 2, 'one catch-up and one same-connection live arrival');
    await deliver(3); // disconnected interval
    await watch(cursor, async (name, data) => {
      if (name !== 'message.received') return false;
      assert.equal(data.event_id, `evt_${++received}`); return true;
    });
    assert.equal(received, 3, 'resumed after the disconnected interval');
    let termination;
    if (waitTtl) {
      while (Date.now() < overall) {
        termination = await watch(cursor, async () => false);
        if (termination === 'not_found') break;
        assert.ok(['lifetime', 'replay_limit'].includes(termination), `Unexpected terminal reason: ${termination}`);
      }
      assert.equal(termination, 'not_found');
      assert.ok(Date.now() - inbox.expires_at * 1000 < 5000, 'live TTL termination within five seconds');
    } else {
      let destroyed = false;
      termination = await watch(cursor, async name => {
        if (name === 'ready' && !destroyed) { destroyed = true; await request(`/inboxes/${inbox.id}`, { method: 'DELETE' }); }
        return false;
      });
      assert.equal(termination, 'not_found');
    }
    console.log(JSON.stringify({ received, catchup: true, liveSelfPost: true, resumed: true,
      termination: waitTtl ? 'expired' : 'destroyed', ttlDelayMs: waitTtl ? Date.now() - inbox.expires_at * 1000 : null }));
  } finally {
    // Exact resource created here only; idempotent cleanup also handles TTL destruction.
    if (inbox?.id) {
      const r = await fetch(`${base}/inboxes/${inbox.id}`, { method: 'DELETE', redirect: 'manual',
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      await r.body?.cancel();
      if (![202, 404].includes(r.status)) console.error(`Disposable inbox cleanup returned HTTP ${r.status}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  qualify().catch(error => { console.error(error.message); process.exitCode = 1; });
}
