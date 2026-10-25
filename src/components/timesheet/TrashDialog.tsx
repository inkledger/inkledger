import { dayAndTime } from "@/lib/dates";
import { errorText, toastError } from "@/lib/errorText";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { formatDuration } from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import { useProviderName } from "@/hooks/useConnections";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState } from "@/components/app/States";
import { t } from "@/i18n";


/** Worklogs deleted in the last 30 days, each one click from coming back. */
export function TrashDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const provider = useProviderName();
  const invalidate = useInvalidateWorklogs();
  const utils = trpc.useUtils();
  const trash = trpc.worklogs.trash.useQuery(undefined, { enabled: open });
  const restore = trpc.worklogs.restore.useMutation({
    onSuccess: w => {
      toast.success(t("pages.timesheet.restored", { key: w.issueKey }));
      void utils.worklogs.trash.invalidate();
      invalidate();
    },
    onError: e => toastError(e),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pages.timesheet.trash")}</DialogTitle>
          <DialogDescription>{t("pages.timesheet.trashHint", { provider })}</DialogDescription>
        </DialogHeader>
        {trash.error ? (
          <ErrorState className="py-4" message={errorText(trash.error)} onRetry={() => void trash.refetch()} />
        ) : trash.isPending ? (
          <p className="text-body-sm text-muted-foreground">{t("common.loading")}</p>
        ) : trash.data.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">{t("pages.timesheet.trashEmpty")}</p>
        ) : (
          <ul className="divide-y">
            {trash.data.map(w => (
              <li key={w.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body-sm font-medium">
                    {w.issueKey} · {formatDuration(w.timeSpentSeconds)}
                  </p>
                  <p className="truncate text-caption text-muted-foreground">
                    {dayAndTime(w.started)} ·{" "}
                    {w.reason === "user" ? t("pages.timesheet.deletedByYou") : t("pages.timesheet.removedOn", { provider })}
                    {w.comment ? ` · ${w.comment}` : ""}
                  </p>
                </div>
                <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => restore.mutate({ id: w.id })}>
                  <RotateCcw />
                  {t("pages.timesheet.restore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
