import { useLayoutEffect, useRef, useState } from "react";
import { fitPreset, PRESETS, type PresetId } from "@contracts/desk";

/** The smallest a pane is drawn (in rem): a desk too small for the chosen arrangement draws a close one that fits. */
const PANE_MIN_W_REM = 20;
const PANE_MIN_H_REM = 14;

/** The arrangement that fits the box in `ref` (the chosen one when it does); `active` once that box is drawn. */
export function useFittedPreset(chosen: PresetId, active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(chosen);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const { width, height } = el.getBoundingClientRect();
      setDrawn(fitPreset(chosen, width, height, PANE_MIN_W_REM * rem, PANE_MIN_H_REM * rem));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chosen, active]);
  // Until measured again, a fit for another pane count is no fit.
  return { ref, drawn: PRESETS[drawn].slots === PRESETS[chosen].slots ? drawn : chosen };
}
