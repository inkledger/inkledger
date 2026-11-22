/**
 * Live frames on a page, at most, by role: each costs a document (and the
 * first, a process). Counted apart, so views never leave a module without
 * its runtime. Sized for the ported modules (a runtime and about two views
 * each): six framed at once (6 runtimes, 12 views) fit, measured smooth by
 * e2e/modules-frame-life.test.mjs.
 */
export const FRAME_BUDGET = { view: 16, runtime: 8 } as const;

export type FrameRole = keyof typeof FRAME_BUDGET;

export function createFrameBudget(max: Readonly<Record<FrameRole, number>> = FRAME_BUDGET) {
  const live: Record<FrameRole, number> = { view: 0, runtime: 0 };
  return {
    /** A frame of this role may open (and is counted), or the budget is spent. */
    take(role: FrameRole): boolean {
      if (live[role] >= max[role]) return false;
      live[role]++;
      return true;
    },
    give(role: FrameRole) {
      live[role] = Math.max(0, live[role] - 1);
    },
  };
}
