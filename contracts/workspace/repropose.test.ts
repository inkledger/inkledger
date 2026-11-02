import { describe, expect, it } from "vitest";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "./catalogV1";
import { productDefaultFor } from "./catalog";
import { reproposeDisjoint } from "./repropose";
import type { ActiveRevision, Constraint, Draft, LayoutOperation, ResolveInput, Scope, SuggestionPatch } from "./model";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };

function current(operations: readonly LayoutOperation[], constraints: readonly Constraint[] = []): ResolveInput {
  const activeRevision: ActiveRevision = {
    revisionId: "rev-2",
    scope,
    catalogVersion: CATALOG_V1.catalogVersion,
    productDefaultVersion: CATALOG_V1.productDefaultVersion,
    committedAt: 2,
    operations: operations.map(operation => ({ operation, origin: "user", acceptedByUser: true })),
    constraints,
    opaque: [],
  };
  return {
    catalog: CATALOG_V1,
    productDefault: productDefaultFor(PRODUCT_DEFAULTS_V1, "dashboard"),
    activeRevision,
    draft: null,
    explicitConstraints: constraints,
    feedback: { suppressedSuggestionSignatures: [] },
    discoveryState: { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [] },
  };
}

function patch(patchId: string, operations: readonly LayoutOperation[]): SuggestionPatch {
  return {
    patchId,
    patchSchemaVersion: 1,
    scope,
    baseRevision: "default",
    catalogVersion: CATALOG_V1.catalogVersion,
    author: "user",
    provenance: {},
    intent: { kind: "custom", status: "explicit" },
    operations,
    evidence: [],
    proposedConstraints: [],
  };
}

function stale(patches: readonly SuggestionPatch[]): Draft {
  return { draftId: "draft-b", draftRevision: 2, baseRevision: "default", scope, patches, status: "ready" };
}

const hideStats: LayoutOperation = { type: "visibility", operationId: "a-hide-stats", anchorId: "dashboard.stats", visible: false };
const pinStats: LayoutOperation = { type: "pin", operationId: "b-pin-stats", anchorId: "dashboard.stats", pinned: true };
const hideActivity: LayoutOperation = { type: "visibility", operationId: "b-hide-activity", anchorId: "dashboard.activity", visible: false };
const compactRecap: LayoutOperation = { type: "variant", operationId: "b-compact-recap", anchorId: "dashboard.recap", variant: "compact" };

describe("re-proposing a stale draft's disjoint changes", () => {
  it("keeps the changes to blocks nobody touched since, rebased on the current revision", () => {
    const result = reproposeDisjoint(stale([patch("p1", [pinStats]), patch("p2", [hideActivity])]), [hideStats], current([hideStats]));
    expect(result.operations).toEqual([hideActivity]);
    expect(result.patches.map(item => [item.patchId, item.baseRevision, item.operations])).toEqual([["p2", "rev-2", [hideActivity]]]);
    expect(result.dropped).toEqual([{ operationId: "b-pin-stats", anchorId: "dashboard.stats", reason: "overlap" }]);
  });

  it("drops a move into an area another change filled meanwhile, and a reorder of it", () => {
    const moveSummary: LayoutOperation = { type: "move", operationId: "a-move-summary", anchorId: "dashboard.summary", toAreaId: "dashboard.secondary" };
    const moveActivity: LayoutOperation = { type: "move", operationId: "b-move-activity", anchorId: "dashboard.activity", toAreaId: "dashboard.secondary" };
    const reorder: LayoutOperation = { type: "reorder", operationId: "b-reorder-secondary", areaId: "dashboard.secondary", anchorIds: ["dashboard.stats"] };
    const result = reproposeDisjoint(stale([patch("p1", [moveActivity, reorder, compactRecap])]), [moveSummary], current([moveSummary]));
    expect(result.operations).toEqual([compactRecap]);
    expect(result.dropped).toEqual([
      { operationId: "b-reorder-secondary", areaId: "dashboard.secondary", reason: "overlap" },
      { operationId: "b-move-activity", anchorId: "dashboard.activity", areaId: "dashboard.secondary", reason: "overlap" },
    ]);
  });

  it("lists as refused a disjoint change today's rules no longer allow, and keeps the rest", () => {
    const keepRecap: Constraint = { id: "keep-recap", kind: "keepVisible", status: "explicit", author: "user", scope, anchorId: "dashboard.recap" };
    const hideRecap: LayoutOperation = { type: "visibility", operationId: "b-hide-recap", anchorId: "dashboard.recap", visible: false };
    const result = reproposeDisjoint(stale([patch("p1", [hideRecap, hideActivity])]), [], current([], [keepRecap]));
    expect(result.operations).toEqual([hideActivity]);
    expect(result.dropped).toEqual([{ operationId: "b-hide-recap", anchorId: "dashboard.recap", reason: "refused" }]);
  });

  it("keeps nothing when every change overlaps", () => {
    const result = reproposeDisjoint(stale([patch("p1", [pinStats])]), [hideStats], current([hideStats]));
    expect(result.patches).toEqual([]);
    expect(result.operations).toEqual([]);
  });

  it("answers the same whatever order the committed changes come in", () => {
    const draft = stale([patch("p1", [compactRecap, pinStats]), patch("p2", [hideActivity])]);
    const hideTasks: LayoutOperation = { type: "visibility", operationId: "a-hide-tasks", anchorId: "dashboard.tasks", visible: false };
    const pinActivity: LayoutOperation = { type: "pin", operationId: "a-pin-activity", anchorId: "dashboard.activity", pinned: true };
    const one = reproposeDisjoint(draft, [hideStats, hideTasks, pinActivity], current([hideStats, hideTasks, pinActivity]));
    const other = reproposeDisjoint(draft, [pinActivity, hideTasks, hideStats], current([hideStats, hideTasks, pinActivity]));
    expect(other).toEqual(one);
    expect(one.operations).toEqual([compactRecap]);
    expect(one.dropped.map(item => item.anchorId)).toEqual(["dashboard.activity", "dashboard.stats"]);
  });
});
