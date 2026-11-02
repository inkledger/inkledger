import { Coffee } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dayMonth } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { suggestBreakMove } from "@contracts/workSchedule";
import { t } from "@/i18n";
import { useSaveDayHours } from "./useDayHoursEdit";

/**
 * "You worked through your break, and there is a gap as long" (`move`, from
 * `suggestBreakMove`, worked out by the caller and only then mounted): one
 * tap moves that day's break into the gap (undo in the toast), so the gap
 * stops asking to be filled and new time goes around the break where it
 * really was. The caller offers it only on a day whose week is open.
 */
export function BreakSuggestion({
  day,
  move,
  className,
}: {
  day: Date;
  move: NonNullable<ReturnType<typeof suggestBreakMove>>;
  className?: string;
}) {
  const { save, pending } = useSaveDayHours();
  const { from, to, workDay } = move;
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground", className)}>
      <Coffee className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {t("views.dashboard.timeline.hours.suggest", { from: from.start, to: from.end, at: to.start })}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void save(day, workDay, t("views.dashboard.timeline.hours.moved", { day: dayMonth(day), from: to.start, to: to.end }))}
      >
        {t("views.dashboard.timeline.hours.suggestAction")}
      </Button>
    </div>
  );
}
