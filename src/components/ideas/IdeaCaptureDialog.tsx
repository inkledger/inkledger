import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDirtyClose } from "@/components/app/DirtyClose";
import { IdeaCapture } from "@/components/ideas/IdeaCapture";
import { ideaCapture } from "@/lib/flag";
import { t } from "@/i18n";

/** "New idea" from the palette: the same capture as the Ideas page, closed once the ideas are kept. */
export function IdeaCaptureDialog() {
  const open = ideaCapture.useValue();
  // Escape or a click outside with ideas typed asks first: closing drops them.
  const guard = useDirtyClose(() => ideaCapture.set(false));
  return (
    <>
    {guard.confirm}
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ui.palette.newIdea")}</DialogTitle>
          <DialogDescription>{t("pages.ideas.capturePlaceholder")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts clean. */}
        {open && <IdeaCapture autoFocus onDirty={guard.markDirty} onAdded={() => ideaCapture.set(false)} />}
      </DialogContent>
    </Dialog>
    </>
  );
}
