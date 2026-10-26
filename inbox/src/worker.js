// BayLeaf Inboxes Worker (issue #97). The contract is inbox/DESIGN.md.
//
// Reception only: email() and fetch() store bounded data in D1 (metadata) and R2
// (exact bytes). Nothing here triggers inference, tools, forwarding or replies.
// Owner operations are the InboxManagement RPC class, bound only to the API Worker.
//
// Boundary: inboxes intentionally store content. This is not the ZDR inference path.
// Never log content, addresses, nonces or tokens; the sweep logs counts only.

import { WorkerEntrypoint } from 'cloudflare:workers';
import PostalMime from 'postal-mime';
import { verifyEmailDomain } from '../.generated/dkim-verifier.mjs';
import { normalizeEmailAuth, RESTRICTED_EMAIL_MAX_BYTES } from './email-policy.mjs';
import { diagnosticHeaders, publicDiagnosticPage } from '../../api/src/templates/diagnostics';

// ---------------------------------------------------------------------------
// Config and limits
// ---------------------------------------------------------------------------

const DEFAULTS = {
  RETENTION_SECONDS: 7776000,
  MAX_INBOXES_PER_OWNER: 100,
  MAX_CREDENTIALS_PER_INBOX: 20,
  MAX_HTTP_BODY_BYTES: 10485760,
  MAX_EMAIL_BYTES: 26214400,
  MAX_INBOX_BYTES: 209715200,
  MAX_OWNER_BYTES: 524288000,
  MAX_INBOX_MESSAGES: 5000,
  MAX_DAILY_RECEIPTS: 1000,
  MAX_SEARCH_TEXT: 32768,
  MAX_TEXT_CHARS: 262144,
  DESTROY_QUIESCE_SECONDS: 900,
  MAX_INBOX_TTL_SECONDS: 2592000,
  MAX_EXPORT_BYTES: 104857600,
  MAX_EXPORT_META_BYTES: 4194304,
  MAX_HAR_TEXT_BYTES: 262144,
  MAX_HAR_PAGE_TEXT_BYTES: 4194304,
};

// Positive integers from env, else the default. DESTROY_QUIESCE_SECONDS may also be 0
// (useful in tests); 0 still requires a whole second to pass before a receiver aborts.
function limits(env) {
  const out = {};
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    const raw = env?.[name];
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    const ok = Number.isSafeInteger(n) && (n > 0 || (n === 0 && name === 'DESTROY_QUIESCE_SECONDS'));
    out[name] = ok ? n : fallback;
  }
  return out;
}

const enabled = env => env?.INBOXES_ENABLED === 'true';
const inboxDomain = env => String(env?.INBOX_DOMAIN || 'bayleaf-inboxes.dev').toLowerCase();

const BATCH = 50;          // ids per statement; D1 allows 100 bound parameters
const SWEEP_ROUNDS = 4;    // batches per sweep step per run
const DESTROY_PER_SWEEP = 5; // shared budget: never multiply four rounds by 50 inboxes
const HEADERS_CAP = 16384; // characters of kept HTTP headers in meta_json
const YEAR = 31536000;
const MIN_TTL = 60;
const PRESETS = { experiment: 900 }; // 15 minutes

// Live: active and not past an explicit endpoint lifetime. Expiry is computed at
// check time, so an expired endpoint stops before any sweep runs.
const LIVE = (alias) => `${alias}state = 'active' AND (${alias}expires_at IS NULL OR ${alias}expires_at > unixepoch()) AND NOT EXISTS (SELECT 1 FROM retired_owners r WHERE r.owner = ${alias || 'inboxes.'}owner)`;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const utcDay = s => new Date(s * 1000).toISOString().slice(0, 10);
const untilMidnight = s => 86400 - (s % 86400);

// Content-free aggregates only. A failed observation must never retry reception.
const TELEMETRY_WINDOW = 900000;
const TELEMETRY_TTL = 86400000;
const TELEMETRY_OUTCOMES = {
  'inbox.receipts': ['accepted', 'auth', 'rate', 'quota', 'size', 'unknown_address', 'failure'],
  'inbox.lifecycle': ['created', 'destroy_requested', 'destroyed'],
  'inbox.cleanup': ['expired', 'stale', 'retried', 'destroyed_messages', 'reconciled', 'success', 'failure'],
  'inbox.export.pages': ['emitted'],
  'inbox.export.bytes': ['emitted'],
};
function telemetryEnabled(env) {
  return env.INBOX_TELEMETRY_ENABLED === 'true' &&
    typeof env.INBOX_TELEMETRY_WRITE_SECRET === 'string' &&
    env.INBOX_TELEMETRY_WRITE_SECRET.length >= 24 && !/\s/.test(env.INBOX_TELEMETRY_WRITE_SECRET);
}
export async function countTelemetry(env, name, transport, outcome, value = 1) {
  if (!telemetryEnabled(env) || !TELEMETRY_OUTCOMES[name]?.includes(outcome) ||
      !(name === 'inbox.cleanup' ? transport === '' : ['http', 'email'].includes(transport)) ||
      !Number.isSafeInteger(value) || value < 1 || value > 1e12) return;
  try {
    const start = Math.floor(Date.now() / TELEMETRY_WINDOW) * TELEMETRY_WINDOW;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO telemetry_windows(start_at,batch_id)
        SELECT ?,? WHERE (SELECT COUNT(*) FROM telemetry_windows) < 96`).bind(start, crypto.randomUUID()),
      env.DB.prepare(`INSERT INTO telemetry_counts(start_at,name,transport,outcome,value)
        SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM telemetry_windows WHERE start_at=? AND sealed=0)
        ON CONFLICT(start_at,name,transport,outcome) DO UPDATE SET value=MIN(1000000000000,value+excluded.value)`)
        .bind(start, name, transport, outcome, value, start),
    ]);
  } catch { /* Missing migration, overload or outage loses counts, never content. */ }
}
export async function exportTelemetry(env, send = fetch) {
  // Prune independently of enablement. Explicit child deletion also works without
  // relying on connection-local SQLite foreign-key settings.
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM telemetry_counts WHERE start_at <= ?').bind(now - TELEMETRY_TTL),
    env.DB.prepare('DELETE FROM telemetry_windows WHERE start_at <= ?').bind(now - TELEMETRY_TTL),
  ]);
  if (!telemetryEnabled(env)) return;
  const windows = (await env.DB.prepare(`SELECT start_at,batch_id FROM telemetry_windows
    WHERE sent=0 AND start_at+? <= ? ORDER BY start_at LIMIT 2`).bind(TELEMETRY_WINDOW, now).all()).results;
  for (const window of windows) {
    await env.DB.prepare('UPDATE telemetry_windows SET sealed=1 WHERE start_at=?').bind(window.start_at).run();
    const rows = (await env.DB.prepare(`SELECT name,transport,outcome,value FROM telemetry_counts
      WHERE start_at=? ORDER BY name,transport,outcome`).bind(window.start_at).all()).results;
    if (!rows.length) continue;
    const end = window.start_at + TELEMETRY_WINDOW;
    // Reconstruct the allowlisted wire record, never serialize an inbox/R2 row.
    const points = rows.map(row => ({ name: row.name, kind: 'sum', unit: row.name === 'inbox.export.bytes' ? 'By' : '1',
      start_at: window.start_at, observed_at: end, temporality: 'delta', monotonic: true,
      value: row.value, attributes: { ...(row.transport ? { transport: row.transport } : {}), outcome: row.outcome } }));
    try {
      const response = await send('https://telemetry.bayleaf.dev/v1/metrics', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INBOX_TELEMETRY_WRITE_SECRET}` },
        body: JSON.stringify({ schema_version: 1, source: 'inboxes', batch_id: window.batch_id, observed_at: end, points }),
      });
      void response.body?.cancel().catch(() => {});
      if (response.status !== 202) break;
      await env.DB.prepare('UPDATE telemetry_windows SET sent=1 WHERE start_at=?').bind(window.start_at).run();
    } catch { break; } // Durable sealed data/UUID survives ambiguous acknowledgement.
  }
}

// ---------------------------------------------------------------------------
// Ids and encoding
// ---------------------------------------------------------------------------

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

// 16 random bytes (128 bits) as 26 lowercase RFC 4648 base32 characters: a valid,
// case-insensitive DNS label and email local part.
function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const NONCE = /^[a-z2-7]{26}$/;
const IDS = { inbox: /^ibx_[a-z2-7]{26}$/, message: /^msg_[a-z2-7]{26}$/, credential: /^cred_[a-z2-7]{26}$/ };
const OWNER = /^[A-Za-z0-9-]{16,128}$/;
const TOKEN = /^sk-bayleaf-inbox-[0-9a-f]{64}$/;

const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

function b64url(text) {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(text) {
  try { return atob(text.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
}

const marks = n => Array(n).fill('?').join(',');
const chunks = (list, size = BATCH) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
const objectKey = (inboxId, messageId) => `m/${inboxId}/${messageId}`;

// Read a stream into bytes, giving up (null) as soon as the running count passes max.
async function readBounded(stream, max) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

// ---------------------------------------------------------------------------
// Reservation and lifecycle
// ---------------------------------------------------------------------------

// Reserve quota and insert a pending row in one transaction. The INSERT ... SELECT
// only produces a row when every quota holds, and the UPDATE only counts it when
// that row exists, so concurrent receivers cannot overshoot.
async function reserve(env, inboxId, { size, meta, searchText, credentialId = null, emailPolicyJson = null }) {
  const L = limits(env);
  const now = nowSeconds();
  const today = utcDay(now);
  const id = `msg_${nonce()}`;
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, inbox_id, state, received_at, expires_at, archived, size, meta_json, search_text)
       SELECT ?1, i.id, 'pending', ?2, ?3, 0, ?4, ?5, ?6 FROM inboxes i
         WHERE i.id = ?7 AND ${LIVE('i.')}
          AND (i.type <> 'email' OR i.email_auth_json IS ?14)
          AND (i.type <> 'http' OR i.auth_required = 0 OR EXISTS (
            SELECT 1 FROM credentials c WHERE c.id = ?13 AND c.inbox_id = i.id
              AND (c.expires_at IS NULL OR c.expires_at > unixepoch())))
         AND i.bytes_stored + ?4 <= ?8
         AND i.message_count + 1 <= ?9
         AND (i.day <> ?10 OR i.day_count < ?11)
         AND (SELECT COALESCE(SUM(bytes_stored), 0) FROM inboxes WHERE owner = i.owner) + ?4 <= ?12`
    ).bind(id, now, now + L.RETENTION_SECONDS, size, JSON.stringify(meta), searchText, inboxId,
      L.MAX_INBOX_BYTES, L.MAX_INBOX_MESSAGES, today, L.MAX_DAILY_RECEIPTS, L.MAX_OWNER_BYTES, credentialId, emailPolicyJson),
    env.DB.prepare(
      `UPDATE inboxes SET bytes_stored = bytes_stored + ?1, message_count = message_count + 1,
         day_count = CASE WHEN day = ?2 THEN day_count + 1 ELSE 1 END, day = ?2
       WHERE id = ?3 AND EXISTS (SELECT 1 FROM messages WHERE id = ?4)`
    ).bind(size, today, inboxId, id),
  ]);
  if (inserted.meta.changes === 1) return { ok: true, id };
  const row = await env.DB.prepare(`SELECT state, expires_at, type, auth_required, day, day_count,
    EXISTS (SELECT 1 FROM retired_owners WHERE owner=inboxes.owner) AS retired,
    EXISTS (SELECT 1 FROM credentials WHERE inbox_id = ?1 AND id = ?2
      AND (expires_at IS NULL OR expires_at > unixepoch())) AS authorized
    FROM inboxes WHERE id = ?1`).bind(inboxId, credentialId).first();
  if (!row || row.retired || row.state !== 'active' || (row.expires_at !== null && row.expires_at <= nowSeconds())) return { ok: false, reason: 'not_found' };
  if (row.type === 'http' && row.auth_required && !row.authorized) return { ok: false, reason: 'unauthorized' };
  if (row.day === today && row.day_count >= L.MAX_DAILY_RECEIPTS) return { ok: false, reason: 'daily', retryAfter: untilMidnight(now) };
  return { ok: false, reason: 'full' };
}

// Put the bytes and mark the row stored. A receiver that has been running longer than
// a third of the quiescence window aborts before writing. This reduces races but is
// not a fence on delayed R2 puts: durable prefix reconciliation is the backstop.
async function commit(env, inboxId, messageId, bytes, startedMs) {
  const quiesce = limits(env).DESTROY_QUIESCE_SECONDS;
  const elapsed = Math.floor((Date.now() - startedMs) / 1000);
  if (elapsed > Math.floor(quiesce / 3)) {
    await removeMessages(env, [messageId]).catch(() => {});
    return 'storage_failed';
  }
  const key = objectKey(inboxId, messageId);
  try {
    await env.BLOBS.put(key, bytes);
  } catch {
    await removeMessages(env, [messageId]).catch(() => {});
    return 'storage_failed';
  }
  // Arrival order is transaction commit order, never reservation order.
  const fresh = `EXISTS (SELECT 1 FROM messages WHERE id = ?1 AND state = 'stored')
    AND NOT EXISTS (SELECT 1 FROM events WHERE message_id = ?1)`;
  const [done] = await env.DB.batch([
    env.DB.prepare(`UPDATE messages SET state = 'stored' WHERE id = ?1 AND state = 'pending'
      AND EXISTS (SELECT 1 FROM inboxes i WHERE i.id = ?2 AND ${LIVE('i.')})`).bind(messageId, inboxId),
    env.DB.prepare(`UPDATE inboxes SET event_seq = event_seq + 1 WHERE id = ?2 AND ${fresh}`).bind(messageId, inboxId),
    env.DB.prepare(`INSERT INTO events (inbox_id, seq, message_id, type, created_at)
      SELECT id, event_seq, ?1, 'message.received', ?3 FROM inboxes WHERE id = ?2 AND ${fresh}`)
      .bind(messageId, inboxId, nowSeconds()),
  ]);
  if (done.meta.changes === 1) {
    const live = await env.DB.prepare(`SELECT expires_at FROM inboxes WHERE id = ? AND ${LIVE('')}`)
      .bind(inboxId).first();
    if (live && (live.expires_at === null || live.expires_at > nowSeconds())) return 'stored';
  }
  // The inbox was destroyed or its lifetime ended meanwhile. Remove our own pending
  // row (if still there) and object so nothing outlives the endpoint; the destroy
  // sweep's R2 list and prefix reconciliation are the backstop.
  await removeMessages(env, [messageId]).catch(() => {});
  await env.BLOBS.delete(key).catch(() => {});
  return 'not_found';
}

// The single removal path for any cause (expiry, owner delete, stale pending, destroy).
// Mark deleting (hidden at once), delete the objects, then remove rows and decrement
// the reservation counters in one batch. If R2 fails, rows stay deleting for the sweep.
async function removeMessages(env, ids) {
  let removed = 0;
  for (const group of chunks(ids)) {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO cleanup_prefixes (inbox_id, turn)
        SELECT inbox_id, (SELECT COALESCE(MAX(turn), 0) + 1 FROM cleanup_prefixes)
        FROM messages WHERE state = 'pending' AND id IN (${marks(group.length)})`).bind(...group),
      env.DB.prepare(`UPDATE messages SET state = 'deleting' WHERE id IN (${marks(group.length)})`).bind(...group),
    ]);
    const rows = (await env.DB.prepare(`SELECT id, inbox_id FROM messages WHERE state = 'deleting' AND id IN (${marks(group.length)})`)
      .bind(...group).all()).results;
    if (!rows.length) continue;
    try {
      await env.BLOBS.delete(rows.map(r => objectKey(r.inbox_id, r.id)));
    } catch {
      continue;
    }
    // Numbered placeholders are reused across the correlated subqueries: <=50
    // bound parameters total, not 50 per appearance. The transaction rechecks
    // deleting rows so overlapping cleanup cannot decrement counters twice.
    const doneIds = rows.map(r => r.id);
    const selected = doneIds.map((_, i) => `?${i + 1}`).join(',');
    const where = `state = 'deleting' AND id IN (${selected})`;
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE inboxes SET
        bytes_stored = bytes_stored - (SELECT COALESCE(SUM(size),0) FROM messages WHERE inbox_id=inboxes.id AND ${where}),
        message_count = message_count - (SELECT COUNT(*) FROM messages WHERE inbox_id=inboxes.id AND ${where})
        WHERE id IN (SELECT inbox_id FROM messages WHERE ${where})`).bind(...doneIds),
      env.DB.prepare(`DELETE FROM messages WHERE ${where}`).bind(...doneIds),
      env.DB.prepare(`DELETE FROM events WHERE message_id IN (${selected})`).bind(...doneIds),
    ]);
    removed += results[1].meta.changes;
  }
  return removed;
}

// The single destruction transition, for an owner's request or an ended lifetime.
// From this batch on, reception sees not-found and credentials are gone. An owner
// request is scoped to that owner; the sweep passes no owner and moves only inboxes
// whose lifetime has ended. Quiescence counts from the earlier of now and expires_at,
// because receivers stopped seeing an expired inbox as live at expires_at.
async function beginDestroy(env, inboxId, now, owner = null) {
  const scope = owner === null ? 'expires_at <= ?1' : 'owner = ?3';
  const args = owner === null ? [now, inboxId] : [now, inboxId, owner];
  const transitions = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO cleanup_prefixes (inbox_id, turn)
      SELECT id, (SELECT COALESCE(MAX(turn), 0) + 1 FROM cleanup_prefixes)
      FROM inboxes WHERE id = ?2 AND ${scope}`).bind(...args),
    env.DB.prepare(`UPDATE inboxes SET state = 'destroying', destroy_requested_at = MIN(?1, COALESCE(expires_at, ?1))
      WHERE id = ?2 AND state = 'active' AND ${scope}`).bind(...args),
    env.DB.prepare(`DELETE FROM credentials WHERE inbox_id = ?2
      AND EXISTS (SELECT 1 FROM inboxes WHERE id = ?2 AND state = 'destroying' AND ${scope})`).bind(...args),
  ]);
  const begun = transitions[1].meta.changes === 1;
  if (begun) {
    // Expiry-driven and requested destruction share one content-free counter.
    const row = await env.DB.prepare('SELECT type FROM inboxes WHERE id = ?').bind(inboxId).first();
    if (row) await countTelemetry(env, 'inbox.lifecycle', row.type, 'destroy_requested');
  }
  return begun;
}

// One bounded step of destroying an inbox: remove up to BATCH message rows.
async function destroyStep(env, inboxId) {
  const ids = (await env.DB.prepare('SELECT id FROM messages WHERE inbox_id = ? LIMIT ?').bind(inboxId, BATCH).all())
    .results.map(r => r.id);
  return ids.length ? removeMessages(env, ids) : 0;
}

// Finalize only when no rows remain, the prefix currently lists empty, and the
// quiescence window has passed. The durable cleanup_prefixes row remains: an empty
// listing cannot prove that a provider put already in flight will never finish.
async function tryFinalize(env, inboxId) {
  const now = nowSeconds();
  const quiesce = limits(env).DESTROY_QUIESCE_SECONDS;
  const row = await env.DB.prepare(
    `SELECT type, destroy_requested_at, EXISTS (SELECT 1 FROM messages WHERE inbox_id = ?1) AS has_messages
     FROM inboxes WHERE id = ?1 AND state = 'destroying'`
  ).bind(inboxId).first();
  if (!row || row.has_messages || now < row.destroy_requested_at + quiesce) return false;
  const prefix = `m/${inboxId}/`;
  let listing = await env.BLOBS.list({ prefix, limit: BATCH });
  if (listing.objects.length) {
    await env.BLOBS.delete(listing.objects.map(o => o.key));
    listing = await env.BLOBS.list({ prefix, limit: 1 });
    if (listing.objects.length) return false;
  }
  const [gone] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM inboxes WHERE id = ?1 AND state = 'destroying' AND destroy_requested_at <= ?2
         AND NOT EXISTS (SELECT 1 FROM messages WHERE inbox_id = ?1)`
    ).bind(inboxId, now - quiesce),
    ...['credentials', 'events', 'event_streams'].map(table => env.DB.prepare(
      `DELETE FROM ${table} WHERE inbox_id = ? AND NOT EXISTS (SELECT 1 FROM inboxes WHERE id = ?)`).bind(inboxId, inboxId)),
  ]);
  if (gone.meta.changes === 1) await countTelemetry(env, 'inbox.lifecycle', row.type, 'destroyed');
  return gone.meta.changes === 1;
}

// ---------------------------------------------------------------------------
// HTTP reception
// ---------------------------------------------------------------------------

const DROPPED = new Set(['x-forwarded-for', 'x-real-ip', 'true-client-ip', 'cdn-loop', 'x-forwarded-proto']);
const REDACTED = new Set(['proxy-authorization', 'cookie']);

const json = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const CORS = { 'Access-Control-Allow-Origin': '*' };
const notFound = () => json({ error: 'not_found' }, 404);

function isTextual(contentType) {
  const t = (contentType || '').split(';')[0].trim().toLowerCase();
  return t.startsWith('text/') || t.includes('json') || t.includes('xml') || t === 'application/x-www-form-urlencoded';
}

// Headers as the Workers runtime exposes them (names lowercased; the Fetch Headers
// iteration order), minus anything identifying the sender's network. BayLeaf keeps no
// sender IP address. Provider signature headers are kept for later verification.
function keptHeaders(headers) {
  const out = [];
  let used = 0, truncated = false;
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    if (name.startsWith('cf-') || DROPPED.has(name)) continue;
    let value = rawValue;
    if (name === 'authorization') {
      const scheme = value.trim().split(/\s+/)[0];
      value = value.trim().includes(' ') || value.trim().includes('\t') ? `${scheme} [redacted]` : '[redacted]';
    } else if (REDACTED.has(name)) {
      value = '[redacted]';
    }
    if (used + name.length + value.length > HEADERS_CAP) { truncated = true; break; }
    used += name.length + value.length;
    out.push([name, value]);
  }
  return { headers: out, truncated };
}

async function rateLimited(binding, key) {
  const { success } = await binding.limit({ key });
  return !success;
}

async function authenticate(env, inbox, request, ctx) {
  const header = request.headers.get('Authorization');
  const reject = async (status, challenge) => {
    if (await rateLimited(env.REJECT_LIMIT, inbox.id)) return { response: json({ error: 'rate_limited' }, 429, { ...CORS, 'Retry-After': '60' }) };
    return { response: json({ error: 'unauthorized' }, status, { ...CORS, 'WWW-Authenticate': challenge }) };
  };
  if (header === null) return reject(401, 'Bearer realm="bayleaf-inbox"');
  const invalid = () => reject(401, 'Bearer realm="bayleaf-inbox", error="invalid_token"');
  const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!match || !TOKEN.test(match[1])) return invalid();
  const now = nowSeconds();
  const cred = await env.DB.prepare(
    `SELECT id, name, expires_at, last_used_at FROM credentials WHERE inbox_id = ?1 AND secret_hash = ?2
      AND (expires_at IS NULL OR expires_at > unixepoch())
      AND EXISTS (SELECT 1 FROM inboxes WHERE id = ?1 AND ${LIVE('')})`
  ).bind(inbox.id, await sha256(match[1])).first();
  if (!cred || (cred.expires_at !== null && cred.expires_at <= nowSeconds())) return invalid();
  // Coalesced: at most one write per credential per hour.
  if (cred.last_used_at === null || now - cred.last_used_at >= 3600) {
    const touch = env.DB.prepare('UPDATE credentials SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at <= ?3)')
      .bind(now, cred.id, now - 3600).run().catch(() => {});
    ctx?.waitUntil ? ctx.waitUntil(touch) : await touch;
  }
  return { credential: { id: cred.id, name: cred.name } };
}

async function receiveHttp(request, env, ctx, label, report = () => {}) {
  const startedMs = Date.now();
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    const asked = request.headers.get('Access-Control-Request-Headers');
    return new Response(null, { status: 204, headers: {
      ...CORS,
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
      'Access-Control-Allow-Headers': asked ? asked.slice(0, 1024) : 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    } });
  }
  if (!env.ACCEPT_LIMIT || !env.REJECT_LIMIT) return json({ error: 'unavailable' }, 503);
  if (!NONCE.test(label)) return notFound();
  const inbox = await env.DB.prepare(
    `SELECT id, auth_required
     FROM inboxes i WHERE nonce = ? AND type = 'http' AND ${LIVE('i.')}`
  ).bind(label).first();
  if (!inbox) return notFound();

  let credential = null;
  if (inbox.auth_required) {
    const auth = await authenticate(env, inbox, request, ctx);
    if (auth.response) return auth.response;
    credential = auth.credential;
  }
  if (await rateLimited(env.ACCEPT_LIMIT, inbox.id)) return json({ error: 'rate_limited' }, 429, { ...CORS, 'Retry-After': '60' });

  const L = limits(env);
  const declared = request.headers.get('Content-Length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > L.MAX_HTTP_BODY_BYTES) {
    return json({ error: 'too_large' }, 413, CORS);
  }
  const body = await readBounded(request.body, L.MAX_HTTP_BODY_BYTES);
  if (body === null) return json({ error: 'too_large' }, 413, CORS);

  const url = new URL(request.url);
  const query = url.search.replace(/^\?/, '');
  const { headers, truncated } = keptHeaders(request.headers);
  const contentType = request.headers.get('Content-Type');
  const meta = { type: 'http', method, path: url.pathname, query, headers,
    content_type: contentType, credential };
  if (truncated) meta.headers_truncated = true;

  let search = `${method} ${url.pathname}${query ? `?${query}` : ''}\n${headers.map(([n, v]) => `${n}: ${v}`).join('\n')}\n`;
  if (isTextual(contentType) && search.length < L.MAX_SEARCH_TEXT) {
    search += new TextDecoder().decode(body.subarray(0, L.MAX_SEARCH_TEXT * 4));
  }

  const reservation = await reserve(env, inbox.id, { size: body.byteLength, meta,
    credentialId: credential?.id ?? null,
    searchText: search.toLowerCase().slice(0, L.MAX_SEARCH_TEXT) });
  if (!reservation.ok) {
    if (reservation.reason === 'not_found') return notFound();
    if (reservation.reason === 'unauthorized') {
      if (await rateLimited(env.REJECT_LIMIT, inbox.id)) return json({ error: 'rate_limited' }, 429, { ...CORS, 'Retry-After': '60' });
      const challenge = 'Bearer realm="bayleaf-inbox"' + (request.headers.has('Authorization') ? ', error="invalid_token"' : '');
      return json({ error: 'unauthorized' }, 401, { ...CORS, 'WWW-Authenticate': challenge });
    }
    if (reservation.reason === 'daily') {
      report('quota');
      return json({ error: 'rate_limited' }, 429, { ...CORS, 'Retry-After': String(reservation.retryAfter) });
    }
    return json({ error: 'inbox_full' }, 507, CORS);
  }
  const outcome = await commit(env, inbox.id, reservation.id, body, startedMs);
  if (outcome === 'not_found') return notFound();
  if (outcome !== 'stored') return json({ error: 'unavailable' }, 503, CORS);
  // Fixed response: senders can never program what an inbox says back.
  if (method === 'HEAD') return new Response(null, { status: 200, headers: CORS });
  return json({ ok: true }, 200, CORS);
}

async function handleFetch(request, env, ctx) {
  const domain = inboxDomain(env);
  const host = new URL(request.url).hostname.toLowerCase();
  if (host === domain) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const path = new URL(request.url).pathname;
      if (path === '/llms.txt') return new Response(request.method === 'HEAD' ? null :
        '# bayleaf-inboxes.dev\n\n' +
        'An auxiliary BayLeaf domain. Its subdomains and email addresses are BayLeaf Inboxes created by users, which receive bounded email and ' +
        'webhook messages for later owner-authorized retrieval. The domain is kept separate from bayleaf.dev so cookies and browser storage ' +
        'tied to user-created resources stay isolated from BayLeaf\'s own services. The apex hosts no user content.\n\n' +
        '- BayLeaf overview: https://bayleaf.dev/llms.txt\n' +
        '- Access and details: https://api.bayleaf.dev/llms.txt\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      if (path !== '/') return notFound();
      return new Response(request.method === 'HEAD' ? null : publicDiagnosticPage('inboxes', enabled(env),
        env.BROWSER_ARRIVALS_ENABLED === 'true'), { headers: diagnosticHeaders(env.BROWSER_ARRIVALS_ENABLED === 'true') });
    }
    return notFound();
  }
  if (!host.endsWith(`.${domain}`)) return notFound();
  const label = host.slice(0, -domain.length - 1);
  if (!label || label.includes('.')) return notFound();
  if (!enabled(env)) return json({ error: 'unavailable' }, 503);
  try {
    let reported;
    const result = await receiveHttp(request, env, ctx, label, outcome => { reported = outcome; });
    if (request.method !== 'OPTIONS') {
      // Fixed status/body vocabulary only. No request material crosses this seam.
      const outcome = reported || ({ 200: 'accepted', 401: 'auth', 404: 'unknown_address', 413: 'size',
        429: 'rate', 507: 'quota' })[result.status] || 'failure';
      await countTelemetry(env, 'inbox.receipts', 'http', outcome);
    }
    return result;
  } catch {
    await countTelemetry(env, 'inbox.receipts', 'http', 'failure');
    return json({ error: 'unavailable' }, 503, CORS);
  }
}

// ---------------------------------------------------------------------------
// Email reception
// ---------------------------------------------------------------------------

// Nested messages stay inert attachments: decoding an encoded nested message and
// recursively parsing it would bypass the raw-line preflight below.
const PARSE_OPTIONS = { attachmentEncoding: 'arraybuffer', maxRfc822NestingDepth: 0 };
const RESTRICTED_PARSE_OPTIONS = { ...PARSE_OPTIONS, maxPartCount: 256, maxNestingDepth: 16,
  maxHeadersSize: 65536, maxForwardedAddresses: 256 };
const MAX_MIME_LINES = 350000;
class MimeResourceLimit extends Error {}
function mimePreflight(raw, max) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength > max) throw new MimeResourceLimit();
  let lines = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 10 && ++lines > MAX_MIME_LINES) throw new MimeResourceLimit();
  }
}
async function parseEmail(raw, max, restricted = false) {
  mimePreflight(raw, max);
  try { return await PostalMime.parse(raw, restricted ? RESTRICTED_PARSE_OPTIONS : PARSE_OPTIONS); }
  catch (error) {
    // These are the pinned maintained parser's own resource-limit errors, not
    // arbitrary sender headers or an attempt to parse MIME ourselves.
    if (/^Maximum (?:MIME |header |forwarded address )/.test(String(error?.message))) throw new MimeResourceLimit();
    throw error;
  }
}

function mailbox(a) {
  if (!a || typeof a.address !== 'string' || !a.address) return null;
  return { address: clip(a.address, 320), name: clip(a.name || '', 320) };
}
// Flatten RFC 5322 groups into their mailboxes, at most 50 per list.
function mailboxes(list) {
  const out = [];
  for (const a of list || []) {
    for (const m of a.group ? a.group : [a]) {
      const box = mailbox(m);
      if (box && out.length < 50) out.push(box);
    }
  }
  return out;
}
const byteLength = c => (typeof c === 'string' ? new TextEncoder().encode(c).byteLength : c.byteLength);

function emailMeta(message, recipient, parsed) {
  const meta = { type: 'email', envelope_from: clip(String(message.from || ''), 320), envelope_to: recipient,
    from: null, to: [], cc: [], reply_to: [], subject: null, date: null, message_id: null, in_reply_to: null,
    authentication_results: [], attachments: [], parse_error: !parsed };
  if (!parsed) {
    const ar = message.headers?.get?.('authentication-results');
    if (ar) meta.authentication_results = [clip(ar, 2048)];
    return meta;
  }
  // Header From is sender-controlled content, not an identity.
  const from = parsed.from?.group ? parsed.from.group[0] : parsed.from;
  meta.from = mailbox(from);
  meta.to = mailboxes(parsed.to);
  meta.cc = mailboxes(parsed.cc);
  meta.reply_to = mailboxes(parsed.replyTo);
  meta.subject = clip(parsed.subject ?? null, 998);
  meta.date = parsed.date && !Number.isNaN(Date.parse(parsed.date)) && /^\d{4}-\d\d-\d\dT/.test(parsed.date) ? parsed.date : null;
  meta.message_id = clip(parsed.messageId ?? null, 998);
  meta.in_reply_to = clip(parsed.inReplyTo ?? null, 998);
  meta.authentication_results = parsed.headers.filter(h => h.key === 'authentication-results')
    .slice(0, 10).map(h => clip(h.value, 2048));
  const attachments = parsed.attachments || [];
  meta.attachments = attachments.slice(0, 200).map((a, index) => ({
    index, filename: clip(a.filename ?? null, 998), mime_type: clip(a.mimeType || 'application/octet-stream', 255),
    size: byteLength(a.content), disposition: clip(a.disposition ?? null, 64), content_id: clip(a.contentId ?? null, 998),
  }));
  if (attachments.length > 200) meta.attachments_truncated = true;
  return meta;
}

// Crude on purpose: readable text for agents and scripts, never a renderer.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
function htmlToText(html, max) {
  // Single forward scan, at most 8 input characters per requested output character,
  // with a hard 2 Mi-character ceiling. Tags have bounded scratch space. Incomplete
  // tags are discarded, not repeatedly searched from every '<'. This is not a parser.
  const end = Math.min(html.length, max * 8, 2097152);
  const out = [];
  let at = 0, hidden = null, tag = null;
  while (at < end && out.length <= max) {
    const c = html[at++];
    if (tag !== null) {
      if (c !== '>') { if (tag.length < 256) tag += c; continue; }
      const name = /^\s*(\/?)\s*([a-z][a-z0-9]*)\b/i.exec(tag);
      tag = null;
      if (!name) continue;
      const closing = name[1] === '/', n = name[2].toLowerCase();
      if (hidden) { if (closing && n === hidden) hidden = null; continue; }
      if (!closing && (n === 'script' || n === 'style')) { hidden = n; continue; }
      out.push(n === 'br' || (closing && /^(p|div|li|tr|h[1-6])$/.test(n)) ? '\n' : ' ');
    } else if (c === '<') {
      tag = '';
    } else if (!hidden) {
      if (c === '&') {
        // Entity lookahead is constant-sized, never a search through the suffix.
        const entity = /^(amp|lt|gt|quot|#39|nbsp);/.exec(html.slice(at, Math.min(end, at + 6)));
        if (entity) { out.push(ENTITIES[entity[1]]); at += entity[0].length; continue; }
      }
      out.push(c);
    }
  }
  const text = out.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text.slice(0, max), truncated: at < html.length || text.length > max };
}

function emailSearch(meta, parsed, max) {
  const people = [meta.from, ...meta.to].filter(Boolean).map(p => `${p.name} <${p.address}>`);
  let body = '';
  if (parsed?.text) body = parsed.text.slice(0, max);
  else if (parsed?.html) body = htmlToText(parsed.html, max).text;
  return [meta.subject || '', ...people, body].join('\n').toLowerCase().slice(0, max);
}

async function handleEmail(message, env, report = () => {}) {
  if (!enabled(env)) return message.setReject('Inbox service unavailable');
  // A missing binding is misconfiguration: throw so the platform's failure path applies.
  if (!env.ACCEPT_LIMIT || !env.REJECT_LIMIT) throw new Error('rate limit binding missing');
  const startedMs = Date.now();
  const L = limits(env);

  // Route only on the envelope recipient (RCPT TO). MIME To/Cc are sender-written text
  // and never decide delivery, which also makes Bcc delivery work.
  const recipient = String(message.to || '').toLowerCase();
  const at = recipient.lastIndexOf('@');
  const local = recipient.slice(0, at), domain = recipient.slice(at + 1);
  const inbox = at > 0 && domain === inboxDomain(env) && NONCE.test(local)
    ? await env.DB.prepare(`SELECT id, email_auth_json FROM inboxes WHERE nonce = ? AND type = 'email' AND ${LIVE('')}`)
      .bind(local).first()
    : null;
  const reject = (outcome, reason) => { report(outcome); return message.setReject(reason); };
  if (!inbox) return reject('unknown_address', '5.1.1 Address not found');
  const restricted = inbox.email_auth_json !== null;
  const cap = restricted ? Math.min(L.MAX_EMAIL_BYTES, RESTRICTED_EMAIL_MAX_BYTES) : L.MAX_EMAIL_BYTES;
  const tooLarge = restricted ? '5.3.4 Restricted inbox supports DKIM mail up to 1 MiB' : '5.3.4 Message too large';
  if (message.rawSize > cap) return reject('size', tooLarge);
  if (restricted) {
    if (await rateLimited(env.REJECT_LIMIT, `email-dkim:${inbox.id}`)) return reject('rate', '4.7.0 DKIM verification rate limited, try later');
  } else if (await rateLimited(env.ACCEPT_LIMIT, inbox.id)) return reject('rate', '4.7.0 Rate limited, try later');

  const raw = await readBounded(message.raw, cap);
  if (raw === null) return reject('size', tooLarge);
  let dkimAuth = null;
  if (restricted) {
    const policy = normalizeEmailAuth(JSON.parse(inbox.email_auth_json));
    // An invalid stored policy never silently reopens reception.
    if (!policy) throw new Error('email authorization configuration unavailable');
    const verdict = await verifyEmailDomain(raw, policy);
    if (!verdict.trusted) {
      if (verdict.temporary) throw new Error('email authorization temporarily unavailable');
      return reject('auth', '5.7.1 DKIM domain authorization required');
    }
    dkimAuth = { domain: verdict.domain, selector: verdict.selector, algo: verdict.algo };
    if (await rateLimited(env.ACCEPT_LIMIT, inbox.id)) return reject('rate', '4.7.0 Rate limited, try later');
  }
  let parsed = null;
  try { parsed = await parseEmail(raw, L.MAX_EMAIL_BYTES, restricted); }
  catch (error) {
    if (error instanceof MimeResourceLimit) return reject('size', '5.3.4 MIME resource limit exceeded');
    parsed = null;
  }
  const meta = emailMeta(message, recipient, parsed);
  if (dkimAuth) meta.dkim_auth = dkimAuth;

  const reservation = await reserve(env, inbox.id, { size: raw.byteLength, meta, emailPolicyJson: inbox.email_auth_json,
    searchText: emailSearch(meta, parsed, L.MAX_SEARCH_TEXT) });
  if (!reservation.ok) {
    return reservation.reason === 'not_found' ? reject('unknown_address', '5.1.1 Address not found') : reject('quota', '5.2.2 Mailbox full');
  }
  const outcome = await commit(env, inbox.id, reservation.id, raw, startedMs);
  if (outcome === 'not_found') return reject('unknown_address', '5.1.1 Address not found');
  // Throw rather than setReject, which is documented as permanent: let the platform
  // decide whether a storage failure becomes a temporary SMTP failure.
  if (outcome !== 'stored') throw new Error('storage unavailable');
}

// ---------------------------------------------------------------------------
// Scheduled sweep
// ---------------------------------------------------------------------------

async function reconcilePrefixes(env) {
  // Round-robin by a durable logical turn, not wall time: even empty prefixes and
  // failed R2 calls yield their place. One page per prefix per run, at most 50 x 50
  // objects. Indefinite tombstones trade id-only storage growth for eventual cleanup
  // of arbitrarily delayed writes, including writes after inbox finalization.
  const rows = (await env.DB.prepare(
    'SELECT inbox_id, cursor FROM cleanup_prefixes ORDER BY turn, inbox_id LIMIT ?'
  ).bind(BATCH).all()).results;
  let removed = 0;
  for (const row of rows) {
    let cursor = row.cursor;
    try {
      const listing = await env.BLOBS.list({ prefix: `m/${row.inbox_id}/`, limit: BATCH,
        ...(cursor ? { cursor } : {}) });
      const ids = listing.objects.map(o => o.key.slice(`m/${row.inbox_id}/`.length));
      const checks = ids.length ? (await env.DB.prepare(
        `SELECT id FROM messages WHERE inbox_id = ? AND id IN (${marks(ids.length)}) AND state IN ('pending','stored')`
      ).bind(row.inbox_id, ...ids).all()).results : [];
      const live = new Set(checks.map(r => r.id));
      const orphans = listing.objects.filter((_, i) => !live.has(ids[i])).map(o => o.key);
      if (orphans.length) { await env.BLOBS.delete(orphans); removed += orphans.length; }
      cursor = listing.truncated ? listing.cursor : null;
    } catch {
      // Retry this page on its next turn. An invalid/expired provider cursor must
      // not stall reconciliation forever: restart at the prefix beginning.
      cursor = null;
    }
    await env.DB.prepare(`UPDATE cleanup_prefixes SET cursor = ?1,
      turn = (SELECT COALESCE(MAX(turn), 0) + 1 FROM cleanup_prefixes) WHERE inbox_id = ?2`)
      .bind(cursor, row.inbox_id).run();
  }
  return removed;
}

async function sweep(env) {
  const now = nowSeconds();
  const quiesce = limits(env).DESTROY_QUIESCE_SECONDS;
  const counts = { expired: 0, stale: 0, retried: 0, lifetimes: 0, destroyed_messages: 0, finalized: 0 };
  // Persist selection before I/O: failures yield their turn too. Every query and
  // wraparound page is bounded. Names/conditions below are code-owned constants.
  const ids = async (name, table, condition, args, count = BATCH) => {
    const cursor = (await env.DB.prepare('SELECT cursor FROM cleanup_progress WHERE name=?').bind(name).first())?.cursor || '';
    const page = (await env.DB.prepare(`SELECT id FROM ${table} WHERE ${condition} AND id > ? ORDER BY id LIMIT ?`)
      .bind(...args, cursor, count).all()).results;
    if (cursor && page.length < count) page.push(...(await env.DB.prepare(
      `SELECT id FROM ${table} WHERE ${condition} AND id <= ? ORDER BY id LIMIT ?`)
      .bind(...args, cursor, count - page.length).all()).results);
    if (page.length) await env.DB.prepare(`INSERT INTO cleanup_progress(name,cursor) VALUES (?,?)
      ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor`).bind(name, page.at(-1).id).run();
    return page.map(r => r.id);
  };
  const step = async (name, condition, ...args) => {
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const batch = await ids(name, 'messages', condition, args);
      if (!batch.length) break;
      counts[name] += await removeMessages(env, batch);
      if (batch.length < BATCH) break;
    }
  };
  await step('expired', "state = 'stored' AND expires_at <= ?", now);
  await step('stale', "state = 'pending' AND received_at < ?", now - quiesce);
  await step('retried', "state = 'deleting'");
  const destroying = await ids('destroying', 'inboxes', "state = 'destroying'", [], DESTROY_PER_SWEEP);
  for (const id of destroying) {
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const n = await destroyStep(env, id);
      counts.destroyed_messages += n;
      if (n < BATCH) break;
    }
    if (await tryFinalize(env, id)) counts.finalized++;
  }
  counts.reconciled = await reconcilePrefixes(env);
  await env.DB.prepare('DELETE FROM event_streams WHERE id IN (SELECT id FROM event_streams WHERE expires_at <= unixepoch() LIMIT 50)').run();
  // Reserve this run's cleanup/reconciliation work before admitting new destruction
  // work. At most five transitions, never BATCH * SWEEP_ROUNDS: each transition
  // includes a transaction and optional telemetry. Failures leave expiry denial in
  // force and retry next run. Combined cleanup/TTL/event/telemetry budget evidence
  // lives in QUALIFICATION.md; local counts are not CPU guarantees.
  try {
    const lapsed = (await env.DB.prepare("SELECT id FROM inboxes WHERE state = 'active' AND expires_at <= ? ORDER BY expires_at, id LIMIT 5")
      .bind(now).all()).results;
    for (const { id } of lapsed) {
      try { if (await beginDestroy(env, id, now)) counts.lifetimes++; }
      catch { break; }
    }
  } catch { /* A failed admission query must not undo completed cleanup. */ }
  console.log(JSON.stringify({ sweep: counts })); // counts only, never content
  return counts;
}

// ---------------------------------------------------------------------------
// RPC: InboxManagement (bound only to the API Worker)
// ---------------------------------------------------------------------------

class Invalid extends Error {}
const fail = code => ({ error: code });

const isPlain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
// Options objects: undefined means none (when allowed); unknown keys are invalid.
function options(value, allowed, { required = false } = {}) {
  if (value === undefined && !required) return {};
  if (!isPlain(value)) throw new Invalid();
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Invalid();
  return value;
}
function handle(value, kind) {
  if (typeof value !== 'string' || !IDS[kind].test(value)) throw new Invalid();
  return value;
}
// Endpoint lifetime in seconds from {ttl_seconds} or {preset}, never both; null when
// neither is given and none is required. Bounded by MAX_INBOX_TTL_SECONDS.
function lifetime(env, o, { required }) {
  const hasTtl = o.ttl_seconds !== undefined, hasPreset = o.preset !== undefined;
  if (hasTtl && hasPreset) throw new Invalid();
  if (hasPreset) {
    if (typeof o.preset !== 'string' || !Object.hasOwn(PRESETS, o.preset)) throw new Invalid();
    if (PRESETS[o.preset] > limits(env).MAX_INBOX_TTL_SECONDS) throw new Invalid();
    return PRESETS[o.preset];
  }
  if (!hasTtl) { if (required) throw new Invalid(); return null; }
  if (!Number.isSafeInteger(o.ttl_seconds) || o.ttl_seconds < MIN_TTL || o.ttl_seconds > limits(env).MAX_INBOX_TTL_SECONDS) throw new Invalid();
  return o.ttl_seconds;
}
const printable = (s, max) => typeof s === 'string' && s.length > 0 && [...s].length <= max && !/[\p{C}]/u.test(s);

function inboxView(env, row) {
  const L = limits(env);
  const now = nowSeconds();
  const today = utcDay(now);
  // A lifetime that has ended reports destroying before the sweep's transition runs.
  const lapsed = row.state === 'active' && row.expires_at !== null && row.expires_at <= now;
  const view = { id: row.id, type: row.type, label: row.label ?? null, state: lapsed ? 'destroying' : row.state };
  if (row.type === 'email') {
    view.address = `${row.nonce}@${inboxDomain(env)}`;
    view.email_auth = row.email_auth_json === null ? null : normalizeEmailAuth(JSON.parse(row.email_auth_json));
    if (view.email_auth) view.restricted_email_max_bytes = Math.min(L.MAX_EMAIL_BYTES, RESTRICTED_EMAIL_MAX_BYTES);
  }
  else view.url = `https://${row.nonce}.${inboxDomain(env)}/`;
  view.created_at = row.created_at;
  view.expires_at = row.expires_at ?? null;
  view.usage = { bytes: row.bytes_stored, messages: row.message_count, receipts_today: row.day === today ? row.day_count : 0 };
  view.limits = { bytes: L.MAX_INBOX_BYTES, messages: L.MAX_INBOX_MESSAGES, daily_receipts: L.MAX_DAILY_RECEIPTS };
  if (row.type === 'http') view.closed = row.auth_required === 1;
  if (view.state === 'destroying') view.cleanup_not_before = (lapsed ? row.expires_at : row.destroy_requested_at) + L.DESTROY_QUIESCE_SECONDS;
  return view;
}
const INBOX_COLUMNS = `i.id, i.type, i.nonce, i.label, i.state, i.created_at, i.expires_at, i.destroy_requested_at, i.bytes_stored, i.message_count, i.day, i.day_count, i.auth_required, i.email_auth_json`;

function summary(row, type) {
  const meta = JSON.parse(row.meta_json);
  const preview = type === 'email'
    ? { from: meta.from ?? null, subject: meta.subject ?? null, attachments: (meta.attachments || []).length }
    : { method: meta.method, path: meta.path, content_type: meta.content_type ?? null, credential_name: meta.credential?.name ?? null };
  return { message: { id: row.id, inbox_id: row.inbox_id, type, received_at: row.received_at, expires_at: row.expires_at,
    archived: row.archived === 1, size: row.size, preview }, meta };
}
const credentialView = r => ({ id: r.id, kind: r.kind, name: r.name, hint: r.hint, created_at: r.created_at,
  expires_at: r.expires_at ?? null, last_used_at: r.last_used_at ?? null });

// Only live inboxes of this owner are visible to message and credential operations.
const activeInbox = async (env, owner, inboxId) => {
  const row = await env.DB.prepare(`SELECT id, type, expires_at FROM inboxes WHERE id = ? AND owner = ? AND ${LIVE('')}`)
    .bind(inboxId, owner).first();
  return row && (row.expires_at === null || row.expires_at > nowSeconds()) ? row : null;
};

// A visible message: stored and unexpired, in a live inbox of this owner.
const visibleMessage = async (env, owner, inboxId, messageId) => {
  const row = await env.DB.prepare(
  `SELECT m.id, m.inbox_id, m.received_at, m.expires_at, m.archived, m.size, m.meta_json, i.type,
      i.expires_at AS inbox_expires_at
   FROM messages m JOIN inboxes i ON i.id = m.inbox_id
   WHERE m.id = ? AND m.inbox_id = ? AND i.owner = ? AND ${LIVE('i.')} AND m.state = 'stored' AND m.expires_at > unixepoch()`
).bind(messageId, inboxId, owner).first();
  const now = nowSeconds();
  return row && row.expires_at > now && (row.inbox_expires_at === null || row.inbox_expires_at > now) ? row : null;
};

// Arrival events: minimal references in commit order, never content.
const EVENT_PAGE = 100;
const encodeCursor = (epoch, inboxId, seq) => b64url(`${epoch}:${inboxId}:${seq}`);
function parseAfter(after, inboxId) {
  if (after === undefined) return { seq: 0 };
  if (after === 'now') return {};
  const decoded = typeof after === 'string' && after.length <= 200 ? unb64url(after) : null;
  const m = decoded && /^([0-9a-f]{16}):(ibx_[a-z2-7]{26}):(\d{1,15})$/.exec(decoded);
  if (!m || m[2] !== inboxId) throw new Invalid();
  return { epoch: m[1], seq: Number(m[3]) };
}

// One transactional snapshot prevents a commit between event and head reads from
// being skipped. The final liveness check preserves the TTL read contract.
async function readEvents(env, owner, inboxId, position, limit, lease = null) {
  const [rows, feed, inbox] = await env.DB.batch([
    env.DB.prepare(`SELECT e.seq, e.type, e.message_id, e.created_at, m.expires_at FROM events e
      JOIN messages m ON m.id = e.message_id AND m.inbox_id = e.inbox_id
      JOIN inboxes i ON i.id = e.inbox_id
      WHERE e.inbox_id = ?1 AND e.seq > ?2 AND i.owner = ?4 AND ${LIVE('i.')}
      AND m.state = 'stored' AND m.expires_at > unixepoch() ORDER BY e.seq LIMIT ?3`)
      .bind(inboxId, position.seq ?? Number.MAX_SAFE_INTEGER, limit + 1, owner),
    env.DB.prepare('SELECT epoch FROM event_feed WHERE id = 1'),
    env.DB.prepare(`SELECT event_seq FROM inboxes i WHERE id = ?1 AND owner = ?2 AND ${LIVE('i.')}
      AND (?3 IS NULL OR EXISTS (SELECT 1 FROM event_streams s WHERE s.id = ?3 AND s.inbox_id = i.id AND s.expires_at > unixepoch()))`)
      .bind(inboxId, owner, lease),
  ]);
  const head = inbox.results[0], epoch = feed.results[0]?.epoch;
  if (!head || !await activeInbox(env, owner, inboxId)) return fail('not_found');
  if (!epoch) return fail('unavailable');
  if (position.epoch !== undefined && (position.epoch !== epoch || position.seq > head.event_seq)) return fail('expired');
  const page = rows.results.slice(0, limit), more = rows.results.length > limit;
  const at = seq => encodeCursor(epoch, inboxId, seq);
  return {
    events: page.filter(r => r.expires_at > nowSeconds()).map(r => ({ event_id: `evt_${r.seq}`, type: r.type, message_id: r.message_id,
      cursor: at(r.seq), created_at: r.created_at })),
    cursor: at(more ? page[page.length - 1].seq : Math.max(position.seq ?? 0, head.event_seq)),
    more,
  };
}

// Portable export: one bounded page as a streamed POSIX ustar archive.
const EXPORT_FORMAT = 'bayleaf-inbox-export';
const EXPORT_LIVE = LIVE('i.');
async function exportInboxRow(env, owner, inboxId) {
  const row = await env.DB.prepare(`SELECT ${INBOX_COLUMNS}, i.expires_at AS inbox_expires_at
    FROM inboxes i WHERE i.id = ? AND i.owner = ? AND ${EXPORT_LIVE}`).bind(inboxId, owner).first();
  return row && (row.inbox_expires_at === null || row.inbox_expires_at > nowSeconds()) ? row : null;
}
async function exportMessageRow(env, owner, inboxId, messageId) {
  const row = await env.DB.prepare(`SELECT m.id, m.inbox_id, m.received_at, m.expires_at,
      m.archived, m.size, m.meta_json, i.type, i.nonce, i.expires_at AS inbox_expires_at
    FROM messages m JOIN inboxes i ON i.id = m.inbox_id
    WHERE m.id = ? AND m.inbox_id = ? AND i.owner = ? AND ${EXPORT_LIVE}
      AND m.state = 'stored' AND m.expires_at > unixepoch()`).bind(messageId, inboxId, owner).first();
  const now = nowSeconds();
  return row && row.expires_at > now && (row.inbox_expires_at === null || row.inbox_expires_at > now) ? row : null;
}
async function releaseExportReader(reader) {
  try { await reader.cancel(); } catch { /* preserve the original error */ }
  reader.releaseLock();
}
const TAR_BLOCK = 512;
const zeros = n => new Uint8Array(n);
const tarPadding = size => zeros((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
function tarHeader(name, size, mtime) {
  const header = zeros(TAR_BLOCK);
  const put = (text, offset) => header.set(new TextEncoder().encode(text), offset);
  const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}\0`;
  put(name, 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(mtime, 12), 136);
  put('        ', 148);
  put('0', 156);
  put('ustar\x0000', 257);
  const sum = header.reduce((n, b) => n + b, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

// HAR-shaped reconstruction, never a wire capture or conformant HAR transaction.
const HAR_COMMENT = 'Reconstructed by BayLeaf Inboxes from stored metadata and the exact stored body; not a wire capture. Not conformant HAR 1.2: unknown total/send/wait/receive durations use -1. Status 0, httpVersion unknown and uncaptured content size 0 are BayLeaf placeholders, not standard unknown sentinels.';
const HAR_DROPPED = ['cf-*', ...DROPPED];
const HAR_REDACTED = new Set(['authorization', 'proxy-authorization', 'cookie']);
const iso = s => new Date(s * 1000).toISOString();
function harText(contentType, bytes) {
  if (!bytes || !isTextual(contentType)) return null;
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset)) return null;
  if (charset === 'us-ascii' && bytes.some(b => b > 127)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}
function harEntry(env, row, meta, body) {
  const headers = (meta.headers || []).map(([name, value]) => ({ name, value }));
  const request = { method: meta.method,
    url: `https://${row.nonce}.${inboxDomain(env)}${meta.path}${meta.query ? `?${meta.query}` : ''}`,
    httpVersion: 'unknown', cookies: [], headers,
    queryString: [...new URLSearchParams(meta.query || '')].map(([name, value]) => ({ name, value })),
    headersSize: -1, bodySize: row.size };
  if (row.size > 0) {
    const mimeType = meta.content_type || '';
    request.postData = typeof body.text === 'string' ? { mimeType, text: body.text, _sha256: body.sha256 }
      : { mimeType, _file: `payloads/${row.id}.body`, _sha256: body.sha256, ...(body.truncated ? { _truncated: true } : {}) };
  }
  const head = meta.method === 'HEAD';
  const expected = { status: 200, statusText: 'OK',
    headers: [...(head ? [] : [{ name: 'content-type', value: 'application/json' }]), { name: 'access-control-allow-origin', value: '*' }],
    content: head ? { size: 0, mimeType: '' } : { size: 11, mimeType: 'application/json', text: '{"ok":true}' },
    bodySize: head ? 0 : 11, _observed: false };
  const response = { status: 0, statusText: '', httpVersion: 'unknown', cookies: [], headers: [],
    content: { size: 0, mimeType: '', _captured: false }, redirectURL: '', headersSize: -1, bodySize: -1,
    _observed: false, comment: 'No response captured. Stored bytes do not prove a sender received an acknowledgement.' };
  return { startedDateTime: iso(row.received_at), time: -1, request, response, cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: -1, wait: -1, receive: -1 }, comment: HAR_COMMENT,
    _expectedAcknowledgement: expected,
    _receiptId: row.id, _archived: row.archived === 1, _expiresAt: iso(row.expires_at),
    _credentialName: meta.credential?.name ?? null, _timingsUnknown: true, _headersNormalized: true,
    _redacted: headers.filter(h => HAR_REDACTED.has(h.name)).map(h => h.name), _dropped: HAR_DROPPED,
    ...(meta.headers_truncated ? { _headersTruncated: true } : {}) };
}
const harLog = entries => `{"log":{"version":"1.2","_profile":"bayleaf-inbox-receipt-1","creator":{"name":"BayLeaf Inboxes","version":"1"},"comment":${
  JSON.stringify(HAR_COMMENT)},"entries":[${entries.join(',')}]}}`;

async function* inspectBody(reader, size, keep, out) {
  const digest = new crypto.DigestStream('SHA-256');
  const hashed = digest.digest;
  hashed.catch(() => {});
  const hasher = digest.getWriter();
  const kept = keep >= size ? new Uint8Array(size) : null;
  let copied = 0, complete = false;
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      copied += chunk.byteLength;
      if (copied > size) throw new Error('size mismatch');
      await hasher.write(chunk.slice());
      if (kept) kept.set(chunk, copied - chunk.byteLength);
      yield chunk;
    }
    if (copied !== size) throw new Error('size mismatch');
    await hasher.close();
    out.sha256 = hex(await hashed);
    if (kept) out.bytes = kept;
    complete = true;
  } finally {
    if (!complete) { try { await hasher.abort(); } catch {} }
    hasher.releaseLock();
  }
}

// Pull-based: one R2 reader, bounded retained HAR text/metadata, manifest last.
function exportStream(env, owner, inbox, rows, page) {
  let cancelled = false, activeReader = null;
  async function* parts() {
    const receipts = [], omitted = [], har = [];
    const L = limits(env);
    let inlined = 0;
    for (const listed of rows) {
      const row = await exportMessageRow(env, owner, inbox.id, listed.id);
      const object = row ? await env.BLOBS.get(objectKey(inbox.id, row.id)) : null;
      if (!row || !object) { omitted.push(listed.id); continue; }
      const reader = object.body.getReader();
      activeReader = reader;
      try {
        if (cancelled) return;
        if (!await exportMessageRow(env, owner, inbox.id, row.id)) { omitted.push(listed.id); continue; }
        if (cancelled) return;
        if (object.size !== row.size) throw new Error('size mismatch');
        const file = `payloads/${row.id}.${inbox.type === 'email' ? 'eml' : 'body'}`;
        yield tarHeader(file, row.size, row.received_at);
        const meta = JSON.parse(row.meta_json);
        const textual = inbox.type === 'http' && row.size > 0 && isTextual(meta.content_type);
        const fits = textual && row.size <= L.MAX_HAR_TEXT_BYTES && inlined + row.size <= L.MAX_HAR_PAGE_TEXT_BYTES;
        const body = {};
        yield* inspectBody(reader, row.size, fits ? row.size : -1, body);
        if (!await exportMessageRow(env, owner, inbox.id, row.id)) throw new Error('receipt expired');
        yield tarPadding(row.size);
        receipts.push({ id: row.id, file, received_at: row.received_at, expires_at: row.expires_at,
          archived: row.archived === 1, size: row.size, sha256: body.sha256, meta });
        if (inbox.type === 'http') {
          const text = harText(meta.content_type, body.bytes);
          if (text !== null) inlined += row.size;
          har.push(JSON.stringify(harEntry(env, row, meta, { sha256: body.sha256, text, truncated: textual && !fits })));
        }
      } finally {
        await releaseExportReader(reader);
        activeReader = null;
      }
    }
    if (!await exportInboxRow(env, owner, inbox.id)) throw new Error('inbox expired');
    const harFile = inbox.type === 'http' ? 'receipts.har' : null;
    if (harFile) {
      const prefix = harLog([]).slice(0, -3), suffix = ']}}';
      const encoder = new TextEncoder();
      const size = encoder.encode(prefix).byteLength + encoder.encode(suffix).byteLength
        + har.reduce((sum, entry) => sum + encoder.encode(entry).byteLength, 0) + Math.max(0, har.length - 1);
      yield tarHeader(harFile, size, nowSeconds());
      yield encoder.encode(prefix);
      for (let i = 0; i < har.length; i++) {
        if (i) yield encoder.encode(',');
        yield encoder.encode(har[i]);
        har[i] = '';
      }
      har.length = 0;
      yield encoder.encode(suffix);
      yield tarPadding(size);
    }
    const manifest = new TextEncoder().encode(JSON.stringify({ format: EXPORT_FORMAT, version: 1, exported_at: nowSeconds(),
      inbox: page.inbox, order: 'received_at_asc', cursor: page.cursor, next_cursor: page.next_cursor, har: harFile,
      receipts, omitted }, null, 2));
    yield tarHeader(`manifests/${rows[0]?.id ?? 'empty'}.json`, manifest.byteLength, nowSeconds());
    yield manifest;
    yield tarPadding(manifest.byteLength);
    yield zeros(TAR_BLOCK * 2);
  }
  const it = parts();
  let emittedBytes = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await it.next();
        if (cancelled) return;
        if (done) {
          await countTelemetry(env, 'inbox.export.pages', inbox.type, 'emitted');
          await countTelemetry(env, 'inbox.export.bytes', inbox.type, 'emitted', emittedBytes);
          controller.close();
        } else {
          emittedBytes += value.byteLength;
          controller.enqueue(value);
        }
      } catch {
        if (!cancelled) controller.error(new Error('export interrupted'));
      }
    },
    async cancel() {
      cancelled = true;
      if (activeReader) { try { await activeReader.cancel(); } catch {} }
      await it.return();
    },
  });
}

const rpc = {
  async getLimits(env, owner) {
    const L = limits(env);
    const usage = await env.DB.prepare(`SELECT COUNT(*) AS inboxes,
      COALESCE(SUM(bytes_stored),0) AS bytes, COALESCE(SUM(message_count),0) AS messages
      FROM inboxes WHERE owner=?`).bind(owner).first();
    return {
      owner: { max_inboxes: L.MAX_INBOXES_PER_OWNER, inboxes: usage.inboxes,
        remaining_inboxes: Math.max(0, L.MAX_INBOXES_PER_OWNER - usage.inboxes),
        max_bytes: L.MAX_OWNER_BYTES, bytes: usage.bytes,
        remaining_bytes: Math.max(0, L.MAX_OWNER_BYTES - usage.bytes), messages: usage.messages },
      per_inbox: { max_bytes: L.MAX_INBOX_BYTES, max_messages: L.MAX_INBOX_MESSAGES,
        max_daily_receipts: L.MAX_DAILY_RECEIPTS, max_credentials: L.MAX_CREDENTIALS_PER_INBOX },
      payload: { http_max_bytes: L.MAX_HTTP_BODY_BYTES, email_max_bytes: L.MAX_EMAIL_BYTES,
        restricted_email_max_bytes: Math.min(L.MAX_EMAIL_BYTES, RESTRICTED_EMAIL_MAX_BYTES),
        restricted_email_creation_enabled: env.EMAIL_AUTH_CREATION_ENABLED === 'true' },
      lifetime: { min_seconds: MIN_TTL, max_seconds: L.MAX_INBOX_TTL_SECONDS,
        presets_seconds: Object.fromEntries(Object.entries(PRESETS).filter(([, seconds]) => seconds <= L.MAX_INBOX_TTL_SECONDS)),
        default_ttl_seconds: null },
      retention_seconds: L.RETENTION_SECONDS, destroy_quiesce_seconds: L.DESTROY_QUIESCE_SECONDS,
    };
  },

  async retireOwner(env, owner) {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO retired_owners(owner,retired_at) VALUES (?,?)').bind(owner, nowSeconds()),
      env.DB.prepare(`INSERT OR IGNORE INTO cleanup_prefixes(inbox_id,turn)
        SELECT id,(SELECT COALESCE(MAX(turn),0)+1 FROM cleanup_prefixes) FROM inboxes WHERE owner=?`).bind(owner),
      env.DB.prepare(`UPDATE inboxes SET state='destroying',destroy_requested_at=?
        WHERE owner=? AND state='active'`).bind(nowSeconds(), owner),
      env.DB.prepare('DELETE FROM credentials WHERE inbox_id IN (SELECT id FROM inboxes WHERE owner=?)').bind(owner),
      env.DB.prepare('DELETE FROM event_streams WHERE inbox_id IN (SELECT id FROM inboxes WHERE owner=?)').bind(owner),
    ]);
    return { retired: true };
  },

  async createInbox(env, owner, opts) {
    const o = options(opts, ['type', 'access', 'label', 'ttl_seconds', 'preset', 'email_auth'], { required: true });
    if (o.type !== 'email' && o.type !== 'http') throw new Invalid();
    // Webhook access is an explicit creation choice: closed from birth leaves no anonymous window.
    if (o.type === 'http' ? o.access !== 'open' && o.access !== 'closed' : o.access !== undefined) throw new Invalid();
    if (o.label !== undefined && o.label !== null && !printable(o.label, 64)) throw new Invalid();
    if (o.type !== 'email' && o.email_auth !== undefined) throw new Invalid();
    let policy;
    try { policy = normalizeEmailAuth(o.email_auth); } catch { throw new Invalid(); }
    // Deploy verifier everywhere before permitting the first restricted inbox.
    // This gate only controls creation: turning it off never bypasses an existing policy.
    if (policy && env.EMAIL_AUTH_CREATION_ENABLED !== 'true') return fail('disabled');
    const policyJson = policy === null ? null : JSON.stringify(policy);
    const id = `ibx_${nonce()}`, now = nowSeconds();
    const ttl = lifetime(env, o, { required: false });
    const done = await env.DB.prepare(
      `INSERT INTO inboxes (id, owner, type, nonce, label, state, created_at, expires_at, email_auth_json, auth_required)
       SELECT ?1, ?2, ?3, ?4, ?5, 'active', ?6, ?8, ?9, ?10 WHERE (SELECT COUNT(*) FROM inboxes WHERE owner = ?2) < ?7
         AND NOT EXISTS (SELECT 1 FROM retired_owners WHERE owner = ?2)`
    ).bind(id, owner, o.type, nonce(), o.label ?? null, now, limits(env).MAX_INBOXES_PER_OWNER,
      ttl === null ? null : now + ttl, policyJson, o.access === 'closed' ? 1 : 0).run();
    if (done.meta.changes !== 1) return fail('limit');
    await countTelemetry(env, 'inbox.lifecycle', o.type, 'created');
    return rpc.getInbox(env, owner, id);
  },

  async listInboxes(env, owner) {
    const rows = (await env.DB.prepare(`SELECT ${INBOX_COLUMNS} FROM inboxes i WHERE i.owner = ? ORDER BY i.created_at DESC, i.id DESC`)
      .bind(owner).all()).results;
    const bytes = rows.reduce((n, r) => n + r.bytes_stored, 0);
    return { inboxes: rows.map(r => inboxView(env, r)), owner_usage: { bytes, limit_bytes: limits(env).MAX_OWNER_BYTES } };
  },

  async getInbox(env, owner, inboxId) {
    handle(inboxId, 'inbox');
    const row = await env.DB.prepare(`SELECT ${INBOX_COLUMNS} FROM inboxes i WHERE i.id = ? AND i.owner = ?`).bind(inboxId, owner).first();
    return row ? inboxView(env, row) : fail('not_found');
  },

  // Shorten or set an endpoint lifetime; never lengthen it or remove it.
  async updateInbox(env, owner, inboxId, opts) {
    handle(inboxId, 'inbox');
    const o = options(opts, ['ttl_seconds', 'preset'], { required: true });
    const ttl = lifetime(env, o, { required: true });
    const now = nowSeconds();
    const done = await env.DB.prepare(
      `UPDATE inboxes SET expires_at = ?1 WHERE id = ?2 AND owner = ?3 AND ${LIVE('')}
         AND (expires_at IS NULL OR expires_at >= ?1)`
    ).bind(now + ttl, inboxId, owner).run();
    if (done.meta.changes !== 1) return (await activeInbox(env, owner, inboxId)) ? fail('conflict') : fail('not_found');
    return rpc.getInbox(env, owner, inboxId);
  },

  async destroyInbox(env, owner, inboxId) {
    handle(inboxId, 'inbox');
    await beginDestroy(env, inboxId, nowSeconds(), owner);
    const row = await env.DB.prepare('SELECT type, state, destroy_requested_at FROM inboxes WHERE id = ? AND owner = ?').bind(inboxId, owner).first();
    if (!row) return fail('not_found');
    try { await destroyStep(env, inboxId); } catch { /* best effort; the sweep continues */ }
    // Never claims completion: finalization happens in the sweep, observable as not_found.
    return { id: inboxId, state: 'destroying', cleanup_not_before: row.destroy_requested_at + limits(env).DESTROY_QUIESCE_SECONDS };
  },

  async listMessages(env, owner, inboxId, opts) {
    handle(inboxId, 'inbox');
    const o = options(opts, ['cursor', 'limit', 'q', 'archived']);
    const limit = o.limit === undefined ? 50 : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Invalid();
    const archived = o.archived === undefined ? false : o.archived;
    if (archived !== true && archived !== false && archived !== 'all') throw new Invalid();
    if (o.q !== undefined && (typeof o.q !== 'string' || o.q.length < 1 || o.q.length > 200)) throw new Invalid();
    let cursor = null;
    if (o.cursor !== undefined && o.cursor !== null) {
      const decoded = typeof o.cursor === 'string' && o.cursor.length <= 128 ? unb64url(o.cursor) : null;
      const m = decoded && /^(\d{1,15}):(msg_[a-z2-7]{26})$/.exec(decoded);
      if (!m) throw new Invalid();
      cursor = { at: Number(m[1]), id: m[2] };
    }
    const inbox = await activeInbox(env, owner, inboxId);
    if (!inbox) return fail('not_found');

    let sql = `SELECT id, inbox_id, received_at, expires_at, archived, size, meta_json FROM messages
               WHERE inbox_id = ? AND state = 'stored' AND expires_at > unixepoch()`;
    const args = [inboxId];
    if (archived !== 'all') { sql += ' AND archived = ?'; args.push(archived ? 1 : 0); }
    if (o.q !== undefined) {
      sql += " AND search_text LIKE ? ESCAPE '\\'";
      args.push(`%${o.q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`);
    }
    if (cursor) { sql += ' AND (received_at < ? OR (received_at = ? AND id < ?))'; args.push(cursor.at, cursor.at, cursor.id); }
    sql += ' ORDER BY received_at DESC, id DESC LIMIT ?';
    args.push(limit + 1);
    const rows = (await env.DB.prepare(sql).bind(...args).all()).results;
    if (!await activeInbox(env, owner, inboxId)) return fail('not_found');
    // Traverse the SQL page even when fresh expiry removes every returned row.
    // The lookahead remains on the next page; filtering must not terminate it.
    const scanned = rows.slice(0, limit);
    const page = scanned.filter(r => r.expires_at > nowSeconds());
    const last = scanned[scanned.length - 1];
    return { messages: page.map(r => summary(r, inbox.type).message),
      next_cursor: rows.length > limit ? b64url(`${last.received_at}:${last.id}`) : null };
  },

  async getMessage(env, owner, inboxId, messageId) {
    handle(inboxId, 'inbox'); handle(messageId, 'message');
    const row = await visibleMessage(env, owner, inboxId, messageId);
    if (!row) return fail('not_found');
    const { message, meta } = summary(row, row.type);
    return { ...message, meta };
  },

  async getMessageBody(env, owner, inboxId, messageId) {
    handle(inboxId, 'inbox'); handle(messageId, 'message');
    const row = await visibleMessage(env, owner, inboxId, messageId);
    if (!row) return fail('not_found');
    const object = await env.BLOBS.get(objectKey(inboxId, messageId));
    if (!object) return fail('unavailable');
    const bytes = await object.arrayBuffer();
    if (!await visibleMessage(env, owner, inboxId, messageId)) return fail('not_found');
    const type = row.type === 'email' ? 'message/rfc822' : (JSON.parse(row.meta_json).content_type || 'application/octet-stream');
    return new Response(bytes, { headers: { 'Content-Type': type, 'Content-Length': String(bytes.byteLength) } });
  },

  async getMessageText(env, owner, inboxId, messageId) {
    handle(inboxId, 'inbox'); handle(messageId, 'message');
    const row = await visibleMessage(env, owner, inboxId, messageId);
    if (!row) return fail('not_found');
    const meta = JSON.parse(row.meta_json);
    const max = limits(env).MAX_TEXT_CHARS;
    const result = (source, text) => ({ id: messageId, type: row.type, source,
      text: text.slice(0, max), truncated: text.length > max });
    if (row.type === 'http' && !isTextual(meta.content_type)) return result('none', '');
    if (row.type === 'email' && meta.parse_error) return result('none', '');
    if (row.type === 'email' && row.size > limits(env).MAX_EMAIL_BYTES) return fail('resource_limit');
    const object = await env.BLOBS.get(objectKey(inboxId, messageId));
    if (!object) return fail('unavailable');
    if (row.type === 'http') {
      const text = await object.text();
      if (!await visibleMessage(env, owner, inboxId, messageId)) return fail('not_found');
      return result('body', text);
    }
    const parsed = await parseEmail(await object.arrayBuffer(), limits(env).MAX_EMAIL_BYTES);
    if (!await visibleMessage(env, owner, inboxId, messageId)) return fail('not_found');
    if (parsed.text) return result('text', parsed.text);
    if (parsed.html) return { id: messageId, type: row.type, source: 'html', ...htmlToText(parsed.html, max) };
    return result('none', '');
  },

  async getAttachment(env, owner, inboxId, messageId, index) {
    handle(inboxId, 'inbox'); handle(messageId, 'message');
    if (!Number.isInteger(index) || index < 0) throw new Invalid();
    const row = await visibleMessage(env, owner, inboxId, messageId);
    if (!row || row.type !== 'email') return fail('not_found');
    const listed = (JSON.parse(row.meta_json).attachments || [])[index];
    if (!listed) return fail('not_found');
    if (row.size > limits(env).MAX_EMAIL_BYTES) return fail('resource_limit');
    const object = await env.BLOBS.get(objectKey(inboxId, messageId));
    if (!object) return fail('unavailable');
    // Attachments are extracted from the stored raw MIME on demand; there is no second store.
    const parsed = await parseEmail(await object.arrayBuffer(), limits(env).MAX_EMAIL_BYTES);
    const part = parsed.attachments[index];
    if (!await visibleMessage(env, owner, inboxId, messageId)) return fail('not_found');
    if (!part) return fail('not_found');
    const bytes = typeof part.content === 'string' ? new TextEncoder().encode(part.content) : new Uint8Array(part.content);
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType || '') ? part.mimeType.toLowerCase() : 'application/octet-stream';
    const filename = encodeURIComponent(part.filename || `attachment-${index}`).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(bytes, { headers: { 'Content-Type': mime, 'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}` } });
  },

  async setArchived(env, owner, inboxId, messageId, archived) {
    handle(inboxId, 'inbox'); handle(messageId, 'message');
    if (typeof archived !== 'boolean') throw new Invalid();
    const done = await env.DB.prepare(
      `UPDATE messages SET archived = ?1 WHERE id = ?2 AND inbox_id = ?3 AND state = 'stored' AND expires_at > unixepoch()
         AND EXISTS (SELECT 1 FROM inboxes WHERE id = ?3 AND owner = ?4 AND ${LIVE('')})`
    ).bind(archived ? 1 : 0, messageId, inboxId, owner).run();
    if (done.meta.changes !== 1) return fail('not_found');
    const row = await visibleMessage(env, owner, inboxId, messageId);
    return row ? summary(row, row.type).message : fail('not_found');
  },

  async deleteMessage(env, owner, inboxId, messageId) {
    handle(inboxId, 'inbox'); handle(messageId, 'message');
    if (!await visibleMessage(env, owner, inboxId, messageId)) return fail('not_found');
    const removed = await removeMessages(env, [messageId]);
    return removed === 1 ? { id: messageId, deleted: true } : { id: messageId, state: 'deleting' };
  },

  async createCredential(env, owner, inboxId, opts) {
    handle(inboxId, 'inbox');
    const o = options(opts, ['name', 'expires_at']);
    const now = nowSeconds();
    if (o.name !== undefined && !printable(o.name, 64)) throw new Invalid();
    const expires = o.expires_at ?? null;
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= now || expires > now + YEAR)) throw new Invalid();
    const inbox = await activeInbox(env, owner, inboxId);
    if (!inbox || inbox.type !== 'http') return fail('not_found');
    const token = `sk-bayleaf-inbox-${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const row = { id: `cred_${nonce()}`, kind: 'bearer', name: o.name ?? `token-${hex(crypto.getRandomValues(new Uint8Array(2)))}`,
      hint: token.slice(-4), created_at: now, expires_at: expires, last_used_at: null };
    const [done] = await env.DB.batch([env.DB.prepare(
      `INSERT INTO credentials (id, inbox_id, kind, name, hint, secret_hash, created_at, expires_at)
       SELECT ?1, ?2, 'bearer', ?3, ?4, ?5, ?6, ?7
       WHERE EXISTS (SELECT 1 FROM inboxes WHERE id = ?2 AND owner = ?8 AND ${LIVE('')} AND type = 'http')
         AND (SELECT COUNT(*) FROM credentials WHERE inbox_id = ?2) < ?9`
    ).bind(row.id, inboxId, row.name, row.hint, await sha256(token), now, expires, owner, limits(env).MAX_CREDENTIALS_PER_INBOX),
    env.DB.prepare(`UPDATE inboxes SET auth_required = 1 WHERE id = ?1
      AND EXISTS (SELECT 1 FROM credentials WHERE id = ?2 AND inbox_id = ?1)`).bind(inboxId, row.id),
    ]);
    if (done.meta.changes !== 1) return (await activeInbox(env, owner, inboxId)) ? fail('limit') : fail('not_found');
    if (!await activeInbox(env, owner, inboxId)) {
      // Never leave an undisclosed minted credential after losing the final check.
      // If deletion fails, expiry still denies use and the destruction sweep retries.
      try { await env.DB.prepare('DELETE FROM credentials WHERE id = ? AND inbox_id = ?').bind(row.id, inboxId).run(); } catch {}
      return fail('not_found');
    }
    // The token is returned once and only its hash is stored.
    return { credential: credentialView(row), token, inbox_closed: true,
      notice: 'Senders now require a bearer credential. Revoking or expiring every credential does not reopen this inbox; create a replacement to restore delivery.' };
  },

  async listCredentials(env, owner, inboxId) {
    handle(inboxId, 'inbox');
    const inbox = await activeInbox(env, owner, inboxId);
    if (!inbox || inbox.type !== 'http') return fail('not_found');
    const rows = (await env.DB.prepare(
      'SELECT id, kind, name, hint, created_at, expires_at, last_used_at FROM credentials WHERE inbox_id = ? ORDER BY created_at, id'
    ).bind(inboxId).all()).results;
    if (!await activeInbox(env, owner, inboxId)) return fail('not_found');
    return { credentials: rows.map(credentialView) };
  },

  async getMessageHar(env, owner, inboxId, messageId) {
    handle(inboxId, 'inbox'); handle(messageId, 'message');
    const row = await exportMessageRow(env, owner, inboxId, messageId);
    if (!row) return fail('not_found');
    if (row.type !== 'http') return fail('unsupported');
    const meta = JSON.parse(row.meta_json);
    const object = await env.BLOBS.get(objectKey(inboxId, messageId));
    if (!object) return fail('unavailable');
    const reader = object.body.getReader();
    try {
      if (!await exportMessageRow(env, owner, inboxId, messageId)) return fail('not_found');
      if (object.size !== row.size) return fail('unavailable');
      const textual = row.size > 0 && isTextual(meta.content_type);
      const fits = textual && row.size <= limits(env).MAX_HAR_TEXT_BYTES;
      const body = {};
      for await (const _ of inspectBody(reader, row.size, fits ? row.size : -1, body)) { /* bounded digest/copy */ }
      const har = harLog([JSON.stringify(harEntry(env, row, meta,
        { sha256: body.sha256, text: harText(meta.content_type, body.bytes), truncated: textual && !fits }))]);
      if (!await exportMessageRow(env, owner, inboxId, messageId)) return fail('not_found');
      return new Response(har, { headers: { 'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${messageId}.har"` } });
    } finally { await releaseExportReader(reader); }
  },

  async exportInbox(env, owner, inboxId, opts) {
    handle(inboxId, 'inbox');
    const o = options(opts, ['cursor', 'limit']);
    const limit = o.limit === undefined ? 50 : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Invalid();
    let after = null;
    if (o.cursor !== undefined && o.cursor !== null) {
      const decoded = typeof o.cursor === 'string' && o.cursor.length <= 128 ? unb64url(o.cursor) : null;
      const m = decoded && /^x:(\d{1,15}):(msg_[a-z2-7]{26})$/.exec(decoded);
      if (!m) throw new Invalid();
      after = { at: Number(m[1]), id: m[2] };
    }
    const row = await exportInboxRow(env, owner, inboxId);
    if (!row) return fail('not_found');
    let sql = `SELECT id, received_at, size, length(CAST(meta_json AS BLOB)) AS meta_size
      FROM messages WHERE inbox_id = ? AND state = 'stored' AND expires_at > unixepoch()`;
    const args = [inboxId];
    if (after) { sql += ' AND (received_at > ? OR (received_at = ? AND id > ?))'; args.push(after.at, after.at, after.id); }
    sql += ' ORDER BY received_at, id LIMIT ?';
    args.push(limit + 1);
    const listed = (await env.DB.prepare(sql).bind(...args).all()).results;
    if (!await exportInboxRow(env, owner, inboxId)) return fail('not_found');
    const budget = limits(env).MAX_EXPORT_BYTES, metaBudget = limits(env).MAX_EXPORT_META_BYTES;
    const rows = [];
    let bytes = 0, metaBytes = 0;
    for (const r of listed.slice(0, limit)) {
      if (rows.length && (bytes + r.size > budget || metaBytes + r.meta_size > metaBudget)) break;
      rows.push(r); bytes += r.size; metaBytes += r.meta_size;
    }
    const last = rows[rows.length - 1];
    const next = rows.length < listed.length ? b64url(`x:${last.received_at}:${last.id}`) : null;
    const view = inboxView(env, row);
    const inbox = { id: view.id, type: view.type, label: view.label,
      ...(view.address ? { address: view.address } : { url: view.url }), created_at: view.created_at };
    const headers = { 'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="${inboxId}-export.tar"` };
    if (next) headers['X-Inbox-Export-Next-Cursor'] = next;
    return new Response(exportStream(env, owner, { id: inboxId, type: row.type }, rows,
      { inbox, cursor: o.cursor ?? null, next_cursor: next }), { headers });
  },

  async listEvents(env, owner, inboxId, opts) {
    handle(inboxId, 'inbox');
    const o = options(opts, ['after', 'limit']);
    const limit = o.limit === undefined ? EVENT_PAGE : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_PAGE) throw new Invalid();
    return readEvents(env, owner, inboxId, parseAfter(o.after, inboxId), limit);
  },

  async acquireEventStream(env, owner, inboxId, opts) {
    handle(inboxId, 'inbox');
    const o = options(opts, ['after']);
    const first = await readEvents(env, owner, inboxId, parseAfter(o.after, inboxId), 1);
    if (first.error) return first;
    const id = `stm_${nonce()}`;
    const [, inserted, lease] = await env.DB.batch([
      env.DB.prepare('DELETE FROM event_streams WHERE inbox_id = ? AND expires_at <= unixepoch()').bind(inboxId),
      env.DB.prepare(`INSERT INTO event_streams(id, inbox_id, expires_at)
        SELECT ?1, i.id, unixepoch() + 300 FROM inboxes i WHERE i.id = ?2 AND i.owner = ?3 AND ${LIVE('i.')}
        AND (SELECT COUNT(*) FROM event_streams WHERE inbox_id = i.id AND expires_at > unixepoch()) < 4`)
        .bind(id, inboxId, owner),
      env.DB.prepare('SELECT expires_at FROM event_streams WHERE id = ?').bind(id),
    ]);
    if (inserted.meta.changes !== 1) {
      const live = await activeInbox(env, owner, inboxId);
      return fail(live ? 'busy' : 'not_found');
    }
    // Resolve now once: a commit during the handshake must remain visible.
    return { lease_id: id, expires_at: lease.results[0].expires_at,
      after: o.after === 'now' ? first.cursor : o.after ?? null };
  },

  async readEventStream(env, owner, inboxId, leaseId, opts) {
    handle(inboxId, 'inbox');
    if (typeof leaseId !== 'string' || !/^stm_[a-z2-7]{26}$/.test(leaseId)) throw new Invalid();
    const o = options(opts, ['after']);
    return readEvents(env, owner, inboxId, parseAfter(o.after, inboxId), EVENT_PAGE, leaseId);
  },

  async releaseEventStream(env, owner, inboxId, leaseId) {
    handle(inboxId, 'inbox');
    if (typeof leaseId !== 'string' || !/^stm_[a-z2-7]{26}$/.test(leaseId)) throw new Invalid();
    await env.DB.prepare(`DELETE FROM event_streams WHERE id = ? AND inbox_id = ?
      AND EXISTS (SELECT 1 FROM inboxes WHERE id = ? AND owner = ?)`)
      .bind(leaseId, inboxId, inboxId, owner).run();
    return { released: true };
  },

  async revokeCredential(env, owner, inboxId, credentialId) {
    handle(inboxId, 'inbox'); handle(credentialId, 'credential');
    const done = await env.DB.prepare(
      `DELETE FROM credentials WHERE id = ?1 AND inbox_id = ?2
         AND EXISTS (SELECT 1 FROM inboxes WHERE id = ?2 AND owner = ?3 AND ${LIVE('')} AND type = 'http')`
    ).bind(credentialId, inboxId, owner).run();
    return done.meta.changes === 1 ? { id: credentialId, revoked: true } : fail('not_found');
  },
};

// Every method: feature flag, owner shape, then the operation. Never throws to the caller.
async function call(env, name, owner, args) {
  if (!enabled(env) && name !== 'retireOwner') return fail('disabled');
  if (typeof owner !== 'string' || !OWNER.test(owner)) return fail('invalid');
  try {
    if (name !== 'retireOwner' && await env.DB.prepare('SELECT owner FROM retired_owners WHERE owner=?').bind(owner).first())
      return fail('not_found');
    return await rpc[name](env, owner, ...args);
  } catch (e) {
    return fail(e instanceof Invalid ? 'invalid' : e instanceof MimeResourceLimit ? 'resource_limit' : 'unavailable');
  }
}

export class InboxManagement extends WorkerEntrypoint {
  getLimits(owner) { return call(this.env, 'getLimits', owner, []); }
  retireOwner(owner) { return call(this.env, 'retireOwner', owner, []); }
  createInbox(owner, opts) { return call(this.env, 'createInbox', owner, [opts]); }
  listInboxes(owner) { return call(this.env, 'listInboxes', owner, []); }
  getInbox(owner, inboxId) { return call(this.env, 'getInbox', owner, [inboxId]); }
  updateInbox(owner, inboxId, opts) { return call(this.env, 'updateInbox', owner, [inboxId, opts]); }
  destroyInbox(owner, inboxId) { return call(this.env, 'destroyInbox', owner, [inboxId]); }
  listMessages(owner, inboxId, opts) { return call(this.env, 'listMessages', owner, [inboxId, opts]); }
  getMessage(owner, inboxId, messageId) { return call(this.env, 'getMessage', owner, [inboxId, messageId]); }
  getMessageBody(owner, inboxId, messageId) { return call(this.env, 'getMessageBody', owner, [inboxId, messageId]); }
  getMessageText(owner, inboxId, messageId) { return call(this.env, 'getMessageText', owner, [inboxId, messageId]); }
  getAttachment(owner, inboxId, messageId, index) { return call(this.env, 'getAttachment', owner, [inboxId, messageId, index]); }
  setArchived(owner, inboxId, messageId, archived) { return call(this.env, 'setArchived', owner, [inboxId, messageId, archived]); }
  deleteMessage(owner, inboxId, messageId) { return call(this.env, 'deleteMessage', owner, [inboxId, messageId]); }
  createCredential(owner, inboxId, opts) { return call(this.env, 'createCredential', owner, [inboxId, opts]); }
  listCredentials(owner, inboxId) { return call(this.env, 'listCredentials', owner, [inboxId]); }
  revokeCredential(owner, inboxId, credentialId) { return call(this.env, 'revokeCredential', owner, [inboxId, credentialId]); }
  listEvents(owner, inboxId, opts) { return call(this.env, 'listEvents', owner, [inboxId, opts]); }
  acquireEventStream(owner, inboxId, opts) { return call(this.env, 'acquireEventStream', owner, [inboxId, opts]); }
  readEventStream(owner, inboxId, leaseId, opts) { return call(this.env, 'readEventStream', owner, [inboxId, leaseId, opts]); }
  releaseEventStream(owner, inboxId, leaseId) { return call(this.env, 'releaseEventStream', owner, [inboxId, leaseId]); }
  exportInbox(owner, inboxId, opts) { return call(this.env, 'exportInbox', owner, [inboxId, opts]); }
  getMessageHar(owner, inboxId, messageId) { return call(this.env, 'getMessageHar', owner, [inboxId, messageId]); }
}

export default {
  fetch: handleFetch,
  email: async (message, env) => {
    if (!enabled(env)) return handleEmail(message, env);
    let outcome = 'accepted';
    try { return await handleEmail(message, env, value => { outcome = value; }); }
    catch (error) { outcome = 'failure'; throw error; }
    finally { await countTelemetry(env, 'inbox.receipts', 'email', outcome); }
  },
  // Awaited (not waitUntil) so a local trigger returns only after the sweep is done.
  scheduled: async (controller, env) => {
    try {
      const counts = await sweep(env);
      for (const name of ['expired', 'stale', 'retried', 'destroyed_messages', 'reconciled']) {
        await countTelemetry(env, 'inbox.cleanup', '', name, counts[name]);
      }
      await countTelemetry(env, 'inbox.cleanup', '', 'success');
    } catch (error) {
      await countTelemetry(env, 'inbox.cleanup', '', 'failure');
      throw error;
    } finally {
      await exportTelemetry(env).catch(() => {});
    }
  },
};
