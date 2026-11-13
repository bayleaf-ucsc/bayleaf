// Production browser proof: client/demo/editor.html (Tiptap 3 + y-bayleaf) against the
// real owner plane (api.bayleaf.dev/rooms) and participant plane (bayleaf-rooms.dev).
//   python3 -m http.server 8790 --directory client
//   set -a; . ~/.tokens/bayleaf-api; set +a; node test/prod-browser.mjs
// The page's local provider import (../y-bayleaf.js) is rewritten with page.route to the
// production https://bayleaf-rooms.dev/client/y-bayleaf@1.js, so the demo is unedited.
// Creates one yjs room labelled "browser test" with a one-day expiry and deletes it.
// Never prints room ids, secrets, link fragments or tickets.
// playwright-core matches the cached chromium build; nothing is downloaded.
import { chromium } from "playwright-core";
import * as Y from "yjs";
import { readFile } from "node:fs/promises";

const API = process.env.ROOMS_API ?? "https://api.bayleaf.dev";
const BASE = process.env.ROOMS_BASE ?? "https://bayleaf-rooms.dev";
const PAGE = process.env.PAGE_BASE ?? "http://localhost:8790/demo/editor.html";
const PROVIDER = `${BASE}/client/y-bayleaf@1.js`;
const KEY = process.env.BAYLEAF_API_KEY;
if (!KEY) throw new Error("BAYLEAF_API_KEY is not set");
const SHOT = "/tmp/rooms-prod-browser";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const until = async (pred, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await sleep(100); } return false; };
const redact = (s, room) => String(s).replaceAll(room ?? "\0", "<room>").replace(/rk_[A-Za-z0-9_-]+/g, "rk_<redacted>")
  .replace(/(ticket|key)=[^&\s"]+/g, "$1=<redacted>");

const owner = async (path, method = "GET", body) => {
  const r = await fetch(`${API}/rooms${path}`, { method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } });
  const json = /^application\/json\b/.test(r.headers.get("content-type") ?? "");
  return { status: r.status, body: json ? await r.json() : await r.arrayBuffer() };
};

// --- 5. Provider headers and bytes (no room needed) ----------------------------------
const local = await readFile(new URL("../client/y-bayleaf.js", import.meta.url));
for (const path of ["/client/y-bayleaf@1.js", "/client/y-bayleaf.js"]) {
  const h = await fetch(`${BASE}${path}`, { method: "HEAD" });
  const acao = h.headers.get("access-control-allow-origin"), cc = h.headers.get("cache-control");
  console.log(`     HEAD ${path}: ${h.status} content-type=${h.headers.get("content-type")} ACAO=${acao} cache-control=${cc}`);
  check(h.status === 200 && acao === "*" && /max-age=3600\b/.test(cc ?? ""), `${path} served with ACAO * and one-hour max-age`);
}
const prodBytes = Buffer.from(await (await fetch(PROVIDER)).arrayBuffer());
check(prodBytes.equals(local), `@1 is byte-identical to client/y-bayleaf.js (${prodBytes.length} B)`);

const before = await owner("/limits");
const maxYjs = before.body.max_entry_bytes?.yjs;
console.log(`     limits before: rooms_used=${before.body.rooms_used}/${before.body.max_rooms}, max_entry_bytes.yjs=${maxYjs}`);

const expires_at = new Date(Date.now() + 86400_000).toISOString();
let room, browser;
try {
  const c = await owner("", "POST", { label: "browser test", codec: "yjs", expires_at });
  check(c.status === 201 || c.status === 200, `create yjs room (${c.status})`);
  room = c.body.room_id;
  const creds = (await owner(`/${room}/credentials`, "POST", { role: "write", labels: ["kite", "wren"] })).body.credentials;
  check(creds?.length === 2, "issue two write links");

  browser = await chromium.launch();
  let providerHits = 0;
  const t0 = Date.now();
  const open = async (cred) => {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 420 } });   // isolated: own localStorage
    // Serve the production provider wherever the demo imports its local copy.
    await ctx.route(/\/y-bayleaf(@1)?\.js(\?.*)?$/, async (route) => {
      if (route.request().url().startsWith(BASE)) return route.continue();
      providerHits++;
      const resp = await route.fetch({ url: PROVIDER });
      await route.fulfill({ response: resp });
    });
    const page = await ctx.newPage();
    const log = { console: [], errors: [], urls: [] };
    page.on("console", (m) => log.console.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => log.errors.push(String(e)));
    page.on("request", (r) => log.urls.push(r.url()));
    await page.goto(`${PAGE}?base=${encodeURIComponent(BASE)}#${cred.link_fragment}`);
    await page.waitForSelector(".ProseMirror[contenteditable=true]", { timeout: 30_000 });
    return { page, log, name: cred.label };
  };
  const [K, W] = await Promise.all(creds.map(open));
  console.log(`     both editors live in ${Date.now() - t0} ms (provider rewritten to production ${providerHits}x)`);
  check(providerHits >= 2, "both pages loaded the provider from bayleaf-rooms.dev/client/y-bayleaf@1.js");
  check(await K.page.evaluate(() => !location.hash), "link fragment scrubbed from the URL");

  const text = (c) => c.page.evaluate(() => getEditor().getText({ blockSeparator: "\n" }));
  const editable = (c) => c.page.getAttribute(".ProseMirror", "contenteditable");
  const status = (c) => c.page.evaluate(() => provider.status);
  const converged = (ms) => until(async () => { const [a, b] = await Promise.all([text(K), text(W)]); return a === b && a.length > 0; }, ms);
  const toEnd = (c) => c.page.evaluate(() => getEditor().commands.focus("end"));   // Control+End is not doc-end on macOS
  const timed = async (fn) => { const t = Date.now(); const ok = await fn(); return [ok, Date.now() - t]; };

  // --- 1. Concurrent co-editing, carets, reload catch-up --------------------------------
  await Promise.all([K, W].map((c) => c.page.click(".ProseMirror")));
  await Promise.all([K.page.keyboard.type("kite was here. ", { delay: 15 }), W.page.keyboard.type("wren too. ", { delay: 15 })]);
  let [ok, ms] = await timed(() => converged());
  check(ok, `concurrent typing converges in ${ms} ms after typing ends: "${await text(K)}"`);
  const merged = await text(K);
  check(merged.includes("kite was here.") && merged.includes("wren too."), "both contributions survive intact");
  const caret = (c, other) => until(() => c.page.locator(".collaboration-carets__label", { hasText: other }).count().then((n) => n === 1));
  check(await caret(K, "wren"), "kite's page shows wren's caret label");
  check(await caret(W, "kite"), "wren's page shows kite's caret label");
  await K.page.screenshot({ path: `${SHOT}-kite.png` });
  await W.page.screenshot({ path: `${SHOT}-wren.png` });

  // W keeps typing while K reloads; K must catch up from the room.
  const tr = Date.now();
  const reload = K.page.reload();
  await toEnd(W); await W.page.keyboard.type("while kite reloads. ", { delay: 15 });
  await reload;
  await K.page.waitForSelector(".ProseMirror[contenteditable=true]", { timeout: 30_000 });
  [ok, ms] = await timed(() => until(async () => (await text(K).catch(() => "")) === (await text(W))));
  check(ok && (await text(K)).includes("while kite reloads."), `reload restores from storage and catches up (${Date.now() - tr} ms reload-to-converged)`);

  // --- 2. Freeze mid-edit, queued edits, unfreeze ----------------------------------------
  await toEnd(K);
  const typing = K.page.keyboard.type("typed into the freeze. ", { delay: 40 });   // ~1 s of typing
  await sleep(300);
  const tf = Date.now();
  check((await owner(`/${room}`, "PATCH", { mode: "read_only" })).status === 200, "owner PATCH mode read_only");
  await typing;
  [ok, ms] = await timed(() => until(async () => (await editable(K)) === "false" && (await editable(W)) === "false"));
  check(ok, `freeze locks both editors, contenteditable=false (${Date.now() - tf} ms after PATCH)`);
  check((await status(K)) === "read_only" && (await status(W)) === "read_only", "both providers report read_only");
  check(/read only/.test(await K.page.textContent("#status")) && /read only/.test(await W.page.textContent("#status")), "banners explain the freeze");
  await W.page.screenshot({ path: `${SHOT}-frozen.png` });
  const kFrozen = await text(K);
  const phrase = "typed into the freeze. ";
  let typedBefore = phrase; while (typedBefore && !kFrozen.includes(typedBefore)) typedBefore = typedBefore.slice(0, -1);
  console.log(`     kite's editor accepted ${typedBefore.length}/${phrase.length} chars of the mid-freeze phrase before locking`);
  check(typedBefore.length > 0, "some keystrokes landed just before the freeze took effect");
  // Keystrokes into a locked editor change nothing.
  await W.page.click(".ProseMirror"); await W.page.keyboard.type("SHOULD NOT APPEAR", { delay: 5 });
  check(!(await text(W)).includes("SHOULD NOT APPEAR"), "typing into a frozen editor is refused");
  // A programmatic edit while frozen stays in the provider's outbox and goes out on unfreeze.
  await W.page.evaluate(() => {
    const p = new Y.XmlElement("paragraph"); p.insert(0, [new Y.XmlText("queued while frozen.")]);
    ydoc.getXmlFragment("default").push([p]);
  });
  await sleep(1000);
  const outbox = await W.page.evaluate(() => provider.outbox.size + provider.buffer.length);
  check(outbox > 0, `frozen provider keeps the edit queued (outbox ${outbox})`);
  check(!(await text(K)).includes("queued while frozen."), "queued edit not relayed while frozen");

  const tu = Date.now();
  check((await owner(`/${room}`, "PATCH", { mode: "open" })).status === 200, "owner PATCH mode open");
  check(await until(async () => (await editable(K)) === "true" && (await editable(W)) === "true"), `unfreeze unlocks both editors (${Date.now() - tu} ms)`);
  check(await until(async () => (await text(K)).includes("queued while frozen.")), `queued edit syncs after unfreeze (${Date.now() - tu} ms)`);
  check((await W.page.evaluate(() => provider.outbox.size)) === 0, "outbox drains after unfreeze");
  await toEnd(K); await K.page.keyboard.type(" after the thaw.", { delay: 15 });
  [ok, ms] = await timed(() => converged());
  const thawed = await text(W);
  check(ok && thawed.includes(" after the thaw.") && thawed.includes(typedBefore) && !thawed.includes("SHOULD NOT APPEAR"),
    `post-unfreeze edits converge in ${ms} ms; the ${typedBefore.length} pre-freeze keystrokes reached wren, nothing dropped`);

  // --- 3. Oversize paste reports diverged ------------------------------------------------
  const pasteChars = Math.ceil((maxYjs ?? 1_048_576) * 1.1);
  const tp = Date.now();
  await K.page.click(".ProseMirror");
  await K.page.evaluate((n) => {
    const big = "oversize ".repeat(Math.ceil(n / 9)).slice(0, n);
    const dt = new DataTransfer(); dt.setData("text/plain", big);
    document.querySelector(".ProseMirror").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pasteChars);
  const pasted = await K.page.evaluate(() => getEditor().getText().length);
  check(pasted > pasteChars, `synthetic clipboard paste of ${pasteChars} chars landed in kite's editor`);
  check(await until(async () => (await status(K)) === "diverged"), `provider reports diverged (${Date.now() - tp} ms)`);
  check(/could not sync/.test(await K.page.textContent("#status")) && (await editable(K)) === "false", "banner says the edit could not sync and the editor locks");
  await K.page.screenshot({ path: `${SHOT}-diverged.png` });
  await sleep(1500);
  check(!(await text(W)).includes("oversize oversize") && (await status(W)) === "connected", "wren never receives the oversize edit and stays connected");
  await toEnd(W); await W.page.keyboard.type(" wren after the paste.", { delay: 15 });
  check(await until(async () => (await text(K)).includes("wren after the paste.")), "diverged page still receives peers' edits");
  await K.page.reload();
  await K.page.waitForSelector(".ProseMirror[contenteditable=true]", { timeout: 30_000 });
  check(await until(async () => (await text(K)) === (await text(W))), "reload after diverged rejoins the room's text (local paste discarded)");

  // --- 4. Owner export rebuilds with plain yjs --------------------------------------------
  const exp = await owner(`/${room}/export?format=yjs`);
  check(exp.status === 200, `owner yjs export (${exp.status}, ${exp.body.byteLength} B)`);
  const doc = new Y.Doc(); Y.applyUpdate(doc, new Uint8Array(exp.body));
  const rebuilt = doc.getXmlFragment("default").toArray().map((el) => el.toArray().map((t) => t.toString()).join("")).join("\n");
  const final = await text(W);
  check(rebuilt === final && rebuilt === (await text(K)), `export rebuilt with plain yjs equals both editors (${rebuilt.length} chars)`);
  console.log(`     final text: "${final}"`);

  for (const c of [K, W]) {
    const errs = [...c.log.errors, ...c.log.console.filter((m) => /^(error|warning):/.test(m))];
    check(errs.length === 0, `${c.name}: no console errors or warnings${errs.length ? ": " + redact(errs.join(" | "), room) : ""}`);
  }
} catch (e) {
  check(false, `harness threw: ${redact(e?.stack ?? e, room)}`);
} finally {
  await browser?.close();
  if (room) {
    const d = await owner(`/${room}`, "DELETE");
    check(d.status === 200, "delete browser-test room");
    check((await fetch(`${BASE}/${room}`)).status === 404, "deleted room is gone on bayleaf-rooms.dev (404)");
  }
  const after = await owner("/limits");
  check(after.body.rooms_used === before.body.rooms_used, `rooms_used back to ${before.body.rooms_used} (now ${after.body.rooms_used})`);
}
console.log(failures ? `\n${failures} failed` : `\nproduction browser proof passed; screenshots: ${SHOT}-*.png`);
process.exit(failures ? 1 : 0);
