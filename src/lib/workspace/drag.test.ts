import { describe, expect, it } from "vitest";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import type { Constraint } from "@contracts/workspace/model";
import { assessWorkspaceDrop } from "./drag";

const anchors = new Map(CATALOG_V1.anchors.map(anchor => [anchor.id, anchor]));
const areas = new Map(CATALOG_V1.areas.map(area => [area.id, area]));
const activity = anchors.get("dashboard.activity")!;
const quickActions = anchors.get("dashboard.quickActions")!;
const scope = { surfaceId: "dashboard", deviceClass: "desktop" } as const;

function pinConstraint(): Constraint {
  return { id: "pin-activity", kind: "pin", status: "explicit", author: "user", scope, anchorId: activity.id };
}

describe("workspace drop assessment", () => {
  it("allows compatible moves and rejects incompatible areas, capacity and constraints", () => {
    expect(assessWorkspaceDrop({ anchor: activity, sourceAreaId: "dashboard.primary", targetArea: areas.get("dashboard.secondary")!, visible: true, targetVisibleCount: 1, constraints: [] })).toEqual({ allowed: true, operation: "move" });
    expect(assessWorkspaceDrop({ anchor: activity, sourceAreaId: "dashboard.primary", targetArea: areas.get("dashboard.header")!, visible: true, targetVisibleCount: 0, constraints: [] })).toEqual({ allowed: false, reason: "incompatible" });
    expect(assessWorkspaceDrop({ anchor: activity, sourceAreaId: "dashboard.primary", targetArea: areas.get("dashboard.secondary")!, visible: true, targetVisibleCount: 2, constraints: [] })).toEqual({ allowed: false, reason: "capacity" });
    expect(assessWorkspaceDrop({ anchor: activity, sourceAreaId: "dashboard.primary", targetArea: areas.get("dashboard.secondary")!, visible: true, targetVisibleCount: 1, constraints: [pinConstraint()] })).toEqual({ allowed: false, reason: "constraint" });
  });

  it("rejects movement of stateful anchors and reorder that displaces a fixed anchor", () => {
    const dirty = anchors.get("dashboard.quick-log")!;
    expect(assessWorkspaceDrop({ anchor: dirty, sourceAreaId: "dashboard.overlays", targetArea: areas.get("dashboard.overlays")!, visible: true, targetVisibleCount: 0, constraints: [] })).toEqual({ allowed: false, reason: "state" });
    const timer = { ...activity, id: "fixed-timer", critical: true, statePolicy: "critical" as const };
    const fixedAnchors = new Map(anchors);
    fixedAnchors.set(timer.id, timer);
    const placements = [
      { anchorId: quickActions.id, areaId: "dashboard.header", order: 0 },
      { anchorId: timer.id, areaId: "dashboard.header", order: 1 },
      { anchorId: "dashboard.customize", areaId: "dashboard.header", order: 2 },
    ];
    const base = { anchor: quickActions, sourceAreaId: "dashboard.header", targetArea: areas.get("dashboard.header")!, visible: true, targetVisibleCount: 3, constraints: [], placements, anchorsById: fixedAnchors };
    expect(assessWorkspaceDrop({ ...base, orderedAnchorIds: ["dashboard.customize", timer.id, quickActions.id] })).toEqual({ allowed: true, operation: "reorder" });
    expect(assessWorkspaceDrop({ ...base, orderedAnchorIds: [timer.id, quickActions.id, "dashboard.customize"] })).toEqual({ allowed: false, reason: "state" });
  });
});
