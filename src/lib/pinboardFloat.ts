import { deviceSetting } from "@/lib/storage";

/** Where a floating panel (the pinboard, the TODO list) sits and how big it is (px, in the window). */
export type Rect = { x: number; y: number; w: number; h: number };

/** A floating panel's sizes, and where it first opens. */
export type FloatShape = { minW: number; minH: number; w: (vw: number) => number; h: (vh: number) => number; at: (vw: number, vh: number, w: number, h: number) => { x: number; y: number } };

/** The pinboard: large, on the right below the top. */
export const PINBOARD_SHAPE: FloatShape = {
  minW: 420,
  minH: 320,
  w: vw => Math.min(900, vw - 48),
  h: vh => Math.min(640, vh - 96),
  at: (vw, _vh, w) => ({ x: vw - w - 24, y: 72 }),
};

/** Room kept between the widget and the window's edges. */
const EDGE = 8;

/** Inside the window, at least its minimum size (or the window's, when smaller): where it was, else where its shape opens it. */
export function fitFloat(r: Rect | null, vw: number, vh: number, shape: FloatShape = PINBOARD_SHAPE): Rect {
  const maxW = Math.max(200, vw - 2 * EDGE);
  const maxH = Math.max(200, vh - 2 * EDGE);
  const w = Math.min(maxW, Math.max(Math.min(shape.minW, maxW), r?.w ?? shape.w(vw)));
  const h = Math.min(maxH, Math.max(Math.min(shape.minH, maxH), r?.h ?? shape.h(vh)));
  const first = shape.at(vw, vh, w, h);
  const x = Math.min(vw - EDGE - w, Math.max(EDGE, r?.x ?? first.x));
  const y = Math.min(vh - EDGE - h, Math.max(EDGE, r?.y ?? first.y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Where a floating panel was left, per device (null: never moved). */
export function floatRectSetting(key: string) {
  return deviceSetting<Rect | null>(
    key,
    raw => {
      try {
        const v: unknown = raw === null ? null : JSON.parse(raw);
        if (typeof v !== "object" || v === null) return null;
        const { x, y, w, h } = v as Record<string, unknown>;
        return [x, y, w, h].every(n => typeof n === "number" && Number.isFinite(n)) ? ({ x, y, w, h } as Rect) : null;
      } catch {
        return null;
      }
    },
    v => (v === null ? null : JSON.stringify(v)),
  );
}
