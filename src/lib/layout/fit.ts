import { useLayoutEffect, type RefObject } from "react";

/** Shows as many of `list`'s items as its box holds, hides the rest, and `more` when any is hidden. */
function fitList(list: HTMLElement, box: HTMLElement, more: HTMLElement | null, alwaysMore: boolean) {
  const items = [...list.children] as HTMLElement[];
  for (const item of items) item.hidden = false;
  // More than the list holds (cut before it came here): the link stays whatever the room.
  if (more) more.hidden = !alwaysMore;
  // The room the list has: its box's height minus what stands with it (its head, the "more" link).
  const room = box.clientHeight - (list.offsetTop - box.offsetTop);
  if (list.scrollHeight <= room + 1) return;
  if (more) more.hidden = false;
  const limit = room - (more ? more.offsetHeight + 8 : 0);
  let anyHidden = false;
  for (const item of items) {
    const bottom = item.offsetTop - list.offsetTop + item.offsetHeight;
    if (anyHidden || bottom > limit) {
      item.hidden = true;
      anyHidden = true;
    }
  }
  if (more) more.hidden = !anyHidden && !alwaysMore;
}

/**
 * A list that fills the height its row gives it (the Dashboard's bento row): as many items as fit are
 * shown, the rest `hidden` (out of the tab order and the accessibility tree, never clipped half-way by a
 * mask), and `more` (a "Show all N" link) appears when any is hidden. Written to the DOM, not to React
 * state: a resize never re-renders the list. Without a constrained height (a phone, a stack) everything shows.
 */
export function useFitToHeight(list: RefObject<HTMLElement | null>, more: RefObject<HTMLElement | null>, alwaysMore = false) {
  useLayoutEffect(() => {
    const el = list.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const fit = () => fitList(el, box, more.current, alwaysMore);
    // Fitted before the first paint: deferred to a frame, the list could be drawn whole first (its link
    // pushed out of the room), then cut, a layout shift. A resize later refits in the next frame.
    fit();
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(box);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [list, more, alwaysMore]);
}
