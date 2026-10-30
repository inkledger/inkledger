import { useState } from "react";
import { History } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Spinner } from "@/components/ui/spinner";
import { dateFormat, t } from "@/i18n";
import { errorText, toastError } from "@/lib/errorText";
import type { NoteDocumentController } from "./useNoteDocument";
import { DeleteVersionButton } from "./DeleteVersionButton";
import { ActionRow } from "@/components/app/ActionRow";
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

const origins: Record<
  string,
  | "pages.notes.auto"
  | "pages.notes.manual"
  | "pages.notes.conflictOrigin"
  | "pages.notes.deleteOrigin"
  | "pages.notes.restoreOrigin"
  | "pages.notes.aiOrigin"
> = {
  auto: "pages.notes.auto",
  manual: "pages.notes.manual",
  conflict: "pages.notes.conflictOrigin",
  delete: "pages.notes.deleteOrigin",
  restore: "pages.notes.restoreOrigin",
  ai: "pages.notes.aiOrigin",
};

export function NoteHistorySheet({
  controller,
}: {
  controller: NoteDocumentController;
}) {
  const [open, setOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const id = controller.currentId;
  const utils = trpc.useUtils();
  const versions = trpc.notes.versions.useQuery(
    { id: id ?? "" },
    { enabled: open && !!id }
  );
  const save = trpc.notes.saveVersion.useMutation({
    onSuccess: () => {
      toast.success(t("pages.notes.versionSaved"));
      void utils.notes.versions.invalidate({ id: id ?? "" });
    },
    onError: (error: unknown) => toastError(error),
  });
  const restore = trpc.notes.restoreVersion.useMutation({
    onSuccess: result => {
      if (result.status === "conflict")
        controller.reportConflict(result.current);
      else {
        controller.applyRestored(result.note);
        toast.success(t("pages.notes.versionRestored"));
        setOpen(false);
      }
    },
    onError: (error: unknown) => toastError(error),
  });
  const compact = trpc.notes.compactVersions.useMutation({
    onSuccess: result => {
      toast.success(t("pages.notes.compacted", { count: result.deleted }));
      if (id) void utils.notes.versions.invalidate({ id });
      setCompactOpen(false);
    },
    onError: (error: unknown) => toastError(error),
  });
  const date = dateFormat({ dateStyle: "medium", timeStyle: "short" });
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        disabled={!id}
        onClick={() => setOpen(true)}
      >
        <History />
        {t("pages.notes.history")}
      </Button>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("pages.notes.historyTitle")}</SheetTitle>
          <SheetDescription>{t("pages.notes.historyText")}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap gap-2 border-b px-4 pb-4">
          <Button
            size="sm"
            disabled={!id || save.isPending}
            onClick={async () => {
              const saved = await controller.flush();
              if (
                id &&
                saved &&
                controller.isCurrent(saved) &&
                !controller.getConflict()
              )
                save.mutate({ id });
            }}
          >
            {t("pages.notes.saveVersion")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !id || (versions.data?.length ?? 0) < 2 || compact.isPending
            }
            onClick={() => setCompactOpen(true)}
          >
            {t("pages.notes.compact")}
          </Button>
          {controller.dirty && (
            <p className="mt-2 w-full text-caption text-muted-foreground">
              {t("pages.notes.saveBeforeVersion")}
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {versions.isPending ? (
            <Spinner className="m-6" />
          ) : versions.error ? (
            <ErrorState
              message={errorText(versions.error)}
              onRetry={() => versions.refetch()}
            />
          ) : !versions.data?.length ? (
            <EmptyState title={t("pages.notes.noVersions")} />
          ) : (
            <ol className="divide-y">
              {versions.data.map(version => (
                <li key={version.id} className="grid gap-2 py-4">
                  <ActionRow
                    className="items-start max-sm:grid-cols-1"
                    actions={
                      <>
                        {id && (
                          <DeleteVersionButton
                            noteId={id}
                            versionId={version.id}
                          />
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={restore.isPending}
                          onClick={async () => {
                            if (!id) return;
                            const saved = await controller.flush();
                            if (
                              saved &&
                              controller.isCurrent(saved) &&
                              !controller.getConflict()
                            )
                              restore.mutate({
                                id,
                                versionId: version.id,
                                expectedRevision: saved.contentRevision,
                              });
                          }}
                        >
                          {t("pages.notes.restoreVersion")}
                        </Button>
                      </>
                    }
                  >
                    <p className="font-medium">
                      {version.title || t("pages.notes.untitled")}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      <time
                        dateTime={new Date(version.createdAt).toISOString()}
                        title={date.format(new Date(version.createdAt))}
                      >
                        {date.format(new Date(version.createdAt))}
                      </time>{" "}
                      · {t(origins[version.origin] ?? "pages.notes.auto")} ·{" "}
                      {t("pages.notes.revision", {
                        revision: version.contentRevision,
                      })}
                    </p>
                  </ActionRow>
                  {version.preview && (
                    <p className="line-clamp-3 [overflow-wrap:anywhere] text-body-sm text-muted-foreground">
                      {version.preview}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
      <AlertDialog open={compactOpen} onOpenChange={setCompactOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.notes.compactTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.notes.compactText")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              disabled={compact.isPending}
              onClick={() => id && compact.mutate({ id })}
            >
              {t("pages.notes.compact")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
