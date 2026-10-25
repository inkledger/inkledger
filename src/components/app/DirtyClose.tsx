import { useRef, useState } from "react";
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
import { t } from "@/i18n";

/**
 * Closing a panel that holds unsaved work (Escape, the overlay, ×): asked first, only when
 * something changed. A clean or saved draft closes at once; "Keep editing" keeps every value.
 * `markDirty` is told by the panel's body; `onOpenChange` replaces the panel's own.
 */
export function useDirtyClose(close: () => void) {
  const dirty = useRef(false);
  const [asking, setAsking] = useState(false);
  const onOpenChange = (open: boolean) => {
    if (open) return;
    if (dirty.current) setAsking(true);
    else close();
  };
  const markDirty = (d: boolean) => {
    dirty.current = d;
  };
  const confirm = (
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("ui.dirty.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("ui.dirty.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("ui.dirty.keep")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              dirty.current = false;
              close();
            }}
          >
            {t("ui.dirty.discard")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { onOpenChange, markDirty, confirm };
}
