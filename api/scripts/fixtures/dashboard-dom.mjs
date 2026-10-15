import assert from 'node:assert/strict';

// Restricted, balanced SSR fixture, not an HTML parser or layout engine. Reject
// unsupported syntax rather than quietly interpreting it unlike a browser.
export function dashboardDocument(html, track = promise => promise) {
  const decode = text => text.replace(/&([^;\s]+);/g, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    if (Object.hasOwn(named, entity)) return named[entity];
    assert.match(entity, /^#(?:\d+|x[\da-f]+)$/i, 'supported fixture entity');
    return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
  const parseAttributes = source => {
    const attributes = {};
    const pattern = /\s+([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
    let offset = 0;
    while (source.slice(offset).trim()) {
      pattern.lastIndex = offset; const attribute = pattern.exec(source); assert.ok(attribute, 'supported fixture attributes: ' + source);
      const name = attribute[1].toLowerCase(); assert.ok(!Object.hasOwn(attributes, name), 'duplicate fixture attribute: ' + name);
      attributes[name] = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''); offset = pattern.lastIndex;
    }
    return attributes;
  };
  class Element extends EventTarget {
    constructor(tag, attributes = {}) {
      super(); this.tagName = tag.toUpperCase(); this.attributes = attributes; this.nodes = []; this.parentElement = null;
    }
    get children() { return this.nodes.filter(node => typeof node !== 'string'); }
    get textContent() { return this.nodes.map(node => typeof node === 'string' ? node : node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(String(value)); }
    get innerHTML() { throw new Error('innerHTML unsupported in restricted fixture'); }
    set innerHTML(value) { throw new Error('innerHTML unsupported in restricted fixture'); }
    get innerText() { return this.hidden ? '' : this.nodes.map(node => typeof node === 'string' ? node : node.innerText).join(''); }
    set innerText(value) { this.textContent = value; }
    append(...nodes) { for (const node of nodes) { if (typeof node !== 'string') node.parentElement = this; this.nodes.push(node); } }
    replaceChildren(...nodes) { this.nodes = []; this.append(...nodes); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { assert.match(name, /^[\w-]+$/); this.attributes[name] = String(value); }
    get dataset() {
      // Only simple camelCase keys are supported. Reads, writes and deletes all
      // operate on the element's real attributes, never a detached snapshot.
      const attribute = key => {
        assert.equal(typeof key, 'string', 'supported dataset key');
        assert.match(key, /^[a-z][a-zA-Z0-9]*$/, 'supported dataset key');
        return 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
      };
      return new Proxy(Object.create(null), {
        get: (_, key) => this.getAttribute(attribute(key)) ?? undefined,
        set: (_, key, value) => { this.setAttribute(attribute(key), value); return true; },
        deleteProperty: (_, key) => { delete this.attributes[attribute(key)]; return true; },
        ownKeys: () => { throw new Error('dataset enumeration unsupported in restricted fixture'); },
        defineProperty: () => { throw new Error('dataset defineProperty unsupported in restricted fixture'); },
      });
    }
    get value() { return this.tagName === 'SELECT' ? this.selectedOptions[0]?.value || '' : this._value ?? this.getAttribute('value') ?? ''; }
    set value(value) {
      if (this.tagName === 'SELECT') for (const option of this.descendants().filter(node => node.tagName === 'OPTION')) option.selected = option.value === String(value);
      else this._value = String(value);
    }
    get selectedOptions() { return this.descendants().filter(node => node.tagName === 'OPTION' && node.selected); }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click', { cancelable: true })); }
  }
  for (const property of ['hidden', 'disabled', 'selected', 'multiple']) Object.defineProperty(Element.prototype, property, {
    get() { return Object.hasOwn(this.attributes, property); },
    set(value) { if (value) this.setAttribute(property, ''); else delete this.attributes[property]; },
  });
  for (const [property, attribute] of Object.entries({ title: 'title', className: 'class', type: 'type', label: 'label', dateTime: 'datetime', tabIndex: 'tabindex' })) Object.defineProperty(Element.prototype, property, {
    get() { return this.getAttribute(attribute) || ''; }, set(value) { this.setAttribute(attribute, value); },
  });
  for (const type of ['click', 'submit']) Object.defineProperty(Element.prototype, 'on' + type, {
    set(handler) {
      if (this['_on' + type]) this.removeEventListener(type, this['_on' + type]);
      this['_on' + type] = event => track(Promise.resolve().then(() => handler(event)));
      this.addEventListener(type, this['_on' + type]);
    },
  });
  const document = new Element('document'), stack = [document];
  // Validate raw-text opening tags with exactly the same attribute parser before
  // excluding their bodies from displayed text. Retain script metadata so the
  // runtime fixture can decide whether execution is actually supported.
  document.rawTextElements = [];
  const markup = html.replace(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (_, tag, source, text) => {
    const attributes = parseAttributes(source);
    document.rawTextElements.push({ tag: tag.toLowerCase(), attributes, text });
    return '';
  });
  for (const token of markup.match(/<[^>]+>|[^<]+/g) || []) {
    if (/^<!doctype html>$/i.test(token)) continue;
    if (token.startsWith('</')) {
      assert.match(token, /^<\/[\w-]+\s*>$/);
      assert.equal(stack.pop()?.tagName, token.slice(2, -1).trim().toUpperCase(), 'balanced fixture HTML');
    } else if (token.startsWith('<')) {
      const match = token.match(/^<([a-z][\w-]*)([\s\S]*?)\/?\s*>$/i); assert.ok(match, 'supported fixture tag');
      const [, tag, source] = match, attributes = parseAttributes(source);
      assert.ok(!['script', 'style'].includes(tag.toLowerCase()), 'balanced raw-text element required');
      const element = new Element(tag, attributes); stack.at(-1).append(element);
      const isVoid = ['meta', 'link', 'input', 'br', 'hr', 'img', 'wbr'].includes(tag.toLowerCase());
      assert.ok(isVoid || !token.endsWith('/>'), 'self-closing non-void HTML is unsupported');
      if (!isVoid) stack.push(element);
    } else stack.at(-1).append(decode(token));
  }
  assert.equal(stack.length, 1, 'balanced fixture HTML');
  const ids = document.descendants().map(node => node.getAttribute('id')).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'unique fixture IDs');
  document.getElementById = id => document.descendants().find(node => node.getAttribute('id') === id) || null;
  document.createElement = tag => new Element(tag);
  return document;
}

export const displayedText = element => element.innerText.replace(/\s+/g, ' ').trim();

export function sealedUsageCard(html) {
  const document = dashboardDocument(html);
  const headings = document.descendants().filter(node => /^H[1-6]$/.test(node.tagName) && displayedText(node) === 'Sealed LLM Inference');
  assert.equal(headings.length, 1, 'one Sealed usage heading');
  return headings[0].parentElement;
}

export function displayedStat(card, label) {
  // Labels and values share a metric group. Inline wrappers are immaterial.
  const matches = card.descendants().filter(node => displayedText(node) === label && !node.children.some(child => displayedText(child) === label));
  assert.equal(matches.length, 1, 'one displayed metric label: ' + label);
  let group = matches[0].parentElement;
  while (group && displayedText(group) === label) group = group.parentElement;
  assert.ok(group, 'metric group for ' + label);
  const value = displayedText(group).replace(label, '').trim();
  assert.ok(value, 'displayed metric value: ' + label);
  return value;
}
