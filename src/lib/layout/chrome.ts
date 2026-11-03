import { useEffect, type RefObject } from "react";

/**
 * The bars that stay put while a page scrolls publish their height and mark themselves (`data-chrome`),
 * so a focused control is never left under them (WCAG 2.4.11, useFocusClearOfBars):
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
    // Marked as a bar: its own controls are exempt from the padding (src/index.css).
    el.dataset.chrome = slot === "app-header" ? "app" : slot;
    const ro = new ResizeObserver(() => target.style.setProperty(name, `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      target.style.removeProperty(name);
      delete el.dataset.chrome;
    };
  }, [ref, slot, enabled]);
}

/**
 * WCAG 2.4.11 Focus Not Obscured: when the focus lands on a control covered by a bar that stays put
 * (a sticky header or toolbar at the top, the phone's tab bar at the bottom), the page scrolls just
 * enough to show it. Not CSS scroll-padding: with it Chrome took the bars' own controls for covered and
 * scrolled the page away when one was focused. Controls inside a bar, a dialog or a popover are left alone.
 */
export function useFocusClearOfBars() {
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || el.closest("[data-chrome], [role=dialog], [role=alertdialog], [data-radix-popper-content-wrapper]")) return;
      requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        if (rect.height === 0) return;
        let top = 0;
        let bottom = innerHeight;
        for (const bar of document.querySelectorAll<HTMLElement>("[data-chrome]")) {
          const box = bar.getBoundingClientRect();
          if (box.height === 0 || box.width === 0) continue;
          if (bar.dataset.chrome === "bottom") bottom = Math.min(bottom, box.top);
          else if (box.top < innerHeight / 2) top = Math.max(top, box.bottom);
        }
        const delta = rect.top < top + 2 ? rect.top - top - 8 : rect.bottom > bottom - 2 ? rect.bottom - bottom + 8 : 0;
        if (delta === 0) return;
        const main = document.getElementById("main");
        if (main && main.contains(el) && main.scrollHeight > main.clientHeight + 1) main.scrollBy({ top: delta });
        else window.scrollBy({ top: delta });
      });
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
}
