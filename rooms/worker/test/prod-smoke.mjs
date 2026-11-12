// Production smoke test: the real owner plane (api.bayleaf.dev/rooms) and
// participant plane (bayleaf-rooms.dev), end to end, cleaning up after itself.
//   set -a; . ~/.tokens/bayleaf-api; set +a; node test/prod-smoke.mjs
// Creates two rooms labelled "smoke test" with a one-day expiry and deletes both.
import * as Y from "yjs";
import { BayLeafRoomProvider } from "../client/y-bayleaf.js";

const API = process.env.ROOMS_API ?? "https://api.bayleaf.dev";
const BASE = process.env.ROOMS_BASE ?? "https://bayleaf-rooms.dev";
const KEY = process.env.BAYLEAF_API_KEY;
if (!KEY) throw new Error("BAYLEAF_API_KEY is not set");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
async function until(pred, ms = 10_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await sleep(50); } return false; }

const owner = async (path, method = "GET", body) => {
  const r = await fetch(`${API}/rooms${path}`, { method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } });
  const json = /^application\/json\b/.test(r.headers.get("content-type") ?? "");   // exports are ndjson or bytes
  return { status: r.status, body: json ? await r.json() : await r.arrayBuffer() };
};
const part = (room, key, path, method = "GET", body, headers = {}) => fetch(`${BASE}/${room}${path}`, { method,
  body: body && JSON.stringify(body), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers } });
const sock = async (room, key) => {
  const { url } = await (await part(room, key, "/tickets", "POST", { after: 0 })).json();
  const ws = new WebSocket(url), frames = [];
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  await until(() => frames.some((f) => f.type === "ready"));
  return { ws, frames };
};
const expires_at = new Date(Date.now() + 86400_000).toISOString();
const made = [];

try {
  const limits = await owner("/limits");
  check(limits.status === 200 && limits.body.max_rooms > 0, `limits: ${limits.body.rooms_used}/${limits.body.max_rooms} rooms`);

  // --- JSON room: links, scopes, live relay, freeze, export ---------------------
  const c = await owner("", "POST", { label: "smoke test", expires_at });
  check(c.status === 201 || c.status === 200, `create json room (${c.status})`);
  const room = c.body.room_id; made.push(room);
  const issued = await owner(`/${room}/credentials`, "POST", { role: "write", labels: ["smoke-w"] });
  const [qr] = (await owner(`/${room}/credentials`, "POST", { scopes: ["presence"], label: "smoke-p" })).body.credentials;
  const w = issued.body.credentials[0];
  check(w.secret.startsWith("rk_") && w.link_fragment === `room=${room}&key=${w.secret}`, "issue write link");
  const who = await (await part(room, qr.secret, "/")).json();
  check(JSON.stringify(who.scopes) === '["presence"]', "participant whoami on bayleaf-rooms.dev reports scopes");

  const listen = await sock(room, w.secret);
  const r1 = await (await part(room, w.secret, "/log", "POST", { data: { hello: "world" } }, { "Idempotency-Key": "smoke-1" })).json();
  check(r1.seq === 1 && typeof r1.ts === "string", "append over HTTP");
  check(await until(() => listen.frames.some((f) => f.type === "entry" && f.entry.data?.hello === "world")), "live entry frame over WebSocket");
  const denied = await part(room, qr.secret, "/log", "POST", { data: 1 }, { "Idempotency-Key": "smoke-2" });
  check(denied.status === 403, "presence-only link cannot append");

  check((await owner(`/${room}`, "PATCH", { mode: "read_only" })).status === 200, "freeze through the API");
  const frozen = await part(room, w.secret, "/log", "POST", { data: 2 }, { "Idempotency-Key": "smoke-3" });
  check(frozen.status === 409, "frozen room refuses appends");
  const pres = await sock(room, qr.secret);
  pres.ws.send(JSON.stringify({ type: "presence", state: { mark: "?" } }));
  check(await until(() => listen.frames.some((f) => f.type === "presence" && f.peer.cred === "smoke-p")), "presence flows in a frozen room");
  pres.ws.close(); listen.ws.close();

  const exp = await owner(`/${room}/export`);
  check(exp.status === 200 && new TextDecoder().decode(exp.body).includes('"hello":"world"'), "owner export through the API");
  const listed = await owner("");
  check(listed.body.rooms?.some((x) => x.room_id === room), "room appears in owner list");

  // --- yjs room: two providers converge through production -----------------------
  const y = await owner("", "POST", { label: "smoke test", codec: "yjs", expires_at });
  const yroom = y.body.room_id; made.push(yroom);
  const yc = (await owner(`/${yroom}/credentials`, "POST", { role: "write", labels: ["kite", "wren"] })).body.credentials;
  const docs = yc.map((cr) => { const doc = new Y.Doc();
    return { doc, p: new BayLeafRoomProvider(Y, doc, { base: BASE, link: "#" + cr.link_fragment, storage: null }) }; });
  check(await until(() => docs.every((d) => d.p.synced)), "two providers synced on bayleaf-rooms.dev");
  docs[0].doc.getText("t").insert(0, "Dear Sir, "); docs[1].doc.getText("t").insert(0, "Sacramento, 1850. ");
  check(await until(() => docs.every((d) => d.p.pending === 0) && docs[0].doc.getText("t").toString() === docs[1].doc.getText("t").toString()),
    `concurrent edits converge: "${docs[0].doc.getText("t").toString()}"`);
  const yexp = await owner(`/${yroom}/export?format=yjs`);
  const restored = new Y.Doc(); Y.applyUpdate(restored, new Uint8Array(yexp.body));
  check(restored.getText("t").toString() === docs[0].doc.getText("t").toString(), "yjs export rebuilds the document");
  for (const d of docs) d.p.destroy();
} finally {
  for (const room of made) {
    const d = await owner(`/${room}`, "DELETE");
    check(d.status === 200, `delete ${room}`);
    check((await fetch(`${BASE}/${room}`)).status === 404, "deleted room is gone on bayleaf-rooms.dev");
  }
}
console.log(failures ? `\n${failures} failed` : "\nproduction smoke test passed");
process.exit(failures ? 1 : 0);
