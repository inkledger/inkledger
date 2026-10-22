import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useStartTimer } from "@/hooks/useStartTimer";
import { startChoice } from "@/lib/startChoice";
import { timeOfDay } from "@/lib/dates";
import { formatDurationLong } from "@contracts/time";
import { t } from "@/i18n";

/**
 * Play while a hole of today is still open: count from now, or from the
 * hole's start (its time then belongs to this timer). Asked once per Play.
 */
export function StartChoiceDialog() {
  const pending = startChoice.use();
  const loud = useStartTimer({ announce: true, ask: false });
  const quiet = useStartTimer({ ask: false });
  const close = () => startChoice.ask(null);
  const start = (from?: Date) => {
    if (!pending) return;
    (pending.announce ? loud : quiet).mutate({ ...pending.input, ...(from ? { from: from.toISOString() } : {}) });
    close();
  };
  const gap = pending?.gap;
  return (
    <AlertDialog open={!!pending} onOpenChange={open => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("ui.startChoice.title", { key: pending?.input.issueKey ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {gap ? t("ui.startChoice.body", { from: timeOfDay(gap.start), duration: formatDurationLong(gap.seconds) }) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <Button variant="outline" onClick={() => start()}>
            {t("ui.startChoice.now")}
          </Button>
          <AlertDialogAction autoFocus onClick={() => gap && start(gap.start)}>
            {gap ? t("ui.startChoice.fromGap", { from: timeOfDay(gap.start) }) : ""}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
