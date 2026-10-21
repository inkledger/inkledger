import { LOCALES, t, tIn } from "./i18n";

/** The corkboard canvas and its post-its (shared by the API and the UI). */
export const CANVAS_W = 1600;
export const CANVAS_H = 1200;
export const NOTE_SIZE = 168;
export const MAX_NOTES = 100;
export const NOTE_COLORS = ["yellow", "pink", "blue", "green", "orange"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/** Keep a post-it fully on the canvas. */
export function clampToCanvas(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(Math.min(CANVAS_W - NOTE_SIZE, Math.max(0, x))),
    y: Math.round(Math.min(CANVAS_H - NOTE_SIZE, Math.max(0, y))),
  };
}

/** A small tilt (−4…4°), different for every note, never 0. */
export function randomTilt(random = Math.random): number {
  const t = (random() * 2 - 1) * 4;
  return Math.round((Math.abs(t) < 0.6 ? Math.sign(t || 1) * 0.6 : t) * 10) / 10;
}

/** First free slot in reading order on a coarse grid (for "Pin"). */
export function firstFreeSlot(taken: { x: number; y: number }[]): { x: number; y: number } {
  const step = NOTE_SIZE + 24;
  for (let y = 32; y + NOTE_SIZE <= CANVAS_H; y += step) {
    for (let x = 32; x + NOTE_SIZE <= CANVAS_W; x += step) {
      const busy = taken.some(
        (t) => Math.abs(t.x - x) < NOTE_SIZE * 0.75 && Math.abs(t.y - y) < NOTE_SIZE * 0.75,
      );
      if (!busy) return { x, y };
    }
  }
  return { x: 32, y: 32 };
}

/**
 * A free spot next to a post-it (a private note hung beside its issue): the
 * ring of places around it, right first, then below, left, above, then
 * farther out; the first free slot on the board if all are taken.
 */
export function freeSlotNear(anchor: { x: number; y: number }, taken: { x: number; y: number }[]): { x: number; y: number } {
  const step = NOTE_SIZE + 36;
  const ring = [[1, 0.35], [0.4, 1], [-1, 0.3], [-0.45, 1], [1, -0.7], [-1, -0.7], [0.2, -1], [2, 0.5], [-2, 0.5], [1.2, 1.6], [-1.2, 1.6]] as const;
  for (const [dx, dy] of ring) {
    const p = clampToCanvas(anchor.x + dx * step, anchor.y + dy * step);
    const busy = [anchor, ...taken].some(
      (t) => Math.abs(t.x - p.x) < NOTE_SIZE * 0.75 && Math.abs(t.y - p.y) < NOTE_SIZE * 0.75,
    );
    if (!busy) return p;
  }
  return firstFreeSlot([anchor, ...taken]);
}

export const MAX_BOARDS = 20;

/** The name a first board is created with (in the language of the request). */
export function defaultBoardName(): string {
  return t("server.pinboard.defaultBoard");
}

/** A board still carrying the untouched default name (in any language) is shown in the current one. */
export function boardDisplayName(name: string): string {
  return LOCALES.some(l => tIn(l, "server.pinboard.defaultBoard") === name) ? defaultBoardName() : name;
}
