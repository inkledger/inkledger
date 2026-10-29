import { toast } from "sonner";
import type { NoteTreeItem } from "@contracts/notes";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { t } from "@/i18n";

/** Where a row is now: its parent and its place among the others there. */
export function placeOf(items: NoteTreeItem[], id: string): { parentId: string | null; index: number } | null {
  const row = items.find(item => item.id === id);
  if (!row) return null;
  const siblings = items.filter(item => item.parentId === row.parentId);
  return { parentId: row.parentId, index: siblings.findIndex(item => item.id === id) };
}

/**
 * Moves a note or folder, then says so with Undo: back to the parent and
 * place it had (the server keeps folders before notes either way).
 */
export function useMoveNote(items: NoteTreeItem[], onMoved?: (item: NoteTreeItem) => void) {
  const utils = trpc.useUtils();
  const move = trpc.notes.move.useMutation({
    onError: (error: unknown) => toastError(error),
  });
  const refresh = () => {
    void utils.notes.tree.invalidate();
    void utils.notes.search.invalidate();
  };
  const run = (id: string, parentId: string | null, index: number, after?: () => void) => {
    const before = placeOf(items, id);
    move.mutate(
      { id, parentId, index },
      {
        onSuccess: item => {
          refresh();
          onMoved?.(item);
          after?.();
          toast.success(t("pages.notes.moved"), {
            action: before
              ? {
                  label: t("pages.notes.undo"),
                  onClick: () =>
                    move.mutate(
                      { id, parentId: before.parentId, index: before.index },
                      {
                        onSuccess: back => {
                          refresh();
                          onMoved?.(back);
                        },
                      }
                    ),
                }
              : undefined,
          });
        },
      }
    );
  };
  return { move: run, isPending: move.isPending };
}
