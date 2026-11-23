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

type Parked = { role: FrameRole; moduleId: string; end: () => void };

export function createFrameBudget(max: Readonly<Record<FrameRole, number>> = FRAME_BUDGET) {
  const live: Record<FrameRole, number> = { view: 0, runtime: 0 };
  const views = new Map<string, number>();
  /** Stopped frames still running their cleanup, oldest first: still a document each. */
  const parked: Parked[] = [];
  const parkedCount = (role: FrameRole, moduleId?: string) => parked.filter(p => p.role === role && (moduleId === undefined || p.moduleId === moduleId)).length;
  const evict = (match: (p: Parked) => boolean) => {
    const i = parked.findIndex(match);
    if (i < 0) return false;
    const [p] = parked.splice(i, 1);
    p?.end();
    return true;
  };
  const give = (role: FrameRole, moduleId: string) => {
    live[role] = Math.max(0, live[role] - 1);
    if (role !== "view") return;
    const mine = (views.get(moduleId) ?? 0) - 1;
    if (mine > 0) views.set(moduleId, mine);
    else views.delete(moduleId);
  };
  return {
    /** A frame of this role may open (and is counted), or the budget is spent. */
    take(role: FrameRole, moduleId: string): boolean {
      if (live[role] >= max[role]) return false;
      const mine = role === "view" ? (views.get(moduleId) ?? 0) : 0;
      if (role === "view" && mine >= MODULE_VIEWS) return false;
      // Never past the cap with parked frames: the oldest goes now (the module's own first), its cleanup cut short.
      while (live[role] + parkedCount(role) >= max[role] && (evict(p => p.role === role && p.moduleId === moduleId) || evict(p => p.role === role)));
      while (role === "view" && mine + parkedCount("view", moduleId) >= MODULE_VIEWS && evict(p => p.role === "view" && p.moduleId === moduleId));
      if (role === "view") views.set(moduleId, mine + 1);
      live[role]++;
      return true;
    },
    give,
    /**
     * A stopped frame left running its cleanup: no longer live (a box remounted meanwhile gets its frame) but
     * counted until it ends, or ended (`end`) when a new one needs its place. Returns its own end's release.
     */
    park(role: FrameRole, moduleId: string, end: () => void): () => void {
      give(role, moduleId);
      const p: Parked = { role, moduleId, end };
      parked.push(p);
      return () => {
        const i = parked.indexOf(p);
        if (i >= 0) parked.splice(i, 1);
      };
    },
  };
}
