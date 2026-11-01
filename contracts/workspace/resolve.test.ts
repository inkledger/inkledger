import { describe, expect, it } from "vitest";
import { createOpaqueEntry } from "../../api/workspace/crypto";
import type {
  ActiveRevision,
  Catalog,
  Constraint,
  Draft,
  ProductDefault,
  ResolveInput,
  Scope,
  SuggestionPatch,
} from "./model";
import { resolve } from "./resolve";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };

const productDefault: ProductDefault = {
  productDefaultVersion: "product-1",
  placements: [
    { anchorId: "timeline", areaId: "primary", order: 0, visible: true, variant: "default", pinned: false },
    { anchorId: "timer", areaId: "primary", order: 1, visible: true, variant: "default", pinned: false },
    { anchorId: "tasks", areaId: "primary", order: 2, visible: true, variant: "default", pinned: false },
    { anchorId: "stats", areaId: "secondary", order: 0, visible: true, variant: "default", pinned: false },
  ],
};

const catalog: Catalog = {
  catalogVersion: "1.0.0",
  productDefaultVersion: "product-1",
  resolverVersion: 1,
  areas: [
    { id: "primary", capacity: 4, allowedAnchorIds: ["timeline", "timer", "tasks", "stats", "new-feature"] },
    { id: "secondary", capacity: 1, allowedAnchorIds: ["stats", "tasks", "new-feature"] },
  ],
  anchors: [
    { id: "timeline", surfaceId: "dashboard", renderer: "timeline", statePolicy: "local", critical: false, introducedIn: "1.0.0" },
    { id: "timer", surfaceId: "dashboard", renderer: "timer", statePolicy: "critical", critical: true, introducedIn: "1.0.0" },
    { id: "tasks", surfaceId: "dashboard", renderer: "tasks", statePolicy: "external", critical: false, introducedIn: "1.0.0" },
    { id: "stats", surfaceId: "dashboard", renderer: "stats", statePolicy: "stateless", critical: false, introducedIn: "1.0.0" },
    { id: "new-feature", surfaceId: "dashboard", renderer: "new-feature", statePolicy: "stateless", critical: false, introducedIn: "2.0.0" },
  ],
  tombstones: [],
};

function active(overrides: Partial<ActiveRevision> = {}): ActiveRevision {
  return {
    revisionId: "rev-1",
    scope,
    catalogVersion: "1.0.0",
    productDefaultVersion: "product-1",
    committedAt: 0,
    operations: [],
    constraints: [],
    opaque: [],
    ...overrides,
  };
}

function patch(overrides: Partial<SuggestionPatch> = {}): SuggestionPatch {
  return {
    patchId: "patch-1",
    patchSchemaVersion: 1,
    scope,
    baseRevision: "rev-1",
    catalogVersion: "1.0.0",
    author: "AI",
    provenance: { model: "test-model" },
    intent: { kind: "prioritize", status: "proposed", anchorId: "stats" },
    operations: [],
    evidence: [],
    proposedConstraints: [],
    suggestionSignature: "suggestion-1",
    ...overrides,
  };
}

function draftOf(patches: readonly SuggestionPatch[]): Draft {
  return { draftId: "draft-1", draftRevision: 1, baseRevision: "rev-1", scope, patches, status: "ready" };
}

function constraintOf(overrides: Partial<Constraint> = {}): Constraint {
  return {
    id: "constraint-1",
    kind: "pin",
    status: "explicit",
    author: "user",
    scope,
    anchorId: "stats",
    ...overrides,
  };
}

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    catalog,
    productDefault,
    activeRevision: active(),
    draft: null,
    explicitConstraints: [],
    feedback: { suppressedSuggestionSignatures: [] },
    discoveryState: { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [] },
    ...overrides,
  };
}

function placements(result: ReturnType<typeof resolve>) {
  if (result.kind !== "resolved") throw new Error(JSON.stringify(result.conflicts));
  return result.workspace.placements;
}

describe("workspace resolver", () => {
  it("resolves an untouched ProductDefault deterministically", () => {
    const first = resolve(input());
    const second = resolve(input());
    expect(first).toEqual(second);
    expect(placements(first).map(item => item.anchorId)).toEqual(["timeline", "timer", "tasks", "stats"]);
    expect(placements(first).every(item => item.origin === "product")).toBe(true);
  });

  it("updates only non-personalized parts when ProductDefault changes", () => {
    const custom = active({
      operations: [{
        origin: "user",
        acceptedByUser: true,
        operation: { type: "move", operationId: "op-1", anchorId: "stats", toAreaId: "primary", order: 3 },
      }],
    });
    const nextCatalog = {
      ...catalog,
      catalogVersion: "2.0.0",
      productDefaultVersion: "product-2",
      areas: catalog.areas.map(area => area.id === "primary" ? { ...area, capacity: 5 } : area),
    };
    const nextDefault = {
      ...productDefault,
      productDefaultVersion: "product-2",
      placements: [...productDefault.placements, { anchorId: "new-feature", areaId: "primary", order: 4, visible: true, variant: "default" as const, pinned: false }],
    };
    const result = resolve(input({ catalog: nextCatalog, productDefault: nextDefault, activeRevision: custom }));
    const stats = placements(result).find(item => item.anchorId === "stats");
    const added = placements(result).find(item => item.anchorId === "new-feature");
    expect(stats).toMatchObject({ areaId: "primary", origin: "user" });
    expect(added).toMatchObject({ origin: "product" });
    if (result.kind !== "resolved") throw new Error("expected resolved workspace");
    expect(result.workspace.discoveryAnchorIds).toEqual(["new-feature"]);
    expect(result.workspace.productDefaultVersion).toBe("product-2");
  });

  it("validates new patches against the current catalog while preserving release discovery", () => {
    const releasedCatalog = { ...catalog, catalogVersion: "1.10.0", anchors: catalog.anchors.map(anchor => anchor.id === "new-feature" ? { ...anchor, introducedIn: "1.10.0" } : anchor) };
    const historical = active({ catalogVersion: "1.9.0" });
    const currentPatch = patch({ catalogVersion: "1.10.0", author: "user", intent: { kind: "group", status: "explicit", anchorId: "stats", areaId: "primary" }, operations: [{ type: "move", operationId: "op-current", anchorId: "stats", toAreaId: "primary" }] });
    const result = resolve(input({ catalog: releasedCatalog, activeRevision: historical, draft: draftOf([currentPatch]) }));
    expect(result).toMatchObject({ kind: "resolved", workspace: { catalogVersion: "1.10.0", sourceActiveRevision: "rev-1", discoveryAnchorIds: ["new-feature"] } });
    expect(placements(result).find(placement => placement.anchorId === "stats")).toMatchObject({ areaId: "primary", origin: "user" });
    const stalePatch = patch({ catalogVersion: "1.9.0" });
    expect(resolve(input({ catalog: releasedCatalog, activeRevision: historical, draft: draftOf([stalePatch]) }))).toMatchObject({ kind: "conflicts" });
    const placed = resolve(input({ catalog: releasedCatalog, activeRevision: historical, discoveryState: { seenAnchorIds: ["new-feature"], placedAnchorIds: ["new-feature"], dismissedAnchorIds: [] } }));
    expect(placed).toMatchObject({ kind: "resolved", workspace: { discoveryAnchorIds: [] } });
  });

  it("orders numeric release versions and rejects an unreadable discovery baseline", () => {
    const releasedCatalog = { ...catalog, catalogVersion: "1.10.0", anchors: catalog.anchors.map(anchor => anchor.id === "new-feature" ? { ...anchor, introducedIn: "1.10.0" } : anchor) };
    const previous = resolve(input({ catalog: releasedCatalog, activeRevision: active({ catalogVersion: "1.9.0" }) }));
    expect(previous).toMatchObject({ kind: "resolved", workspace: { discoveryAnchorIds: ["new-feature"] } });
    const current = resolve(input({ catalog: releasedCatalog, activeRevision: active({ catalogVersion: "1.10.0" }) }));
    expect(current).toMatchObject({ kind: "resolved", workspace: { discoveryAnchorIds: [] } });
    expect(() => resolve(input({ catalog: releasedCatalog, activeRevision: active({ catalogVersion: "1.9" }) }))).not.toThrow();
    expect(resolve(input({ catalog: releasedCatalog, activeRevision: active({ catalogVersion: "1.9" }) }))).toMatchObject({ kind: "conflicts" });
  });

  it("discovers new areas until they are explicitly placed or dismissed", () => {
    const releasedCatalog = { ...catalog, catalogVersion: "1.10.0", areas: [...catalog.areas, { id: "new-area", capacity: 2, allowedAnchorIds: ["new-feature"], introducedIn: "1.10.0" }] };
    const historical = active({ catalogVersion: "1.9.0" });
    const result = resolve(input({ catalog: releasedCatalog, activeRevision: historical }));
    expect(result).toMatchObject({ kind: "resolved", workspace: { discoveryAreaIds: ["new-area"] } });
    const placed = resolve(input({ catalog: releasedCatalog, activeRevision: historical, discoveryState: { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: ["new-area"], placedAreaIds: ["new-area"], dismissedAreaIds: [] } }));
    expect(placed).toMatchObject({ kind: "resolved", workspace: { discoveryAreaIds: [] } });
    const dismissed = resolve(input({ catalog: releasedCatalog, activeRevision: historical, discoveryState: { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: ["new-area"], placedAreaIds: [], dismissedAreaIds: ["new-area"] } }));
    expect(dismissed).toMatchObject({ kind: "resolved", workspace: { discoveryAreaIds: [] } });
  });

  it("uses only explicit product migrations for missing areas and capacity overflow", () => {
    const overflowDefault = { ...productDefault, placements: [...productDefault.placements, { anchorId: "new-feature", areaId: "secondary", order: 1, visible: true, variant: "default" as const, pinned: false }] };
    const migration = { id: "migrate-new-feature", fromCatalogVersion: "1.0.0", toCatalogVersion: "1.0.0", anchorId: "new-feature", fallback: { type: "move" as const, toAreaId: "primary" } };
    expect(resolve(input({ productDefault: overflowDefault }))).toMatchObject({ kind: "conflicts" });
    const moved = resolve(input({ productDefault: overflowDefault, migrations: [migration] }));
    expect(placements(moved).find(placement => placement.anchorId === "new-feature")).toMatchObject({ areaId: "primary", origin: "fallback" });
    expect(moved).toMatchObject({ kind: "resolved", workspace: { fallbacks: [{ anchorId: "new-feature", reason: "migrated", migrationId: migration.id, toAreaId: "primary" }] } });
    const isolated = resolve(input({ productDefault: overflowDefault, migrations: [{ ...migration, fallback: { type: "isolate" as const } }] }));
    expect(placements(isolated).some(placement => placement.anchorId === "new-feature")).toBe(false);
    expect(placements(isolated).some(placement => placement.anchorId === "stats")).toBe(true);
    const missingArea = { ...productDefault, placements: [...productDefault.placements, { anchorId: "new-feature", areaId: "removed-area", order: 0, visible: true, variant: "default" as const, pinned: false }] };
    const recovered = resolve(input({ productDefault: missingArea, migrations: [migration] }));
    expect(placements(recovered).find(placement => placement.anchorId === "new-feature")).toMatchObject({ areaId: "primary", origin: "fallback" });
  });

  it("treats accepted AI operations as user-owned without losing their provenance", () => {
    const accepted = patch({
      operations: [{ type: "move", operationId: "op-ai", anchorId: "stats", toAreaId: "primary" }],
    });
    const stats = placements(resolve(input({ draft: draftOf([accepted]) }))).find(item => item.anchorId === "stats");
    expect(stats).toMatchObject({ origin: "user", operationId: "op-ai", areaId: "primary" });
    expect(accepted.provenance.model).toBe("test-model");
  });

  it("does not apply proposed AI/import constraints without separate confirmation", () => {
    const proposed = patch({
      proposedConstraints: [constraintOf({ kind: "hide", status: "proposed", author: "AI" })],
    });
    expect(placements(resolve(input({ draft: draftOf([proposed]) }))).find(item => item.anchorId === "stats")?.visible).toBe(true);
    const confirmed = constraintOf({ kind: "hide", author: "import" });
    expect(placements(resolve(input({ explicitConstraints: [confirmed] }))).find(item => item.anchorId === "stats")?.visible).toBe(false);
  });

  it("never lets a draft override pin, keepVisible or suppressed feedback", () => {
    const move = patch({ operations: [{ type: "move", operationId: "op-2", anchorId: "stats", toAreaId: "primary" }] });
    expect(resolve(input({ draft: draftOf([move]), explicitConstraints: [constraintOf()] }))).toMatchObject({ kind: "conflicts" });
    const hide = patch({ operations: [{ type: "visibility", operationId: "op-3", anchorId: "stats", visible: false }] });
    expect(resolve(input({ draft: draftOf([hide]), explicitConstraints: [constraintOf({ kind: "keepVisible" })] }))).toMatchObject({ kind: "conflicts" });
    expect(resolve(input({ draft: draftOf([move]), feedback: { suppressedSuggestionSignatures: ["suggestion-1"] } }))).toMatchObject({ kind: "conflicts" });
  });

  it("enforces pin, expectHere and suggestion suppression on reorder too", () => {
    // Only primary's own anchors, the critical timer at its index: what is left to refuse is the constraint.
    const reorder = patch({ operations: [{ type: "reorder", operationId: "op-reorder", areaId: "primary", anchorIds: ["tasks", "timer", "timeline"] }] });
    expect(resolve(input({ draft: draftOf([reorder]) })).kind).toBe("resolved");
    expect(resolve(input({ draft: draftOf([reorder]), explicitConstraints: [constraintOf({ anchorId: "tasks" })] }))).toMatchObject({ kind: "conflicts", conflicts: [{ code: "constraint-conflict", anchorId: "tasks" }] });
    expect(resolve(input({ draft: draftOf([reorder]), explicitConstraints: [constraintOf({ kind: "doNotSuggest", anchorId: "tasks" })] }))).toMatchObject({ kind: "conflicts", conflicts: [{ code: "suggestion-suppressed", anchorId: "tasks" }] });
    expect(resolve(input({ draft: draftOf([reorder]), explicitConstraints: [constraintOf({ kind: "expectHere", anchorId: "tasks", areaId: "secondary" })] }))).toMatchObject({ kind: "conflicts", conflicts: expect.arrayContaining([expect.objectContaining({ code: "constraint-conflict", anchorId: "tasks", areaId: "secondary" })]) });
  });

  it("lets a pin keep an anchor in place and on screen, not freeze the user's variant (D-55)", () => {
    const pin = [constraintOf()];
    const user = (operation: SuggestionPatch["operations"][number]) => patch({ author: "user", intent: { kind: "custom", status: "explicit" }, suggestionSignature: undefined, operations: [operation] });
    expect(resolve(input({ draft: draftOf([user({ type: "variant", operationId: "v", anchorId: "stats", variant: "compact" })]), explicitConstraints: pin })).kind).toBe("resolved");
    for (const operation of [
      { type: "visibility", operationId: "h", anchorId: "stats", visible: false },
      { type: "move", operationId: "m", anchorId: "stats", toAreaId: "primary" },
      { type: "pin", operationId: "p", anchorId: "stats", pinned: false },
    ] as const) {
      expect(resolve(input({ draft: draftOf([user(operation)]), explicitConstraints: pin }))).toMatchObject({ kind: "conflicts", conflicts: expect.arrayContaining([expect.objectContaining({ code: "constraint-conflict", anchorId: "stats" })]) });
    }
  });

  it("leaves a pinned placement to the user: a suggestion cannot change or reorder it", () => {
    const pinned = { ...productDefault, placements: productDefault.placements.map(item => item.anchorId === "tasks" ? { ...item, pinned: true } : item) };
    const variant = patch({ operations: [{ type: "variant", operationId: "v", anchorId: "tasks", variant: "compact" }] });
    expect(resolve(input({ productDefault: pinned, draft: draftOf([variant]) }))).toMatchObject({ kind: "conflicts", conflicts: [{ code: "constraint-conflict", anchorId: "tasks" }] });
    const reorder = patch({ operations: [{ type: "reorder", operationId: "r", areaId: "primary", anchorIds: ["tasks", "timer", "timeline"] }] });
    expect(resolve(input({ productDefault: pinned, draft: draftOf([reorder]) }))).toMatchObject({ kind: "conflicts", conflicts: [{ code: "constraint-conflict", anchorId: "tasks" }] });
    const mine = { ...variant, author: "user" as const, intent: { kind: "custom" as const, status: "explicit" as const } };
    expect(resolve(input({ productDefault: pinned, draft: draftOf([mine]) })).kind).toBe("resolved");
  });

  it("refuses a second change to the same anchor in one draft unless the user made it", () => {
    const first = patch({ patchId: "a", operations: [{ type: "variant", operationId: "v1", anchorId: "stats", variant: "compact" }] });
    const second = patch({ patchId: "b", operations: [{ type: "variant", operationId: "v2", anchorId: "stats", variant: "expanded" }] });
    expect(resolve(input({ draft: draftOf([first, second]) }))).toMatchObject({ kind: "conflicts", conflicts: [{ code: "constraint-conflict", anchorId: "stats" }] });
    const mine = { ...second, author: "user" as const, intent: { kind: "custom" as const, status: "explicit" as const } };
    expect(placements(resolve(input({ draft: draftOf([first, mine]) }))).find(item => item.anchorId === "stats")?.variant).toBe("expanded");
  });

  it("reorders a replaced anchor as its replacement", () => {
    const migrated: Catalog = { ...catalog, anchors: catalog.anchors.filter(anchor => anchor.id !== "tasks"), tombstones: [{ anchorId: "tasks", replacementAnchorId: "new-feature", fallback: "conflict" }] };
    const withNew = { ...catalog, anchors: migrated.anchors.map(anchor => anchor.id === "new-feature" ? { ...anchor, introducedIn: "1.0.0" } : anchor) };
    const reorder = patch({ operations: [{ type: "reorder", operationId: "r", areaId: "primary", anchorIds: ["tasks", "timer", "timeline"] }] });
    const result = resolve(input({ catalog: { ...withNew, tombstones: migrated.tombstones }, draft: draftOf([reorder]) }));
    expect(placements(result).filter(item => item.areaId === "primary").map(item => item.anchorId)).toEqual(["new-feature", "timer", "timeline"]);
  });

  it("rejects divergent Catalog and ProductDefault versions before rendering", () => {
    expect(resolve(input({ productDefault: { ...productDefault, productDefaultVersion: "product-other" } }))).toMatchObject({ kind: "conflicts" });
  });

  it("blocks incompatible areas, capacity overflow and hiding critical controls", () => {
    const incompatible = patch({ operations: [{ type: "move", operationId: "op-4", anchorId: "timeline", toAreaId: "secondary" }] });
    expect(resolve(input({ draft: draftOf([incompatible]) }))).toMatchObject({ kind: "conflicts" });
    const hideTimer = patch({ operations: [{ type: "visibility", operationId: "op-5", anchorId: "timer", visible: false }] });
    expect(resolve(input({ draft: draftOf([hideTimer]) }))).toMatchObject({ kind: "conflicts" });
    const overCapacity = { ...productDefault, placements: [...productDefault.placements, { anchorId: "new-feature", areaId: "secondary", order: 1, visible: true, variant: "default" as const, pinned: false }] };
    expect(resolve(input({ productDefault: overCapacity }))).toMatchObject({ kind: "conflicts" });
  });

  it("migrates replaced anchors and isolates only declared fallbacks", () => {
    const migratedCatalog: Catalog = {
      ...catalog,
      anchors: catalog.anchors.filter(anchor => anchor.id !== "timeline"),
      tombstones: [{ anchorId: "timeline", replacementAnchorId: "new-feature", fallback: "conflict" }],
    };
    const replaced = resolve(input({ catalog: migratedCatalog }));
    expect(replaced.kind).toBe("resolved");
    if (replaced.kind === "resolved") {
      expect(replaced.workspace.fallbacks).toEqual([{ anchorId: "timeline", reason: "replaced", replacementAnchorId: "new-feature" }]);
      expect(replaced.workspace.placements.some(item => item.anchorId === "new-feature")).toBe(true);
    }
    const isolatedCatalog: Catalog = {
      ...migratedCatalog,
      tombstones: [{ anchorId: "timeline", fallback: "isolate" }],
    };
    const isolated = resolve(input({ catalog: isolatedCatalog }));
    expect(isolated.kind).toBe("resolved");
    if (isolated.kind === "resolved") expect(isolated.workspace.fallbacks).toEqual([{ anchorId: "timeline", reason: "isolated" }]);
  });

  it("preserves opaque entries read-only and rejects writes that could erase them", () => {
    const opaque = [createOpaqueEntry("future.anchor", 1, new TextEncoder().encode('{"x":1}'))];
    const withOpaque = active({ opaque });
    const resolved = resolve(input({ activeRevision: withOpaque }));
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") expect(resolved.workspace.opaque).toEqual(opaque);
    const write = patch({ operations: [{ type: "variant", operationId: "op-6", anchorId: "stats", variant: "compact" }] });
    expect(resolve(input({ activeRevision: withOpaque, draft: draftOf([write]) }))).toMatchObject({ kind: "conflicts" });
  });

  it("normalizes area order and rejects stale or cross-scope drafts", () => {
    const reorder = patch({
      operations: [{ type: "reorder", operationId: "op-7", areaId: "primary", anchorIds: ["tasks", "timer", "timeline"] }],
    });
    expect(placements(resolve(input({ draft: draftOf([reorder]) }))).filter(item => item.areaId === "primary").map(item => item.anchorId)).toEqual(["tasks", "timer", "timeline"]);
    // A partial order would leave the rest at a guessed place: the full visible list or nothing.
    const partial = patch({ operations: [{ type: "reorder", operationId: "op-8", areaId: "primary", anchorIds: ["tasks", "timeline"] }] });
    expect(resolve(input({ draft: draftOf([partial]) }))).toMatchObject({ kind: "conflicts", conflicts: [{ code: "constraint-conflict", areaId: "primary" }] });
    const crossScope = patch({ scope: { surfaceId: "mobile-tabs", deviceClass: "mobile" } });
    expect(resolve(input({ draft: draftOf([crossScope]) }))).toMatchObject({ kind: "conflicts" });
    expect(resolve(input({ draft: draftOf([patch({ catalogVersion: "0.9.0" })]) }))).toMatchObject({ kind: "conflicts" });
  });

  it("applies only separately confirmed draft constraints", () => {
    const proposed = patch({ proposedConstraints: [constraintOf({ status: "proposed", author: "import" })] });
    const confirmed = patch({ proposedConstraints: [constraintOf({ status: "explicit", author: "user" })] });
    expect(placements(resolve(input({ draft: draftOf([proposed]) }))).find(placement => placement.anchorId === "stats")?.pinned).toBe(false);
    expect(placements(resolve(input({ draft: draftOf([confirmed]) }))).find(placement => placement.anchorId === "stats")?.pinned).toBe(true);
  });

  it("rejects indirect moves of critical or dirty anchors", () => {
    const critical = patch({ operations: [{ type: "reorder", operationId: "op-critical", areaId: "primary", anchorIds: ["timer", "tasks", "timeline"] }] });
    expect(resolve(input({ draft: draftOf([critical]) }))).toMatchObject({ kind: "conflicts", conflicts: expect.arrayContaining([expect.objectContaining({ code: "constraint-conflict", anchorId: "timer" })]) });
    const dirty = { ...catalog, anchors: catalog.anchors.map(anchor => anchor.id === "tasks" ? { ...anchor, statePolicy: "dirty" as const } : anchor) };
    expect(resolve(input({ catalog: dirty, draft: draftOf([critical]) }))).toMatchObject({ kind: "conflicts" });
  });

  it("rejects stale draft and patch bases instead of silently rebasing them", () => {
    const staleDraft = { ...draftOf([]), baseRevision: "rev-old" };
    expect(resolve(input({ draft: staleDraft }))).toMatchObject({ kind: "conflicts" });
    const stalePatch = patch({ baseRevision: "rev-old", operations: [{ type: "variant", operationId: "op-stale", anchorId: "stats", variant: "compact" }] });
    expect(resolve(input({ draft: draftOf([stalePatch]) }))).toMatchObject({ kind: "conflicts" });
  });

  it("revokes committed constraints only through an explicit user patch", () => {
    const pinned = constraintOf();
    const reset = patch({ author: "user", intent: { kind: "custom", status: "explicit" }, revokedConstraintIds: [pinned.id], operations: [{ type: "pin", operationId: "op-unpin", anchorId: "stats", pinned: false }] });
    const result = resolve(input({ activeRevision: active({ constraints: [pinned] }), explicitConstraints: [pinned], draft: draftOf([reset]) }));
    expect(placements(result).find(placement => placement.anchorId === "stats")?.pinned).toBe(false);
    const imported = patch({ author: "import", intent: { kind: "custom", status: "proposed" }, revokedConstraintIds: [pinned.id] });
    expect(placements(resolve(input({ activeRevision: active({ constraints: [pinned] }), draft: draftOf([imported]) }))).find(placement => placement.anchorId === "stats")?.pinned).toBe(true);
    const unknown = patch({ author: "user", intent: { kind: "custom", status: "explicit" }, revokedConstraintIds: ["missing"] });
    expect(resolve(input({ draft: draftOf([unknown]) }))).toMatchObject({ kind: "conflicts" });
  });

  it("does not mistake an explicit user edit for a suppressed suggestion", () => {
    const manual = patch({ author: "user", intent: { kind: "prioritize", status: "explicit", anchorId: "stats" }, operations: [{ type: "move", operationId: "op-manual", anchorId: "stats", toAreaId: "primary" }] });
    const result = resolve(input({ draft: draftOf([manual]), explicitConstraints: [constraintOf({ kind: "doNotSuggest" })] }));
    expect(placements(result).find(placement => placement.anchorId === "stats")).toMatchObject({ areaId: "primary", origin: "user" });
  });
});
