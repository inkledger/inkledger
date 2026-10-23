/** Widgets available in the customizable dashboard (labels live in the dictionaries). */
export const DASHBOARD_WIDGETS = [
  { id: "inbox" },
  { id: "todos" },
  { id: "timeline" },
  { id: "stats" },
  { id: "summary" },
  { id: "tasks" },
  { id: "activity" },
  { id: "recap" },
] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGETS)[number]["id"];

export interface DashboardLayoutItem {
  id: string;
  visible: boolean;
}

/**
 * Merge a saved layout with the known widgets: keeps saved order and
 * visibility, appends widgets added by newer versions, drops unknown ids.
 */
export function normalizeDashboardLayout(saved: unknown): DashboardLayoutItem[] {
  const known = new Set<string>(DASHBOARD_WIDGETS.map((w) => w.id));
  const items: DashboardLayoutItem[] = [];
  // Layouts saved before the current widget set (no "tasks") restart from defaults.
  const legacy =
    Array.isArray(saved) &&
    !saved.some((it) => (it as { id?: unknown } | null)?.id === "tasks");
  if (Array.isArray(saved) && !legacy) {
    for (const it of saved) {
      if (
        it &&
        typeof it === "object" &&
        typeof (it as { id?: unknown }).id === "string" &&
        known.has((it as { id: string }).id) &&
        !items.some((x) => x.id === (it as { id: string }).id)
      ) {
        items.push({
          id: (it as { id: string }).id,
          visible: (it as { visible?: unknown }).visible !== false,
        });
      }
    }
  }
  for (const w of DASHBOARD_WIDGETS) {
    if (!items.some((x) => x.id === w.id)) {
      items.push({ id: w.id, visible: true });
    }
  }
  return items;
}
