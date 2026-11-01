// Markdown replies as DOM, never HTML. The text is parsed to an mdast tree
// (micromark with GFM) and every node is built with createElement and
// textContent, so a reply cannot smuggle markup, script or a remote image into
// the page that holds your key. Raw HTML in a reply shows as visible text.
//
// Links are the one channel out: navigation is not governed by connect-src,
// so a link can carry anything in its address to another site. External
// links therefore show their host and go through a confirm step (ctx.external);
// Pouch paths open in the editor (ctx.open); every other scheme is plain text.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

function normalizePath(p) {
  const out = [];
  for (const s of p.split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return '/' + out.join('/');
}

// Classify a link target: { type: 'external', url, host }, { type: 'path',
// path, line, col }, or null (render as text). Accepts pouch:/x, pouch:///x,
// absolute and relative paths, and :12, :12:3, #L12 or #L12-L20 suffixes.
export function parseTarget(href, cwd = '/work') {
  let s = String(href ?? '').trim();
  if (/^pouch:/i.test(s)) s = s.slice(6).replace(/^\/\/(?=\/)/, '');
  else if (SCHEME.test(s)) {
    if (!/^https?:/i.test(s)) return null;
    try { const u = new URL(s); return { type: 'external', url: u.href, host: u.host }; } catch { return null; }
  }
  let line, col;
  const frag = s.match(/#L(\d+)(?:-L?\d+)?$/i);
  if (frag) line = Number(frag[1]);
  s = s.replace(/[?#].*$/, '');
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* keep it as written */ }
  const suffix = s.match(/:(\d+)(?::(\d+))?$/);
  if (suffix) { line ??= Number(suffix[1]); col = suffix[2] && Number(suffix[2]); s = s.slice(0, suffix.index); }
  return { type: 'path', path: normalizePath(s.startsWith('/') ? s : cwd + '/' + s), line, col };
}

// Inline code that is exactly a path (optionally :line) may become a file link.
const PATHLIKE = /^(?:\.{0,2}\/)?[\w@+.-]+(?:\/[\w@+.-]+)*(?::\d+(?::\d+)?)?$/;
const looksLikePath = (s) => PATHLIKE.test(s) && (s.includes('/') || /\.\w+(?::\d+)*$/.test(s));

// ctx: { doc, cwd, kind(path) -> 'file'|'dir'|'missing'|'unknown',
//        open(target), external(url), text(string) -> nodes (bare paths),
//        highlight(code, lang) -> nodes | null, copy(text) }
export function renderMarkdown(text, ctx) {
  const doc = ctx.doc ?? document;
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const defs = new Map();
  (function collect(n) {
    if (n.type === 'definition') defs.set(n.identifier, n);
    n.children?.forEach(collect);
  })(tree);

  const el = (tag, cls, ...kids) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const txt = (s) => doc.createTextNode(s);
  const kids = (n, o) => (n.children ?? []).flatMap((c) => node(c, o));

  function fileLink(t, content) {
    const k = ctx.kind(t.path);
    const where = t.path + (t.line ? ' at line ' + t.line : '');
    if (k === 'missing') {
      const s = el('span', 'path missing', ...content);
      s.title = 'Not found in Pouch: ' + t.path;
      return s;
    }
    const b = el('button', 'path', ...content);
    b.type = 'button';
    b.title = (k === 'dir' ? 'Show folder ' : 'Open ') + where;
    b.addEventListener('click', () => ctx.open({ ...t, kind: k }));
    return b;
  }
  function link(url, content) {
    const t = parseTarget(url, ctx.cwd);
    if (!t) return [...content, el('span', 'url', ' (' + (url.length > 120 ? url.slice(0, 120) + '...' : url) + ')')];
    if (t.type === 'path') return [fileLink(t, content)];
    const b = el('button', 'ext', ...content);
    b.type = 'button';
    b.title = t.url;
    b.addEventListener('click', () => ctx.external(t.url));
    // The host is always visible, so a link cannot pose as somewhere else.
    if (!b.textContent.includes(t.host)) b.append(el('span', 'host', ' (' + t.host + ')'));
    return [b];
  }
  function image(url, alt) {
    const target = parseTarget(url, ctx.cwd);
    const local = target?.type === 'path' && ctx.image?.(target.path, alt);
    return local ? [local] : link(url, [txt('image: ' + (alt || url))]);
  }
  function codeBlock(n) {
    const code = el('code');
    const lang = (n.lang ?? '').toLowerCase();
    const hl = lang && n.value.length < 50000 ? ctx.highlight?.(n.value, lang) : null;
    if (hl) code.append(...hl); else code.textContent = n.value;
    const copy = el('button', 'copy', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('click', async () => {
      try { await ctx.copy(n.value); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
    });
    return el('div', 'code', el('div', 'code-head', el('span', null, n.lang ?? ''), copy), el('pre', null, code));
  }

  // o.inLink: no nested buttons, so bare paths inside link text stay text.
  // o.phrasing: inside a paragraph, heading or cell (inline context).
  function node(n, o = {}) {
    switch (n.type) {
      case 'root': return kids(n, o);
      case 'paragraph': return [el('p', null, ...kids(n, { ...o, phrasing: true }))];
      case 'heading': return [el('h' + n.depth, null, ...kids(n, { ...o, phrasing: true }))];
      case 'thematicBreak': return [el('hr')];
      case 'blockquote': return [el('blockquote', null, ...kids(n, o))];
      case 'list': {
        const l = el(n.ordered ? 'ol' : 'ul', n.spread ? null : 'tight', ...kids(n, o));
        if (n.ordered && n.start != null && n.start !== 1) l.start = n.start;
        return [l];
      }
      case 'listItem': {
        const li = el('li');
        if (typeof n.checked === 'boolean') {
          const box = el('input');
          box.type = 'checkbox'; box.disabled = true; box.checked = n.checked;
          li.className = 'task';
          li.append(box);
        }
        li.append(...kids(n, o));
        return [li];
      }
      case 'code': return [codeBlock(n)];
      // Raw HTML is shown, not interpreted: as a text run inline, a block otherwise.
      case 'html': return o.phrasing ? [txt(n.value)] : [el('p', 'raw', n.value)];
      case 'text': return o.inLink || !ctx.text ? [txt(n.value)] : ctx.text(n.value);
      case 'emphasis': return [el('em', null, ...kids(n, o))];
      case 'strong': return [el('strong', null, ...kids(n, o))];
      case 'delete': return [el('del', null, ...kids(n, o))];
      case 'break': return [el('br')];
      case 'inlineCode': {
        const c = el('code', null, n.value);
        if (!o.inLink && looksLikePath(n.value)) {
          const t = parseTarget(n.value, ctx.cwd);
          const k = t && ctx.kind(t.path);
          if (k === 'file' || k === 'dir') return [fileLink(t, [c])];
        }
        return [c];
      }
      case 'link': return link(n.url, kids(n, { ...o, inLink: true }));
      case 'image': return image(n.url, n.alt);
      case 'linkReference':
      case 'imageReference': {
        const d = defs.get(n.identifier);
        const content = n.type === 'imageReference' ? [txt('image: ' + (n.alt || n.label))] : kids(n, { ...o, inLink: true });
        return d ? n.type === 'imageReference' ? image(d.url, n.alt || n.label) : link(d.url, content) : content;
      }
      case 'definition': return [];
      case 'footnoteReference': return [el('sup', null, '[' + n.label + ']')];
      case 'footnoteDefinition': return [el('div', 'footnote', el('sup', null, '[' + n.label + '] '), ...kids(n, o))];
      case 'table': {
        const [head, ...rows] = n.children;
        const cell = (tag, c, i) => {
          const td = el(tag, null, ...kids(c, { ...o, phrasing: true }));
          if (n.align?.[i]) td.style.textAlign = n.align[i];
          return td;
        };
        const tr = (r, tag) => el('tr', null, ...r.children.map((c, i) => cell(tag, c, i)));
        const table = el('table', null, el('thead', null, tr(head, 'th')));
        if (rows.length) table.append(el('tbody', null, ...rows.map((r) => tr(r, 'td'))));
        return [el('div', 'table', table)];
      }
      default:
        return n.children ? kids(n, o) : n.value != null ? [txt(n.value)] : [];
    }
  }
  return node(tree);
}
