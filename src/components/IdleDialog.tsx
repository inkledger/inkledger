import { Coffee } from "lucide-react";
import { formatDuration } from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { useIdleDetection } from "@/hooks/useIdleDetection";
import { quickStart } from "@/lib/quickStart";
import { timerLog } from "@/lib/timerLog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { dateFormat, t } from "@/i18n";
import { issueId } from "@/lib/issues";
import { surface } from "@/components/app/surface";

const time = () => dateFormat({ hour: "2-digit", minute: "2-digit" });

/** "You were away 25 min": keep, remove or move the away time of the running timer. */
export function IdleDialog() {
  const { away, dismiss } = useIdleDetection();
  const utils = trpc.useUtils();
  const trim = trpc.timers.trim.useMutation({
    onSuccess: () => utils.timers.list.invalidate(),
    onError: e => toast.error(e.message),
  });
  if (!away) return null;

  const minutes = Math.round(away.seconds / 60) * 60;
  const remove = (then?: () => void) =>
    trim.mutate(
      { issueKey: away.issueKey, connectionId: away.connectionId, seconds: away.seconds },
      {
        onSuccess: () => {
          dismiss();
          then?.();
        },
      }
    );

  return (
    <Dialog open onOpenChange={o => !o && dismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary-strong" {...surface("picture")}>
            <Coffee className="h-5 w-5" aria-hidden />
          </span>
          <DialogTitle>{t("ui.idle.title", { duration: formatDuration(away.seconds) })}</DialogTitle>
          <DialogDescription>
            {t("ui.idle.sinceBefore", { time: time().format(away.since) })}{" "}
            <span className="font-medium text-foreground">{away.issueKey}</span>{" "}
            {t("ui.idle.sinceAfter")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            disabled={trim.isPending}
            onClick={() => {
              // The running timer is trimmed only once the time is logged
              // elsewhere: backing out of the picker or the dialog loses nothing.
              const { issueKey, connectionId, seconds, since } = away;
              dismiss();
              // Vanilla client: this dialog is gone by the time it is saved.
              // A failed trim would count the away time twice: say so, retry.
              const removeAway = (): Promise<void> =>
                utils.client.timers.trim
                  .mutate({ issueKey, connectionId, seconds })
                  .then(() => void utils.timers.list.invalidate())
                  .catch((e: unknown) => {
                    toast.error(
                      t("ui.idle.removeFailed", { key: issueKey }),
                      {
                        description: e instanceof Error ? e.message : undefined,
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
          >
            {t("ui.idle.assign")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={dismiss}>
              {t("ui.idle.keep")}
            </Button>
            <Button disabled={trim.isPending} onClick={() => remove()}>
              {t("ui.idle.remove", { duration: formatDuration(away.seconds) })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
