// Motion carries continuity (README "Continuity: color and motion"): a
// thing that moves or changes state is shown moving, once, so the eye can
// follow it. Never the only signal: labels say the same. Transform and
// opacity only. Under prefers-reduced-motion each moment is a brief static
// highlight (.still-mark) instead.
//
// The log, tree and tray are rebuilt often (every streamed token), so a
// moment is keyed, not tied to a node: arm(key) starts its clock, and each
// rebuild calls play() on the new node, which resumes the animation where it
// was (a negative delay) until it has run its course.
const started = new Map(); // key -> performance.now() at arm()
const STILL_MS = 1000;

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const arm = (key) => { started.set(key, performance.now()); };
export const armed = (key) => started.has(key);

// Returns the Animation (or null: reduced motion, unarmed, or over).
// mark: a class the node wears for the rest of the moment (removed on time,
// even if nothing rebuilds the node).
export function play(node, key, keyframes, ms, { pseudo, easing = 'ease-out', mark } = {}) {
  const t0 = started.get(key);
  if (t0 == null || !node) return null;
  const t = performance.now() - t0;
  if (mark && t < ms) { node.classList.add(mark); setTimeout(() => node.classList.remove(mark), ms - t); }
  if (reduced()) {
    if (t >= STILL_MS) { started.delete(key); return null; }
    node.classList.add('still-mark');
    setTimeout(() => node.classList.remove('still-mark'), STILL_MS - t);
    return null;
  }
  if (t >= ms) { started.delete(key); return null; }
  const a = node.animate(typeof keyframes === 'function' ? keyframes(node) : keyframes, { duration: ms, delay: -t, easing, ...(pseudo ? { pseudoElement: pseudo } : {}) });
  a.id = key;
  return a;
}

// FLIP from a remembered rectangle to where `node` is now.
export const flipFrom = (first) => (node) => {
  const last = node.getBoundingClientRect();
  const dx = first.left - last.left, dy = first.top - last.top;
  return [{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.55 }, { transform: 'none', opacity: 1 }];
};

// Take a snapshot of `node` (its place and a copy) before it is rebuilt.
export const snapshot = (node) => (node?.isConnected ? { rect: node.getBoundingClientRect(), copy: node.cloneNode(true) } : null);
// A ghost of a snapshot that folds into `to` (fixed position, removed after).
export function fold(from, to, ms = 240) {
  if (!from || !to?.isConnected || reduced()) return null;
  const a = from.rect, b = to.getBoundingClientRect();
  if (!a.width || !a.height || !b.width || !b.height) return null;
  const ghost = from.copy;
  ghost.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.classList.add('fold-ghost');
  Object.assign(ghost.style, { position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: 0, pointerEvents: 'none', zIndex: 50, transformOrigin: '0 0', overflow: 'hidden' });
  document.body.append(ghost);
  const sx = b.width / a.width, sy = b.height / a.height;
  const anim = ghost.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${sx}, ${sy})`, opacity: 0.2 }], { duration: ms, easing: 'ease-in' });
  anim.id = 'fold';
  anim.finished.catch(() => {}).finally(() => ghost.remove());
  return anim;
}
