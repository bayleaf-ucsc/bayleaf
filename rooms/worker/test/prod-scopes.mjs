// Production evidence for Rooms app-token scopes (issue #159): rooms.read,
// rooms.manage and an unrelated scope against the real owner plane, plus the
// Campus Pass denial. Mints three one-hour grants and revokes them; creates
// rooms labelled "scope test" with a one-day expiry and deletes them.
//   set -a; . ~/.tokens/bayleaf-api; set +a; node test/prod-scopes.mjs
// Prints only statuses and error codes: never tokens, grant ids, room ids or links.
const API = process.env.ROOMS_API ?? "https://api.bayleaf.dev";
const BASE = process.env.ROOMS_BASE ?? "https://bayleaf-rooms.dev";
const KEY = process.env.BAYLEAF_API_KEY;
if (!KEY) throw new Error("BAYLEAF_API_KEY is not set");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const call = async (bearer, path, method = "GET", body) => {
  const headers = { "Content-Type": "application/json" };
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
  const r = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  const code = json?.error?.code;
  return { status: r.status, json, text, code: typeof code === "string" ? code : "" };
};
const show = (r) => `${r.status}${r.code ? " " + r.code : ""}`;
const expires_at = new Date(Date.now() + 86400_000).toISOString();
const rooms = [], grants = [], minted = [];
let used0;

try {
  const start = await call(KEY, "/rooms/limits");
  used0 = start.json?.rooms_used;
  check(start.status === 200, `operator limits (${start.status}); rooms_used at start ${used0}`);

  // --- fixture: one json room with one entry --------------------------------------
  const c = await call(KEY, "/rooms", "POST", { label: "scope test", expires_at });
  check(c.status === 201, `operator creates json room (${c.status})`);
  const room = c.json.room_id; rooms.push(room);
  const [w] = (await call(KEY, `/rooms/${room}/credentials`, "POST", { role: "write", label: "scope-w" })).json.credentials;
  const ap = await fetch(`${BASE}/${room}/log`, { method: "POST", body: JSON.stringify({ data: { scope: "probe" } }),
    headers: { Authorization: `Bearer ${w.secret}`, "Content-Type": "application/json", "Idempotency-Key": "scope-1" } });
  check(ap.status === 200 || ap.status === 201, `append one entry through a write link (${ap.status})`);

  // --- grants ------------------------------------------------------------------------
  const mint = async (scope) => {
    const g = await call(KEY, "/grants", "POST", { scopes: [scope], expires_in: 3600 });
    check(g.status === 200 && !!g.json?.access_token, `mint ${scope} grant (${show(g)})`);
    if (g.json?.grant_id) { grants.push(g.json.grant_id); minted.push(g.json.grant_id); }
    return g.json?.access_token;
  };
  const A = await mint("rooms.read"), B = await mint("rooms.manage"), C = await mint("identity.read");

  const expect = async (tok, name, method, path, want, body) => {
    const r = await call(tok, path, method, body);
    const ok = r.status === want && (want !== 403 || r.code === "insufficient_scope");
    check(ok, `${name}: ${method} ${path.replace(room, "{id}").replace(/\/c_[\w-]+$/, "/{cid}")} -> ${show(r)} (want ${want})`);
    return r;
  };

  // --- A: rooms.read ------------------------------------------------------------------
  await expect(A, "read", "GET", "/rooms/limits", 200);
  await expect(A, "read", "GET", "/rooms", 200);
  await expect(A, "read", "GET", `/rooms/${room}`, 200);
  const ex = await expect(A, "read", "GET", `/rooms/${room}/export`, 200);
  check(ex.text.includes('"scope":"probe"'), "read: export contains the appended entry");
  await expect(A, "read", "POST", "/rooms", 403, { label: "scope test", expires_at });
  await expect(A, "read", "PATCH", `/rooms/${room}`, 403, { label: "scope test renamed" });
  await expect(A, "read", "POST", `/rooms/${room}/credentials`, 403, { role: "read", label: "scope-a" });
  await expect(A, "read", "GET", `/rooms/${room}/credentials`, 403);
  await expect(A, "read", "DELETE", `/rooms/${room}`, 403);

  // --- B: rooms.manage ----------------------------------------------------------------
  for (const [m, p] of [["GET", "/rooms/limits"], ["GET", "/rooms"], ["GET", `/rooms/${room}`], ["GET", `/rooms/${room}/export`]]) {
    const r = await call(B, p, m);
    check(r.status === 403 && r.code === "insufficient_scope", `manage: ${m} ${p.replace(room, "{id}")} -> ${show(r)} (want 403: read verbs need rooms.read)`);
  }
  await expect(B, "manage", "PATCH", `/rooms/${room}`, 200, { label: "scope test" });
  const mc = await expect(B, "manage", "POST", `/rooms/${room}/credentials`, 201, { scopes: ["presence"], label: "scope-b" });
  await expect(B, "manage", "GET", `/rooms/${room}/credentials`, 200);
  const cid = mc.json?.credentials?.[0]?.credential_id;
  if (cid) await expect(B, "manage", "DELETE", `/rooms/${room}/credentials/${cid}`, 200);
  // The "effectively read" path: a link B mints can export the room.
  const rl = (await call(B, `/rooms/${room}/credentials`, "POST", { scopes: ["presence"], label: "scope-b2" })).json?.credentials?.[0];
  const viaLink = rl && await fetch(`${BASE}/${room}/export`, { headers: { Authorization: `Bearer ${rl.secret}` } });
  check(viaLink?.status === 200 && (await viaLink.text()).includes('"scope":"probe"'),
    `manage: a link it mints exports the room (${viaLink?.status}): read reachable through links`);
  const b2 = await expect(B, "manage", "POST", "/rooms", 201, { label: "scope test", expires_at });
  const room2 = b2.json?.room_id; if (room2) rooms.push(room2);
  if (room2) {
    const d = await call(B, `/rooms/${room2}`, "DELETE");
    check(d.status === 200, `manage: DELETE /rooms/{id2} -> ${show(d)} (want 200)`);
    if (d.status === 200) rooms.splice(rooms.indexOf(room2), 1);
    check((await fetch(`${BASE}/${room2}`)).status === 404, "manage-deleted room is gone on bayleaf-rooms.dev");
  }

  // --- C: identity.read -----------------------------------------------------------------
  for (const [m, p, body] of [["GET", "/rooms/limits"], ["GET", "/rooms"], ["GET", `/rooms/${room}`], ["GET", `/rooms/${room}/export`],
    ["GET", `/rooms/${room}/credentials`], ["POST", "/rooms", { label: "scope test", expires_at }],
    ["PATCH", `/rooms/${room}`, { label: "x" }], ["POST", `/rooms/${room}/credentials`, { role: "read", label: "scope-c" }],
    ["DELETE", `/rooms/${room}`]])
    await expect(C, "identity", m, p, 403, body);

  // --- Campus Pass ---------------------------------------------------------------------
  const none = await call(null, "/rooms/limits"), campus = await call("campus", "/rooms/limits");
  // On campus both are 403 "Campus Pass does not establish ownership"; off campus a 401 is also a denial.
  const cp = (r) => r.status === 401 || (r.status === 403 && /Campus Pass/.test(r.json?.error?.message ?? ""));
  check(cp(none), `no Authorization: GET /rooms/limits -> ${show(none)}`);
  check(cp(campus), `Bearer campus: GET /rooms/limits -> ${show(campus)}`);
  const ci = await call(null, "/whoami");
  console.log(`info network: keyless GET /whoami -> ${show(ci)} (200 means Campus Pass is available here)`);

  // --- revoke ---------------------------------------------------------------------------
  for (const id of [...grants]) {
    const r = await call(KEY, `/grants/${id}`, "DELETE");
    check(r.status === 200 || r.status === 204, `revoke grant (${r.status})`);
    if (r.status === 200 || r.status === 204) grants.splice(grants.indexOf(id), 1);
  }
  const listed = await call(KEY, "/grants");
  const live = new Set((listed.json?.grants ?? []).map((g) => g.id));
  check(listed.status === 200 && minted.every((id) => !live.has(id)), `GET /grants lists none of the revoked grants (${listed.status})`);
  for (const [n, tok] of [["read", A], ["manage", B], ["identity", C]]) {
    const r = await call(tok, "/rooms/limits");
    check(r.status === 401, `revoked ${n} token: GET /rooms/limits -> ${show(r)} (want 401)`);
  }
} finally {
  for (const id of grants) { try { await call(KEY, `/grants/${id}`, "DELETE"); } catch {} }
  for (const room of rooms) {
    try {
      const d = await call(KEY, `/rooms/${room}`, "DELETE");
      check(d.status === 200, `operator deletes scope-test room (${d.status})`);
      check((await fetch(`${BASE}/${room}`)).status === 404, "deleted room is gone on bayleaf-rooms.dev");
    } catch (e) { check(false, `delete scope-test room: ${e.name}`); }
  }
  const end = await call(KEY, "/rooms/limits");
  check(end.status === 200 && end.json?.rooms_used === used0, `rooms_used back to start: ${used0} -> ${end.json?.rooms_used}`);
}
console.log(failures ? `\n${failures} failed` : "\nproduction scope test passed");
process.exit(failures ? 1 : 0);
