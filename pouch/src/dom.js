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

// Continuity (README "Continuity: color and motion"): an agent's color is
// CSS's business. JS sets one number, its spawn order (s3 -> --seed: 3), and
// pouch.html turns it into a hue. Main (s1) stays neutral; unknown refs get nothing.
export const seedOf = (ref) => { const m = /^s(\d+)$/.exec(String(ref ?? '')); return m ? Number(m[1]) : null; };
export function seeded(node, ref) {
  const n = seedOf(ref);
  if (n === 1) node.classList.add('main-agent');
  else if (n != null) node.style.setProperty('--seed', String(n));
  return node;
}
