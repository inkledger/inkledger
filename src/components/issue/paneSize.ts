import { useLayoutEffect, useState, type RefObject } from "react";

/** A pane's width class: s (one column, every action in the menu), m (one column), l (two columns). */
export type PaneSize = "s" | "m" | "l";

/** Below this (in rem) a pane is small. */
export const PANE_M_REM = 28;
/** From this (in rem) a pane is large: two columns, as the page. */
export const PANE_L_REM = 56;

/** The size of a pane `width` px wide, with the root font at `remPx` (density changes it). */
export function paneSize(width: number, remPx: number): PaneSize {
  const rem = width / (remPx > 0 ? remPx : 16);
  return rem < PANE_M_REM ? "s" : rem < PANE_L_REM ? "m" : "l";
}

/**
 * The size of the element in `ref`, following its own width (not the viewport's): a
 * pane set beside others is as narrow as its slot. Measured before paint.
 */
export function usePaneSize(ref: RefObject<HTMLElement | null>): PaneSize {
  const [size, setSize] = useState<PaneSize>("m");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setSize(paneSize(el.getBoundingClientRect().width, parseFloat(getComputedStyle(document.documentElement).fontSize)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
