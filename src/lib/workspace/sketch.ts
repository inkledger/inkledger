import type { ResolvedPlacement, Scope, Variant } from "@contracts/workspace/model";

/**
 * How each page is drawn small, area by area, the way the real page lays them out: the Layout editor
 * and the "Use over time" maps share it, so a block is always found where it is on the page.
 * - `axis`: how the area lines its blocks up (a row, a column, or tiles that wrap).
 * - `region`: where the area sits in its frame.
 */
export type SketchAxis = "row" | "column" | "tiles";
export type SketchRegion = "top" | "main" | "rail" | "bottom" | "sidebar-top" | "sidebar-dock" | "sidebar-bottom" | "sheet" | "edge" | "bar" | "tray";
export type SketchArea = { areaId: string; axis: SketchAxis; region: SketchRegion };
export type SketchFrame = "page" | "phone-page" | "sidebar" | "phone";
export type Sketch = { frame: SketchFrame; areas: readonly SketchArea[] };

const DASHBOARD_AREAS = (rail: SketchRegion): SketchArea[] => [
  { areaId: "dashboard.header", axis: "row", region: "top" },
  { areaId: "dashboard.primary", axis: "column", region: "main" },
  { areaId: "dashboard.secondary", axis: "column", region: rail },
  { areaId: "dashboard.desk", axis: "column", region: "bottom" },
  { areaId: "dashboard.overlays", axis: "row", region: "tray" },
];

const SKETCHES: Record<string, Sketch> = {
  // The rail stands beside the main column on a wide screen…
  "dashboard:desktop": { frame: "page", areas: DASHBOARD_AREAS("rail") },
  // …and under the first section on a phone, where everything is one column.
  "dashboard:mobile": { frame: "phone-page", areas: DASHBOARD_AREAS("rail") },
  "shell-desktop:desktop": {
    frame: "sidebar",
    areas: [
      { areaId: "shell.navigation", axis: "column", region: "sidebar-top" },
      { areaId: "shell.timer", axis: "column", region: "sidebar-dock" },
      { areaId: "shell.actions", axis: "column", region: "sidebar-bottom" },
      { areaId: "shell.overlays", axis: "row", region: "tray" },
    ],
  },
  "mobile-tabs:mobile": {
    frame: "phone",
    areas: [
      { areaId: "mobile.more", axis: "tiles", region: "sheet" },
      { areaId: "mobile.dock", axis: "row", region: "edge" },
      { areaId: "mobile.tabs", axis: "row", region: "bar" },
    ],
  },
};

export function sketchFor(scope: Scope): Sketch | null {
  return SKETCHES[`${scope.surfaceId}:${scope.deviceClass}`] ?? null;
}

/** An area's blocks in their order, hidden ones included (drawn as ghosts where they would be). */
export function blocksIn(placements: readonly ResolvedPlacement[], areaId: string): ResolvedPlacement[] {
  return placements.filter(placement => placement.areaId === areaId).sort((a, b) => a.order - b.order || (a.anchorId < b.anchorId ? -1 : 1));
}

/**
 * Where a dragged block goes among the area's other blocks: before the first one whose middle is past
 * the pointer, along the area's axis. A row may wrap on a narrow screen, so rows and tiles read like
 * text: by line, then along it.
 */
export function insertionIndex(rects: readonly { left: number; top: number; width: number; height: number }[], point: { x: number; y: number }, axis: SketchAxis): number {
  for (const [index, rect] of rects.entries()) {
    const middleX = rect.left + rect.width / 2;
    const middleY = rect.top + rect.height / 2;
    if (axis === "column" && point.y < middleY) return index;
    if (axis !== "column" && (point.y < rect.top || (point.y < rect.top + rect.height && point.x < middleX))) return index;
  }
  return rects.length;
}

export type LocalChange =
  | { kind: "visible"; anchorId: string; visible: boolean }
  | { kind: "pinned"; anchorId: string; pinned: boolean }
  | { kind: "variant"; anchorId: string; variant: Variant }
  | { kind: "place"; anchorId: string; areaId: string; index: number };

/**
 * The layout as it will look once the server agrees, drawn at once: the preview that comes back
 * replaces it (or, refused, the change is simply dropped). Orders are rewritten 0..n per area.
 */
export function applyLocally(placements: readonly ResolvedPlacement[], change: LocalChange): ResolvedPlacement[] {
  const moved = placements.find(placement => placement.anchorId === change.anchorId);
  if (!moved) return [...placements];
  if (change.kind === "visible") return placements.map(placement => placement === moved ? { ...placement, visible: change.visible } : placement);
  if (change.kind === "pinned") return placements.map(placement => placement === moved ? { ...placement, pinned: change.pinned } : placement);
  if (change.kind === "variant") return placements.map(placement => placement === moved ? { ...placement, variant: change.variant } : placement);
  const others = placements.filter(placement => placement !== moved);
  const target = blocksIn(others, change.areaId);
  const index = Math.max(0, Math.min(change.index, target.length));
  const reordered = [...target.slice(0, index), { ...moved, areaId: change.areaId }, ...target.slice(index)].map((placement, order) => ({ ...placement, order }));
  const source = moved.areaId === change.areaId ? [] : blocksIn(others, moved.areaId).map((placement, order) => ({ ...placement, order }));
  const rewritten = new Map([...reordered, ...source].map(placement => [placement.anchorId, placement] as const));
  return placements.map(placement => rewritten.get(placement.anchorId) ?? placement);
}
