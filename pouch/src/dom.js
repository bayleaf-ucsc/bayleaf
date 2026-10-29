// The few DOM helpers every module shares. Nodes only, never HTML strings.
export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

// An icon from the sprite in pouch.html (<symbol id="i-NAME">).
export function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
