export {
  SKETCHES,
  applyLocally,
  blocksIn,
  dashboardSegments,
  heatLayerOf,
  hitGridByAnchor,
  hitStep,
  HIT_GRID_SIZE,
  insertionIndex,
  sidebarActionSegments,
  sketchFor,
  usesByAnchor,
  type HeatLayer,
  type LocalChange,
  type Sketch,
  type SketchArea,
  type SketchAxis,
  type SketchFrame,
  type SketchRegion,
} from "@contracts/workspace/sketch";
import { blocksIn } from "@contracts/workspace/sketch";
import type { ResolvedPlacement } from "@contracts/workspace/model";

export type Reorder = "up" | "down" | "first" | "last";

/**
 * Where a block goes for "up", "down", "first" or "last", as an index among its area's other blocks
 * (hidden ones included, as drawn); null when it is already there. The steps count the blocks on
 * screen only: a hidden one is never a step.
 */
export function reorderIndexOf(placements: readonly ResolvedPlacement[], anchorId: string, to: Reorder): number | null {
  const placement = placements.find(item => item.anchorId === anchorId);
  if (!placement) return null;
  const all = blocksIn(placements, placement.areaId);
  const rest = all.filter(item => item.anchorId !== anchorId);
  const visible = all.filter(item => item.visible);
  const at = visible.findIndex(item => item.anchorId === anchorId);
  if (at < 0) return null;
  const wanted = to === "up" ? at - 1 : to === "down" ? at + 1 : to === "first" ? 0 : visible.length - 1;
  if (wanted === at || wanted < 0 || wanted >= visible.length) return null;
  const restVisible = rest.filter(item => item.visible);
  return wanted < restVisible.length ? rest.indexOf(restVisible[wanted]) : rest.length;
}


/** Data colour for how much a block was used, in four steps of the theme's accent (no use: the muted fill). */
// Light steps go stronger (a pastel on white fades); dark keeps them lower, so light text stays readable.
const HEAT = ["bg-primary/25 dark:bg-primary/20", "bg-primary/45 dark:bg-primary/35", "bg-primary/65 dark:bg-primary/50", "bg-primary/90 dark:bg-primary/65"] as const;
export function heatClass(count: number, most: number): string {
  if (count <= 0) return "bg-muted";
  return HEAT[Math.min(HEAT.length - 1, Math.floor((count / Math.max(1, most)) * HEAT.length))];
}
