// Minimal DOM deliberately has no HTML parser. All markdown must use nodes/text.
import assert from 'node:assert/strict';
import { renderMarkdown, parseTarget } from '../src/markdown.js';
class Node {
  constructor(tag, text = '') { this.tag = tag; this.children = []; this.text = text; this.style = {}; this.events = {}; }
  append(...kids) { this.children.push(...kids); }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML parser must never run'); }
  setAttribute(k,v) { this[k] = v; }
  addEventListener(k,v) { this.events[k] = v; }
}
const doc = { createElement: tag => new Node(tag), createTextNode: text => new Node('#text',text) };
const calls = [], images = [];
const ctx = { doc, kind: () => 'file', open: x => calls.push(x), external: x => calls.push(x), copy: async()=>{},
  image: (path,alt) => { images.push(path); return /\.png$/.test(path) ? new Node('local-raster',alt) : null; } };
const nodes = renderMarkdown('# Heading\n\n**bold** and `code`\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![local](/work/a.png)\n\n![remote](https://evil.invalid/pixel.png)\n\n![svg](/work/a.svg)\n\n[a](/work/a.js:2)\n\n[web](https://example.org/q?secret)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```',ctx);
const flat=[];const visit=n=>{flat.push(n);for(const c of n.children)if(typeof c!=='string')visit(c);};nodes.forEach(visit);
assert.ok(flat.some(n=>n.tag==='strong'));assert.ok(flat.some(n=>n.tag==='table'));assert.ok(flat.some(n=>n.tag==='pre'));
assert.ok(!flat.some(n=>['script','img','iframe','svg'].includes(n.tag)));
assert.ok(flat.some(n=>n.textContent.includes('<script>alert(1)</script>')));
assert.deepEqual(images,['/work/a.png','/work/a.svg']);
assert.ok(flat.some(n=>n.tag==='local-raster'));assert.ok(flat.some(n=>n.className==='ext'&&n.textContent.includes('evil.invalid')));
assert.deepEqual(calls,[],'rendering makes no navigation calls');
flat.find(n=>n.className==='ext').events.click();assert.match(calls[0],/^https:\/\/evil.invalid/);
assert.equal(parseTarget('data:image/svg+xml,evil'),null);assert.equal(parseTarget('javascript:alert(1)'),null);
assert.deepEqual(parseTarget('/work/../work/a.js:2'),{type:'path',path:'/work/a.js',line:2,col:undefined});
console.log('PASS markdown DOM-only rendering, literal raw HTML, scheme blocking, local-image hook, external confirmation, tables/code/paths');
