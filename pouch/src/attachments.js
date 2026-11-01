// Picker, drop and image paste share one local-only ingest path. No fetch here.
import { el } from './dom.js';
export const FILE_CAP = 20 * 1024 * 1024;
export const IMAGE_CAP = 4 * 1024 * 1024;
export function rasterMime(bytes) {
  if (bytes[0] === 137 && String.fromCharCode(...bytes.slice(1, 4)) === 'PNG') return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0, 6)))) return 'image/gif';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
const base64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
export async function prepareImage(bytes) {
  const mime = rasterMime(bytes);
  if (!mime) throw new Error('Only PNG, JPEG, GIF and WebP images can be understood. SVG and other formats stay local files.');
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80_000_000) throw new Error('Image dimensions are too large. Use a smaller image.');
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Re-encode locally: strips metadata and preserves the untouched original in VFS.
    let blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob || blob.size > IMAGE_CAP) blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', .85));
    if (!blob || blob.size > IMAGE_CAP) throw new Error('Prepared image exceeds 4 MB. Use a smaller image.');
    return { type: 'image', data: base64(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type };
  } finally { bitmap.close(); }
}
export function attachmentContext(files) {
  return files.length ? '\n\n[Files attached by the user, stored locally in Pouch. Read these VFS paths with read or bash as needed; binary files are not text. Raster images are also included as image blocks (first frame, at most 2000px/4MB); originals are unchanged.\n' + files.map((f) => JSON.stringify({ path: f.path, name: f.name, size: f.size, type: f.type })).join('\n') + '\n]' : '';
}
// Markdown images never fetch URLs. Only magic-checked local raster bytes become blobs.
export function createLocalImages(vfs) {
  const urls = new Map();
  const sweep = () => { for (const [node, url] of urls) if (!node.isConnected) { URL.revokeObjectURL(url); urls.delete(node); } };
  addEventListener('pagehide', () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); });
  return {
    sweep,
    render(path, alt) {
      if (!/^\/work\/.+\.(png|jpe?g|gif|webp)$/i.test(path)) return null;
      const box = el('span', { className: 'local-image', textContent: alt || path });
      (async () => {
        try {
          const stat = await vfs.fs.stat(path);
          if (stat.size > FILE_CAP) return;
          const bytes = await vfs.fs.readFileBuffer(path), type = rasterMime(bytes);
          if (!type || !box.isConnected) return;
          const url = URL.createObjectURL(new Blob([bytes], { type }));
          urls.set(box, url);
          box.replaceChildren(el('img', { src: url, alt: alt || path, loading: 'lazy' }));
        } catch { box.textContent = 'Image unavailable: ' + (alt || path); }
      })();
      return box;
    },
  };
}
export function createAttachments({ vfs, composer, input, picker, button, chips, warning, status, changed = () => {} }) {
  let pending = [], jobs = 0, serial = Promise.resolve();
  const render = () => {
    chips.replaceChildren(...pending.map((f) => {
      const remove = el('button', { type: 'button', textContent: '×', ariaLabel: 'Remove attachment ' + f.name });
      remove.onclick = () => { pending = pending.filter((x) => x !== f); render(); };
      return el('span', { className: 'attachment', title: f.path }, el('span', { textContent: `${f.name} (${f.size.toLocaleString()} B)` }), remove);
    }));
    warning.textContent = pending.some((f) => f.image) ? 'Images need an image-capable model (marked “images”). Nothing is sent until Send. Originals stay in Files.'
      : pending.some((f) => f.type.startsWith('image/')) ? 'This image format is attached as a file only, not for image understanding. Use PNG, JPEG, GIF or WebP.' : '';
    warning.hidden = !warning.textContent;
    changed();
  };
  const ingest = (files) => {
    const batch = Array.from(files); jobs++; changed();
    const task = serial.then(async () => {
      for (const file of batch) {
        if (file.size > FILE_CAP) throw new Error(`${file.name}: maximum attachment size is 20 MB.`);
        if (pending.length >= 8) throw new Error('Attach at most 8 files per message.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const name = (file.name || 'attachment').replace(/[\x00-\x1f/\\]/g, '_').slice(0, 160);
        const path = '/work/.attachments/' + crypto.randomUUID() + '-' + name;
        await vfs.fs.mkdir('/work/.attachments', { recursive: true });
        if (await vfs.fs.exists(path)) throw new Error('Attachment name collision. Try again.');
        await (vfs.as?.('user') ?? vfs.fs).writeFile(path, bytes); // the user's own write (file watches)
        pending.push({ path, name, size: bytes.length, type: file.type || 'application/octet-stream', image: !!rasterMime(bytes) });
        vfs.changed?.(path);
        render();
      }
    });
    serial = task.catch((e) => status(e.message, 'bad')).finally(() => { jobs--; render(); });
    return serial;
  };
  button.onclick = () => picker.click();
  picker.onchange = () => { ingest(picker.files); picker.value = ''; };
  composer.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; composer.classList.add('drop'); } });
  composer.addEventListener('dragleave', (e) => { if (!composer.contains(e.relatedTarget)) composer.classList.remove('drop'); });
  composer.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); e.stopPropagation(); composer.classList.remove('drop'); ingest(e.dataTransfer.files);
  });
  input.addEventListener('paste', (e) => {
    const images = Array.from(e.clipboardData?.items ?? []).filter((x) => x.kind === 'file' && x.type.startsWith('image/')).map((x) => x.getAsFile()).filter(Boolean);
    if (images.length) { e.preventDefault(); ingest(images); }
  });
  return {
    ingest, get files() { return pending; }, get loading() { return jobs > 0; },
    async prepare(model) {
      if (jobs) throw new Error('Wait for attachments to finish saving.');
      if (pending.some((f) => f.image) && model?.multimodal !== true) throw new Error('Choose a model marked “images” before sending these images. No request was sent.');
      const files = pending.map((f) => ({ ...f }));
      const images = [];
      for (const f of files) if (f.image) images.push(await prepareImage(await vfs.fs.readFileBuffer(f.path)));
      return { files, images };
    },
    clear(files = pending) { const paths = new Set(files.map((f) => f.path)); pending = pending.filter((f) => !paths.has(f.path)); render(); },
  };
}
