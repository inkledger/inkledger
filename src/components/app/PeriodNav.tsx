import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** ‹ Today › grouped control for period navigation. */
export function PeriodNav({
  onPrev,
  onNext,
  onToday,
  isCurrent,
  todayLabel = t("common.today"),
}: {
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  isCurrent: boolean;
  todayLabel?: string;
}) {
  return (
    <div data-lit="1" className="flex items-center rounded-lg border bg-background">
      <Button
        variant="ghost"
        size="icon"
        className="rounded-r-none"
        onClick={onPrev}
        aria-label={t("ui.period.prev")}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        className="rounded-none border-x px-3"
        onClick={onToday}
        disabled={isCurrent}
      >
        {todayLabel}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-l-none"
        onClick={onNext}
        aria-label={t("ui.period.next")}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
