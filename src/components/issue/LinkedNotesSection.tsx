import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Link2, Plus, Unlink } from "lucide-react";
import { toast } from "sonner";
import type { NoteTreeItem } from "@contracts/notes";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import { newDraftId } from "@/components/notes/drafts";
import { errorText, toastError } from "@/lib/errorText";
import { t } from "@/i18n";
import { ActionRow } from "@/components/app/ActionRow";

export function LinkedNotesSection({
  issueKey,
  connectionId,
}: {
  issueKey: string;
  connectionId: number;
}) {
  const notes = trpc.notes.forIssue.useQuery({ issueKey, connectionId });
  const [linkOpen, setLinkOpen] = useState(false);
  const utils = trpc.useUtils();
  const unlink = trpc.notes.setIssue.useMutation({
    onSuccess: () => {
      toast.success(t("pages.notes.unlinked"));
      void refresh();
    },
    onError: (error: unknown) => toastError(error),
  });
  const refresh = () =>
    Promise.all([
      utils.notes.forIssue.invalidate({ issueKey, connectionId }),
      utils.notes.tree.invalidate(),
    ]);
  const createParams = new URLSearchParams({
    draft: newDraftId(),
    issueKey,
    connectionId: String(connectionId),
  });
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to={`/notes/new?${createParams}`}>
            <Plus />
            {t("pages.notes.new")}
          </Link>
        </Button>
        <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
          <Link2 />
          {t("pages.notes.linkExisting")}
        </Button>
      </div>
      {notes.isPending ? (
        <div className="grid gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : notes.error ? (
        <ErrorState
          message={errorText(notes.error)}
          onRetry={() => notes.refetch()}
        />
      ) : !notes.data?.length ? (
        <EmptyState
          title={t("pages.notes.noLinked")}
          message={t("pages.notes.noLinkedText")}
        />
      ) : (
        <ul className="divide-y">
          {notes.data.map(note => (
            <li key={note.id} className="py-2">
              <ActionRow
                actions={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("pages.notes.unlinkNote", {
                      title: note.title || t("pages.notes.untitled"),
                    })}
                    disabled={unlink.isPending}
                    onClick={() => unlink.mutate({ id: note.id, issue: null })}
                  >
                    <Unlink />
                  </Button>
                }
              >
                <Link
                  to={`/notes/${note.id}`}
                  className="block truncate rounded-sm py-1 font-medium outline-none hover:text-primary-strong focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {note.title || t("pages.notes.untitled")}
                </Link>
              </ActionRow>
            </li>
          ))}
        </ul>
      )}
      <LinkExisting
        issueKey={issueKey}
        connectionId={connectionId}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onLinked={refresh}
      />
    </div>
  );
}

function LinkExisting({
  issueKey,
  connectionId,
  open,
  onOpenChange,
  onLinked,
}: {
  issueKey: string;
  connectionId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
}) {
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<NoteTreeItem | null>(null);
  const tree = trpc.notes.tree.useQuery(undefined, { enabled: open });
  const search = trpc.notes.search.useQuery(
    { query: query.trim(), filter: "all", limit: 30 },
    { enabled: open && query.trim().length >= 2 }
  );
  const setIssue = trpc.notes.setIssue.useMutation({
    onSuccess: () => {
      toast.success(t("pages.notes.issueLinked"));
      onLinked();
      onOpenChange(false);
    },
    onError: (error: unknown) => toastError(error),
  });
  // Folders only group: they are never linked to an issue.
  const candidates: NoteTreeItem[] = useMemo(() => {
    if (query.trim().length >= 2)
      return (search.data?.results ?? []).filter(result => result.kind === "note").map(result => ({
        id: result.id,
        parentId: null,
        kind: result.kind,
        hasText: true,
        position: 0,
        title: result.title,
        contentRevision: 1,
        connectionId: result.connectionId,
        issueKey: result.issueKey,
        notedOn: result.notedOn,
        hasAi: false,
        createdAt: result.updatedAt,
        updatedAt: result.updatedAt,
      }));
    return (tree.data ?? []).filter(note => note.kind === "note" && !note.issueKey).slice(0, 100);
  }, [query, search.data, tree.data]);
  const choose = (note: NoteTreeItem) => {
    if (
      note.issueKey &&
      (note.issueKey !== issueKey || note.connectionId !== connectionId)
    )
      setConfirm(note);
    else setIssue.mutate({ id: note.id, issue: { issueKey, connectionId } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pages.notes.linkExistingTitle")}</DialogTitle>
          <DialogDescription>
            {t("pages.notes.linkExistingText")}
          </DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t("pages.notes.search")}
          aria-label={t("pages.notes.search")}
        />
        <div className="max-h-80 overflow-y-auto">
          {query.trim().length === 1 ? (
            <p className="py-4 text-body-sm text-muted-foreground">
              {t("pages.notes.searchMinimum")}
            </p>
          ) : search.isFetching && query.trim().length >= 2 ? (
            <Skeleton className="h-12" />
          ) : !candidates.length ? (
            <EmptyState title={t("pages.notes.noResults")} />
          ) : (
            <ul className="divide-y">
              {candidates.map(note => (
                <li key={note.id}>
                  <button
                    type="button"
                    className="w-full rounded-sm px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => choose(note)}
                  >
                    <span className="block truncate font-medium">
                      {note.title || t("pages.notes.untitled")}
                    </span>
                    {note.issueKey && (
                      <span className="text-caption text-muted-foreground">
                        {t("pages.notes.currentIssue", { key: note.issueKey })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <AlertDialog
          open={!!confirm}
          onOpenChange={value => !value && setConfirm(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("pages.notes.relinkTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("pages.notes.relinkText", {
                  key: confirm?.issueKey ?? "",
                  issue: issueKey,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirm)
                    setIssue.mutate({
                      id: confirm.id,
                      issue: { issueKey, connectionId },
                    });
                  setConfirm(null);
                }}
              >
                {t("pages.notes.relinkConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
