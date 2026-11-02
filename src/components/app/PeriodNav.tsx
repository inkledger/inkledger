import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";
import type { FlowControlAttributes } from "@/lib/workspace/instrumentation";

/** ‹ Today › grouped control for period navigation. */
export function PeriodNav({
  onPrev,
  onNext,
  onToday,
  isCurrent,
  todayLabel = t("common.today"),
  controls,
}: {
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  isCurrent: boolean;
  todayLabel?: string;
  /** Its buttons counted by FlowMap where the caller says so (the Dashboard's period). */
  controls?: { prev: FlowControlAttributes; today: FlowControlAttributes; next: FlowControlAttributes };
}) {
  return (
    <div {...surface("card")} className="flex items-center rounded-lg border bg-background">
      <Button
        variant="ghost"
        size="icon"
        className="rounded-r-none"
        onClick={onPrev}
        aria-label={t("ui.period.prev")}
        {...controls?.prev}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        className="rounded-none border-x px-3"
        onClick={onToday}
        disabled={isCurrent}
        {...controls?.today}
      >
        {todayLabel}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-l-none"
        onClick={onNext}
        aria-label={t("ui.period.next")}
        {...controls?.next}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
