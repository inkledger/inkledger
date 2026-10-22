import { toastError } from "@/lib/errorText";
import { useNavigate } from "react-router";
import { trpc } from "@/lib/trpc";
import { pinboardBoard, pinboardPanel } from "@/hooks/usePinboardPanel";
import { toast } from "sonner";
import { t } from "@/i18n";

/** "Pin to the pinboard": pin an issue in the first free spot of the pinboard. */
export function usePinIssue() {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  return async (issueKey: string, connectionId?: number) => {
    try {
      // On the board shown in the panel (the last one chosen on this device).
      const r = await utils.client.pinboard.add.mutate({
        issueKey,
        connectionId,
        boardId: pinboardBoard.get() ?? undefined,
      });
      void utils.pinboard.list.invalidate();
      void utils.pinboard.boards.invalidate();
      toast.success(
        t(r.existed ? "ui.pin.existing" : "ui.pin.added", {
          key: issueKey,
          board: r.boardName,
        }),
        {
          action: {
            label: t("ui.pin.open"),
            onClick: () => {
              pinboardPanel.set("open");
              void navigate("/board");
            },
          },
        }
      );
    } catch (e) {
      toastError(e);
    }
  };
}
