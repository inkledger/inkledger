import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowDown, ArrowUp, Check, FileText, Folder, FolderInput, FolderTree, Link2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { NoteIssue, NoteTreeItem } from "@contracts/notes";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { IssuePicker } from "@/components/app/IssuePicker";
import { t } from "@/i18n";
import { toastError } from "@/lib/errorText";
import { ancestorIds, descendantsOf, siblingIndices } from "./treeModel";
import { useMoveNote } from "./useMoveNote";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { NoteDocumentController } from "./useNoteDocument";
import { NoteHistorySheet } from "./NoteHistorySheet";

export function NoteActions({
  controller,
  tree,
}: {
  controller: NoteDocumentController;
  tree: NoteTreeItem[];
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const id = controller.currentId;
  const note = controller.note;
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const remove = trpc.notes.remove.useMutation({
    onSuccess: result => {
      toast.success(t("pages.notes.deleted", { count: result.count }));
      void utils.notes.tree.invalidate();
      void utils.notes.trash.invalidate();
      void navigate("/notes");
    },
    onError: (error: unknown) => toastError(error),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 md:px-6">
      <Button
        variant="outline"
        size="sm"
        disabled={!id}
        onClick={() => setMoveOpen(true)}
      >
        <FolderInput />
        {t("pages.notes.move")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!id}
        onClick={() => setLinkOpen(true)}
      >
        <Link2 />
        {t("pages.notes.linkIssue")}
      </Button>
      <NoteHistorySheet controller={controller} />
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto text-danger"
        disabled={!id}
        onClick={() => setDeleteOpen(true)}
      >
        <Trash2 />
        {t("pages.notes.delete")}
      </Button>
      {id && note && (
        <MoveDialog
          key={`${note.parentId}:${note.position}`}
          id={id}
          tree={tree}
          open={moveOpen}
          onOpenChange={setMoveOpen}
          onMetadata={controller.applyMetadata}
        />
      )}
      {id && note && (
        <LinkDialog
          key={`${note.connectionId}:${note.issueKey}`}
          id={id}
          issue={
            note.connectionId !== null && note.issueKey
              ? { connectionId: note.connectionId, issueKey: note.issueKey }
              : null
          }
          open={linkOpen}
          onOpenChange={setLinkOpen}
          onMetadata={controller.applyMetadata}
        />
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.notes.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {id
                ? t("pages.notes.deleteText", {
                    count: descendantsOf(tree, id).size - 1,
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              disabled={remove.isPending}
              onClick={() => {
                if (id)
                  void controller.flush().then(saved => {
                    if (
                      controller.isCurrent(saved) &&
                      !controller.getConflict()
                    )
                      remove.mutate({ id });
                  });
              }}
            >
              {t("pages.notes.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Where a note or folder goes: a new parent (a folder goes only to the top
 * level or into a folder) and its place there.
 */
export function MoveDialog({
  id,
  tree,
  open,
  onOpenChange,
  onMetadata,
}: {
  id: string;
  tree: NoteTreeItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMetadata?: (item: NoteTreeItem) => void;
}) {
  const note = tree.find(item => item.id === id);
  const isFolder = note?.kind === "folder";
  const [parentId, setParentId] = useState<string>(note?.parentId ?? "root");
  // Each place as its path ("Work / Meetings"): two folders with one name stay apart, and search finds either word.
  const byId = new Map(tree.map(item => [item.id, item]));
  const pathOf = (item: NoteTreeItem) =>
    [...ancestorIds(tree, item.id).reverse().map(step => byId.get(step)), item]
      .map(step => step?.title || t("pages.notes.untitled"))
      .join(" / ");
  const siblings = siblingIndices(
    tree,
    id,
    parentId === "root" ? null : parentId
  );
  const [index, setIndex] = useState(note?.position ?? siblings.length);
  const excluded = descendantsOf(tree, id);
  const places = tree.filter(item => !excluded.has(item.id) && (!isFolder || item.kind === "folder"));
  const move = useMoveNote(tree, onMetadata);
  const max = siblings.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(isFolder ? "pages.notes.moveFolderTitle" : "pages.notes.moveTitle")}</DialogTitle>
          <DialogDescription>{t(isFolder ? "pages.notes.moveFolderText" : "pages.notes.moveText")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-body-sm">
          <span id="note-move-parent">{t("pages.notes.parent")}</span>
          <Command aria-labelledby="note-move-parent" className="rounded-md border">
            <CommandInput placeholder={t("pages.notes.searchPlace")} />
            <CommandList className="max-h-56">
              <CommandEmpty>{t("pages.notes.noPlace")}</CommandEmpty>
              {[{ key: "root", label: t("pages.notes.root"), kind: "folder" as const }, ...places.map(item => ({ key: item.id, label: pathOf(item), kind: item.kind }))].map(place => {
                const Icon = place.key === "root" ? FolderTree : place.kind === "folder" ? Folder : FileText;
                return (
                  <CommandItem
                    key={place.key}
                    value={`${place.label} ${place.key}`}
                    onSelect={() => {
                      setParentId(place.key);
                      setIndex(0);
                    }}
                  >
                    <Icon aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{place.label}</span>
                    {parentId === place.key && <Check aria-hidden className="text-primary" />}
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-body-sm">
            {t("pages.notes.position", {
              index: Math.min(index, max) + 1,
              count: max + 1,
            })}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t("pages.notes.moveUp")}
            disabled={index <= 0}
            onClick={() => setIndex(value => Math.max(0, value - 1))}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t("pages.notes.moveDown")}
            disabled={index >= max}
            onClick={() => setIndex(value => Math.min(max, value + 1))}
          >
            <ArrowDown />
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={move.isPending}
            onClick={() =>
              move.move(id, parentId === "root" ? null : parentId, Math.min(index, max), () => onOpenChange(false))
            }
          >
            {t(isFolder ? "pages.notes.moveFolderTitle" : "pages.notes.moveConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({
  id,
  issue,
  open,
  onOpenChange,
  onMetadata,
}: {
  id: string;
  issue: NoteIssue | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMetadata: (item: NoteTreeItem) => void;
}) {
  const [value, setValue] = useState<IssueRefLocal | null>(
    issue ? { key: issue.issueKey, connectionId: issue.connectionId } : null
  );
  const issues = trpc.issues.all.useQuery(undefined, { enabled: open });
  const utils = trpc.useUtils();
  const setIssue = trpc.notes.setIssue.useMutation({
    onSuccess: item => {
      onMetadata(item);
      toast.success(t("pages.notes.issueLinked"));
      void utils.notes.tree.invalidate();
      void utils.notes.forIssue.invalidate();
      onOpenChange(false);
    },
    onError: (error: unknown) => toastError(error),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pages.notes.linkIssueTitle")}</DialogTitle>
          <DialogDescription>
            {t("pages.notes.linkIssueText")}
          </DialogDescription>
        </DialogHeader>
        <IssuePicker
          issues={issues.data ?? []}
          value={value}
          onChange={setValue}
        />
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={!issue || setIssue.isPending}
            onClick={() => setIssue.mutate({ id, issue: null })}
          >
            {t("pages.notes.unlink")}
          </Button>
          <Button
            disabled={!value?.connectionId || setIssue.isPending}
            onClick={() =>
              value?.connectionId &&
              setIssue.mutate({
                id,
                issue: {
                  issueKey: value.key,
                  connectionId: value.connectionId,
                },
              })
            }
          >
            {t("pages.notes.linkConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type IssueRefLocal = { key: string; connectionId?: number };
