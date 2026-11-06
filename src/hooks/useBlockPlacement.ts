import { useCallback, useMemo } from "react";
import { addDays, onMinute, startOfDay } from "@contracts/time";
import {
  conflictMessage,
  occupiedId,
  overlapping,
  placeBlock,
  type Block,
  type Occupied,
  type Placement,
} from "@contracts/placement";
import { trpc } from "@/lib/trpc";
import { useToday } from "@/hooks/useToday";
import { useTimers } from "@/hooks/useTimers";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { issueId } from "@/lib/issues";

/**
 * Where new time goes on `day` (today by default), and what it would collide
 * with: the worklogs of that day plus the timers (running until now, paused
 * until their stop). The one entry point for every "Log time".
 * `ready` is false until worklogs, schedule and timers are loaded: nothing
 * may be placed on guesses. `error`: one of them failed (`retry` reads it again).
 */
export function useBlockPlacement(
  day?: Date,
  /**
   * excludeTimer: a timer's identity (issueId) whose own time is being placed;
   * shared: the timers it ran beside, whose time together it shares (not a collision).
   */
  opts: { excludeTimer?: string; shared?: readonly string[] } = {}
) {
  const today = useToday();
  const from = useMemo(() => startOfDay(day ?? today), [day, today]);
  const logs = trpc.worklogs.list.useQuery({
    from: from.toISOString(),
    to: addDays(from, 1).toISOString(),
  });
  const schedule = useWorkSchedule();
  const timerState = useTimers();
  // As one string: a new array each render must not recompute the placement.
  const sharedKey = ` ${(opts.shared ?? []).join(" ")} `;
  const { timers, query: timersQuery } = timerState;
  const ready = !!logs.data && !schedule.isPending && !!timersQuery.data;

  const occupied = useMemo<Occupied[]>(() => {
    const out: Occupied[] = (logs.data ?? []).map(w => ({
      start: new Date(w.started),
      seconds: w.timeSpentSeconds,
      id: occupiedId(w),
      label: w.issueKey,
    }));
    for (const t of timers) {
      if (issueId(t) === opts.excludeTimer || sharedKey.includes(` ${issueId(t)} `) || t.elapsedSeconds <= 0) continue;
      // Real run segments are not stored: the tracked time is taken as the
      // stretch right before the stop (or before the fetch while running), on the
      // server's moments rounded to the minute as its log will be: a timer
      // started where another stopped begins right where that one's block ends.
      const start = onMinute(new Date(t.trackedFrom).getTime());
      const end = onMinute(new Date(t.pausedAt ?? t.serverNow).getTime());
      if (end <= start) continue;
      out.push({
        start: new Date(start),
        seconds: (end - start) / 1000,
        label: `timer ${t.issueKey}`,
        timer: issueId(t),
      });
    }
    return out;
  }, [logs.data, timers, opts.excludeTimer, sharedKey]);

  /**
   * Place `seconds` (ending at `endAt` for a stopped timer), around the day's
   * breaks: `parts` when split. A timer of its own (`excludeTimer`) that ran
   * without a pause stays in one piece.
   */
  const place = useCallback(
    (seconds: number, at: { now: Date; endAt?: Date; tracked?: number }): Placement =>
      placeBlock({
        day: from,
        seconds,
        occupied,
        schedule: schedule.forDay(from),
        now: at.now,
        endAt: at.endAt,
        tracked: at.tracked,
        unbroken: at.tracked !== undefined && !!timers.find(t => issueId(t) === opts.excludeTimer)?.unbroken,
      }),
    [from, occupied, schedule, timers, opts.excludeTimer]
  );

  /** Collision message for a block chosen by hand, or null. */
  const conflictOf = useCallback(
    (block: Block, exceptId?: string): string | null => {
      const hits = overlapping(block, occupied, exceptId);
      return hits.length > 0 ? conflictMessage(hits) : null;
    },
    [occupied]
  );

  /** What the placement needs couldn't be read: nothing may be placed until a retry reads it. */
  const error = !ready && (logs.isError || timersQuery.isError);
  const retry = useCallback(() => {
    if (logs.isError) void logs.refetch();
    if (timersQuery.isError) void timersQuery.refetch();
  }, [logs, timersQuery]);

  return { ready, error, retry, place, conflictOf, occupied };
}
