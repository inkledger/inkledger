import { useContext, useEffect, useState } from "react";
import { getLocale } from "@/i18n";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { SettingsPanel } from "@/components/settings/sections/store/ProductSheet";
import { ModulesContext } from "./context";

/**
 * A module's settings over any page, opened by the module itself
 * (host.openSettings, e.g. a click on the Bonsai): the same panel as in its
 * Store sheet, without leaving the page.
 */
export function ModuleSettingsSheet() {
  const ctx = useContext(ModulesContext);
  const [id, setId] = useState<string | null>(null);
  useEffect(() => ctx?.hub.settingsOpen(setId), [ctx]);
  const loaded = id ? ctx?.modules.find(m => m.entry.id === id && m.module.mount.settings) : undefined;
  const name = loaded ? loaded.entry.name[getLocale() === "it" ? "it" : "en"] : "";
  return (
    <Sheet open={loaded !== undefined} onOpenChange={o => !o && ctx?.hub.closeSettings()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
        {loaded && <SettingsPanel moduleId={loaded.entry.id} name={name} />}
      </SheetContent>
    </Sheet>
  );
}
