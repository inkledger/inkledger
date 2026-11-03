import type { SurfaceId } from "@contracts/workspace/model";
import { claimPartFailure } from "@/components/app/lazyPart";

/**
 * The code that draws each surface's blocks. The shell's and the tab bar's are in the first load;
 * the Dashboard's comes with its page (the same chunk its route loads, fetched once).
 */
const RENDERERS: Readonly<Record<SurfaceId, () => Promise<unknown>>> = {
  dashboard: () => import("@/pages/Dashboard"),
  "shell-desktop": () => Promise.resolve(),
  "mobile-tabs": () => Promise.resolve(),
  // Observed pages: never rearranged yet, their code is the page's own chunk.
  reports: () => import("@/pages/Reports"),
  timesheet: () => import("@/pages/Timesheet"),
  issues: () => import("@/pages/Issues"),
  board: () => import("@/pages/Board"),
  desk: () => import("@/pages/DeskPage"),
  team: () => import("@/pages/Team"),
};

/**
 * Whether the blocks of a surface can be drawn here, loading their code if needed (T-03): a layout is
 * never committed for a page this tab could not then show. A failure is this check's own, never a
 * reason to reload the page under the user (main.tsx).
 */
export async function renderersReady(surfaceId: SurfaceId): Promise<boolean> {
  try {
    await RENDERERS[surfaceId]();
    return true;
  } catch (error) {
    claimPartFailure(error);
    return false;
  }
}
