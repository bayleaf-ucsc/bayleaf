// The media commands without a browser (src/media.ts): argument parsing,
// time syntax, the image path's plan, log tidying, caps, error messages, the
// commands in the terminal's shell and the agents' bash, jobs with a fake
// engine, and the build's pins, source and containment (build-libav.mjs);
// the WebCodecs path's pure parts (src/media/wc.ts): sniffing, codec strings,
// MP3 frames, WAV in and out, the -vf subset and fps choice, ffprobe's
// writers, the audio plan, and the routing with a fake engine.
// The real runtime: test/media-browser.mjs.
// Run: node test/media-node.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryFs } from 'just-bash';
import { parseProbe, parseFfmpeg, parseTime, imagePlan, frameName, tidy, createMediaService, mediaCommands, HELP,
  MAX_INPUT_BYTES, MAX_IMAGES, MAX_STDERR_LINES, MAX_OUTPUT_BYTES, writeProbe, audioPlan } from '../src/media.ts';
import { sniff, codecString, mp3Frames, readWav, wavHeader, wavBytes, rotationOf, vfPlan, geometry, fpsPicker } from '../src/media/wc.ts';
import { Tasks } from '../src/ns/tasks.ts';
import { shellFor } from '../src/tools.ts';
import { buildLibav, LIBAV, SOURCES, UNLINKED } from '../build-libav.mjs';
import { assertNoCdn } from '../build-runtime.mjs';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('ok', name); };

await t('parseProbe: switches, values, one file, no pipes or -o', () => {
  assert.deepEqual(parseProbe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', 'a.webm']),
    { args: ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', { file: 0 }], files: ['a.webm'] });
  assert.deepEqual(parseProbe(['-i', 'x.wav', '-show_entries', 'format=duration']).files, ['x.wav']);
  assert.deepEqual(parseProbe(['--help']), { help: true });
  assert.match(parseProbe([]).error, /needs a FILE/);
  assert.match(parseProbe(['a', 'b']).error, /one file per call/);
  assert.match(parseProbe(['-']).error, /no pipes or URLs/);
  assert.match(parseProbe(['https://x.org/a.webm']).error, /no pipes or URLs/);
  assert.match(parseProbe(['-o', 'r.json', 'a.webm']).error, /redirect it/);
  assert.match(parseProbe(['a.webm', '-of']).error, /-of needs a value/);
});

await t('parseFfmpeg: inputs, outputs, per-file options, info flags, refusals', () => {
  const a = parseFfmpeg(['-y', '-ss', '5', '-i', 'in.webm', '-vn', '-c:a', 'copy', 'out.opus']);
  assert.deepEqual(a.args, ['-y', '-ss', '5', '-i', { input: 0 }, '-vn', '-c:a', 'copy', { output: 0 }]);
  assert.deepEqual(a.inputs, [{ path: 'in.webm', opts: [['y'], ['ss', '5', 'ss']] }]);
  assert.deepEqual(a.outputs, [{ path: 'out.opus', opts: [['vn'], ['c', 'copy', 'c:a']] }]);
  assert.ok(a.flags.has('y'));
  assert.equal(parseFfmpeg(['-i', 'a.webm', '-i', 'b.wav', '-map', '0:v', '-map', '1:a', 'o.webm']).inputs.length, 2);
  assert.equal(parseFfmpeg(['-codecs']).info, true);
  assert.equal(parseFfmpeg(['-L']).info, true);
  assert.match(parseFfmpeg(['-i', 'a.webm']).error, /needs an output/);
  assert.match(parseFfmpeg(['out.webm']).error, /needs an input/);
  assert.match(parseFfmpeg(['-i', '-', 'o.webm']).error, /no pipes/);
  assert.match(parseFfmpeg(['-i', 'a.webm', 'pipe:1']).error, /no pipes/);
  assert.match(parseFfmpeg(['-i', 'http://x/a.webm', 'o.webm']).error, /no pipes, URLs or protocols/);
  assert.match(parseFfmpeg(['-i', 'a.webm', '-c:v']).error, /-c:v needs a value/);
});

await t('parseTime: FFmpeg time syntax', () => {
  assert.equal(parseTime('12.5'), 12.5); assert.equal(parseTime('90'), 90); assert.equal(parseTime('1:30'), 90);
  assert.equal(parseTime('01:02:03.5'), 3723.5); assert.equal(parseTime('500ms'), 0.5); assert.equal(parseTime('.25'), 0.25);
  assert.ok(Number.isNaN(parseTime('soon')));
});

await t('imagePlan: -ss/-t/-to, -vf and -r, frames, quality, patterns, refusals', () => {
  const plan = (argv) => imagePlan(parseFfmpeg(argv));
  assert.deepEqual(plan(['-i', 'v.webm', '-vf', 'fps=1/10,scale=640:-1', 'f/f-%03d.png']),
    { path: 'f/f-%03d.png', pattern: true, ss: 0, t: null, filters: ['fps=1/10', 'scale=640:-1'], want: Infinity, quality: 0.9, start: 1, type: 'image/png' });
  const s = plan(['-ss', '00:01:05', '-i', 'v.webm', '-frames:v', '1', '-q:v', '2', 'still.jpg']);
  assert.equal(s.ss, 65); assert.equal(s.want, 1); assert.equal(s.quality, 1); assert.equal(s.type, 'image/jpeg'); assert.equal(s.pattern, false);
  assert.equal(plan(['-i', 'v.webm', 'one.png']).want, 1, 'one file name writes the first frame');
  assert.deepEqual(plan(['-i', 'v.webm', '-ss', '10', '-to', '30', '-r', '0.5', 'p%d.png']).filters, ['fps=0.5']);
  assert.equal(plan(['-i', 'v.webm', '-ss', '10', '-to', '30', 'p%d.png']).t, 20);
  assert.equal(plan(['-i', 'v.webm', '-start_number', '0', 'p%d.webp']).start, 0);
  assert.match(plan(['-i', 'v.webm', '-frames:v', '3', 'one.png']).error, /use a pattern such as frame-%03d\.png/);
  assert.match(plan(['-i', 'v.webm', '-c:v', 'libx264', 'o.png']).error, /PNG, JPEG or WebP/);
  assert.match(plan(['-i', 'v.webm', '-b:v', '1M', 'o.png']).error, /-b:v is not supported when writing images/);
  assert.match(plan(['-i', 'a.webm', '-i', 'b.webm', 'o.png']).error, /one input/);
  assert.match(plan(['-i', 'a.webm', '-ss', 'x', 'o.png']).error, /not a time/);
  assert.match(plan(['-i', 'a.webm', '-ss', '9', '-to', '3', 'o.png']).error, /is not after/);
  assert.match(plan(['-i', 'a.webm', '-filter_complex', 'x', 'o.png']).error, /not supported when writing images/);
  assert.equal(frameName('f-%03d.png', 7), 'f-007.png'); assert.equal(frameName('f%d.png', 12), 'f12.png'); assert.equal(frameName('f%2d.png', 3), 'f03.png');
});

await t('tidy: no progress lines, head and tail kept, libav names mapped back', () => {
  assert.equal(tidy('frame=  10 fps=0.0 q=0.0 size=1kB time=00:00:01.00\nInput #0, matroska, from \'in0.webm\':\n', [['in0.webm', '/work/a.webm']]),
    "Input #0, matroska, from '/work/a.webm':\n");
  const long = tidy(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
  const lines = long.trim().split('\n');
  assert.equal(lines.length, MAX_STDERR_LINES + 1); assert.equal(lines[0], 'line 0'); assert.equal(lines.at(-1), 'line 499');
  assert.match(long, /\[\.\.\. 440 lines of FFmpeg's log cut \.\.\.\]/);
  assert.equal(tidy(''), '');
});

// A fake engine: answers like the worker, records what it was asked.
const asked = [];
const fake = { label: 'fake libav', memory: 1, create: () => ({ async run(input, { signal }) {
  asked.push(input);
  if (fake.hang) await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('Stopped.', 'AbortError'))));
  if (input.action === 'wc.audio') throw Object.assign(new Error(`${input.input.label}: no audio`), { code: 'ENOAUDIO' });
  if (input.action === 'frames') {
    if (input.input.label.endsWith('.mp4')) throw Object.assign(new Error(`${input.input.label}: cannot open it (Invalid data)`), { code: 'EFORMAT' });
    return { width: 64, height: 48, images: [0, 10, 20].slice(0, Math.min(3, input.want)).map((s) => ({ t: s, width: 32, height: 24, bytes: new Uint8Array([137, 80, 78, 71]) })) };
  }
  if (input.program === 'ffprobe') return { code: 0, stdout: `{ "format": { "filename": "${input.inputs[0].name}" } }`, stderr: '', files: [] };
  if (input.args.includes('-codecs')) return { code: 0, stdout: ' DEV.L. vp8', stderr: '', files: [] };
  const empty = input.args.includes('pcm_s16le');
  return { code: 0, stdout: '', stderr: `Input #0, matroska,webm, from '${input.inputs[0].name}':\nframe=  1 fps=0 size=0kB time=00:00:00.00\nOutput #0, ogg, to '${input.outputs[0]}':`,
    files: input.outputs.map((name) => ({ name, bytes: empty ? new Uint8Array(0) : new Uint8Array([79, 103, 103, 83]) })) };
} }) };

await t('the commands in the terminal shell: mapping, outputs, -y, gaps, /task jobs, Stop', async () => {
  const fs = new InMemoryFs(), tasks = new Tasks();
  await fs.mkdir('/work', { recursive: true });
  await fs.writeFile('/work/a.webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  await fs.writeFile('/work/c.mp4', new Uint8Array([0, 0, 0, 0x18]));
  const shell = shellFor(fs, { media: createMediaService({ tasks, engine: fake }) });
  const sh = async (c) => shell.exec(c, { cwd: '/work' });
  let r = await sh('ffprobe --help'); assert.equal(r.exitCode, 0); assert.equal(r.stdout, HELP.ffprobe);
  r = await sh('ffmpeg -h'); assert.equal(r.stdout, HELP.ffmpeg);
  r = await sh('ffprobe -v error -show_format -of json a.webm');
  assert.equal(r.exitCode, 0, r.stderr); assert.equal(JSON.parse(r.stdout).format.filename, '/work/a.webm');
  assert.deepEqual(asked.at(-1).args, ['-hide_banner', '-v', 'error', '-show_format', '-of', 'json', 'in0.webm']);
  await fs.writeFile('/work/a"b\\.webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  r = await sh(`ffprobe -of json 'a"b\\.webm'`);
  assert.equal(JSON.parse(r.stdout).format.filename, '/work/a"b\\.webm', 'a quote or backslash in a name keeps the JSON valid');
  const n = asked.length;
  r = await sh('ffmpeg -y -i a.webm -an ./a.webm');
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /Output \/work\/a\.webm is the same as an input/); assert.equal(asked.length, n, 'refused before any job');
  r = await sh('ffmpeg -i a.webm -vn -c:a copy sub/voice.opus');
  assert.equal(r.exitCode, 0, r.stderr); assert.equal(r.stdout, 'wrote /work/sub/voice.opus (4 bytes)\n');
  assert.equal(r.stderr, "Input #0, matroska,webm, from '/work/a.webm':\nOutput #0, ogg, to '/work/sub/voice.opus':\n", 'no progress line; real paths');
  assert.deepEqual(asked.at(-1).args, ['-hide_banner', '-nostdin', '-nostats', '-y', '-i', 'in0.webm', '-vn', '-c:a', 'copy', 'out0.opus']);
  assert.equal(asked.at(-1).maxOutputBytes, MAX_OUTPUT_BYTES);
  r = await sh('ffmpeg -i a.webm -vn -c:a copy sub/voice.opus');
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /File '\/work\/sub\/voice\.opus' already exists\. Exiting \(use -y to overwrite\)/);
  r = await sh('ffmpeg -i a.webm -c:a pcm_s16le x.wav');
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /\/work\/a\.webm: no audio/); assert.equal(asked.at(-1).action, 'wc.audio', 'nothing written: retried on the conversion path');
  assert.equal(await fs.exists('/work/x.wav'), false);
  r = await sh('ffmpeg -i a.webm -vf fps=1/10 f/f-%03d.png');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout, 'wrote /work/f/f-001.png (t=0s, 32x24)\nwrote /work/f/f-002.png (t=10s, 32x24)\nwrote /work/f/f-003.png (t=20s, 32x24)\n');
  assert.deepEqual(asked.at(-1).filters, ['fps=1/10']); assert.equal(asked.at(-1).maxImages, MAX_IMAGES);
  r = await sh('ffmpeg -i a.webm -vf fps=1/10 f/f-%03d.png'); assert.equal(r.exitCode, 1, 'images also need -y to overwrite');
  r = await sh('ffmpeg -i a.webm o.png o.webm'); assert.match(r.stderr, /separate calls/);
  r = await sh('ffmpeg -i a.webm o%d.webm'); assert.match(r.stderr, /for images only/);
  r = await sh('ffmpeg -i c.mp4 still.png');
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /cannot open it/); assert.match(r.stderr, /hint: this build reads and writes WebM/);
  r = await sh('ffmpeg -codecs'); assert.equal(r.exitCode, 0); assert.match(r.stdout, /vp8/);
  r = await sh('ffmpeg -i nope.webm o.opus'); assert.equal(r.exitCode, 1); assert.match(r.stderr, /\/work\/nope\.webm: No such file or directory/);
  assert.ok(tasks.list().every((x) => x.kind === 'job') && tasks.list().length >= 6, 'each run is a /task job');
  assert.equal(tasks.list()[0].label, 'ffprobe a.webm');
  fake.hang = true;
  const run = shell.exec('ffmpeg -y -i a.webm -c:v libvpx-vp9 big.webm', { cwd: '/work' });
  let live;
  for (let i = 0; i < 200 && !live; i++) { await new Promise((r) => setTimeout(r, 1)); live = tasks.list().find((x) => x.status === 'running'); }
  assert.ok(live); assert.equal(live.label, 'ffmpeg a.webm'); await tasks.kill(live);
  r = await run; assert.equal(r.exitCode, 130); assert.match(r.stderr, /stopped \(\/task\/\d+\)/);
  assert.equal(await fs.exists('/work/big.webm'), false);
  fake.hang = false;
});

await t('input size cap before anything loads', async () => {
  const fs = new InMemoryFs();
  await fs.mkdir('/work', { recursive: true });
  await fs.writeFile('/work/big.webm', 'x');
  const big = new Proxy(fs, { get: (t, k) => (k === 'stat' ? async (p) => ({ ...(await t.stat(p)), size: MAX_INPUT_BYTES + 1 }) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const before = asked.length;
  const [probe, ffmpeg] = mediaCommands((name, fn) => ({ name, fn }), createMediaService({ tasks: new Tasks(), engine: fake }));
  let r = await probe.fn(['big.webm'], { fs: big, cwd: '/work' });
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /the cap is 256 MiB \(MAX_INPUT_BYTES\)/);
  r = await ffmpeg.fn(['-i', 'big.webm', 'o.opus'], { fs: big, cwd: '/work' });
  assert.match(r.stderr, /MAX_INPUT_BYTES/);
  assert.equal(asked.length, before, 'the engine was never asked');
});

await t('no service and no runtime: clear errors', async () => {
  const fs = new InMemoryFs();
  await fs.mkdir('/work', { recursive: true }); await fs.writeFile('/work/a.webm', 'x');
  let r = await shellFor(fs, {}).exec('ffprobe a.webm', { cwd: '/work' });
  assert.match(r.stderr, /the media runtime is not available here/);
  r = await shellFor(fs, { media: createMediaService({ tasks: new Tasks() }) }).exec('ffprobe a.webm', { cwd: '/work' });
  assert.match(r.stderr, /no media runtime/);
});

await t('agents get the same commands (createTools bash)', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/tools.ts'), 'utf8');
  assert.equal((src.match(/\.\.\.mediaCommands\(defineCommand, hooks\.media/g) ?? []).length, 2, 'terminal shellFor and agent bashFor');
});

await t('build: pinned libav.js variant, no CDN, source shipped alongside', async () => {
  const out = mkdtempSync(join(tmpdir(), 'pouch-libav-node-'));
  try {
    const { pin, source, sums } = await buildLibav(out);
    const read = (p, name) => { const m = JSON.parse(readFileSync(join(out, p.dir, p.manifest), 'utf8')); return [m, name && Buffer.concat(m.files.find((f) => f.name === name).parts.map((x) => readFileSync(join(out, p.dir, x.path))))]; };
    const [m, w] = read(pin, 'worker.js');
    assert.deepEqual(m.files.map((f) => f.name), ['worker.js', 'libav.wasm', 'libav-avf.wasm', 'NOTICE.txt']);
    assert.equal(m.files[1].sha256, LIBAV.sha256['dist/libav-6.10.9.0-webm-vp9-cli.wasm.wasm'], 'the released wasm, unmodified');
    assert.equal(m.files[2].sha256, LIBAV.avf.sha256['dist/libav-6.10.9.0-webcodecs-avf.wasm.wasm'], 'the WebCodecs path\'s released wasm, unmodified');
    assert.ok(m.files.every((f) => f.bytes <= 25 * 2 ** 20), 'every file under 25 MiB');
    assertNoCdn(w.toString(), 'libav worker');
    assert.ok(!/node:(module|fs|path|url|crypto)/.test(w.toString()), 'no Node imports');
    assert.ok(!w.toString().includes('self.location.href === import.meta.url'), 'libav.js\'s own worker bootstrap is off');
    assert.ok(pin.bytes < 9 * 2 ** 20, `runtime is ${pin.bytes} bytes`);
    const notice = read(pin, 'NOTICE.txt')[1].toString();
    for (const k of ['GNU LESSER GENERAL PUBLIC LICENSE', 'Version 2.1', 'libvpx', 'Opus', 'Yahweasel', 'webcodecs-avf', 'WebCodecs', source.manifest]) assert.ok(notice.includes(k), k);
    const [sm] = read(source);
    assert.deepEqual(sm.files.map((f) => [f.name, f.sha256]), [...SOURCES, ...UNLINKED].map(([f, , h]) => [f, h]));
    assert.ok(notice.includes('not linked') && UNLINKED.every(([f]) => notice.includes(f)), 'NOTICE names the unlinked sources');
    assert.ok(sm.files.every((f) => f.parts.every((p) => p.bytes <= 20 * 2 ** 20)), 'every part under the static-asset limit');
    assert.ok(sums.some(([, p]) => p === `${source.dir}${source.manifest}`), 'the source is in SHA256SUMS, so deploy.mjs uploads it');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

const fx = (f) => new Uint8Array(readFileSync(resolve(import.meta.dirname, 'fixtures/media', f)));

await t('WebCodecs routing: sniff MOV/MP4/M4A/MP3, leave WebM/WAV to the CLI build', () => {
  assert.equal(sniff(fx('scene.mov')), 'mp4'); assert.equal(sniff(fx('scene.mp4')), 'mp4'); assert.equal(sniff(fx('tone.m4a')), 'mp4');
  assert.equal(sniff(fx('tone.mp3')), 'mp3');
  assert.equal(sniff(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0])), 'mp3', 'ID3v2');
  for (const f of ['colors.webm', 'tone.wav', 'tone24.wav']) assert.equal(sniff(fx(f)), null, f);
  assert.equal(sniff(new Uint8Array(4)), null);
});

await t('codec strings, display rotation, MP3 frames', () => {
  assert.equal(codecString('h264', Uint8Array.from([1, 0x64, 0, 0x0a, 0xff])), 'avc1.64000a');
  assert.equal(codecString('h264', new Uint8Array(0)), null, 'Annex B without avcC: no description');
  // hvcC: Main profile, compat flags 0x60000000 (bits 1, 2), constraint 0x90, level 30.
  const hvcc = Uint8Array.from([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 30, 0xf0]);
  assert.equal(codecString('hevc', hvcc, 'hvc1'), 'hvc1.1.6.L30.90'); assert.equal(codecString('hevc', hvcc, 'hev1'), 'hev1.1.6.L30.90');
  assert.equal(codecString('aac', Uint8Array.from([0x12, 0x10])), 'mp4a.40.2'); assert.equal(codecString('aac', Uint8Array.from([0x2b, 0x92])), 'mp4a.40.5');
  assert.equal(codecString('prores', null), null);
  // As ffprobe reads them (av_display_rotation_get): the matrix -display_rotation 90 writes, and its opposite.
  assert.equal(rotationOf([0, -65536, 0, 65536, 0, 0, 0, 0, 1 << 30]), 90); assert.equal(rotationOf([0, 65536, 0, -65536, 0, 0, 0, 0, 1 << 30]), -90); assert.equal(rotationOf([65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30]), 0);
  const frames = mp3Frames(fx('tone.mp3'));
  assert.ok(frames.length >= 19 && frames.every((f) => f.sampleRate === 44100 && f.samples === 1152), `${frames.length} frames`);
});

await t('WAV: 24-bit read as float, written as s16 and s24', () => {
  const w = readWav(fx('tone24.wav'));
  assert.deepEqual([w.sampleRate, w.channels, w.bits, w.codec, w.data[0].length], [16000, 2, 24, 'pcm_s24le', 4000]);
  assert.ok(w.data[0].every((v) => v >= -1 && v < 1) && Math.max(...w.data[0]) > 0.05);
  const h = wavHeader('pcm_s24le', 16000, 2, 6);
  assert.equal(new DataView(h.buffer).getUint16(34, true), 24); assert.equal(new DataView(h.buffer).getUint32(28, true), 16000 * 6);
  assert.deepEqual([...wavBytes('pcm_s24le', Int32Array.from([0x12345600, -256]))], [0x56, 0x34, 0x12, 0xff, 0xff, 0xff]);
  assert.throws(() => readWav(fx('tone.mp3')), /not a RIFF WAVE/);
  const zero = fx('tone24.wav').slice(); zero[22] = 0; zero[23] = 0; // fmt channels = 0
  assert.throws(() => readWav(zero), /zero channels/);
});

await t('-vf on the WebCodecs path: fps, scale, crop; fps frame choice as ffmpeg makes it', () => {
  assert.deepEqual(vfPlan(['fps=1/10', 'scale=640:-1']), { rate: 0.1, ops: [{ scale: ['640', '-1'] }] });
  assert.match(vfPlan(['hflip']).error, /fps, scale, crop and null/);
  assert.deepEqual(geometry(vfPlan(['scale=640:-1']).ops, 1920, 1080), { sx: 0, sy: 0, sw: 1920, sh: 1080, w: 640, h: 360 });
  assert.equal(geometry(vfPlan(['scale=w=iw/2:h=-2']).ops, 1081, 607).h % 2, 0, '-2 rounds to even');
  assert.deepEqual(geometry(vfPlan(['crop=iw/2:ih/2:0:0', 'scale=100:-1']).ops, 400, 200), { sx: 0, sy: 0, sw: 200, sh: 100, w: 100, h: 50 });
  assert.match(geometry(vfPlan(['scale=a:b']).ops, 10, 10).error, /numbers, iw, ih/);
  // 3 s at 10 fps, fps=1: three slots at 0, 1, 2 (each the last frame rounding to it), as libav's fps filter gives.
  const pick = fpsPicker(1), got = [];
  for (let i = 0; i < 30; i++) got.push(...pick.push(i, i / 10).emit.map(([f, at]) => [f, at]));
  got.push(...pick.end(3).emit);
  assert.deepEqual(got, [[4, 0], [14, 1], [24, 2]]);
  const one = fpsPicker(0.1); for (let i = 0; i < 20; i++) one.push(i, i / 10);
  assert.deepEqual(one.end(2).emit, [[19, 0]], 'shorter than a slot: still one frame');
  assert.match(vfPlan(['fps=1/0']).error, /a rate such as/); assert.match(vfPlan(['fps=1000000000']).error, /at most 1000/);
  const capped = fpsPicker(1000, 3); capped.push('a', 0);
  assert.equal(capped.push('b', 3600).emit.length, 3, 'a long gap emits no more than the cap');
  const single = fpsPicker(1); single.push('only', 5);
  assert.deepEqual(single.end(Infinity).emit, [['only', 5]], 'one frame and no end: one image, no endless fill');
  assert.deepEqual(geometry(vfPlan(['crop=32:24:(iw-ow)/2:(ih-out_h)/2']).ops, 64, 48), { sx: 16, sy: 12, sw: 32, sh: 24, w: 32, h: 24 }, 'crop x and y take ow, oh, out_w, out_h');
  assert.deepEqual(geometry(vfPlan(['crop=32:24:48:0']).ops, 64, 48), { sx: 32, sy: 0, sw: 32, sh: 24, w: 32, h: 24 }, 'x keeps the crop inside, as ffmpeg');
});

const PROBE = { kind: 'mp4', notes: ['stream 0 (hevc): no decoder'], format: { nb_streams: 2, format_name: 'mov,mp4,m4a,3gp,3g2,mj2', format_long_name: 'QuickTime / MOV', start_time: 0, duration: 2, size: 1000, bit_rate: 4000, probe_score: 100, tags: { major_brand: 'qt' } },
  streams: [{ index: 0, codec_name: 'h264', codec_type: 'video', width: 64, height: 48, avg_frame_rate: '10/1', duration: 2, nb_frames: 20, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] },
    { index: 1, codec_name: 'aac', codec_type: 'audio', sample_rate: 44100, channels: 1, channel_layout: 'mono', duration: 2, profile: 'LC' }] };
await t('ffprobe writers for the WebCodecs path: json, default, csv, compact, flat, entries, select', () => {
  let w = writeProbe(PROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json'], '/w/a "q".mov');
  const j = JSON.parse(w.stdout);
  assert.equal(j.format.filename, '/w/a "q".mov'); assert.equal(j.format.duration, '2.000000'); assert.equal(j.format.nb_streams, 2);
  assert.equal(j.streams[1].sample_rate, '44100'); assert.equal(j.streams[0].width, 64); assert.equal(j.streams[0].side_data_list[0].rotation, 90);
  assert.equal(w.stderr, 'ffprobe: note: stream 0 (hevc): no decoder\n', '-v error keeps only the note');
  assert.equal(writeProbe(PROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1'], 'a').stdout, '2.000000\n');
  assert.equal(writeProbe(PROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0'], 'a').stdout, '2.000000\n');
  assert.equal(writeProbe(PROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name,sample_rate', '-of', 'csv=p=0'], 'a').stdout, 'aac,44100\n');
  assert.equal(writeProbe(PROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name:stream_side_data=rotation', '-of', 'csv=p=0'], 'a').stdout, 'h264,90\n');
  assert.equal(writeProbe(PROBE, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'default'], 'a').stdout, '[STREAM]\ncodec_name=h264\n[/STREAM]\n[STREAM]\ncodec_name=aac\n[/STREAM]\n');
  assert.match(writeProbe(PROBE, ['-v', 'error', '-show_streams', '-of', 'compact'], 'a').stdout, /^stream\|index=0\|codec_name=h264/);
  assert.equal(writeProbe(PROBE, ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0'], 'a').stdout, '"mov,mp4,m4a,3gp,3g2,mj2"\n', 'csv quotes a cell with commas');
  assert.equal(writeProbe(PROBE, ['-v', 'error', '-show_entries', 'format=filename', '-of', 'csv=p=0'], '/w/a "q",b.mov').stdout, '"/w/a ""q"",b.mov"\n');
  assert.equal(writeProbe(PROBE, ['-v', 'error', '-show_entries', 'format=filename', '-of', 'compact=p=0:nk=1'], 'a|b').stdout, 'a\\|b\n');
  assert.match(writeProbe(PROBE, ['-v', 'error', '-show_format', '-of', 'flat'], 'a').stdout, /^format\.filename="a"\nformat\.nb_streams=2\n/);
  assert.match(writeProbe(PROBE, ['-of', 'xml', '-show_format'], 'a').error, /json, default, csv, compact or flat/);
  w = writeProbe(PROBE, [], '/w/a.mov');
  assert.equal(w.stdout, ''); assert.match(w.stderr, /^Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '\/w\/a\.mov':\n  Duration: 00:00:02\.00, start: 0\.000000, bitrate: 4 kb\/s\n  Stream #0:0: Video: h264, 64x48, 10 fps, rotation 90\n  Stream #0:1: Audio: aac \(LC\), 44100 Hz, mono\n/);
});

await t('audio plan: WAV/FLAC/Opus out, codecs and formats, trims, refusals with what instead', () => {
  const plan = (args) => audioPlan(parseFfmpeg(args));
  assert.deepEqual(plan(['-i', 'a.mov', '-vn', 'a.wav']), { path: 'a.wav', ss: 0, t: null, filters: null, rate: null, channels: null, out: { format: 'wav', codec: 'pcm_s16le', sampleFmt: 's16' } });
  assert.deepEqual(plan(['-i', 'a.wav', '-c:a', 'pcm_s24le', 'b.wav']).out, { format: 'wav', codec: 'pcm_s24le', sampleFmt: 's32' });
  assert.deepEqual(plan(['-i', 'a.wav', '-sample_fmt', 'flt', 'b.wav']).out.codec, 'pcm_f32le');
  assert.equal(plan(['-i', 'a.wav', 'b.flac']).out.sampleFmt, null, 'FLAC depth follows the source');
  const o = plan(['-ss', '1:02', '-i', 'a.m4a', '-to', '70', '-ar', '16k', '-ac', '1', '-af', 'loudnorm', '-b:a', '32k', 'x.opus']);
  assert.deepEqual([o.ss, o.t, o.rate, o.channels, o.filters, o.out], [62, 8, 16000, 1, 'loudnorm', { format: 'ogg', codec: 'libopus', sampleFmt: 'flt', bitRate: 32000 }]);
  assert.match(plan(['-i', 'a.mov', 'b.mp4']).error, /writing \.mp4 from MOV\/MP4 is not available here.*QuickTime Export As/);
  assert.match(plan(['-i', 'a.m4a', '-c:a', 'copy', 'b.m4a']).error, /not available here/);
  assert.match(plan(['-i', 'a.mov', '-c:a', 'copy', 'b.wav']).error, /drop -c copy/);
  assert.match(plan(['-i', 'a.mov', '-c:a', 'aac', 'b.opus']).error, /written as Opus here/);
  assert.match(plan(['-i', 'a.mov', '-vf', 'scale=1:1', 'b.wav']).error, /-vf is not supported on this path/);
  assert.match(plan(['-i', 'a', '-i', 'b', 'c.wav']).error, /one input and one output/);
  assert.match(plan(['-i', 'a.mov', '-map', '0:v', 'c.wav']).error, /first audio stream/);
  assert.match(plan(['-i', 'a.mov', '-map', '0:a:1', 'c.wav']).error, /first audio stream/, 'a second track is refused, not swapped for the first');
  assert.equal(plan(['-i', 'a.mov', '-map', '0:a:0', 'c.wav']).error, undefined);
  assert.match(plan(['-i', 'memo.m4a', '-f', 'flac', 'out.wav']).error, /picks the format from the name/);
  assert.equal(plan(['-i', 'memo.m4a', '-f', 'ogg', 'out.opus']).error, undefined);
  assert.equal(plan(['-f', 'mp4', '-i', 'memo.m4a', 'out.wav']).error, undefined, 'an input -f is not the output format');
  assert.match(plan(['-i', 'a.mov', '-compression_level', '8', 'b.flac']).error, /-compression_level is not supported/);
});

await t('routing with a fake engine: MOV to wc.*, WebM to the CLI, a missing aresample retried on the conversion path', async () => {
  const calls = [];
  let cliStderr = '';
  const engine = { label: 'fake', memory: 1, concurrency: 1, create: () => ({ dispose() {}, async run(input) {
    calls.push(input.action);
    if (input.action === 'wc.probe') return PROBE;
    if (input.action === 'wc.frames' || input.action === 'frames') return { width: 1, height: 1, images: [{ t: 0, width: 1, height: 1, bytes: new Uint8Array([1]) }] };
    if (input.action === 'wc.audio') return { files: [{ name: input.out.name, bytes: new Uint8Array(50) }], rate: 16000, channels: 1 };
    return { code: cliStderr ? 1 : 0, stdout: '', stderr: cliStderr, files: input.outputs.map((name) => ({ name, bytes: cliStderr ? null : new Uint8Array(5) })) };
  } }) };
  const tasks = new Tasks(), media = createMediaService({ tasks, engine }), fs = new InMemoryFs(), sh = shellFor(fs, { media });
  await fs.mkdir('/w', { recursive: true });
  for (const f of ['scene.mov', 'tone.mp3', 'colors.webm', 'tone24.wav']) await fs.writeFile('/w/' + f, fx(f));
  const run = async (c) => { calls.length = 0; const r = await sh.exec(c, { cwd: '/w' }); return { ...r, calls: [...calls] }; };
  let r = await run('ffprobe -v error -show_entries format=duration -of csv=p=0 scene.mov');
  assert.deepEqual([r.stdout, r.calls], ['2.000000\n', ['wc.probe']]);
  r = await run('ffmpeg -i scene.mov -vf fps=1 f-%d.png');
  assert.deepEqual([r.exitCode, r.calls], [0, ['wc.frames']]);
  r = await run('ffmpeg -i colors.webm -vf fps=1 g-%d.png');
  assert.deepEqual(r.calls, ['frames']);
  r = await run('ffmpeg -i tone.mp3 x.png');
  assert.match(r.stderr, /has no video stream/); assert.deepEqual(r.calls, [], 'refused before any job');
  r = await run('ffmpeg -i scene.mov -vn a.wav');
  assert.deepEqual([r.exitCode, r.calls], [0, ['wc.audio']]); assert.match(r.stdout, /wrote \/w\/a\.wav \(50 bytes, 16000 Hz, mono\)/);
  r = await run('ffmpeg -i scene.mov out.mp4');
  assert.equal(r.exitCode, 1); assert.deepEqual(r.calls, []); assert.match(r.stderr, /not available here/);
  r = await run('ffmpeg -i tone24.wav b.flac');
  assert.deepEqual(r.calls, ['run'], 'the CLI build first');
  cliStderr = "[auto_aresample_0 @ 0x1] 'aresample' filter not present, cannot convert formats.";
  r = await run('ffmpeg -i tone24.wav -c:a pcm_s16le c.wav');
  assert.deepEqual([r.exitCode, r.calls], [0, ['run', 'wc.audio']], r.stderr);
  r = await run('ffmpeg -i colors.webm -c:v libvpx-vp9 v.webm');
  assert.equal(r.exitCode, 1); assert.deepEqual(r.calls, ['run'], 'video outputs are not retried');
});

console.log(`media-node: ${pass} passed`);
