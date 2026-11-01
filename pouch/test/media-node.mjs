// The media commands without a browser (src/media.js): argument parsing,
// time syntax, the image path's plan, log tidying, caps, error messages, the
// commands in the terminal's shell and the agents' bash, jobs with a fake
// engine, and the build's pins, source and containment (build-libav.mjs).
// The real runtime: test/media-browser.mjs.
// Run: node test/media-node.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryFs } from 'just-bash';
import { parseProbe, parseFfmpeg, parseTime, imagePlan, frameName, tidy, createMediaService, mediaCommands, HELP,
  MAX_INPUT_BYTES, MAX_IMAGES, MAX_STDERR_LINES, MAX_OUTPUT_BYTES } from '../src/media.js';
import { Tasks } from '../src/ns/tasks.js';
import { shellFor } from '../src/tools.js';
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
  assert.equal(r.exitCode, 1); assert.match(r.stderr, /nothing was written to \/work\/x\.wav/);
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
  const src = readFileSync(resolve(import.meta.dirname, '../src/tools.js'), 'utf8');
  assert.equal((src.match(/\.\.\.mediaCommands\(defineCommand, hooks\.media/g) ?? []).length, 2, 'terminal shellFor and agent bashFor');
});

await t('build: pinned libav.js variant, no CDN, source shipped alongside', async () => {
  const out = mkdtempSync(join(tmpdir(), 'pouch-libav-node-'));
  try {
    const { pin, source, sums } = await buildLibav(out);
    const read = (p, name) => { const m = JSON.parse(readFileSync(join(out, p.dir, p.manifest), 'utf8')); return [m, name && Buffer.concat(m.files.find((f) => f.name === name).parts.map((x) => readFileSync(join(out, p.dir, x.path))))]; };
    const [m, w] = read(pin, 'worker.js');
    assert.deepEqual(m.files.map((f) => f.name), ['worker.js', 'libav.wasm', 'NOTICE.txt']);
    assert.equal(m.files[1].sha256, LIBAV.sha256['dist/libav-6.10.9.0-webm-vp9-cli.wasm.wasm'], 'the released wasm, unmodified');
    assertNoCdn(w.toString(), 'libav worker');
    assert.ok(!/node:(module|fs|path|url|crypto)/.test(w.toString()), 'no Node imports');
    assert.ok(!w.toString().includes('self.location.href === import.meta.url'), 'libav.js\'s own worker bootstrap is off');
    assert.ok(pin.bytes < 5 * 2 ** 20, `runtime is ${pin.bytes} bytes`);
    const notice = read(pin, 'NOTICE.txt')[1].toString();
    for (const k of ['GNU LESSER GENERAL PUBLIC LICENSE', 'Version 2.1', 'libvpx', 'Opus', 'Yahweasel', source.manifest]) assert.ok(notice.includes(k), k);
    const [sm] = read(source);
    assert.deepEqual(sm.files.map((f) => [f.name, f.sha256]), [...SOURCES, ...UNLINKED].map(([f, , h]) => [f, h]));
    assert.ok(notice.includes('not linked') && UNLINKED.every(([f]) => notice.includes(f)), 'NOTICE names the unlinked sources');
    assert.ok(sm.files.every((f) => f.parts.every((p) => p.bytes <= 20 * 2 ** 20)), 'every part under the static-asset limit');
    assert.ok(sums.some(([, p]) => p === `${source.dir}${source.manifest}`), 'the source is in SHA256SUMS, so deploy.mjs uploads it');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

console.log(`media-node: ${pass} passed`);
