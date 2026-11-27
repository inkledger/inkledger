import { useContext, useEffect } from "react";
import { XIcon } from "lucide-react";
import { currentLocale, t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { ModulesContext } from "../context";
import { FramedBox } from "./FrameHost";
import { sheetOpen } from "./sheet";
import { pageGestures } from "./gesture";

/** Closed: the focus back on the opener's box (a host button, else the frame inside it). */
const returnFocus = (e: Event) => {
  const box = sheetOpen.takeOpener();
  if (!box) return;
  e.preventDefault();
  const to = box.hasAttribute("tabindex") && box.tabIndex >= 0 ? box : (box.querySelector("iframe") ?? box);
  to.focus({ preventScroll: true });
  // The host handed the focus back: keys in that frame are the person's.
  if (to instanceof HTMLIFrameElement) pageGestures().hostFocus(to);
};

/**
 * A framed module's sheet (host.sheet.open): the host's dialog, the module's view frame inside.
 * "side" (the default) slides in from the side; "wide" is a centered dialog, the whole screen on a phone.
 */
export function ModuleSheet() {
  const ctx = useContext(ModulesContext);
  const id = sheetOpen.use();
  const size = sheetOpen.useSize();
  const phone = useMediaQuery("(max-width: 767px)", false);
  const loaded = id ? ctx?.modules.find(m => m.entry.id === id && m.entry.frameUrl && m.entry.capabilities.includes("sheet")) : undefined;
  // Its module gone (switched off, logged out): never reopened later without a gesture.
  useEffect(() => {
    if (id && !loaded) sheetOpen.close(id);
  }, [id, loaded]);
  const name = loaded ? loaded.entry.name[currentLocale() === "it" ? "it" : "en"] : "";
  if (size === "wide")
    return (
      <Dialog open={loaded !== undefined} onOpenChange={o => !o && sheetOpen.close()}>
        <DialogContent
          data-sheet-size="wide"
          aria-modal="true"
          showCloseButton={false}
          // The whole screen on a phone is no floating box: it casts nothing there.
          cast={!phone}
          onCloseAutoFocus={returnFocus}
          className={
            // A phone: the whole screen (over the tab bar), clear of the notch and the home indicator.
            "inset-0 top-0 left-0 flex w-auto max-w-none max-h-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none " +
            "max-md:pr-[env(safe-area-inset-right)] max-md:pb-[env(safe-area-inset-bottom)] max-md:pl-[env(safe-area-inset-left)] " +
            // From md: centered, a dialog's surface and radius.
            "md:right-auto md:bottom-auto md:top-1/2 md:left-1/2 md:h-[min(48rem,90dvh)] md:w-[min(64rem,94vw)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border"
          }
        >
          <DialogHeader className="flex-row items-center gap-3 border-b py-2 pr-2 pl-4 max-md:pt-[max(0.5rem,env(safe-area-inset-top))] md:pl-6">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">{name}</DialogTitle>
              <DialogDescription className="sr-only">{t("settings.store.moduleSheet.description", { name })}</DialogDescription>
            </div>
            <DialogClose asChild>
              {/* A 44 px tap on a phone, whatever its pointer. */}
              <Button variant="ghost" size="icon" className="max-md:size-touch">
                <XIcon />
                <span className="sr-only">{t("common.close")}</span>
              </Button>
            </DialogClose>
          </DialogHeader>
          {loaded && ctx && <FramedBox hub={ctx.hub} entry={loaded.entry} slot="sheet" className="relative min-h-0 flex-1" />}
        </DialogContent>
      </Dialog>
    );
  return (
    <Sheet open={loaded !== undefined} onOpenChange={o => !o && sheetOpen.close()}>
      {/* Modal for assistive tech too: the page's live regions keep it from being hidden behind the sheet. */}
      <SheetContent className="w-full gap-0 p-0 sm:max-w-md" aria-modal="true" onCloseAutoFocus={returnFocus}>
        <SheetHeader className="border-b">
          <SheetTitle>{name}</SheetTitle>
          <SheetDescription>{t("settings.store.moduleSheet.description", { name })}</SheetDescription>
        </SheetHeader>
        {loaded && ctx && <FramedBox hub={ctx.hub} entry={loaded.entry} slot="sheet" className="relative min-h-0 flex-1" />}
      </SheetContent>
    </Sheet>
  );
}
