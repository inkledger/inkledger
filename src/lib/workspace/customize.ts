import type { Draft, ResolvedWorkspace, Scope } from "@contracts/workspace/model";
import { draftFromWorkspace, visibilityPatch } from "./draft";

/** One Dashboard scope as Customize changes it: read fresh, applied through the usual steps, a refused draft dropped. */
export type CustomizeTarget = {
  scope: Scope;
  load: () => Promise<{ workspace: ResolvedWorkspace; draft: Draft | null }>;
  apply: (draft: Draft) => Promise<{ status: "applied" | "committed" | "deferred" | "conflict" }>;
  discard: (draftId: string) => Promise<void>;
};

export type CustomizeResult = "applied" | "deferred" | "conflict" | "studio-draft";

/**
 * Shows or hides one Dashboard section on every target, as the old Customize did on every device.
 * Each change starts from the layout as it is now (never a stale copy), and a draft it could not
 * apply is discarded, so the next tick is not blocked by this one. Changes already in progress in
 * the Studio are never applied along with it: then nothing is done at all.
 */
export async function setSectionVisibility(targets: readonly CustomizeTarget[], anchorId: string, visible: boolean): Promise<CustomizeResult> {
  const current = await Promise.all(targets.map(target => target.load()));
  if (current.some(state => state.draft)) return "studio-draft";
  for (const [index, target] of targets.entries()) {
    const { workspace } = index === 0 ? current[0] : await target.load();
    const placement = workspace.placements.find(item => item.anchorId === anchorId);
    if (!placement || placement.visible === visible) continue;
    const draft = draftFromWorkspace(workspace, [visibilityPatch(workspace, anchorId, visible)]);
    const result = await target.apply(draft);
    if (result.status === "deferred" || result.status === "conflict") {
      await target.discard(draft.draftId).catch(() => {});
      return result.status;
    }
  }
  return "applied";
}
