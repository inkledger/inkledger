import { useEffect, useLayoutEffect, type RefObject } from "react";
import { useLocation, useNavigationType, NavigationType } from "react-router";

/** Scroll of one history entry: the page panel, the window (phones), and marked scrollers. */
type Snapshot = { main: number; win: number; els: Record<string, [number, number]> };

const KEY = "ikl-scroll";
let saved: Record<string, Snapshot> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, Snapshot>;
  } catch {
    return {};
  }
})();

function persist() {
  try {
    const entries = Object.entries(saved).slice(-100);
    saved = Object.fromEntries(entries);
    sessionStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // storage unavailable: kept for this page load only
  }
}

const marked = () => [...document.querySelectorAll<HTMLElement>("[data-scroll-key]")];

/**
 * Back/forward land where you were: the panel, the window and every element
 * with `data-scroll-key` (Board columns) get their scroll back once the
 * content is there (retried while data arrives from the cache). A new page
 * starts at the top.
 */
export function useScrollRestoration(main: RefObject<HTMLElement | null>) {
  const location = useLocation();
  const type = useNavigationType();

  // Live: remember this entry's scroll as it changes.
  useEffect(() => {
    let frame = 0;
    const take = () => {
      frame = 0;
      const els: Snapshot["els"] = {};
      for (const el of marked()) els[el.dataset.scrollKey!] = [el.scrollLeft, el.scrollTop];
      saved[location.key] = { main: main.current?.scrollTop ?? 0, win: window.scrollY, els };
      persist();
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(take);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [location.key, main]);

  useLayoutEffect(() => {
    if (type === NavigationType.Replace) return; // filters typed: stay where you are
    const target = type === NavigationType.Pop ? saved[location.key] : undefined;
    if (!target) {
      main.current?.scrollTo({ top: 0 });
      window.scrollTo({ top: 0 });
      return;
    }
    let tries = 0;
    let frame = 0;
    const apply = () => {
      let done = true;
      const m = main.current;
      if (m) {
        m.scrollTop = target.main;
        done &&= Math.abs(m.scrollTop - target.main) < 2;
      }
      window.scrollTo({ top: target.win });
      done &&= Math.abs(window.scrollY - target.win) < 2;
      for (const [key, [left, top]] of Object.entries(target.els)) {
        const el = document.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(key)}"]`);
        if (!el) {
          done = false;
          continue;
        }
        el.scrollLeft = left;
        el.scrollTop = top;
        done &&= Math.abs(el.scrollLeft - left) < 2 && Math.abs(el.scrollTop - top) < 2;
      }
      // Content may still be loading: try for about two seconds.
      if (!done && ++tries < 120) frame = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [location.key, type, main]);
}
