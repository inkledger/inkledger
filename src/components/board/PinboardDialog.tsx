import { useEffect } from "react";
import { useLocation } from "react-router";
import { pinboardDialog } from "@/lib/flag";
import { lazyPart } from "@/components/app/lazyPart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";

const Pinboard = lazyPart(() => import("@/components/board/Pinboard").then(m => m.Pinboard));

/**
 * The pinboard over any page (sidebar button, "p"). Never on the Board,
 * which has its own panel: the pinboard is mounted once.
 */
export function PinboardDialog() {
  const open = pinboardDialog.useValue();
  const { pathname } = useLocation();
  // Opening a note navigates: the dialog gives way to the page.
  useEffect(() => {
    pinboardDialog.set(false);
  }, [pathname]);
  return (
    <Dialog
      open={open && pathname !== "/board"}
      onOpenChange={pinboardDialog.set}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[85dvh] w-[min(96vw,1640px)] max-w-none flex-col gap-0 p-3 sm:max-w-none"
      >
        <DialogTitle className="sr-only">
          {t("pages.board.pinboard")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t("pages.board.pinboardDescription")}
        </DialogDescription>
        {open && (
          <Pinboard
            className="min-h-0 flex-1"
            resizable={false}
            onClose={() => pinboardDialog.set(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
