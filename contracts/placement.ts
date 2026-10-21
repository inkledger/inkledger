import { addDays, dayKey, startOfDay } from "./time";
import { workBounds, type WorkSchedule } from "./workSchedule";
import { t } from "./i18n";

/**
 * Where a new worklog goes, and whether it collides with another. One rule for
 * every entry point (dialogs, quick log, day review, duplicate, timers) and the
 * server check, so time is never placed on top of time already logged.
 */

/** Something already on the day: a worklog or a timer. */
export type Occupied = {
  start: Date;
  seconds: number;
  /** Worklog id (to skip itself when editing) */
  id?: string;
  /** What it is, for the conflict message (issue key) */
  label?: string;
  /** Tracked by the timer of this issue (not logged yet) */
  timer?: string;
};

export type Block = { start: Date; seconds: number };

export type Placement =
  | { ok: true; start: Date }
  | { ok: false; reason: string; with: Occupied[] };

/**
 * Overlaps up to this long are tolerated: start fields have minute precision,
 * so a block ending at 10:00:30 and one starting at 10:00 are "adjacent".
 */
export const OVERLAP_TOLERANCE_MS = 59_000;

const MINUTE = 60_000;
const endMs = (s: Block) => s.start.getTime() + s.seconds * 1000;
const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE) * MINUTE;

/** The occupied items `block` would cover (beyond the tolerance). */
export function overlapping(block: Block, occupied: Occupied[], exceptId?: string): Occupied[] {
  const a = block.start.getTime();
  const b = endMs(block);
  return occupied.filter(
    (o) =>
      (exceptId === undefined || o.id !== exceptId) &&
      Math.min(b, endMs(o)) - Math.max(a, o.start.getTime()) > OVERLAP_TOLERANCE_MS,
  );
}

/** Free stretches of [from, until] not covered by `occupied`, in order. */
function freeIntervals(occupied: Occupied[], from: number, until: number): [number, number][] {
  const sorted = [...occupied].sort((x, y) => x.start.getTime() - y.start.getTime());
  const out: [number, number][] = [];
  let cursor = from;
  for (const o of sorted) {
    const a = o.start.getTime();
    const b = endMs(o);
    if (b <= cursor) continue;
    if (a >= until) break;
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < until) out.push([cursor, until]);
  return out;
}

/** Latest minute-aligned start in [lo, hi] for `seconds`, or null. */
function fitAtEnd(lo: number, hi: number, seconds: number): number | null {
  const len = seconds * 1000;
  let start = floorMinute(hi - len);
  if (start < ceilMinute(lo)) start = ceilMinute(lo);
  return start + len <= hi + OVERLAP_TOLERANCE_MS && start >= lo - OVERLAP_TOLERANCE_MS
    ? start
    : null;
}

const describe = (o: Occupied) => {
  const hm = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${o.label ? `${o.label} ` : ""}${hm(o.start)}–${hm(new Date(endMs(o)))}`;
};

/** Human message for a collision with `with`. */
export function conflictMessage(withItems: Occupied[]): string {
  return t("server.placement.overlaps", {
    list: `${withItems.slice(0, 3).map(describe).join(", ")}${withItems.length > 3 ? "…" : ""}`,
  });
}

/**
 * Place a block of `seconds` on `day`, never over `occupied`:
 * - today (or with `endAt`, e.g. when a timer was stopped): it ends at `endAt`
 *   (default now); if that is taken, it goes at the end of the latest free
 *   stretch before it, not earlier than the start of the working hours;
 * - another day: right after the last block of that day, or at the start of
 *   that day's working hours (9:00 on days off) when it is empty.
 * No silent fallback: when nothing fits the answer says why.
 */
export function placeBlock(opts: {
  day: Date;
  seconds: number;
  occupied: Occupied[];
  schedule: WorkSchedule;
  now: Date;
  endAt?: Date;
}): Placement {
  const { day, seconds, schedule, now } = opts;
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const occupied = opts.occupied.filter((o) => endMs(o) > dayStart && o.start.getTime() < dayEnd);
  if (seconds <= 0) return { ok: false, reason: t("server.placement.invalidDuration"), with: [] };

  const isToday = dayKey(day) === dayKey(now);
  if (opts.endAt || isToday) {
    const limit = Math.min(dayEnd, Math.max(dayStart, (opts.endAt ?? now).getTime()));
    // Not into the night: back to the start of the working hours at most,
    // unless the block itself ends before them.
    const workStart = workBounds(day, schedule)?.start.getTime() ?? dayStart;
    const floor = limit > workStart ? workStart : dayStart;
    const free = freeIntervals(occupied, floor, limit);
    for (let i = free.length - 1; i >= 0; i--) {
      const start = fitAtEnd(free[i][0], free[i][1], seconds);
      if (start !== null) return { ok: true, start: new Date(start) };
    }
    return {
      ok: false,
      reason: t(opts.endAt ? "server.placement.noRoomBeforeStop" : "server.placement.noRoomBeforeNow"),
      with: occupied,
    };
  }

  const lastEnd = occupied.reduce((m, o) => Math.max(m, endMs(o)), -Infinity);
  const nine = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).getTime();
  const from =
    lastEnd > -Infinity ? ceilMinute(lastEnd) : (workBounds(day, schedule)?.start.getTime() ?? nine);
  const block = { start: new Date(from), seconds };
  const hits = overlapping(block, occupied);
  if (from + seconds * 1000 > dayEnd || hits.length > 0) {
    return { ok: false, reason: t("server.placement.dayFull"), with: hits };
  }
  return { ok: true, start: block.start };
}

/**
 * Lanes for blocks logged in parallel: overlapping blocks (beyond the
 * tolerance) form a group, each takes the first lane free at its start, and
 * every block of a group shares the group's lane count. A block alone is
 * lane 0 of 1. Input order is kept.
 */
export function lanesOf<T extends Block>(items: T[]): { item: T; lane: number; lanes: number }[] {
  const order = items.map((item, i) => ({ item, i })).sort((a, b) => a.item.start.getTime() - b.item.start.getTime() || a.i - b.i);
  const out: { item: T; lane: number; lanes: number; i: number }[] = [];
  let group: typeof out = [];
  let groupEnd = -Infinity;
  const laneEnds: number[] = [];
  const close = () => {
    const n = Math.max(1, ...group.map((g) => g.lane + 1));
    for (const g of group) g.lanes = n;
    group = [];
    laneEnds.length = 0;
  };
  for (const { item, i } of order) {
    const start = item.start.getTime();
    if (start >= groupEnd - OVERLAP_TOLERANCE_MS) close();
    let lane = laneEnds.findIndex((end) => start >= end - OVERLAP_TOLERANCE_MS);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = endMs(item);
    const placed = { item, lane, lanes: 1, i };
    group.push(placed);
    out.push(placed);
    groupEnd = Math.max(groupEnd === -Infinity ? 0 : groupEnd, endMs(item));
  }
  close();
  return out.sort((a, b) => a.i - b.i).map(({ item, lane, lanes }) => ({ item, lane, lanes }));
}

/** Clock time of blocks (their union): what the day took, counted once however many ran in parallel. */
export function clockSeconds(items: Block[]): number {
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime());
  let total = 0;
  let from = -Infinity;
  let to = -Infinity;
  for (const b of sorted) {
    const a = b.start.getTime();
    const e = endMs(b);
    if (a > to) {
      if (to > from) total += to - from;
      from = a;
      to = e;
    } else to = Math.max(to, e);
  }
  if (to > from) total += to - from;
  return Math.round(total / 1000);
}
