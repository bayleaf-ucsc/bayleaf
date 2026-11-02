// Parakeet TDT 0.6B v3 in Chromium on WebGPU: load time, real-time factor and word
// error rate for each encoder/decoder pair, on clips spoken by macOS `say` from
// known public-domain texts. Run fetch.mjs first (it is the only part that talks
// to Hugging Face). Results go to results/<date>.json.
//
//   node experiments/parakeet-webgpu/run.mjs [--headed] [--pair fp16-int8,int8-int8,...]
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DIR } from './fetch.mjs';

const here = dirname(fileURLToPath(import.meta.url)), pouch = join(here, '../..');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/Users/adam/Desktop/openchamber-maxwell/node_modules/playwright/index.mjs');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

export const TEXTS = {
  gettysburg: 'Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal. Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure. We are met on a great battle-field of that war. We have come to dedicate a portion of that field, as a final resting place for those who here gave their lives that that nation might live. It is altogether fitting and proper that we should do this.',
  spanish: 'En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero, adarga antigua, rocín flaco y galgo corredor.',
};
// Over 180 s at Samantha's default rate, so parakeet.js windows it (90 s windows, merged at sentence gaps).
TEXTS.long = [TEXTS.gettysburg,
  'But, in a larger sense, we can not dedicate, we can not consecrate, we can not hallow this ground. The brave men, living and dead, who struggled here, have consecrated it, far above our poor power to add or detract. The world will little note, nor long remember what we say here, but it can never forget what they did here.',
  'We the People of the United States, in Order to form a more perfect Union, establish Justice, insure domestic Tranquility, provide for the common defence, promote the general Welfare, and secure the Blessings of Liberty to ourselves and our Posterity, do ordain and establish this Constitution for the United States of America.',
  'When in the Course of human events, it becomes necessary for one people to dissolve the political bands which have connected them with another, and to assume among the powers of the earth, the separate and equal station to which the Laws of Nature and of Nature\'s God entitle them, a decent respect to the opinions of mankind requires that they should declare the causes which impel them to the separation.',
  'We hold these truths to be self-evident, that all men are created equal, that they are endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty and the pursuit of Happiness. That to secure these rights, Governments are instituted among Men, deriving their just powers from the consent of the governed.',
  'Fondly do we hope, fervently do we pray, that this mighty scourge of war may speedily pass away. With malice toward none, with charity for all, with firmness in the right as God gives us to see the right, let us strive on to finish the work we are in, to bind up the nation\'s wounds, to care for him who shall have borne the battle and for his widow and his orphan, to do all which may achieve and cherish a just and lasting peace among ourselves and with all nations.',
  'A well regulated public library, being necessary to the education of a free people, shall be open to every reader, and the records it keeps shall be kept no longer than its work requires.',
  'Congress shall make no law respecting an establishment of religion, or prohibiting the free exercise thereof; or abridging the freedom of speech, or of the press; or the right of the people peaceably to assemble, and to petition the Government for a redress of grievances.',
  'It is for us the living, rather, to be dedicated here to the unfinished work which they who fought here have thus far so nobly advanced. It is rather for us to be here dedicated to the great task remaining before us, that from these honored dead we take increased devotion to that cause for which they gave the last full measure of devotion, that we here highly resolve that these dead shall not have died in vain, that this nation, under God, shall have a new birth of freedom, and that government of the people, by the people, for the people, shall not perish from the earth.',
].join(' ');
const VOICES = { gettysburg: 'Samantha', long: 'Samantha', spanish: 'Paulina', marathon: 'Samantha' };
// --marathon MIN: the English paragraphs cycled to about MIN minutes (interview length), as the only clip.
const marathon = Number(arg('--marathon') ?? 0);
if (marathon) {
  const paras = TEXTS.long.split(/(?<=\.) (?=[A-Z])/), out = [];
  for (let words = 0, i = 0; words < marathon * 175; i++) { const p = paras[i % paras.length]; out.push(p); words += p.split(' ').length; }
  for (const k of Object.keys(TEXTS)) delete TEXTS[k];
  TEXTS.marathon = out.join(' ');
}

// Word error rate after lowercasing and dropping punctuation (Levenshtein over words).
export function wer(ref, hyp) {
  const norm = (s) => s.toLowerCase().normalize('NFC').replace(/[-–]/g, ' ').replace(/[^\p{L}\p{N}' ]+/gu, '').split(/\s+/).filter(Boolean);
  const r = norm(ref), h = norm(hyp);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return +(prev[h.length] / r.length).toFixed(4);
}

const audio = join(tmpdir(), 'pouch-parakeet-spike');
mkdirSync(audio, { recursive: true });
for (const [k, text] of Object.entries(TEXTS)) {
  const p = join(audio, k + '.wav');
  if (k === 'marathon' && existsSync(p) && readFileSync(p.replace('.wav', '.txt'), 'utf8') !== text) execFileSync('rm', [p]);
  if (!existsSync(p)) { execFileSync('say', ['-v', VOICES[k], '-o', p, '--file-format=WAVE', '--data-format=LEI16@16000', '-f', '-'], { input: text }); writeFileSync(p.replace('.wav', '.txt'), text); }
}

// parakeet.js's initOrt fills an unset wasmPaths with jsDelivr; with any wasmPaths
// set, ORT's WebGPU bundle imports its glue from there instead of using its own.
// The same rewrite Pouch's build makes (build-parakeet.mjs): leave it unset.
const CDN_DEFAULT = /ort\.env\.wasm\.wasmPaths = `https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\$\{ver\}\/dist\/`;/;
const noCdn = { name: 'no-cdn', setup(b) { b.onLoad({ filter: /parakeet\.js[\\/]src[\\/]backend\.js$/ }, ({ path }) => {
  const src = readFileSync(path, 'utf8');
  if (!CDN_DEFAULT.test(src)) throw new Error('backend.js: the jsDelivr default moved; update the rewrite');
  return { contents: src.replace(CDN_DEFAULT, '/* Pouch: no CDN default; the WebGPU bundle uses its embedded glue and the wasm handed in */'), loader: 'js' };
}); } };
const bundle = (await build({ entryPoints: [join(here, 'spike.js')], bundle: true, format: 'esm', write: false, minify: true, plugins: [noCdn],
  alias: { 'onnxruntime-web': join(pouch, 'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs') }, nodePaths: [join(pouch, 'node_modules')], logLevel: 'warning' })).outputFiles[0].text;
const ortDist = join(pouch, 'node_modules/onnxruntime-web/dist');
const server = createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u.split('/').includes('..')) { res.statusCode = 400; return res.end(); }
  const file = u === '/spike.js' ? null : u.startsWith('/model/') ? join(DIR, u.slice(7)) : u.startsWith('/audio/') ? join(audio, u.slice(7)) : u.startsWith('/ort/') ? join(ortDist, u.slice(5)) : null;
  if (u === '/') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><script type="module" src="/spike.js"></script>'); }
  if (u === '/spike.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle); }
  if (!file || !existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-length', statSync(file).size);
  res.end(readFileSync(file));
}).listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${server.address().port}/`;

const PAIRS = { 'fp16-int8': ['encoder-model.fp16.onnx', 'decoder_joint-model.int8.onnx'], 'int8-int8': ['encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx'],
  'fp16-fp16': ['encoder-model.fp16.onnx', 'decoder_joint-model.fp16.onnx'] };
const pairs = (arg('--pair') ?? 'fp16-int8,int8-int8').split(',');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: !process.argv.includes('--headed'),
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-first-run'] });
// Peak resident memory of this run's Chrome (the Playwright-launched browser process,
// found by its temporary profile, and every process under it: GPU, renderers, utilities),
// sampled each second. Not the owner's own Chrome.
const chromeRss = () => {
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8', maxBuffer: 2 ** 26 }).split('\n').filter(Boolean)
      .map((l) => { const [pid, ppid, rss, ...args] = l.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, rss: +rss * 1024, args: args.join(' ') }; });
    const roots = rows.filter((r) => /playwright_chromiumdev_profile/.test(r.args) && !/--type=/.test(r.args)).map((r) => r.pid);
    const tree = new Set(roots);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; } }
    return rows.filter((r) => tree.has(r.pid)).reduce((n, r) => n + r.rss, 0);
  } catch { return 0; }
};
const results = [];
for (const pair of pairs) {
  const [encoder, decoder] = PAIRS[pair];
  if (!existsSync(join(DIR, encoder)) || !existsSync(join(DIR, decoder))) { console.log(`skip ${pair}: run fetch.mjs --all`); continue; }
  const page = await browser.newPage(); // a fresh page per pair: no state or GPU memory carried over
  page.on('console', (m) => { if (m.type() === 'error' || process.env.VERBOSE) console.log('  [page]', m.text().slice(0, 300)); });
  await page.goto(base);
  await page.waitForFunction(() => self.spikeReady);
  const mem0 = await page.evaluate(() => performance.memory?.usedJSHeapSize), rss0 = chromeRss();
  let peak = rss0; const sampler = setInterval(() => { peak = Math.max(peak, chromeRss()); }, 1000);
  try {
    const r = await page.evaluate((a) => self.runSpike(a), { encoder, decoder, clips: Object.keys(TEXTS).map((k) => k + '.wav'), threads: Number(arg('--threads') ?? 1) });
    r.pair = pair; r.bytes = statSync(join(DIR, encoder)).size + statSync(join(DIR, decoder)).size + statSync(join(DIR, 'vocab.txt')).size;
    r.heapBefore = mem0; r.heapAfter = await page.evaluate(() => performance.memory?.usedJSHeapSize);
    r.chromeRssBefore = rss0; r.chromeRssPeak = peak;
    for (const c of r.clips) c.wer = wer(TEXTS[c.clip.replace('.wav', '')], c.text);
    results.push(r);
    console.log(`${pair}: ${(r.bytes / 1e6).toFixed(0)} MB, Chrome RSS ${(rss0 / 2 ** 30).toFixed(2)} -> peak ${(peak / 2 ** 30).toFixed(2)} GiB, read ${r.read_ms} ms, load ${r.load_ms} ms, ORT ${r.ort}, adapter ${JSON.stringify(r.adapter)}, refused ${r.refused.length}`);
    for (const c of r.clips) console.log(`  ${c.clip} ${c.seconds}s: cold ${c.cold.ms} ms (RTF ${c.cold.rtf}), warm ${c.warm.ms} ms (RTF ${c.warm.rtf}, ${c.warm.dispatches} GPU dispatches), WER ${c.wer}, ${c.chunks} chunks\n    "${c.text.slice(0, 160)}..."`);
  } catch (e) { console.log(`${pair}: FAILED ${String(e.message).slice(0, 600)}`); results.push({ pair, error: String(e.message).slice(0, 2000) }); }
  clearInterval(sampler);
  await page.close();
}
await browser.close(); server.close();
mkdirSync(join(here, 'results'), { recursive: true });
const out = join(here, 'results', `${new Date().toISOString().slice(0, 10)}-${pairs.join('+')}${marathon ? `-marathon${marathon}` : ''}.json`);
writeFileSync(out, JSON.stringify({ chrome: browser.version?.(), date: new Date().toISOString(), results }, null, 1) + '\n');
console.log(out);
