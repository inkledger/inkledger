import type {
  AnchorDefinition,
  AreaDefinition,
  Catalog,
  Constraint,
  LayoutOperation,
  Placement,
  ResolveInput,
  ResolveResult,
  ResolvedFallback,
  ResolvedPlacement,
  Scope,
  WorkspaceConflict,
} from "./model";
import { byCodeUnit as byId } from "./canonical";
import { compareWorkspaceVersions } from "./versions";

type Resolution = {
  anchor?: AnchorDefinition;
  fallback?: { anchorId: string; reason: "replaced" | "isolated"; replacementAnchorId?: string };
  conflict?: WorkspaceConflict;
};

function resolveAnchor(catalog: Catalog, anchorId: string): Resolution {
  const direct = catalog.anchors.find(anchor => anchor.id === anchorId);
  if (direct) return { anchor: direct };
  const tombstone = catalog.tombstones.find(item => item.anchorId === anchorId);
  if (!tombstone) {
    return { conflict: { code: "unknown-anchor", anchorId, detail: `Unknown anchor ${anchorId}` } };
  }
  if (tombstone.replacementAnchorId) {
    const replacement = catalog.anchors.find(anchor => anchor.id === tombstone.replacementAnchorId);
    if (replacement) {
      return {
        anchor: replacement,
        fallback: { anchorId, reason: "replaced", replacementAnchorId: replacement.id },
      };
    }
  }
  if (tombstone.fallback === "isolate") {
    return { fallback: { anchorId, reason: "isolated" } };
  }
  return {
    conflict: { code: "unknown-anchor", anchorId, detail: `No safe migration for ${anchorId}` },
  };
}

/** What a reorder must list: exactly the area's visible anchors, so nothing is left at a guessed place. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(id => b.includes(id));
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.surfaceId === b.surfaceId && a.deviceClass === b.deviceClass;
}

export function resolve(input: ResolveInput): ResolveResult {
  const { catalog, productDefault, activeRevision, draft, explicitConstraints, feedback, discoveryState, migrations = [] } = input;
  const conflicts: WorkspaceConflict[] = [];
  const fallbacks: ResolvedFallback[] = [];
  const placements: ResolvedPlacement[] = [];
  const blockedSuggestions = new Set<string>();

  if (catalog.productDefaultVersion !== productDefault.productDefaultVersion) {
    conflicts.push({ code: "constraint-conflict", detail: "Catalog and ProductDefault versions diverge" });
  }

  if (activeRevision.opaque.length > 0 && ((draft?.patches.length ?? 0) > 0 || explicitConstraints.length > 0)) {
    conflicts.push({ code: "unknown-content-write", detail: "A document with opaque entries is read-only" });
  }

  const areaFor = (areaId: string): AreaDefinition | undefined => catalog.areas.find(area => area.id === areaId);
  const placementFor = (anchorId: string) => placements.find(placement => placement.anchorId === anchorId);

  const addPlacement = (placement: Placement, origin: ResolvedPlacement["origin"], operationId?: string) => {
    const resolved = resolveAnchor(catalog, placement.anchorId);
    if (resolved.fallback) fallbacks.push(resolved.fallback);
    if (resolved.conflict) conflicts.push(resolved.conflict);
    if (!resolved.anchor) return;
    if (placementFor(resolved.anchor.id)) {
      conflicts.push({ code: "constraint-conflict", anchorId: resolved.anchor.id, detail: `Duplicate placement for ${resolved.anchor.id}` });
      return;
    }
    placements.push({ ...placement, anchorId: resolved.anchor.id, origin, operationId });
  };

  for (const placement of productDefault.placements) addPlacement(placement, "product");

  const allows = (anchor: AnchorDefinition, operation: "move" | "reorder" | "variant" | "hide" | "pin") =>
    anchor.critical || anchor.statePolicy === "dirty" ? operation === "variant" : !anchor.studio || anchor.studio.operations.includes(operation);
  /** An area's visible anchors in their current order (orders may have gaps after moves). */
  const visibleOrder = (areaId: string) => placements
    .filter(placement => placement.areaId === areaId && placement.visible)
    .sort((a, b) => a.order - b.order || byId(a.anchorId, b.anchorId))
    .map(placement => placement.anchorId);
  /**
   * `byUser`: the user's own explicit choice (or one they accepted and committed). Only that may
   * change what is pinned; a suggestion, an import or the AI must leave it where it is (D-06).
   */
  const applyOperation = (operation: LayoutOperation, origin: ResolvedPlacement["origin"], respectSuggestionSuppression = true, byUser = true) => {
    const operationAnchorIds = operation.type === "reorder" ? operation.anchorIds : [operation.anchorId];
    const suppressed = respectSuggestionSuppression && operationAnchorIds.find(anchorId => blockedSuggestions.has(anchorId));
    if (suppressed) {
      conflicts.push({ code: "suggestion-suppressed", anchorId: suppressed, detail: `Suggestions are suppressed for ${suppressed}` });
      return;
    }
    if (operation.type === "reorder") {
      const area = areaFor(operation.areaId);
      if (!area) {
        conflicts.push({ code: "unknown-area", areaId: operation.areaId, detail: `Unknown area ${operation.areaId}` });
        return;
      }
      // Through tombstones, as every other operation: a replaced anchor is reordered as its replacement.
      const anchorIds: string[] = [];
      for (const listed of operation.anchorIds) {
        const resolved = resolveAnchor(catalog, listed);
        if (resolved.fallback) fallbacks.push(resolved.fallback);
        if (resolved.conflict) conflicts.push(resolved.conflict);
        if (resolved.anchor) anchorIds.push(resolved.anchor.id);
      }
      const current = visibleOrder(area.id);
      if (new Set(anchorIds).size === anchorIds.length && anchorIds.every(anchorId => placementFor(anchorId)?.areaId === area.id) && !sameMembers(anchorIds, current)) {
        conflicts.push({ code: "constraint-conflict", areaId: area.id, detail: `A reorder of ${area.id} must list its visible anchors exactly` });
        return;
      }
      const ids = new Set<string>();
      const moved: ResolvedPlacement[] = [];
      anchorIds.forEach((anchorId, index) => {
        if (ids.has(anchorId)) {
          conflicts.push({ code: "constraint-conflict", anchorId, areaId: area.id, detail: `Duplicate reorder entry ${anchorId}` });
          return;
        }
        ids.add(anchorId);
        const placement = placementFor(anchorId);
        const anchor = catalog.anchors.find(item => item.id === anchorId);
        if (!placement || placement.areaId !== area.id) {
          conflicts.push({ code: "incompatible-area", anchorId, areaId: area.id, detail: `${anchorId} is not in ${area.id}` });
          return;
        }
        // Critical, dirty and (for anything but the user) pinned anchors keep their index: others move around them.
        const fixed = anchor && (anchor.critical || anchor.statePolicy === "dirty" || (!byUser && placement.pinned));
        if (anchor && (fixed ? current.indexOf(anchorId) !== index : anchor.studio && !anchor.studio.operations.includes("reorder"))) {
          conflicts.push({ code: "constraint-conflict", anchorId, areaId: area.id, detail: `${anchorId} cannot be reordered` });
          return;
        }
        if (!fixed) moved.push(placement);
      });
      // Every listed anchor takes its index, the fixed ones included (it is theirs already).
      anchorIds.forEach((anchorId, index) => {
        const placement = placementFor(anchorId);
        if (placement?.areaId === area.id) placement.order = index;
      });
      for (const placement of moved) {
        placement.origin = origin;
        placement.operationId = operation.operationId;
      }
      return;
    }

    const resolved = resolveAnchor(catalog, operation.anchorId);
    if (resolved.fallback) fallbacks.push(resolved.fallback);
    if (resolved.conflict) conflicts.push(resolved.conflict);
    if (!resolved.anchor) return;
    const placement = placementFor(resolved.anchor.id);
    if (!placement) {
      conflicts.push({ code: "unknown-anchor", anchorId: resolved.anchor.id, detail: `No placement for ${resolved.anchor.id}` });
      return;
    }
    if (!allows(resolved.anchor, operation.type === "visibility" ? "hide" : operation.type)) {
      conflicts.push({ code: "constraint-conflict", anchorId: resolved.anchor.id, detail: `${operation.type} is not allowed for ${resolved.anchor.id}` });
      return;
    }
    if (!byUser && placement.pinned) {
      conflicts.push({ code: "constraint-conflict", anchorId: resolved.anchor.id, detail: `Pinned ${resolved.anchor.id} changes only by the user` });
      return;
    }

    if (operation.type === "move") {
      const area = areaFor(operation.toAreaId);
      if (resolved.anchor.statePolicy === "local" && operation.toAreaId !== placement.areaId) {
        conflicts.push({ code: "incompatible-area", anchorId: placement.anchorId, areaId: operation.toAreaId, detail: `${placement.anchorId} requires a stable parent` });
        return;
      }
      if (!area) {
        conflicts.push({ code: "unknown-area", anchorId: placement.anchorId, areaId: operation.toAreaId, detail: `Unknown area ${operation.toAreaId}` });
        return;
      }
      if (!area.allowedAnchorIds.includes(placement.anchorId)) {
        conflicts.push({ code: "incompatible-area", anchorId: placement.anchorId, areaId: area.id, detail: `${placement.anchorId} is not allowed in ${area.id}` });
        return;
      }
      placement.areaId = area.id;
      if (operation.order !== undefined) placement.order = operation.order;
    } else if (operation.type === "variant") {
      placement.variant = operation.variant;
    } else if (operation.type === "visibility") {
      placement.visible = operation.visible;
      if (!operation.visible && resolved.anchor.critical) {
        conflicts.push({ code: "critical-hidden", anchorId: resolved.anchor.id, detail: `${resolved.anchor.id} is critical` });
      }
    } else if (operation.type === "pin") {
      placement.pinned = operation.pinned;
    }
    placement.origin = origin;
    placement.operationId = operation.operationId;
  };

  for (const committed of activeRevision.operations) {
    applyOperation(committed.operation, committed.origin === "product" ? "product" : "user");
  }

  const applyConstraint = (constraint: Constraint) => {
    if (constraint.status !== "explicit") return;
    if (!sameScope(constraint.scope, activeRevision.scope)) {
      conflicts.push({ code: "constraint-conflict", anchorId: constraint.anchorId, detail: `Constraint ${constraint.id} has another scope` });
      return;
    }
    if (constraint.kind === "doNotSuggest") {
      blockedSuggestions.add(constraint.anchorId);
      return;
    }
    const resolved = resolveAnchor(catalog, constraint.anchorId);
    if (resolved.fallback) fallbacks.push(resolved.fallback);
    if (resolved.conflict) conflicts.push(resolved.conflict);
    if (!resolved.anchor) return;
    const placement = placementFor(resolved.anchor.id);
    if (!placement) {
      conflicts.push({ code: "unknown-anchor", anchorId: resolved.anchor.id, detail: `No placement for ${resolved.anchor.id}` });
      return;
    }
    if (constraint.kind === "pin" && !placement.pinned && !allows(resolved.anchor, "pin")) {
      conflicts.push({ code: "constraint-conflict", anchorId: placement.anchorId, detail: `${placement.anchorId} cannot be pinned` });
      return;
    }
    if (constraint.kind === "hide" && !allows(resolved.anchor, "hide")) {
      conflicts.push({ code: "critical-hidden", anchorId: resolved.anchor.id, detail: `${resolved.anchor.id} cannot be hidden` });
      return;
    }
    if (constraint.kind === "expectHere" && constraint.areaId && constraint.areaId !== placement.areaId && (resolved.anchor.statePolicy === "local" || !allows(resolved.anchor, "move"))) {
      conflicts.push({ code: "incompatible-area", anchorId: placement.anchorId, areaId: constraint.areaId, detail: `${placement.anchorId} cannot move to ${constraint.areaId}` });
      return;
    }
    if (constraint.kind === "pin") placement.pinned = true;
    if (constraint.kind === "hide") {
      placement.visible = false;
      if (resolved.anchor.critical) conflicts.push({ code: "critical-hidden", anchorId: resolved.anchor.id, detail: `${resolved.anchor.id} is critical` });
    }
    if (constraint.kind === "keepVisible") placement.visible = true;
    if (constraint.kind === "expectHere") {
      if (!constraint.areaId) {
        conflicts.push({ code: "constraint-conflict", anchorId: placement.anchorId, detail: `expectHere needs an area for ${placement.anchorId}` });
        return;
      }
      const area = areaFor(constraint.areaId);
      if (!area || !area.allowedAnchorIds.includes(placement.anchorId)) {
        conflicts.push({ code: "incompatible-area", anchorId: placement.anchorId, areaId: constraint.areaId, detail: `Invalid expectHere area ${constraint.areaId}` });
        return;
      }
      placement.areaId = constraint.areaId;
    }
    placement.origin = "user";
  };

  const revokedConstraintIds = new Set<string>();
  for (const patch of draft?.patches ?? []) {
    if (patch.author !== "user" || patch.intent.status !== "explicit") continue;
    for (const constraintId of patch.revokedConstraintIds ?? []) {
      const constraint = activeRevision.constraints.find(item => item.id === constraintId);
      if (!constraint || constraint.author !== "user" || constraint.status !== "explicit" || !sameScope(constraint.scope, activeRevision.scope)) {
        conflicts.push({ code: "constraint-conflict", detail: `Constraint ${constraintId} cannot be revoked` });
      } else revokedConstraintIds.add(constraintId);
    }
  }
  for (const constraint of activeRevision.constraints) if (!revokedConstraintIds.has(constraint.id)) applyConstraint(constraint);
  for (const constraint of explicitConstraints) if (!revokedConstraintIds.has(constraint.id)) applyConstraint(constraint);
  for (const patch of draft?.patches ?? []) {
    for (const constraint of patch.proposedConstraints) {
      if (constraint.status === "explicit") applyConstraint(constraint);
    }
  }

  if (draft) {
    if (!sameScope(draft.scope, activeRevision.scope)) {
      conflicts.push({ code: "constraint-conflict", detail: "Draft scope mismatch" });
    }
    if (draft.baseRevision !== activeRevision.revisionId) {
      conflicts.push({ code: "constraint-conflict", detail: "Draft base revision is stale" });
    }
    // Which patch last decided each anchor's attribute: a later suggestion may not silently override it.
    const decided = new Map<string, boolean>();
    for (const patch of draft.patches) {
      const explicitUserPatch = patch.author === "user" && patch.intent.status === "explicit";
      if (!explicitUserPatch && patch.suggestionSignature && feedback.suppressedSuggestionSignatures.includes(patch.suggestionSignature)) {
        conflicts.push({ code: "suggestion-suppressed", detail: `Suppressed suggestion ${patch.suggestionSignature}` });
        continue;
      }
      if (!sameScope(patch.scope, activeRevision.scope) || patch.catalogVersion !== catalog.catalogVersion || patch.baseRevision !== draft.baseRevision) {
        conflicts.push({ code: "constraint-conflict", detail: `Stale or cross-scope patch ${patch.patchId}` });
        continue;
      }
      for (const operation of patch.operations) {
        const canonicalId = (anchorId: string) => resolveAnchor(catalog, anchorId).anchor?.id ?? anchorId;
        const operationAnchorIds = (operation.type === "reorder" ? operation.anchorIds : [operation.anchorId]).map(canonicalId);
        const constraints = [...activeRevision.constraints, ...explicitConstraints, ...draft.patches.flatMap(item => item.proposedConstraints)].filter(constraint => constraint.status === "explicit" && !revokedConstraintIds.has(constraint.id) && operationAnchorIds.includes(canonicalId(constraint.anchorId)));
        // A pin keeps the anchor where it is and on screen; its variant stays the user's to change (D-55).
        const movesOrHides = operation.type === "move" || operation.type === "reorder" || (operation.type === "visibility" && !operation.visible) || (operation.type === "pin" && !operation.pinned);
        // A reorder may list pinned anchors, as long as each of them keeps its index.
        const pinnedAnchorId = movesOrHides ? operationAnchorIds.find(anchorId => constraints.some(constraint => canonicalId(constraint.anchorId) === anchorId && constraint.kind === "pin")
          && !(operation.type === "reorder" && visibleOrder(operation.areaId).indexOf(anchorId) === operationAnchorIds.indexOf(anchorId))) : undefined;
        if (pinnedAnchorId) {
          conflicts.push({ code: "constraint-conflict", anchorId: pinnedAnchorId, detail: `Pinned anchor ${pinnedAnchorId} cannot be changed` });
          continue;
        }
        const attribute = operation.type === "reorder" || operation.type === "move" ? "place" : operation.type;
        const keys = operationAnchorIds.map(anchorId => `${anchorId}:${attribute}`);
        const overridden = keys.find(key => decided.has(key));
        if (overridden && !explicitUserPatch) {
          conflicts.push({ code: "constraint-conflict", anchorId: overridden.split(":")[0], detail: `Two changes to ${overridden} in one draft` });
          continue;
        }
        for (const key of keys) decided.set(key, explicitUserPatch);
        const anchorId = operationAnchorIds[0];
        if (constraints.some(constraint => constraint.kind === "keepVisible") && operation.type === "visibility" && !operation.visible) {
          conflicts.push({ code: "constraint-conflict", anchorId, detail: `${anchorId} must stay visible` });
          continue;
        }
        if (constraints.some(constraint => constraint.kind === "hide") && operation.type === "visibility" && operation.visible) {
          conflicts.push({ code: "constraint-conflict", anchorId, detail: `${anchorId} is explicitly hidden` });
          continue;
        }
        const expectation = constraints.find(constraint => constraint.kind === "expectHere");
        if (expectation && ((operation.type === "move" && operation.toAreaId !== expectation.areaId) || (operation.type === "reorder" && operation.areaId !== expectation.areaId))) {
          conflicts.push({ code: "constraint-conflict", anchorId: expectation.anchorId, areaId: expectation.areaId, detail: `${expectation.anchorId} must remain in ${expectation.areaId}` });
          continue;
        }
        applyOperation(operation, "user", !explicitUserPatch, explicitUserPatch);
      }
    }
  }

  const migrationByAnchor = new Map(migrations.filter(migration => migration.toCatalogVersion === catalog.catalogVersion).map(migration => [migration.anchorId, migration] as const));
  const usedMigrations = new Set<string>();
  const migrate = (placement: ResolvedPlacement): boolean => {
    if (placement.origin === "user" || usedMigrations.has(placement.anchorId)) return false;
    const migration = migrationByAnchor.get(placement.anchorId);
    if (!migration) return false;
    const fromAreaId = placement.areaId;
    const fallback = migration.fallback;
    if (fallback.type === "move") {
      const target = areaFor(fallback.toAreaId);
      const targetUsed = placements.filter(item => item.areaId === fallback.toAreaId && item.visible && item !== placement).length;
      if (!target || target.id === fromAreaId || !target.allowedAnchorIds.includes(placement.anchorId) || (placement.visible && targetUsed >= target.capacity)) return false;
      placement.areaId = target.id;
      placement.origin = "fallback";
      fallbacks.push({ anchorId: placement.anchorId, reason: "migrated", migrationId: migration.id, fromAreaId, toAreaId: target.id });
    } else {
      const index = placements.indexOf(placement);
      if (index < 0) return false;
      placements.splice(index, 1);
      fallbacks.push({ anchorId: placement.anchorId, reason: "isolated", migrationId: migration.id, fromAreaId });
    }
    usedMigrations.add(placement.anchorId);
    return true;
  };

  for (const placement of [...placements]) {
    const area = areaFor(placement.areaId);
    if ((!area || !area.allowedAnchorIds.includes(placement.anchorId)) && placement.origin !== "user") migrate(placement);
  }
  for (let pass = 0; pass < placements.length; pass++) {
    let changed = false;
    for (const area of catalog.areas) {
      let used = placements.filter(placement => placement.areaId === area.id && placement.visible).length;
      if (used <= area.capacity) continue;
      const candidates = placements.filter(placement => placement.areaId === area.id && placement.visible && placement.origin !== "user").sort((a, b) => b.order - a.order || byId(b.anchorId, a.anchorId));
      for (const candidate of candidates) {
        if (used <= area.capacity) break;
        if (migrate(candidate)) {
          used--;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  for (const placement of placements) {
    const area = areaFor(placement.areaId);
    if (!area) {
      conflicts.push({ code: "unknown-area", anchorId: placement.anchorId, areaId: placement.areaId, detail: `Unknown area ${placement.areaId}` });
      continue;
    }
    if (!area.allowedAnchorIds.includes(placement.anchorId)) {
      conflicts.push({ code: "incompatible-area", anchorId: placement.anchorId, areaId: area.id, detail: `${placement.anchorId} is not allowed in ${area.id}` });
    }
    const anchor = catalog.anchors.find(item => item.id === placement.anchorId);
    if (anchor?.critical && !placement.visible) {
      conflicts.push({ code: "critical-hidden", anchorId: anchor.id, detail: `${anchor.id} is critical` });
    }
  }

  for (const area of catalog.areas) {
    const used = placements.filter(placement => placement.areaId === area.id && placement.visible).length;
    if (used > area.capacity) {
      conflicts.push({ code: "area-capacity", areaId: area.id, detail: `${area.id} has ${used} visible anchors, capacity ${area.capacity}` });
    }
  }

  const discoveryAnchorIds = catalog.anchors
    .filter(anchor => {
      if (anchor.surfaceId !== activeRevision.scope.surfaceId || discoveryState.dismissedAnchorIds.includes(anchor.id) || discoveryState.placedAnchorIds.includes(anchor.id)) return false;
      const comparison = compareWorkspaceVersions(anchor.introducedIn, activeRevision.catalogVersion);
      if (comparison === null) {
        conflicts.push({ code: "constraint-conflict", anchorId: anchor.id, detail: `Cannot compare catalog versions ${anchor.introducedIn} and ${activeRevision.catalogVersion}` });
        return false;
      }
      return comparison > 0;
    })
    .map(anchor => anchor.id)
    .sort();
  const discoveryAreaIds = catalog.areas
    .filter(area => {
      if ((area.surfaceId && area.surfaceId !== activeRevision.scope.surfaceId) || (discoveryState.dismissedAreaIds ?? []).includes(area.id) || (discoveryState.placedAreaIds ?? []).includes(area.id)) return false;
      const comparison = compareWorkspaceVersions(area.introducedIn ?? activeRevision.catalogVersion, activeRevision.catalogVersion);
      if (comparison === null) {
        conflicts.push({ code: "constraint-conflict", areaId: area.id, detail: `Cannot compare catalog versions ${area.introducedIn} and ${activeRevision.catalogVersion}` });
        return false;
      }
      return comparison > 0;
    })
    .map(area => area.id)
    .sort();

  if (conflicts.length > 0) {
    const unique = new Map<string, WorkspaceConflict>();
    for (const conflict of conflicts) {
      const key = `${conflict.code}:${conflict.anchorId ?? ""}:${conflict.areaId ?? ""}:${conflict.detail}`;
      unique.set(key, conflict);
    }
    return {
      kind: "conflicts",
      conflicts: [...unique.values()].sort((a, b) => byId(`${a.code}:${a.anchorId ?? ""}:${a.areaId ?? ""}`, `${b.code}:${b.anchorId ?? ""}:${b.areaId ?? ""}`)),
    };
  }

  const ordered = placements
    .map(placement => ({ ...placement }))
    .sort((a, b) => byId(a.areaId, b.areaId) || a.order - b.order || byId(a.anchorId, b.anchorId));
  let previousArea = "";
  let order = 0;
  for (const placement of ordered) {
    if (placement.areaId !== previousArea) {
      previousArea = placement.areaId;
      order = 0;
    }
    placement.order = order++;
  }

  const uniqueFallbacks = new Map(fallbacks.map(fallback => [`${fallback.anchorId}:${fallback.reason}`, fallback] as const));

  return {
    kind: "resolved",
    workspace: {
      scope: activeRevision.scope,
      sourceActiveRevision: activeRevision.revisionId,
      catalogVersion: catalog.catalogVersion,
      productDefaultVersion: productDefault.productDefaultVersion,
      resolverVersion: catalog.resolverVersion,
      placements: ordered,
      fallbacks: [...uniqueFallbacks.values()].sort((a, b) => byId(a.anchorId, b.anchorId)),
      discoveryAnchorIds,
      discoveryAreaIds,
      opaque: activeRevision.opaque,
    },
  };
}
