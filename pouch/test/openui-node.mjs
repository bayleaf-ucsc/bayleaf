// openui-lang UI blocks (src/openui.ts): parsed to DOM nodes, never HTML; broken
// parts dropped with a listed problem; forward references, last-wins, loops,
// streaming prefixes and size limits; and the fence hooks into markdown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, renderUi } from '../src/openui.ts';
import { renderMarkdown } from '../src/markdown.ts';
import defaults from '../src/defaults.ts';

class Node {
  constructor(tag, text = '') { this.tag = tag; this.children = []; this.text = text; this.style = {}; this.events = {}; this.attrs = {}; }
  append(...kids) { this.children.push(...kids.map((k) => (typeof k === 'string' ? new Node('#text', k) : k))); }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML parser must never run'); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, v) { this.events[k] = v; }
}
const doc = { createElement: (tag) => new Node(tag), createElementNS: (_, tag) => new Node(tag), createTextNode: (t) => new Node('#text', t) };
const flat = (nodes) => { const out = []; const v = (n) => { out.push(n); n.children.forEach(v); }; [].concat(nodes).forEach(v); return out; };
const md = (s) => [new Node('md', s)], inline = (s) => [new Node('#text', s)];
const ui = (src) => renderUi(src, { doc, md, inline });

// Parse: statements, forward references, last definition wins, multi-line lists.
{
  const p = parse('root = Stack([a,\n  b])\na = Text("one")\nb = Badge("x")\nb = Badge("y", "info")');
  assert.deepEqual([...p.stmts.keys()], ['root', 'a', 'b']);
  assert.equal(p.errors.length, 0);
  const r = ui('root = Stack([a,\n  b])\na = Text("one")\nb = Badge("x")\nb = Badge("y", "info")');
  const f = flat(r.node);
  assert.ok(f.some((n) => n.tag === 'md' && n.text === 'one'), 'forward reference renders');
  const badge = f.find((n) => n.className === 'oui-badge');
  assert.equal(badge.textContent, 'y'); assert.equal(badge.attrs['data-tone'], 'info');
}
// Unsupported syntax drops its statement, not the block; problems are listed.
{
  const r = ui('root = Stack([a, b, c, d])\na = Text("kept")\nb = Text("x" + y)\nc = Button("Go", @ToAssistant("hi"))\nd = Nonsense(1)');
  const f = flat(r.node);
  assert.ok(f.some((n) => n.text === 'kept'));
  assert.ok(r.errors.some((e) => /operators/.test(e)), r.errors.join('; '));
  assert.ok(r.errors.some((e) => /not supported/.test(e)));
  assert.ok(r.errors.some((e) => /Nonsense: not a component/.test(e)));
  assert.ok(!r.errors.some((e) => /\b[bc] is not defined/.test(e)), 'a dropped statement is reported once');
}
// A lone child where a list belongs (GLM-5.3 playtest, 2026-11-02) is shown, with a note.
{
  const r = ui('root = Stack([tabs])\ntabs = Tabs([Tab("Trend", chart)])\nchart = Text("in the tab")');
  assert.ok(flat(r.node).some((n) => n.text === 'in the tab'));
  assert.deepEqual(r.errors, ['line 2: Tab: children are a list: write [chart]; shown anyway']);
}
// Review findings (#155, Greptile): a program that spends the whole node budget
// still returns; a chart that cuts says so; small values keep their digits.
{
  const full = ui('root = Stack([' + Array.from({ length: 1999 }, () => 'Badge("b")').join(', ') + '])');
  assert.ok(full && full.node.className === 'oui', 'exactly the budget renders');
  const over = ui('root = Stack([' + Array.from({ length: 2100 }, () => 'Badge("b")').join(', ') + '])');
  assert.equal(over, null, 'over the budget: nothing to show, so a code block');
  const n = 501, labels = JSON.stringify(Array.from({ length: n }, (_, i) => 'd' + i)), vals = JSON.stringify(Array.from({ length: n }, (_, i) => i));
  const cut = ui(`root = Stack([LineChart(${labels}, [Series("x", ${vals})])])`);
  assert.ok(cut.errors.some((e) => /showing the first 500 of 501 labels/.test(e)), cut.errors.join('; '));
  const short = ui('root = Stack([BarChart(["a", "b"], [Series("s", [1])])])');
  assert.ok(short.errors.some((e) => /Series "s" has 1 values for 2 labels/.test(e)));
  const small = flat(ui('root = Stack([Stat("Rate", 0.004), LineChart(["a", "b"], [Series("r", [0.001, 0.002])])])').node);
  assert.ok(small.some((n) => n.textContent === '0.004'), 'small stat keeps its digits');
  assert.ok(small.some((n) => n.textContent === '0.001 – 0.002'), 'small range keeps its digits');
}
// Loops and a missing root: no hang, no crash; nothing to show stays a code block.
{
  const r = ui('root = Stack([a])\na = Stack([root])');
  assert.ok(r.errors.some((e) => /refers to itself/.test(e)));
  assert.ok(ui('root = x\nx = y\ny = x') === null || ui('root = x\nx = y\ny = x').errors.length);
  assert.equal(ui('a = Text("no stack, no root")'), null);
  assert.equal(ui(''), null);
}
// Exponential sharing is capped by the node budget.
{
  let src = 'root = Stack([l0])\n';
  for (let i = 0; i < 30; i++) src += `l${i} = Stack([l${i + 1}, l${i + 1}])\n`;
  src += 'l30 = Text("leaf")';
  const t = Date.now(), r = ui(src);
  assert.ok(Date.now() - t < 2000, 'bounded work');
  assert.ok(r === null || r.errors.length);
}
// Every prefix of a program (streaming) parses without throwing.
const SAMPLE = `root = Stack([head, row, tabs, steps])
head = Callout("Most trees were planted in **2019**.", "info", "Summary")
row = Row([s1, kv])
s1 = Stat("Trees", 21, "+5", "success")
kv = KeyValue([{label: "Oldest", value: "Oak"}, {label: "Height", value: 12.5}])
tabs = Tabs([Tab("Bars", [bars]), Tab("Line", [line]), Tab("Table", [tbl])])
bars = BarChart(["2018", "2019", "2020"], [Series("Planted", [4, 11, 6])], "trees", true)
line = LineChart(["Jan", "Feb", "Mar", "Apr"], [Series("Rain", [3, null, 5, 2]), Series("Sun", [1, 2, 3, 4])], "mm")
tbl = Table(["Species", "Count"], [["Oak", 9], ["Pine", 12]])
steps = Steps([{title: "Survey", status: "done"}, {title: "Plant", status: "current"}, {title: "Water"}], "row")`;
for (let i = 0; i <= SAMPLE.length; i++) ui(SAMPLE.slice(0, i));
{
  const r = ui(SAMPLE);
  assert.deepEqual(r.errors, []);
  const f = flat(r.node);
  for (const cls of ['oui-callout', 'oui-row', 'oui-stat', 'oui-kv', 'oui-tabs', 'oui-chart', 'table', 'oui-steps row'])
    assert.ok(f.some((n) => n.className === cls), 'renders ' + cls);
  assert.ok(f.some((n) => n.tag === 'path' && /^M0\.0 .* M200\.0 .* L300\.0/.test(n.attrs.d)), 'null breaks the line: ' + f.find((n) => n.tag === 'path')?.attrs.d);
  assert.ok(f.some((n) => n.textContent.includes('Total: 21 trees')));
  assert.ok(f.some((n) => n.textContent === '11 trees (52.38%)'));
  // Tabs: one panel at a time, switched by its button.
  const tabs = f.find((n) => n.className === 'oui-tabs'), [bar, ...panels] = tabs.children;
  assert.deepEqual(panels.map((p) => p.hidden), [false, true, true]);
  bar.children[2].events.click();
  assert.deepEqual(panels.map((p) => p.hidden), [true, true, false]);
  assert.ok(!f.some((n) => ['script', 'img', 'iframe', 'a', 'style', 'foreignObject'].includes(n.tag)));
}
// Strings are text: markup and links in plain props stay literal.
{
  const f = flat(ui('root = Stack([Badge("<img src=x onerror=alert(1)>"), Table(["<b>"], [["javascript:alert(1)"]])])').node);
  assert.ok(f.some((n) => n.textContent === '<img src=x onerror=alert(1)>'));
  assert.ok(!f.some((n) => n.tag === 'img' || n.tag === 'b'));
}
// The fence: rendered in replies with its program; markdown props do not nest blocks.
{
  const ctx = { doc, kind: () => 'file', open() {}, external() {}, copy: async () => {} };
  const f = flat(renderMarkdown('Before\n\n```openui-lang\nroot = Stack([Text("hi")])\n```\n', ctx));
  assert.ok(f.some((n) => n.className === 'oui'), 'block rendered');
  assert.ok(f.some((n) => n.className === 'oui-source' && n.textContent.includes('root = Stack')), 'program one click away');
  const nested = flat(renderMarkdown('```openui-lang\nroot = Stack([Text("```openui-lang\\nroot = Stack([Badge(\\"in\\")])\\n```")])\n```', ctx));
  assert.equal(nested.filter((n) => n.className === 'oui').length, 1, 'no nested UI blocks');
  const partial = flat(renderMarkdown('```openui-lang\nroot = Sta', ctx));
  assert.ok(partial.some((n) => n.className === 'code') && !partial.some((n) => n.className === 'oui'), 'nothing to show yet: a code block');
}
// The agent is told: a seeded skill and one line in main's prompt.
assert.match(defaults['/skills/ui-blocks/SKILL.md'], /```openui-lang block/);
assert.match(readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8'), /read the ui-blocks skill/);
console.log('PASS openui-lang: DOM-only, forward refs/last wins, dropped parts listed, loops/size bounded, streaming prefixes, tabs/charts, fence, skill');
