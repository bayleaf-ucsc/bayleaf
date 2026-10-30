// Regenerate WALKTHROUGH.md's screenshots, status tags and coverage list.
//
//   node walkthrough.mjs [--only=scene,scene] [--draft-captions] [--jobs=4]
//   node build.mjs --walkthrough            (builds dist/, then runs this)
//
// Scenes live in walkthrough/scenes.mjs: story IDs, a scripted fake model,
// Playwright steps and named, cropped shots. The page is the real app bundled
// with the scripted fake in test/graph-fixture.js in place of Tinfoil (and a
// scripted stand-in for the Local lane's WebGPU engine): every network request
// is answered locally or aborted, so no Sealed request is ever made.
//
// Determinism: fixed viewport, deviceScaleFactor 2, light theme, reduced
// motion, hidden caret, a fixed clock start, seeded randomUUID/Math.random,
// and elapsed times frozen in the crop. Images are rewritten only when their
// pixels really changed (zero-dependency PNG decode and diff in
// walkthrough/png.mjs), so a rerun on an unchanged app leaves git clean.
//
// WALKTHROUGH.md is hand-written except between marker comments:
//   <!-- wt:shot ID --> ... <!-- /wt -->        image, story tags, caption
//   <!-- wt:status A5 D25 --> ... <!-- /wt -->  live statuses from JOURNEYS.md
//   <!-- wt:coverage --> ... <!-- /wt -->       illustrated vs not yet
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { decode, encode, shrink, diff } from './walkthrough/png.mjs';
// WALKTHROUGH_SCENES: another scenes module (tests of the generator itself).
const { scenes } = await import(process.env.WALKTHROUGH_SCENES ? resolve(process.env.WALKTHROUGH_SCENES) : './walkthrough/scenes.mjs');

const root = import.meta.dirname;
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const only = arg('only')?.split(',');
const JOBS = Number(arg('jobs') ?? 4);
const DRAFT = process.argv.includes('--draft-captions');
const IMAGES = join(root, 'walkthrough/images');
const CAPTIONS = join(root, 'walkthrough/captions.json');
const DOC = join(root, 'WALKTHROUGH.md');
const BUDGET = 5 * 1024 * 1024; // walkthrough/images/, all files
const T0 = new Date('2026-10-30T09:41:00-07:00');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ── Stories from JOURNEYS.md ───────────────────────────────────────
// "- A5 ok: text" → { id, status, text, section }. Some IDs are reused for
// different stories (D19-D21 today): a scene names the n-th one as "D19.2";
// a bare "D19" means every occurrence.
export function parseStories(md) {
  const out = []; let section = '';
  for (const line of md.split('\n')) {
    if (/^#{2,3} /.test(line)) section = line.replace(/^#+ /, '');
    else if (/^[A-Z][^-].*\(slice, /.test(line)) section = line.split(' (')[0];
    const m = /^- ([A-Z]\d+[a-z]?|Caps|Mechanics) ([^:]*?):\s(.*)$/.exec(line);
    if (!m) continue;
    const n = out.filter((s) => s.id === m[1]).length + 1;
    out.push({ id: m[1], n, ref: n > 1 ? `${m[1]}.${n}` : m[1], status: m[2].replace(/\s*\(.*$/, '').trim() || m[2], text: m[3], section });
  }
  return out;
}
const stories = parseStories(readFileSync(join(root, 'JOURNEYS.md'), 'utf8'));
const resolveRef = (ref) => { const [id, n] = ref.split('.'); return stories.filter((s) => s.id === id && (!n || s.n === Number(n))); };
const badge = (s) => `<b>${s.ref}</b> ${s.status === '?' ? 'built, untested' : s.status}`;

// Validate scenes before launching anything.
const shotIds = new Set(); const problems = [];
for (const sc of scenes) {
  for (const ref of sc.stories) if (!resolveRef(ref).length) problems.push(`scene ${sc.id}: story ${ref} is not in JOURNEYS.md`);
  for (const sh of sc.shots) {
    if (shotIds.has(sh.id)) problems.push(`duplicate shot id ${sh.id}`);
    shotIds.add(sh.id);
    for (const ref of sh.stories ?? []) if (!resolveRef(ref).length) problems.push(`shot ${sh.id}: story ${ref} is not in JOURNEYS.md`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

// ── The page: the real app with fakes bundled in ───────────────────
async function fixturePage() {
  const stub = `
import { createFake, panelRules } from './test/graph-fixture.js';
window.fake = createFake(); window.panelRules = panelRules;
export class TinfoilAI {
  constructor() { this.openAIOptions = { apiKey: 'fake' };
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: window.fakeTitle ?? 'Walkthrough session' } }] }) } };
    this.secureClient = { fetch: (u, i) => window.fake.fetch(u, i) };
  }
  async ready() {} async getVerificationDocument() { return { securityVerified: true, enclaveHost: 'enclave.example', codeFingerprint: 'walkthrough' }; }
}`;
  const worker = (await build({ entryPoints: [join(root, 'src/run/worker-browser.js')], bundle: true, minify: true, write: false, format: 'iife' })).outputFiles[0].text;
  const bundled = await build({ entryPoints: [join(root, 'src/main.js')], bundle: true, write: false, format: 'iife', minify: true,
    define: { WORKER_SRC: JSON.stringify(worker), LOCAL_MODEL: 'null', SW_SHA256: '"walkthrough"' },
    alias: { 'node:zlib': join(root, 'src/shims/zlib.js'), zlib: join(root, 'src/shims/zlib.js'), 'decode-named-character-reference': join(root, 'node_modules/decode-named-character-reference/index.js') },
    plugins: [{ name: 'walkthrough-fakes', setup(b) {
      b.onResolve({ filter: /^tinfoil$/ }, () => ({ path: 'fake', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: stub, loader: 'js', resolveDir: root }));
      b.onResolve({ filter: /local\/engine\.js$/ }, () => ({ path: join(root, 'walkthrough/fake-local.js') }));
    } }] });
  let html = readFileSync(join(root, 'pouch.html'), 'utf8').replace('<script>/*APP*/</script>', () => '<script>' + bundled.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>');
  html = html.replace('__SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' '))
    .replaceAll('__BUILD_ID__', 'walkthrough 2026-10-30');
  return html;
}

// Seeded ids and randomness, so attachment paths and the like are stable.
const INIT = `(() => {
  let n = 0, seed = 42;
  crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0');
  Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
})();`;

// ── Scene runner ───────────────────────────────────────────────────
const fresh = new Map(); // shot id -> { img (decoded, final density), text, scene, shot }
async function runScene(browser, url, sc) {
  const phone = sc.viewport === 'phone';
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, deviceScaleFactor: 2,
    isMobile: phone, hasTouch: phone, colorScheme: sc.theme ?? 'light', reducedMotion: 'reduce',
    locale: 'en-US', timezoneId: 'America/Los_Angeles', permissions: ['clipboard-read', 'clipboard-write'],
  });
  const api = [];
  await context.route('https://**/*', (r) => {
    const u = new URL(r.request().url()); api.push(`${r.request().method()} ${u.pathname}`);
    if (u.pathname === '/sealed/models') return r.fulfill({ json: { data: [{ id: 'glm-5-3', name: 'GLM 5.3', tool_calling: true, multimodal: false, endpoints: ['/v1/chat/completions'] }] } });
    if (u.pathname === '/campus-pass') return r.fulfill({ json: { campus_network: true, enabled: true, quota: { remaining: 187, limit: 200, approximate: true, resets_at: '2026-10-31T07:00:00Z' } } });
    if (u.pathname.includes('usage')) return r.fulfill({ json: {} });
    return r.abort();
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.clock.install({ time: T0 }); // flows in real time from T0
  const T = { timeout: 15000 };
  const fn = (f) => f && (typeof f === 'string' ? f : f.toString());
  const ctx = {
    page, context, T, phone,
    // A fake-model rule (test/graph-fixture.js). `when` and function replies
    // run in the page: write them as self-contained arrow functions.
    // `when` may also be an expression over c, as in the browser tests.
    rule: (r) => page.evaluate(({ r, when, reply }) => {
      const w = when && (/^\s*(\(|c\s*=>|function)/.test(when) ? new Function('return ' + when)() : new Function('c', 'return ' + when));
      window.fake.rule({ ...r, ...(w ? { when: w } : {}), ...(reply ? { reply: new Function('return ' + reply)() } : {}) });
    }, { r: { ...r, when: undefined, reply: typeof r.reply === 'function' ? undefined : r.reply }, when: fn(r.when), reply: typeof r.reply === 'function' ? fn(r.reply) : null }),
    // Files straight into OPFS /work, then a reload so the VFS sees them.
    seed: async (files) => {
      await page.evaluate(async (files) => {
        const work = await navigator.storage.getDirectory(); // OPFS root is /work
        for (const [path, text] of Object.entries(files)) {
          let dir = work; const parts = path.replace(/^\/work\//, '').split('/');
          for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
          const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(text); await w.close();
        }
      }, files);
      await page.reload(); await page.waitForSelector('#badge.ok', T);
      if ((await page.inputValue('#model').catch(() => '')) !== 'glm-5-3') await page.selectOption('#model', 'glm-5-3').catch(() => {});
      await page.evaluate(() => { const s = document.getElementById('status'); if (/Model selected/.test(s.textContent)) s.textContent = ''; });
    },
    typing: async (sel, text) => { await page.click(sel); await page.keyboard.type(text); },
    open: (gate) => page.evaluate((g) => { window.fake.gates[g] = true; }, gate),
    send: async (text) => { await page.fill('#input', text); if (phone) await page.click('#send'); else await page.press('#input', 'Enter'); },
    idle: () => page.waitForFunction(() => document.getElementById('send-label').textContent === 'Send' && !document.querySelector('#log .msg.assistant.streaming'), null, T),
    requests: (who = 'main') => page.evaluate((w) => window.fake.requests[w]?.length ?? 0, who),
    waitRequests: (who, n) => page.waitForFunction(([w, n]) => (window.fake.requests[w]?.length ?? 0) >= n, [who, n], T),
    // Open a side panel (files, editor, usage, trust, settings) unless it already is.
    panel: async (name) => {
      if ((await page.getAttribute('#app', 'data-panel')) === name) return;
      const b = page.locator(`#rail [data-panel="${name}"]`);
      if (await b.isVisible()) await b.click();
      else { await page.click('#more'); await page.locator(`#sheet button:has-text("${name[0].toUpperCase() + name.slice(1)}")`).first().click(); }
    },
    sidebar: async () => { if ((await page.getAttribute('#flipper', 'aria-expanded')) !== 'true') await page.click('#flipper'); },
    shot: (id, opts) => shot(page, sc, id, opts),
  };
  try {
    await page.goto(url + (sc.path ?? '/'));
    await page.waitForSelector('#badge.ok', T);
    if (sc.welcome !== true) await page.click('#welcome-dismiss').catch(() => {});
    if ((await page.inputValue('#model').catch(() => '')) !== 'glm-5-3') await page.selectOption('#model', 'glm-5-3').catch(() => {});
    await page.evaluate(() => { const s = document.getElementById('status'); if (/Model selected/.test(s.textContent)) s.textContent = ''; }); // picker notice from setup, not from the scene
    await sc.run(ctx);
    if (process.env.WT_EVAL) console.log(sc.id, await page.evaluate(process.env.WT_EVAL)); // debugging aid
    const posts = api.filter((a) => a.startsWith('POST'));
    if (posts.length) throw new Error(`scene ${sc.id} made POST requests: ${posts.join(', ')}`);
    if (errors.length) throw new Error(`scene ${sc.id} page errors: ${errors.join('; ')}`);
  } catch (e) {
    await page.screenshot({ path: join(tmpdir(), `walkthrough-fail-${sc.id}.png`) }).catch(() => {});
    const state = await page.evaluate(() => `title: ${document.getElementById('title')?.textContent} | status: ${document.getElementById('status')?.textContent} | log tail: ${document.getElementById('log')?.innerText.slice(-300).replace(/\s+/g, ' ')} | unmatched: ${JSON.stringify(window.fake?.unmatched?.slice(-3))} | pending: ${window.fake?.pending?.()}`).catch(() => '');
    throw new Error(`${sc.id}: ${e.message.split('\n')[0]}\n    ${state}\n    (page: ${join(tmpdir(), `walkthrough-fail-${sc.id}.png`)})`);
  } finally { await context.close(); }
}

// One named shot: the union box of `target` (a selector or a list), plus
// padding, clipped to the viewport and to `maxHeight`; with `stack`, each
// target is cropped on its own and the crops are stacked (no empty gap
// between, say, the latest turn and the composer). Optional highlight
// outline. Captured at 2x and written at `density` (2 for crops, 1 for
// whole layouts).
async function shot(page, sc, id, opts = {}) {
  const decl = sc.shots.find((s) => s.id === id);
  if (!decl) throw new Error(`scene ${sc.id}: shot ${id} is not declared in its shots list`);
  const { target, pad = 12, grow = 0, maxHeight = 1e9, highlight, density = 2, wait, stack } = { ...decl, ...opts };
  if (wait) await page.waitForSelector(wait, { timeout: 15000 });
  // With stack, each entry of target is one crop (itself a selector or a list).
  const groups = stack ? target.map((g) => [g].flat()) : [[target].flat(2)];
  const targets = groups.flat();
  const loc = (t) => (t.startsWith('last:') ? page.locator(t.slice(5)).last() : page.locator(t).first());
  // "last:sel" picks the last match (the latest turn), else the first.
  for (const t of targets) await loc(t).waitFor({ state: 'visible', timeout: 15000 });
  // Continuity highlights (src/motion.js) last about a second: shoot after them, so a run's images do not depend on timing.
  await page.waitForFunction(() => !document.querySelector('.still-mark, .pulsed, .morphed, .cm-flash, .leaving') && !document.getAnimations().some((a) => a.playState === 'running' && a.id), null, { timeout: 5000 }).catch(() => {});
  if (opts.hover) await page.hover(opts.hover); else await page.mouse.move(300, 1); // no stray hover state
  // A transcript target is scrolled to the top of the log, so the composer does not cover it.
  await loc(targets[0]).evaluate((el) => { if (el.closest('#log')) el.scrollIntoView({ block: 'start' }); else el.scrollIntoView({ block: 'nearest' }); });
  await page.waitForTimeout(150);
  const boxes = await page.evaluate(({ groups, pad, grow, maxHeight, highlight }) => {
    // Freeze elapsed times and turn durations so a rerun is pixel-identical.
    for (const el of document.querySelectorAll('.tray-time')) if (el.textContent) el.textContent = '12s';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      if (!n.parentElement?.closest('.sa-meta, .turn-meta, .msg-meta, .sa-view-head, .s-child, .tray-row, .msg-bar')) continue;
      n.textContent = n.textContent.replace(/\b(\d+m \d{2}s|\d+s)\b/g, '4s');
    }
    document.querySelectorAll('[data-wt-highlight]').forEach((e) => { e.style.outline = ''; e.removeAttribute('data-wt-highlight'); });
    if (highlight) for (const e of document.querySelectorAll(highlight)) { e.dataset.wtHighlight = ''; e.style.outline = '3px solid #e8a33d'; e.style.outlineOffset = '2px'; }
    const box = (rects) => {
      const x0 = Math.min(...rects.map((r) => r.left)), y0 = Math.min(...rects.map((r) => r.top)), x1 = Math.max(...rects.map((r) => r.right)), y1 = Math.max(...rects.map((r) => r.bottom));
      const x = Math.max(0, Math.floor(x0 - pad)), y = Math.max(0, Math.floor(y0 - pad));
      return { x, y, width: Math.min(innerWidth, Math.ceil(x1 + pad)) - x, height: Math.min(innerHeight, Math.ceil(y1 + pad + grow), y + maxHeight) - y };
    };
    const pick = (t) => t.startsWith('last:') ? [...document.querySelectorAll(t.slice(5))].at(-1) : document.querySelector(t);
    const els = groups.map((g) => g.map(pick));
    // A composer crop takes the status line under it when it says something.
    const st = document.getElementById('status');
    for (const g of els) if (g.some((e) => e?.id === 'composer') && st?.textContent.trim()) g.push(st);
    return { text: els.flat().map((e) => e.innerText).join('\n').trim(), clips: els.map((g) => box(g.map((e) => e.getBoundingClientRect()))) };
  }, { groups, pad, grow, maxHeight, highlight });
  const imgs = [];
  for (const clip of boxes.clips) {
    if (clip.height <= 0 || clip.width <= 0) throw new Error(`shot ${id}: empty crop ${JSON.stringify(clip)} (target off screen?)`);
    imgs.push(decode(await page.screenshot({ clip, animations: 'disabled', caret: 'hide', scale: 'device' })));
  }
  if (process.env.WT_TEXT?.split(',').includes(id)) console.log(id, JSON.stringify(boxes));
  fresh.set(id, { img: shrink(imgs.length > 1 ? stackImages(imgs) : imgs[0], 2 / density), text: boxes.text, sc, decl });
}
// Stack crops vertically, centered, on the first crop's corner color, 16px apart (at 2x).
function stackImages(imgs) {
  const gap = 16, width = Math.max(...imgs.map((i) => i.width)), height = imgs.reduce((n, i) => n + i.height, 0) + gap * (imgs.length - 1);
  const data = new Uint8Array(width * height * 4), bg = imgs[0].data.slice(0, 4);
  for (let i = 0; i < width * height; i++) data.set(bg, i * 4);
  let y = 0;
  for (const im of imgs) {
    const x = (width - im.width) >> 1;
    for (let r = 0; r < im.height; r++) data.set(im.data.subarray(r * im.width * 4, (r + 1) * im.width * 4), ((y + r) * width + x) * 4);
    y += im.height + gap;
  }
  return { width, height, data };
}

// ── Images: write only on real change ──────────────────────────────
function saveImages() {
  mkdirSync(IMAGES, { recursive: true });
  const changed = [];
  for (const [id, f] of fresh) {
    const file = join(IMAGES, `${id}.png`);
    if (existsSync(file)) {
      const old = decode(readFileSync(file));
      if (diff(old, f.img) <= 40) continue; // anti-aliasing noise, not a change
    }
    writeFileSync(file, encode(f.img)); changed.push(id);
  }
  return changed;
}
const pngSize = (file) => { const b = readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

// ── Captions: hand-written, or drafted with limited inference ───────
// Drafting (--draft-captions) sends only story text from JOURNEYS.md and the
// visible text of the crop (never the image, never user data: the scene
// content is synthetic) to BayLeaf API's plaintext open-weight lane, which
// routes only to OpenRouter zero-data-retention endpoints and stores no
// prompt or completion content itself (ZDR; not Sealed, not ZOA). Results are
// cached in walkthrough/captions.json by a hash of (story text + image hash),
// so unchanged shots cost nothing. A draft stays marked until a human edits
// it there (set "draft": false) or writes the caption in scenes.mjs.
const API_BASE = process.env.BAYLEAF_API_BASE ?? 'https://api.bayleaf.dev';
function apiKey() {
  if (process.env.BAYLEAF_API_KEY) return process.env.BAYLEAF_API_KEY;
  const f = join(homedir(), '.tokens/bayleaf-api');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}
function recommendedModel() {
  if (process.env.BAYLEAF_DRAFT_MODEL) return process.env.BAYLEAF_DRAFT_MODEL;
  try { return /"RECOMMENDED_MODEL":\s*"(?:openrouter:)?([^"]+)"/.exec(readFileSync(join(root, '../api/wrangler.jsonc'), 'utf8'))[1]; } catch { return null; }
}
async function draftCaption(decl, storyList, visibleText) {
  const key = apiKey(), model = recommendedModel();
  if (!key || !model) throw new Error('--draft-captions needs BAYLEAF_API_KEY (or ~/.tokens/bayleaf-api) and a model (BAYLEAF_DRAFT_MODEL or ../api/wrangler.jsonc)');
  const r = await fetch(`${API_BASE}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, messages: [
      { role: 'system', content: 'You write alt text and one-sentence captions for screenshots in a software walkthrough. Plain, concrete, present tense. No emoji, no em dashes. Reply with JSON only: {"alt": "...", "caption": "..."}. Alt text says what is visible (at most 25 words); the caption says why it matters to the user (at most 30 words).' },
      { role: 'user', content: JSON.stringify({ shot: decl.id, target: decl.target, stories: storyList.map((s) => `${s.ref} (${s.status}): ${s.text.slice(0, 600)}`), visible_text: visibleText.slice(0, 1500) }) },
    ] }) });
  if (!r.ok) throw new Error(`draft ${decl.id}: HTTP ${r.status}`);
  const content = (await r.json()).choices?.[0]?.message?.content ?? '';
  const j = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  return { alt: String(j.alt), caption: String(j.caption), model };
}

// ── Markdown ───────────────────────────────────────────────────────
const shotStories = (sc, decl) => (decl.stories ?? sc.stories).flatMap(resolveRef);
function shotBlock(sc, decl, cap) {
  const file = `walkthrough/images/${decl.id}.png`;
  const dims = existsSync(join(root, file)) ? pngSize(join(root, file)) : null;
  const density = decl.density ?? 2;
  const alt = (decl.alt ?? cap?.alt ?? `Screenshot: ${decl.id}`).replaceAll('"', '&quot;');
  const caption = decl.caption ?? cap?.caption ?? '';
  const tags = [...new Map(shotStories(sc, decl).map((s) => [s.ref, s])).values()].map(badge).join(' · ');
  const notes = [sc.reenactment && '<i>Scripted reenactment with a fake model.</i>', cap && !decl.caption && cap.draft && '<i>(draft caption)</i>'].filter(Boolean).join(' ');
  return `<img src="${file}" alt="${alt}"${dims ? ` width="${Math.round(dims.width / density)}"` : ''}><br>\n<sub>${tags}${caption ? `. ${caption}` : ''}${notes ? ` ${notes}` : ''}</sub>`;
}
function coverage(illustrated) {
  const by = new Map();
  for (const s of stories) (by.get(s.section) ?? by.set(s.section, []).get(s.section)).push(s);
  const dupes = [...new Set(stories.filter((s) => s.n > 1).map((s) => s.id))];
  const lines = [`${illustrated.size} of ${stories.length} stories in [JOURNEYS.md](JOURNEYS.md) are illustrated.${dupes.length ? ` JOURNEYS.md reuses ${dupes.join(', ')} for different stories; a second use is written with .2 here (${dupes[0]}.2).` : ''}`, '', '**Not yet illustrated**', ''];
  for (const [section, list] of by) {
    const missing = list.filter((s) => !illustrated.has(s.ref));
    if (missing.length) lines.push(`- ${section}: ${missing.map((s) => `${s.ref} (${s.status === '?' ? 'untested' : s.status})`).join(', ')}`);
  }
  return lines.join('\n');
}
function regenerate(captions) {
  let md = readFileSync(DOC, 'utf8');
  const all = new Map(scenes.flatMap((sc) => sc.shots.map((d) => [d.id, { sc, d }])));
  const placed = new Set(), illustrated = new Set(), errs = [];
  md = md.replace(/<!-- wt:shot ([\w-]+) -->[\s\S]*?<!-- \/wt -->/g, (_, id) => {
    const s = all.get(id);
    if (!s) { errs.push(`WALKTHROUGH.md places unknown shot ${id}`); return _; }
    placed.add(id); for (const st of shotStories(s.sc, s.d)) illustrated.add(st.ref);
    return `<!-- wt:shot ${id} -->\n${shotBlock(s.sc, s.d, captions[id])}\n<!-- /wt -->`;
  });
  md = md.replace(/<!-- wt:status ([^>]*?) -->[\s\S]*?<!-- \/wt -->/g, (_, refs) => {
    const list = refs.trim().split(/\s+/).flatMap((r) => { const f = resolveRef(r); if (!f.length) errs.push(`wt:status names unknown story ${r}`); return f; });
    return `<!-- wt:status ${refs.trim()} -->${list.map(badge).join(' · ')}<!-- /wt -->`;
  });
  for (const id of all.keys()) if (!placed.has(id)) errs.push(`shot ${id} is not placed in WALKTHROUGH.md (add <!-- wt:shot ${id} --><!-- /wt -->)`);
  md = md.replace(/<!-- wt:coverage -->[\s\S]*?<!-- \/wt -->/, () => `<!-- wt:coverage -->\n${coverage(illustrated)}\n<!-- /wt -->`);
  if (errs.length) { console.error(errs.join('\n')); process.exitCode = 1; }
  writeFileSync(DOC, md);
  return { illustrated, placed };
}

// ── Main ───────────────────────────────────────────────────────────
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const selected = scenes.filter((s) => !only || only.includes(s.id));
log(`${stories.length} stories, ${selected.length} scenes, ${selected.reduce((n, s) => n + s.shots.length, 0)} shots`);
const html = await fixturePage();
log('page bundled');
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  const queue = [...selected];
  await Promise.all(Array.from({ length: JOBS }, async () => {
    for (let sc; (sc = queue.shift());) {
      const s = Date.now();
      try { await runScene(browser, url, sc); log(`ok ${sc.id} (${((Date.now() - s) / 1000).toFixed(1)}s)`); }
      catch (e) { failures.push(e.message); log(`FAIL ${e.message}`); }
    }
  }));
} finally { await browser.close(); server.close(); }

const changed = saveImages();
const captions = existsSync(CAPTIONS) ? JSON.parse(readFileSync(CAPTIONS, 'utf8')) : {};
let drafted = 0;
for (const sc of scenes) for (const d of sc.shots) {
  const file = join(IMAGES, `${d.id}.png`);
  if (d.caption && d.alt || !existsSync(file)) continue;
  const list = shotStories(sc, d);
  const key = sha(list.map((s) => s.text).join('\n') + sha(readFileSync(file)));
  const c = captions[d.id];
  if (c?.key === key) continue;
  if (c && c.draft === false) { log(`note: ${d.id} changed since its caption was reviewed`); continue; }
  if (!DRAFT || !fresh.has(d.id)) continue;
  captions[d.id] = { key, ...(await draftCaption(d, list, fresh.get(d.id).text)), draft: true }; drafted++;
}
if (drafted) writeFileSync(CAPTIONS, JSON.stringify(captions, null, 2) + '\n');
const { illustrated } = regenerate(captions);

// Stale images (shots no longer declared) are reported, not deleted.
const declared = new Set(scenes.flatMap((s) => s.shots.map((d) => `${d.id}.png`)));
const files = existsSync(IMAGES) ? readdirSync(IMAGES).filter((f) => f.endsWith('.png')) : [];
const stale = files.filter((f) => !declared.has(f));
const total = files.reduce((n, f) => n + statSync(join(IMAGES, f)).size, 0);
log(`images: ${files.length} (${(total / 1024).toFixed(0)} KiB), changed ${changed.length}${changed.length ? `: ${changed.join(', ')}` : ''}; drafted ${drafted}; illustrated ${illustrated.size}/${stories.length}`);
if (stale.length) log(`stale images (no scene declares them): ${stale.join(', ')}`);
if (total > BUDGET) { console.error(`walkthrough/images/ is ${(total / 1048576).toFixed(2)} MiB, over the ${BUDGET / 1048576} MiB budget: crop tighter or use density 1`); process.exitCode = 1; }
if (failures.length) { console.error(`${failures.length} scene(s) failed:\n${failures.join('\n')}`); process.exitCode = 1; }
