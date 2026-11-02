// openui-lang UI blocks as DOM, never HTML (https://www.openui.com/docs/openui-lang).
// A reply's ```openui-lang fence is a small program, one statement per line:
//
//   root = Stack([note, chart])
//   note = Callout("Most trees were planted in **2019**.", "info")
//   chart = BarChart(["2018", "2019"], [Series("Trees", [4, 11])])
//
// This is a static subset of the language: literals, arrays, objects, references
// (forward references allowed, the last definition wins) and component calls.
// State ($vars), actions and functions (@Name), queries and operators are not
// supported; a statement that uses them is dropped and the rest still renders.
// The components are OpenChamber's, so a program renders the same in both;
// the ui-blocks skill (defaults.ts) teaches them to the agent.
//
// The program cannot reach the network or the page: every node is built with
// createElement and textContent, markdown props go through renderMarkdown, and
// there are no links, images, styles or event handlers from the program.

// Classes, so a component call or a reference is never mistaken for an object literal.
class Call {
  readonly name: string; readonly args: Value[]; readonly line: number;
  constructor(name: string, args: Value[], line: number) { this.name = name; this.args = args; this.line = line; }
}
class Ref { readonly name: string; constructor(name: string) { this.name = name; } }
type Obj = { [k: string]: Value };
type Value = string | number | boolean | null | Value[] | Obj | Call | Ref;

// dropped: statements that failed to parse; a reference to one is not a second problem.
export interface Program { stmts: Map<string, Value>; first: string | null; errors: string[]; dropped: Set<string> }

const IDENT = /[A-Za-z_][\w]*/y, NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, STATEMENT = /^\s*[A-Za-z_]\w*\s*=/;
const MAX_DEPTH = 32;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function parse(src: string): Program {
  const stmts = new Map<string, Value>(), errors: string[] = [], dropped = new Set<string>();
  let first: string | null = null, i = 0;
  const lineAt = (at: number) => src.slice(0, at).split('\n').length;
  const fail = (msg: string): never => { throw new Error(msg); };
  // Inside brackets a value may span lines; between statements newlines end them.
  const ws = (nl: boolean) => { while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || (nl && src[i] === '\n'))) i++; };
  const match = (re: RegExp) => { re.lastIndex = i; const m = re.exec(src); if (m) i += m[0].length; return m?.[0]; };

  function str(): string {
    const q = src[i++];
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\n') fail('unterminated string');
      if (src[i] !== '\\') { out += src[i++]; continue; }
      const e = src[i + 1];
      if (e === 'u' && /^[\da-f]{4}$/i.test(src.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
      out += e === 'n' ? '\n' : e === 't' ? '\t' : e ?? '';
      i += 2;
    }
    if (i >= src.length) fail('unterminated string');
    i++;
    return out;
  }
  function list(close: string, item: () => void) {
    for (;;) {
      ws(true);
      if (src[i] === close) { i++; return; }
      item();
      ws(true);
      if (src[i] === ',') { i++; continue; }
      if (src[i] === close) { i++; return; }
      fail(i >= src.length ? 'unterminated ' + close : /[-+*/?:<>=!&|]/.test(src[i]) ? `${src[i]}: operators are not supported` : `expected , or ${close}`);
    }
  }
  function value(depth: number): Value {
    if (depth > MAX_DEPTH) fail('nested too deeply');
    ws(true);
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') { i++; const a: Value[] = []; list(']', () => a.push(value(depth + 1))); return a; }
    if (c === '{') {
      i++;
      const o: Obj = Object.create(null);
      list('}', () => {
        const k = src[i] === '"' || src[i] === "'" ? str() : match(IDENT) ?? fail('expected a key');
        ws(true);
        if (src[i++] !== ':') fail('expected :');
        o[k] = value(depth + 1);
      });
      return o;
    }
    if (c === '$' || c === '@') fail(`${c}${match(/[$@]\w*/y)?.slice(1) ?? ''}: state and actions are not supported here`);
    const num = match(NUMBER);
    if (num) return Number(num);
    const at = i, id = match(IDENT) ?? fail(i >= src.length ? 'unexpected end' : `unexpected ${JSON.stringify(src[i])}`);
    if (id === 'true' || id === 'false') return id === 'true';
    if (id === 'null') return null;
    if (src[i] !== '(') return new Ref(id);
    i++;
    const args: Value[] = [];
    list(')', () => args.push(value(depth + 1)));
    return new Call(id, args, lineAt(at));
  }

  while (i < src.length) {
    ws(true);
    if (i >= src.length) break;
    const start = i, lineEnd = src.indexOf('\n', i), line = src.slice(i, lineEnd < 0 ? undefined : lineEnd);
    try {
      const name = match(IDENT) ?? fail('not a statement');
      ws(false);
      if (src[i++] !== '=') fail('not a statement');
      const v = value(0);
      ws(false);
      if (i < src.length && src[i] !== '\n') fail(`unexpected ${JSON.stringify(src[i])} (operators are not supported)`);
      stmts.set(name, v);
      first ??= v instanceof Call && v.name === 'Stack' ? name : null;
    } catch (e) {
      // Report statements, not the continuation lines of a broken one.
      if (STATEMENT.test(line)) { errors.push(`line ${lineAt(start)}: ${message(e)}`); dropped.add(line.split('=')[0].trim()); }
      const next = src.indexOf('\n', Math.max(start, lineEnd));
      i = next < 0 || lineEnd < 0 ? src.length : next + 1;
    }
  }
  return { stmts, first, errors, dropped };
}

export interface UiContext {
  doc?: Document;
  md(text: string): Node[];      // block markdown
  inline(text: string): Node[];  // one line of markdown, no paragraph
}
const TONES = new Set(['neutral', 'info', 'success', 'warning', 'error']);
const MAX_NODES = 2000, MAX_POINTS = 500;

// The rendered block, or null when there is nothing to show (no root yet).
export function renderUi(src: string, ctx: UiContext): { node: HTMLElement; errors: string[] } | null {
  const doc = ctx.doc ?? document;
  const { stmts, first, errors, dropped } = parse(src);
  const entry = stmts.has('root') ? 'root' : first;
  if (!entry) return null;
  let budget = MAX_NODES;
  const resolving = new Set<string>();

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] => {
    if (--budget < 0) throw new Error('too large to show');
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const warn = (call: Call | null, msg: string) => { errors.push(call ? `line ${call.line}: ${call.name}: ${msg}` : msg); return null; };

  // References resolve at use, so a statement may name one defined later.
  function deref(v: Value | undefined): Value {
    for (let hops = 0; v instanceof Ref; hops++) {
      if (resolving.has(v.name) || hops > stmts.size) { warn(null, `${v.name} refers to itself`); return null; }
      const next = stmts.get(v.name);
      if (next === undefined) { if (!dropped.has(v.name)) warn(null, `${v.name} is not defined`); return null; }
      v = next;
    }
    return v ?? null;
  }
  const text = (v: Value | undefined) => { const x = deref(v); return typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : null; };
  const num = (v: Value | undefined) => { const x = deref(v); return typeof x === 'number' && Number.isFinite(x) ? x : null; };
  const arr = (v: Value | undefined) => { const x = deref(v); return Array.isArray(x) ? x.map(deref) : null; };
  const obj = (v: Value | undefined) => { const x = deref(v); return x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Call) && !(x instanceof Ref) ? x : null; };
  const toned = <T extends HTMLElement>(n: T, v: Value | undefined) => { const t = text(v); n.setAttribute('data-tone', t && TONES.has(t) ? t : 'neutral'); return n; };
  // Two decimals from 1 up; below that, three significant digits, so 0.004 is not 0.
  const fmt = (n: number, unit = '') => n.toLocaleString(undefined, Math.abs(n) >= 1 || n === 0 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 }) + (unit ? ' ' + unit : '');

  // A lone component where a list belongs is shown (it is unambiguous), with a
  // note: hosts that follow the spec drop it.
  function items(v: Value | undefined, call: Call): Node[] {
    const one = deref(v), a = one instanceof Call ? [one] : arr(v);
    if (one instanceof Call) warn(call, `children are a list: write [${v instanceof Ref ? v.name : one.name + '(...)'}]; shown anyway`);
    if (!a) { warn(call, 'children are a list, like [a, b]'); return []; }
    return a.flatMap((x) => { const n = item(x, call); return n ? [n] : []; });
  }
  // A chart shows at most MAX_POINTS labels and says so when it cuts.
  function chartLabels(v: Value | undefined, call: Call) {
    const all = arr(v) ?? [];
    if (all.length > MAX_POINTS) warn(call, `showing the first ${MAX_POINTS} of ${all.length} labels`);
    return all.slice(0, MAX_POINTS).map((x) => text(x) ?? '');
  }
  function series(v: Value | undefined, call: Call, n: number) {
    return (arr(v) ?? []).flatMap((s) => {
      if (!(s instanceof Call) || s.name !== 'Series') { warn(call, 'series must be Series(name, values)'); return []; }
      const raw = arr(s.args[1]) ?? [];
      if (raw.length !== n) warn(call, `Series "${text(s.args[0]) ?? ''}" has ${raw.length} values for ${n} labels`);
      const values = raw.slice(0, MAX_POINTS).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null));
      return [{ name: text(s.args[0]) ?? '', values: Array.from({ length: n }, (_, i) => values[i] ?? null) }];
    });
  }
  function legend(names: string[]) {
    return names.length > 1 ? el('div', 'oui-legend', ...names.map((s, i) => el('span', null, el('i', `oui-dot oui-c${i % 6}`), s))) : null;
  }

  const COMPONENTS: Record<string, (a: Value[], call: Call) => Node | null> = {
    Stack: (a, c) => el('div', 'oui-stack', ...items(a[0], c)),
    Row: (a, c) => el('div', 'oui-row', ...items(a[0], c)),
    Card: (a, c) => { const t = text(a[0]); return el('section', 'oui-card', t ? el('div', 'oui-title', ...ctx.inline(t)) : null, ...items(a[1], c)); },
    Details: (a, c) => el('details', 'oui-details', el('summary', null, ...ctx.inline(text(a[0]) ?? '')), ...items(a[1], c)),
    Text: (a, c) => { const t = text(a[0]); return t == null ? warn(c, 'needs markdown text') : el('div', 'oui-text', ...ctx.md(t)); },
    Badge: (a) => toned(el('span', 'oui-badge', text(a[0]) ?? ''), a[1]),
    Callout: (a) => { const t = text(a[2]); return toned(el('div', 'oui-callout', t ? el('strong', 'oui-title', t) : null, ...ctx.md(text(a[0]) ?? '')), a[1]); },
    KeyValue: (a, c) => el('dl', 'oui-kv', ...(arr(a[0]) ?? []).flatMap((x) => {
      const o = obj(x);
      if (!o) { warn(c, 'items are {label, value}'); return []; }
      const v = deref(o.value);
      return [el('dt', null, text(o.label) ?? ''), el('dd', null, typeof v === 'number' ? fmt(v) : text(v) ?? '')];
    })),
    Table: (a, c) => {
      const cols = (arr(a[0]) ?? []).map((x) => text(x) ?? ''), rows = arr(a[1]);
      if (!cols.length || !rows) return warn(c, 'needs columns and rows');
      const cell = (tag: 'th' | 'td', x: Value) => { const n = deref(x); const td = el(tag, null, typeof n === 'number' ? fmt(n) : text(n) ?? ''); if (typeof n === 'number') td.className = 'num'; return td; };
      return el('div', 'table', el('table', null,
        el('thead', null, el('tr', null, ...cols.map((t) => el('th', null, t)))),
        el('tbody', null, ...rows.map((r) => el('tr', null, ...(Array.isArray(r) ? r.map(deref) : [r]).slice(0, cols.length).map((x) => cell('td', x)))))));
    },
    Stat: (a) => {
      const v = deref(a[1]), d = text(a[2]);
      return toned(el('div', 'oui-stat', el('span', 'oui-label', text(a[0]) ?? ''), el('span', 'oui-value', typeof v === 'number' ? fmt(v) : text(v) ?? ''), d ? el('span', 'oui-delta', d) : null), a[3]);
    },
    Progress: (a, c) => {
      const v = num(a[1]), max = num(a[2]) ?? 100;
      if (v == null || max <= 0) return warn(c, 'needs a number value');
      const p = el('progress');
      p.max = max; p.value = Math.min(Math.max(v, 0), max);
      return el('div', 'oui-progress', el('span', 'oui-label', `${text(a[0]) ?? ''} (${fmt(Math.round((p.value / max) * 100))}%)`), p);
    },
    Steps: (a, c) => {
      const ol = el('ol', 'oui-steps' + (text(a[1]) === 'row' ? ' row' : ''), ...(arr(a[0]) ?? []).flatMap((x) => {
        const o = obj(x);
        if (!o) { warn(c, 'items are {title, markdown?, status?}'); return []; }
        const body = text(o.markdown), status = text(o.status) ?? 'todo';
        const li = el('li', null, el('strong', null, text(o.title) ?? ''), body ? el('div', 'oui-text', ...ctx.md(body)) : null);
        li.setAttribute('data-status', ['done', 'current', 'todo', 'blocked'].includes(status) ? status : 'todo');
        return [li];
      }));
      return ol;
    },
    Tabs: (a, c) => {
      const tabs = (arr(a[0]) ?? []).filter((t): t is Call => t instanceof Call && t.name === 'Tab');
      if (!tabs.length) return warn(c, 'needs Tab(label, children) items');
      const panels = tabs.map((t) => el('div', 'oui-stack', ...items(t.args[1], t)));
      const buttons = tabs.map((t, k) => { const b = el('button', null, text(t.args[0]) ?? 'Tab ' + (k + 1)); b.type = 'button'; b.addEventListener('click', () => pick(k)); return b; });
      const pick = (k: number) => panels.forEach((p, i) => { p.hidden = i !== k; buttons[i].setAttribute('aria-pressed', String(i === k)); });
      const box = el('div', 'oui-tabs', el('div', 'seg oui-tabbar', ...buttons), ...panels);
      pick(0);
      return box;
    },
    BarChart: (a, c) => {
      const labels = chartLabels(a[0], c), unit = text(a[2]) ?? '', whole = deref(a[3]) === true;
      const ss = series(a[1], c, labels.length);
      if (!labels.length || !ss.length) return warn(c, 'needs labels and Series');
      const max = Math.max(...ss.flatMap((s) => s.values.map((v) => Math.abs(v ?? 0))), 0) || 1;
      const total = whole ? ss[0].values.reduce<number>((t, v) => t + (v ?? 0), 0) : 0;
      const rows = labels.map((l, i) => el('div', 'oui-bar-row', el('span', 'oui-label', l), el('div', 'oui-bars', ...ss.map((s, k) => {
        const v = s.values[i], bar = el('i', `oui-c${k % 6}`);
        bar.style.width = `calc((100% - 6rem) * ${(Math.abs(v ?? 0) / max).toFixed(4)})`; // room for the value
        const share = whole && total && v != null ? ` (${fmt((v / total) * 100)}%)` : '';
        return el('div', 'oui-bar', bar, el('span', 'num', v == null ? 'no data' : fmt(v, unit) + share));
      }))));
      return el('figure', 'oui-chart', legend(ss.map((s) => s.name)), ...rows, whole ? el('div', 'oui-label', 'Total: ' + fmt(total, unit)) : null);
    },
    LineChart: (a, c) => {
      const labels = chartLabels(a[0], c), unit = text(a[2]) ?? '';
      const ss = series(a[1], c, labels.length);
      const all = ss.flatMap((s) => s.values.filter((v): v is number => v != null));
      if (labels.length < 2 || !all.length) return warn(c, 'needs at least two labels and a Series');
      const lo = Math.min(...all), hi = Math.max(...all), W = 300, H = 100, span = hi - lo || 1;
      const NS = 'http://www.w3.org/2000/svg', svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${ss.map((s) => s.name).join(', ')}: from ${fmt(lo, unit)} to ${fmt(hi, unit)} over ${labels.length} points`);
      ss.forEach((s, k) => {
        // A gap (null) breaks the line into separate runs; a run of one point
        // gets a zero-length segment (h0), drawn as a dot by the round cap.
        let d = '', pen = 'M';
        const lone = (i: number) => (pen === 'L' && s.values[i - 1] != null && (i < 2 || s.values[i - 2] == null) ? 'h0 ' : '');
        s.values.forEach((v, i) => {
          if (v == null) { d += lone(i); pen = 'M'; return; }
          d += `${pen}${((i / (labels.length - 1)) * W).toFixed(1)} ${(H - ((v - lo) / span) * (H - 4) - 2).toFixed(1)} `;
          pen = 'L';
        });
        d += lone(s.values.length);
        const path = doc.createElementNS(NS, 'path');
        path.setAttribute('d', d.trim());
        path.setAttribute('class', `oui-c${k % 6}`);
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.append(path);
      });
      const ends = el('div', 'oui-axis', el('span', null, labels[0]), el('span', 'num', `${fmt(lo, unit)} – ${fmt(hi, unit)}`), el('span', null, labels[labels.length - 1]));
      return el('figure', 'oui-chart', legend(ss.map((s) => s.name)), el('div', 'oui-plot', svg), ends);
    },
  };

  function item(v: Value | undefined, parent: Call | null): Node | null {
    const name = v instanceof Ref ? v.name : null;
    const x = deref(v);
    if (x == null) return null;
    if (!(x instanceof Call)) return warn(parent, 'expected a component, got ' + (Array.isArray(x) ? 'a list' : typeof x));
    const make = COMPONENTS[x.name];
    if (!make) return warn(x, x.name === 'Tab' || x.name === 'Series' ? 'only valid inside ' + (x.name === 'Tab' ? 'Tabs' : 'a chart') : 'not a component Pouch shows');
    if (name) resolving.add(name);
    try { return make(x.args, x); } finally { if (name) resolving.delete(name); }
  }

  let node: Node | null;
  try { node = item(new Ref(entry), null); } catch (e) { warn(null, message(e)); node = null; }
  if (!node) return null;
  if (!stmts.has('root')) errors.unshift(`no root statement: showing ${entry}`);
  // The wrapper is outside the node budget: a program that spends it all still returns.
  const wrap = doc.createElement('div');
  wrap.className = 'oui';
  wrap.append(node);
  return { node: wrap, errors };
}
