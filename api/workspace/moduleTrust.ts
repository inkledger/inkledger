import { MODULES_PATH, type ModuleListEntry, type SlotId } from "@contracts/modules";

export type VerifiedModuleBinding = {
  moduleId: string;
  slot: SlotId;
  entryUrl: string;
  integrity: string;
  build: string;
};

export function bindingForModule(entry: ModuleListEntry, slot: SlotId): VerifiedModuleBinding | null {
  if (entry.status.state !== "active" || !entry.slots.includes(slot)) return null;
  if (!entry.entryUrl?.startsWith(`${MODULES_PATH}/${entry.id}/`)) return null;
  if (!entry.integrity?.startsWith("sha256-") || !entry.build) return null;
  return {
    moduleId: entry.id,
    slot,
    entryUrl: entry.entryUrl,
    integrity: entry.integrity,
    build: entry.build,
  };
}
