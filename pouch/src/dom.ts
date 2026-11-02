// The few DOM helpers every module shares. Nodes only, never HTML strings.
// By id: pouch.html declares every id the page uses, so a missing one is a bug.
// This cast is the one place Pouch trusts pouch.html's ids and their element types.
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// props are assigned as properties; style may be a CSS string.
type Props<T> = Partial<Omit<T, 'style'>> & { style?: string };
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

// A Blob of bytes. Blob takes only ArrayBuffer-backed views, so other bytes (a SharedArrayBuffer's) are copied.
export function blobOf(bytes: Uint8Array, type: string): Blob {
  const { buffer } = bytes;
  return new Blob([buffer instanceof ArrayBuffer ? new Uint8Array(buffer, bytes.byteOffset, bytes.length) : bytes.slice()], { type });
}

// An icon from the sprite in pouch.html (<symbol id="i-NAME">).
export function icon(name: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

// Continuity (README "Continuity: color and motion"): an agent's color is
// CSS's business. JS sets one number, its spawn order (a3 -> --seed: 3), and
// pouch.html turns it into a hue. Main (a1) stays neutral; unknown refs get nothing.
// Older builds' s-handles (s3) read the same (graph.ts asRef).
export const seedOf = (ref: unknown): number | null => { const m = /^[as](\d+)$/.exec(String(ref ?? '')); return m ? Number(m[1]) : null; };
export function seeded<T extends HTMLElement | SVGElement>(node: T, ref: unknown): T {
  const n = seedOf(ref);
  if (n === 1) node.classList.add('main-agent');
  else if (n != null) node.style.setProperty('--seed', String(n));
  return node;
}
