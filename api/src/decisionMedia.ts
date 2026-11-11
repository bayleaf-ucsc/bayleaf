/** Transient Clef media adapter. No uploads, remote fetches, logging or text fallback.
 * Only the Cloudflare endpoint is qualified; provider metadata is checked per call.
 * Container checks bound inputs, not a claim that malformed codecs will decode. */
import type { z } from '@hono/zod-openapi';
import type { DecisionRequestSchema } from './schemas';

type Request = z.infer<typeof DecisionRequestSchema>;
type Media = NonNullable<Request['images']>[number];
const utf8 = new TextEncoder();
const MIB = 1024 * 1024;
const CLEF = new Set(['cloudflare/clef', 'cloudflare/clef-flash', 'cloudflare/clef-omni']);
const mediaTypes = new Set(['image_url', 'input_image', 'input_audio', 'video_url', 'file']);

/** JSON context must not smuggle media around the validated top-level fields.
 * Iterative traversal also avoids stack overflow on deeply nested caller JSON. */
export function hasInlineDecisionMedia(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item) && ('image_url' in item || 'input_audio' in item || 'video_url' in item
      || 'file_data' in item || ('type' in item && typeof item.type === 'string' && mediaTypes.has(item.type)))) return true;
    for (const child of Object.values(item)) pending.push(child);
  }
  return false;
}

function decode(media: Media, maxBytes: number): { mime: string; base64: string; bytes: Uint8Array } | null {
  const comma = typeof media === 'string' ? media.indexOf(',') : -1;
  const mime = typeof media === 'string' ? media.slice(5, comma).replace(/;base64$/, '') : media.content_type;
  const base64 = typeof media === 'string' ? media.slice(comma + 1) : media.base64;
  if (typeof media === 'string' && (!media.startsWith('data:') || comma < 0 || !media.slice(0, comma).endsWith(';base64'))) return null;
  if (!base64.length || base64.length % 4 || base64.length > Math.ceil(maxBytes / 3) * 4) return null;
  // Bounded regex slices avoid regex-engine stack limits on large media strings.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const raw = base64.slice(0, base64.length - padding);
  for (let i = 0; i < raw.length; i += 8192) if (!/^[A-Za-z0-9+/]+$/.test(raw.slice(i, i + 8192))) return null;
  try {
    const binary = atob(base64);
    if (binary.length > maxBytes || btoa(binary) !== base64) return null;
    return { mime, base64, bytes: Uint8Array.from(binary, c => c.charCodeAt(0)) };
  } catch { return null; }
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

function imageDimensions(b: Uint8Array, mime: string): [number, number] | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (mime === 'image/png' && b.length >= 33 && ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n'
    && v.getUint32(8) === 13 && ascii(b, 12, 4) === 'IHDR') return [v.getUint32(16), v.getUint32(20)];
  if (mime !== 'image/jpeg' || b.length < 4 || b[0] !== 255 || b[1] !== 216) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at++] !== 255) return null;
    while (at < b.length && b[at] === 255) at++;
    const marker = b[at++];
    if (marker === 0xda || marker === 0xd9 || at + 2 > b.length) return null;
    const size = v.getUint16(at);
    if (size < 2 || at + size > b.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) return [v.getUint16(at + 5), v.getUint16(at + 3)];
    at += size;
  }
  return null;
}

/** Deliberately narrow first audio release: uncompressed PCM16 RIFF/WAVE only. */
function wavSeconds(b: Uint8Array): number | null {
  if (b.length < 44 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(4, true) + 8 !== b.length) return null;
  let rate = 0, alignment = 0, data = -1, at = 12;
  while (at + 8 <= b.length) {
    const kind = ascii(b, at, 4), size = v.getUint32(at + 4, true), start = at + 8;
    if (start + size > b.length) return null;
    if (kind === 'fmt ') {
      if (rate || size !== 16 || v.getUint16(start, true) !== 1) return null;
      const channels = v.getUint16(start + 2, true), sampleRate = v.getUint32(start + 4, true);
      alignment = v.getUint16(start + 12, true);
      rate = v.getUint32(start + 8, true);
      if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 48000
        || v.getUint16(start + 14, true) !== 16 || alignment !== channels * 2 || rate !== sampleRate * alignment) return null;
    } else if (kind === 'data') {
      if (data !== -1) return null;
      data = size;
    }
    at = start + size + (size % 2);
  }
  return at === b.length && rate && data > 0 && data % alignment === 0 ? data / rate : null;
}

/** Conventional, unfragmented MP4 only. Movie AND track durations must fit.
 * Reject edit lists and fragments rather than guessing their presentation time. */
function mp4Info(b: Uint8Array): { seconds: number; sound: boolean } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let count = 0, movie = 0, tracks = 0, video = false, sound = false, ftyp = false, mdat = false;
  function boxes(start: number, end: number, depth: number): boolean {
    if (depth > 4) return false;
    let at = start;
    while (at < end) {
      if (++count > 4096 || at + 8 > end) return false;
      const size = v.getUint32(at), kind = ascii(b, at + 4, 4), p = at + 8;
      if (size < 8 || at + size > end) return false;
      if (['moof', 'mvex', 'edts'].includes(kind)) return false;
      if (kind === 'ftyp') ftyp = true;
      if (kind === 'mdat') mdat = true;
      if (['moov', 'trak', 'mdia'].includes(kind) && !boxes(p, at + size, depth + 1)) return false;
      if (kind === 'mvhd' || kind === 'mdhd') {
        if (size < 28 || b[p] !== 0) return false;
        const scale = v.getUint32(p + 12), duration = v.getUint32(p + 16);
        if (!scale || !duration || duration === 0xffffffff || duration / scale > 60) return false;
        if (kind === 'mvhd') { if (movie) return false; movie = duration / scale; }
        else tracks++;
      }
      if (kind === 'hdlr') {
        if (size < 24) return false;
        const handler = ascii(b, p + 8, 4);
        if (handler === 'vide') video = true;
        else if (handler === 'soun') sound = true;
        else return false;
      }
      at += size;
    }
    return at === end;
  }
  if (!boxes(0, b.length, 0) || !ftyp || !mdat || !movie || !tracks || !video) return null;
  // Use a conservative 60-second budget even if the movie header understates tracks.
  return { seconds: 60, sound };
}

export type DecisionMediaResult = { state: Request['state']; provider: Request['provider']; modalities: string[] }
  | { error: string };

export function prepareDecisionMedia(body: Request, slug: string): DecisionMediaResult {
  if (hasInlineDecisionMedia([body.state, body.questions]))
    return { error: 'Use the top-level images, audio and videos fields, not media parts inside JSON context.' };
  const images = body.images ?? [], audio = body.audio ?? [], videos = body.videos ?? [];
  if (!images.length && !audio.length && !videos.length) return { state: body.state, provider: body.provider, modalities: [] };
  if (!CLEF.has(slug)) return { error: 'Media is qualified only for Clef, Clef Flash and Clef Omni on Cloudflare.' };
  if (images.length && videos.length) return { error: 'Combining still images with video is not qualified: Omni may confuse their identities. Send separate requests.' };
  const omni = slug === 'cloudflare/clef-omni';
  if (!omni && (audio.length || videos.length)) return { error: 'Audio and video require Clef Omni.' };
  if (body.provider?.order?.length || body.provider?.ignore?.length
    || (body.provider?.only && (body.provider.only.length !== 1 || body.provider.only[0] !== 'cloudflare'))
    || body.provider?.allow_fallbacks === true) return { error: 'Media requires provider.only=["cloudflare"] and no fallback or alternate routing.' };
  const text = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
  const textBytes = utf8.encode(text).length, questionBytes = utf8.encode(JSON.stringify(body.questions)).length;
  // Byte ceilings conservatively bound text tokens and avoid Workers AI's ~2K state truncation.
  if (textBytes > 1800 || textBytes + questionBytes > 12000) return { error: 'Media requests allow 1,800 UTF-8 state bytes and 12,000 state-plus-question bytes.' };
  const parts: unknown[] = [text];
  let imageBytes = 0, avBytes = 0, mediaTokens = 0;
  const sounds: boolean[] = [];
  for (const item of images) {
    const image = decode(item, 4 * MIB);
    const dimensions = image && imageDimensions(image.bytes, image.mime);
    if (!image || !dimensions || dimensions.some(n => n < 1) || dimensions[0] * dimensions[1] > 16_000_000)
      return { error: 'Images must be embedded PNG or JPEG with valid headers and at most 16 megapixels.' };
    imageBytes += image.bytes.length;
    // Conservative base64 preflight headroom, including Flash's smaller live context.
    if (imageBytes > (slug === 'cloudflare/clef-flash' ? 24 : 128) * 1024)
      return { error: 'Combined decoded images exceed the qualified limit (Flash: 24 KiB; Clef/Omni: 128 KiB).' };
    parts.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } });
    mediaTokens += 1027;
  }
  for (const item of audio) {
    const clip = decode(item, 8 * MIB);
    const seconds = clip?.mime === 'audio/wav' ? wavSeconds(clip.bytes) : null;
    if (!clip || seconds === null || seconds <= 0 || seconds > 300) return { error: 'Audio must be PCM16 WAV (8–48 kHz, mono/stereo), at most 8 MiB and 300 seconds.' };
    avBytes += clip.bytes.length; mediaTokens += Math.ceil(seconds * 14);
    parts.push({ type: 'input_audio', input_audio: { data: clip.base64, format: 'wav' } });
  }
  for (const item of videos) {
    const clip = decode(item, 16 * MIB);
    const info = clip?.mime === 'video/mp4' ? mp4Info(clip.bytes) : null;
    if (!clip || !info) return { error: 'Video must be unfragmented MP4 without edit lists, at most 16 MiB and 60 seconds per movie/track.' };
    avBytes += clip.bytes.length; mediaTokens += Math.ceil(info.seconds * 280); sounds.push(info.sound);
    parts.push({ type: 'video_url', video_url: { url: `data:video/mp4;base64,${clip.base64}` } });
  }
  if (avBytes > 16 * MIB) return { error: 'Audio and video together exceed 16 MiB decoded.' };
  if (sounds.some(Boolean) && !sounds.every(Boolean)) return { error: 'Do not mix videos with and without soundtracks: upstream may omit sound.' };
  if (textBytes + questionBytes + mediaTokens > 60000) return { error: 'Text, questions and conservatively estimated media exceed the context budget.' };
  return { state: parts, provider: { ...body.provider, only: ['cloudflare'], allow_fallbacks: false },
    modalities: [...(images.length ? ['image'] : []), ...(audio.length ? ['audio'] : []), ...(videos.length ? ['video'] : [])] };
}

/** Model-level advertisements are insufficient. Require the pinned endpoint in
 * the live ZDR catalog as well; every submitted request still forces ZDR + deny. */
export async function supportsDecisionMedia(slug: string, modalities: string[]): Promise<boolean> {
  try {
    const [catalog, endpoints] = await Promise.all([
      fetch('https://openrouter.ai/api/v1/models?output_modalities=decisions&zdr=true'),
      fetch('https://openrouter.ai/api/v1/endpoints/zdr'),
    ]);
    if (!catalog.ok || !endpoints.ok) return false;
    const models = await catalog.json() as { data?: any[] };
    const zdr = await endpoints.json() as { data?: any[] };
    if (!Array.isArray(models.data) || !Array.isArray(zdr.data)) return false;
    const model = models.data.find(m => m.id === slug);
    return Array.isArray(model?.architecture?.input_modalities)
      && modalities.every(m => model.architecture.input_modalities.includes(m))
      && zdr.data.some(e => e.model_id === slug && e.tag === 'cloudflare' && e.provider_name === 'Cloudflare'
        && e.safety_retention === false && e.status === 0);
  } catch { return false; }
}
