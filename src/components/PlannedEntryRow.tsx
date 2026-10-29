import { useState } from "react";
import { ArrowRight, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import { formatDuration, formatDurationLong } from "@contracts/time";
import { type PlannedEntry } from "@contracts/planned";
import { plannedKindLabel } from "@/lib/planned";
import { timeOfDay } from "@/lib/dates";
import { t } from "@/i18n";
import { ActionRow } from "@/components/app/ActionRow";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export function PlannedEntryRow({ entry, seconds, onEdit, className }: { entry: PlannedEntry; seconds?: number; onEdit: (entry: PlannedEntry) => void; className?: string }) {
  return (
    <ActionRow
      className={cn("rounded-lg border border-dashed bg-card/60 p-2.5", entry.kind === "vacation" && "border-primary-strong/30 bg-primary-soft/50", className)}
      actions={<PlannedActions entry={entry} onEdit={onEdit} />}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Chip tone={entry.kind === "vacation" ? "success" : "neutral"}>{plannedKindLabel(entry.kind)}</Chip>
        <span className="font-medium">{t("ui.planned.status")}</span>
        <span className="text-muted-foreground tabular">{formatDuration(seconds ?? Math.round((entry.endsAt.getTime() - entry.startsAt.getTime()) / 1000))}</span>
        {entry.convertedWorklogId !== null && <Chip tone="success">{t("ui.planned.converted")}</Chip>}
      </div>
      <p className="mt-1 text-body-sm text-muted-foreground tabular">
        {timeOfDay(entry.startsAt)}–{timeOfDay(entry.endsAt)}
        {entry.issueKey && <span className="ml-2 font-medium text-foreground">{entry.issueKey}</span>}
      </p>
      {entry.note && <p className="mt-1 line-clamp-2 [overflow-wrap:anywhere] text-caption">{entry.note}</p>}
    </ActionRow>
  );
}

export function PlannedActions({ entry, onEdit }: { entry: PlannedEntry; onEdit: (entry: PlannedEntry) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const utils = trpc.useUtils();
  const invalidateWorklogs = useInvalidateWorklogs();
  const remove = trpc.planned.remove.useMutation({
    onSuccess: () => {
      void utils.planned.invalidate();
      setConfirmDelete(false);
      toast.success(t("ui.planned.deleted"));
    },
    onError: e => toastError(e),
  });
  const convert = trpc.planned.convert.useMutation({
    onSuccess: () => {
      void utils.planned.invalidate();
      invalidateWorklogs();
      toast.success(t("ui.planned.convertDone"));
    },
    onError: e => toastError(e),
  });
  const busy = remove.isPending || convert.isPending;
  const convertible = entry.kind !== "vacation" && entry.convertedWorklogId === null;

  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {convertible && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => convert.mutate({ id: entry.id })} aria-label={t("ui.planned.convert")}>
          <ArrowRight className="h-4 w-4" />
          <span className="max-lg:sr-only">{convert.isPending ? t("ui.planned.converting") : t("ui.planned.convert")}</span>
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" disabled={busy} onClick={() => onEdit(entry)} aria-label={t("ui.planned.edit")} title={t("ui.planned.edit")}>
        <Pencil className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-danger" disabled={busy} onClick={() => setConfirmDelete(true)} aria-label={t("ui.planned.delete")} title={t("ui.planned.delete")}>
        <Trash2 className="h-4 w-4" />
      </Button>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.planned.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("ui.planned.deleteBody", { kind: plannedKindLabel(entry.kind), duration: formatDurationLong(Math.round((entry.endsAt.getTime() - entry.startsAt.getTime()) / 1000)) })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction destructive disabled={remove.isPending} onClick={e => { e.preventDefault(); remove.mutate({ id: entry.id }); }}>
              {remove.isPending ? t("ui.planned.deleting") : t("ui.planned.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}
