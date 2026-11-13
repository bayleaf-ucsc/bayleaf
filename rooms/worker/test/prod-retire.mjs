// Live retirement drill (QUALIFICATION.md, "Retirement and recovery") with a
// synthetic production account whose key is in RETIRE_KEY. Not a test you run casually:
// the account is created and backdated by hand in API D1 (see QUALIFICATION.md),
// then the API's daily retention job (08:17 UTC) retires it for real.
//   RETIRE_KEY=... node test/prod-retire.mjs setup   two rooms, one entry each; state to STATE
//   node test/prod-retire.mjs watch                  hold a socket until `end`, reconnecting if dropped
//   node test/prod-retire.mjs verify                 every synthetic room 404 on bayleaf-rooms.dev
// STATE holds room ids and a participant secret: keep it private, delete it after.
// Logs carry timestamps, frame types and end reasons only.
import { readFileSync, writeFileSync } from "node:fs";
import * as Y from "yjs";

const API = process.env.ROOMS_API ?? "https://api.bayleaf.dev";
const BASE = process.env.ROOMS_BASE ?? "https://bayleaf-rooms.dev";
const STATE = process.env.RETIRE_STATE ?? `${process.env.HOME}/.tokens/bayleaf-rooms-retire-qual-state.json`;
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const phase = process.argv[2];
if (phase === "setup") {
  const KEY = process.env.RETIRE_KEY;
  if (!KEY) throw new Error("RETIRE_KEY is not set");
  const owner = async (path, method = "GET", body) => {
    const r = await fetch(`${API}/rooms${path}`, { method, body: body && JSON.stringify(body),
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const expires_at = new Date(Date.now() + 3 * 86400_000).toISOString();
  const rooms = [];
  for (const codec of ["json", "yjs"]) {
    const r = await owner("", "POST", { label: "retirement test", codec, expires_at });
    if (r.status !== 201 && r.status !== 200) throw new Error(`create ${codec}: ${r.status} ${r.body?.error?.message ?? r.body?.error}`);
    const [c] = (await owner(`/${r.body.room_id}/credentials`, "POST", { role: "write", label: "retire-w" })).body.credentials;
    const data = codec === "json" ? JSON.stringify({ data: { note: "synthetic" } })
      : JSON.stringify({ data: Buffer.from((() => { const d = new Y.Doc(); d.getText("t").insert(0, "synthetic"); return Y.encodeStateAsUpdate(d); })()).toString("base64") });
    const a = await fetch(`${BASE}/${r.body.room_id}/log`, { method: "POST", body: data,
      headers: { Authorization: `Bearer ${c.secret}`, "Content-Type": "application/json", "Idempotency-Key": "retire-1" } });
    log(`${codec} room created, append ${a.status}`);
    rooms.push({ codec, room: r.body.room_id, secret: c.secret });
  }
  const limits = (await owner("/limits")).body;
  writeFileSync(STATE, JSON.stringify({ rooms }), { mode: 0o600 });
  log(`setup done: rooms_used ${limits.rooms_used}; state written`);
} else if (phase === "watch") {
  const { rooms } = JSON.parse(readFileSync(STATE, "utf8"));
  const { room, secret } = rooms[0];
  for (let attempt = 0; ; attempt++) {
    const t = await fetch(`${BASE}/${room}/tickets`, { method: "POST", body: "{}",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } }).catch(() => null);
    if (!t) { log("ticket: network error, retrying in 60 s"); await sleep(60_000); continue; }
    if (t.status !== 200 && t.status !== 201) { log(`ticket refused ${t.status}: room or credential gone`); break; }
    const url = (await t.json()).url;
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => log(`socket open (attempt ${attempt})`);
      ws.onmessage = (m) => { const f = JSON.parse(m.data); if (f.type === "end") { log(`END frame: reason ${f.reason}`); resolve("end"); }
        else if (f.type === "ready") log("ready"); };
      ws.onclose = (e) => { log(`closed ${e.code} ${e.reason}`); resolve("closed"); };
      ws.onerror = () => {};
    });
    if (result === "end") break;
    await sleep(5000);
  }
  for (const { codec, room } of rooms) log(`${codec} room on bayleaf-rooms.dev: ${(await fetch(`${BASE}/${room}`)).status}`);
  process.exit(0);
} else if (phase === "verify") {
  const { rooms } = JSON.parse(readFileSync(STATE, "utf8"));
  for (const { codec, room, secret } of rooms) {
    const anon = (await fetch(`${BASE}/${room}`)).status;
    const keyed = (await fetch(`${BASE}/${room}`, { headers: { Authorization: `Bearer ${secret}` } })).status;
    log(`${codec} room: anonymous ${anon}, with its credential ${keyed}`);
  }
} else {
  console.log("usage: node test/prod-retire.mjs setup|watch|verify");
}
