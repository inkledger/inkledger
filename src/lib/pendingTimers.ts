import { placeBlock, type Occupied } from "@contracts/placement";
import type { WorkSchedule } from "@contracts/workSchedule";
import { timerOnDay } from "./timerDay";

type PausedTimer = {
  issueKey: string;
  connectionId: number | null;
  state: string;
  pausedAt: string | Date | null;
  elapsedSeconds: number;
  note?: string;
};

/** No working hours: placement may use the whole day. */
const OFF_WEEK: WorkSchedule = Array.from({ length: 7 }, () => ({ enabled: false, start: "09:00", end: "18:00", breaks: [] }));

export type PendingBlock<T extends PausedTimer = PausedTimer> = { timer: T; start: Date; seconds: number };

/**
 * Where the stopped, not yet logged timers of `day` sit on its timeline: each
 * where logging it would put it (the shared `placeBlock` rule, ending at its
 * stop), never over a worklog, the running timer or another of them. Real run
 * segments are not stored; when nothing fits it is the stretch before its stop.
 */
export function placePendingTimers<T extends PausedTimer>(opts: {
  day: Date;
  now: Date;
  timers: readonly T[];
  /** The day's worklogs and the running timer's stretch. */
  occupied: readonly Occupied[];
  schedule: WorkSchedule;
}): PendingBlock<T>[] {
  const paused = opts.timers
    .filter(t => t.state !== "running" && t.pausedAt && t.elapsedSeconds > 0 && timerOnDay(t, opts.day, opts.now))
    .sort((a, b) => new Date(a.pausedAt ?? 0).getTime() - new Date(b.pausedAt ?? 0).getTime());
  const occupied = [...opts.occupied];
  const out: PendingBlock<T>[] = [];
  for (const timer of paused) {
    const end = new Date(timer.pausedAt ?? 0);
    const seconds = timer.elapsedSeconds;
    const place = (schedule: WorkSchedule) =>
      placeBlock({ day: opts.day, seconds, occupied, schedule, now: opts.now, endAt: end, tracked: seconds });
    // Not within the working hours: the latest free stretch of the day, as it was tracked
    // outside them; only a full day falls back to the stretch before the stop.
    const placed = [place(opts.schedule), place(OFF_WEEK)].find(p => p.ok);
    const start = placed?.ok ? placed.start : new Date(end.getTime() - seconds * 1000);
    out.push({ timer, start, seconds });
    occupied.push({ start, seconds, label: `timer ${timer.issueKey}` });
  }
  return out;
}
