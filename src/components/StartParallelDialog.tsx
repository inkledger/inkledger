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
import { lastStartMode, startParallel, type StartMode } from "@/lib/startParallel";
import { trpc } from "@/lib/trpc";
import { formatDurationLong } from "@contracts/time";
import { t } from "@/i18n";

/**
 * Play while other timers run: switch to it (they stop, their time asked to
 * be logged) or run it beside them (their time together shared out at their
 * logs). Enter gives the answer last given on this device. While overlapping
 * time is refused, only Switch.
 */
export function StartParallelDialog() {
  const pending = startParallel.use();
  const last = lastStartMode.use();
  const settings = trpc.settings.get.useQuery(undefined, { enabled: !!pending, staleTime: 60_000 });
  const loud = useStartTimer({ announce: true });
  const quiet = useStartTimer({});
  const close = () => startParallel.ask(null);
  const blocked = settings.data?.overlapPolicy === "block";
  const start = (mode: StartMode) => {
    if (!pending) return;
    lastStartMode.set(mode);
    (pending.announce ? loud : quiet).mutate({ ...pending.input, mode });
    close();
  };
  const running = pending?.running ?? [];
  const list = running.map(r => `${r.issueKey} · ${formatDurationLong(Math.round(r.elapsedSeconds / 60) * 60)}`).join(", ");
  const preferred: StartMode = blocked ? "switch" : last;
  const choice = (mode: StartMode) =>
    mode === "switch" ? t("ui.startParallel.switch") : running.length > 1 ? t("ui.startParallel.runAll") : t("ui.startParallel.runBoth");
  const hint = (mode: StartMode) => (mode === "switch" ? t("ui.startParallel.switchHint") : t("ui.startParallel.runHint"));
  const other: StartMode = preferred === "switch" ? "alongside" : "switch";
  return (
    <AlertDialog open={!!pending} onOpenChange={open => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">{t("ui.startParallel.title", { list })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("ui.startParallel.body", { key: pending?.input.issueKey ?? "" })}{" "}
            {blocked ? t("ui.startParallel.blocked") : hint(preferred)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          {/* The answer not given last: a click away. Running both is off while overlapping time is refused. */}
          <Button variant="outline" disabled={other === "alongside" && blocked} title={hint(other)} onClick={() => start(other)}>
            {choice(other)}
          </Button>
          <AlertDialogAction autoFocus title={hint(preferred)} onClick={() => start(preferred)}>
            {choice(preferred)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
