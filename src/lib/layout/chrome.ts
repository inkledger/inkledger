import { useEffect, type RefObject } from "react";

/**
 * The bars that stay put while a page scrolls publish their height where the scroll padding reads it,
 * so a focused control is never left under them (WCAG 2.4.11, technique C43):
 * - `header`/`toolbar`: a page's sticky header and toolbar, on `#main` (the desktop's scroller);
 * - `app-header`: the phone's top bar, on the root (the phone's scroller is the window).
 * Read once per size change (a ResizeObserver), never on scroll.
 */
export function usePublishChromeHeight(ref: RefObject<HTMLElement | null>, slot: "header" | "toolbar" | "app-header", enabled = true) {
  useEffect(() => {
    const el = ref.current;
    const target = slot === "app-header" ? document.documentElement : document.getElementById("main");
    if (!enabled || !el || !target) return;
    const name = `--chrome-${slot}-h`;
    const ro = new ResizeObserver(() => target.style.setProperty(name, `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      target.style.removeProperty(name);
    };
  }, [ref, slot, enabled]);
}
