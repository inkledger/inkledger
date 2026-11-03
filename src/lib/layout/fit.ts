import { useLayoutEffect, type RefObject } from "react";

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
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const items = [...el.children] as HTMLElement[];
        for (const item of items) item.hidden = false;
        // More than the list holds (cut before it came here): the link stays whatever the room.
        if (more.current) more.current.hidden = !alwaysMore;
        // The room the list has: its box's height minus what stands with it (its head, the "more" link).
        const room = box.clientHeight - (el.offsetTop - box.offsetTop);
        if (el.scrollHeight <= room + 1) return;
        if (more.current) more.current.hidden = false;
        const limit = room - (more.current ? more.current.offsetHeight + 8 : 0);
        let anyHidden = false;
        for (const item of items) {
          const bottom = item.offsetTop - el.offsetTop + item.offsetHeight;
          if (anyHidden || bottom > limit) {
            item.hidden = true;
            anyHidden = true;
          }
        }
        if (more.current) more.current.hidden = !anyHidden && !alwaysMore;
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [list, more, alwaysMore]);
}
