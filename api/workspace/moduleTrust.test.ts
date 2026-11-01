import { describe, expect, it } from "vitest";
import type { ModuleListEntry } from "@contracts/modules";
import { bindingForModule } from "./moduleTrust";

const active: ModuleListEntry = {
  id: "shadow",
  version: "1.0.0",
  product: "inkledger.shadow",
  name: { en: "Shadow", it: "Shadow" },
  slots: ["dashboard-widget", "dashboard-overlay"],
  status: { state: "active" },
  entryUrl: "/api/modules/shadow/deadbeef/entry.mjs",
  integrity: "sha256-c2hh",
  build: "a".repeat(32),
};

describe("verified add-on renderer bindings", () => {
  it("binds only an active verified module to a declared slot", () => {
    expect(bindingForModule(active, "dashboard-widget")).toEqual({
      moduleId: "shadow",
      slot: "dashboard-widget",
      entryUrl: active.entryUrl,
      integrity: active.integrity,
      build: active.build,
    });
  });

  it("rejects inactive, undeclared or unverifiable bindings without new trust roots", () => {
    expect(bindingForModule(active, "settings")).toBeNull();
    expect(bindingForModule({ ...active, status: { state: "needs-license" } }, "dashboard-widget")).toBeNull();
    expect(bindingForModule({ ...active, integrity: null }, "dashboard-widget")).toBeNull();
    expect(bindingForModule({ ...active, entryUrl: "https://example.com/entry.mjs" }, "dashboard-widget")).toBeNull();
    expect(bindingForModule({ ...active, build: null }, "dashboard-widget")).toBeNull();
  });
});
