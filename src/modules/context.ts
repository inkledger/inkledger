import { createContext, useContext } from "react";
import type { Hub } from "./host";
import type { LoadedModule } from "./loader";
import type { SlotId } from "./types";

export const ModulesContext = createContext<{ hub: Hub; modules: LoadedModule[] } | null>(null);

/** Whether a loaded module draws in a slot (e.g. offers settings). */
export function useModuleOffers(moduleId: string, slot: SlotId): boolean {
  const ctx = useContext(ModulesContext);
  return ctx?.modules.some(m => m.entry.id === moduleId && Boolean(m.module.mount[slot])) ?? false;
}
