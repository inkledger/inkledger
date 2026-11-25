/**
 * A two-pane split resized by a separator (the list and its preview): the second pane's width in px,
 * kept within its bounds. Pure, so the separator's keys and limits are tested without a browser.
 */

/** The limits a pane's width lives in. */
export type SplitBounds = { min: number; max: number };

/** Arrow keys move the divider by this many px; Shift by the larger step. */
export const SPLIT_STEP = 16;
export const SPLIT_BIG_STEP = 64;

/**
 * The bounds of the side pane in a split `container` px wide: at least `paneMin`, at most `viewportShare` of the
 * window and never so wide that the main pane falls under `mainMin`. When the two minimums cannot both hold,
 * the side pane keeps its own (the main pane scrolls sideways, the side pane would be unreadable).
 */
export function splitBounds({ container, viewport, paneMin, mainMin, viewportShare }: { container: number; viewport: number; paneMin: number; mainMin: number; viewportShare: number }): SplitBounds {
  const max = Math.min(viewport * viewportShare, container - mainMin);
  return { min: paneMin, max: Math.max(paneMin, Math.floor(max)) };
}

/** `width` within `bounds`, rounded to a whole px. */
export function clampWidth(width: number, { min, max }: SplitBounds): number {
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * The width a key moves a vertical divider to, or null for a key it does not handle. The pane is on the
 * right of the divider: ← widens it, → narrows it; Home takes it to its smallest, End to its largest.
 */
export function widthForKey(key: string, width: number, bounds: SplitBounds, big = false): number | null {
  const step = big ? SPLIT_BIG_STEP : SPLIT_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width + step, bounds);
    case "ArrowRight":
      return clampWidth(width - step, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return null;
  }
}

/** A stored width: a positive whole number of px, or null (nothing stored, or not a width: the default). */
export function parseWidth(raw: string | null): number | null {
  if (raw === null || !/^\d{1,5}$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** What is stored for a width: null (the default) removes the key. */
export function formatWidth(width: number | null): string | null {
  return width === null ? null : String(Math.round(width));
}
