import { addDays, dayKey, hhmm, startOfDay } from "./time";
import { breakSpans, workBounds, type WorkSchedule } from "./workSchedule";
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
  /** Worklog identity, `occupiedId` (to skip itself when editing) */
  id?: string;
  /** What it is, for the conflict message (issue key) */
  label?: string;
  /** Tracked by the timer of this issue (not logged yet) */
  timer?: string;
};

export type Block = { start: Date; seconds: number };

export type Placement =
  | {
      ok: true;
      start: Date;
      /**
       * Split around the day's breaks: the pieces in order (`start` is the
       * first's), each a worklog of its own. Absent when the block is one piece.
       */
      parts?: Block[];
      /** One piece over a break of the day: nothing fitted around it. */
      overBreak?: true;
    }
  | { ok: false; reason: string; with: Occupied[] };

/**
 * Overlaps up to this long are tolerated: start fields have minute precision,
 * so a block ending at 10:00:30 and one starting at 10:00 are "adjacent".
 */
export const OVERLAP_TOLERANCE_MS = 59_000;

/** A worklog's identity among the occupied: its remote id on its tracker (two trackers may share one). */
export const occupiedId = (w: { connectionId: number | null; remoteId: string }) => `${w.connectionId ?? 0}:${w.remoteId}`;

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

type Piece = { lo: number; hi: number; /** right after a break that ends the previous piece */ linked: boolean };

/** `free` stretches minus `breaks`: pieces of working time, linked across a break inside one stretch. */
function workPieces(free: [number, number][], breaks: [number, number][]): Piece[] {
  const out: Piece[] = [];
  for (const [a, b] of free) {
    let cursor = a;
    let linked = false;
    for (const [bs, be] of breaks) {
      if (be <= cursor || bs >= b) continue;
      // Linked only to work just before the break in this same stretch: a stretch
      // starting in a break begins at other time (a worklog), never chained over it.
      const before = bs > cursor;
      if (before) out.push({ lo: cursor, hi: bs, linked });
      cursor = Math.max(cursor, be);
      linked = before;
    }
    if (cursor < b) out.push({ lo: cursor, hi: b, linked });
  }
  // Under a minute is no room for a worklog: never a piece of a chain.
  return out
    .map((p, i, all) => ({ ...p, linked: p.linked && i > 0 && all[i - 1].hi - all[i - 1].lo >= MINUTE }))
    .filter((p) => p.hi - p.lo >= MINUTE);
}

/**
 * No piece under a minute (a worklog's least): a short first piece starts its
 * neighbour that much earlier, a short last one runs the one before on, both
 * within the sub-minute tolerance over the break between them.
 */
function foldShort(parts: Block[]): Block[] {
  const out = parts.map((p) => ({ ...p }));
  if (out.length > 1 && out[0].seconds * 1000 < MINUTE) {
    const [short, next] = out.splice(0, 2);
    out.unshift({ start: new Date(next.start.getTime() - short.seconds * 1000), seconds: next.seconds + short.seconds });
  }
  if (out.length > 1 && out[out.length - 1].seconds * 1000 < MINUTE) {
    const short = out.pop() as Block;
    out[out.length - 1] = { ...out[out.length - 1], seconds: out[out.length - 1].seconds + short.seconds };
  }
  return out;
}

/**
 * `seconds` ending as late as possible in `pieces`, continued backwards only
 * across a break (never over other time): the parts in order, or null.
 */
function fillBack(pieces: Piece[], seconds: number): Block[] | null {
  for (let i = pieces.length - 1; i >= 0; i--) {
    const single = fitAtEnd(pieces[i].lo, pieces[i].hi, seconds);
    if (single !== null) return [{ start: new Date(single), seconds }];
    const parts: Block[] = [];
    let remaining = seconds * 1000;
    let j = i;
    let end = floorMinute(pieces[i].hi);
    for (;;) {
      const { lo, linked } = pieces[j];
      if (end - lo >= remaining) {
        parts.unshift({ start: new Date(floorMinute(end - remaining)), seconds: remaining / 1000 });
        if (parts[0].start.getTime() < lo - OVERLAP_TOLERANCE_MS) break;
        return foldShort(parts);
      }
      if (!linked || end - lo < MINUTE) break;
      parts.unshift({ start: new Date(lo), seconds: (end - lo) / 1000 });
      remaining -= end - lo;
      j -= 1;
      end = pieces[j].hi;
    }
  }
  return null;
}

/** Whether [a, b] covers part of a break (beyond the tolerance). */
const overBreak = (a: number, b: number, breaks: [number, number][]) =>
  breaks.some(([bs, be]) => Math.min(b, be) - Math.max(a, bs) > OVERLAP_TOLERANCE_MS);

const placed = (parts: Block[], over = false): Placement => ({
  ok: true,
  start: parts[0].start,
  ...(parts.length > 1 ? { parts } : {}),
  ...(over ? { overBreak: true as const } : {}),
});

const describe = (o: Occupied) => `${o.label ? `${o.label} ` : ""}${hhmm(o.start)}–${hhmm(new Date(endMs(o)))}`;

/** "09:00–13:00 + 14:00–18:00" */
export const partsLabel = (parts: Block[]) => parts.map((p) => `${hhmm(p.start)}–${hhmm(new Date(endMs(p)))}`).join(" + ");

/**
 * The pieces as `worklogs.create` takes them: whole seconds adding up to
 * `seconds` exactly (the last one takes the rounding).
 */
export function partsInput(parts: Block[], seconds: number): { started: string; seconds: number }[] {
  const out = parts.map((p) => ({ started: p.start.toISOString(), seconds: Math.round(p.seconds) }));
  out[out.length - 1].seconds += seconds - out.reduce((a, p) => a + p.seconds, 0);
  return out;
}

/**
 * Blocks of `durations` (seconds) laid one after another over `parts` (a
 * placement split around breaks, as long as all of them): each block's pieces.
 */
export function layOver(parts: Block[], durations: number[]): Block[][] {
  let i = 0;
  let cursor = parts[0].start.getTime();
  let room = parts[0].seconds * 1000;
  return durations.map((d) => {
    const out: Block[] = [];
    let left = d * 1000;
    while (left > 0) {
      if (room <= 0) {
        if (i + 1 >= parts.length) {
          // Longer than the parts: the rest goes on where the last one ends.
          out.push({ start: new Date(cursor), seconds: left / 1000 });
          cursor += left;
          break;
        }
        i += 1;
        cursor = parts[i].start.getTime();
        room = parts[i].seconds * 1000;
      }
      const take = Math.min(left, room);
      out.push({ start: new Date(cursor), seconds: take / 1000 });
      cursor += take;
      left -= take;
      room -= take;
    }
    return out;
  });
}

/** Human message for a collision with `with`. */
export function conflictMessage(withItems: Occupied[]): string {
  return t("server.placement.overlaps", {
    list: `${withItems.slice(0, 3).map(describe).join(", ")}${withItems.length > 3 ? "…" : ""}`,
  });
}

/**
 * Place a block of `seconds` on `day`, never over `occupied`:
 * - today (or with `endAt`, e.g. when a timer was stopped): it ends at `endAt`
 *   (default now) — a timer's tracked time (`endAt`, `tracked`) wherever it starts,
 *   anything else not before the working hours; if that is taken, it goes at the end of the latest
 *   free stretch before it, not earlier than the start of the working hours;
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
  /** What a timer actually tracked (seconds): a block no longer than that, ending at `endAt`, is that work. */
  tracked?: number;
  /** That timer ran without a pause: its time stays in one piece, over a break too (worked through it). */
  unbroken?: boolean;
}): Placement {
  const { day, seconds, schedule, now } = opts;
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const occupied = opts.occupied.filter((o) => endMs(o) > dayStart && o.start.getTime() < dayEnd);
  if (seconds <= 0) return { ok: false, reason: t("server.placement.invalidDuration"), with: [] };

  const isToday = dayKey(day) === dayKey(now);
  const allBreaks: [number, number][] = breakSpans(day, schedule).map((b) => [b.start.getTime(), endMs(b)]);
  if (opts.endAt || isToday) {
    const limit = Math.min(dayEnd, Math.max(dayStart, (opts.endAt ?? now).getTime()));
    // A break still running at the end (now, or the stop) was worked through: only whole breaks before it count.
    const breaks = allBreaks.filter(([, be]) => be <= limit);
    // Tracked time (ending at its stop, no longer than the timer tracked, give or take
    // the minute it is rounded to) first in its own place, wherever it starts: work
    // begun before the working hours (a timer from 8:15 stopped at 9:05) ends there
    // too. Over a break only when the timer ran through it (`unbroken`), else it is
    // split around it below. A typed duration, one typed over a timer's, or a copied
    // day keeps out of the night (below).
    const tracked = !!opts.endAt && opts.tracked !== undefined && seconds <= opts.tracked + 60;
    const [own] = tracked ? freeIntervals(occupied, dayStart, limit).slice(-1) : [];
    if (own && own[1] === limit) {
      const start = fitAtEnd(own[0], own[1], seconds);
      if (start !== null && (opts.unbroken || !overBreak(start, start + seconds * 1000, breaks))) {
        return placed([{ start: new Date(start), seconds }]);
      }
    }
    // Taken: moved back, but not into the night: to the start of the working hours
    // at most, unless the block itself ends before them. Around the breaks when it
    // fits (split across them), else in one piece over a break.
    const workStart = workBounds(day, schedule)?.start.getTime() ?? dayStart;
    const floor = limit > workStart ? workStart : dayStart;
    const free = freeIntervals(occupied, floor, limit);
    const around = fillBack(workPieces(free, breaks), seconds);
    if (around) return placed(around);
    for (let i = free.length - 1; i >= 0; i--) {
      const start = fitAtEnd(free[i][0], free[i][1], seconds);
      if (start !== null) return placed([{ start: new Date(start), seconds }], overBreak(start, start + seconds * 1000, breaks));
    }
    return {
      ok: false,
      reason: t(opts.endAt ? "server.placement.noRoomBeforeStop" : "server.placement.noRoomBeforeNow"),
      with: occupied,
    };
  }

  const lastEnd = occupied.reduce((m, o) => Math.max(m, endMs(o)), -Infinity);
  const nine = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).getTime();
  let from =
    lastEnd > -Infinity ? ceilMinute(lastEnd) : (workBounds(day, schedule)?.start.getTime() ?? nine);
  // Appended after a break, never in it; a break further on splits it.
  const parts: Block[] = [];
  let remaining = seconds * 1000;
  for (const [bs, be] of allBreaks) {
    if (be <= from) continue;
    if (bs > from && bs - from >= remaining) break;
    if (bs - from >= MINUTE) {
      parts.push({ start: new Date(from), seconds: (bs - from) / 1000 });
      remaining -= bs - from;
    }
    from = be;
  }
  parts.push({ start: new Date(from), seconds: remaining / 1000 });
  const pieces = foldShort(parts);
  const hits = pieces.flatMap((p) => overlapping(p, occupied));
  if (endMs(pieces[pieces.length - 1]) > dayEnd || hits.length > 0) {
    return { ok: false, reason: t("server.placement.dayFull"), with: hits };
  }
  return placed(pieces);
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

/**
 * The hours worked: entries done at the same time count once. Parallel work
 * (an entry overlapping another by more than the tolerance) adds only what
 * runs past the others; entries that just touch (pieces rounded to the
 * minute) add in full, so a day without parallel work is the plain sum.
 */
export function realSeconds(items: Block[]): number {
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime() || endMs(a) - endMs(b));
  let total = 0;
  let to = -Infinity;
  for (const b of sorted) {
    const a = b.start.getTime();
    const e = endMs(b);
    total += a > to - OVERLAP_TOLERANCE_MS ? e - a : Math.max(0, e - to);
    to = Math.max(to, e);
  }
  return Math.round(total / 1000);
}

/** realSeconds of each local day (an entry belongs to the day it starts on). */
export function realSecondsByDay(items: Block[]): Map<string, number> {
  const days = new Map<string, Block[]>();
  for (const b of items) days.set(dayKey(b.start), [...(days.get(dayKey(b.start)) ?? []), b]);
  return new Map([...days].map(([k, d]) => [k, realSeconds(d)]));
}

/** realSeconds over many days: the sum of each day's. */
export const realSecondsTotal = (items: Block[]) => [...realSecondsByDay(items).values()].reduce((a, s) => a + s, 0);
