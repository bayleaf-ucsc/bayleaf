// QR output only (#152): independently decode the actual DOM path, not a
// second call to the encoder. Browser screenshots are decoded in qr-browser.
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { renderUi } from '../src/openui.ts';
import { renderMarkdown } from '../src/markdown.ts';
import defaults from '../src/defaults.ts';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.text = ''; this.style = { setProperty() {} }; }
  append(...kids) { this.children.push(...kids.map((k) => typeof k === 'string' ? Object.assign(new Node('#text'), { text: k }) : k)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, v) { this.events[k] = v; }
  set textContent(v) { this.text = v; this.children = []; }
  get textContent() { return this.text + this.children.map((n) => n.textContent).join(''); }
  set innerHTML(_) { throw new Error('must not parse HTML'); }
}
const doc = { createElement: (tag) => new Node(tag), createElementNS: (_, tag) => new Node(tag), createTextNode: (t) => Object.assign(new Node('#text'), { text: t }) };
const flat = (n) => [n, ...n.children.flatMap(flat)];
const ui = (src, extra = {}) => renderUi(src, { doc, md: (s) => [doc.createTextNode(s)], inline: (s) => [doc.createTextNode(s)], ...extra });
const program = (s, label = 'Open on phone') => `root = Stack([QRCode(${JSON.stringify(s)}, ${JSON.stringify(label)})])`;
const find = (r, tag) => flat(r.node).find((n) => n.tag === tag);
function decode(svg) {
  const side = Number(svg.attrs.viewBox.split(' ')[2]), scale = 4, width = side * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  const path = svg.children.find((n) => n.tag === 'path');
  const runs = [...path.attrs.d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)];
  assert.ok(runs.length > 0);
  for (const [, xx, yy, len] of runs) {
    const x = Number(xx), y = Number(yy), w = Number(len);
    assert.ok(x >= 4 && y >= 4 && x + w <= side - 4 && y < side - 4, 'four-module quiet zone');
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < w * scale; dx++) {
      const i = ((y * scale + dy) * width + x * scale + dx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return jsQR(data, width, width);
}

for (const payload of [
  'https://bayleaf.dev',
  'https://example.invalid/receive#ticket=abc%2F123&x=1',
  'A café, 中文, 🐈, e\u0301\nline two\tend',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  ' leading and trailing space ',
  '\ufeffBOM is payload too\u0000',
  'x'.repeat(1024),
  '🐈'.repeat(256),
]) {
  const r = ui(program(payload, '<b>literal label</b>'));
  assert.deepEqual(r.errors, []);
  const svg = find(r, 'svg');
  assert.equal(svg.attrs.role, 'img');
  assert.equal(svg.attrs['aria-label'], '<b>literal label</b>');
  assert.equal(find(r, 'code').textContent, payload, 'fallback is the exact payload');
  const got = decode(svg);
  assert.ok(got, 'independent decoder found a QR code');
  assert.equal(got.data, payload);
  assert.deepEqual(got.binaryData, [...new TextEncoder().encode(payload)]);
  assert.ok(!flat(r.node).some((n) => ['a', 'img', 'script', 'iframe', 'b', 'style'].includes(n.tag)));
}
for (const [expr, error] of [
  ['""', /nonempty string/], ['42', /nonempty string/], ['null', /nonempty string/],
  [JSON.stringify('x'.repeat(1025)), /1024 UTF-8 bytes/],
  [JSON.stringify('🐈'.repeat(257)), /1024 UTF-8 bytes/],
  ['"\\ud800"', /invalid Unicode/], ['"\\udc00"', /invalid Unicode/],
]) {
  const r = ui(`root = Stack([QRCode(${expr}), Text("kept")])`);
  assert.equal(find(r, 'svg'), undefined);
  assert.match(r.errors.join(';'), error);
  assert.match(r.node.textContent, /kept/, 'bad QR does not drop the rest');
}
{
  const r = ui('root = Stack([q, q, q, q, q, Text("kept")])\nq = QRCode("hi")');
  assert.equal(flat(r.node).filter((n) => n.tag === 'svg').length, 4);
  assert.match(r.errors.join(';'), /at most 4/);
  assert.match(r.node.textContent, /kept/);
}
{
  const copied = [], value = 'https://example.invalid/#exact%20payload';
  const r = ui(program(value), { copy: async (s) => { copied.push(s); } });
  const b = find(r, 'button');
  assert.deepEqual(copied, [], 'no clipboard write until clicked');
  await b.events.click();
  assert.deepEqual(copied, [value]);
  assert.equal(b.textContent, 'Copied');
  const failed = ui(program(value), { copy: () => { throw new Error('denied'); } });
  await find(failed, 'button').events.click();
  assert.equal(find(failed, 'button').textContent, 'Copy failed');
  const ctx = { doc, kind: () => 'file', open() {}, external() {}, copy: (s) => copied.push(s) };
  const markdown = renderMarkdown('```openui-lang\n' + program(value) + '\n```', ctx);
  const qr = markdown.flatMap(flat).find((n) => n.className === 'oui-qr');
  await flat(qr).find((n) => n.tag === 'button').events.click();
  assert.deepEqual(copied, [value, value], 'markdown passes its trusted copy callback');
}
const sample = program('https://bayleaf.dev');
for (let i = 0; i <= sample.length; i++) ui(sample.slice(0, i));
assert.match(defaults['/skills/ui-blocks/SKILL.md'], /QRCode\(value, label\?\)/);
assert.match(defaults['/skills/ui-blocks/SKILL.md'], /conversation history/);
console.log('PASS QR: independent UTF-8 byte decoding, quiet zone, literal text, limits, malformed Unicode, bounded repeated refs, copy, markdown, streaming, skill');
