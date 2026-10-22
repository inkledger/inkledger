import { dayAndTime } from "@/lib/dates";
import { toastError } from "@/lib/errorText";
import { AlertTriangle, CloudOff, Lock } from "lucide-react";
import { surface } from "@/components/app/surface";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@contracts/time";
import { t } from "@/i18n";

export type SinkInfo = {
  state: "synced" | "pending" | "failed" | "conflict" | null;
  locked: { cause: string; message?: string } | null;
  remote: { seconds: number; started: number; comment: string } | null;
  error: string | null;
};


/**
 * Where a worklog stands on its tracker: waiting to be sent, refused, locked
 * there (changed there only), or changed on both sides (pick one).
 */
export function WorklogSinkState({ worklogId, sink, provider }: { worklogId: number; sink: SinkInfo; provider: string }) {
  const utils = trpc.useUtils();
  const resolve = trpc.worklogs.resolveConflict.useMutation({
    onSuccess: () => {
      toast.success(t("views.worklogSink.settled"));
      void utils.worklogs.list.invalidate();
    },
    onError: e => toastError(e),
  });
  return (
    <>
      {sink.locked && (
        <span title={sink.locked.message ?? undefined}>
          <Chip tone="neutral">
            <Lock className="h-3 w-3" aria-hidden /> {t("views.worklogSink.locked", { provider })}
          </Chip>
        </span>
      )}
      {sink.state === "pending" && (
        <Chip tone="warning">
          <CloudOff className="h-3 w-3" aria-hidden /> {t("views.worklogSink.pending", { provider })}
        </Chip>
      )}
      {sink.state === "failed" && (
        <span title={sink.error ?? undefined}>
          <Chip tone="danger">
            <AlertTriangle className="h-3 w-3" aria-hidden /> {t("views.worklogSink.failed", { provider })}
          </Chip>
        </span>
      )}
      {sink.state === "conflict" && sink.remote && (
        <div role="group" aria-label={t("views.worklogSink.conflictLabel")} {...surface("glass")} className="mt-1 grid w-full gap-1.5 rounded-lg border border-warning/40 bg-warning/5 p-2 text-body-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
            {t("views.worklogSink.conflict", { provider })}
          </p>
          <p className="text-caption text-muted-foreground">
            {t("views.worklogSink.theirs", {
              provider,
              duration: formatDuration(sink.remote.seconds),
              when: dayAndTime(sink.remote.started),
            })}
            {sink.remote.comment && ` · “${sink.remote.comment}”`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: worklogId, keep: "mine" })}>
              {t("views.worklogSink.keepMine")}
            </Button>
            <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: worklogId, keep: "theirs" })}>
              {t("views.worklogSink.keepTheirs", { provider })}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
