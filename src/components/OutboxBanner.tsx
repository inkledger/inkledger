import { useState } from "react";
import { CloudOff, RefreshCw, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatDuration } from "@contracts/time";
import { MAX_OUTBOX_ATTEMPTS } from "@contracts/types";
import { Button } from "@/components/ui/button";
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
import { Chip } from "@/components/app/Chip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";

const kindLabel = (kind: string): string =>
  kind === "create"
    ? t("ui.outbox.create")
    : kind === "update"
      ? t("ui.outbox.update")
      : kind === "delete"
        ? t("ui.outbox.delete")
        : kind;

/**
 * Slim bar shown under the header when there are worklog operations
 * queued offline. Allows manual replay and per-entry discard.
 */
export function OutboxBanner() {
  const provider = useProviderName();
  const utils = trpc.useUtils();
  const { data } = trpc.outbox.list.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const retry = trpc.outbox.retry.useMutation({
    onSuccess: r => {
      void utils.outbox.list.invalidate();
      void utils.worklogs.list.invalidate();
      if (r.remaining === 0) {
        toast.success(t("ui.outbox.allSynced", { provider }));
      } else if (r.synced > 0) {
        toast.info(
          t("ui.outbox.partlySynced", { count: r.synced, remaining: r.remaining })
        );
      } else {
        toast.error(t("ui.outbox.unreachable", { provider }));
      }
    },
    onError: e => toast.error(e.message),
  });
  const discard = trpc.outbox.discard.useMutation({
    onSuccess: () => {
      void utils.outbox.list.invalidate();
      void utils.worklogs.list.invalidate();
      toast.success(t("ui.outbox.discarded"));
    },
    onError: e => toast.error(e.message),
  });

  const [discarding, setDiscarding] = useState<number | null>(null);

  if (!data || data.length === 0) return null;

  return (
    <div className="border-b bg-warning-soft">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2 text-body-sm md:px-6">
        <CloudOff className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span className="text-foreground">
          <strong>{data.length}</strong>{" "}
          {t("ui.outbox.waiting", { count: data.length, provider })}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-warning hover:bg-warning/10"
            >
              {t("ui.outbox.details")}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(24rem,calc(100vw-2rem))] p-0"
          >
            <div className="border-b px-3 py-2 text-caption font-semibold">
              {t("ui.outbox.queue")}
            </div>
            <ul className="max-h-72 overflow-y-auto">
              {data.map(op => {
                const stuck = op.attempts >= MAX_OUTBOX_ATTEMPTS;
                return (
                  <li
                    key={op.id}
                    className="flex items-start gap-2 border-b px-3 py-2 text-caption last:border-0"
                  >
                    <Chip
                      tone={stuck ? "danger" : "warning"}
                      className="mt-0.5 shrink-0"
                    >
                      {kindLabel(op.kind)}
                    </Chip>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{op.issueKey}</div>
                      {op.issueSummary && (
                        <div className="truncate text-muted-foreground">
                          {op.issueSummary}
                        </div>
                      )}
                      <div className="text-muted-foreground">
                        {op.kind !== "delete" && (
                          <span>{formatDuration(op.timeSpentSeconds)} · </span>
                        )}
                        {stuck ? (
                          <span className="text-danger">
                            {t("ui.outbox.stuck", { count: op.attempts, provider })}
                          </span>
                        ) : (
                          op.attempts > 0 && (
                            <span>{t("ui.outbox.attempts", { count: op.attempts })}</span>
                          )
                        )}
                        {op.lastError && (
                          <span
                            className="block text-danger"
                            title={op.lastError}
                          >
                            {op.lastError.slice(0, 80)}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-danger"
                      aria-label={t("ui.outbox.discardFor", { key: op.issueKey })}
                      title={t("ui.outbox.discardTip")}
                      disabled={discard.isPending}
                      onClick={() => setDiscarding(op.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          className="ml-auto h-7 px-3"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${retry.isPending ? "motion-safe:animate-spin" : ""}`}
            aria-hidden
          />
          {t("ui.outbox.retryNow")}
        </Button>
      </div>

      <AlertDialog open={discarding !== null} onOpenChange={o => !o && setDiscarding(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.outbox.discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ui.outbox.discardBody", { provider })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                if (discarding) discard.mutate({ id: discarding });
              }}
            >
              {t("ui.outbox.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
