// Fan-out at audience scale, against `npm run dev` (wrangler dev on :8791).
//   node test/fanout.mjs [phones=150]
//
// Workload: the audience-cursor deck (DECISIONS.md, candidate workload). Phones
// join on one shared write link (the projected QR code) and park cursors as
// presence; a read-role projector watches. Nothing is stored. Two phases:
//   steady  each phone taps about every 5 s for 20 s
//   burst   every phone taps once within 2 s ("ready" after a slide change)
// Then a co-editing check: 12 provider clients in a yjs room, one keystroke
// each every 500 ms, default 250 ms batching.
//
// Latency is send-to-receive in one process (one clock), on loopback, on local
// workerd: a lower bound on the transport, not a production number. One Node
// event loop also parses every frame for all clients, so heavy phases measure
// the harness too.
import * as Y from "yjs";
import { BayLeafRoomProvider } from "../client/y-bayleaf.js";

const BASE = process.env.ROOMS_BASE ?? "http://localhost:8791";
const OWNER = process.env.DEV_OWNER_TOKEN ?? "dev-owner";
const PHONES = Number(process.argv[2] ?? 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(20); } return false; }

const owner = (path, method = "GET", body) => fetch(`${BASE}/owner/rooms${path}`, {
  method, headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
  body: body && JSON.stringify(body) }).then((r) => r.json());

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const summary = (xs) => `n=${xs.length} p50=${pct(xs, 0.5)} p95=${pct(xs, 0.95)} p99=${pct(xs, 0.99)} max=${pct(xs, 1)} ms`;

// --- presence fan-out -----------------------------------------------------------
const room = (await owner("", "POST", { label: "audience deck" })).room_id;
const [audience] = (await owner(`/${room}/credentials`, "POST", { role: "write", label: "audience" })).credentials;
const [proj] = (await owner(`/${room}/credentials`, "POST", { role: "read", label: "projector" })).credentials;

// Each client records the latency of every tap it sees: the tap carries its send time.
async function join(secret, sink) {
  const { url } = await (await fetch(`${BASE}/${room}/tickets`, { method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: "{}" })).json();
  const ws = new WebSocket(url), c = { ws, frames: 0, ready: false };
  ws.onmessage = (m) => {
    const f = JSON.parse(m.data);
    if (f.type === "error") { limited++; return; }                // raw sockets don't retry; the provider would
    c.frames++;
    if (f.type === "ready") c.ready = true;
    if (f.type === "presence" && f.peer.state?.t) sink.push(Date.now() - f.peer.state.t);
  };
  return c;
}

let t = Date.now(), limited = 0;
const projLat = [], phoneLat = [];
const projector = await join(proj.secret, projLat);
const phones = await Promise.all(Array.from({ length: PHONES }, () => join(audience.secret, phoneLat)));
await until(() => projector.ready && phones.every((p) => p.ready), 30_000);
console.log(`${PHONES} phones + projector connected in ${Date.now() - t} ms (${phones.filter((p) => p.ready).length} ready)`);

const tap = (p, i) => p.ws.send(JSON.stringify({ type: "presence", state: { x: Math.random(), y: Math.random(), k: i, t: Date.now() } }));
const reset = () => { projLat.length = phoneLat.length = limited = 0; for (const c of [projector, ...phones]) c.frames = 0; };

async function phase(name, ms, schedule) {
  reset();
  const timers = phones.flatMap((p, i) => schedule(i).map((at) => setTimeout(() => tap(p, i), at)));
  const sent = timers.length;
  await sleep(ms);
  await until(() => projLat.length + limited >= sent, 15_000);    // let the tail drain
  const out = projector.frames + phones.reduce((n, p) => n + p.frames, 0);
  console.log(`\n${name}: ${sent} taps in ${ms / 1000} s`);
  console.log(`  projector  ${summary(projLat)} (${projLat.length} delivered + ${limited} rate-limited = ${projLat.length + limited}/${sent})`);
  console.log(`  phones     ${summary(phoneLat)}`);
  console.log(`  frames out ${out} total, ${Math.round(out / (ms / 1000))}/s averaged over the phase`);
}

// Poisson taps, mean 5 s apart per phone.
await phase("steady", 20_000, () => { const at = []; for (let s = -Math.log(Math.random()) * 5000; s < 20_000; s += -Math.log(Math.random()) * 5000) at.push(s); return at; });
await phase("burst", 2_000, () => [Math.random() * 2000]);

for (const c of [projector, ...phones]) c.ws.close();
await owner(`/${room}`, "DELETE");

// --- co-editing latency: 12 writers --------------------------------------------
const yroom = (await owner("", "POST", { label: "fanout yjs", codec: "yjs" })).room_id;
const labels = Array.from({ length: 12 }, (_, i) => `w${i}`);
const creds = (await owner(`/${yroom}/credentials`, "POST", { role: "write", labels })).credentials;
const editLat = [];
const writers = creds.map((cr, i) => {
  const doc = new Y.Doc(), p = new BayLeafRoomProvider(Y, doc, { base: BASE, link: "#" + cr.link_fragment, storage: null });
  // Each writer stamps its own key; peers measure stamp-to-arrival, batching included.
  doc.getMap("stamps").observe((e) => {
    if (!e.transaction.local) for (const k of e.keysChanged) editLat.push(Date.now() - e.target.get(k));
  });
  return { doc, p, i };
});
await until(() => writers.every((w) => w.p.synced), 15_000);
const typing = writers.map((w) => setInterval(() => {
  w.doc.transact(() => { w.doc.getText("t").insert(0, "x"); w.doc.getMap("stamps").set(`w${w.i}`, Date.now()); });
}, 500));
await sleep(15_000);
typing.forEach(clearInterval);
await sleep(1500);
console.log(`\nco-editing: 12 writers, one keystroke each per 500 ms for 15 s, 250 ms batching`);
console.log(`  peer arrival ${summary(editLat)}`);
const texts = writers.map((w) => w.doc.getText("t").length);
console.log(`  converged: ${texts.every((n) => n === texts[0])} (${texts[0]} chars)`);
for (const w of writers) w.p.destroy();
await owner(`/${yroom}`, "DELETE");
process.exit(0);
