import type { ProductDefault, ProductMigration } from "./model";
import type { CatalogDiff, CatalogManifest, ControlInteraction, ScopeDefaults, SurfaceDefinition } from "./catalogTypes";
import { compareWorkspaceVersions, isWorkspaceVersion } from "./versions";

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function sortedIds<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const ids = items.map(idOf);
  const duplicate = duplicates(ids)[0];
  if (duplicate) throw new Error(`workspace catalog: duplicate id ${duplicate}`);
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const left = idOf(a.item);
    const right = idOf(b.item);
    return left < right ? -1 : left > right ? 1 : a.index - b.index;
  }).map(({ item }) => item);
}

export function assertCatalogManifest(manifest: CatalogManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("workspace catalog: unsupported schema");
  if (!isWorkspaceVersion(manifest.catalogVersion)) throw new Error("workspace catalog: invalid catalog version");
  sortedIds(manifest.surfaces, surface => surface.id);
  sortedIds(manifest.areas, area => area.id);
  sortedIds(manifest.anchors, anchor => anchor.id);
  sortedIds(manifest.controls, control => control.id);
  sortedIds(manifest.rendererBindings, binding => binding.anchorId);
  sortedIds(manifest.tombstones, tombstone => tombstone.anchorId);

  const surfaces = new Set(manifest.surfaces.map(surface => surface.id));
  const anchors = new Map(manifest.anchors.map(anchor => [anchor.id, anchor] as const));
  const bindings = new Map(manifest.rendererBindings.map(binding => [binding.anchorId, binding] as const));
  const eventIds = manifest.controls.flatMap(control => control.interactions.map(interaction => interaction.eventId));
  if (duplicates(eventIds).length > 0) throw new Error("workspace catalog: duplicate event id");

  for (const area of manifest.areas) {
    if (!surfaces.has(area.surfaceId)) throw new Error(`workspace catalog: unknown surface ${area.surfaceId}`);
    if (!isWorkspaceVersion(area.introducedIn)) throw new Error(`workspace catalog: invalid introduced version for ${area.id}`);
    if (compareWorkspaceVersions(area.introducedIn, manifest.catalogVersion) === 1) throw new Error(`workspace catalog: ${area.id} introduced after catalog version`);
    for (const anchorId of area.allowedAnchorIds) {
      if (!anchors.has(anchorId)) throw new Error(`workspace catalog: ${area.id} allows unknown anchor ${anchorId}`);
    }
  }
  for (const anchor of anchors.values()) {
    if (!surfaces.has(anchor.surfaceId)) throw new Error(`workspace catalog: unknown surface ${anchor.surfaceId}`);
    if (!isWorkspaceVersion(anchor.introducedIn)) throw new Error(`workspace catalog: invalid introduced version for ${anchor.id}`);
    if (compareWorkspaceVersions(anchor.introducedIn, manifest.catalogVersion) === 1) throw new Error(`workspace catalog: ${anchor.id} introduced after catalog version`);
    if (anchor.semanticRevision < 1) throw new Error(`workspace catalog: invalid semantic revision for ${anchor.id}`);
    if (anchor.studio.variants.length === 0) throw new Error(`workspace catalog: no variants for ${anchor.id}`);
    if (anchor.critical && anchor.studio.operations.includes("hide")) throw new Error(`workspace catalog: critical anchor ${anchor.id} can be hidden`);
    if ((anchor.statePolicy === "dirty" || anchor.statePolicy === "critical") && (anchor.studio.operations.includes("move") || anchor.studio.operations.includes("reorder"))) {
      throw new Error(`workspace catalog: stateful anchor ${anchor.id} can move between parents`);
    }
    if (bindings.get(anchor.id)?.renderer !== anchor.renderer) throw new Error(`workspace catalog: renderer binding mismatch for ${anchor.id}`);
    if (!anchor.accessibility.labelKey) throw new Error(`workspace catalog: missing accessible name for ${anchor.id}`);
  }
  for (const control of manifest.controls) {
    const anchor = anchors.get(control.anchorId);
    if (!anchor) throw new Error(`workspace catalog: unknown anchor ${control.anchorId}`);
    if (!isWorkspaceVersion(control.introducedIn)) throw new Error(`workspace catalog: invalid introduced version for ${control.id}`);
    if (compareWorkspaceVersions(control.introducedIn, manifest.catalogVersion) === 1) throw new Error(`workspace catalog: ${control.id} introduced after catalog version`);
    if (control.semanticRevision < 1) throw new Error(`workspace catalog: invalid semantic revision for ${control.id}`);
    if (!control.accessibility.labelKey) throw new Error(`workspace catalog: missing accessible name for ${control.id}`);
    // A critical control (pause, stop…) makes its anchor critical: it cannot be hidden or moved away (C-01).
    if (control.critical && !anchor.critical) throw new Error(`workspace catalog: ${control.anchorId} holds critical ${control.id} but is not critical`);
    if (control.sensitive && control.interactions.some(interaction => interaction.telemetry === "allowed")) {
      throw new Error(`workspace catalog: sensitive control ${control.id} allows telemetry`);
    }
    if (control.critical && control.interactions.length === 0) throw new Error(`workspace catalog: critical control ${control.id} has no outcome`);
  }
  for (const tombstone of manifest.tombstones) {
    if (anchors.has(tombstone.anchorId)) throw new Error(`workspace catalog: ${tombstone.anchorId} is both live and tombstoned`);
    if (tombstone.replacementAnchorId && !anchors.has(tombstone.replacementAnchorId)) {
      throw new Error(`workspace catalog: unknown replacement ${tombstone.replacementAnchorId}`);
    }
  }
}

/** A checked manifest in its canonical order (tests, tools): the check, then the ordering. */
export function buildCatalogManifest(input: CatalogManifest): CatalogManifest {
  assertCatalogManifest(input);
  return orderCatalogManifest(input);
}

/**
 * The canonical order alone. The shipped catalogue uses this: its checks run in the tests and when
 * the server starts (api/workspace/service.ts), never again in every browser that loads the app.
 */
export function orderCatalogManifest(input: CatalogManifest): CatalogManifest {
  return {
    ...input,
    surfaces: sortedIds(input.surfaces, surface => surface.id),
    areas: sortedIds(input.areas, area => area.id).map(area => ({ ...area, allowedAnchorIds: sortedIds(area.allowedAnchorIds, id => id) })),
    anchors: sortedIds(input.anchors, anchor => anchor.id),
    controls: sortedIds(input.controls, control => control.id).map(control => ({
      ...control,
      interactions: sortedIds(control.interactions, interaction => interaction.eventId),
    })),
    rendererBindings: sortedIds(input.rendererBindings, binding => binding.anchorId),
    tombstones: sortedIds(input.tombstones, tombstone => tombstone.anchorId),
  };
}

export function eventAllowlist(manifest: CatalogManifest): readonly ControlInteraction[] {
  return manifest.controls
    .flatMap(control => control.interactions)
    .filter(interaction => interaction.telemetry === "allowed")
    .sort((a, b) => a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
}

export function scopeFor(manifest: CatalogManifest, surfaceId: SurfaceDefinition["id"], deviceClass: SurfaceDefinition["deviceClasses"][number]) {
  const surface = manifest.surfaces.find(item => item.id === surfaceId);
  if (!surface || !surface.deviceClasses.includes(deviceClass)) throw new Error(`workspace catalog: unsupported scope ${surfaceId}/${deviceClass}`);
  return { surfaceId, deviceClass } as const;
}

export function assertProductDefaults(manifest: CatalogManifest, defaults: ScopeDefaults, migrations: readonly ProductMigration[] = []): void {
  const areas = new Map(manifest.areas.map(area => [area.id, area] as const));
  const anchors = new Map(manifest.anchors.map(anchor => [anchor.id, anchor] as const));
  const used = new Map<string, number>();
  const placed = new Set<string>();
  for (const [surfaceId, productDefault] of Object.entries(defaults)) {
    if (!productDefault) continue;
    if (productDefault.productDefaultVersion !== manifest.productDefaultVersion) throw new Error("workspace catalog: ProductDefault version mismatch");
    for (const placement of productDefault.placements) {
      const key = `${surfaceId}:${placement.anchorId}`;
      if (placed.has(key)) throw new Error(`workspace catalog: duplicate placement ${key}`);
      placed.add(key);
      const anchor = anchors.get(placement.anchorId);
      if (!anchor || anchor.surfaceId !== surfaceId) throw new Error(`workspace catalog: placement on wrong surface ${placement.anchorId}`);
      const fallback = migrations.find(migration => migration.anchorId === placement.anchorId)?.fallback;
      if (fallback?.type === "isolate") continue;
      const areaId = fallback?.type === "move" ? fallback.toAreaId : placement.areaId;
      const area = areas.get(areaId);
      if (!area || area.surfaceId !== surfaceId || !area.allowedAnchorIds.includes(placement.anchorId)) {
        throw new Error(`workspace catalog: incompatible placement ${placement.anchorId}/${areaId}`);
      }
      if (placement.visible) used.set(area.id, (used.get(area.id) ?? 0) + 1);
    }
  }
  for (const [areaId, count] of used) {
    const area = areas.get(areaId);
    if (area && count > area.capacity) throw new Error(`workspace catalog: area ${areaId} exceeds capacity`);
  }
}

export function productDefaultFor(defaults: ScopeDefaults, surfaceId: SurfaceDefinition["id"]): ProductDefault {
  const productDefault = defaults[surfaceId];
  if (!productDefault) throw new Error(`workspace catalog: no ProductDefault for ${surfaceId}`);
  return productDefault;
}

export function assertProductMigrations(previous: CatalogManifest, current: CatalogManifest, migrations: readonly ProductMigration[]): void {
  if (duplicates(migrations.map(migration => migration.id)).length > 0 || duplicates(migrations.map(migration => migration.anchorId)).length > 0) throw new Error("workspace catalog: duplicate product migration");
  for (const migration of migrations) {
    if (!migration.id || migration.fromCatalogVersion !== previous.catalogVersion || migration.toCatalogVersion !== current.catalogVersion) throw new Error(`workspace catalog: invalid migration boundary ${migration.id}`);
    if (!current.anchors.some(anchor => anchor.id === migration.anchorId)) throw new Error(`workspace catalog: unknown migration anchor ${migration.anchorId}`);
    const fallback = migration.fallback;
    if (fallback.type === "move") {
      const area = current.areas.find(item => item.id === fallback.toAreaId);
      if (!area || !area.allowedAnchorIds.includes(migration.anchorId)) throw new Error(`workspace catalog: incompatible migration area ${fallback.toAreaId}`);
    }
  }
}

export function diffCatalogs(previous: CatalogManifest, current: CatalogManifest): CatalogDiff {
  const addedAreaIds = current.areas.filter(area => !previous.areas.some(old => old.id === area.id)).map(area => area.id);
  const removedAreaIds = previous.areas.filter(area => !current.areas.some(next => next.id === area.id)).map(area => area.id);
  const addedAnchorIds = current.anchors.filter(anchor => !previous.anchors.some(old => old.id === anchor.id)).map(anchor => anchor.id);
  const removedAnchorIds = previous.anchors.filter(anchor => !current.anchors.some(next => next.id === anchor.id)).map(anchor => anchor.id);
  const semanticAnchorIds = current.anchors.filter(anchor => {
    const old = previous.anchors.find(item => item.id === anchor.id);
    return old && old.semanticRevision !== anchor.semanticRevision;
  }).map(anchor => anchor.id);
  const addedControlIds = current.controls.filter(control => !previous.controls.some(old => old.id === control.id)).map(control => control.id);
  const removedControlIds = previous.controls.filter(control => !current.controls.some(next => next.id === control.id)).map(control => control.id);
  const semanticControlIds = current.controls.filter(control => {
    const old = previous.controls.find(item => item.id === control.id);
    return old && old.semanticRevision !== control.semanticRevision;
  }).map(control => control.id);
  return {
    addedAreaIds,
    removedAreaIds,
    addedAnchorIds,
    removedAnchorIds,
    semanticAnchorIds,
    addedControlIds,
    removedControlIds,
    semanticControlIds,
    productDefaultChanged: previous.productDefaultVersion !== current.productDefaultVersion,
  };
}
