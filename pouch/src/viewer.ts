// HTML reports: Pouch's side of the report viewer (viewer.html, README "HTML reports").
//
// A report is rendered two frames down. The outer frame is /viewer.html,
// sandboxed without allow-same-origin, so it has an opaque origin and its own
// network-less policy; the report runs in its inner srcdoc frame and inherits
// that policy. A srcdoc or blob: frame directly in Pouch would inherit Pouch's
// policy instead, whose hash-only script-src would block report scripts, and
// loosening Pouch's policy for reports is not an option.
//
// Pouch only posts the report's text (targetOrigin '*' is the only one an
// opaque origin matches, so nothing else is ever posted) and never listens:
// no message from the viewer or the report reaches Pouch's code.
export const VIEWER_MAX = 5 * 2 ** 20; // characters; viewer.html enforces the same cap

// show(html, { scripts }) replaces whatever the box showed with a fresh
// viewer, so nothing from a previous report keeps running.
export function createViewer(box, { src = 'viewer.html', doc = document } = {}) {
  let frame = null;
  return {
    show(html, { scripts = false } = {}) {
      if (html.length > VIEWER_MAX) throw new Error(`This report is ${(html.length / 2 ** 20).toFixed(1)} MB; Preview shows reports up to 5 MB. Use Raw, or Download it.`);
      const f = doc.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; midi 'none'");
      f.className = 'viewer';
      f.title = scripts ? 'Report preview (interactive)' : 'Report preview (static)';
      f.addEventListener('load', () => f.contentWindow?.postMessage({ html, scripts }, '*'), { once: true });
      f.src = src;
      if (frame?.isConnected) frame.replaceWith(f); else box.replaceChildren(f);
      frame = f;
    },
    clear() { frame?.remove(); frame = null; },
    get frame() { return frame; },
  };
}
