import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStartTimer } from "@/hooks/useStartTimer";
import { useTimers } from "@/hooks/useTimers";
import { flowControlProps } from "@/lib/workspace/instrumentation";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/**
 * ▶ for one issue, wherever the issue is shown as a card or tile (Board, Dashboard): its timer, without
 * opening it. None while its timer already runs. Its own click: never the card's drag or link.
 */
export function StartIssueButton({ issueKey, connectionId, controlId, className }: { issueKey: string; connectionId?: number; controlId: string; className?: string }) {
  const { timers } = useTimers();
  const start = useStartTimer({ announce: true });
  if (timers.some(timer => timer.state === "running" && timer.issueKey === issueKey)) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("size-7", className)}
      aria-label={t("ui.timer.startFor", { key: issueKey })}
      title={t("ui.timer.startFor", { key: issueKey })}
      disabled={start.isPending}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        start.mutate({ issueKey, connectionId });
      }}
      {...flowControlProps(controlId)}
    >
      <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
    </Button>
  );
}
