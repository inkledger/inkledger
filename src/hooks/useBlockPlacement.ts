import { useCallback, useMemo } from "react";
import { addDays, startOfDay } from "@contracts/time";
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
 * may be placed on guesses.
 */
export function useBlockPlacement(
  day?: Date,
  /** excludeTimer: a timer's identity (issueId) whose own time is being placed */
  opts: { excludeTimer?: string } = {}
) {
  const today = useToday();
  const from = useMemo(() => startOfDay(day ?? today), [day, today]);
  const logs = trpc.worklogs.list.useQuery({
    from: from.toISOString(),
    to: addDays(from, 1).toISOString(),
  });
  const schedule = useWorkSchedule();
  const { timers, fetchedAt, query: timersQuery } = useTimers();
  const ready = !!logs.data && !schedule.isPending && !!timersQuery.data;

  const occupied = useMemo<Occupied[]>(() => {
    const out: Occupied[] = (logs.data ?? []).map(w => ({
      start: new Date(w.started),
      seconds: w.timeSpentSeconds,
      id: occupiedId(w),
      label: w.issueKey,
    }));
    for (const t of timers) {
      if (issueId(t) === opts.excludeTimer || t.elapsedSeconds <= 0) continue;
      // Real run segments are not stored: the tracked time is taken as the
      // stretch right before the stop (or before now while running).
      const end = t.pausedAt ? new Date(t.pausedAt).getTime() : fetchedAt;
      out.push({
        start: new Date(end - t.elapsedSeconds * 1000),
        seconds: t.elapsedSeconds,
        label: `timer ${t.issueKey}`,
        timer: issueId(t),
      });
    }
    return out;
  }, [logs.data, timers, fetchedAt, opts.excludeTimer]);

  /** Place `seconds` (ending at `endAt` for a stopped timer). */
  const place = useCallback(
    (seconds: number, at: { now: Date; endAt?: Date }): Placement =>
      placeBlock({
        day: from,
        seconds,
        occupied,
        schedule: schedule.forDay(from),
        now: at.now,
        endAt: at.endAt,
      }),
    [from, occupied, schedule]
  );

  /** Collision message for a block chosen by hand, or null. */
  const conflictOf = useCallback(
    (block: Block, exceptId?: string): string | null => {
      const hits = overlapping(block, occupied, exceptId);
      return hits.length > 0 ? conflictMessage(hits) : null;
    },
    [occupied]
  );

  return { ready, place, conflictOf, occupied };
}
