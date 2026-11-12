// Rooms checks from the spike, against `npm run dev` (:8791) through the dev owner shim.
//   node test/spike.mjs          run everything, save state for the restart check
//   node test/spike.mjs verify   after restarting wrangler: state survived?
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { writeFileSync, readFileSync } from "node:fs";
import { BayLeafRoomProvider } from "../client/y-bayleaf.js";

const BASE = process.env.ROOMS_BASE ?? "http://localhost:8791";
const OWNER = process.env.DEV_OWNER_TOKEN ?? "dev-owner";
const STATE = "/tmp/bayleaf-rooms-spike.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
async function until(pred, ms = 10_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await sleep(50); } return false; }

const owner = (path, method = "GET", body) => fetch(`${BASE}/owner/rooms${path}`, {
  method, headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
  body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const part = (room, key, path, method = "GET", body, headers = {}) => fetch(`${BASE}/${room}${path}`, {
  method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
  body: body && JSON.stringify(body) });

function client(link) {
  const doc = new Y.Doc();
  const p = new BayLeafRoomProvider(Y, doc, { base: BASE, link, storage: null });
  return { doc, p, text: doc.getText("t") };
}
const converged = (cs, ms) => until(() => cs.every((c) => c.p.pending === 0) &&
  cs.every((c) => c.text.toString() === cs[0].text.toString()), ms);

if (process.argv[2] === "verify") {
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  const c = client(s.readLink);
  check(await until(() => c.p.synced), "fresh reader syncs after restart");
  check(c.text.toString() === s.text, `text survived restart (${s.text.length} chars)`);
  c.p.destroy();
  process.exit(failures ? 1 : 0);
}

// --- yjs room ---------------------------------------------------------------
const room = (await owner("", "POST", { label: "transcription spike", codec: "yjs",
  expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() })).body.room_id;
const issued = (await owner(`/${room}/credentials`, "POST", { role: "write", labels: ["owl", "heron"] })).body.credentials;
const reader = (await owner(`/${room}/credentials`, "POST", { role: "read", label: "projector" })).body.credentials[0];
check(issued.length === 2 && reader, "bulk credential issue");
check((await owner(`/${room}/credentials`, "POST", { role: "write", label: "owl" })).status === 409, "duplicate label refused");

const A = client("#" + issued[0].link_fragment), B = client("#" + issued[1].link_fragment);
check(await until(() => A.p.synced && B.p.synced), "two writers synced");

A.text.insert(0, "Dear Sir, ");
B.text.insert(0, "Sacramento, 1850. ");                // concurrent: neither has seen the other
check(await converged([A, B]), `concurrent inserts converge: "${A.text.toString()}"`);

// Many interleaved edits: crosses the compaction threshold several times.
for (let i = 0; i < 600; i++) {
  const c = i % 2 ? A : B;
  c.text.insert(Math.floor(Math.random() * (c.text.length + 1)), "ab"[i % 2]);
  c.p.flush();                                          // one append per keystroke: worst case for log growth
  if (i % 20 === 0) await sleep(30);
}
// Unbatched, this far exceeds 50 appends/s: refused appends retry after 1 s until accepted.
const t600 = Date.now();
check(await converged([A, B], 60_000), `600 interleaved edits converge under the append rate limit (${A.text.length} chars, ${Date.now() - t600} ms)`);
const log = await (await part(room, issued[0].secret, "/log?after=0&limit=1000")).json();
check(log.entries.length < 200, `log compacted: ${log.entries.length} entries for head ${log.head}`);
check(log.entries.every((e) => !("cred" in e)), "yjs entries carry no cred (commons)");

// Abrupt disconnect while editing: outbox resend must not lose or duplicate.
A.text.insert(0, "[");
A.p.flush();
A.p.ws.close();                                         // ack may be lost in flight; rely on the server's close handshake
A.text.insert(A.text.length, "]");
check(await converged([A, B]), "edits across an abrupt disconnect converge");
const bt = B.text.toString();
check(bt.startsWith("[") && bt.endsWith("]") && bt.split("[").length === 2, "peer has each edit exactly once");

const C = client("#" + reader.link_fragment);
check(await until(() => C.p.synced && C.text.toString() === A.text.toString()), "fresh read-only client from after=0 matches");

// Freeze and revoke.
await owner(`/${room}`, "PATCH", { mode: "read_only" });
check(await until(() => B.p.status === "read_only"), "freeze reaches open sockets");
const before = A.text.toString();
B.text.insert(0, "X"); B.p.flush();                     // the app should have locked the editor; this edit raced the freeze
await sleep(500);
check(A.text.toString() === before, "writes refused while frozen");
check(B.p.pending > 0, "refused edit stays in the outbox (dropping it would stall B's later edits on every peer)");
await owner(`/${room}`, "PATCH", { mode: "open" });
check(await until(() => B.p.status === "connected"), "unfreeze");
B.text.insert(B.text.length, "Y"); B.p.flush();          // later edit depends on the refused one's clock range
check(await converged([A, B]) && A.text.toString().startsWith("X") && A.text.toString().endsWith("Y"),
  "edits typed during and after the freeze both reach the peer");

let ended = null; B.p.on("ended", (e) => (ended = e.reason));
await owner(`/${room}/credentials/${issued[1].credential_id}`, "DELETE");
check(await until(() => ended === "revoked"), "revoked socket ends with reason 'revoked'");

// Large document: ~1 MB of text in 30 KB pastes (raw), checks the 64 KiB entry cap and the chunked compaction path.
const big = "x".repeat(30_000);
for (let i = 0; i < 34; i++) { A.text.insert(A.text.length, big); A.p.flush(); await sleep(40); }
check(await until(() => A.p.pending === 0 && C.text.length === A.text.length, 30_000), `~1 MB doc reaches reader (${A.text.length} chars)`);
const exp = new Uint8Array(await (await part(room, reader.secret, "/export?format=yjs")).arrayBuffer());
const restored = new Y.Doc(); Y.applyUpdate(restored, exp);
check(restored.getText("t").toString() === A.text.toString(), `participant export rebuilds the doc anywhere (${exp.length} bytes)`);

// A big paste fits the yjs entry cap (1 MiB serialized); one over it is refused.
A.text.insert(0, "y".repeat(600_000)); A.p.flush();
check(await until(() => A.p.pending === 0 && C.text.length === A.text.length, 15_000), "single 600 KB paste syncs");
let tooBig = null; A.p.on("diverged", (e) => (tooBig = e.error));
A.text.insert(0, "z".repeat(900_000)); A.p.flush();
check(await until(() => tooBig !== null, 5000), `single 900 KB paste (1.2 MB base64) diverges the client: ${tooBig}`);
check(A.p.status === "diverged" && A.p.pending === 0, "diverged client stops sending and clears its outbox");
check(C.text.length < A.text.length, "peers never see the unsyncable paste");

writeFileSync(STATE, JSON.stringify({ room, readLink: "#" + reader.link_fragment, text: C.text.toString() }));
for (const c of [A, B, C]) c.p.destroy();

// --- presence: y-protocols Awareness relayed as opaque deltas -----------------
const pr = (await owner("", "POST", { label: "carets", codec: "yjs" })).body.room_id;
const pc = (await owner(`/${pr}/credentials`, "POST", { role: "write", labels: ["kite", "wren", "lark"] })).body.credentials;
const aware = (cr) => {
  const doc = new Y.Doc();
  const p = new BayLeafRoomProvider(Y, doc, { base: BASE, link: "#" + cr.link_fragment, storage: null, awarenessProtocol });
  return { doc, p, a: p.awareness };
};
const [K, W, L] = pc.map(aware);
const names = (c) => [...c.a.getStates().entries()].filter(([id]) => id !== c.doc.clientID).map(([, s]) => s.user?.name).sort().join(",");
check(await until(() => K.p.synced && W.p.synced && L.p.synced), "three awareness clients synced");
K.a.setLocalStateField("user", { name: "kite" });
W.a.setLocalStateField("user", { name: "wren" });
L.a.setLocalStateField("user", { name: "lark" });
check(await until(() => names(K) === "lark,wren" && names(L) === "kite,wren"), "everyone sees the others' awareness");
for (let i = 0; i <= 40; i++) { K.a.setLocalStateField("cursor", i); await sleep(10); }   // 100/s: the provider throttles to 4/s
check(await until(() => W.a.getStates().get(K.doc.clientID)?.cursor === 40, 3000), "throttled cursor stream still delivers the last position");
W.p.reconnect();
await sleep(1000);
check(names(K) === "lark,wren" && names(W) === "kite,lark", "reconnect: no one loses a caret (stale 'left' spares a live clientID)");
L.p.destroy();
const t0 = Date.now();
check(await until(() => names(K) === "wren", 3000), `departure removes the caret in ${Date.now() - t0} ms, not after the 30 s awareness timeout`);
for (const c of [K, W]) c.p.destroy();

// --- opaque json room ----------------------------------------------------------
const j = (await owner("", "POST", { label: "board", codec: "json" })).body.room_id;
const [w, m] = [(await owner(`/${j}/credentials`, "POST", { role: "write", label: "students" })).body.credentials[0],
  (await owner(`/${j}/credentials`, "POST", { role: "manage", label: "teacher" })).body.credentials[0]];
const post = (key, idem, data) => part(j, key, "/log", "POST", { data }, { "Idempotency-Key": idem }).then((r) => r.json());
const r1 = await post(w.secret, "same", { type: "arg.create", text: "hi" });
const r2 = await post(w.secret, "same", { type: "arg.create", text: "hi" });
check(r1.seq === r2.seq, "idempotent retry returns the same seq");
const rd = await part(j, m.secret, "/redact", "POST", { seq: r1.seq });
const after = await (await part(j, w.secret, "/log?after=0")).json();
for (const q of ["limit=-1", "limit=abc", "after=-5", "after=1.5", "limit=0"])
  check((await part(j, w.secret, `/log?${q}`)).status === 400, `log read refuses ${q} (SQLite LIMIT -1 means unlimited)`);
check(rd.status === 200 && after.entries[0].redacted && after.entries[0].cred === "students", "redact keeps seq and cred, tombstones data");
const sock = async (key) => {                                // raw socket: plain JSON presence, no provider
  const { url } = await (await part(j, key, "/tickets", "POST", { after: 0 })).json();
  const ws = new WebSocket(url), frames = [];
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  await until(() => frames.some((f) => f.type === "ready"));
  return { ws, frames };
};
const s1 = await sock(w.secret), s2 = await sock(m.secret);
s1.ws.send(JSON.stringify({ type: "presence", state: { nick: "Owl", ready: true } }));
check(await until(() => s2.frames.some((f) => f.type === "presence" && f.peer.state?.nick === "Owl")), "json-room presence arrives as a delta");
check(!s1.frames.some((f) => f.type === "presence" && f.peer.state?.nick === "Owl"), "sender gets no echo of its own presence");
s1.ws.close();
check(await until(() => s2.frames.some((f) => f.type === "left")), "closing a socket sends 'left'");
s2.ws.close();
await owner(`/${j}`, "PATCH", { mode: "read_only" });
check((await part(j, w.secret, "/log", "POST", { data: 1 }, { "Idempotency-Key": "z" })).status === 409, "frozen json room refuses appends");

// Scopes: a presence-only credential (the projected-QR case) can signal but not write the record.
const [qr] = (await owner(`/${j}/credentials`, "POST", { scopes: ["presence"], label: "L07" })).body.credentials;
check(JSON.stringify(qr.scopes) === '["presence"]', "issue by scopes");
check((await owner(`/${j}/credentials`, "POST", { scopes: ["fly"], label: "x" })).status === 400, "unknown scope refused");
const who = await (await part(j, qr.secret, "/")).json();
check(JSON.stringify(who.scopes) === '["presence"]', "whoami reports scopes");
await owner(`/${j}`, "PATCH", { mode: "open" });
const denied = await part(j, qr.secret, "/log", "POST", { data: 1 }, { "Idempotency-Key": "q" });
check(denied.status === 403 && (await denied.json()).need === "append", "presence-only credential cannot append (403, need: append)");
await owner(`/${j}`, "PATCH", { mode: "read_only" });
const s3 = await sock(qr.secret), s4 = await sock(m.secret);
s3.ws.send(JSON.stringify({ type: "presence", state: { mark: "?" } }));
check(await until(() => s4.frames.some((f) => f.type === "presence" && f.peer.cred === "L07" && f.peer.state?.mark === "?")),
  "presence flows in a frozen room (freeze stops the record, not the signal)");
const s5 = await sock((await owner(`/${j}/credentials`, "POST", { role: "read", label: "viewer" })).body.credentials[0].secret);
s5.ws.send(JSON.stringify({ type: "presence", state: { mark: "!" } }));
check(await until(() => s5.frames.some((f) => f.type === "error" && f.need === "presence")), "read shorthand has no presence scope");
for (const s of [s3, s4, s5]) s.ws.close();

// Provider: two links to one room on one device keep separate stored keys.
const store = new Map(), storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k), removeItem: (k) => store.delete(k) };
const pa = new BayLeafRoomProvider(Y, new Y.Doc(), { base: BASE, link: "#" + w.link_fragment, storage, storageKey: "deck:projector" });
const pb = new BayLeafRoomProvider(Y, new Y.Doc(), { base: BASE, link: "#" + qr.link_fragment, storage, storageKey: "deck:student" });
const stored = (k) => JSON.parse(store.get(k) ?? "null");
check(stored("deck:projector")?.key === w.secret && stored("deck:student")?.key === qr.secret, "storageKey keeps two links to one room apart");
pa.destroy(); pb.destroy();
// A reload has no link and no room: the stored record supplies both, for its own base only.
const pr2 = new BayLeafRoomProvider(Y, new Y.Doc(), { base: BASE, storage, storageKey: "deck:student" });
check(pr2.room === j && pr2.key === qr.secret, "a reload with no link restores room and key from storage");
pr2.destroy();
let leaked = null;
try { leaked = new BayLeafRoomProvider(Y, new Y.Doc(), { base: "https://attacker.example", storage, storageKey: "deck:student" }); } catch {}
check(leaked === null, "a stored key is never used with a different base");

// Provider: a 429 to the first whoami is retried, not cached as the answer.
const realFetch = globalThis.fetch;
let busy = 1;
globalThis.fetch = (u, o) => (busy-- > 0 && String(u) === `${BASE}/${pr}`
  ? Promise.resolve(new Response('{"error":"rate_limited"}', { status: 429 })) : realFetch(u, o));
const pw = new BayLeafRoomProvider(Y, new Y.Doc(), { base: BASE, link: "#" + pc[0].link_fragment, storage: null });
check(await until(() => pw.synced) && pw.can("append"), "a 429 whoami is retried: the provider syncs and can append");
globalThis.fetch = realFetch;
// Provider: overlapping reconnects leave exactly one socket.
pw.reconnect(); pw.reconnect(); pw.connect();
await until(() => pw.ws?.readyState === 1);
await sleep(1500);
check((await owner(`/${pr}`)).body.sockets === 1, "overlapping reconnects leave one socket, not several");
pw.destroy();
await owner(`/${j}`, "DELETE");
check((await part(j, w.secret, "/")).status === 404, "deleted room is gone");

console.log(failures ? `\n${failures} failed` : "\nall passed; restart wrangler and run: node test/spike.mjs verify");
process.exit(failures ? 1 : 0);
