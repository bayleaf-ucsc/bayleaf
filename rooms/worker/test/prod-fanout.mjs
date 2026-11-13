// Deployed fan-out measurement (QUALIFICATION.md, "Deployed fan-out measurement").
//   set -a; . ~/.tokens/bayleaf-api; set +a; node test/prod-fanout.mjs [phase...]
// Phases (default: all): ramp appends presence audience coedit
//   ramp      fill one json room to MAX_SOCKETS_PER_ROOM, then one more (expect 429 room_busy)
//   appends   one writer at MAX_APPENDS_PER_SECOND over its socket, every socket listening
//   presence  every socket at the presence limit (5/s); a sample of sockets parses frames
//   audience  the audience-cursor deck: 150 presence-only phones + a read-only projector
//   coedit    12 y-bayleaf providers, one keystroke each per 500 ms
// Synthetic rooms labelled "fanout test" with a one-day expiry, all deleted at the end.
// Latency is send-to-receive in one process (one clock) over the real network:
// laptop -> Cloudflare edge -> Durable Object -> edge -> laptop. One Node event
// loop parses every sampled frame, so the heaviest phases also measure the harness.
// Appends go over the socket: HTTP appends would spend the room's ACCEPT_LIMIT
// (1000 requests/minute) in 20 s at 50/s.
import https from "node:https";
import * as Y from "yjs";
import { BayLeafRoomProvider } from "../client/y-bayleaf.js";

const API = process.env.ROOMS_API ?? "https://api.bayleaf.dev";
const BASE = process.env.ROOMS_BASE ?? "https://bayleaf-rooms.dev";
const KEY = process.env.BAYLEAF_API_KEY;
if (!KEY) throw new Error("BAYLEAF_API_KEY is not set");
const PHASES = process.argv.slice(2).length ? process.argv.slice(2) : ["ramp", "appends", "presence", "audience", "coedit"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(20); } return false; }
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const summary = (xs) => `n=${xs.length} p50=${pct(xs, 0.5)} p95=${pct(xs, 0.95)} p99=${pct(xs, 0.99)} max=${pct(xs, 1)} ms`;
const stamp = () => new Date().toISOString();

const owner = async (path, method = "GET", body) => {
  const r = await fetch(`${API}/rooms${path}`, { method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const expires_at = new Date(Date.now() + 86400_000).toISOString();
const made = [];
async function room(codec = "json") {
  const r = await owner("", "POST", { label: "fanout test", codec, expires_at });
  if (r.status !== 201 && r.status !== 200) throw new Error(`create ${codec} room: ${r.status} ${r.body?.error}`);
  made.push(r.body.room_id);
  return r.body.room_id;
}
const creds = async (id, body) => (await owner(`/${id}/credentials`, "POST", body)).body.credentials;
const ticket = async (id, secret) => {
  const r = await fetch(`${BASE}/${id}/tickets`, { method: "POST", body: "{}",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } });
  if (r.status !== 200 && r.status !== 201) throw Object.assign(new Error(`ticket ${r.status}`), { status: r.status });
  return (await r.json()).url;
};

// A socket that counts every frame and parses only when `parse` is set (the sample).
function connect(url, parse, onFrame) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url), c = { ws, frames: 0, ready: false, errors: {}, closed: null };
    ws.onmessage = (m) => {
      c.frames++;
      if (!parse && c.ready) return;
      const f = JSON.parse(m.data);
      if (f.type === "ready") { c.ready = true; resolve(c); }
      else if (f.type === "error") c.errors[f.error] = (c.errors[f.error] ?? 0) + 1;
      else onFrame?.(f, c);
    };
    ws.onclose = (e) => { c.closed = e.code; c.closedAt = Date.now(); c.reason = e.reason; resolve(c); };
    ws.onerror = () => resolve(c);
  });
}
async function fill(id, secret, n, { sample = n, onFrame } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 20)                 // batches of 20: realistic join, gentle on ticket issuance
    out.push(...await Promise.all(Array.from({ length: Math.min(20, n - i) }, async (_, j) =>
      connect(await ticket(id, secret), i + j < sample, onFrame))));
  return out;
}
// Status and body of a WebSocket upgrade, without a client library that hides the 429.
const upgradeStatus = (url) => new Promise((resolve) => {
  const req = https.get(url.replace(/^wss/, "https"), { headers: { Connection: "Upgrade", Upgrade: "websocket",
    "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  req.on("upgrade", (res, socket) => { socket.destroy(); resolve("101 (accepted, unexpected)"); });
  req.on("response", (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(`${res.statusCode} ${b}`)); });
  req.on("error", (e) => resolve(`error ${e.code}`));
});
const closeAll = (cs) => { for (const c of cs) try { c.ws.close(); } catch {} };

const limits = (await owner("/limits")).body;
const MAX = limits.max_sockets_per_room, RATE = limits.max_appends_per_second;
console.log(`${stamp()} limits: sockets ${MAX}/room, appends ${RATE}/s, presence ${limits.presence.per_second}/s, rooms ${limits.rooms_used}/${limits.max_rooms}`);

try {
  // --- ramp + appends + presence share one full room ------------------------------
  let full, id, w;
  if (PHASES.some((p) => ["ramp", "appends", "presence"].includes(p))) {
    id = await room();
    [w] = await creds(id, { role: "write", label: "fanout-w" });
    const entryLat = [], perSocket = new Map();
    const onEntry = (f, c) => { if (f.type === "entry" && f.entry.data?.t) { entryLat.push(Date.now() - f.entry.data.t); perSocket.set(c, (perSocket.get(c) ?? 0) + 1); } };
    let t = Date.now();
    // Every socket parses entries (they're the subject); presence sampling happens later by count only.
    full = await fill(id, w.secret, MAX, { onFrame: onEntry });
    const ready = full.filter((c) => c.ready).length;
    console.log(`\nramp: ${ready}/${MAX} sockets ready in ${Date.now() - t} ms`);
    const extra = await connect(await ticket(id, w.secret), true).catch(() => null);
    // The 429 arrives as an upgrade failure; Node's WebSocket reports it as an abnormal close.
    console.log(`  socket ${MAX + 1}: ${extra?.ready ? "ACCEPTED (unexpected)" : `refused (close ${extra?.closed})`}`);
    if (extra?.ready) extra.ws.close();
    console.log(`  raw upgrade at capacity: ${await upgradeStatus(await ticket(id, w.secret))}`);

    if (PHASES.includes("appends")) {
      const writer = full[0], acks = { ack: 0 }, SECONDS = 20;
      writer.ws.addEventListener("message", (m) => { const f = JSON.parse(m.data); if (f.type === "ack") acks.ack++; });
      const sent = RATE * SECONDS; t = Date.now();
      for (let k = 0; k < sent; k++) {
        writer.ws.send(JSON.stringify({ type: "append", idem: `f${k}`, data: { t: Date.now(), k } }));
        await sleep(Math.max(0, t + ((k + 1) * 1000) / RATE - Date.now()));
      }
      await until(() => entryLat.length >= sent * ready, 20_000);
      const counts = full.filter((c) => c.ready).map((c) => perSocket.get(c) ?? 0);
      const errs = full.reduce((e, c) => { for (const [k, v] of Object.entries(c.errors)) e[k] = (e[k] ?? 0) + v; return e; }, {});
      console.log(`\nappends: ${sent} over ${SECONDS} s (${RATE}/s), ${acks.ack} acked, errors ${JSON.stringify(errs)}`);
      console.log(`  delivery ${summary(entryLat)}`);
      console.log(`  per socket: min ${Math.min(...counts)} max ${Math.max(...counts)} of ${acks.ack} acked; ${counts.filter((n) => n < acks.ack).length} sockets short`);
      console.log(`  frames out ${entryLat.length} (${Math.round(entryLat.length / SECONDS)}/s)`);
    }

    if (PHASES.includes("presence")) {
      // Every socket sends at 5/s for 10 s. Ten sampled sockets parse frames for latency;
      // the rest only count, so the harness can keep up with ~200k frames/s.
      // PRES_SOCKETS and PRES_MS shrink the storm to find where it breaks.
      const SAMPLE = 10, SECONDS = 10, presLat = [], N = Number(process.env.PRES_SOCKETS ?? MAX), EVERY = Number(process.env.PRES_MS ?? 210);
      for (const c of full) c.frames = 0, c.errors = {};
      full.slice(0, SAMPLE).forEach((c) => c.ws.addEventListener("message", (m) => {
        const f = JSON.parse(m.data); if (f.type === "presence" && f.peer.state?.t) presLat.push(Date.now() - f.peer.state.t); }));
      const live = full.filter((c) => c.ready && c.ws.readyState === 1);
      const senders = live.slice(0, N);
      t = Date.now();
      const timers = senders.map((c, i) => setInterval(() => c.ws.readyState === 1 && c.ws.send(JSON.stringify({ type: "presence", state: { x: i, t: Date.now() } })), EVERY));
      await sleep(SECONDS * 1000); timers.forEach(clearInterval); await sleep(3000);
      const sentP = senders.length * Math.floor((SECONDS * 1000) / EVERY);
      const out = live.reduce((n, c) => n + c.frames, 0);
      console.log(`\npresence: ${senders.length} of ${live.length} sockets x ~${(1000 / EVERY).toFixed(1)}/s for ${SECONDS} s, ~${sentP} sent`);
      const closes = live.filter((c) => c.closed != null);
      if (closes.length) console.log(`  closed ${closes.length}: codes ${JSON.stringify(closes.reduce((m, c) => (m[c.closed] = (m[c.closed] ?? 0) + 1, m), {}))}, first at +${Math.min(...closes.map((c) => c.closedAt)) - t} ms, last at +${Math.max(...closes.map((c) => c.closedAt)) - t} ms, reasons ${JSON.stringify([...new Set(closes.map((c) => c.reason))])}`);
      console.log(`  sampled delivery (${SAMPLE} sockets) ${summary(presLat)}`);
      console.log(`  frames received ${out} of ~${sentP * (live.length - 1)} expected (${(100 * out / (sentP * (live.length - 1))).toFixed(1)}%), ${Math.round(out / SECONDS)}/s`);
      const errs = live.reduce((e, c) => { for (const [k, v] of Object.entries(c.errors)) e[k] = (e[k] ?? 0) + v; return e; }, {});
      console.log(`  errors (sampled sockets only parse): ${JSON.stringify(errs)}; still open ${live.filter((c) => c.ws.readyState === 1).length}`);
    }
    closeAll(full);
  }

  // --- audience-cursor deck --------------------------------------------------------
  if (PHASES.includes("audience")) {
    const PHONES = 150, aid = await room();
    const [phone] = await creds(aid, { scopes: ["presence"], label: "audience" });
    const [proj] = await creds(aid, { role: "read", label: "projector" });
    const projLat = [], phoneLat = [];
    const lat = (sink) => (f) => { if (f.type === "presence" && f.peer.state?.t) sink.push(Date.now() - f.peer.state.t); };
    let t = Date.now();
    const projector = await connect(await ticket(aid, proj.secret), true, lat(projLat));
    const phones = await fill(aid, phone.secret, PHONES, { sample: 10, onFrame: lat(phoneLat) });
    console.log(`\naudience: ${phones.filter((p) => p.ready).length}/${PHONES} phones + projector in ${Date.now() - t} ms`);
    const reset = () => { projLat.length = phoneLat.length = 0; for (const c of [projector, ...phones]) c.frames = 0, c.errors = {}; };
    const tap = (p, i) => p.ws.readyState === 1 && p.ws.send(JSON.stringify({ type: "presence", state: { x: Math.random(), y: Math.random(), k: i, t: Date.now() } }));
    async function run(name, ms, schedule) {
      reset();
      const timers = phones.flatMap((p, i) => schedule(i).map((at) => setTimeout(() => tap(p, i), at)));
      await sleep(ms); await until(() => projLat.length >= timers.length, 10_000);
      const out = projector.frames + phones.reduce((n, p) => n + p.frames, 0);
      const limited = [projector, ...phones].reduce((n, c) => n + (c.errors.presence_rate ?? 0), 0);
      console.log(`  ${name}: ${timers.length} taps in ${ms / 1000} s`);
      console.log(`    projector ${summary(projLat)} (${projLat.length}/${timers.length} delivered, ${limited} presence_rate seen)`);
      console.log(`    phones (10 sampled) ${summary(phoneLat)}`);
      console.log(`    frames out ${out} total, ${Math.round(out / (ms / 1000))}/s`);
    }
    await run("steady", 20_000, () => { const at = []; for (let s = -Math.log(Math.random()) * 5000; s < 20_000; s += -Math.log(Math.random()) * 5000) at.push(s); return at; });
    await run("burst", 2_000, () => [Math.random() * 2000]);
    closeAll([projector, ...phones]);
  }

  // --- co-editing --------------------------------------------------------------------
  if (PHASES.includes("coedit")) {
    const yid = await room("yjs");
    const cs = await creds(yid, { role: "write", labels: Array.from({ length: 12 }, (_, i) => `w${i}`) });
    const editLat = [];
    const writers = cs.map((cr, i) => {
      const doc = new Y.Doc(), p = new BayLeafRoomProvider(Y, doc, { base: BASE, link: "#" + cr.link_fragment, storage: null });
      doc.getMap("stamps").observe((e) => { if (!e.transaction.local) for (const k of e.keysChanged) editLat.push(Date.now() - e.target.get(k)); });
      return { doc, p, i };
    });
    await until(() => writers.every((w) => w.p.synced), 20_000);
    const typing = writers.map((w) => setInterval(() => w.doc.transact(() => {
      w.doc.getText("t").insert(0, "x"); w.doc.getMap("stamps").set(`w${w.i}`, Date.now()); }), 500));
    await sleep(15_000); typing.forEach(clearInterval);
    await until(() => writers.every((w) => w.p.pending === 0), 10_000); await sleep(1500);
    const lens = writers.map((w) => w.doc.getText("t").length);
    console.log(`\ncoedit: 12 writers, one keystroke each per 500 ms for 15 s, provider batching`);
    console.log(`  peer arrival ${summary(editLat)}`);
    console.log(`  converged: ${lens.every((n) => n === lens[0])} (${lens[0]} chars)`);
    for (const w of writers) w.p.destroy();
  }
} finally {
  await sleep(500);
  for (const id of made) {
    try {
      const d = await owner(`/${id}`, "DELETE");
      const gone = (await fetch(`${BASE}/${id}`)).status;
      console.log(`${d.status === 200 && gone === 404 ? "ok  " : "FAIL"} delete synthetic room (${d.status}, then ${gone})`);
    } catch (e) { console.log(`FAIL delete synthetic room: ${e.name}`); }
  }
  console.log(`${stamp()} rooms left: ${(await owner("/limits")).body.rooms_used}`);
}
process.exit(0);
