import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
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
import { toastError } from "@/lib/errorText";
import { t } from "@/i18n";

export function DeleteVersionButton({
  noteId,
  versionId,
}: {
  noteId: string;
  versionId: string;
}) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const remove = trpc.notes.deleteVersion.useMutation({
    onSuccess: () => {
      toast.success(t("pages.notes.versionDeleted"));
      void utils.notes.versions.invalidate({ id: noteId });
      setOpen(false);
    },
    onError: (error: unknown) => toastError(error),
  });

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-danger"
        aria-label={t("pages.notes.deleteVersion")}
        title={t("pages.notes.deleteVersion")}
        disabled={remove.isPending}
        onClick={() => setOpen(true)}
      >
        <Trash2 />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("pages.notes.deleteVersionTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.notes.deleteVersionText")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: noteId, versionId })}
            >
              {t("pages.notes.deleteVersion")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
