import { useId } from "react";
import { dayMonth, timeOfDay } from "@/lib/dates";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { useSaveDayHours } from "@/components/dashboard/useDayHoursEdit";
import { breakAt, breakHolding } from "@/components/dashboard/dayHours";
import { dayKey, startOfDay } from "@contracts/time";
import { weekdayIndex } from "@contracts/workSchedule";
import { toastError, failureText } from "@/lib/errorText";
import { ArrowRightLeft, Check, Coffee, Scissors, type LucideIcon } from "lucide-react";
import { formatDuration } from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { useIdleDetection } from "@/hooks/useIdleDetection";
import { quickStart } from "@/lib/quickStart";
import { timerLog } from "@/lib/timerLog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { t } from "@/i18n";
import { issueId } from "@/lib/issues";
import { surface } from "@/components/app/surface";


/** "You were away 25 min": keep, remove or move the away time of the running timer. */
export function IdleDialog() {
  const { away, dismiss } = useIdleDetection();
  const utils = trpc.useUtils();
  const trim = trpc.timers.trim.useMutation({
    onSuccess: () => utils.timers.list.invalidate(),
    onError: e => toastError(e),
  });
  const schedule = useWorkSchedule();
  const { save: saveHours } = useSaveDayHours();
  // A closed week's hours can't change: no "my break" there (nor while that's unknown).
  const week = trpc.weeks.status.useQuery({ week: dayKey(away?.since ?? new Date()) }, { enabled: !!away });
  if (!away) return null;

  const minutes = Math.round(away.seconds / 60) * 60;
  // "It was my break": the away time leaves the timer and becomes the day's break
  // (holes and placement follow), when it falls within that day's hours.
  const awayDay = startOfDay(away.since);
  const awayEnd = new Date(away.since.getTime() + away.seconds * 1000);
  const sameDay = dayKey(awayEnd) === dayKey(away.since);
  const known = sameDay && !schedule.isPending && week.isSuccess && week.data === null;
  const hours = schedule.forDay(awayDay)[weekdayIndex(awayDay)];
  const awayFrom = away.since.getHours() * 60 + away.since.getMinutes();
  const awayTo = awayEnd.getHours() * 60 + awayEnd.getMinutes() + (awayEnd.getSeconds() > 0 ? 1 : 0);
  // Away inside the day's own break (lunch 13–14, away 13:40–13:57): that break stays as it is,
  // the time only leaves the timer. Moving a break there would have shrunk it.
  const holding = known ? breakHolding(hours, awayFrom, awayTo) : null;
  const asBreak = known && !holding ? breakAt(hours, awayFrom, awayTo) : null;
  const moved = asBreak?.breaks.find(b => !hours.breaks.some(x => x.start === b.start && x.end === b.end));
  // Timers side by side on this device: the time away leaves every one of them.
  const trimOthers = (seconds: number) =>
    Promise.all(away.alsoOn.map(o => utils.client.timers.trim.mutate({ ...o, seconds })))
      .then(() => void utils.timers.list.invalidate())
      .catch((e: unknown) => toastError(e));
  const remove = () =>
    trim.mutate(
      { issueKey: away.issueKey, connectionId: away.connectionId, seconds: away.seconds },
      {
        onSuccess: () => {
          void trimOthers(away.seconds);
          dismiss();
        },
      }
    );

  return (
    <Dialog open onOpenChange={o => !o && dismiss()}>
      <DialogContent
        className="sm:max-w-md"
        // Focus first on "Assign to another issue", never on an answer that writes at once.
        onOpenAutoFocus={e => {
          const assign = document.querySelector<HTMLElement>("[data-idle-assign]");
          if (!assign) return;
          e.preventDefault();
          assign.focus();
        }}
      >
        <DialogHeader>
          <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary-strong" {...surface("picture")}>
            <Coffee className="h-5 w-5" aria-hidden />
          </span>
          <DialogTitle>{t("ui.idle.title", { duration: formatDuration(away.seconds) })}</DialogTitle>
          <DialogDescription>
            {t("ui.idle.sinceBefore", { time: timeOfDay(away.since) })}{" "}
            <span className="font-medium text-foreground">{away.issueKey}</span>{" "}
            {t("ui.idle.sinceAfter")}
            {away.alsoOn.length > 0 && <> {t("ui.idle.alsoOn", { keys: away.alsoOn.map(o => o.issueKey).join(", ") })}</>}
          </DialogDescription>
        </DialogHeader>
        {/* A decision, so a list of choices (docs/design-system.md §7.1): each one a whole row, its
            name and what it does, in the order they are wanted; none written before it is picked. */}
        <div role="group" aria-label={t("ui.idle.choices")} className="grid gap-1.5">
          {holding && (
            <Choice
              icon={Coffee}
              title={t("ui.idle.myBreak")}
              detail={`${holding.start}–${holding.end} · ${t("ui.idle.myBreakInsideWhat")}`}
              label={t("ui.idle.myBreakInsideTitle", { duration: formatDuration(away.seconds), from: holding.start, to: holding.end })}
              disabled={trim.isPending}
              onPick={() => remove()}
            />
          )}
          {asBreak && moved && (
            <Choice
              icon={Coffee}
              title={t("ui.idle.myBreak")}
              detail={`${moved.start}–${moved.end} · ${t("ui.idle.myBreakWhat")}`}
              label={t("ui.idle.myBreakTitle", { duration: formatDuration(away.seconds), from: moved.start, to: moved.end })}
              disabled={trim.isPending}
              onPick={() =>
              // The break first: when it can't be saved, the timer keeps its time.
              void saveHours(awayDay, asBreak, t("views.dashboard.timeline.hours.moved", { day: dayMonth(awayDay), from: moved.start, to: moved.end })).then(ok => {
                if (ok) remove();
              })
              }
            />
          )}
          <Choice
            icon={Scissors}
            title={t("ui.idle.remove", { duration: formatDuration(away.seconds) })}
            detail={t("ui.idle.removeWhat")}
            disabled={trim.isPending}
            onPick={() => remove()}
          />
          <Choice
            icon={ArrowRightLeft}
            title={t("ui.idle.assign")}
            detail={t("ui.idle.assignWhat")}
            assign
            disabled={trim.isPending}
            onPick={() => {
              // The running timer is trimmed only once the time is logged
              // elsewhere: backing out of the picker or the dialog loses nothing.
              const { issueKey, connectionId, seconds, since, alsoOn } = away;
              dismiss();
              // Vanilla client: this dialog is gone by the time it is saved.
              // A failed trim would count the away time twice: say so, retry.
              const removeAway = (): Promise<void> =>
                Promise.all([{ issueKey, connectionId }, ...alsoOn].map(o => utils.client.timers.trim.mutate({ ...o, seconds })))
                  .then(() => void utils.timers.list.invalidate())
                  .catch((e: unknown) => {
                    toast.error(
                      t("ui.idle.removeFailed", { key: issueKey }),
                      {
                        description: failureText(e),
                        duration: Infinity,
                        action: { label: t("common.retry"), onClick: () => void removeAway() },
                      }
                    );
                  });
              quickStart.pick(({ key, connectionId: toConnection }) => {
                timerLog.push({
                  issueKey: key,
                  connectionId: toConnection,
                  seconds: minutes,
                  fromTimer: false,
                  start: since,
                  // The away time is inside this timer: not a collision.
                  excludeTimer: issueId({ key: issueKey, connectionId }),
                  onSaved: () => void removeAway(),
                });
              }, t("ui.idle.assignPlaceholder"));
            }}
          />
          <Choice icon={Check} title={t("ui.idle.keep")} detail={t("ui.idle.keepWhat", { key: away.issueKey })} onPick={dismiss} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One answer of the dialog: a whole row, its name and, under it, what it does. */
function Choice({ icon: Icon, title, detail, label, disabled, assign, onPick }: { icon: LucideIcon; title: string; detail: string; label?: string; disabled?: boolean; assign?: boolean; onPick: () => void }) {
  // Named by its answer, described by what it does: "Keep", then "It stays on APP-12".
  const id = useId();
  return (
    <button
      type="button"
      aria-label={title}
      aria-describedby={id}
      disabled={disabled}
      title={label}
      data-idle-assign={assign ? "" : undefined}
      onClick={onPick}
      {...surface("control")}
      className="flex w-full items-start gap-3 rounded-lg border bg-card px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="grid min-w-0">
        <span className="text-body-sm font-medium">{title}</span>
        <span id={id} className="text-caption text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}
