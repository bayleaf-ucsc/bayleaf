// BayLeaf Rooms (issue #159): one Durable Object per room. Contract: rooms/DESIGN.md.
//
// Principle: BayLeaf relays, it does not arbitrate. The room stores entries,
// orders them for delivery, gates access by credential and relays live. It never
// interprets app data. The one exception is codec "yjs", where it merges updates
// with Y.mergeUpdates to compact the log, still without reading the document.
//
// Planes: participants use HTTP and WebSocket on bayleaf-rooms.dev; owners use the
// RoomManagement RPC entrypoint, bound only to the API Worker. A dev-only HTTP shim
// for the owner plane (/owner/...) exists only when DEV_OWNER_TOKEN is set.
//
// Boundary: rooms intentionally store participant content, outside the API's
// ZDR/ZOA posture. Never log content, labels, ids, secrets, tickets or owners.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Y from "yjs";
import PROVIDER from "../client/y-bayleaf.js";   // bytes, not a module: see the Text rule in wrangler.jsonc

// ---------------------------------------------------------------------------
// Config and limits. Every number getLimits reports comes from here.

const DEFAULTS = {
  MAX_ROOMS_PER_OWNER: 20, MAX_CREDENTIALS_PER_ROOM: 100,
  MAX_ENTRY_BYTES_JSON: 65536, MAX_ENTRY_BYTES_YJS: 1048576,     // DECISIONS.md item 8
  MAX_ROOM_BYTES: 10485760, MAX_SOCKETS_PER_ROOM: 200, MAX_APPENDS_PER_SECOND: 50,
  DEFAULT_LIFE_DAYS: 30, MAX_LIFE_DAYS: 90, COMPACT_ENTRIES: 500,
};
const limits = (env) => Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => {
  const v = Number(env[k]);
  return [k, Number.isFinite(v) && v > 0 ? v : d];
}));
const enabled = (env) => env.ROOMS_ENABLED === "true";

const DAY = 86400_000;
const CHUNK = 1024 * 1024;            // compacted state is split under the 2 MB row cap
const TICKET_MS = 60_000;
const IDEM_MS = DAY;                  // idempotency keys are honored for 24 hours
// Presence lives in the socket attachment (2 KiB platform cap), so it stays small.
// In yjs rooms it is an opaque base64 y-protocols Awareness update. Measured in
// UTF-8 bytes of its JSON; the other half of the cap is headroom for conn, cred, pts.
const MAX_PRESENCE = 1024;
const PRESENCE_MS = 200;              // at most 5/s per connection

const ROOM_ID = /^r_[A-Za-z0-9_-]{16}$/;
const CRED_ID = /^c_[A-Za-z0-9_-]{12}$/;
const OWNER = /^[A-Za-z0-9-]{16,128}$/;      // identical to Inboxes: the API's account_generation

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...headers } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

const randomId = (prefix, bytes = 18) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const sha256 = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64encode = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const utf8 = (s) => new TextEncoder().encode(s).length;      // caps count stored bytes, not UTF-16 units
// A Yjs update is valid if a fresh document accepts it. Base64 alone is not enough:
// one malformed update would make every later Y.mergeUpdates throw.
const yjsValid = (u8) => { try { Y.applyUpdate(new Y.Doc(), u8); return true; } catch { return false; } };
// Merge, skipping updates no document could apply; null if merging still fails.
const yjsMerge = (datas) => {
  const all = [];
  for (const d of datas) try { all.push(b64decode(d)); } catch {}
  if (all.length > 1) try { return Y.mergeUpdates(all); } catch {}    // one update merges to itself, unchecked
  try { return Y.mergeUpdates(all.filter(yjsValid)); } catch { return null; }
};
// Export never fails: if even the valid updates will not merge, rebuild the
// state in a document (losing only structs still waiting on missing history).
const yjsExport = (datas) => yjsMerge(datas) ?? (() => {
  const doc = new Y.Doc();
  for (const d of datas) try { Y.applyUpdate(doc, b64decode(d)); } catch {}
  return Y.encodeStateAsUpdate(doc);
})();
const bearer = (req) => (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || null;
const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
const isLabel = (l) => typeof l === "string" && l.length <= 64 && !/[\u0000-\u001f\u007f]/.test(l);
const limited = async (binding, key) => !(await binding.limit({ key })).success;

// ---------------------------------------------------------------------------
// Telemetry: aggregate counts only, closed vocabularies (DESIGN.md, "Telemetry").
// Off unless ROOMS_TELEMETRY_ENABLED is "true" and a writer secret is present.

const CODECS = ["json", "yjs"];
const METRICS = {
  "room.lifecycle": { unit: "1", attrs: { codec: CODECS, outcome: ["created", "expired", "deleted", "retired"] } },
  "room.appends": { unit: "1", attrs: { codec: CODECS, outcome: ["accepted", "frozen", "too_large", "room_full", "scope", "rate_limited"] } },
  "room.append.bytes": { unit: "By", attrs: { codec: CODECS, outcome: ["accepted"] } },
  "room.connections": { unit: "1", attrs: { outcome: ["opened", "auth_failed", "room_busy"] } },
  "room.presence": { unit: "1", attrs: { outcome: ["relayed", "rate_limited", "too_large"] } },
  "room.fanout.frames": { unit: "1", attrs: { kind: ["entry", "presence"] } },
};
const WINDOW = 15 * 60_000;
const METRIC_TTL = DAY;               // unsent windows are dropped after a day, as in Inboxes
const FLUSH_MS = 10_000;
const COLLECTOR = "https://telemetry.bayleaf.dev/v1/metrics";

const telemetryEnabled = (env) => env.ROOMS_TELEMETRY_ENABLED === "true" &&
  typeof env.ROOMS_TELEMETRY_WRITE_SECRET === "string" &&
  env.ROOMS_TELEMETRY_WRITE_SECRET.length >= 24 && !/\s/.test(env.ROOMS_TELEMETRY_WRITE_SECRET);

// Counts in memory, written to metric_windows in one batch. Anything outside the
// vocabulary is dropped, so a typo can never leak a new attribute.
class Counter {
  constructor(env) { this.env = env; this.counts = new Map(); }
  add(name, attrs, n = 1) {
    const spec = METRICS[name];
    if (!spec || !telemetryEnabled(this.env) || !(n > 0)) return false;
    const keys = Object.keys(spec.attrs);
    if (Object.keys(attrs).length !== keys.length || !keys.every((k) => spec.attrs[k].includes(attrs[k]))) return false;
    const key = [Math.floor(Date.now() / WINDOW) * WINDOW, name, JSON.stringify(Object.fromEntries(keys.map((k) => [k, attrs[k]])))].join("\t");
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
    return true;
  }
  async flush() {
    // Never write into a window the cron may already have exported (see exportMetrics).
    const rows = [...this.counts].map(([k, n]) => [...k.split("\t"), n]).filter(([w]) => Number(w) + 2 * WINDOW > Date.now());
    this.counts.clear();
    if (!rows.length) return;
    await this.env.DB.batch(rows.map(([w, name, attrs, n]) => this.env.DB.prepare(
      `INSERT INTO metric_windows (window_start, name, attrs, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (window_start, name, attrs) DO UPDATE SET value = value + excluded.value`).bind(Number(w), name, attrs, n)));
  }
}

// Cron: export completed windows, then delete them. A window is exported only once
// the next one has also ended, so no Durable Object flush (at most 10 s late) can
// add to a window after it was sent. The batch id is derived from the window, so a
// retry after an ambiguous acknowledgement is the same batch to the collector.
async function exportMetrics(env, now = Date.now()) {
  await env.DB.prepare("DELETE FROM metric_windows WHERE window_start <= ?").bind(now - METRIC_TTL).run();
  if (!telemetryEnabled(env)) return;
  const windows = (await env.DB.prepare(`SELECT DISTINCT window_start FROM metric_windows
    WHERE window_start + ? <= ? ORDER BY window_start LIMIT 2`).bind(2 * WINDOW, now).all()).results;
  for (const { window_start: start } of windows) {
    const rows = (await env.DB.prepare("SELECT name, attrs, value FROM metric_windows WHERE window_start = ? ORDER BY name, attrs")
      .bind(start).all()).results;
    const end = start + WINDOW;
    const points = rows.map((r) => ({ name: r.name, kind: "sum", unit: METRICS[r.name].unit, start_at: start,
      observed_at: end, temporality: "delta", monotonic: true, value: r.value, attributes: JSON.parse(r.attrs) }));
    const h = await sha256(`bayleaf-rooms:${start}`);
    const batch_id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    try {
      const r = await fetch(env.ROOMS_TELEMETRY_URL || COLLECTOR, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ROOMS_TELEMETRY_WRITE_SECRET}` },
        body: JSON.stringify({ schema_version: 1, source: "rooms", batch_id, observed_at: end, points }),
      });
      void r.body?.cancel().catch(() => {});
      if (r.status !== 202) break;
      await env.DB.prepare("DELETE FROM metric_windows WHERE window_start = ?").bind(start).run();
    } catch { break; }
  }
}

// ---------------------------------------------------------------------------
// The single destruction path (DESIGN.md, "Lifecycle"). Expiry (alarm), owner
// delete, retirement and the cron backstop all call it. `room` is the Durable
// Object itself when it reaps its own expiry, otherwise a stub.

const stub = (env, roomId) => env.ROOM.get(env.ROOM.idFromName(roomId));

async function destroyRoom(env, roomId, reason, room = stub(env, roomId)) {
  await env.DB.prepare("UPDATE rooms SET state = 'destroying' WHERE room_id = ?").bind(roomId).run();
  await room.teardown(reason);
  await env.DB.prepare("DELETE FROM rooms WHERE room_id = ?").bind(roomId).run();
}

// Cron backstop: rows past expiry whose alarm never fired, or stuck in destroying.
async function sweep(env, now = Date.now()) {
  const rows = (await env.DB.prepare(`SELECT room_id, state, expires_at FROM rooms
    WHERE state = 'destroying' OR expires_at <= ? ORDER BY expires_at LIMIT 20`).bind(now).all()).results;
  for (const r of rows) {
    try { await destroyRoom(env, r.room_id, r.expires_at <= now ? "expired" : "deleted"); } catch {}
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Owner RPC. D1 decides ownership before any Durable Object is touched.

class Invalid extends Error {}
class NotFound extends Error {}
const err = (error, extra = {}) => ({ error, ...extra });

function options(o, keys) {
  if (o === undefined || o === null) return {};
  if (typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => !keys.includes(k))) throw new Invalid();
  return o;
}
function expiry(env, value, fallback) {
  const L = limits(env), now = Date.now();
  const t = value === undefined ? fallback : typeof value === "string" ? Date.parse(value) : NaN;
  if (!(t > now && t <= now + L.MAX_LIFE_DAYS * DAY)) throw new Invalid();
  return t;
}
async function owned(env, owner, roomId) {
  if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) throw new Invalid();
  const row = await env.DB.prepare(`SELECT * FROM rooms WHERE room_id = ? AND owner = ? AND state = 'live'
    AND expires_at > ?`).bind(roomId, owner, Date.now()).first();
  if (!row) throw new NotFound();       // unknown, foreign, expired and destroyed look alike
  return row;
}
const roomView = (row, v) => ({ room_id: row.room_id, label: row.label, codec: row.codec, mode: v?.mode ?? null,
  expires_at: iso(row.expires_at), created_at: iso(row.created_at) });

const rpc = {
  async getLimits(env, owner) {
    const L = limits(env);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE owner = ?").bind(owner).first();
    return { rooms_used: n, max_rooms: L.MAX_ROOMS_PER_OWNER, max_credentials_per_room: L.MAX_CREDENTIALS_PER_ROOM,
      max_entry_bytes: { json: L.MAX_ENTRY_BYTES_JSON, yjs: L.MAX_ENTRY_BYTES_YJS }, max_room_bytes: L.MAX_ROOM_BYTES,
      max_sockets_per_room: L.MAX_SOCKETS_PER_ROOM, max_appends_per_second: L.MAX_APPENDS_PER_SECOND,
      presence: { max_bytes: MAX_PRESENCE, per_second: 1000 / PRESENCE_MS },
      default_life_days: L.DEFAULT_LIFE_DAYS, max_life_days: L.MAX_LIFE_DAYS };
  },

  async createRoom(env, owner, opts) {
    const o = options(opts, ["label", "codec", "expires_at"]);
    const codec = o.codec ?? "json", label = o.label ?? "";
    if (!CODECS.includes(codec) || !isLabel(label)) throw new Invalid();
    const now = Date.now(), expires = expiry(env, o.expires_at, now + limits(env).DEFAULT_LIFE_DAYS * DAY);
    const roomId = randomId("r_", 12);
    // Reserve the row first: the quota check and the fence are one atomic statement.
    const done = await env.DB.prepare(`INSERT INTO rooms (room_id, owner, label, codec, created_at, expires_at, state)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'live' WHERE (SELECT COUNT(*) FROM rooms WHERE owner = ?2) < ?7
        AND NOT EXISTS (SELECT 1 FROM retired_owners WHERE owner = ?2)`)
      .bind(roomId, owner, label, codec, now, expires, limits(env).MAX_ROOMS_PER_OWNER).run();
    if (done.meta.changes !== 1) return err("limit");
    try { await stub(env, roomId).create({ room_id: roomId, label, codec, expires_at: expires }); }
    catch (e) { await env.DB.prepare("DELETE FROM rooms WHERE room_id = ?").bind(roomId).run(); throw e; }
    const c = new Counter(env);
    if (c.add("room.lifecycle", { codec, outcome: "created" })) await c.flush().catch(() => {});
    return roomView({ room_id: roomId, label, codec, created_at: now, expires_at: expires }, { mode: "open" });
  },

  async listRooms(env, owner) {
    const rows = (await env.DB.prepare(`SELECT * FROM rooms WHERE owner = ? AND state = 'live' AND expires_at > ?
      ORDER BY created_at DESC`).bind(owner, Date.now()).all()).results;
    // At most MAX_ROOMS_PER_OWNER objects; one that fails to answer is listed without mode and head.
    const views = await Promise.allSettled(rows.map((r) => stub(env, r.room_id).view()));
    return { rooms: rows.map((r, i) => {
      const v = views[i].status === "fulfilled" ? views[i].value : null;
      return { ...roomView(r, v), ...(v ? { head: v.head } : {}) };
    }) };
  },

  async getRoom(env, owner, roomId) {
    const row = await owned(env, owner, roomId);
    const v = await stub(env, roomId).view(true);
    if (!v) throw new NotFound();
    return { ...roomView(row, v), head: v.head, bytes: v.bytes, sockets: v.sockets, credentials: v.credentials };
  },

  async updateRoom(env, owner, roomId, opts) {
    const o = options(opts, ["label", "expires_at", "mode"]);
    const row = await owned(env, owner, roomId);
    if (o.label !== undefined && !isLabel(o.label)) throw new Invalid();
    if (o.mode !== undefined && !["open", "read_only"].includes(o.mode)) throw new Invalid();
    const expires = o.expires_at === undefined ? row.expires_at : expiry(env, o.expires_at);
    const label = o.label ?? row.label;
    // D1 first: it is the authority on expiry, so a failed object update can only
    // make the alarm fire early, and the alarm re-reads D1 before destroying.
    await env.DB.prepare("UPDATE rooms SET label = ?, expires_at = ? WHERE room_id = ?").bind(label, expires, roomId).run();
    const v = await stub(env, roomId).update({ label, expires_at: expires, mode: o.mode });
    return roomView({ ...row, label, expires_at: expires }, v);
  },

  async deleteRoom(env, owner, roomId) {
    await owned(env, owner, roomId);
    await destroyRoom(env, roomId, "deleted");
    return { deleted: true };
  },

  async issueCredentials(env, owner, roomId, opts) {
    const o = options(opts, ["scopes", "role", "label", "labels", "expires_at"]);
    await owned(env, owner, roomId);
    return stub(env, roomId).issue(o, limits(env).MAX_CREDENTIALS_PER_ROOM);
  },

  async listCredentials(env, owner, roomId) {
    await owned(env, owner, roomId);
    return { credentials: await stub(env, roomId).credentials() };
  },

  async revokeCredential(env, owner, roomId, credentialId) {
    await owned(env, owner, roomId);
    if (typeof credentialId !== "string" || !CRED_ID.test(credentialId)) throw new Invalid();
    return (await stub(env, roomId).revoke(credentialId)) ? { credential_id: credentialId, revoked: true } : err("not_found");
  },

  async exportRoom(env, owner, roomId, opts) {
    const o = options(opts, ["format"]);
    const row = await owned(env, owner, roomId);
    const format = o.format ?? "jsonl";
    if (!(format === "jsonl" || (format === "yjs" && row.codec === "yjs"))) throw new Invalid();
    return stub(env, roomId).exportRoom(format);
  },

  // Fence first, so nothing new can be created; then the single destroy path per room.
  async retireOwner(env, owner) {
    await env.DB.prepare("INSERT OR IGNORE INTO retired_owners (owner, retired_at) VALUES (?, ?)").bind(owner, Date.now()).run();
    const rows = (await env.DB.prepare("SELECT room_id FROM rooms WHERE owner = ?").bind(owner).all()).results;
    for (const r of rows) await destroyRoom(env, r.room_id, "retired");
    return { retired: true, rooms: rows.length };
  },
};

// Every method: kill switch, owner shape, retired fence, then the operation.
// Never throws to the caller.
async function call(env, name, owner, args) {
  if (!enabled(env) && name !== "retireOwner") return err("disabled");
  if (typeof owner !== "string" || !OWNER.test(owner)) return err("invalid");
  try {
    if (name !== "retireOwner" && await env.DB.prepare("SELECT 1 FROM retired_owners WHERE owner = ?").bind(owner).first())
      return err("not_found");
    return await rpc[name](env, owner, ...args);
  } catch (e) {
    return err(e instanceof Invalid ? "invalid" : e instanceof NotFound ? "not_found" : "unavailable");
  }
}

export class RoomManagement extends WorkerEntrypoint {
  getLimits(owner) { return call(this.env, "getLimits", owner, []); }
  createRoom(owner, opts) { return call(this.env, "createRoom", owner, [opts]); }
  listRooms(owner) { return call(this.env, "listRooms", owner, []); }
  getRoom(owner, roomId) { return call(this.env, "getRoom", owner, [roomId]); }
  updateRoom(owner, roomId, opts) { return call(this.env, "updateRoom", owner, [roomId, opts]); }
  deleteRoom(owner, roomId) { return call(this.env, "deleteRoom", owner, [roomId]); }
  issueCredentials(owner, roomId, opts) { return call(this.env, "issueCredentials", owner, [roomId, opts]); }
  listCredentials(owner, roomId) { return call(this.env, "listCredentials", owner, [roomId]); }
  revokeCredential(owner, roomId, credentialId) { return call(this.env, "revokeCredential", owner, [roomId, credentialId]); }
  exportRoom(owner, roomId, opts) { return call(this.env, "exportRoom", owner, [roomId, opts]); }
  retireOwner(owner) { return call(this.env, "retireOwner", owner, []); }
}

// ---------------------------------------------------------------------------
// Dev-only owner shim: HTTP onto the same call() as the RPC entrypoint, so local
// tests exercise the real owner path. Absent unless DEV_OWNER_TOKEN is set, which
// production never does. The owner comes from X-Dev-Owner so tests can be several.

const SHIM_STATUS = { invalid: 400, not_found: 404, disabled: 503, limit: 403, credential_limit: 413, label_taken: 409, unavailable: 503 };

async function devOwner(req, env, parts) {
  if (bearer(req) !== env.DEV_OWNER_TOKEN) return fail(401, "owner_auth");
  const owner = req.headers.get("X-Dev-Owner") ?? "dev-owner-0000000000";
  const body = ["POST", "PATCH"].includes(req.method) ? await req.json().catch(() => ({})) : undefined;
  const [, what, id, sub, cid] = parts, m = req.method;
  const route =
    what === "retire" && m === "POST" ? ["retireOwner", []] :
    what !== "rooms" ? null :
    id === "limits" && m === "GET" ? ["getLimits", []] :
    !id && m === "GET" ? ["listRooms", []] :
    !id && m === "POST" ? ["createRoom", [body]] :
    !sub && m === "GET" ? ["getRoom", [id]] :
    !sub && m === "PATCH" ? ["updateRoom", [id, body]] :
    !sub && m === "DELETE" ? ["deleteRoom", [id]] :
    sub === "credentials" && !cid && m === "POST" ? ["issueCredentials", [id, body]] :
    sub === "credentials" && !cid && m === "GET" ? ["listCredentials", [id]] :
    sub === "credentials" && cid && m === "DELETE" ? ["revokeCredential", [id, cid]] :
    sub === "export" && m === "GET" ? ["exportRoom", [id, { format: new URL(req.url).searchParams.get("format") ?? undefined }]] :
    null;
  if (!route) return fail(404, "not_found");
  const r = await call(env, route[0], owner, route[1]);
  if (r.error) return json(r, SHIM_STATUS[r.error] ?? 500);
  if (route[0] === "exportRoom") return new Response(r.body, { headers: { "Content-Type": r.content_type } });
  return json(r, ["createRoom", "issueCredentials"].includes(route[0]) ? 201 : 200);
}

// ---------------------------------------------------------------------------
// Worker: routing only. Every room-scoped request goes to that room's object.

const POINTER = `BayLeaf Rooms: durable shared state for apps you build (bayleaf-rooms.dev).

Participants reach a room at https://bayleaf-rooms.dev/{room_id} with a room credential.
Owners create rooms through the BayLeaf API: https://api.bayleaf.dev/rooms
Docs: https://api.bayleaf.dev/docs/rooms.md
Yjs provider: https://bayleaf-rooms.dev/client/y-bayleaf@1.js

Rooms store participant content; BayLeaf operators can technically read it.
`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const read = req.method === "GET" || req.method === "HEAD";

    if (parts.length === 0 && read)
      return new Response(req.method === "HEAD" ? null : POINTER, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    if (parts[0] === "client" && parts.length === 2 && ["y-bayleaf.js", "y-bayleaf@1.js"].includes(parts[1]) && read)
      return new Response(req.method === "HEAD" ? null : PROVIDER, { headers: { "Content-Type": "text/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
    if (parts[0] === "owner" && env.DEV_OWNER_TOKEN) return devOwner(req, env, parts);

    if (!ROOM_ID.test(parts[0] ?? "")) return fail(404, "not_found");
    // Kill switch and rate-limit bindings fail closed for the whole participant plane.
    if (!enabled(env) || !env.ACCEPT_LIMIT || !env.REJECT_LIMIT) return fail(503, "unavailable");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    return stub(env, parts[0]).fetch(req);
  },

  // Awaited, so a local trigger returns only after the sweep and export are done.
  async scheduled(controller, env) {
    try { await sweep(env); }
    finally { await exportMetrics(env).catch(() => {}); }
  },
};

// ---------------------------------------------------------------------------
// Room Durable Object. SQLite holds everything that must survive hibernation,
// including tickets; sockets carry their credential in a serialized attachment.
// Owner operations are RPC methods, reachable only through this Worker's binding;
// fetch() serves the participant plane alone.

// Scopes, not ranked roles (DECISIONS.md item 14). Every credential reads the log
// and receives presence; scopes add independent powers. Roles are shorthands.
const SCOPES = ["presence", "append", "manage"];
const ROLES = { read: [], write: ["presence", "append"], manage: SCOPES };

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.L = limits(env);
    this.metrics = new Counter(env);
    this.flushAt = null;
    this.schema();
  }

  // Re-run after deleteAll(): a destroyed room's object instance may live on.
  schema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS creds (id TEXT PRIMARY KEY, label TEXT UNIQUE, scopes TEXT,
        hash TEXT UNIQUE, expires_at INTEGER, revoked INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, ts INTEGER, cred TEXT,
        data TEXT, chunks INTEGER DEFAULT 0, redacted INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chunks (seq INTEGER, idx INTEGER, part TEXT, PRIMARY KEY (seq, idx));
      CREATE TABLE IF NOT EXISTS idem (cred_id TEXT, key TEXT, seq INTEGER, ts INTEGER, PRIMARY KEY (cred_id, key));
      CREATE INDEX IF NOT EXISTS idem_ts ON idem (ts);
      CREATE TABLE IF NOT EXISTS tickets (ticket TEXT PRIMARY KEY, cred_id TEXT, after INTEGER, exp INTEGER);
    `);
  }

  meta(k) { return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null; }
  setMeta(k, v) { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, String(v)); }
  get head() { return Number(this.meta("head") ?? 0); }
  get bytes() { return Number(this.meta("bytes") ?? 0); }
  get codec() { return this.meta("codec") ?? "json"; }
  get mode() { return this.meta("mode") ?? "open"; }
  get expiresAt() { return Number(this.meta("expires_at")); }
  get exists() { return this.meta("room_id") !== null; }
  get maxEntry() { return this.codec === "yjs" ? this.L.MAX_ENTRY_BYTES_YJS : this.L.MAX_ENTRY_BYTES_JSON; }

  // --- Owner RPC (called by the Worker after it checked ownership in D1) ----

  async create({ room_id, label, codec, expires_at }) {
    if (this.exists) throw new Error("exists");
    this.destroying = false;
    this.setMeta("room_id", room_id);
    this.setMeta("label", label);
    this.setMeta("codec", codec);
    this.setMeta("mode", "open");
    this.setMeta("expires_at", expires_at);
    this.setMeta("head", 0);
    this.setMeta("bytes", 0);
    await this.schedule();
  }

  view(full) {
    if (!this.exists) return null;
    const v = { mode: this.mode, head: this.head };
    return full ? { ...v, bytes: this.bytes, sockets: this.ctx.getWebSockets().length, credentials: this.credentials() } : v;
  }

  async update({ label, expires_at, mode }) {
    this.setMeta("label", label);
    if (mode !== undefined && mode !== this.mode) {
      this.setMeta("mode", mode);
      this.broadcast({ type: "mode", mode });
    }
    this.setMeta("expires_at", expires_at);
    await this.schedule();
    return this.view();
  }

  async issue(body, max) {
    const labels = body.labels ?? [body.label];
    const scopes = body.scopes ?? ROLES[body.role ?? (body.scopes ? undefined : "read")];
    if (!Array.isArray(scopes) || !scopes.every((s) => SCOPES.includes(s)) || (body.scopes && body.role) ||
        (body.labels && body.label !== undefined) || !Array.isArray(labels) || !labels.length ||
        !labels.every((l) => typeof l === "string" && l.length > 0 && isLabel(l)))
      return { error: "invalid" };
    const exp = body.expires_at === undefined ? null : Date.parse(body.expires_at);
    if (exp !== null && !(exp > Date.now())) return { error: "invalid" };
    // Hash first: no await may separate the checks from the inserts, or concurrent
    // issues interleave past the cap or leave a partial batch.
    const made = await Promise.all(labels.map(async (label) => {
      const secret = randomId("rk_", 24);
      return { label, id: randomId("c_", 9), secret, hash: await sha256(secret) };
    }));
    if (!this.exists || this.destroying) return { error: "not_found" };
    const count = this.sql.exec("SELECT COUNT(*) AS n FROM creds").one().n;
    if (count + labels.length > max) return { error: "credential_limit", max };
    // All or nothing: check every label (and duplicates within the request) first.
    const seen = new Set();
    for (const label of labels) {
      if (seen.has(label) || this.sql.exec("SELECT 1 FROM creds WHERE label = ?", label).toArray().length)
        return { error: "label_taken", label };
      seen.add(label);
    }
    const set = SCOPES.filter((s) => scopes.includes(s));      // canonical order, no duplicates
    this.ctx.storage.transactionSync(() => {
      for (const c of made) this.sql.exec("INSERT INTO creds (id, label, scopes, hash, expires_at) VALUES (?, ?, ?, ?, ?)",
        c.id, c.label, set.join(","), c.hash, exp);
    });
    return { credentials: made.map(({ id, label, secret }) => ({ credential_id: id, label, scopes: set, secret,
      link_fragment: `room=${this.meta("room_id")}&key=${secret}`, expires_at: iso(exp) })) };
  }

  credentials() {
    return this.sql.exec("SELECT id AS credential_id, label, scopes, expires_at, revoked FROM creds").toArray()
      .map((c) => ({ ...c, scopes: c.scopes ? c.scopes.split(",") : [], expires_at: iso(c.expires_at), revoked: !!c.revoked }));
  }

  revoke(id) {
    const n = this.sql.exec("UPDATE creds SET revoked = 1 WHERE id = ?", id).rowsWritten;
    for (const ws of this.ctx.getWebSockets(id)) this.end(ws, "revoked");
    return n > 0;
  }

  exportRoom(format) {
    const all = this.read(0, 1_000_000);
    if (format === "yjs") return { content_type: "application/octet-stream", body: yjsExport(all.map((e) => e.data)) };
    return { content_type: "application/x-ndjson", body: all.map((e) => JSON.stringify(e)).join("\n") + "\n" };
  }

  // Called only through destroyRoom(), after the D1 row is marked destroying.
  async teardown(reason) {
    this.destroying = true;               // handlers resuming from an await must not write (see current)
    if (this.exists) {
      this.count("room.lifecycle", { codec: this.codec, outcome: reason });
      for (const ws of this.ctx.getWebSockets()) this.end(ws, reason === "retired" ? "deleted" : reason);
    }
    await this.metrics.flush().catch(() => {});
    this.flushAt = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.schema();
  }

  // --- One alarm, three jobs: expiry, the telemetry flush, ending sockets
  // whose credential expires while they are silent ---------------------------

  async schedule() {
    const at = Math.min(this.exists ? this.expiresAt : Infinity, this.flushAt ?? Infinity, this.nextCredExpiry());
    if (at === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  count(name, attrs, n) {
    if (this.metrics.add(name, attrs, n) && !this.flushAt) {
      this.flushAt = Date.now() + FLUSH_MS;
      this.schedule();
    }
  }

  // Earliest expiry among live credentials that hold a socket.
  nextCredExpiry() {
    if (!this.exists) return Infinity;
    for (const { id, expires_at } of this.sql.exec(`SELECT id, expires_at FROM creds
        WHERE revoked = 0 AND expires_at > ? ORDER BY expires_at`, Date.now()))
      if (this.ctx.getWebSockets(id).length) return expires_at;
    return Infinity;
  }

  async alarm() {
    this.flushAt = null;
    await this.metrics.flush().catch(() => {});
    if (this.exists && Date.now() >= this.expiresAt) return this.expire();
    this.endStale(this.ctx.getWebSockets());
    await this.schedule();
  }

  // D1 is the authority on expiry: if the owner extended the room and this
  // object missed the update, adopt the new time instead of destroying.
  async expire() {
    const id = this.meta("room_id");
    const row = await this.env.DB.prepare("SELECT expires_at, state FROM rooms WHERE room_id = ?").bind(id).first();
    if (row?.state === "live" && row.expires_at > Date.now()) {
      this.setMeta("expires_at", row.expires_at);
      return this.schedule();
    }
    await destroyRoom(this.env, id, "expired", this);
  }

  // --- Participant plane ----------------------------------------------------

  async fetch(req) {
    const url = new URL(req.url);
    const path = "/" + url.pathname.split("/").filter(Boolean).slice(1).join("/");
    if (!this.exists) return fail(404, "not_found");
    if (Date.now() >= this.expiresAt) {
      try { await this.expire(); } catch {}
      if (!this.exists || Date.now() >= this.expiresAt) return fail(404, "not_found");
    }
    if (path === "/live") return this.live(req, url);

    let cred = await this.authenticate(req);
    if (!cred) return this.reject("credential");
    if (await limited(this.env.ACCEPT_LIMIT, this.meta("room_id"))) return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
    if (!(cred = this.current(cred.id))) return this.stale();
    const need = (scope) => cred.scopes.includes(scope);

    if (path === "/" && req.method === "GET")
      return json({ scopes: cred.scopes, cred_label: cred.label, room_label: this.meta("label"), codec: this.codec,
        mode: this.mode, head: this.head, expires_at: iso(this.expiresAt),
        limits: { max_entry_bytes: this.maxEntry, max_room_bytes: this.L.MAX_ROOM_BYTES,
          max_appends_per_second: this.L.MAX_APPENDS_PER_SECOND, ticket_seconds: TICKET_MS / 1000 } });

    if (path === "/log" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 1000);
      return json({ entries: this.read(after, limit), head: this.head });
    }

    if (path === "/log" && req.method === "POST") {
      if (!need("append")) { this.countAppend("scope"); return fail(403, "scope", { need: "append" }); }
      const idem = req.headers.get("Idempotency-Key");
      if (!idem) return fail(400, "idempotency_key_required");
      const body = await req.json().catch(() => null);
      if (!body || !("data" in body)) return fail(400, "data_required");
      if (!(cred = this.current(cred.id))) return this.stale();
      const r = this.append(cred, idem, body.data);
      if (r.retry_after) return json({ error: r.error, retry_after: r.retry_after }, r.status, { "Retry-After": String(Math.ceil(r.retry_after)) });
      return r.error ? fail(r.status, r.error) : json({ seq: r.seq, ts: iso(r.ts) });
    }

    if (path === "/tickets" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!(cred = this.current(cred.id))) return this.stale();
      const ticket = randomId("t_");
      this.sql.exec("DELETE FROM tickets WHERE exp < ?", Date.now());
      this.sql.exec("INSERT INTO tickets VALUES (?, ?, ?, ?)", ticket, cred.id, Number(body.after ?? 0), Date.now() + TICKET_MS);
      return json({ url: `${url.origin.replace(/^http/, "ws")}/${this.meta("room_id")}/live?ticket=${ticket}` });
    }

    if (path === "/export" && req.method === "GET") {
      const format = this.codec === "yjs" && url.searchParams.get("format") === "yjs" ? "yjs" : "jsonl";
      const { content_type, body } = this.exportRoom(format);
      return new Response(body, { headers: { "Content-Type": content_type, ...CORS } });
    }

    if (path === "/redact" && req.method === "POST") {
      if (!need("manage")) return fail(403, "scope", { need: "manage" });
      if (this.codec === "yjs") return fail(409, "redact_unavailable_for_codec");
      const { seq } = await req.json().catch(() => ({}));
      if (!(cred = this.current(cred.id))) return this.stale();
      const row = this.sql.exec("SELECT data FROM entries WHERE seq = ?", seq).toArray()[0];
      if (!row) return fail(404, "no_such_entry");
      this.sql.exec("UPDATE entries SET data = 'null', redacted = 1 WHERE seq = ?", seq);
      this.setMeta("bytes", Math.max(0, this.bytes - utf8(row.data ?? "") + 4));
      this.broadcast({ type: "entry", entry: this.read(seq - 1, 1)[0] });
      return json({ seq, redacted: true });
    }

    return fail(404, "not_found");
  }

  // Failed rk_ or ticket authentication spends a separate bucket, keyed by room,
  // so a leaked URL cannot drain the budget of legitimate participants.
  async reject(error) {
    if (await limited(this.env.REJECT_LIMIT, this.meta("room_id"))) return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
    return fail(401, error);
  }

  async authenticate(req) {
    const secret = bearer(req);
    if (!secret?.startsWith("rk_")) return null;
    return this.credByHash(await sha256(secret));
  }
  credByHash(hash) { return this.validCred(this.sql.exec("SELECT * FROM creds WHERE hash = ?", hash).toArray()[0]); }
  credById(id) { return this.validCred(this.sql.exec("SELECT * FROM creds WHERE id = ?", id).toArray()[0]); }
  validCred(c) {
    if (!c || c.revoked || (c.expires_at && c.expires_at <= Date.now())) return null;
    return { ...c, scopes: c.scopes ? c.scopes.split(",") : [] };
  }
  // Why a credential's sockets must end: "revoked", "expired", or null if still valid.
  credEnd(id) {
    const c = this.sql.exec("SELECT revoked, expires_at FROM creds WHERE id = ?", id ?? "").toArray()[0];
    return !c || c.revoked ? "revoked" : c.expires_at && c.expires_at <= Date.now() ? "expired" : null;
  }

  // Revalidate before mutate. Every await in a handler is a window in which the
  // room can be torn down or expire and the credential be revoked or expire, so
  // a handler calls this after its last await and writes only if it gets a cred.
  current(id) {
    if (!this.exists || this.destroying || Date.now() >= this.expiresAt) return null;
    return this.credById(id);
  }
  stale() {
    return this.exists && !this.destroying && Date.now() < this.expiresAt ? fail(401, "credential") : fail(404, "not_found");
  }

  // --- The log ------------------------------------------------------------

  countAppend(outcome, bytes) {
    this.count("room.appends", { codec: this.codec, outcome });
    if (bytes) this.count("room.append.bytes", { codec: this.codec, outcome }, bytes);
  }

  // In-memory token bucket per room: MAX_APPENDS_PER_SECOND, refilled continuously.
  // Lost on hibernation, which only ever refills it.
  takeToken() {
    const rate = this.L.MAX_APPENDS_PER_SECOND, now = Date.now();
    this.tokens = Math.min(rate, (this.tokens ?? rate) + ((now - (this.tokenAt ?? now)) * rate) / 1000);
    this.tokenAt = now;
    if (this.tokens < 1) return Math.max(0.01, Math.ceil(((1 - this.tokens) / rate) * 100) / 100);
    this.tokens -= 1;
    return 0;
  }

  append(cred, idem, data) {
    const prior = this.sql.exec("SELECT seq, ts FROM idem WHERE cred_id = ? AND key = ?", cred.id, idem).toArray()[0];
    if (prior) return { ...prior, duplicate: true };
    if (this.mode === "read_only") { this.countAppend("frozen"); return { status: 409, error: "read_only" }; }
    const yjs = this.codec === "yjs";
    let text, bytes;
    if (yjs) {
      if (typeof data !== "string") return { status: 400, error: "yjs_data_must_be_base64" };
      try { bytes = b64decode(data); } catch { return { status: 400, error: "yjs_data_must_be_base64" }; }
      text = data;
    } else text = JSON.stringify(data) ?? "null";
    const size = yjs ? text.length : utf8(text);         // base64 is ASCII
    if (size > this.maxEntry) { this.countAppend("too_large"); return { status: 413, error: "entry_too_large" }; }
    const wait = this.takeToken();
    if (wait) { this.countAppend("rate_limited"); return { status: 429, error: "rate_limited", retry_after: wait }; }
    // After the token, so a flood of invalid updates is paced like any other.
    if (yjs && !yjsValid(bytes)) return { status: 400, error: "yjs_update_invalid" };
    // Yjs rooms count post-compaction size, so compact before refusing, unless
    // the log is already one merged entry.
    if (this.bytes + size > this.L.MAX_ROOM_BYTES && yjs &&
        this.sql.exec("SELECT COUNT(*) AS n FROM entries").one().n > 1) this.compact();
    if (this.bytes + size > this.L.MAX_ROOM_BYTES) { this.countAppend("room_full"); return { status: 507, error: "room_full" }; }
    const seq = this.head + 1, ts = Date.now();
    // Commons decision: yjs entries carry no cred (rooms/DECISIONS.md, item 4).
    this.sql.exec("INSERT INTO entries (seq, ts, cred, data) VALUES (?, ?, ?, ?)",
      seq, ts, yjs ? null : cred.label, text);
    this.sql.exec("DELETE FROM idem WHERE ts < ?", ts - IDEM_MS);
    this.sql.exec("INSERT INTO idem VALUES (?, ?, ?, ?)", cred.id, idem, seq, ts);
    this.setMeta("head", seq);
    this.setMeta("bytes", this.bytes + size);
    this.countAppend("accepted", size);
    this.broadcast({ type: "entry", entry: this.format({ seq, ts, cred: cred.label, data: text }) });
    if (yjs && this.sql.exec("SELECT COUNT(*) AS n FROM entries").one().n >= this.L.COMPACT_ENTRIES) this.compact();
    return { seq, ts };
  }

  read(after, limit) {
    return this.sql.exec("SELECT * FROM entries WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)
      .toArray().map((row) => this.format(row));
  }

  format(row) {
    const data = row.chunks
      ? this.sql.exec("SELECT part FROM chunks WHERE seq = ? ORDER BY idx", row.seq).toArray().map((r) => r.part).join("")
      : row.data;
    // Timestamps are ms in storage, ISO 8601 at every boundary.
    if (this.codec === "yjs") return { seq: row.seq, ts: iso(row.ts), data };
    return { seq: row.seq, ts: iso(row.ts), cred: row.cred, data: JSON.parse(data), ...(row.redacted ? { redacted: true } : {}) };
  }

  // Merge every update into one. Yjs updates are idempotent, so a client that
  // already holds part of the merged state can apply it again harmlessly. An
  // entry no document could apply is skipped (it was never an update), and a
  // merge that still fails leaves the log as it is: never wedge the room.
  compact() {
    const head = this.head;
    const u8 = yjsMerge(this.read(0, 1_000_000).map((e) => e.data));
    if (!u8) return;
    const merged = b64encode(u8);
    const ts = Date.now();
    this.sql.exec("DELETE FROM entries");
    this.sql.exec("DELETE FROM chunks");
    if (merged.length <= CHUNK) {
      this.sql.exec("INSERT INTO entries (seq, ts, cred, data) VALUES (?, ?, NULL, ?)", head, ts, merged);
    } else {
      const parts = Math.ceil(merged.length / CHUNK);
      for (let i = 0; i < parts; i++)
        this.sql.exec("INSERT INTO chunks VALUES (?, ?, ?)", head, i, merged.slice(i * CHUNK, (i + 1) * CHUNK));
      this.sql.exec("INSERT INTO entries (seq, ts, cred, data, chunks) VALUES (?, ?, NULL, NULL, ?)", head, ts, parts);
    }
    this.setMeta("bytes", merged.length);
  }

  // --- Live WebSocket (hibernation API) ----------------------------------

  async live(req, url) {
    if (req.headers.get("Upgrade") !== "websocket") return fail(426, "websocket_required");
    const ticket = url.searchParams.get("ticket");
    const t = this.sql.exec("SELECT * FROM tickets WHERE ticket = ?", ticket).toArray()[0];
    this.sql.exec("DELETE FROM tickets WHERE ticket = ?", ticket);       // single use
    const cred = t && t.exp >= Date.now() ? this.credById(t.cred_id) : null;
    if (!cred) { this.count("room.connections", { outcome: "auth_failed" }); return this.reject(t ? "credential" : "ticket"); }
    if (this.ctx.getWebSockets().length >= this.L.MAX_SOCKETS_PER_ROOM) {
      this.count("room.connections", { outcome: "room_busy" });
      return json({ error: "room_busy", retry_after: 5 }, 429, { "Retry-After": "5" });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peers = this.peers();                         // snapshot before this socket joins
    const conn = randomId("k_", 6);
    this.ctx.acceptWebSocket(server, [cred.id]);
    server.serializeAttachment({ cred_id: cred.id, cred: cred.label, conn, state: null, pts: 0 });
    let sent = 0;
    for (let after = t.after; ; ) {
      const page = this.read(after, 500);
      for (const entry of page) server.send(JSON.stringify({ type: "entry", entry }));
      sent += page.length;
      if (page.length < 500) break;
      after = page[page.length - 1].seq;
    }
    if (sent) this.count("room.fanout.frames", { kind: "entry" }, sent);
    this.count("room.connections", { outcome: "opened" });
    server.send(JSON.stringify({ type: "ready", head: this.head, mode: this.mode, conn, peers }));
    this.broadcast({ type: "presence", peer: { conn, cred: cred.label, state: null } }, server);
    if (cred.expires_at) await this.schedule();         // end it even if it never speaks again
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    const cred = this.current(a.cred_id);
    if (!cred) return this.end(ws, this.credEnd(a.cred_id) ?? "expired");
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.send(JSON.stringify({ type: "error", status: 400, error: "json" })); }
    const scope = { append: "append", presence: "presence" }[msg.type];
    if (scope && !cred.scopes.includes(scope)) {
      if (scope === "append") this.countAppend("scope");
      return ws.send(JSON.stringify({ type: "error", idem: msg.idem, status: 403, error: "scope", need: scope }));
    }
    if (msg.type === "append") {
      if (!msg.idem) return ws.send(JSON.stringify({ type: "error", status: 400, error: "idem_required" }));
      const r = this.append(cred, msg.idem, msg.data);
      ws.send(JSON.stringify(r.error ? { type: "error", idem: msg.idem, status: r.status, error: r.error,
        ...(r.retry_after ? { retry_after: r.retry_after } : {}) } : { type: "ack", idem: msg.idem, seq: r.seq }));
    } else if (msg.type === "presence") {
      // Delta fan-out: one frame per change, to the others only. Never stored.
      const state = msg.state ?? null, now = Date.now();
      const tooLarge = () => {
        this.count("room.presence", { outcome: "too_large" });
        return ws.send(JSON.stringify({ type: "error", status: 413, error: "presence_too_large" }));
      };
      if (utf8(JSON.stringify(state)) > MAX_PRESENCE) return tooLarge();
      if (now - a.pts < PRESENCE_MS) {
        this.count("room.presence", { outcome: "rate_limited" });
        return ws.send(JSON.stringify({ type: "error", status: 429, error: "presence_rate", retry_after: PRESENCE_MS / 1000 }));
      }
      try { ws.serializeAttachment({ ...a, state, pts: now }); } catch { return tooLarge(); }
      this.count("room.presence", { outcome: "relayed" });
      this.broadcast({ type: "presence", peer: { conn: a.conn, cred: a.cred, state } }, ws);
    }
  }

  // Complete the close handshake, or the client lingers in CLOSING (~10 s locally)
  // with its outbox stuck. Found by the abrupt-disconnect check.
  webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
    this.left(ws);
  }
  webSocketError(ws) { this.left(ws); }

  left(ws) {
    const conn = ws.deserializeAttachment()?.conn;
    if (conn) this.broadcast({ type: "left", conn }, ws);
  }

  peers() {
    return this.ctx.getWebSockets().map((w) => {
      const { conn, cred, state } = w.deserializeAttachment() ?? {};
      return { conn, cred, state };
    });
  }

  // A credential can expire while its socket stays silent, so every broadcast
  // ends sockets whose credential is no longer valid instead of sending to them.
  broadcast(frame, except) {
    const s = JSON.stringify(frame);
    let n = 0;
    for (const ws of this.endStale(this.ctx.getWebSockets())) if (ws !== except) { try { ws.send(s); n++; } catch {} }
    const kind = frame.type === "entry" ? "entry" : frame.type === "presence" || frame.type === "left" ? "presence" : null;
    if (kind && n) this.count("room.fanout.frames", { kind }, n);
  }

  // Ends sockets whose credential was revoked or has expired; returns the rest.
  // One lookup per credential, not per socket.
  endStale(sockets) {
    const why = new Map();
    return sockets.filter((ws) => {
      const id = ws.deserializeAttachment()?.cred_id;
      if (!why.has(id)) why.set(id, this.credEnd(id));
      if (why.get(id)) this.end(ws, why.get(id));
      return !why.get(id);
    });
  }

  end(ws, reason) {
    try { ws.send(JSON.stringify({ type: "end", reason })); ws.close(1000, reason); } catch {}
  }
}
