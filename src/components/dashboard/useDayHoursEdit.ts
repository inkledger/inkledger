import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { dayMonth } from "@/lib/dates";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { dayKey } from "@contracts/time";
import { minutesOf, sameWorkDay, weekdayIndex, type WorkDay } from "@contracts/workSchedule";
import { t } from "@/i18n";
import { saveChoice } from "./dayHours";

/**
 * Save a day's own hours (`null`: back to the week's), with a toast that
 * undoes it: the day gets back the hours it had before.
 */
export function useSaveDayHours() {
  const utils = trpc.useUtils();
  const { overrides } = useWorkSchedule();
  const saveDay = trpc.workSchedule.saveDay.useMutation();
  const removeDay = trpc.workSchedule.removeDay.useMutation();
  // The stable functions, not the mutations' result objects (new on every render).
  const { mutateAsync: saveAsync } = saveDay;
  const { mutateAsync: removeAsync } = removeDay;

  const write = useCallback(
    async (key: string, hours: WorkDay | null) => {
      const days = hours ? await saveAsync({ day: key, workDay: hours }) : await removeAsync({ day: key });
      utils.workSchedule.days.setData(undefined, days);
    },
    [saveAsync, removeAsync, utils]
  );

  const save = useCallback(
    async (day: Date, hours: WorkDay | null, message?: string): Promise<boolean> => {
      const key = dayKey(day);
      const before = overrides[key] ?? null;
      try {
        await write(key, hours);
      } catch (e) {
        toastError(e);
        return false;
      }
      toast.success(
        message ?? (hours ? t("views.dashboard.timeline.hours.saved", { day: dayMonth(day) }) : t("views.dashboard.timeline.hours.restored", { day: dayMonth(day) })),
        {
          // One toast per day: a second save replaces the first, so Undo always
          // goes back one step (never to hours older than the last save).
          id: `day-hours-${key}`,
          action: {
            label: t("views.dashboard.timeline.hours.undo"),
            onClick: () => void write(key, before).catch(e => toastError(e)),
          },
        }
      );
      return true;
    },
    [overrides, write]
  );

  return { save, pending: saveDay.isPending || removeDay.isPending };
}

/** Axis of the timeline while editing, in hours: the day ±2 h, fixed for the whole session. */
export type EditAxis = { first: number; last: number };

/**
 * Editing a day's hours on its timeline: a draft (always valid), started and
 * left explicitly, saved only on Save.
 */
export function useDayHoursEdit(day: Date) {
  const schedule = useWorkSchedule();
  const current: WorkDay = schedule.forDay(day)[weekdayIndex(day)];
  const base = schedule.baseForDay(day);
  const overridden = schedule.isOverridden(day);
  const { save, pending } = useSaveDayHours();
  // The week's lock (the page's own query, shared): no editing until it is known.
  const week = trpc.weeks.status.useQuery({ week: dayKey(day) });
  const closed = !!week.data;
  const [draft, setDraft] = useState<WorkDay | null>(null);
  const [axis, setAxis] = useState<EditAxis | null>(null);
  const [draftDay, setDraftDay] = useState<string | null>(null);

  // A draft belongs to its day: another day shows no draft (the page asks before leaving one).
  const live = draftDay === dayKey(day) ? draft : null;

  const start = useCallback(() => {
    // The axis around the hours the draft starts from (a day off starts from the week's, or 9–18).
    const first = current.enabled ? current : { ...base, enabled: true };
    const from = minutesOf(first.start) / 60;
    const to = minutesOf(first.end) / 60;
    setAxis({ first: Math.max(0, Math.floor(from) - 2), last: Math.min(24, Math.ceil(to) + 2) });
    setDraft(first);
    setDraftDay(dayKey(day));
  }, [current, base, day]);

  const cancel = useCallback(() => {
    setDraft(null);
    setDraftDay(null);
  }, []);

  const dirty = !!live && !sameWorkDay(live, current);

  /** Save `hours` as the day's (the week's own: back to them); whether it was saved. */
  const commit = useCallback(
    async (hours: WorkDay): Promise<boolean> => {
      const ok = await save(day, sameWorkDay(hours, base) ? null : hours);
      if (ok) cancel();
      return ok;
    },
    [save, day, base, cancel]
  );

  /** Enter: save the draft at once when nothing has to be chosen (else the bar shows the choice). */
  const submit = useCallback(() => {
    if (!pending && live && !sameWorkDay(live, current) && !saveChoice(current, base, live)) void commit(live);
  }, [pending, live, current, base, commit]);

  const reset = useCallback(async () => {
    if (await save(day, null)) cancel();
  }, [save, day, cancel]);

  const ready = !schedule.isPending && week.isSuccess;
  const shownAxis = live ? axis : null;
  // One object while nothing changes: the bar above a ticking timeline doesn't render again.
  return useMemo(
    () => ({ current, base, overridden, draft: live, setDraft, axis: shownAxis, dirty, start, cancel, commit, submit, reset, pending, ready, closed }),
    [current, base, overridden, live, shownAxis, dirty, start, cancel, commit, submit, reset, pending, ready, closed]
  );
}

export type DayHoursEdit = ReturnType<typeof useDayHoursEdit>;
