/** Where the floating pinboard sits and how big it is (px, in the window). */
export type Rect = { x: number; y: number; w: number; h: number };
const MIN_W = 420;
const MIN_H = 320;
/** Room kept between the widget and the window's edges. */
const EDGE = 8;

/** Inside the window, at least its minimum size (or the window's, when smaller): where it was, else on the right. */
export function fitFloat(r: Rect | null, vw: number, vh: number): Rect {
  const maxW = Math.max(200, vw - 2 * EDGE);
  const maxH = Math.max(200, vh - 2 * EDGE);
  const w = Math.min(maxW, Math.max(Math.min(MIN_W, maxW), r?.w ?? Math.min(900, vw - 48)));
  const h = Math.min(maxH, Math.max(Math.min(MIN_H, maxH), r?.h ?? Math.min(640, vh - 96)));
  const x = Math.min(vw - EDGE - w, Math.max(EDGE, r?.x ?? vw - w - 24));
  const y = Math.min(vh - EDGE - h, Math.max(EDGE, r?.y ?? 72));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

