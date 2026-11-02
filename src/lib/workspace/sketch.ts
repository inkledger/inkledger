import type { ResolvedPlacement, Scope, Variant } from "@contracts/workspace/model";

/**
 * How each page is drawn small, area by area, the way the real page lays them out: the Layout editor
 * and the "Use over time" maps share it, so a block is always found where it is on the page.
 * - `axis`: how the area lines its blocks up (a row, a column, or tiles that wrap).
 * - `region`: where the area sits in its frame.
 */
export type SketchAxis = "row" | "column" | "tiles" | "flow";
/** `nested`: drawn inside another area, where the real page puts it (the rail beside the timeline, the timer among the sidebar's actions). */
export type SketchRegion = "top" | "main" | "nested" | "bottom" | "sidebar-top" | "sidebar-bottom" | "sheet" | "edge" | "bar" | "tray";
export type SketchArea = { areaId: string; axis: SketchAxis; region: SketchRegion };
export type SketchFrame = "page" | "phone-page" | "sidebar" | "phone";
export type Sketch = { frame: SketchFrame; areas: readonly SketchArea[] };

// The main area is drawn as the Dashboard composes it (dashboardSegments): the rail inside it, beside the timeline.
const DASHBOARD_AREAS: SketchArea[] = [
  { areaId: "dashboard.header", axis: "row", region: "top" },
  { areaId: "dashboard.primary", axis: "flow", region: "main" },
  { areaId: "dashboard.secondary", axis: "column", region: "nested" },
  { areaId: "dashboard.desk", axis: "column", region: "bottom" },
  { areaId: "dashboard.overlays", axis: "row", region: "tray" },
];

const SKETCHES: Record<string, Sketch> = {
  "dashboard:desktop": { frame: "page", areas: DASHBOARD_AREAS },
  // One column on a phone: the rail comes under the timeline.
  "dashboard:mobile": { frame: "phone-page", areas: DASHBOARD_AREAS },
  "shell-desktop:desktop": {
    frame: "sidebar",
    areas: [
      { areaId: "shell.navigation", axis: "column", region: "sidebar-top" },
      // The running timer sits among the actions, just before "Start timer" (sidebarActionSegments).
      { areaId: "shell.timer", axis: "column", region: "nested" },
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

/** Sections that span the Dashboard's whole width, wherever they sit in the order. */
const DASHBOARD_BANDS: ReadonlySet<string> = new Set(["dashboard.timeline", "dashboard.recap"]);
/** My issues and Recent activity stack in one column beside the summary. */
const DASHBOARD_STACKED: ReadonlySet<string> = new Set(["dashboard.tasks", "dashboard.activity"]);

/**
 * How the Dashboard lays out its main area, for the page itself and for every drawing of it: the timeline,
 * when it leads, shares a band with the rail; then full-width bands keep their place and the sections
 * between them share a row (the stacked ones in one column, where the first of them sits).
 */
export function dashboardSegments(anchorIds: readonly string[]): { lead: string | null; segments: ({ kind: "band"; anchorId: string } | { kind: "row"; items: (string | readonly string[])[] })[] } {
  const lead = anchorIds[0] === "dashboard.timeline" ? anchorIds[0] : null;
  const segments: ({ kind: "band"; anchorId: string } | { kind: "row"; anchorIds: string[] })[] = [];
  for (const anchorId of lead ? anchorIds.slice(1) : anchorIds) {
    const last = segments.at(-1);
    if (DASHBOARD_BANDS.has(anchorId)) segments.push({ kind: "band", anchorId });
    else if (last?.kind === "row") last.anchorIds.push(anchorId);
    else segments.push({ kind: "row", anchorIds: [anchorId] });
  }
  return {
    lead,
    segments: segments.map(segment => {
      if (segment.kind === "band") return segment;
      const column = segment.anchorIds.filter(anchorId => DASHBOARD_STACKED.has(anchorId));
      const items = segment.anchorIds.flatMap((anchorId): (string | readonly string[])[] => !DASHBOARD_STACKED.has(anchorId) ? [anchorId] : anchorId === column[0] ? [column] : []);
      return { kind: "row" as const, items };
    }),
  };
}

/** The sidebar's actions split where the running timer goes: before "Start timer". */
export function sidebarActionSegments(anchorIds: readonly string[], quickStartIndex: number): { before: string[]; after: string[] } {
  const split = quickStartIndex < 0 ? anchorIds.length : quickStartIndex;
  return { before: anchorIds.slice(0, split), after: anchorIds.slice(split) };
}

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
    // Rows, tiles and the Dashboard's flow read like text; only a plain column is by height alone.
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

/** Data colour for how much a block was used, in four steps of the theme's accent (no use: the muted fill). */
const HEAT = ["bg-primary/15", "bg-primary/25", "bg-primary/35", "bg-primary/45"] as const;
export function heatClass(count: number, most: number): string {
  if (count <= 0) return "bg-muted";
  return HEAT[Math.min(HEAT.length - 1, Math.floor((count / Math.max(1, most)) * HEAT.length))];
}

/** How much each block was used: its controls' activations added up. */
export function usesByAnchor(heat: readonly { anchorId: string; activations: number }[]): Map<string, number> {
  const uses = new Map<string, number>();
  for (const point of heat) uses.set(point.anchorId, (uses.get(point.anchorId) ?? 0) + point.activations);
  return uses;
}
