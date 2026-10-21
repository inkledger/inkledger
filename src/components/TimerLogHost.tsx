import { LogTimeDialog } from "@/components/LogTimeDialog";
import { timerLog, useTimerLogQueue } from "@/lib/timerLog";
import { t } from "@/i18n";

/**
 * Single place where stopped timers ask to be logged, wherever they were
 * stopped (explicit stop, or switching the timer to another issue).
 * "Later" keeps the timer paused, visible in the sidebar.
 */
export function TimerLogHost() {
  const [current] = useTimerLogQueue();
  if (!current) return null;
  return (
    <LogTimeDialog
      key={`${current.issueKey}-${current.end?.getTime() ?? current.start?.getTime() ?? ""}`}
      issueKey={current.issueKey}
      connectionId={current.connectionId}
      prefillSeconds={current.seconds}
      prefillComment={current.note}
      prefillStart={current.start}
      endAt={current.end}
      excludeTimer={current.excludeTimer}
      fromTimer={current.fromTimer ?? true}
      onDone={current.onSaved}
      title={t("ui.timerLog.title", { key: current.issueKey })}
      cancelLabel={t("ui.timerLog.later")}
      open
      onOpenChange={o => {
        if (!o) timerLog.shift();
      }}
    />
  );
}
