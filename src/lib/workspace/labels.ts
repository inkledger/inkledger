import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { t, type MessageKey } from "@/i18n";

/** An area by its name in the user's language, never its catalogue id. */
export const areaLabel = (areaId: string): string =>
  t(`settings.categories.workspace.areaNames.${areaId.replace(/[.-]/g, "_")}` as MessageKey);

/** A catalogued control by the name its button carries. */
export function controlLabel(controlId: string): string {
  const control = CATALOG_V1.controls.find(item => item.id === controlId);
  return control ? t(control.accessibility.labelKey as MessageKey) : controlId;
}

/** A block of the layout by the name the Studio shows for it. */
export function anchorLabel(anchorId: string): string {
  const anchor = CATALOG_V1.anchors.find(item => item.id === anchorId);
  return anchor ? t(anchor.accessibility.labelKey as MessageKey) : anchorId;
}

/** Areas top to bottom as the page shows them (the catalogue keeps them sorted by id). */
const PAGE_ORDER = [
  "dashboard.header", "dashboard.primary", "dashboard.secondary", "dashboard.desk", "dashboard.overlays",
  "shell.navigation", "shell.actions", "shell.timer", "shell.overlays",
  "mobile.tabs", "mobile.more", "mobile.dock",
];

export function inPageOrder<T extends { id: string }>(areas: readonly T[]): T[] {
  const rank = (id: string) => (PAGE_ORDER.includes(id) ? PAGE_ORDER.indexOf(id) : PAGE_ORDER.length);
  return [...areas].sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : 1));
}
