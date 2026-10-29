import { ChevronLeft, RotateCcw } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState, ErrorState, PageSpinner } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { dateFormat, t } from "@/i18n";
import { errorText, toastError } from "@/lib/errorText";
import { ActionRow } from "@/components/app/ActionRow";

export function NoteTrash() {
  const trash = trpc.notes.trash.useQuery();
  const utils = trpc.useUtils();
  const restore = trpc.notes.restore.useMutation({
    onSuccess: result => {
      toast.success(t("pages.notes.restored", { count: result.ids.length }));
      void utils.notes.trash.invalidate();
      void utils.notes.tree.invalidate();
    },
    onError: (error: unknown) => toastError(error),
  });
  const date = dateFormat({ dateStyle: "medium", timeStyle: "short" });
  return (
    <div>
      <PageHeader
        title={t("pages.notes.trash")}
        description={t("pages.notes.trashDescription")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/notes">
              <ChevronLeft />
              {t("pages.notes.backToNotes")}
            </Link>
          </Button>
        }
      />
      {trash.isPending ? (
        <PageSpinner />
      ) : trash.error ? (
        <ErrorState
          message={errorText(trash.error)}
          onRetry={() => trash.refetch()}
        />
      ) : !trash.data?.length ? (
        <EmptyState
          art="inbox"
          title={t("pages.notes.trashEmpty")}
          message={t("pages.notes.trashEmptyText")}
          action={
            <Button asChild>
              <Link to="/notes">{t("pages.notes.backToNotes")}</Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-y">
          {trash.data.map(batch => {
            const needsRoot = !batch.parentActive && !!batch.parentId;
            return (
              <li key={batch.batch} className="px-5 py-4 md:px-6">
                <ActionRow
                  actions={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restore.isPending}
                      onClick={() =>
                        restore.mutate({
                          batch: batch.batch,
                          toRoot: needsRoot,
                        })
                      }
                    >
                      <RotateCcw />
                      {t(
                        needsRoot
                          ? "pages.notes.restoreRoot"
                          : "pages.notes.restore"
                      )}
                    </Button>
                  }
                >
                  <p className="truncate font-medium">
                    {batch.title || t("pages.notes.untitled")}
                  </p>
                  <p className="text-body-sm text-muted-foreground">
                    {t("pages.notes.trashCount", { count: batch.count })} ·{" "}
                    <time
                      dateTime={new Date(batch.deletedAt).toISOString()}
                      title={date.format(new Date(batch.deletedAt))}
                    >
                      {date.format(new Date(batch.deletedAt))}
                    </time>
                  </p>
                </ActionRow>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
