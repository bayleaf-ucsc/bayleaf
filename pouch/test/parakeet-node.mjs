// Speech to text without a browser (src/parakeet.ts, src/parakeet/format.ts):
// argument parsing, cues and the four formats, where it refuses to run, the
// command with fake media and Parakeet engines (decode then transcribe as two
// /task jobs, -o and -y, caps, Stop, the not-downloaded message), what the
// consent sheet says (story TR1), and the build's pins and containment
// (build-parakeet.mjs: no CDN default, no hub.js, the lock's files).
// The real runtime: test/parakeet-browser.mjs.
// Run: node test/parakeet-node.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryFs } from 'just-bash';
import { buildParakeet } from '../build-parakeet.mjs';

// The build's pin, as build.mjs defines it, before the registry reads it.
const scratch = mkdtempSync(join(tmpdir(), 'pouch-parakeet-'));
const built = await buildParakeet(scratch);
globalThis.POUCH_PARAKEET = built.pin;
const PIN = built.pin, model = PIN.model;
const { parseArgs, support, createAsrService, asrWorker, HELP, DIARIZATION_GAP, MAX_SECONDS } = await import('../src/parakeet.ts');
const { cues, clock, stamp, toSrt, toVtt, toTxt, toJson, render, CUE_SECONDS, CUE_CHARS } = await import('../src/parakeet/format.ts');
const { createMediaService, MAX_INPUT_BYTES } = await import('../src/media.ts');
const { wavHeader } = await import('../src/media/wc.ts');
const { createAddons, backendOf, sizeText } = await import('../src/addons.ts');
const { REGISTRY, parakeetGpu } = await import('../src/addons-registry.ts');
const { Tasks } = await import('../src/ns/tasks.ts');
const { shellFor } = await import('../src/tools.ts');

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('ok', name); };
const lock = JSON.parse(readFileSync('models.lock.json', 'utf8'));

await t('parseArgs: formats from flags or -o, conflicts, --lang auto only, one file', () => {
  assert.deepEqual(parseArgs(['a.m4a']), { file: 'a.m4a', out: null, overwrite: false, format: 'txt' });
  assert.deepEqual(parseArgs(['a.m4a', '--srt', '-o', 'a.srt']), { file: 'a.m4a', out: 'a.srt', overwrite: false, format: 'srt' });
  assert.equal(parseArgs(['a.m4a', '-o', 'x/a.VTT']).format, 'vtt', 'the extension decides without a flag');
  assert.equal(parseArgs(['a.m4a', '-o', 'notes.md']).format, 'txt', 'an unknown extension keeps the default');
  assert.equal(parseArgs(['--json', 'a.mp4', '-o', 'a.out']).format, 'json');
  assert.equal(parseArgs(['a.m4a', '-y', '-o', 'a.txt']).overwrite, true);
  assert.equal(parseArgs(['a.m4a', '--lang', 'auto']).format, 'txt');
  assert.equal(parseArgs(['a.m4a', '--lang=auto']).file, 'a.m4a');
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.match(parseArgs(['a.m4a', '--lang', 'en']).error, /only auto; Parakeet v3 detects the language/);
  assert.match(parseArgs(['a.m4a', '--srt', '--vtt']).error, /pick one format/);
  assert.match(parseArgs(['a.m4a', '--srt', '-o', 'a.vtt']).error, /--srt but -o a\.vtt ends in \.vtt/);
  assert.match(parseArgs(['a.m4a', 'b.m4a']).error, /one file per call/);
  assert.match(parseArgs([]).error, /name an audio or video file/);
  assert.match(parseArgs(['a.m4a', '-o']).error, /-o needs a path/);
  assert.match(parseArgs(['a.m4a', '--speakers']).error, /unknown option --speakers/);
});

const W = (text, start, end, confidence) => ({ text, start_time: start, end_time: end, ...(confidence !== undefined ? { confidence } : {}) });
const words = [W('Four', 0.32, 0.6, 0.98), W('score', 0.6, 0.9), W('years', 0.9, 1.3), W('ago.', 1.3, 1.8),
  W('Now', 3.5, 3.7), W('we', 3.7, 3.8), W('are', 3.8, 4.0), W('engaged', 4.0, 4.6),
  W('in', 5.8, 5.9), W('a', 5.9, 6.0), W('great', 6.0, 6.3), W('civil', 6.3, 6.7), W('war,', 6.7, 7.2)];
const meta = { source: '/work/i.m4a', duration: 7.5, model: 'Parakeet TDT 0.6B v3', attribution: 'NVIDIA, CC-BY-4.0' };

await t('cues: a sentence end, a pause and the length caps start a new cue', () => {
  assert.deepEqual(cues(words), [
    { start: 0.32, end: 1.8, text: 'Four score years ago.' },
    { start: 3.5, end: 4.6, text: 'Now we are engaged' },
    { start: 5.8, end: 7.2, text: 'in a great civil war,' }]);
  const run = Array.from({ length: 40 }, (_, i) => W('word', i * 0.3, i * 0.3 + 0.25));
  for (const c of cues(run)) { assert.ok(c.end - c.start <= CUE_SECONDS); assert.ok(c.text.length <= CUE_CHARS); }
  const wide = Array.from({ length: 30 }, (_, i) => W('extraordinary', i * 0.1, i * 0.1 + 0.09));
  assert.ok(cues(wide).every((c) => c.text.length <= CUE_CHARS), 'the character cap holds inside a short span');
  assert.deepEqual(cues([W('  ', 0, 1), W('Hi.', 1, 1.2)]), [{ start: 1, end: 1.2, text: 'Hi.' }], 'blank words are dropped');
});

await t('clock and stamp: SRT and VTT times, [mm:ss] and [h:mm:ss]', () => {
  assert.equal(clock(3725.5, ','), '01:02:05,500');
  assert.equal(clock(0.0004, '.'), '00:00:00.000');
  assert.equal(clock(59.9996, '.'), '00:01:00.000', 'rounds to the millisecond, carrying');
  assert.equal(stamp(65.9), '[01:05]');
  assert.equal(stamp(3725), '[1:02:05]');
});

await t('the four formats', () => {
  const list = cues(words);
  assert.equal(toSrt(list), '1\n00:00:00,320 --> 00:00:01,800\nFour score years ago.\n\n2\n00:00:03,500 --> 00:00:04,600\nNow we are engaged\n\n3\n00:00:05,800 --> 00:00:07,200\nin a great civil war,\n');
  const vtt = toVtt(list, meta);
  assert.ok(vtt.startsWith('WEBVTT\n\nNOTE\nTranscribed in this browser from /work/i.m4a by Parakeet TDT 0.6B v3 (NVIDIA, CC-BY-4.0).\nSpeakers are not separated.\n\n00:00:00.320 --> 00:00:01.800\nFour score years ago.\n'), vtt);
  assert.ok(!toVtt(list, { ...meta, source: '/work/a-->b.m4a' }).includes('a-->b'), 'a cue arrow in a name cannot end the NOTE');
  assert.equal(toTxt(list), '[00:00] Four score years ago.\n[00:03] Now we are engaged\n[00:05] in a great civil war,\n');
  const j = JSON.parse(toJson(list, words, 'Four score years ago. Now we are engaged in a great civil war,', meta));
  assert.equal(j.speakers, null); assert.equal(j.language, 'auto'); assert.equal(j.segments.length, 3);
  assert.deepEqual(j.words[0], { start: 0.32, end: 0.6, text: 'Four', confidence: 0.98 });
  assert.deepEqual(j.words[1], { start: 0.6, end: 0.9, text: 'score' }, 'no confidence when the model gave none');
  assert.equal(render('txt', [], '', meta), '', 'no words, no lines');
});

await t('support: phones, tablets, small memory, no WebGPU, no shader-f16 are refused with what to do', async () => {
  const gpu = (features) => ({ requestAdapter: async () => ({ features: new Set(features) }) });
  const ok = { userAgent: 'Mozilla/5.0 (Macintosh)', deviceMemory: 8, gpu: gpu(['shader-f16']) };
  assert.deepEqual(await support(ok), { ok: true });
  for (const nav of [{ ...ok, userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) Mobile' }, { ...ok, userAgentData: { mobile: true } },
    { ...ok, maxTouchPoints: 5 }, { ...ok, deviceMemory: 4 }]) {
    const r = await support(nav);
    assert.equal(r.ok, false); assert.match(r.reason, /phones and tablets.*Transcribe on a computer with a recent Chrome or Edge/);
  }
  assert.match((await support({ ...ok, gpu: undefined })).reason, /WebGPU is not available/);
  assert.match((await support({ ...ok, gpu: gpu([]) })).reason, /lacks shader-f16, which the model's fp16 encoder needs/);
  assert.match((await parakeetGpu({ requestAdapter: async () => null })).reason, /no usable graphics adapter/);
});

// Fakes: a media engine that answers wc.audio with an f32 WAV, a Parakeet engine that returns words.
const f32wav = (seconds) => { const n = Math.round(seconds * 16000), data = new Float32Array(n).fill(0.1), out = new Uint8Array(44 + n * 4);
  out.set(wavHeader('pcm_f32le', 16000, 1, n * 4)); out.set(new Uint8Array(data.buffer), 44); return out; };
const asked = [];
const mediaFake = { label: 'fake libav', memory: 1, create: () => ({ async run(input) {
  asked.push({ engine: 'media', ...input, input: { ...input.input, bytes: input.input.bytes.length } });
  if (input.input.label.endsWith('silent.wav')) return { files: [{ name: 'out0.wav', bytes: f32wav(1) }], rate: 16000, channels: 1, source: { codec: 'pcm_s16le', rate: 16000, channels: 1 } };
  if (input.input.label.endsWith('long.m4a')) throw Object.assign(new Error('/work/long.m4a is 3:00:00 long; the cap is 2:00:00 (MAX_INPUT_SECONDS)'), { code: 'ECAP' });
  return { files: [{ name: 'out0.wav', bytes: f32wav(7.5) }], rate: 16000, channels: 1, source: { codec: 'aac', rate: 44100, channels: 2 } };
} }) };
const asrFake = { label: 'fake parakeet', memory: 1, hang: false, create: () => ({ async run(job, { signal, note }) {
  asked.push({ engine: 'parakeet', samples: job.pcm.length, label: job.label });
  note('transcribing 0:00 to 1:30 of 7:30 (0%)');
  if (asrFake.hang) await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('Stopped.', 'AbortError'))));
  if (job.label.endsWith('silent.wav')) return { text: '', words: [], seconds: 1, ms: 50, windows: 1 };
  return { text: 'Four score years ago. Now we are engaged in a great civil war,', words, seconds: job.pcm.length / 16000, ms: 150, windows: 1 };
} }) };
const SIZE = model.files.reduce((n, f) => n + f.bytes, 0) + PIN.runtime.bytes;
// The add-ons service as transcribe reads it: get, and status (installed, size, what is kept, a reason).
const fakeAddons = ({ complete, supported }) => ({ get: (id) => REGISTRY.find((d) => d.id === id),
  status: async () => ({ installed: complete, size: SIZE, bytes: complete ? SIZE : Math.round(SIZE / 4), tier: 'asked',
    ...(supported ? {} : { reason: 'this browser\'s WebGPU lacks shader-f16, which the model\'s fp16 encoder needs. Transcribe on a computer with a recent Chrome or Edge.' }) }) });
function rig({ complete = true, supported = true } = {}) {
  const fs = new InMemoryFs(), tasks = new Tasks();
  const media = createMediaService({ tasks, worker: mediaFake });
  const transcribe = createAsrService({ tasks, media, addons: fakeAddons({ complete, supported }), pin: PIN, worker: asrFake });
  const shell = shellFor(fs, { media, transcribe });
  return { fs, tasks, sh: (c, o = {}) => shell.exec(c, { cwd: '/work', ...o }) };
}

await t('the command: decode then transcribe as two /task jobs; -o writes the format; stdout prints it', async () => {
  const { fs, tasks, sh } = rig();
  await fs.mkdir('/work/interviews', { recursive: true });
  await fs.writeFile('/work/interviews/i1.m4a', new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]));
  let r = await sh('transcribe interviews/i1.m4a --srt -o interviews/i1.srt');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /^wrote \/work\/interviews\/i1\.srt \(srt, \d+ bytes\): 0:08 of audio in 0\.\d s \(50x real time\), 13 words\. Speakers are not separated\.\n$/);
  assert.ok((await fs.readFile('/work/interviews/i1.srt')).startsWith('1\n00:00:00,320 --> 00:00:01,800\nFour score years ago.\n'));
  const dec = asked.find((a) => a.engine === 'media');
  assert.equal(dec.action, 'wc.audio'); assert.equal(dec.kind, 'mp4', 'sniffed as MP4/M4A: the WebCodecs path');
  assert.deepEqual([dec.rate, dec.channels, dec.out.codec, dec.out.format, dec.maxSeconds], [16000, 1, 'pcm_f32le', 'wav', MAX_SECONDS]);
  assert.equal(asked.find((a) => a.engine === 'parakeet').samples, 7.5 * 16000, 'the samples after the 44-byte header');
  const labels = tasks.list().map((x) => x.label);
  assert.ok(labels.includes('transcribe i1.m4a (decode)') && labels.includes('transcribe i1.m4a (0:08)'), labels.join(', '));
  r = await sh('transcribe interviews/i1.m4a');
  assert.equal(r.stdout, '[00:00] Four score years ago.\n[00:03] Now we are engaged\n[00:05] in a great civil war,\n');
  assert.match(r.stderr, /13 words\. Speakers are not separated\./);
  assert.equal((await sh('transcribe interviews/i1.m4a --json -o interviews/i1.json')).exitCode, 0);
  assert.equal(JSON.parse(await fs.readFile('/work/interviews/i1.json')).words.length, 13);
  r = await sh('transcribe interviews/i1.m4a --vtt -o interviews/i1.json');
  assert.equal(r.exitCode, 2); assert.match(r.stderr, /--vtt but -o interviews\/i1\.json ends in \.json/);
  r = await sh('transcribe interviews/i1.m4a -o interviews/i1.srt');
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /i1\.srt exists; add -y to overwrite/);
  r = await sh('transcribe interviews/i1.m4a -y -o interviews/i1.srt'); assert.equal(r.exitCode, 0, r.stderr);
  r = await sh('transcribe --help'); assert.equal(r.stdout, HELP);
  assert.ok(HELP.includes(DIARIZATION_GAP), 'the help states the diarization gap (story TR7)');
});

await t('refusals: not downloaded, cannot run here, no file, a folder, over the caps, no speech', async () => {
  let { fs, sh } = rig({ complete: false });
  await fs.mkdir('/work', { recursive: true }); await fs.writeFile('/work/a.wav', new Uint8Array(64));
  const n = asked.length;
  let r = await sh('transcribe a.wav');
  assert.equal(r.exitCode, 1);
  assert.equal(r.stderr, `transcribe: not installed: Parakeet TDT 0.6B v3 (${sizeText(SIZE)}). Run \`addons install parakeet-tdt-0.6b-v3\`; the user will be asked.\n`);
  ({ fs, sh } = rig({ supported: false, complete: true }));
  await fs.mkdir('/work', { recursive: true }); await fs.writeFile('/work/a.wav', new Uint8Array(64));
  r = await sh('transcribe a.wav');
  assert.match(r.stderr, /^transcribe: not available here: .*lacks shader-f16.* \(Parakeet TDT 0\.6B v3 is installed; `addons remove parakeet-tdt-0\.6b-v3` frees the space\)\.\n$/);
  ({ fs, sh } = rig({ supported: false, complete: false }));
  await fs.mkdir('/work/d', { recursive: true }); await fs.writeFile('/work/a.wav', new Uint8Array(64));
  r = await sh('transcribe a.wav');
  assert.match(r.stderr, /^transcribe: not available here: this browser's WebGPU lacks shader-f16.*; nothing was fetched \(Parakeet TDT 0\.6B v3\)\.\n$/);
  assert.equal(asked.length, n, 'no job for a refusal');
  ({ fs, sh } = rig());
  await fs.mkdir('/work/d', { recursive: true });
  r = await sh('transcribe nope.m4a'); assert.match(r.stderr, /\/work\/nope\.m4a: No such file or directory/);
  r = await sh('transcribe d'); assert.match(r.stderr, /is a folder; run transcribe once per file/);
  await fs.writeFile('/work/big.mp4', new Uint8Array(8));
  const stat = fs.stat.bind(fs);
  fs.stat = async (p) => (p.endsWith('big.mp4') ? { ...(await stat(p)), size: MAX_INPUT_BYTES + 1 } : stat(p));
  r = await sh('transcribe big.mp4'); assert.match(r.stderr, /the cap is 256 MiB \(MAX_INPUT_BYTES\)\. For a long video call, export its audio/);
  await fs.writeFile('/work/long.m4a', new Uint8Array(8));
  r = await sh('transcribe long.m4a'); assert.match(r.stderr, /the cap is 2:00:00 \(MAX_SECONDS\)/);
  await fs.writeFile('/work/silent.wav', new Uint8Array(8));
  r = await sh('transcribe silent.wav -o s.txt'); assert.equal(r.exitCode, 0); assert.match(r.stderr, /no speech found/); assert.equal(await fs.exists('/work/s.txt'), false);
});

await t('Stop through /task: the transcription job ends, exit 130, nothing written', async () => {
  const { fs, tasks, sh } = rig();
  await fs.mkdir('/work', { recursive: true }); await fs.writeFile('/work/a.wav', new Uint8Array(64));
  asrFake.hang = true;
  const p = sh('transcribe a.wav -o a.txt');
  let live;
  for (let i = 0; i < 200 && !live; i++) { await new Promise((res) => setTimeout(res, 2)); live = tasks.list().find((x) => x.label.startsWith('transcribe a.wav (0:') && x.status === 'running'); }
  assert.ok(live, 'the transcription is a running /task job'); await tasks.kill(live);
  const r = await p;
  asrFake.hang = false;
  assert.equal(r.exitCode, 130, r.stderr); assert.match(r.stderr, /stopped \(\/task\/\d+\)/);
  assert.equal(await fs.exists('/work/a.txt'), false);
});

await t('removing the add-on unloads the worker: a transcription still running ends with a reason, never hangs', async () => {
  // The real asrWorker with a fake Worker: it loads, then never answers the transcription.
  let w;
  const spawn = () => (w = { terminated: false, onmessage: null, onerror: null, terminate() { this.terminated = true; },
    postMessage(m) { if (m.action === 'load') queueMicrotask(() => this.onmessage({ data: { id: m.id, result: { loaded: true } } })); } });
  const addons = { files: async () => ({ [PIN.model.id]: { files: {} }, 'parakeet-runtime': { files: { 'worker.js': new Blob([]) } } }) };
  const engine = asrWorker({ addons, pin: PIN, spawn }).create();
  const running = engine.run({ action: 'transcribe', pcm: new Float32Array(16), label: 'a.wav' }, { signal: new AbortController().signal, note: () => {} });
  for (let i = 0; i < 50 && !w; i++) await new Promise((res) => setTimeout(res, 1));
  await new Promise((res) => setTimeout(res, 5));
  engine.dispose();
  await assert.rejects(running, /Parakeet was removed while this job ran/);
  assert.ok(w.terminated);
});

await t('consent (TR1): `addons install parakeet` resolves past the hidden runtime; the sheet says size, origin, where it runs, license and attribution', async () => {
  const entries = REGISTRY.filter((d) => d.id === model.id || d.id === 'parakeet-runtime').map((d) => ({ ...d, device: () => ({ ok: true }) }));
  let seen = null;
  const addons = createAddons({ entries, tasks: new Tasks(), approve: async (req) => { seen = req; return false; },
    backend: (d) => backendOf(d, { fetchImpl: async () => new Response(JSON.stringify({ releases: [] })) }) });
  await assert.rejects(addons.install('parakeet', { by: 'user', via: 'terminal' }), /denied by the user: nothing was installed \(Parakeet TDT 0\.6B v3\)/);
  assert.equal(seen.items.length, 1, 'one add-on, its runtime included in its size');
  const [it] = seen.items;
  assert.equal(it.size, SIZE); assert.match(sizeText(it.size), /^1\.3 GB$/);
  assert.match(it.runs, /only in this browser, on this computer's GPU/);
  assert.equal(it.license, 'MIT (parakeet.js, ONNX Runtime Web; NOTICE.txt); CC-BY-4.0', 'the runtime\'s license and the model\'s');
  assert.match(it.attribution, /^Parakeet TDT 0\.6B v3 by NVIDIA .*CC-BY-4\.0; ONNX export by istupakov, FP16 conversion by ysdede; used unmodified$/);
  assert.ok(it.from.some((f) => /api\.bayleaf\.dev/.test(f)) && it.from.length === 2, `from the gateway and this origin: ${it.from}`);
  assert.match(readFileSync('src/interface/session-list.ts', 'utf8'), /row\('Runs', i\.runs\)/, 'the sheet shows where it runs');
});

await t('registered in both shells; the media skill and system prompt name it', () => {
  const src = readFileSync('src/tools.ts', 'utf8');
  assert.equal((src.match(/\.\.\.transcribeCommands\(defineCommand, hooks\.transcribe/g) ?? []).length, 2, 'terminal shellFor and agent bashFor');
  const defaults = readFileSync('src/defaults.ts', 'utf8');
  assert.match(defaults, /transcribe/); assert.match(defaults, /Speakers are not separated/);
});

await t('build: runtime parts, no CDN default, no hub.js, the lock\'s pins', async () => {
  const out = scratch;
  try {
    const { sums, pin } = built;
    assert.equal(pin.runtime.dir, 'runtime/parakeet/');
    assert.ok(sums.every(([, p]) => p.startsWith('runtime/parakeet/')));
    const man = JSON.parse(readFileSync(join(out, pin.runtime.dir, pin.runtime.manifest), 'utf8'));
    assert.deepEqual(man.files.map((f) => f.name), ['worker.js', 'ort-wasm-simd-threaded.asyncify.wasm', 'NOTICE.txt']);
    const notice = Buffer.concat(man.files[2].parts.map((p) => readFileSync(join(out, pin.runtime.dir, p.path)))).toString('utf8');
    assert.match(notice, /parakeet\.js LICENSE/); assert.match(notice, /Copyright \(c\) Microsoft Corporation/);
    assert.equal(man.files[1].sha256, lock.runtime['onnxruntime-web'].files[0].sha256, 'the same wasm the Transformers.js runtime ships');
    const worker = Buffer.concat(man.files[0].parts.map((p) => readFileSync(join(out, pin.runtime.dir, p.path)))).toString('utf8');
    assert.ok(!/jsdelivr|huggingface\.co\/(?!docs)|parakeet-cache-db/.test(worker), 'no CDN, no Hub, no fromHub cache');
    assert.deepEqual(pin.model.files.map((f) => f.name), ['config.json', 'vocab.txt', 'decoder_joint-model.fp16.onnx', 'encoder-model.fp16.onnx']);
    assert.equal(pin.model.files.reduce((n, f) => n + f.bytes, 0), 1275328825);
    assert.deepEqual([pin.encoder, pin.decoder, pin.vocab], ['encoder-model.fp16.onnx', 'decoder_joint-model.fp16.onnx', 'vocab.txt']);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

console.log(`parakeet-node: ${pass} passed`);
