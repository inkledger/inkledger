export {
  SKETCHES,
  applyLocally,
  blocksIn,
  dashboardSegments,
  hitGridByAnchor,
  insertionIndex,
  sidebarActionSegments,
  sketchFor,
  usesByAnchor,
  type LocalChange,
  type Sketch,
  type SketchArea,
  type SketchAxis,
  type SketchFrame,
  type SketchRegion,
} from "@contracts/workspace/sketch";

/** Data colour for how much a block was used, in four steps of the theme's accent (no use: the muted fill). */
const HEAT = ["bg-primary/15", "bg-primary/25", "bg-primary/35", "bg-primary/45"] as const;
export function heatClass(count: number, most: number): string {
  if (count <= 0) return "bg-muted";
  return HEAT[Math.min(HEAT.length - 1, Math.floor((count / Math.max(1, most)) * HEAT.length))];
}
