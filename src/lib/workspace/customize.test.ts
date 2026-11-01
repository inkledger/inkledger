import { describe, expect, it, vi } from "vitest";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "@contracts/workspace/catalogV1";
import { productDefaultFor } from "@contracts/workspace/catalog";
import type { Draft, ResolvedWorkspace, Scope } from "@contracts/workspace/model";
import { setSectionVisibility, type CustomizeTarget } from "./customize";

function workspaceFor(scope: Scope, revision = "default", hidden: readonly string[] = []): ResolvedWorkspace {
  return {
    scope,
    sourceActiveRevision: revision,
    catalogVersion: CATALOG_V1.catalogVersion,
    productDefaultVersion: "product-1",
    resolverVersion: CATALOG_V1.resolverVersion,
    placements: productDefaultFor(PRODUCT_DEFAULTS_V1, "dashboard").placements.map(placement => ({ ...placement, visible: placement.visible && !hidden.includes(placement.anchorId), origin: "product" as const })),
    fallbacks: [],
    discoveryAnchorIds: [],
    discoveryAreaIds: [],
    opaque: [],
  };
}

/** A scope whose server commits what it is given: the next load sees it, as a refetch would. */
function target(deviceClass: "desktop" | "mobile", status: "applied" | "deferred" | "conflict" = "applied", draft: Draft | null = null) {
  const scope: Scope = { surfaceId: "dashboard", deviceClass };
  let hidden: string[] = [];
  let revision = 0;
  const applied: Draft[] = [];
  const discarded: string[] = [];
  const value: CustomizeTarget = {
    scope,
    load: vi.fn(async () => ({ workspace: workspaceFor(scope, revision ? `rev-${revision}` : "default", hidden), draft })),
    apply: vi.fn(async (next: Draft) => {
      if (status !== "applied") return { status };
      applied.push(next);
      for (const patch of next.patches) {
        for (const operation of patch.operations) {
          if (operation.type === "visibility") hidden = operation.visible ? hidden.filter(id => id !== operation.anchorId) : [...hidden, operation.anchorId];
        }
      }
      revision++;
      return { status };
    }),
    discard: vi.fn(async (draftId: string) => { discarded.push(draftId); }),
  };
  return { value, applied, discarded, hidden: () => hidden };
}

describe("Customize on the Dashboard", () => {
  it("hides a section on desktop and phone, as the old setting did", async () => {
    const desktop = target("desktop");
    const phone = target("mobile");
    expect(await setSectionVisibility([desktop.value, phone.value], "dashboard.activity", false)).toBe("applied");
    expect(desktop.hidden()).toEqual(["dashboard.activity"]);
    expect(phone.hidden()).toEqual(["dashboard.activity"]);
  });

  it("builds two quick ticks one on top of the other, never on the same stale layout", async () => {
    const desktop = target("desktop");
    await setSectionVisibility([desktop.value], "dashboard.activity", false);
    await setSectionVisibility([desktop.value], "dashboard.summary", false);
    expect(desktop.hidden()).toEqual(["dashboard.activity", "dashboard.summary"]);
    expect(desktop.applied.map(draft => draft.baseRevision)).toEqual(["default", "rev-1"]);
  });

  it("drops a draft it could not apply, so it never blocks the next tick", async () => {
    const desktop = target("desktop", "deferred");
    expect(await setSectionVisibility([desktop.value], "dashboard.activity", false)).toBe("deferred");
    expect(desktop.discarded).toHaveLength(1);
  });

  it("changes nothing while the Studio has unapplied changes", async () => {
    const studio: Draft = { draftId: "studio", draftRevision: 1, baseRevision: "default", scope: { surfaceId: "dashboard", deviceClass: "mobile" }, patches: [], status: "ready" };
    const desktop = target("desktop");
    const phone = target("mobile", "applied", studio);
    expect(await setSectionVisibility([desktop.value, phone.value], "dashboard.activity", false)).toBe("studio-draft");
    expect(desktop.value.apply).not.toHaveBeenCalled();
  });
});
