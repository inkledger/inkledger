import { useEffect, useRef, useState } from "react";

const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Animates a number towards `value` when it changes (easeOutCubic). The first
 * render shows the value as is: numbers move only when they really change.
 */
export function useCountUp(value: number, duration = 600): number {
  const [shown, setShown] = useState(value);
  // What is on screen right now: a change mid-animation continues from here.
  const current = useRef(value);

  useEffect(() => {
    const start = current.current;
    if (start === value || reduced()) {
      current.current = value;
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const eased = 1 - (1 - k) ** 3;
      current.current = start + (value - start) * eased;
      setShown(current.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return shown;
}
