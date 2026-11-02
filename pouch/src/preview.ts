// Previews in the editor pane (README "Previews"): what a file looks like,
// beside what it says. One table decides which files have a preview, whether
// they also have Raw text, and how the preview is drawn; a later kind (PDF,
// a database) is one row here and one case in render(). Files with no row
// keep today's behavior: text opens in the editor, binaries get the sheet.
import { el } from './dom.ts';
import { createViewer, VIEWER_MAX, type Viewer } from './viewer.ts';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
};
// raw: the file is text with a Raw view too. preview: the mode a file of this
// kind opens in until the user picks the other one (remembered per kind).
export type PreviewKind = 'markdown' | 'html' | 'svg' | 'image' | 'audio' | 'video';
export type ViewMode = 'raw' | 'preview';
export const KINDS: Record<PreviewKind, { ext: string[]; raw: boolean; preview?: ViewMode }> = {
  markdown: { ext: ['md', 'markdown'], raw: true, preview: 'raw' },
  html: { ext: ['html', 'htm'], raw: true, preview: 'preview' },
  svg: { ext: ['svg'], raw: true, preview: 'preview' },
  image: { ext: ['png', 'jpg', 'jpeg', 'gif', 'webp'], raw: false },
  audio: { ext: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac'], raw: false },
  video: { ext: ['mp4', 'm4v', 'webm', 'ogv', 'mov'], raw: false },
  // pdf, sqlite: later batches.
};
export const MEDIA_MAX = 50 * 2 ** 20; // bytes: images, audio and video are read whole into memory

export interface Preview { kind: PreviewKind; raw: boolean; mime: string | null }
export function previewOf(path: string): Preview | null {
  const ext = path.split('/').pop()!.split('.').pop()!.toLowerCase();
  for (const [kind, k] of Object.entries(KINDS)) if (k.ext.includes(ext)) return { kind: kind as PreviewKind, raw: k.raw, mime: MIME[ext] ?? null };
  return null;
}

// The last mode per kind, in localStorage (Erase all clears it).
const KEY = 'pouch.view';
export function rememberedMode(kind: PreviewKind, storage: Pick<Storage, 'getItem'> = localStorage): ViewMode {
  if (!KINDS[kind]?.raw) return 'preview';
  try { return JSON.parse(storage.getItem(KEY)!)?.[kind] ?? KINDS[kind].preview; } catch { return KINDS[kind].preview!; }
}
export function rememberMode(kind: PreviewKind, mode: ViewMode, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  if (!KINDS[kind]?.raw) return;
  try { const v: Partial<Record<PreviewKind, ViewMode>> = JSON.parse(storage.getItem(KEY)!) ?? {}; v[kind] = mode; storage.setItem(KEY, JSON.stringify(v)); } catch {}
}

// box: the element previews draw into. markdown(text, path): DOM nodes from
// Pouch's own renderer (no HTML, no remote images; README "What the page enforces").
export interface PreviewPane {
  render(path: string, bytes: Uint8Array, opts?: { scripts?: boolean }): void;
  clear(): void;
  notice(text: string): void;
  readonly viewer: Viewer;
}
export function createPreview(box: HTMLElement, { markdown, doc = document }: { markdown: (text: string, path: string) => Node[]; doc?: Document }): PreviewPane {
  const viewer = createViewer(box, { doc });
  let url: string | null = null;
  const reset = (cls: string) => {
    viewer.clear();
    if (url) { URL.revokeObjectURL(url); url = null; }
    box.className = cls;
    box.replaceChildren();
  };
  const notice = (text: string) => box.replaceChildren(el('p', { className: 'preview-notice', textContent: text }));
  return {
    // bytes: the saved file. scripts: Interactive mode for HTML.
    render(path, bytes, { scripts = false } = {}) {
      const p = previewOf(path);
      if (!p) throw new Error('No preview for ' + path);
      if (p.kind === 'markdown') {
        reset('md');
        box.append(el('div', { className: 'md-preview' }, ...markdown(new TextDecoder().decode(bytes), path)));
      } else if (p.kind === 'html') {
        reset('frame');
        const html = new TextDecoder().decode(bytes);
        // The viewer is a separate document, and Chromium does not serve a sandboxed
        // (opaque-origin) frame from the offline copy (sw.js), so offline it cannot load.
        if (!navigator.onLine) return notice('HTML preview needs a connection: the report viewer is a separate, sandboxed page, which browsers do not load from the offline copy. Raw works offline.');
        if (html.length > VIEWER_MAX) return notice(`This report is ${(html.length / 2 ** 20).toFixed(1)} MB; Preview shows reports up to 5 MB. Use Raw, or Download it.`);
        viewer.show(html, { scripts });
      } else {
        reset('media');
        if (bytes.length > MEDIA_MAX) return notice(`This file is ${(bytes.length / 2 ** 20).toFixed(0)} MB; Preview shows files up to 50 MB. Download it instead.`);
        // SVG too is drawn as an <img> from a blob: no script runs and nothing loads.
        url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: p.mime! }));
        const name = path.split('/').pop()!;
        const media = p.kind === 'audio' ? el('audio', { controls: true, src: url, preload: 'metadata', ariaLabel: name })
          : p.kind === 'video' ? el('video', { controls: true, src: url, preload: 'metadata', ariaLabel: name })
          : el('img', { src: url, alt: name });
        media.className = 'preview-' + (p.kind === 'svg' ? 'image' : p.kind);
        media.addEventListener('error', () => notice(`This browser cannot show ${name}. Download it instead.`), { once: true });
        box.append(media);
      }
    },
    clear: () => reset(''),
    notice(text) { reset(''); notice(text); },
    get viewer() { return viewer; },
  };
}
