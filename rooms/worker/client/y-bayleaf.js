// y-bayleaf: connect a Y.Doc to a BayLeaf yjs room (issue #159).
//
//   import * as Y from "yjs";
//   const provider = new BayLeafRoomProvider(Y, ydoc, { base, link: location.hash });
//
// You pass your own Y module, so the page never loads two copies of Yjs.
// The provider imports nothing.
// Unacknowledged updates stay in an outbox and are resent with the same
// idempotency key after reconnecting, so a lost ack never duplicates or drops
// an edit. Spike gap: no IndexedDB persistence across reloads.
//
// Presence: pass y-protocols' awareness module as `awarenessProtocol` to get
// `provider.awareness` for editor carets; the room relays its updates as opaque
// base64 and never decodes them. Without it, `setPresence(json)` and the
// "presence" event carry plain state. Either way at most 5 sends/s, trailing.
//
// Never drop an update from the outbox. Yjs needs each client's clock range to be
// contiguous: peers park every later update from a client with a gap in
// pendingStructs, forever and silently. So refusals split two ways:
//   409 read_only  the room is frozen: keep the outbox, stop sending, report
//                  "read_only" (lock the editor); resend in order on unfreeze.
//   429            the room is busy: wait retry_after, then resend the outbox in order.
//   413, 403, 507  this edit can never sync (too large, no append scope, room full):
//                  report "diverged" and stop sending.
//                  The app reloads from the room; the local edit is lost.

const enc = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const PRESENCE_MS = 250;              // the room allows one presence frame per 200 ms

export class BayLeafRoomProvider {
  constructor(Y, ydoc, { base = "https://bayleaf-rooms.dev", link, room, key, storage = globalThis.localStorage,
    batchMs = 250, awarenessProtocol, storageKey } = {}) {
    if (link) {
      const f = new URLSearchParams(String(link).replace(/^.*#/, ""));
      room = f.get("room") ?? room; key = f.get("key") ?? key;
      if (room && key && globalThis.history && globalThis.location?.hash) history.replaceState(null, "", location.pathname + location.search);
    }
    // One stored key per storageKey. A page holding two links to the same room
    // (projector and student, say) must name them apart, or one overwrites the other.
    storageKey ??= `bayleaf-room:${room}`;
    if (storage && room && key) storage.setItem(storageKey, key);
    if (storage && room && !key) key = storage.getItem(storageKey);
    if (!room || !key) throw new Error("BayLeafRoomProvider needs a link (#room=...&key=...) or room and key");
    Object.assign(this, { Y, ydoc, base, room, key, storage, storageKey, batchMs });
    this.lastSeq = 0; this.outbox = new Map(); this.buffer = []; this.listeners = {};
    this.status = "connecting"; this.synced = false; this.backoff = 500; this.ended = false;

    // Leading-edge batching: a lone keystroke goes out at once; edits arriving
    // within batchMs of a send wait and go out together.
    this.onUpdate = (update, origin) => {
      if (origin === this) return;
      this.buffer.push(update);
      if (this.timer) return;
      this.flush();
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.batchMs);
    };
    ydoc.on("update", this.onUpdate);

    this.peers = new Map();                       // conn → {cred, state}, everyone but us
    this.pts = 0;
    if (awarenessProtocol) {
      this.ap = awarenessProtocol;
      this.awareness = new awarenessProtocol.Awareness(ydoc);
      this.connClients = new Map();               // conn → awareness clientIDs it announced, for "left"
      this.onAwareness = ({ added, updated, removed }, origin) => {
        if (origin !== this && [...added, ...updated, ...removed].includes(ydoc.clientID)) this.queuePresence();
      };
      this.awareness.on("update", this.onAwareness);
    }
    this.connect();
  }

  on(event, fn) { (this.listeners[event] ??= []).push(fn); return this; }
  emit(event, arg) { for (const fn of this.listeners[event] ?? []) fn(arg); }
  setStatus(status) {
    if (this.diverged && status !== "ended") return;      // only a reload leaves "diverged"
    this.status = status; this.emit("status", { status });
  }

  async connect() {
    if (this.ended) return;
    try {
      const auth = { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" };
      if (!this.whoami) {
        const r = await fetch(`${this.base}/${this.room}`, { headers: auth });
        if (r.status === 401 || r.status === 404) return this.finish(r.status === 401 ? "revoked" : "deleted");
        this.whoami = await r.json();
      }
      const t = await fetch(`${this.base}/${this.room}/tickets`, { method: "POST", headers: auth, body: JSON.stringify({ after: this.lastSeq }) });
      if (t.status === 401 || t.status === 404) return this.finish(t.status === 401 ? "revoked" : "deleted");
      const { url } = await t.json();
      const ws = this.ws = new WebSocket(url);
      ws.onmessage = (m) => this.frame(JSON.parse(m.data));
      ws.onclose = () => { this.ws = null; if (!this.ended) { this.setStatus("connecting"); this.retry(); } };
    } catch { this.retry(); }
  }

  retry() { setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 2, 30_000); }

  frame(f) {
    if (f.type === "entry") {
      if (f.entry.seq <= this.lastSeq) return;
      this.lastSeq = f.entry.seq;
      this.Y.applyUpdate(this.ydoc, dec(f.entry.data), this);   // own echoes are idempotent no-ops
    } else if (f.type === "ready") {
      this.backoff = 500;
      this.setStatus(f.mode === "read_only" ? "read_only" : "connected");
      if (!this.synced) { this.synced = true; this.emit("synced"); }
      this.resend();
      // Reconcile, don't wipe: Awareness ignores a re-sent state at a clock it has
      // already seen, so removing then re-applying a live peer would lose it.
      this.conn = f.conn;
      const now = new Set(f.peers.map((p) => p.conn));
      for (const conn of [...this.peers.keys()]) if (!now.has(conn)) this.leave(conn, true);
      for (const p of f.peers) this.peer(p, true);
      this.emit("presence", this.peerList());
      // Same rule from the other side: peers may have dropped us on our old socket's
      // "left", so re-announce at a new clock.
      if (this.awareness?.getLocalState()) this.awareness.setLocalState(this.awareness.getLocalState());
      else this.queuePresence();
    } else if (f.type === "ack") {
      this.outbox.delete(f.idem);
    } else if (f.type === "error") {
      if (f.error?.startsWith("presence")) { if (f.status === 429) this.queuePresence(); }
      else if (f.status === 409) this.setStatus("read_only");                    // keep it; resend on unfreeze
      else if (f.status === 413 || f.status === 403 || f.status === 507) this.diverge(f.error);
      else if (f.status === 429 && !this.rtimer)                                 // one paced resend of the whole outbox, in order
        this.rtimer = setTimeout(() => { this.rtimer = null; this.resend(); }, Math.max(1000 * (f.retry_after ?? 1), 250));
      this.emit("error", f);
    } else if (f.type === "mode") {
      this.setStatus(f.mode === "read_only" ? "read_only" : "connected");
      this.resend();
    } else if (f.type === "presence") {
      this.peer(f.peer);
    } else if (f.type === "left") {
      this.leave(f.conn);
    } else if (f.type === "end") {
      this.finish(f.reason === "revoked" || f.reason === "deleted" || f.reason === "expired" ? f.reason : null);
    }
  }

  flush() {
    if (!this.buffer.length) return;
    const data = enc(this.Y.mergeUpdates(this.buffer));
    this.buffer = [];
    const max = this.whoami?.limits?.max_entry_bytes;
    if (max && data.length > max) return this.diverge("entry_too_large");   // skip the doomed round trip
    const idem = crypto.randomUUID();
    this.outbox.set(idem, data);
    this.send(idem, data);
  }

  // Only while "connected": a frozen room would refuse it, and "ready" or an
  // unfreezing "mode" frame resends the whole outbox in order anyway.
  send(idem, data) {
    if (this.status === "connected" && this.ws?.readyState === 1 && data)
      this.ws.send(JSON.stringify({ type: "append", idem, data }));
  }

  resend() { for (const [idem, data] of this.outbox) this.send(idem, data); }

  // Local state now holds an edit no peer can ever receive, and every later local
  // edit would depend on it. Stop sending; keep receiving so the page stays live
  // until the app reloads from the room.
  diverge(error) {
    clearTimeout(this.timer); this.timer = null;
    this.outbox.clear(); this.buffer = [];
    this.ydoc.off("update", this.onUpdate);
    this.setStatus("diverged");
    this.diverged = true;
    this.emit("diverged", { error });
  }

  // Drop a socket without waiting for the close handshake, then reconnect.
  // Useful when the app detects network change; tests use it to simulate loss.
  reconnect() {
    const ws = this.ws;
    if (ws) { ws.onclose = ws.onmessage = null; ws.close(); this.ws = null; }
    if (!this.ended) { this.setStatus("connecting"); this.connect(); }
  }

  // --- Presence: deltas in, throttled deltas out ---------------------------

  peer({ conn, cred, state }, quiet) {
    this.peers.set(conn, { cred, state });
    if (this.awareness && typeof state === "string") {
      // Remember which awareness clients this connection speaks for, so "left"
      // can remove them without waiting for the 30 s awareness timeout.
      const ids = this.connClients.get(conn) ?? new Set();
      const seen = ({ added, updated }) => { for (const id of [...added, ...updated]) ids.add(id); };
      this.awareness.on("update", seen);
      this.ap.applyAwarenessUpdate(this.awareness, dec(state), this);
      this.awareness.off("update", seen);
      this.connClients.set(conn, ids);
    }
    if (!quiet) this.emit("presence", this.peerList());
  }

  leave(conn, quiet) {
    this.peers.delete(conn);
    const ids = this.connClients?.get(conn);
    if (ids) {
      this.connClients.delete(conn);
      // A reconnecting peer keeps its clientID under a new conn: don't remove it.
      const live = new Set([...this.connClients.values()].flatMap((s) => [...s]));
      const gone = [...ids].filter((id) => !live.has(id));
      if (gone.length) this.ap.removeAwarenessStates(this.awareness, gone, this);
    }
    if (!quiet) this.emit("presence", this.peerList());
  }

  peerList() { return [...this.peers].map(([conn, p]) => ({ conn, ...p })); }

  setPresence(state) { this.presence = state; this.queuePresence(); }   // plain mode; use awareness otherwise

  queuePresence() {
    if (this.ptimer || (this.whoami && !this.can("presence"))) return;
    this.ptimer = setTimeout(() => { this.ptimer = null; this.sendPresence(); }, Math.max(0, this.pts + PRESENCE_MS - Date.now()));
  }

  sendPresence() {
    if (this.ws?.readyState !== 1) return;                // "ready" sends it again
    const state = this.awareness ? enc(this.ap.encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID]))
      : this.presence ?? null;
    if (state === null && !this.awareness) return;
    this.pts = Date.now();
    this.ws.send(JSON.stringify({ type: "presence", state }));
  }

  get pending() { return this.outbox.size + this.buffer.length; }

  finish(reason) {
    if (!reason) return;           // transient end: onclose will reconnect
    this.ended = true; this.setStatus("ended"); this.emit("ended", { reason });
    this.ws?.close();
  }

  forget() { this.storage?.removeItem(this.storageKey); }

  can(scope) { return !!this.whoami?.scopes?.includes(scope); }   // "presence" | "append" | "manage"

  destroy() {
    this.ended = true;
    this.flush();
    this.ydoc.off("update", this.onUpdate);
    clearTimeout(this.ptimer); clearTimeout(this.rtimer);
    if (this.awareness) { this.awareness.off("update", this.onAwareness); this.awareness.destroy(); }
    this.ws?.close();                                    // the room tells peers we left
  }
}
