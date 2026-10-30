import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IdeaCapture } from "@/components/ideas/IdeaCapture";
import { ideaCapture } from "@/lib/flag";
import { t } from "@/i18n";

/** "New idea" from the palette: the same capture as the Ideas page, closed once the ideas are kept. */
export function IdeaCaptureDialog() {
  const open = ideaCapture.useValue();
  return (
    <Dialog open={open} onOpenChange={ideaCapture.set}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ui.palette.newIdea")}</DialogTitle>
          <DialogDescription>{t("pages.ideas.capturePlaceholder")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts clean. */}
        {open && <IdeaCapture autoFocus onAdded={() => ideaCapture.set(false)} />}
      </DialogContent>
    </Dialog>
  );
}
