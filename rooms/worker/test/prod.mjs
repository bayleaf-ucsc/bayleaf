// Production checks (DESIGN.md) against wrangler dev on :8791, through the dev
// owner shim, which calls the same call() as the RoomManagement RPC.
//   node test/prod.mjs main   default limits, enabled
//   node test/prod.mjs low    MAX_SOCKETS_PER_ROOM=3, MAX_ROOM_BYTES=4096, telemetry on
//   node test/prod.mjs off    ROOMS_ENABLED=false (run after main: it retires main's owner)
// test/run.mjs starts wrangler with the right vars for each phase; see there.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const BASE = process.env.ROOMS_BASE ?? "http://localhost:8791";
const TOKEN = process.env.DEV_OWNER_TOKEN ?? "dev-owner";
const PERSIST = process.env.ROOMS_PERSIST ?? "/tmp/rooms-prod-state";
const STATE = "/tmp/bayleaf-rooms-prod.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
async function until(pred, ms = 10_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await sleep(50); } return false; }
const acct = (name) => `acct-${name}-${Math.random().toString(36).slice(2, 12)}`;   // OWNER shape: 16-128 [A-Za-z0-9-]

const owner = (who, path, method = "GET", body) => fetch(`${BASE}/owner${path}`, {
  method, headers: { Authorization: `Bearer ${TOKEN}`, "X-Dev-Owner": who, "Content-Type": "application/json" },
  body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const part = (room, key, path = "", method = "GET", body, headers = {}) => fetch(`${BASE}/${room}${path}`, {
  method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
  body: body && JSON.stringify(body) });
const d1 = (sql) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "bayleaf-rooms", "--local",
  "--persist-to", PERSIST, "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const rows = (roomId) => d1(`SELECT * FROM rooms WHERE room_id = '${roomId}'`);

async function room(who, opts = {}, cred = { role: "write", label: "w" }) {
  const r = (await owner(who, "/rooms", "POST", opts)).body;
  const c = (await owner(who, `/rooms/${r.room_id}/credentials`, "POST", cred)).body.credentials[0];
  return { id: r.room_id, key: c.secret, cred: c };
}
async function sock(id, key) {
  const { url } = await (await part(id, key, "/tickets", "POST", { after: 0 })).json();
  const ws = new WebSocket(url), frames = [];
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  await until(() => frames.some((f) => f.type === "ready"));
  return { ws, frames, ended: () => frames.find((f) => f.type === "end")?.reason };
}
// Status of a WebSocket upgrade, without a client library that hides it.
async function upgradeStatus(id, key) {
  const { url } = await (await part(id, key, "/tickets", "POST", { after: 0 })).json();
  return new Promise((resolve) => {
    const req = http.get(url.replace(/^ws/, "http"), { headers: { Connection: "Upgrade", Upgrade: "websocket",
      "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: 101, socket }); });
    req.on("response", (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
  });
}
const cron = () => fetch(`${BASE}/__scheduled?cron=*/15+*+*+*+*`).then((r) => r.status);

const phase = process.argv[2] ?? "main";

if (phase === "main") {
  // --- Public surfaces -------------------------------------------------------
  const root = await fetch(`${BASE}/`);
  check(root.status === 200 && root.headers.get("content-type").startsWith("text/plain") && !root.headers.has("set-cookie")
    && /api\.bayleaf\.dev\/docs\/rooms\.md/.test(await root.text()), "GET / is a plain-text pointer with no Set-Cookie");
  const src = readFileSync(new URL("../client/y-bayleaf.js", import.meta.url), "utf8");
  for (const p of ["y-bayleaf.js", "y-bayleaf@1.js"]) {
    const r = await fetch(`${BASE}/client/${p}`);
    check(r.status === 200 && r.headers.get("content-type").startsWith("text/javascript") &&
      r.headers.get("access-control-allow-origin") === "*" && /max-age=3600/.test(r.headers.get("cache-control")) &&
      (await r.text()) === src, `/client/${p} serves the provider bytes as JavaScript, CORS open, cached 1 h`);
  }
  check((await fetch(`${BASE}/owner/rooms`)).status === 401, "dev shim still requires DEV_OWNER_TOKEN");

  // --- call() guards and validation -----------------------------------------
  check((await owner("short", "/rooms/limits")).body?.error === "invalid", "malformed owner is invalid");
  const v = acct("valid");
  check((await owner(v, "/rooms", "POST", { codec: "xml" })).body?.error === "invalid", "unknown codec is invalid");
  check((await owner(v, "/rooms", "POST", { colour: "red" })).body?.error === "invalid", "unknown option is invalid");
  check((await owner(v, "/rooms", "POST", { expires_at: new Date(Date.now() + 91 * 86400_000).toISOString() })).body?.error === "invalid",
    "expires_at beyond 90 days is invalid");
  check((await owner(v, "/rooms/r_doesnotexist0000")).body?.error === "not_found", "unknown room is not_found");

  // --- Quota: the 21st room is refused ---------------------------------------
  const q = acct("quota");
  const made = [];
  for (let i = 0; i < 20; i++) made.push(await owner(q, "/rooms", "POST", { label: `q${i}` }));
  const over = await owner(q, "/rooms", "POST", { label: "q20" });
  check(made.every((r) => r.status === 201) && over.body?.error === "limit", "20 rooms created, the 21st returns limit");
  const lim = (await owner(q, "/rooms/limits")).body;
  check(lim.rooms_used === 20 && lim.max_rooms === 20 && lim.max_appends_per_second === 50 && lim.max_sockets_per_room === 200,
    `getLimits reports usage and enforced limits (${lim.rooms_used}/${lim.max_rooms})`);
  const listed = (await owner(q, "/rooms")).body.rooms;
  check(listed.length === 20 && listed.every((r) => r.mode === "open" && r.head === 0 && r.codec === "json"), "listRooms returns live rooms with mode and head");
  check(d1(`SELECT COUNT(*) AS n FROM rooms WHERE owner = '${q}'`)[0].n === 20, "D1 holds exactly 20 index rows (no orphan from the refused one)");

  // --- Foreign owner sees nothing -----------------------------------------------
  const f = acct("foreign"), target = made[0].body.room_id;
  const foreign = await Promise.all([owner(f, `/rooms/${target}`), owner(f, `/rooms/${target}`, "DELETE"),
    owner(f, `/rooms/${target}/credentials`, "POST", { role: "read", label: "x" }), owner(f, `/rooms/${target}/export`),
    owner(f, `/rooms/${target}`, "PATCH", { mode: "read_only" })]);
  check(foreign.every((r) => r.body?.error === "not_found"), "foreign owner gets not_found on get, delete, issue, export, update");
  check((await owner(q, `/rooms/${target}`)).body?.mode === "open", "the owner's room is untouched");

  // --- Owner operations through the shim --------------------------------------
  const o = acct("ops");
  const r1 = await room(o, { label: "ops", codec: "json" }, { role: "write", labels: ["a"] });
  const many = Array.from({ length: 99 }, (_, i) => `s${i}`);
  check((await owner(o, `/rooms/${r1.id}/credentials`, "POST", { role: "read", labels: many })).status === 201, "issue up to the credential cap (100)");
  const cap = await owner(o, `/rooms/${r1.id}/credentials`, "POST", { role: "read", label: "one-more" });
  check(cap.body?.error === "credential_limit", "the 101st credential returns credential_limit");
  check((await owner(o, `/rooms/${r1.id}/credentials/c_nonexistent0`, "DELETE")).body?.error === "not_found", "revoking an unknown credential is not_found");
  check((await owner(o, `/rooms/${r1.id}/credentials`)).body.credentials.every((c) => !("secret" in c)), "listCredentials shows no secrets");
  const later = new Date(Date.now() + 60 * 86400_000).toISOString();
  const up = await owner(o, `/rooms/${r1.id}`, "PATCH", { label: "renamed", expires_at: later });
  check(up.body?.label === "renamed" && up.body.expires_at === later && rows(r1.id)[0].expires_at === Date.parse(later),
    "updateRoom moves expiry in D1 and the room");

  const r2 = await room(o);
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
  const ap = await (await part(r2.id, r2.key, "/log", "POST", { data: { hi: 1 } }, { "Idempotency-Key": "k1" })).json();
  const lg = await (await part(r2.id, r2.key, "/log?after=0")).json();
  const who = await (await part(r2.id, r2.key)).json();
  const exp = new Date(Date.now() + 86400_000).toISOString();
  const ic = (await owner(o, `/rooms/${r2.id}/credentials`, "POST", { role: "read", labels: ["tmp-a", "tmp-b"], expires_at: exp })).body;
  const lc = (await owner(o, `/rooms/${r2.id}/credentials`)).body.credentials.find((c) => c.label === "tmp-a");
  check(ISO.test(ap.ts) && ISO.test(lg.entries[0].ts) && ISO.test(who.expires_at) && ic.credentials?.[0]?.expires_at === exp &&
    lc?.expires_at === exp, "timestamps are ISO 8601 in append, log, whoami and credential results");
  const taken = (await owner(o, `/rooms/${r2.id}/credentials`, "POST", { role: "read", label: "w" })).body;
  check(taken?.error === "label_taken" && taken.label === "w",
    "label_taken names the label");
  await part(r1.id, r1.key, "/log", "POST", { data: { hi: 1 } }, { "Idempotency-Key": "k1" });
  const ex = await fetch(`${BASE}/owner/rooms/${r1.id}/export`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Dev-Owner": o } });
  check(ex.headers.get("content-type") === "application/x-ndjson" && JSON.parse((await ex.text()).trim()).data.hi === 1, "exportRoom returns JSON lines");
  // The spike forwarded /{room}/_owner/... to the object's owner handlers; owner
  // operations are now RPC methods with no HTTP route at all.
  const sneak = await Promise.all([part(r2.id, r2.key, "/_owner/credentials", "POST", { role: "manage", label: "sneak" }),
    part(r2.id, r2.key, "/_owner/", "DELETE"), part(r2.id, r2.key, "/teardown", "POST")]);
  check(sneak.every((r) => r.status === 404) && (await part(r2.id, r2.key)).status === 200 &&
    !(await owner(o, `/rooms/${r2.id}/credentials`)).body.credentials.some((c) => c.label === "sneak"),
    "participant paths cannot reach owner operations");
  check((await owner(o, `/rooms/${r1.id}`, "DELETE")).body?.deleted === true, "deleteRoom");
  check(rows(r1.id).length === 0 && (await part(r1.id, r1.key)).status === 404, "deleted room: D1 row removed, participant 404");

  // --- Append rate limit (50/s token bucket) -----------------------------------
  const rl = await room(o);
  const burst = await Promise.all(Array.from({ length: 120 }, (_, i) =>
    part(rl.id, rl.key, "/log", "POST", { data: i }, { "Idempotency-Key": `b${i}` })));
  const okN = burst.filter((r) => r.status === 200).length, limitedR = burst.filter((r) => r.status === 429);
  const lb = limitedR[0] && await limitedR[0].json();
  check(okN >= 45 && okN <= 90 && limitedR.length + okN === 120 && lb?.error === "rate_limited" && lb.retry_after > 0 &&
    limitedR[0].headers.get("retry-after") === "1", `120 concurrent appends: ${okN} accepted, ${limitedR.length} refused 429 with retry_after`);
  await sleep(1100);
  check((await part(rl.id, rl.key, "/log", "POST", { data: "again" }, { "Idempotency-Key": "after" })).status === 200, "bucket refills after a second");

  // --- REJECT_LIMIT: failed auth has its own bucket, keyed by room --------------
  const bad = [];
  for (let i = 0; i < 34; i++) bad.push((await part(rl.id, "rk_wrong")).status);
  check(bad.slice(0, 30).every((s) => s === 401) && bad.slice(30).every((s) => s === 429), "failed auth: 30 x 401, then 429");
  check((await part(rl.id, rl.key)).status === 200, "a valid credential still works while the reject bucket is empty");
  const badTicket = await new Promise((resolve) => {
    http.get(`${BASE.replace(/^http/, "http")}/${rl.id}/live?ticket=t_forged`, { headers: { Connection: "Upgrade",
      Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } })
      .on("response", (res) => resolve(res.statusCode)).on("upgrade", () => resolve(101));
  });
  check(badTicket === 429, `a forged ticket also spends the reject bucket (${badTicket})`);

  // --- Retirement: fence first, rooms destroyed, sockets ended -----------------
  const ret = acct("retire");
  const ra = await room(ret, { codec: "yjs" }), rb = await room(ret);
  const rs = await sock(ra.id, ra.key);
  const retired = await owner(ret, "/retire", "POST");
  check(retired.body?.retired === true && retired.body.rooms === 2, "retireOwner destroys both rooms");
  check(await until(() => rs.ended() === "deleted"), "retirement ends sockets with reason 'deleted'");
  check(d1(`SELECT COUNT(*) AS n FROM rooms WHERE owner = '${ret}'`)[0].n === 0 &&
    d1(`SELECT COUNT(*) AS n FROM retired_owners WHERE owner = '${ret}'`)[0].n === 1, "D1: rows gone, fence written");
  check((await part(ra.id, ra.key)).status === 404 && (await part(rb.id, rb.key)).status === 404, "retired rooms 404 for participants");
  const fenced = await Promise.all([owner(ret, "/rooms/limits"), owner(ret, "/rooms", "POST", {}), owner(ret, "/rooms")]);
  check(fenced.every((r) => r.body?.error === "not_found"), "retired owner is fenced: not_found on limits, create, list");
  check((await owner(ret, "/retire", "POST")).body?.rooms === 0, "retireOwner is idempotent");

  // --- Expiry by alarm, with no participant request to trigger it --------------
  const e = acct("expiry");
  const er = await room(e, { expires_at: new Date(Date.now() + 3000).toISOString() });
  const es = await sock(er.id, er.key);
  check(await until(() => es.ended() === "expired", 15_000), "the alarm ends sockets with 'expired' at expires_at");
  check(await until(() => rows(er.id).length === 0, 5000), "expired room's D1 row is removed");
  check((await part(er.id, er.key)).status === 404, "expired room 404s");

  // --- Cron backstop: rows past expiry whose alarm never fired, stuck destroying -
  const b = acct("backstop");
  const bx = await room(b), by = await room(b);
  const bs = await sock(bx.id, bx.key);
  d1(`UPDATE rooms SET expires_at = ${Date.now() - 1000} WHERE room_id = '${bx.id}'`);    // alarm still 30 days out
  d1(`UPDATE rooms SET state = 'destroying' WHERE room_id = '${by.id}'`);
  check(await cron() === 200, "cron trigger runs");
  check(await until(() => bs.ended() === "expired", 5000), "backstop ends the overdue room's sockets with 'expired'");
  check(rows(bx.id).length === 0 && rows(by.id).length === 0, "backstop removes the overdue and the stuck rows");
  check((await part(bx.id, bx.key)).status === 404 && (await part(by.id, by.key)).status === 404, "both rooms 404");

  check(d1("SELECT COUNT(*) AS n FROM metric_windows")[0].n === 0, "telemetry off: nothing accumulates in metric_windows");

  // --- Leave a room for the kill-switch phase ----------------------------------
  const k = acct("killswitch");
  const kr = await room(k);
  writeFileSync(STATE, JSON.stringify({ owner: k, room: kr.id, key: kr.key }));
}

if (phase === "low") {
  // Telemetry collector stand-in: records what the cron would POST.
  const received = [];
  const stubServer = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => { received.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(202).end(); });
  }).listen(8799);

  const w = acct("low");
  const lim = (await owner(w, "/rooms/limits")).body;
  check(lim.max_sockets_per_room === 3 && lim.max_room_bytes === 4096, "getLimits reports the lowered, enforced limits");

  // room_busy: the fourth socket is refused at upgrade.
  const r = await room(w, { codec: "yjs" });
  const socks = [await sock(r.id, r.key), await sock(r.id, r.key), await sock(r.id, r.key)];
  const fourth = await upgradeStatus(r.id, r.key);
  check(socks.every((s) => s.frames.some((f) => f.type === "ready")) && fourth.status === 429 &&
    JSON.parse(fourth.body).error === "room_busy", "the socket past MAX_SOCKETS_PER_ROOM gets 429 room_busy");
  socks[0].ws.close();
  await sleep(300);
  check((await upgradeStatus(r.id, r.key)).status === 101, "a slot frees when a socket closes");

  // room_full: stored bytes are capped; the over-cap append gets 507.
  const j = await room(w);
  const statuses = [];
  for (let i = 0; i < 6; i++)
    statuses.push((await part(j.id, j.key, "/log", "POST", { data: "x".repeat(1000) }, { "Idempotency-Key": `f${i}` })).status);
  const full = await part(j.id, j.key, "/log", "POST", { data: "y" }, { "Idempotency-Key": "small" });
  check(statuses.slice(0, 4).every((s) => s === 200) && statuses[4] === 507 && full.status === 200,
    `appends past MAX_ROOM_BYTES get 507 room_full; a small one still fits (${statuses.join(",")})`);
  const body = await (await part(j.id, j.key, "/log", "POST", { data: "z".repeat(1000) }, { "Idempotency-Key": "f9" })).json();
  check(body.error === "room_full", "the refusal names room_full");
  const info = (await owner(w, `/rooms/${j.id}`)).body;
  check(info.bytes <= 4096 && info.bytes > 4000, `getRoom reports stored bytes (${info.bytes})`);

  // Telemetry: counts reach metric_windows within ~10 s, closed vocabulary only.
  const p = await sock(j.id, j.key), q = await sock(j.id, j.key);
  p.ws.send(JSON.stringify({ type: "presence", state: { nick: "Owl" } }));
  await sleep(11_500);
  const m = d1("SELECT * FROM metric_windows");
  const names = new Set(m.map((x) => x.name));
  for (const n of ["room.lifecycle", "room.appends", "room.append.bytes", "room.connections", "room.presence", "room.fanout.frames"])
    check(names.has(n), `metric_windows has ${n}`);
  const blob = JSON.stringify(m);
  check(![w, r.id, j.id, j.key, "Owl"].some((s) => blob.includes(s)), "no owner, room id, secret or presence state in telemetry");
  const full507 = m.find((x) => x.name === "room.appends" && JSON.parse(x.attrs).outcome === "room_full");
  check(full507?.value === 3, `room_full appends counted (${full507?.value})`);
  const busy = m.find((x) => x.name === "room.connections" && JSON.parse(x.attrs).outcome === "room_busy");
  check(busy?.value >= 1, "room_busy connections counted");

  // Export: age the windows so the cron sees them complete, then check the POST.
  d1("UPDATE metric_windows SET window_start = window_start - 3600000");
  await cron();
  const sent = received.flatMap((x) => x.body.points);
  check(received.length >= 1 && received.every((x) => x.auth === "Bearer local-test-writer-not-a-secret" &&
    x.body.source === "rooms" && x.body.schema_version === 1 && /^[0-9a-f-]{36}$/.test(x.body.batch_id)),
    `cron exports to the collector (${received.length} batch, ${sent.length} points)`);
  check(sent.every((pt) => pt.kind === "sum" && pt.temporality === "delta" && typeof pt.attributes === "object"), "points are delta sums with attribute objects");
  check(d1("SELECT COUNT(*) AS n FROM metric_windows WHERE window_start < " + (Date.now() - 1800000))[0].n === 0, "exported windows are deleted");
  for (const s of [p, q, ...socks]) s.ws.close();
  stubServer.close();
}

if (phase === "off") {
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  check((await part(s.room, s.key)).status === 503, "kill switch: participant request gets 503");
  check((await fetch(`${BASE}/${s.room}/tickets`, { method: "OPTIONS" })).status === 503, "kill switch: preflight gets 503 too");
  const rpcs = await Promise.all([owner(s.owner, "/rooms/limits"), owner(s.owner, "/rooms", "POST", {}), owner(s.owner, `/rooms/${s.room}`)]);
  check(rpcs.every((r) => r.body?.error === "disabled"), "kill switch: RPC returns disabled");
  check((await fetch(`${BASE}/`)).status === 200, "GET / still answers");
  const r = await owner(s.owner, "/retire", "POST");
  check(r.body?.retired === true && r.body.rooms === 1, "retireOwner works while disabled");
  check(rows(s.room).length === 0, "and removes the D1 row");
}

console.log(failures ? `\n${failures} failed` : `\n${phase}: all passed`);
process.exit(failures ? 1 : 0);
