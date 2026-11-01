import { purgeFlowRetention } from "./flowStore";
import { snapshotFlowEvidence } from "./flowService";
import { pruneWorkspaceState } from "./store";

/** Workspace housekeeping for the boot purge: reads never prune, so this is the only place. */
export async function purgeWorkspace(now = Date.now()): Promise<void> {
  await Promise.all([pruneWorkspaceState(now), purgeFlowRetention(now)]);
  // After the purge, so a new period never counts what retention just dropped.
  await snapshotFlowEvidence(now);
}
