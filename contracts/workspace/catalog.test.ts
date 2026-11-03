import { describe, expect, it } from "vitest";
import { SURFACES } from "../../src/components/app/surface";
import {
  assertCatalogManifest,
  assertProductDefaults,
  assertProductMigrations,
  buildCatalogManifest,
  diffCatalogs,
  eventAllowlist,
  productDefaultFor,
  scopeFor,
} from "./catalog";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "./catalogV1";
import type { CatalogManifest } from "./catalogTypes";
import { assertCriticalStatePolicies, statePolicyFor } from "./statePolicies";

const dashboardAnchorIds = ["dashboard.timeline", "dashboard.stats", "dashboard.summary", "dashboard.tasks", "dashboard.activity", "dashboard.recap", "dashboard.desk", "dashboard.period", "dashboard.headerTimer", "dashboard.quickActions", "dashboard.customize", "dashboard.quick-log", "dashboard.planned-dialog", "dashboard.gap-cutter"];
const shellAnchorIds = ["shell.navigation", "shell.search", "shell.notifications", "shell.pinboard", "shell.todos", "shell.theme", "shell.screensaver", "shell.timer.active", "shell.quick-start", "shell.sync", "shell.account", "shell.sidebar"];
const mobileAnchorIds = ["mobile.home", "mobile.board", "mobile.issues", "mobile.timer.active", "mobile.more", "mobile.todos", "mobile.notifications", "mobile.dock"];

describe("workspace UI catalog", () => {
  it("covers the existing Dashboard, desktop shell and mobile anchors with stable ids", () => {
    const ids = CATALOG_V1.anchors.map(anchor => anchor.id);
    for (const required of [...dashboardAnchorIds, ...shellAnchorIds, ...mobileAnchorIds]) expect(ids).toContain(required);
    for (const anchor of CATALOG_V1.anchors) {
      expect(anchor.semanticRevision).toBeGreaterThan(0);
      expect(anchor.studio.variants.length).toBeGreaterThan(0);
      expect(anchor.accessibility.labelKey).not.toBe("");
    }
    expect(CATALOG_V1.surfaces.map(surface => surface.id)).toEqual(["board", "dashboard", "desk", "issues", "mobile-tabs", "reports", "shell-desktop", "team", "timesheet"]);
    expect(Object.keys(SURFACES).some(kind => CATALOG_V1.areas.some(area => area.id === kind))).toBe(false);
  });

  it("observes the other pages as they are: every block shown by default, none movable, hideable or resizable", () => {
    const observed = ["board", "desk", "issues", "reports", "team", "timesheet"] as const;
    for (const surfaceId of observed) {
      const anchors = CATALOG_V1.anchors.filter(anchor => anchor.surfaceId === surfaceId);
      expect(anchors.length, surfaceId).toBeGreaterThan(0);
      for (const anchor of anchors) {
        expect(anchor.studio.operations, anchor.id).toEqual([]);
        expect(anchor.studio.variants.length, anchor.id).toBeGreaterThan(0);
      }
      const defaults = productDefaultFor(PRODUCT_DEFAULTS_V1, surfaceId);
      expect(defaults.placements.map(placement => placement.anchorId).sort()).toEqual(anchors.map(anchor => anchor.id).sort());
      expect(defaults.placements.every(placement => placement.visible)).toBe(true);
      expect(CATALOG_V1.surfaces.find(surface => surface.id === surfaceId)?.deviceClasses).toEqual(["desktop", "mobile"]);
    }
  });

  it("keeps every default placement compatible and every critical state policy explicit", () => {
    expect(() => assertProductDefaults(CATALOG_V1, PRODUCT_DEFAULTS_V1)).not.toThrow();
    expect(() => assertCriticalStatePolicies()).not.toThrow();
    for (const anchor of CATALOG_V1.anchors) {
      if (anchor.critical || anchor.statePolicy === "dirty" || anchor.statePolicy === "critical") {
        expect(anchor.studio.operations).not.toContain("move");
      }
      if (anchor.id in { "dashboard.timeline": 1, "dashboard.quick-log": 1, "shell.timer.active": 1, "mobile.timer.active": 1 }) {
        expect(statePolicyFor(anchor.id)).toBe(anchor.statePolicy);
      }
    }
    expect(productDefaultFor(PRODUCT_DEFAULTS_V1, "dashboard").placements.some(placement => placement.anchorId === "dashboard.timeline")).toBe(true);
    expect(scopeFor(CATALOG_V1, "dashboard", "desktop")).toEqual({ surfaceId: "dashboard", deviceClass: "desktop" });
    expect(() => scopeFor(CATALOG_V1, "shell-desktop", "mobile")).toThrow("unsupported scope");
  });

  it("derives telemetry only from allowlisted, non-sensitive interactions", () => {
    const ids = eventAllowlist(CATALOG_V1).map(interaction => interaction.eventId);
    expect(ids).toContain("dashboard.logTime.succeed");
    expect(ids).toContain("shell.nav.home.navigate");
    expect(ids).not.toContain("dashboard.quickLog.input.activate");
    expect(ids).not.toContain("dashboard.desk.module.activate");
    expect(ids).not.toContain("mobile.dock.module.activate");
    expect(ids).not.toContain("dashboard.planned.input.activate");
    expect(new Set(ids).size).toBe(ids.length);
    for (const control of CATALOG_V1.controls) {
      if (control.sensitive) expect(control.interactions.every(interaction => interaction.telemetry === "disabled")).toBe(true);
    }
  });

  it("is canonical and rejects duplicate ids, unsafe metadata and renderer mismatches", () => {
    expect(() => assertCatalogManifest(CATALOG_V1)).not.toThrow();
    expect(CATALOG_V1.areas.map(area => area.id)).toEqual([...CATALOG_V1.areas.map(area => area.id)].sort());
    const duplicate = { ...CATALOG_V1, anchors: [...CATALOG_V1.anchors, CATALOG_V1.anchors[0]] } as CatalogManifest;
    expect(() => buildCatalogManifest(duplicate)).toThrow("duplicate id");
    const sensitive = {
      ...CATALOG_V1,
      controls: CATALOG_V1.controls.map(control => control.id === "dashboard.quickLog.input"
        ? { ...control, interactions: control.interactions.map(interaction => ({ ...interaction, telemetry: "allowed" as const })) }
        : control),
    } as CatalogManifest;
    expect(() => buildCatalogManifest(sensitive)).toThrow("sensitive control");
    const criticalHide = {
      ...CATALOG_V1,
      anchors: CATALOG_V1.anchors.map(anchor => anchor.critical ? { ...anchor, studio: { ...anchor.studio, operations: [...anchor.studio.operations, "hide" as const] } } : anchor),
    } as CatalogManifest;
    expect(() => buildCatalogManifest(criticalHide)).toThrow("critical anchor");
    const wrongRenderer = {
      ...CATALOG_V1,
      rendererBindings: CATALOG_V1.rendererBindings.map(binding => binding.anchorId === "dashboard.timeline" ? { ...binding, renderer: "Wrong" } : binding),
    } as CatalogManifest;
    expect(() => buildCatalogManifest(wrongRenderer)).toThrow("renderer binding mismatch");
  });

  it("rejects ambiguous release versions and features introduced after their manifest", () => {
    expect(() => buildCatalogManifest({ ...CATALOG_V1, catalogVersion: "1.0" })).toThrow("catalog version");
    const futureAnchor = { ...CATALOG_V1, anchors: CATALOG_V1.anchors.map(anchor => anchor.id === "dashboard.recap" ? { ...anchor, introducedIn: "1.0.1" } : anchor) };
    expect(() => buildCatalogManifest(futureAnchor)).toThrow("introduced after catalog version");
    const futureControl = { ...CATALOG_V1, controls: CATALOG_V1.controls.map(control => control.id === "dashboard.logTime" ? { ...control, introducedIn: "1.0.1" } : control) };
    expect(() => buildCatalogManifest(futureControl)).toThrow("introduced after catalog version");
  });

  it("reports additions, removals, semantic changes and release defaults without AI", () => {
    const oldAnchor = CATALOG_V1.anchors.find(anchor => anchor.id === "dashboard.recap")!;
    const addedAnchor = { ...oldAnchor, id: "dashboard.new", renderer: "NewFeature", introducedIn: "2.0.0", semanticRevision: 2 };
    const oldControl = CATALOG_V1.controls.find(control => control.id === "dashboard.logTime")!;
    const addedControl = {
      ...oldControl,
      id: "dashboard.new.action",
      anchorId: addedAnchor.id,
      introducedIn: "2.0.0",
      interactions: oldControl.interactions.map(interaction => ({ ...interaction, eventId: interaction.eventId.replace("dashboard.logTime", "dashboard.new.action") })),
    };
    const next: CatalogManifest = {
      ...CATALOG_V1,
      catalogVersion: "2.0.0",
      productDefaultVersion: "product-2",
      areas: [
        ...CATALOG_V1.areas.map(area => ({ ...area, allowedAnchorIds: area.allowedAnchorIds.filter(anchorId => anchorId !== oldAnchor.id) })),
        { id: "dashboard.new-area", surfaceId: "dashboard", role: "primary", capacity: 1, allowedAnchorIds: [addedAnchor.id], introducedIn: "2.0.0" },
      ],
      anchors: [...CATALOG_V1.anchors.filter(anchor => anchor.id !== oldAnchor.id), addedAnchor],
      controls: [
        ...CATALOG_V1.controls.filter(control => control.id !== "dashboard.closeDay" && control.id !== oldControl.id),
        addedControl,
        { ...oldControl, semanticRevision: 2 },
      ],
      rendererBindings: [...CATALOG_V1.rendererBindings, { anchorId: addedAnchor.id, kind: "core", renderer: addedAnchor.renderer }],
      tombstones: [{ anchorId: oldAnchor.id, replacementAnchorId: addedAnchor.id, fallback: "conflict" }],
    };
    const migration = { id: "release-new-anchor", fromCatalogVersion: "1.0.0", toCatalogVersion: "2.0.0", anchorId: addedAnchor.id, fallback: { type: "move" as const, toAreaId: "dashboard.new-area" } };
    expect(() => assertProductMigrations(CATALOG_V1, next, [migration])).not.toThrow();
    expect(() => assertProductMigrations(CATALOG_V1, next, [{ ...migration, fallback: { type: "move" as const, toAreaId: "dashboard.header" } }])).toThrow("incompatible migration area");
    const migratedDefaults = { dashboard: { productDefaultVersion: "product-2", placements: [{ anchorId: addedAnchor.id, areaId: "dashboard.retired", order: 0, visible: true, variant: "default" as const, pinned: false }] } };
    expect(() => assertProductDefaults(next, migratedDefaults, [migration])).not.toThrow();
    const diff = diffCatalogs(CATALOG_V1, buildCatalogManifest(next));
    expect(diff.addedAreaIds).toEqual(["dashboard.new-area"]);
    expect(diff.addedAnchorIds).toEqual([addedAnchor.id]);
    expect(diff.removedAnchorIds).toEqual([oldAnchor.id]);
    expect(diff.addedControlIds).toEqual([addedControl.id]);
    expect(diff.removedControlIds).toEqual(["dashboard.closeDay"]);
    expect(diff.semanticControlIds).toEqual([oldControl.id]);
    expect(diff.productDefaultChanged).toBe(true);
  });

  it("makes every anchor that holds a critical control critical, so nothing can hide pause or stop (C-01)", () => {
    for (const control of CATALOG_V1.controls.filter(item => item.critical)) {
      expect(CATALOG_V1.anchors.find(anchor => anchor.id === control.anchorId)?.critical, control.id).toBe(true);
    }
    const loosened: CatalogManifest = { ...CATALOG_V1, anchors: CATALOG_V1.anchors.map(anchor => anchor.id === "dashboard.headerTimer" ? { ...anchor, critical: false } : anchor) };
    expect(() => assertCatalogManifest(loosened)).toThrow(/critical/);
  });
});

