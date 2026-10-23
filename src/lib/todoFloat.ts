import type { FloatShape } from "@/lib/pinboardFloat";

/** The TODO list: narrow, at the bottom right, just above the hot corner. */
export const TODO_SHAPE: FloatShape = {
  minW: 320,
  minH: 280,
  w: vw => Math.min(360, vw - 48),
  h: vh => Math.min(420, vh - 96),
  at: (vw, vh, w, h) => ({ x: vw - w - 24, y: vh - h - 24 }),
};
