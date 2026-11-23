import { useContext, useEffect } from "react";
import { currentLocale, t } from "@/i18n";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ModulesContext } from "../context";
import { FramedBox } from "./FrameHost";
import { sheetOpen } from "./sheet";

/** Closed: the focus back on the opener's box (a host button, else the frame inside it). */
const returnFocus = (e: Event) => {
  const box = sheetOpen.takeOpener();
  if (!box) return;
  e.preventDefault();
  (box.hasAttribute("tabindex") && box.tabIndex >= 0 ? box : (box.querySelector("iframe") ?? box)).focus({ preventScroll: true });
};

/** A framed module's sheet (host.sheet.open): the host's dialog, the module's view frame inside. */
export function ModuleSheet() {
  const ctx = useContext(ModulesContext);
  const id = sheetOpen.use();
  const loaded = id ? ctx?.modules.find(m => m.entry.id === id && m.entry.frameUrl && m.entry.capabilities.includes("sheet")) : undefined;
  // Its module gone (switched off, logged out): never reopened later without a gesture.
  useEffect(() => {
    if (id && !loaded) sheetOpen.close(id);
  }, [id, loaded]);
  const name = loaded ? loaded.entry.name[currentLocale() === "it" ? "it" : "en"] : "";
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
