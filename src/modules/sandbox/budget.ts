/**
 * Live frames on a page, at most, by role: each costs a document (and the
 * first, a process). Counted apart, so views never leave a module without
 * its runtime. Sized for the ported modules (a runtime and about two views
 * each): six framed at once (6 runtimes, 12 views) fit; e2e/modules-frame-life
 * mounts those 18 with no long task and the watchdog leaving every frame alone.
 * A module's views are capped too, so one module naming many slots never
 * leaves the others without theirs.
 */
export const FRAME_BUDGET = { view: 16, runtime: 8 } as const;
/** Views one module may hold at once: the most slots a module shows together (the radio's on a phone), its sheet included. */
export const MODULE_VIEWS = 6;

export type FrameRole = keyof typeof FRAME_BUDGET;

export function createFrameBudget(max: Readonly<Record<FrameRole, number>> = FRAME_BUDGET) {
  const live: Record<FrameRole, number> = { view: 0, runtime: 0 };
  const views = new Map<string, number>();
  return {
    /** A frame of this role may open (and is counted), or the budget is spent. */
    take(role: FrameRole, moduleId: string): boolean {
      if (live[role] >= max[role]) return false;
      if (role === "view") {
        const mine = views.get(moduleId) ?? 0;
        if (mine >= MODULE_VIEWS) return false;
        views.set(moduleId, mine + 1);
      }
      live[role]++;
      return true;
    },
    give(role: FrameRole, moduleId: string) {
      live[role] = Math.max(0, live[role] - 1);
      if (role !== "view") return;
      const mine = (views.get(moduleId) ?? 0) - 1;
      if (mine > 0) views.set(moduleId, mine);
      else views.delete(moduleId);
    },
  };
}
