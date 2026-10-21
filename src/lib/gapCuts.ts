import type { TimeSpan } from "@contracts/time";

/** Cuts snap to this clock grid (arrows move by it); no piece is shorter. */
export const CUT_STEP_MS = 60_000;
/** Shift + arrows: a long move. */
export const CUT_JUMP_MS = 15 * 60_000;

const endMs = (g: TimeSpan) => g.start.getTime() + g.seconds * 1000;

/** Nearest whole minute. */
export function snap(ms: number): number {
  return Math.round(ms / CUT_STEP_MS) * CUT_STEP_MS;
}

/** Keep `ms` at least one step away from both neighbours (null = no room). */
function clamp(ms: number, lo: number, hi: number): number | null {
  const min = lo + CUT_STEP_MS;
  const max = hi - CUT_STEP_MS;
  if (min > max) return null;
  return Math.min(max, Math.max(min, ms));
}

/** Add a cut near `at` (snapped); unchanged when the piece is too short. */
export function addCut(gap: TimeSpan, cuts: number[], at: number): number[] {
  const bounds = [gap.start.getTime(), ...cuts, endMs(gap)];
  const i = bounds.findIndex((b, k) => k > 0 && at < b);
  if (i <= 0) return cuts;
  const placed = clamp(snap(at), bounds[i - 1], bounds[i]);
  if (placed === null || cuts.includes(placed)) return cuts;
  return [...cuts, placed].sort((a, b) => a - b);
}

/** Move cut `index` towards `at`, never past its neighbours. */
export function moveCut(gap: TimeSpan, cuts: number[], index: number, at: number): number[] {
  const lo = index === 0 ? gap.start.getTime() : cuts[index - 1];
  const hi = index === cuts.length - 1 ? endMs(gap) : cuts[index + 1];
  const placed = clamp(snap(at), lo, hi);
  if (placed === null) return cuts;
  return cuts.map((c, k) => (k === index ? placed : c));
}

/** Cut in the middle of the longest piece (keyboard "C"). */
export function cutLongest(gap: TimeSpan, cuts: number[]): number[] {
  const pieces = segments(gap, cuts);
  const longest = pieces.reduce((a, b) => (b.seconds > a.seconds ? b : a), pieces[0]);
  return addCut(gap, cuts, longest.start.getTime() + (longest.seconds * 1000) / 2);
}

/** The pieces between the cuts, in order. */
export function segments(gap: TimeSpan, cuts: number[]): TimeSpan[] {
  const bounds = [gap.start.getTime(), ...cuts, endMs(gap)];
  return bounds.slice(1).map((b, i) => ({
    start: new Date(bounds[i]),
    seconds: Math.round((b - bounds[i]) / 1000),
  }));
}
