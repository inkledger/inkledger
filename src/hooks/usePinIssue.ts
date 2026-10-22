import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { canShowPinboard, pinboardBoard, showPinboard } from "@/hooks/usePinboardPanel";
import { toast } from "sonner";
import { t } from "@/i18n";
import type { NoteColor } from "@contracts/pinboard";

/** What a pin changes: the boards, their post-its and where each issue is. */
function usePinRefresh() {
  const utils = trpc.useUtils();
  return () => {
    void utils.pinboard.list.invalidate();
    void utils.pinboard.boards.invalidate();
    void utils.pinboard.where.invalidate();
  };
}

/**
 * "Pin to the pinboard": pin an issue in the first free spot of a board (the
 * one asked, else the one shown in the panel, the last chosen on this device).
 */
export function usePinIssue() {
  const utils = trpc.useUtils();
  const refresh = usePinRefresh();
  return async (issueKey: string, connectionId?: number, boardId?: number) => {
    try {
      const r = await utils.client.pinboard.add.mutate({
        issueKey,
        connectionId,
        boardId: boardId ?? pinboardBoard.get() ?? undefined,
      });
      refresh();
      toast.success(
        t(r.existed ? "ui.pin.existing" : "ui.pin.added", {
          key: issueKey,
          board: r.boardName,
        }),
        canShowPinboard()
          ? {
              action: {
                label: t("ui.pin.open"),
                onClick: () => {
                  pinboardBoard.set(r.boardId);
                  showPinboard();
                },
              },
            }
          : undefined
      );
    } catch (e) {
      toastError(e);
    }
  };
}

/** Unpin an issue from one board; "Undo" puts it back where it was. */
export function useUnpinIssue() {
  const utils = trpc.useUtils();
  const refresh = usePinRefresh();
  return async (issueKey: string, connectionId: number | undefined, board: { id: number; name: string }) => {
    try {
      const removed = await utils.client.pinboard.unpinIssue.mutate({ boardId: board.id, issueKey, connectionId });
      refresh();
      toast.success(t("ui.pin.removed", { key: issueKey, board: board.name }), {
        action: {
          label: t("ui.pin.undo"),
          onClick: () =>
            void utils.client.pinboard.restore
              .mutate({
                boardId: board.id,
                issueKey: removed.issueKey,
                connectionId: removed.connectionId ?? undefined,
                note: removed.note,
                color: removed.color as NoteColor,
                x: removed.x,
                y: removed.y,
                rotation: removed.rotation,
              })
              .then(refresh, toastError),
        },
      });
    } catch (e) {
      toastError(e);
    }
  };
}
