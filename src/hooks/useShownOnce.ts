import { useEffect, useState, type RefObject } from "react";

const canObserve = typeof IntersectionObserver !== "undefined";

/**
 * True from the first time the element comes within `margin` of the screen (its scroller's
 * clipping included), and from then on. Not `enabled`: true at once (nothing to wait for).
 */
export function useShownOnce(ref: RefObject<Element | null>, enabled = true, margin = "0px"): boolean {
  const [shown, setShown] = useState(false);
  const done = shown || !enabled || !canObserve;
  useEffect(() => {
    const el = ref.current;
    if (done || !el) return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) setShown(true);
      },
      { rootMargin: margin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, done, margin]);
  return done;
}
