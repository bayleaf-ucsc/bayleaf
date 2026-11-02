// Transcript formats for `transcribe` (src/parakeet.ts): cues built from
// parakeet.js's word timestamps, then written as SRT, WebVTT, JSON or text
// with [mm:ss] stamps. Pure functions: tested in node (test/parakeet-node.mjs).
//
// A cue ends after a sentence's last word, at a pause, or before it would
// pass CUE_SECONDS or CUE_CHARS (a two-line subtitle). Speakers are not
// separated: Parakeet has no diarization, and every format says so where
// it has room (VTT NOTE, JSON "speakers": null).
import type { AsrWord } from './protocol.ts';

export type TranscriptFormat = 'srt' | 'vtt' | 'json' | 'txt';
export interface Cue { start: number; end: number; text: string }
export interface TranscriptMeta { source: string; duration: number; model: string; attribution: string }

export const CUE_SECONDS = 7;   // longest cue
export const CUE_CHARS = 84;    // two subtitle lines of 42
export const CUE_PAUSE = 1.0;   // a silence this long (seconds) starts a new cue
const SENTENCE_END = /[.!?…。！？]["')\]]*$/;

export function cues(words: readonly AsrWord[], { seconds = CUE_SECONDS, chars = CUE_CHARS, pause = CUE_PAUSE } = {}): Cue[] {
  const out: Cue[] = [];
  let cur: AsrWord[] = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0].start_time, end: cur[cur.length - 1].end_time, text: cur.map((w) => w.text).join(' ') }); cur = []; };
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    if (cur.length) {
      const last = cur[cur.length - 1], len = cur.reduce((n, x) => n + x.text.length + 1, 0) + text.length;
      if (w.start_time - last.end_time >= pause || w.end_time - cur[0].start_time > seconds || len > chars) flush();
    }
    cur.push({ ...w, text });
    if (SENTENCE_END.test(text)) flush();
  }
  flush();
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
// 3725.5 -> "01:02:05,500" (SRT) or "01:02:05.500" (VTT)
export function clock(t: number, sep: ',' | '.') {
  const ms = Math.max(0, Math.round(t * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}
// [mm:ss], or [h:mm:ss] from an hour on: what an agent cites (story TR4).
export function stamp(t: number) {
  const s = Math.max(0, Math.floor(t));
  return s >= 3600 ? `[${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}]` : `[${pad(Math.floor(s / 60))}:${pad(s % 60)}]`;
}

export function toSrt(list: readonly Cue[]) {
  return list.map((c, i) => `${i + 1}\n${clock(c.start, ',')} --> ${clock(c.end, ',')}\n${c.text}\n`).join('\n');
}
export function toVtt(list: readonly Cue[], meta: TranscriptMeta) {
  const note = `NOTE\nTranscribed in this browser from ${meta.source.replace(/-->/g, '->')} by ${meta.model} (${meta.attribution}).\nSpeakers are not separated.\n`;
  return `WEBVTT\n\n${note}\n` + list.map((c) => `${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${c.text}\n`).join('\n');
}
export function toTxt(list: readonly Cue[]) {
  return list.map((c) => `${stamp(c.start)} ${c.text}`).join('\n') + (list.length ? '\n' : '');
}
const r3 = (t: number) => Math.round(t * 1000) / 1000;
export function toJson(list: readonly Cue[], words: readonly AsrWord[], text: string, meta: TranscriptMeta) {
  return JSON.stringify({
    source: meta.source, duration: r3(meta.duration), model: meta.model, attribution: meta.attribution, language: 'auto', speakers: null,
    text, segments: list.map((c) => ({ start: r3(c.start), end: r3(c.end), text: c.text })),
    words: words.map((w) => ({ start: r3(w.start_time), end: r3(w.end_time), text: w.text.trim(), ...(w.confidence !== undefined ? { confidence: Math.round(w.confidence * 1000) / 1000 } : {}) })),
  }, null, 1) + '\n';
}

export function render(format: TranscriptFormat, words: readonly AsrWord[], text: string, meta: TranscriptMeta) {
  const list = cues(words);
  return format === 'srt' ? toSrt(list) : format === 'vtt' ? toVtt(list, meta) : format === 'json' ? toJson(list, words, text, meta) : toTxt(list);
}
