// One dismissal rule for every popover, menu, sheet and drawer (README
// "Dismissing"). A press outside the topmost open one, or Esc, closes it
// when that is safe: nothing typed is lost (a draft is kept for its next
// opening) and no decision is left hanging. Where a decision is pending it
// stays open and says why. Esc is taken here first (capture phase), so the
// composer's Esc (Stop) and the subagent view's Esc (pop out) only see it
// when nothing floats above them.
export type DismissHow = 'outside' | 'esc';
export interface Dismissible {
  isOpen(): boolean;
  close(how: DismissHow): void;
  inside(): (Element | null | undefined)[];
  // Higher is nearer the user (dialogs 3, popovers 2, drawers 1).
  layer?: number;
  // A reason to stay open, or null.
  keep?(how: DismissHow): string | null | undefined;
  // Where the reason shows (default: the first inside node).
  note?: Element;
}
const items: (Dismissible & { layer: number })[] = [];
export function dismissible<T extends Dismissible>(o: T): T { items.push({ layer: 2, ...o }); return o; }

const top = () => items.filter((i) => i.isOpen()).sort((a, b) => b.layer - a.layer)[0] ?? null;
function tell(i: Dismissible, why: string) {
  const host = i.note ?? i.inside()[0];
  if (!host) return;
  let n = host.querySelector(':scope > .keep-note');
  if (!n) { n = Object.assign(document.createElement('p'), { className: 'keep-note' }); n.setAttribute('role', 'status'); host.append(n); }
  n.textContent = why;
}
function dismiss(i: Dismissible, how: DismissHow) {
  const why = i.keep?.(how);
  if (why) { tell(i, why); return false; }
  i.close(how);
  return true;
}
// A modal dialog fills the viewport: a press on its backdrop targets the dialog itself.
const onBackdrop = (n: Element, e: PointerEvent) => n.tagName === 'DIALOG' && e.target === n && (() => {
  const r = n.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
})();

document.addEventListener('pointerdown', (e) => {
  const i = top();
  if (!i) return;
  if (i.inside().some((n) => n?.contains(e.target as Node | null) && !onBackdrop(n, e))) return;
  dismiss(i, 'outside');
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return;
  const i = top();
  if (!i) return;
  e.preventDefault(); e.stopPropagation();
  dismiss(i, 'esc');
}, true);
// A modal's own Esc (its cancel event) comes here too, never straight to close.
export function guardDialog(d: HTMLDialogElement | HTMLElement) {
  d.addEventListener('cancel', (e) => { e.preventDefault(); const i = items.find((x) => x.inside()[0] === d); if (i && i.isOpen()) dismiss(i, 'esc'); });
}
