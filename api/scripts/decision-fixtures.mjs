/** Synthetic fixtures only. ffmpeg is needed for MP4; no network or credentials. */
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

export function wav(seconds = 1, hz = 440) {
  const rate = 16000, samples = Math.round(seconds * rate), b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * hz * i / rate)), 44 + i * 2);
  return b;
}
export const embedded = (content_type, bytes) => ({ content_type, base64: bytes.toString('base64') });
export async function image(color, format = 'png') {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: color } }).toFormat(format).toBuffer();
}
export async function video(color, sound = false) {
  const dir = await mkdtemp(join(tmpdir(), 'bayleaf-decision-fixture-'));
  const path = join(dir, 'fixture.mp4');
  const audioPath = join(dir, 'fixture.wav');
  try {
    const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=256x256:r=2:d=2`];
    if (Buffer.isBuffer(sound)) { await writeFile(audioPath, sound); args.push('-i', audioPath); }
    else if (sound) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-use_editlist', '0');
    if (sound) args.push('-c:a', 'aac', '-shortest');
    args.push('-movflags', '+faststart', '-y', path);
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('Synthetic MP4 generation failed; install ffmpeg with libx264.');
    return await readFile(path);
  } finally {
    await unlink(path).catch(() => {});
    await unlink(audioPath).catch(() => {});
    await rmdir(dir);
  }
}
