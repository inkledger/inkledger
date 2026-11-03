import { roundToMinute } from "./time";

/**
 * Timers run side by side: the time two (or more) of them ran together is
 * shared out between them, by a share each one's log gives (basis points,
 * 10000 = all of it). Shared by the server (what a log takes) and the Log time
 * dialog (what it shows while the shares are edited). Times in ms.
 */

/** A stretch a timer ran (`timer`: its issue id, "connection:KEY"); `logged`: already taken by a log. */
export type SplitRun = { timer: string; start: number; end: number; logged: boolean };
/** The share a timer's log took of a stretch it ran together with others. */
export type SplitShare = { timer: string; start: number; end: number; bp: number };

/** A stretch the target ran with the same others the whole time. */
export type Stretch = {
  start: number;
  end: number;
  /** The other timers running with it, sorted */
  others: string[];
  /** Shares the others' logs already took of it, by timer */
  recorded: Record<string, number>;
  /** What is left, shared equally among those not logged yet (the target among them) */
  defaultBp: number;
};

export type Stretches = {
  /** The target's time with no other timer running */
  alone: { start: number; end: number }[];
  stretches: Stretch[];
  /** Every timer by its first run's start: in a stretch the earlier one's part comes first */
  order: string[];
};

export const FULL_BP = 10000;

/** A timer's id in a split: its issue on its connection. */
export const timerId = (connectionId: number, issueKey: string) => `${connectionId}:${issueKey}`;

/** The row a stretch's others make in the dialog ("With VEND-2352"). */
export const groupKey = (others: string[]) => [...others].sort().join("|");

/** The target's unlogged time, cut where the set of timers running beside it changes. */
export function stretchesOf(target: string, runs: SplitRun[], shares: SplitShare[]): Stretches {
  const own = runs.filter((r) => r.timer === target && !r.logged && r.end > r.start);
  const first = new Map<string, number>();
  for (const r of runs) first.set(r.timer, Math.min(first.get(r.timer) ?? Infinity, r.start));
  const order = [...first.keys()].sort((a, b) => first.get(a)! - first.get(b)! || a.localeCompare(b));
  const alone: Stretches["alone"] = [];
  const stretches: Stretch[] = [];
  const cuts = [...new Set(runs.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (!own.some((r) => r.start <= start && end <= r.end)) continue;
    const others = [...new Set(runs.filter((r) => r.timer !== target && r.start <= start && end <= r.end).map((r) => r.timer))].sort();
    if (others.length === 0) {
      const last = alone.at(-1);
      if (last && last.end === start) last.end = end;
      else alone.push({ start, end });
      continue;
    }
    const last = stretches.at(-1);
    if (last && last.end === start && groupKey(last.others) === groupKey(others)) {
      last.end = end;
      continue;
    }
    stretches.push({ start, end, others, recorded: {}, defaultBp: 0 });
  }
  for (const s of stretches) {
    for (const x of shares) {
      if (x.timer !== target && s.others.includes(x.timer) && x.start <= s.start && s.end <= x.end) s.recorded[x.timer] = x.bp;
    }
    const taken = Object.values(s.recorded).reduce((a, b) => a + b, 0);
    const open = s.others.length + 1 - Object.keys(s.recorded).length;
    s.defaultBp = Math.max(0, FULL_BP - taken) / Math.max(1, open);
  }
  return { alone, stretches, order };
}

export type SplitGroup = { key: string; others: string[]; seconds: number; defaultBp: number; bp: number; shareSeconds: number };
export type Split = {
  aloneSeconds: number;
  groups: SplitGroup[];
  /** Alone and the shares, rounded to the minute as a stop's */
  toLogSeconds: number;
  /** Shares of every timer on a stretch, the recorded ones and this one's together (above 100 %: counted twice) */
  overBp: number;
  /** Where the target's time goes, tiled with the others' parts; null when it can't be told (no runs, too many pieces) */
  pieces: { start: number; seconds: number }[] | null;
};

const MAX_PIECES = 5;
const sec = (ms: number) => ms / 1000;

/**
 * The target's log with the shares `bpByGroup` gives (a group not given: its
 * default). `trackedSeconds`: the timer's own count, whose part no run shows
 * (a timer older than the runs) is time alone.
 */
export function splitOf(target: string, s: Stretches, bpByGroup: Record<string, number>, trackedSeconds: number): Split {
  const byKey = new Map<string, SplitGroup>();
  for (const x of s.stretches) {
    const key = groupKey(x.others);
    const g = byKey.get(key) ?? { key, others: x.others, seconds: 0, defaultBp: 0, bp: 0, shareSeconds: 0 };
    const seconds = sec(x.end - x.start);
    g.defaultBp = g.seconds + seconds > 0 ? (g.defaultBp * g.seconds + x.defaultBp * seconds) / (g.seconds + seconds) : x.defaultBp;
    g.seconds += seconds;
    byKey.set(key, g);
  }
  const groups = [...byKey.values()];
  let overBp = 0;
  for (const g of groups) {
    g.bp = Math.min(FULL_BP, Math.max(0, bpByGroup[g.key] ?? g.defaultBp));
    g.shareSeconds = (g.seconds * g.bp) / FULL_BP;
  }
  for (const x of s.stretches) {
    const bp = byKey.get(groupKey(x.others))!.bp;
    overBp = Math.max(overBp, bp + Object.values(x.recorded).reduce((a, b) => a + b, 0));
  }
  const runSeconds = s.alone.reduce((a, x) => a + sec(x.end - x.start), 0) + groups.reduce((a, g) => a + g.seconds, 0);
  const shortfall = Math.max(0, trackedSeconds - runSeconds);
  const aloneSeconds = s.alone.reduce((a, x) => a + sec(x.end - x.start), 0) + shortfall;
  const shared = groups.reduce((a, g) => a + g.shareSeconds, 0);
  return {
    aloneSeconds,
    groups,
    toLogSeconds: roundToMinute(aloneSeconds + shared),
    overBp,
    pieces: shortfall >= 60 ? null : piecesOf(target, s, byKey),
  };
}

/** The target's alone time and, in each stretch, its slice after the slices of the timers that started before it. */
function piecesOf(target: string, s: Stretches, byKey: Map<string, SplitGroup>): Split["pieces"] {
  const parts: { start: number; end: number }[] = s.alone.map((x) => ({ ...x }));
  for (const x of s.stretches) {
    const mine = byKey.get(groupKey(x.others))!.bp;
    const length = x.end - x.start;
    let offset = 0;
    for (const timer of s.order) {
      if (timer === target) break;
      if (!x.others.includes(timer)) continue;
      offset += ((x.recorded[timer] ?? x.defaultBp) * length) / FULL_BP;
    }
    const start = x.start + Math.min(length, offset);
    const end = Math.min(x.end, start + (mine * length) / FULL_BP);
    if (end > start) parts.push({ start, end });
  }
  parts.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const p of parts) {
    const last = merged.at(-1);
    if (last && p.start - last.end < 60_000) last.end = Math.max(last.end, p.end);
    else merged.push({ ...p });
  }
  const pieces = merged.map((p) => ({ start: Math.round(p.start), seconds: Math.round(sec(p.end - p.start)) })).filter((p) => p.seconds > 0);
  return pieces.length === 0 || pieces.length > MAX_PIECES ? null : pieces;
}
