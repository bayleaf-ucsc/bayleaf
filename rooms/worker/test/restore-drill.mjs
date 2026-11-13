// Local restore drill for Rooms recovery (OPERATIONS.md, "Recovery after a
// database restore"; issue #159). Starts its own wrangler dev on :8794 with fresh
// state under /tmp, so it never touches the suite's :8791 state or production.
//   node test/restore-drill.mjs
// 1. Retirement: fence, rooms destroyed, live socket ended.
// 2. Rooms D1 restored alone from a pre-retirement snapshot (wrangler stopped
//    while copying): the hazard with the service reopened unreconciled, then the
//    documented reconciliation with the service closed (replay every ledger
//    generation through retireOwner), then reopening.
// 3. Kill switch: retireOwner works while ROOMS_ENABLED=false; participants 503.
// Not drillable here: an API-D1-only restore (needs the API's real ledger and
// transaction, see inbox/qualification/retirement-check.mjs for that shape) and
// Durable Object point-in-time recovery (no local bookmark API, no restore route).
import { spawn, execFileSync } from "node:child_process";
import { rmSync, cpSync, readdirSync, appendFileSync } from "node:fs";

const PORT = 8794, BASE = `http://localhost:${PORT}`, TOKEN = "dev-owner";
const PERSIST = "/tmp/rooms-restore-drill", SNAP = "/tmp/rooms-restore-drill-snapshot";
const LOG = "/tmp/rooms-restore-drill.log";   // wrangler output, for diagnosing a failed run
const D1_DIR = `${PERSIST}/v3/d1`, DO_DIR = `${PERSIST}/v3/do`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const note = (msg) => console.log(`note ${msg}`);
async function until(pred, ms = 10_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await sleep(50); } return false; }
const acct = (name) => `acct-${name}-${Math.random().toString(36).slice(2, 12)}`;
const MARK = `drill-${Math.random().toString(36).slice(2, 10)}`;   // content marker, searched for in DO storage

// --- wrangler lifecycle ------------------------------------------------------
let dev = null;
async function start(vars) {
  const all = { ROOMS_ENABLED: "true", DEV_OWNER_TOKEN: TOKEN, ...vars };
  const flags = Object.entries(all).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT), "--local-upstream", `localhost:${PORT}`,
    "--persist-to", PERSIST, ...flags], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wrangler did not start")), 60_000);
    dev.stdout.on("data", (d) => { if (/Ready on/.test(d)) { clearTimeout(t); resolve(); } });
    for (const s of [dev.stdout, dev.stderr]) s.on("data", (d) => appendFileSync(LOG, d));
  });
}
async function stop() {
  if (!dev) return;
  try { process.kill(-dev.pid); } catch {}
  dev = null;
  await sleep(1500);
}
process.on("exit", () => { if (dev) try { process.kill(-dev.pid); } catch {} });

// --- clients -------------------------------------------------------------------
const owner = (who, path, method = "GET", body) => fetch(`${BASE}/owner${path}`, {
  method, headers: { Authorization: `Bearer ${TOKEN}`, "X-Dev-Owner": who, "Content-Type": "application/json" },
  body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let idem = 0;   // appends require an Idempotency-Key
const part = (room, key, path = "", method = "GET", body) => fetch(`${BASE}/${room}${path}`, {
  method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `k${++idem}` },
  body: body && JSON.stringify(body) });
const d1 = (sql) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "bayleaf-rooms", "--local",
  "--persist-to", PERSIST, "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const fence = (o) => d1(`SELECT COUNT(*) AS n FROM retired_owners WHERE owner = '${o}'`)[0].n;
const roomRows = (o) => d1(`SELECT room_id, state FROM rooms WHERE owner = '${o}'`);

async function room(who, entries = 1) {
  const made = await owner(who, "/rooms", "POST", { label: "drill" }), r = made.body;
  if (!r?.room_id) throw new Error(`createRoom: ${made.status} ${JSON.stringify(r)}`);
  const c = (await owner(who, `/rooms/${r.room_id}/credentials`, "POST", { role: "write", label: "w" })).body.credentials[0];
  for (let i = 0; i < entries; i++) await part(r.room_id, c.secret, "/log", "POST", { data: { mark: MARK, i } });
  return { id: r.room_id, key: c.secret };
}
async function sock(id, key) {
  const { url } = await (await part(id, key, "/tickets", "POST", { after: 0 })).json();
  const ws = new WebSocket(url), frames = [];
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  await until(() => frames.some((f) => f.type === "ready"));
  return { ws, frames, ended: () => frames.find((f) => f.type === "end")?.reason };
}
// Rows holding the marker across every Durable Object SQLite file (wrangler stopped).
function doMarkerRows() {
  let n = 0;
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".sqlite")) {
      try { n += Number(execFileSync("sqlite3", [p, `SELECT COUNT(*) FROM entries WHERE data LIKE '%${MARK}%'`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || 0); } catch {}   // files without `entries`
    }
  } };
  walk(DO_DIR);
  return n;
}

// The API's room_retirements ledger, simulated: one entry per retired generation.
const ledger = [];

// =============================================================================
rmSync(PERSIST, { recursive: true, force: true });
rmSync(SNAP, { recursive: true, force: true });
rmSync(LOG, { force: true });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "bayleaf-rooms", "--local", "--persist-to", PERSIST], { stdio: "ignore" });

try {
  await start({});
  console.log("\n=== 1. retirement ===");
  // Y retired before the snapshot: its fence is in the backup, yet still replayed.
  const Y = acct("early"), yRoom = await room(Y);
  check((await owner(Y, "/retire", "POST")).body?.retired === true, "Y retired before the snapshot");
  ledger.push(Y);

  const X = acct("victim");
  const xa = await room(X, 3), xb = await room(X, 2);
  const keep = acct("keep"), kRoom = await room(keep);   // bystander: must survive everything
  check(roomRows(X).length === 2 && (await part(xa.id, xa.key)).status === 200, "X has two live rooms with content");

  // Snapshot the Rooms D1 alone, pre-retirement, with wrangler stopped.
  await stop();
  const preMarks = doMarkerRows();
  cpSync(D1_DIR, SNAP, { recursive: true });
  note(`snapshot of Rooms D1 taken; DO storage holds ${preMarks} marker entries`);
  await start({});

  const s = await sock(xa.id, xa.key);
  const ret = await owner(X, "/retire", "POST");
  ledger.push(X);
  check(ret.body?.retired === true && ret.body.rooms === 2, "retireOwner(X) destroys both rooms");
  check(await until(() => s.ended() !== undefined), `live socket receives end (reason '${s.ended()}')`);
  check(fence(X) === 1 && roomRows(X).length === 0, "D1: fence row written, X's room rows gone");
  check((await part(xa.id, xa.key)).status === 404 && (await part(xb.id, xb.key)).status === 404, "X's rooms 404 for participants");
  check((await owner(X, "/rooms")).body?.error === "not_found", "X is fenced: listRooms not_found");
  s.ws.close();

  console.log("\n=== 2. Rooms D1 restored alone ===");
  await stop();
  const postMarks = doMarkerRows();
  check(postMarks === preMarks - 5, `DO storage: retirement deleteAll'd X's content (${preMarks} -> ${postMarks} marker entries)`);
  rmSync(D1_DIR, { recursive: true, force: true });
  cpSync(SNAP, D1_DIR, { recursive: true });
  note("pre-retirement Rooms D1 restored over the live one; DO storage untouched");

  // 2a. Negative control: reopened WITHOUT reconciliation (what OPERATIONS.md forbids).
  await start({});
  check(fence(X) === 0, "hazard: X's fence is gone");
  check(roomRows(X).length === 2 && roomRows(X).every((r) => r.state === "live"), "hazard: X's room rows are back, state live");
  check(fence(Y) === 1, "Y's fence survived (it predates the snapshot)");
  const ghostPart = [await part(xa.id, xa.key), await part(xb.id, xb.key)];
  check(ghostPart.every((r) => r.status === 404), "participants with old X credentials still get 404 (content not resurrected)");
  const gl = (await owner(X, "/rooms")).body;
  check(Array.isArray(gl?.rooms) && gl.rooms.length === 2, `hazard: X (a retired generation) can list ${gl?.rooms?.length} ghost rooms`);
  note(`ghost room view: mode=${gl?.rooms?.[0]?.mode} head=${gl?.rooms?.[0]?.head}`);
  const gget = await owner(X, `/rooms/${xa.id}`);
  note(`getRoom on a ghost: ${gget.status} ${JSON.stringify(gget.body)}`);
  const gcred = await owner(X, `/rooms/${xa.id}/credentials`, "POST", { role: "write", label: "ghost" });
  note(`issueCredentials on a ghost: ${gcred.status} ${JSON.stringify(gcred.body?.error ?? "issued")}`);
  check(gcred.status !== 201, "a ghost room cannot be re-armed with new credentials");
  if (gcred.status === 201) {
    const ap = await part(xa.id, gcred.body.credentials[0].secret, "/log", "POST", { data: { mark: MARK } });
    note(`append through a re-armed ghost credential: ${ap.status}`);
  }
  const lim = (await owner(X, "/rooms/limits")).body;
  note(`ghost rows count against X's quota: rooms_used=${lim?.rooms_used}`);
  const fresh = await owner(X, "/rooms", "POST", { label: "after-restore" });
  check(fresh.status === 201, "hazard: retired X can create a NEW room (fence gone)");
  let freshKey = null;
  if (fresh.status === 201) {
    const c = (await owner(X, `/rooms/${fresh.body.room_id}/credentials`, "POST", { role: "write", label: "w" })).body.credentials[0];
    freshKey = c.secret;
    check((await part(fresh.body.room_id, freshKey, "/log", "POST", { data: { mark: MARK, fresh: true } })).status === 200,
      "hazard: the new room accepts participant content under the retired generation");
  }

  // 2b. Documented procedure: close first, replay every ledger generation, verify.
  await stop();
  await start({ ROOMS_ENABLED: "false" });
  check((await part(kRoom.id, kRoom.key)).status === 503, "closed: participants get 503 during reconciliation");
  for (const g of ledger) {
    const r = await owner(g, "/retire", "POST");
    check(r.body?.retired === true, `replay retireOwner(${g === X ? "X" : "Y"}) -> retired, destroyed ${r.body?.rooms}`);
  }
  for (const g of ledger) check(fence(g) === 1 && roomRows(g).length === 0, `verified: fence present and no room row for ${g === X ? "X" : "Y"}`);
  check(d1("SELECT COUNT(*) AS n FROM rooms WHERE state = 'destroying'")[0].n === 0, "no row stuck in destroying");
  await stop();
  check(doMarkerRows() === 1, "DO storage: the post-restore room's content is gone too (only the bystander's entry remains)");

  // Reopen (operator approval assumed for the drill).
  await start({});
  const after = [await part(xa.id, xa.key), await part(xb.id, xb.key), ...(fresh.status === 201 ? [await part(fresh.body.room_id, freshKey)] : [])];
  check(after.every((r) => r.status === 404), "reopened: every X room, including the post-restore one, is 404");
  const fenced = await Promise.all([owner(X, "/rooms/limits"), owner(X, "/rooms"), owner(X, "/rooms", "POST", {})]);
  check(fenced.every((r) => r.body?.error === "not_found"), "reopened: X is fenced again (limits, list, create not_found)");
  check((await part(kRoom.id, kRoom.key)).status === 200, "bystander room untouched throughout");

  console.log("\n=== 3. kill switch ===");
  const W = acct("killsw"), wRoom = await room(W);
  check((await part(wRoom.id, wRoom.key)).status === 200, "W's room live while enabled");
  await stop();
  await start({ ROOMS_ENABLED: "false" });
  check((await part(wRoom.id, wRoom.key)).status === 503 && (await part(kRoom.id, kRoom.key)).status === 503, "disabled: participants get 503");
  check((await owner(W, "/rooms")).body?.error === "disabled", "disabled: other owner RPC returns disabled");
  const wr = await owner(W, "/retire", "POST");
  check(wr.body?.retired === true && wr.body.rooms === 1, "disabled: retireOwner still succeeds and destroys W's room");
  check(fence(W) === 1 && roomRows(W).length === 0, "disabled: W fenced, no rows");
  await stop();
  await start({});
  check((await part(wRoom.id, wRoom.key)).status === 404, "re-enabled: W's room is 404");

  console.log("\n=== 4. not drilled locally ===");
  note("API D1 restored alone: needs the API's room_retirements ledger and identity transaction (api/src/userRetention.ts);");
  note("  this script holds the ledger as a list, so ledger write-back from Rooms fences is not exercised.");
  note("Durable Object point-in-time recovery: no local bookmark API and no production restore route (by design).");
} catch (e) {
  console.log(`FAIL drill aborted: ${e.message}`);
  failures++;
} finally {
  await stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nrestore drill passed");
process.exit(failures ? 1 : 0);
