import { and, eq } from "drizzle-orm";
import { workspaceDiscovery } from "@db/schema";
import { getDb } from "../queries/connection";
import type { DiscoveryState, Scope } from "@contracts/workspace/model";

const empty: DiscoveryState = { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: [], placedAreaIds: [], dismissedAreaIds: [] };

function where(userId: number, scope: Scope) {
  return and(
    eq(workspaceDiscovery.userId, userId),
    eq(workspaceDiscovery.surfaceId, scope.surfaceId),
    eq(workspaceDiscovery.deviceClass, scope.deviceClass),
  );
}

function normalized(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function stringArray(text: string): string[] {
  return JSON.parse(text) as string[];
}

export async function getDiscoveryState(userId: number, scope: Scope): Promise<DiscoveryState> {
  const rows = await getDb().select().from(workspaceDiscovery).where(where(userId, scope)).limit(1);
  if (!rows[0]) return empty;
  return {
    seenAnchorIds: stringArray(rows[0].seenAnchorIds),
    placedAnchorIds: stringArray(rows[0].placedAnchorIds),
    dismissedAnchorIds: stringArray(rows[0].dismissedAnchorIds),
    seenAreaIds: stringArray(rows[0].seenAreaIds),
    placedAreaIds: stringArray(rows[0].placedAreaIds),
    dismissedAreaIds: stringArray(rows[0].dismissedAreaIds),
  };
}

export async function saveDiscoveryState(userId: number, scope: Scope, state: DiscoveryState): Promise<void> {
  await getDb().insert(workspaceDiscovery).values({
    userId,
    surfaceId: scope.surfaceId,
    deviceClass: scope.deviceClass,
    seenAnchorIds: JSON.stringify(normalized(state.seenAnchorIds)),
    placedAnchorIds: JSON.stringify(normalized(state.placedAnchorIds)),
    dismissedAnchorIds: JSON.stringify(normalized(state.dismissedAnchorIds)),
    seenAreaIds: JSON.stringify(normalized(state.seenAreaIds ?? [])),
    placedAreaIds: JSON.stringify(normalized(state.placedAreaIds ?? [])),
    dismissedAreaIds: JSON.stringify(normalized(state.dismissedAreaIds ?? [])),
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [workspaceDiscovery.userId, workspaceDiscovery.surfaceId, workspaceDiscovery.deviceClass],
    set: {
      seenAnchorIds: JSON.stringify(normalized(state.seenAnchorIds)),
      placedAnchorIds: JSON.stringify(normalized(state.placedAnchorIds)),
      dismissedAnchorIds: JSON.stringify(normalized(state.dismissedAnchorIds)),
      seenAreaIds: JSON.stringify(normalized(state.seenAreaIds ?? [])),
      placedAreaIds: JSON.stringify(normalized(state.placedAreaIds ?? [])),
      dismissedAreaIds: JSON.stringify(normalized(state.dismissedAreaIds ?? [])),
      updatedAt: Date.now(),
    },
  });
}
