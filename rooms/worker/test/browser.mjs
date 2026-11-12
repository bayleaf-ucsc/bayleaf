// Browser checks for client/demo/editor.html (Tiptap + y-bayleaf) against a local room server.
//   npm run dev                      (wrangler dev on :8791)
//   python3 -m http.server 8790 --directory client
//   node test/browser.mjs
// playwright-core 1.64.0 matches the cached chromium-1248 build; nothing is downloaded.
import { chromium } from "playwright-core";

const BASE = process.env.ROOMS_BASE ?? "http://localhost:8791";
const PAGE = process.env.PAGE_BASE ?? "http://localhost:8790/demo/editor.html";
const OWNER = process.env.DEV_OWNER_TOKEN ?? "dev-owner";
const SHOT = "/tmp/rooms-tiptap-proof.png";
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const owner = (path, method = "GET", body) => fetch(`${BASE}/owner/rooms${path}`, {
  method, headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
  body: body && JSON.stringify(body) }).then((r) => r.json());

const room = (await owner("", "POST", { label: "tiptap browser proof", codec: "yjs" })).room_id;
const creds = (await owner(`/${room}/credentials`, "POST", { role: "write", labels: ["kite", "wren"] })).credentials;

const browser = await chromium.launch();
const t0 = Date.now();
const open = async (cred) => {
  const ctx = await browser.newContext({ viewport: { width: 760, height: 420 } });   // isolated: own localStorage
  const page = await ctx.newPage();
  const log = { console: [], errors: [], urls: [] };
  page.on("console", (m) => log.console.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.errors.push(String(e)));
  page.on("request", (r) => log.urls.push(r.url()));
  await page.goto(`${PAGE}?base=${encodeURIComponent(BASE)}#${cred.link_fragment}`);
  await page.waitForSelector(".ProseMirror[contenteditable=true]", { timeout: 20_000 });
  return { page, log, name: cred.label };
};
const [K, W] = await Promise.all(creds.map(open));
console.log(`     both editors live in ${Date.now() - t0} ms`);
check(!(await K.page.evaluate(() => location.hash)), "link fragment scrubbed from the URL");

const text = (c) => c.page.evaluate(() => getEditor().getText());
const editable = (c) => c.page.getAttribute(".ProseMirror", "contenteditable");
const until = async (pred, ms = 10_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const converged = () => until(async () => { const [a, b] = await Promise.all([text(K), text(W)]); return a === b && a.length > 0; });

// Concurrent typing: both pages type at the same time into the same paragraph.
await Promise.all([K, W].map((c) => c.page.click(".ProseMirror")));
await Promise.all([K.page.keyboard.type("kite was here. ", { delay: 15 }), W.page.keyboard.type("wren too. ", { delay: 15 })]);
check(await converged(), `concurrent typing converges: "${await text(K)}"`);
const merged = await text(K);
check(merged.includes("kite was here.") && merged.includes("wren too."), "both contributions survive intact");

const caret = (c, other) => until(() => c.page.locator(".collaboration-carets__label", { hasText: other }).count().then((n) => n === 1));
check(await caret(K, "wren"), "kite's page shows wren's caret label");
check(await caret(W, "kite"), "wren's page shows kite's caret label");
await K.page.screenshot({ path: SHOT });   // kite's view: own cursor plus wren's labelled caret
await W.page.screenshot({ path: SHOT.replace(".png", "-wren.png") });

// Freeze: both editors lock; unfreeze: both unlock and edits still converge.
await owner(`/${room}`, "PATCH", { mode: "read_only" });
check(await until(async () => (await editable(K)) === "false" && (await editable(W)) === "false"), "freeze locks both editors (contenteditable=false)");
check(/read only/.test(await K.page.textContent("#status")), "banner explains the freeze");
await owner(`/${room}`, "PATCH", { mode: "open" });
check(await until(async () => (await editable(K)) === "true" && (await editable(W)) === "true"), "unfreeze unlocks both editors");
await W.page.click(".ProseMirror"); await W.page.keyboard.press("End");
await W.page.keyboard.type("after the thaw.", { delay: 15 });
check(await converged() && (await text(K)).includes("after the thaw."), "an edit after unfreezing still converges");

// One Yjs, one ProseMirror core, nothing noisy.
for (const c of [K, W]) {
  const copies = (re) => new Set(c.log.urls.filter((u) => re.test(u)).map((u) => u.replace(/\?.*/, ""))).size;
  check(!c.log.console.some((m) => /Yjs was already imported/.test(m)), `${c.name}: no "Yjs was already imported" warning`);
  check(copies(/\/yjs@[^/]+\/.*\.mjs/) === 1, `${c.name}: exactly one Yjs module file loaded`);
  for (const pm of ["model", "state", "view", "transform"])
    check(copies(new RegExp(`/prosemirror-${pm}@[^/]+/.*\\.mjs`)) === 1, `${c.name}: exactly one prosemirror-${pm} module file loaded`);
  const errs = [...c.log.errors, ...c.log.console.filter((m) => /^(error|warning):/.test(m))];
  check(errs.length === 0, `${c.name}: no console errors or warnings${errs.length ? ": " + errs.join(" | ") : ""}`);
}

await browser.close();
await owner(`/${room}`, "DELETE");
console.log(failures ? `\n${failures} failed` : `\nall passed; screenshot: ${SHOT}`);
process.exit(failures ? 1 : 0);
