// Scrolling rules for a transcript that streams (README "Scrolling").
//
// 1. The thread follows new content only while following is on. It is on at
//    the start, when the user reaches the end themselves, sends, or clicks
//    "New reply below"; any scroll that moves up turns it off at once, so a
//    stream never pulls the reader back down.
// 2. Opening or closing a disclosure (reasoning, tool output, a transcript)
//    keeps its summary line where it was on screen. If that leaves the end
//    out of view, following stops, as if the reader had scrolled.
// 3. Inner scroll boxes survive a re-render: each keeps its position, and one
//    that was at its end stays at its end (it follows too). Streaming
//    reasoning has no scroll box at all (README), so there is nothing to trap
//    a wheel or a finger.
//
// The rules key off scroll events, not wheel or touch events, so a wheel, a
// finger, a scrollbar drag and the keyboard all count the same way.
export interface ScrollMark { top: number; inner: Map<string | undefined, { top: number; end: boolean }> }
export interface Follow {
  readonly following: boolean;
  stick(): void;
  pin(smooth?: boolean): void;
  top(): void;
  mark(): ScrollMark;
  restore(m: ScrollMark): void;
}
export function createFollow(log: HTMLElement): Follow {
  let follow = true, lastTop = log.scrollTop;
  const gap = () => log.scrollHeight - log.scrollTop - log.clientHeight;
  const set = (top: number) => { log.scrollTop = top; lastTop = log.scrollTop; };
  log.addEventListener('scroll', () => {
    const t = log.scrollTop;
    if (gap() <= 2) follow = true;
    else if (t < lastTop - 1) follow = false;
    lastTop = t;
  }, { passive: true });
  // Rule 2: toggle the disclosure ourselves, so the correction lands in the
  // same frame (a toggle event comes a task later, after a paint).
  log.addEventListener('click', (e) => {
    const s = (e.target as Element).closest?.('summary');
    const d = s?.parentElement as HTMLDetailsElement | null | undefined;
    if (!s || d?.tagName !== 'DETAILS' || !log.contains(d) || (e.target as Element).closest('button, a, input, select, textarea') || e.defaultPrevented) return;
    e.preventDefault();
    const y = s.getBoundingClientRect().top;
    d.open = !d.open;
    set(log.scrollTop + s.getBoundingClientRect().top - y);
    follow = gap() <= 2;
  });
  return {
    get following() { return follow; },
    // After a render: to the end if following.
    stick() { if (follow) set(log.scrollHeight); },
    // Follow again (send, the pill, a fresh session), smoothly if asked.
    pin(smooth = false) {
      follow = true;
      if (smooth) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
      else set(log.scrollHeight);
    },
    // Stop following without a scroll (the subagent view opens at its top).
    top() { follow = false; set(0); },
    // Around a re-render: mark() before building it, restore() once it is in.
    // The thread keeps its place (or follows); inner boxes, which carry
    // data-sk="<stable key>", keep theirs, and one at its end stays there (rule 3).
    mark: () => ({ top: log.scrollTop, inner: new Map([...log.querySelectorAll<HTMLElement>('[data-sk]')].map((n) => [n.dataset.sk, { top: n.scrollTop, end: n.scrollHeight - n.scrollTop - n.clientHeight <= 2 }])) }),
    restore(m) {
      for (const n of log.querySelectorAll<HTMLElement>('[data-sk]')) {
        const w = m.inner.get(n.dataset.sk);
        if (n.dataset.sk!.startsWith('live:') || w?.end) n.scrollTop = n.scrollHeight;
        else if (w) n.scrollTop = w.top;
      }
      if (!follow) set(m.top);
    },
  };
}
