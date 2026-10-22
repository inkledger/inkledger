import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { timerLog } from "@/lib/timerLog";
import { newOpId, thisDevice, timerConflictOf } from "@/lib/timerConflict";
import { toast } from "sonner";
import { addDays, dayKey, startOfDay, type TimeSpan } from "@contracts/time";
import { missingSpans, openGap, scheduleFor } from "@contracts/workSchedule";
import { startChoice } from "@/lib/startChoice";
import { t } from "@/i18n";

type StartInput = { issueKey: string; connectionId?: number; force?: boolean; from?: string };
type Utils = ReturnType<typeof trpc.useUtils>;

/**
 * The hole of today still open (reaching now, nothing logged or tracked in it),
 * read when Play is pressed: none while a timer runs or the week is closed.
 */
async function openGapNow(utils: Utils): Promise<TimeSpan | null> {
  const now = new Date();
  const day = startOfDay(now);
  const fresh = { staleTime: 30_000 };
  const timers = await utils.timers.list.fetch(undefined, fresh);
  if (timers.some(tm => tm.state === "running")) return null;
  const [week, logs, versions] = await Promise.all([
    utils.weeks.status.fetch({ week: dayKey(day) }, fresh),
    utils.worklogs.list.fetch({ from: day.toISOString(), to: addDays(day, 1).toISOString() }, fresh),
    utils.workSchedule.list.fetch(undefined, { staleTime: 5 * 60_000 }),
  ]);
  if (week !== null) return null;
  const logged: TimeSpan[] = logs.map(w => ({ start: new Date(w.started), seconds: w.timeSpentSeconds }));
  // A paused timer's time is tracked, not a hole (as on the Dashboard).
  const paused: TimeSpan[] = timers.flatMap(tm =>
    !tm.pausedAt || tm.elapsedSeconds <= 0 ? [] : [{ start: new Date(new Date(tm.pausedAt).getTime() - tm.elapsedSeconds * 1000), seconds: tm.elapsedSeconds }]
  );
  return openGap(missingSpans(day, scheduleFor(day, versions), [...logged, ...paused], now), now);
}

/**
 * Start (or resume) a timer. Switching issue stops the previous timer, whose
 * time is queued for logging in the global "Log time" dialog. When another
 * device holds the running timer, the refusal says where and offers to take
 * it over (it keeps its time: nothing is counted twice). With a hole of today
 * still open, Play asks first: from now, or from the hole's start (`ask`:
 * false where nobody is there to answer, e.g. the tray).
 */
export function useStartTimer(opts: { announce?: boolean; ask?: boolean } = {}) {
  const utils = trpc.useUtils();
  const m = trpc.timers.start.useMutation({
    onSuccess: (r, { issueKey }) => {
      void utils.timers.list.invalidate();
      if (r.tookOver) toast.success(t("ui.timer.tookOver", { key: issueKey }));
      else if (opts.announce) toast.success(t("ui.startTimer.started", { key: issueKey }));
      if (r.switchedFrom) {
        timerLog.push({ ...r.switchedFrom, end: r.switchedFrom.stoppedAt });
        toast.info(t("ui.startTimer.switched", { key: r.switchedFrom.issueKey }));
      }
    },
    onError: (e, input) => {
      const c = timerConflictOf(e);
      void utils.timers.list.invalidate();
      if (c?.reason === "held") {
        toast.error(e.message, {
          action: { label: t("ui.timer.takeOver"), onClick: () => mutate({ ...input, force: true }) },
        });
      } else toastError(e);
    },
  });
  const send = (input: StartInput) => m.mutate({ ...input, opId: newOpId(), device: thisDevice() });
  const mutate = (input: StartInput) => {
    if (opts.ask === false || input.force || input.from) return send(input);
    void openGapNow(utils).then(
      gap => (gap ? startChoice.ask({ input: { issueKey: input.issueKey, connectionId: input.connectionId }, gap, announce: !!opts.announce }) : send(input)),
      // Unknown (offline): started now, as before.
      () => send(input)
    );
  };
  return { mutate, isPending: m.isPending };
}
